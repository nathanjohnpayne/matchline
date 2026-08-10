/**
 * Pluggable token source for the eval harness (#389).
 *
 * ## The seam
 *
 * `extractFromResume` / `parseJobRequirements` already accept an
 * injected `client` and call it as:
 *
 * ```ts
 * client.messages.create({ model, system, tools: [{ input_schema }],
 *                          tool_choice, messages, ... })
 * ```
 *
 * then read the `tool_use` block's `.input`. So the cheapest possible
 * seam is an object that satisfies **that same shape** but routes to a
 * subscription-billed CLI instead of the metered API. Nothing in
 * `functions/` changes; production keeps calling the real SDK.
 *
 * ## Why bother
 *
 * One 4-cell × 3-sample eval run costs $2.06 against a $25/mo Anthropic
 * cap (#177). Tuning needs dozens of iterations. A Claude subscription
 * and a ChatGPT subscription are already paid for.
 *
 * **This is a development-time tool only.** Deployed inference stays on
 * the metered API — that separation is the point, since the whole
 * exercise is choosing which metered model to deploy.
 *
 * ## Fidelity caveat — read before trusting a ranking
 *
 * The CLI path is a **ranking proxy, not a replica**:
 *
 *   - The API enforces the schema via `tool_use` + `tool_choice`.
 *     Claude CLI validates a JSON Schema final response but does not
 *     reproduce API tool choice semantics. A malformed result is
 *     surfaced as a missing `tool_use` block, which routes into the
 *     pipeline's existing 3-attempt retry loop rather than needing its
 *     own.
 *   - Claude Code injects ~20-80k tokens of its own tool definitions
 *     that a production call would never carry. Its reported
 *     `total_cost_usd` is therefore shadow cost of the agent harness,
 *     NOT of the production call — measured, a real extraction reported
 *     $0.105 against roughly $0.066 of actual Haiku payload. This
 *     module deliberately does not propagate that number; see
 *     `estimateTokens` below.
 *   - Wall-clock latency includes agent startup and is not a usable
 *     production latency signal.
 *   - **The output-token budget differs.** Production sets
 *     `max_tokens: 16_384` explicitly (see `extraction/resume.ts`,
 *     raised in #145 after truncation was observed on a real resume).
 *     Neither CLI exposes an equivalent flag, so a CLI run gets that
 *     model's default ceiling instead. A model whose default sits
 *     below 16k could truncate here and not in production, which
 *     would read as a quality difference rather than a budget one.
 *     Another reason the confirmation run on `--token-source api` is
 *     not optional.
 *
 * Confirm the top 2-3 finalists on the metered API before editing
 * `functions/src/llm/config.ts`.
 *
 * ## Trust boundary — read before widening the fixture corpus (#392)
 *
 * Resume and JD fixture text is embedded **verbatim** in the agent
 * prompt, and the agent runs with a sandbox that still permits
 * read-only shell commands. Fixture text is therefore untrusted input
 * to a process that can execute things.
 *
 * The mitigations are `buildChildEnv` and the CLI's native structured
 * output mode: the subprocess starts from an empty environment and the
 * model receives no tools at all. That removes both the ambient-secret
 * and arbitrary-write paths from fixture-controlled prompt text — do
 * not weaken either property by passing `process.env` through or by
 * re-enabling tools.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";

export type TokenSourceKind = "api" | "claude-cli";

export const TOKEN_SOURCE_KINDS: readonly TokenSourceKind[] = [
  "api",
  "claude-cli",
];

export function isTokenSourceKind(v: string): v is TokenSourceKind {
  return (TOKEN_SOURCE_KINDS as readonly string[]).includes(v);
}

export interface CliClientOptions {
  /**
   * Per-call wall-clock budget. The verified Nathan-resume extraction
   * took 130s through Claude Code, so the default leaves real headroom
   * for a long resume without hanging a sweep forever.
   */
  readonly timeoutMs?: number;
  /**
   * Root for the throwaway per-call workdir. Defaults to the OS temp
   * dir. The agent is granted Read/Write access to this directory ONLY.
   */
  readonly workdirRoot?: string;
  /** Injectable for tests; defaults to spawning the real binary. */
  readonly spawnFn?: SpawnFn;
}

/** Result of one CLI invocation, normalized across both CLIs. */
interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
) => Promise<CliRunResult>;

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Rough token estimate from raw text.
 *
 * **Why an estimate and not the CLI's own number.** The CLI reports
 * input tokens that include its entire injected tool-definition
 * preamble, which a production API call never carries — using it would
 * systematically mis-rank models on cost, which is the one thing the
 * sweep exists to get right. So the adapter prices the *payload*: the
 * system prompt, the user content, and the emitted JSON.
 *
 * ~4 characters per token is the standard English-text approximation
 * for both vendors' BPE tokenizers. It is an approximation: expect it
 * to run a few percent off on JSON-heavy output, which is dense in
 * punctuation. Costs derived from a CLI run are therefore labeled
 * `estimated` in the sweep output, and the confirmation run on the
 * metered API is what produces exact numbers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a minimal Anthropic-`Message`-shaped response carrying a
 * `tool_use` block, which is exactly what the extraction / parsing
 * pipelines destructure.
 */
function toolUseResponse(
  model: string,
  toolName: string,
  input: unknown,
  inputTokens: number,
  outputTokens: number,
): Anthropic.Messages.Message {
  return {
    id: `msg_cli_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "tool_use", id: `toolu_cli`, name: toolName, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  } as unknown as Anthropic.Messages.Message;
}

/**
 * Build a response with NO `tool_use` block. The pipelines classify
 * this as `no_tool_use` and burn a retry attempt — which is the
 * behavior we want when the CLI returns unusable output, and it means
 * this adapter needs no retry logic of its own.
 */
function noToolUseResponse(
  model: string,
  reason: string,
  inputTokens: number,
  outputTokens: number,
): Anthropic.Messages.Message {
  return {
    id: `msg_cli_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: reason }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  } as unknown as Anthropic.Messages.Message;
}

/** Default spawn: run the binary, feed stdin, collect stdout/stderr. */
const realSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `${command} exceeded ${options.timeoutMs}ms. Raise timeoutMs, or check that the CLI is authenticated and not waiting on a prompt.`,
        ),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", fail);
    // An executable that exits before it reads stdin emits EPIPE on
    // this stream. Handle it explicitly: without this listener Node
    // treats it as an unhandled EventEmitter error and can terminate
    // the whole eval process instead of returning a failed fixture.
    child.stdin.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });

    try {
      child.stdin.end(options.stdin);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });

/**
 * Variables a CLI subprocess legitimately needs. Everything else is
 * withheld.
 *
 * Mirrors the `env -i` allowlist in
 * `scripts/phase-4b/adapters/review-via-{codex,claude}.sh`, which
 * already solves this exact problem for the Phase 4b review adapters.
 * Same list, same fallbacks, so the two stay comparable.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
] as const;

/** Fallbacks matching the shell adapters, for a sparse parent env. */
const ENV_FALLBACKS: Readonly<Record<string, string>> = {
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/sh",
  TMPDIR: "/tmp",
  LANG: "C",
  TERM: "dumb",
};

/**
 * Build the child environment by **construction**, not by filtering.
 *
 * ## Why not a filtered copy (#392)
 *
 * The first version of this did `{...process.env}` minus the two model
 * API keys. Deleting two variables is not the same as withholding the
 * rest: in a normal working session the parent also carries
 * `OP_PREFLIGHT_REVIEWER_PAT`, `OP_PREFLIGHT_AUTHOR_PAT`, `GH_TOKEN`,
 * and GCP credential paths, all of which were inherited by the child.
 *
 * That mattered because of what else this adapter does. **Resume and
 * JD fixture text is embedded verbatim in the agent prompt**, and the
 * agent runs with a sandbox that still permits read-only shell
 * commands such as `env`. Fixture text is therefore untrusted input to
 * a process holding credentials it has no use for — a prompt-injected
 * fixture could read them into model context. The corpus is
 * repo-controlled today, but the harness is explicitly aimed at real
 * resumes and scraped JDs (#38, #87, #28), so that will not hold.
 *
 * Starting from empty inverts the failure mode: a variable reaches the
 * child only if someone adds it here deliberately.
 *
 * The two model API keys are excluded as a consequence rather than as
 * a special case — but note it is still load-bearing that they are
 * absent: Claude Code prefers `ANTHROPIC_API_KEY` when present, so
 * leaking it would silently bill the metered API on a run the operator
 * believes is subscription-billed.
 */
export function buildChildEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key] ?? ENV_FALLBACKS[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface PromptParts {
  readonly system: string;
  readonly userContent: string;
  readonly schema: unknown;
  readonly toolName: string;
  readonly model: string;
}

/**
 * Pull the pieces this adapter needs out of an Anthropic
 * `MessageCreateParams`. Throws on any shape it can't handle rather
 * than silently degrading — a sweep that quietly dropped the schema
 * would produce garbage rankings.
 */
export function extractPromptParts(params: unknown): PromptParts {
  const p = params as {
    model?: unknown;
    system?: unknown;
    tools?: Array<{ name?: unknown; input_schema?: unknown }>;
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };

  if (typeof p.model !== "string") {
    throw new Error("tokenSource: params.model must be a string");
  }
  if (typeof p.system !== "string") {
    throw new Error(
      "tokenSource: params.system must be a string. The CLI adapter needs the " +
        "system prompt verbatim so the run stays faithful to production.",
    );
  }
  const tool = p.tools?.[0];
  if (!tool || typeof tool.name !== "string" || tool.input_schema === undefined) {
    throw new Error(
      "tokenSource: params.tools[0] must carry a name and input_schema. " +
        "The CLI has no tool_use enforcement, so the schema is what the " +
        "adapter substitutes into the output contract.",
    );
  }
  const firstMessage = p.messages?.[0];
  if (!firstMessage || typeof firstMessage.content !== "string") {
    throw new Error(
      "tokenSource: params.messages[0].content must be a string",
    );
  }

  return {
    system: p.system,
    userContent: firstMessage.content,
    schema: tool.input_schema,
    toolName: tool.name,
    model: p.model,
  };
}

/**
 * Rewrite a production system prompt's tool-use instruction into a
 * native structured-output instruction.
 *
 * The prompts say "Return your response via the `<tool>` tool" (see
 * `functions/src/prompts/extraction/resume.v1.md`). Left as-is, the
 * agent looks for a tool that isn't there. The rest of the prompt —
 * every hard rule, the few-shot block — is passed through untouched,
 * which is what keeps the comparison meaningful.
 */
export function buildCliSystemPrompt(
  parts: PromptParts,
): string {
  const rewritten = parts.system
    .replace(
      new RegExp(
        `Return your response via the \`${parts.toolName}\` tool\\.`,
        "g",
      ),
      "Return your response as one JSON object.",
    )
    // Codex P2: the pipelines APPEND a retry reminder to the system
    // prompt on attempts 2 and 3, and those reminders tell the model to
    // match "the tool schema". The replacement above only touches the
    // opening instruction, so a retrying CLI run was being told to
    // satisfy a "tool schema" while having no tools at all — the exact
    // confusion most likely to make the retry fail the same way again.
    //
    // (The finding described the reminder as naming
    // `record_job_requirements`; it actually says "the tool schema".
    // Same substance.)
    .replace(/\bthe tool schema\b/g, "the required schema");
  return (
    `${rewritten}\n\n` +
    "OUTPUT CONTRACT: Return ONE JSON object — nothing else, no prose, no " +
    "markdown fence. The CLI validates it against the supplied JSON Schema."
  );
}

/**
 * Anthropic-shaped client backed by `claude -p` on the Claude Code
 * subscription.
 *
 * Verified end-to-end on 2026-07-30 against the real
 * `extraction/resume.v1` prompt, the real `ExtractionResponseV1Schema`,
 * and the `nathan-2026` fixture: schema-valid, 23 Units, 130s.
 *
 * Two spike findings encoded here:
 *
 *   - `--bare` cannot be used. It forces `ANTHROPIC_API_KEY` /
 *     `apiKeyHelper` auth and never reads OAuth, so it returns
 *     "Not logged in" — it is the one overhead-reducing flag that
 *     defeats the entire purpose.
 *   - `--json-schema` gives the CLI an output contract without giving
 *     the model filesystem tools. It is deliberately paired with
 *     `--tools ""`; real resumes and JDs are untrusted prompt input.
 */
export function claudeCliClient(options: CliClientOptions = {}): Anthropic {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnFn ?? realSpawn;
  const workdirRoot = options.workdirRoot ?? tmpdir();

  return {
    messages: {
      create: async (params: unknown): Promise<Anthropic.Messages.Message> => {
        const parts = extractPromptParts(params);
        const workdir = mkdtempSync(join(workdirRoot, "matchline-claude-cli-"));
        try {
          const system = buildCliSystemPrompt(parts);
          // This schema is sent as prompt input through --json-schema, so
          // include it in the modeled request cost. Excluding it makes broad
          // extraction schemas look artificially cheap in a model sweep.
          const serializedSchema = JSON.stringify(parts.schema);
          const inputTokens =
            estimateTokens(system) +
            estimateTokens(parts.userContent) +
            estimateTokens(serializedSchema);

          const result = await spawnFn(
            "claude",
            [
              "-p",
              "--model", parts.model,
              "--output-format", "json",
              "--json-schema", serializedSchema,
              "--system-prompt", system,
              // Native schema enforcement replaces the former
              // file-write workaround. An empty list is intentional:
              // fixture text must not be able to grant itself a
              // filesystem or shell capability through prompt
              // injection.
              "--tools", "",
              "--safe-mode",
              // Codex P2: without this, `claude -p` writes the session
              // — including the resume/JD text pasted into the prompt
              // and the model's output — into Claude Code's on-disk
              // store under the operator's real HOME. Fixture content
              // is the user's actual career history, and once the
              // corpus widens to real scraped material (#38, #87, #28)
              // it is third-party data too. An eval run should leave
              // no transcript behind.
              "--no-session-persistence",
              "--disable-slash-commands",
              "--strict-mcp-config",
              "--mcp-config", '{"mcpServers":{}}',
              "--settings", '{"hooks":{}}',
            ],
            {
              cwd: workdir,
              // HOME stays the REAL home: Claude Code's subscription
              // OAuth lives under it, and isolating it reproduces the
              // `--bare` failure ("Not logged in"). This matches
              // review-via-claude.sh, which also keeps the real HOME
              // while withholding everything else. The security win is
              // the allowlist, not HOME isolation.
              env: buildChildEnv({
                HOME: process.env.HOME,
                ...(process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined && {
                  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
                }),
              }),
              stdin: parts.userContent,
              timeoutMs,
            },
          );

          if (result.exitCode !== 0) {
            throw new Error(
              `claude -p exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
            );
          }

          const envelope = parseClaudeEnvelope(result.stdout);
          if (envelope.isError) {
            throw new Error(`claude -p reported an error: ${envelope.resultText.slice(0, 300)}`);
          }
          assertModelMatches(parts.model, envelope.models);

          // Prefer the CLI's already-parsed structured output; fall
          // back to parsing `result` for older CLI builds that only
          // populate the string form.
          let parsed: unknown;
          if (envelope.structuredOutput !== undefined && envelope.structuredOutput !== null) {
            parsed = envelope.structuredOutput;
          } else {
            try {
              parsed = JSON.parse(envelope.resultText);
            } catch (err) {
              // Degrade to a missing tool_use block so the pipeline's
              // existing 3-attempt retry loop handles it.
              return noToolUseResponse(
                parts.model,
                `claude -p returned neither structured_output nor parseable result: ${
                  err instanceof Error ? err.message : String(err)
                }. First 200 chars: ${envelope.resultText.slice(0, 200)}`,
                inputTokens,
                estimateTokens(envelope.resultText),
              );
            }
          }

        return toolUseResponse(
            parts.model,
            parts.toolName,
            parsed,
            inputTokens,
            estimateTokens(envelope.resultText),
          );
        } finally {
          rmSync(workdir, { recursive: true, force: true });
        }
      },
    },
  } as unknown as Anthropic;
}

interface ClaudeEnvelope {
  readonly isError: boolean;
  readonly resultText: string;
  /**
   * The `--json-schema` payload, already parsed by the CLI.
   *
   * Codex P1: this is the canonical field for structured output and
   * is what the headless docs specify. `result` also carries the same
   * content as a JSON string — measured, both are populated — so the
   * previous `result`-only parser was not broken, and a 29-Unit
   * end-to-end run through the real pipeline confirms that. But
   * relying on the stringified copy means an extra `JSON.parse` that
   * can fail, and depends on a field the docs do not promise for this
   * mode. Prefer the parsed one; keep `result` as the fallback.
   */
  readonly structuredOutput: unknown;
  readonly outputTokens: number;
  /** Model ids Claude Code reports actually serving the request. */
  readonly models: readonly string[];
}

export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  let raw: {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    usage?: { output_tokens?: number };
    modelUsage?: Record<string, unknown>;
  };
  try {
    raw = JSON.parse(stdout) as typeof raw;
  } catch (err) {
    throw new Error(
      `claude -p --output-format json produced non-JSON stdout: ${
        err instanceof Error ? err.message : String(err)
      }. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  return {
    isError: raw.is_error === true,
    resultText: typeof raw.result === "string" ? raw.result : "",
    structuredOutput: raw.structured_output,
    outputTokens: raw.usage?.output_tokens ?? 0,
    models: Object.keys(raw.modelUsage ?? {}),
  };
}

/**
 * Fail loudly when the CLI served a different model than the sweep
 * asked for.
 *
 * A silent substitution (alias resolution drift, a subscription tier
 * that downgrades, a fallback on overload) would attribute one model's
 * quality to another and quietly corrupt the entire ranking — the one
 * failure mode that would make the sweep worse than useless.
 *
 * Matching is containment-based in both directions because Claude Code
 * resolves an undated alias (`haiku`) to a dated id
 * (`claude-haiku-4-5-20251001`) — the alias is a substring of the id,
 * not a prefix of it.
 *
 * The looseness is bounded: `claude-sonnet-4-6` vs `claude-sonnet-4-5`
 * normalizes to `claudesonnet46` vs `claudesonnet45`, and neither
 * contains the other, so a point-version substitution still throws.
 * The residual gap is inherent to aliases — asking for `sonnet` means
 * "whatever the current Sonnet is". Sweep entries should use full
 * dated ids when the exact point version matters for the ranking.
 */
export function assertModelMatches(
  requested: string,
  served: readonly string[],
): void {
  if (served.length === 0) {
    throw new Error(
      `tokenSource: requested model "${requested}" but the CLI did not report the served model. ` +
        "Refusing to attribute unverified results to the requested model.",
    );
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const req = norm(requested);
  const ok = served.some((s) => {
    const got = norm(s);
    return got.includes(req) || req.includes(got);
  });
  if (!ok) {
    throw new Error(
      `tokenSource: requested model "${requested}" but the CLI served ` +
        `[${served.join(", ")}]. Refusing to attribute these results to the ` +
        `requested model — that would corrupt the sweep's ranking.`,
    );
  }
}
