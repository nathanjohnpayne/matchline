/**
 * Token-source adapter tests (#389).
 *
 * The CLI is injected via `spawnFn`, so these run offline and spend
 * nothing. The real-binary path was verified by hand during the #389
 * spike (Claude Code: schema-valid, 23 Units on `nathan-2026`).
 *
 * Priority invariants:
 *   1. API keys are stripped from the child env — otherwise Claude Code
 *      prefers ANTHROPIC_API_KEY and silently bills the metered API,
 *      which is the exact cost this path exists to avoid.
 *   2. A model substitution throws rather than mis-attributing results.
 *   3. Malformed CLI output degrades to `no_tool_use` so the pipeline's
 *      existing retry loop handles it.
 *   4. Reported tokens price the PAYLOAD, never the CLI's
 *      harness-inflated figure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertModelMatches,
  buildChildEnv,
  buildCliSystemPrompt,
  claudeCliClient,
  estimateTokens,
  extractPromptParts,
  isTokenSourceKind,
  parseClaudeEnvelope,
} from "./tokenSource.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "matchline-ts-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SCHEMA = {
  type: "object",
  required: ["units"],
  properties: { units: { type: "array", items: { type: "string" } } },
};

function params(overrides: Record<string, unknown> = {}) {
  return {
    model: "haiku",
    system: "You extract Experience Units.\n\nReturn your response via the `record_experience_units` tool. The schema is strict.",
    tools: [{ name: "record_experience_units", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "record_experience_units" },
    messages: [{ role: "user", content: "Resume text here" }],
    ...overrides,
  };
}

/** Claude Code's `--output-format json` envelope. */
function claudeEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_error: false,
    result: "DONE",
    total_cost_usd: 0.1048,
    usage: {
      input_tokens: 26,
      cache_creation_input_tokens: 18228,
      cache_read_input_tokens: 62618,
      output_tokens: 12413,
    },
    modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.1048 } },
    ...overrides,
  });
}

describe("buildChildEnv", () => {
  it("starts from empty and admits only allowlisted names", () => {
    const env = buildChildEnv({}, {
      PATH: "/bin",
      HOME: "/home/x",
      GH_TOKEN: "leak",
      OP_PREFLIGHT_REVIEWER_PAT: "leak",
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OP_PREFLIGHT_REVIEWER_PAT).toBeUndefined();
    // HOME is not in the base allowlist — each client passes it
    // explicitly, because the right value differs between them.
    expect(env.HOME).toBeUndefined();
  });

  it("applies the shell adapters' fallbacks for a sparse parent env", () => {
    const env = buildChildEnv({}, {} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.SHELL).toBe("/bin/sh");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.LANG).toBe("C");
    expect(env.TERM).toBe("dumb");
  });

  it("lets extras through and drops undefined extras", () => {
    const env = buildChildEnv(
      { HOME: "/isolated", CODEX_HOME: "/codex", MISSING: undefined },
      { PATH: "/bin" } as NodeJS.ProcessEnv,
    );
    expect(env.HOME).toBe("/isolated");
    expect(env.CODEX_HOME).toBe("/codex");
    expect("MISSING" in env).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("isTokenSourceKind", () => {
  it("accepts the supported sources and rejects anything else", () => {
    expect(isTokenSourceKind("api")).toBe(true);
    expect(isTokenSourceKind("claude-cli")).toBe(true);
    expect(isTokenSourceKind("codex-cli")).toBe(false);
    expect(isTokenSourceKind("gemini-cli")).toBe(false);
  });
});

describe("extractPromptParts", () => {
  it("pulls model, system, schema, tool name, and user content", () => {
    const parts = extractPromptParts(params());
    expect(parts.model).toBe("haiku");
    expect(parts.toolName).toBe("record_experience_units");
    expect(parts.schema).toEqual(SCHEMA);
    expect(parts.userContent).toBe("Resume text here");
  });

  it.each([
    ["model", { model: 123 }],
    ["system", { system: undefined }],
    ["tools", { tools: [] }],
    ["messages", { messages: [] }],
  ] as const)("throws when %s is malformed", (_label, override) => {
    // Silently degrading here would produce a sweep ranking built on a
    // dropped schema — fail at the boundary instead.
    expect(() => extractPromptParts(params(override))).toThrow();
  });
});

describe("buildCliSystemPrompt", () => {
  it("rewrites the tool-use instruction into a structured-output instruction", () => {
    const prompt = buildCliSystemPrompt(extractPromptParts(params()));
    expect(prompt).not.toContain("via the `record_experience_units` tool");
    expect(prompt).toContain("Return your response as one JSON object");
  });

  it("preserves the production rules verbatim", () => {
    // The comparison is only meaningful if everything except the
    // output mechanism survives untouched.
    const prompt = buildCliSystemPrompt(extractPromptParts(params()));
    expect(prompt).toContain("You extract Experience Units.");
  });

  it("leaves schema delivery to the native CLI flag", () => {
    const prompt = buildCliSystemPrompt(extractPromptParts(params()));
    expect(prompt).toContain("CLI validates it against the supplied JSON Schema");
    expect(prompt).not.toContain(JSON.stringify(SCHEMA));
  });

  // The pipelines append a retry reminder to the system prompt on
  // attempts 2 and 3. Those reminders are written for the tool-use API
  // shape, so each one has to be rewritten too — a CLI retry told to
  // call a tool it was never given contradicts the JSON-only OUTPUT
  // CONTRACT and re-fails the same way. The literals below are copied
  // verbatim from the production consts; if a reminder's wording drifts
  // away from them, that is the signal to re-check the rewrite rules.
  describe("retry reminders", () => {
    // functions/src/parsing/jd.ts § SCHEMA_ERROR_REMINDER (the same
    // sentence appears in extraction/resume.ts, validation/*.ts and
    // generation/pipeline.ts).
    const SCHEMA_ERROR_REMINDER =
      "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.";
    // functions/src/parsing/jd.ts § NO_TOOL_USE_REMINDER.
    const NO_TOOL_USE_REMINDER =
      "\n\nYour previous response did not call the tool. You must respond by calling the tool with the parsed requirements; do not respond with plain text.";

    it("rewrites the schema-error reminder's tool-schema wording", () => {
      const prompt = buildCliSystemPrompt(
        extractPromptParts(params({ system: `Base.${SCHEMA_ERROR_REMINDER}` })),
      );
      expect(prompt).not.toContain("the tool schema");
      expect(prompt).toContain("exactly matches the required schema");
    });

    it("rewrites the no-tool-use reminder into a JSON-object instruction", () => {
      const prompt = buildCliSystemPrompt(
        extractPromptParts(params({ system: `Base.${NO_TOOL_USE_REMINDER}` })),
      );
      expect(prompt).toContain("did not return a JSON object");
      expect(prompt).toContain(
        "respond with one JSON object containing the parsed requirements",
      );
      // The substance of the reminder — "you returned prose, stop" —
      // has to survive the rewrite, or the retry loses its point.
      expect(prompt).toContain("do not respond with plain text");
    });

    it("never leaves a tool-calling instruction in the CLI prompt", () => {
      for (const reminder of [SCHEMA_ERROR_REMINDER, NO_TOOL_USE_REMINDER]) {
        const prompt = buildCliSystemPrompt(
          extractPromptParts(params({ system: `Base.${reminder}` })),
        );
        expect(prompt).not.toMatch(/\bcall(ing)? the tool\b/);
      }
    });
  });
});

describe("assertModelMatches", () => {
  it("accepts a dated id for an undated alias", () => {
    expect(() =>
      assertModelMatches("haiku", ["claude-haiku-4-5-20251001"]),
    ).not.toThrow();
  });

  it("accepts an exact match", () => {
    expect(() =>
      assertModelMatches("claude-sonnet-4-6", ["claude-sonnet-4-6"]),
    ).not.toThrow();
  });

  it("throws when a different model was served", () => {
    // Silent substitution would attribute one model's quality to
    // another and corrupt the whole ranking.
    expect(() =>
      assertModelMatches("haiku", ["claude-opus-4-1-20250805"]),
    ).toThrow(/Refusing to attribute/);
  });

  it("fails closed when the CLI reported no model", () => {
    expect(() => assertModelMatches("haiku", [])).toThrow(
      /did not report the served model/,
    );
  });
});

describe("parseClaudeEnvelope", () => {
  it("reads the error flag, result text, output tokens, and models", () => {
    const parsed = parseClaudeEnvelope(claudeEnvelope());
    expect(parsed.isError).toBe(false);
    expect(parsed.resultText).toBe("DONE");
    expect(parsed.outputTokens).toBe(12413);
    expect(parsed.models).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("throws with a diagnostic on non-JSON stdout", () => {
    expect(() => parseClaudeEnvelope("Not logged in")).toThrow(/non-JSON stdout/);
  });
});

describe("claudeCliClient", () => {
  it("returns a tool_use block carrying the CLI's structured JSON", async () => {
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({
        stdout: claudeEnvelope({ result: JSON.stringify({ units: ["a"] }) }),
        stderr: "",
        exitCode: 0,
      }),
    });

    const res = await client.messages.create(params() as never);
    const block = res.content[0] as unknown as { type: string; input: unknown };
    expect(block.type).toBe("tool_use");
    expect(block.input).toEqual({ units: ["a"] });
  });

  // Codex P2: when the CLI populates ONLY `structured_output` and
  // leaves `result` empty (the documented preferred-field case above),
  // pricing `estimateTokens(envelope.resultText)` on the empty string
  // recorded zero output tokens for a real, non-empty response —
  // understating `$ / flow` for every structured-output run.
  it("prices the structured output, not the empty result string, when structured_output is populated", async () => {
    const structuredOutput = { units: ["a", "b", "c"] };
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({
        stdout: claudeEnvelope({ result: "", structured_output: structuredOutput }),
        stderr: "",
        exitCode: 0,
      }),
    });

    const res = await client.messages.create(params() as never);
    const usage = (res as unknown as { usage: { output_tokens: number } }).usage;
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBe(estimateTokens(JSON.stringify(structuredOutput)));
  });

  // #392. The ORIGINAL test here asserted only that the two model API
  // keys had been removed — which passes happily while OP_PREFLIGHT_*
  // PATs, GH_TOKEN, and GCP credential paths sail through. That is the
  // difference between a test that confirms what you fixed and one
  // that catches what you forgot, so this asserts the complement:
  // nothing OUTSIDE the allowlist reaches the child.
  it("passes only allowlisted variables to the child", async () => {
    const leaky = {
      OP_PREFLIGHT_REVIEWER_PAT: "ghp_reviewer",
      OP_PREFLIGHT_AUTHOR_PAT: "ghp_author",
      GH_TOKEN: "ghp_ambient",
      GITHUB_TOKEN: "ghp_ambient2",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/x/adc.json",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk-ant-leak",
      OPENAI_API_KEY: "sk-oai-leak",
    };
    for (const [k, v] of Object.entries(leaky)) vi.stubEnv(k, v);

    let seenEnv: NodeJS.ProcessEnv | undefined;
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return { stdout: claudeEnvelope({ result: JSON.stringify({ units: [] }) }), stderr: "", exitCode: 0 };
      },
    });
    await client.messages.create(params() as never);

    expect(seenEnv).toBeDefined();
    for (const name of Object.keys(leaky)) {
      expect(seenEnv?.[name], `${name} must not reach the child`).toBeUndefined();
    }
    // And the allowlist is a closed set, not a denylist of known-bad
    // names — so a NEW secret added to the parent env later is
    // withheld without anyone updating this test.
    const permitted = new Set([
      "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM",
      "HOME", "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    for (const key of Object.keys(seenEnv ?? {})) {
      expect(permitted.has(key), `unexpected variable in child env: ${key}`).toBe(true);
    }
  });

  it("strips ANTHROPIC_API_KEY and OPENAI_API_KEY from the child env", async () => {
    // Load-bearing: Claude Code prefers ANTHROPIC_API_KEY when set, so
    // leaving it would silently bill the metered API on a run the
    // operator believes is subscription-billed.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak");
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-should-not-leak");

    let seenEnv: NodeJS.ProcessEnv | undefined;
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return { stdout: claudeEnvelope({ result: JSON.stringify({ units: [] }) }), stderr: "", exitCode: 0 };
      },
    });

    await client.messages.create(params() as never);
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv?.OPENAI_API_KEY).toBeUndefined();
  });

  // The real HOME remains available for OAuth, so the adapter must
  // provide no model tools at all. This closes the prompt-injection
  // write path rather than merely limiting it to one tool.
  it("enables native JSON-schema output with no model tools", async () => {
    let seenArgs: readonly string[] = [];
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async (_cmd, args) => {
        seenArgs = args;
        return { stdout: claudeEnvelope({ result: JSON.stringify({ units: [] }) }), stderr: "", exitCode: 0 };
      },
    });
    await client.messages.create(params() as never);

    expect(seenArgs).toContain("--json-schema");
    expect(seenArgs[seenArgs.indexOf("--json-schema") + 1]).toBe(JSON.stringify(SCHEMA));
    expect(seenArgs).toContain("--tools");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(seenArgs).toContain("--safe-mode");
    expect(seenArgs).not.toContain("--allowedTools");
    expect(seenArgs).not.toContain("--add-dir");
  });

  it("never passes --bare, which would force API-key auth", async () => {
    let seenArgs: readonly string[] = [];
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async (_cmd, args) => {
        seenArgs = args;
        return { stdout: claudeEnvelope({ result: JSON.stringify({ units: [] }) }), stderr: "", exitCode: 0 };
      },
    });
    await client.messages.create(params() as never);
    expect(seenArgs).not.toContain("--bare");
    expect(seenArgs).toContain("--system-prompt");
  });

  it("prices the prompt payload, including its native JSON schema", async () => {
    const body = JSON.stringify({ units: ["a", "b"] });
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({
        stdout: claudeEnvelope({ result: body }), stderr: "", exitCode: 0,
      }),
    });

    const res = await client.messages.create(params() as never);
    // The envelope claims 80k+ input tokens of agent preamble and
    // 12,413 output. Neither should reach the cost model, but the
    // serialized native schema is request input and must be modeled.
    const promptParts = extractPromptParts(params());
    expect(res.usage.input_tokens).toBeLessThan(1000);
    expect(res.usage.input_tokens).toBe(
      estimateTokens(buildCliSystemPrompt(promptParts)) +
        estimateTokens(promptParts.userContent) +
        estimateTokens(JSON.stringify(promptParts.schema)),
    );
    expect(res.usage.output_tokens).toBe(estimateTokens(body));
    expect(res.usage.output_tokens).toBeLessThan(12413);
  });

  it("degrades to no_tool_use when the CLI result is not JSON", async () => {
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({ stdout: claudeEnvelope(), stderr: "", exitCode: 0 }),
    });
    const res = await client.messages.create(params() as never);
    // Routes into the pipeline's existing 3-attempt retry loop.
    expect(res.content.every((b) => (b as { type: string }).type !== "tool_use")).toBe(true);
  });

  it("degrades to no_tool_use when structured output is malformed", async () => {
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({
        stdout: claudeEnvelope({ result: "{ not json" }), stderr: "", exitCode: 0,
      }),
    });
    const res = await client.messages.create(params() as never);
    expect(res.content.every((b) => (b as { type: string }).type !== "tool_use")).toBe(true);
  });

  it("throws when the CLI serves a different model than requested", async () => {
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => {
        return {
          stdout: claudeEnvelope({
            result: JSON.stringify({ units: [] }),
            modelUsage: { "claude-opus-4-1-20250805": {} },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    await expect(client.messages.create(params() as never)).rejects.toThrow(
      /Refusing to attribute/,
    );
  });

  it("surfaces a not-logged-in envelope as an error", async () => {
    const client = claudeCliClient({
      workdirRoot: root,
      spawnFn: async () => ({
        stdout: claudeEnvelope({ is_error: true, result: "Not logged in · Please run /login" }),
        stderr: "",
        exitCode: 0,
      }),
    });
    await expect(client.messages.create(params() as never)).rejects.toThrow(/Not logged in/);
  });
});
