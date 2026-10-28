/**
 * Request-level local replay for the subtask suites (#488).
 *
 * The key is the request body exactly as `messages.create` received it
 * (model, max_tokens, tool_choice, output_config, system with any suffix
 * and retry reminder, the tool schema, and the rendered messages), plus
 * the token source, the CLI adapter version and the sample index. Any
 * change to a setting, a prompt, a schema or the way Units are rendered
 * therefore changes the key on its own; there is no hand-maintained
 * version to forget to bump. The second argument (signal, timeout) is
 * not part of the request and is excluded.
 *
 * This is a LOCAL replay of earlier outputs, distinct from the
 * provider's prompt cache (which only discounts input tokens and still
 * returns a fresh output). The default mode, `fresh`, writes and never
 * reads, so independently repeated live runs never reuse an output.
 * `replay` is the explicit opt-in for rescoring offline.
 *
 * The corpus `StageCache` (`../cache.ts`) is untouched.
 */

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../functions/src/validation/attestation.ts";
import type { TokenSourceKind } from "../tokenSource.ts";

export type ReplayMode = "fresh" | "replay" | "bypass";

export const REPLAY_FORMAT_VERSION = 1;

/** Gitignored through the repository's `.cache/` rule. */
export const DEFAULT_REPLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "requests");

export function replayKey(a: {
  readonly tokenSource: TokenSourceKind;
  readonly cliAdapterVersion: string | null;
  readonly repeat: number;
  readonly body: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        format: REPLAY_FORMAT_VERSION,
        provider: "anthropic",
        tokenSource: a.tokenSource,
        cliAdapterVersion: a.cliAdapterVersion,
        repeat: a.repeat,
        body: a.body,
      }),
    )
    .digest("hex");
}

export interface StoredResponse {
  readonly message: Anthropic.Messages.Message;
  readonly producedByRunId: string;
  readonly producedAt: string;
  readonly latencyMs: number;
}

export interface MiniFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: true }): unknown;
}

export class ReplayStore {
  readonly mode: ReplayMode;
  private readonly dir: string;
  private readonly fs: MiniFs;

  constructor(opts: { readonly dir?: string; readonly mode: ReplayMode; readonly fs?: MiniFs }) {
    this.mode = opts.mode;
    this.dir = opts.dir ?? DEFAULT_REPLAY_DIR;
    this.fs = opts.fs ?? (nodeFs as unknown as MiniFs);
  }

  private path(stage: string, key: string): string {
    if (!/^[a-z_]+$/.test(stage) || !/^[0-9a-f]{64}$/.test(key)) {
      throw new Error(`replay: refusing an unexpected stage or key (${stage}, ${key})`);
    }
    return join(this.dir, stage, `${key}.json`);
  }

  /** A stored response, only in `replay` mode. */
  get(stage: string, key: string): StoredResponse | null {
    if (this.mode !== "replay") return null;
    const p = this.path(stage, key);
    if (!this.fs.existsSync(p)) return null;
    return JSON.parse(this.fs.readFileSync(p, "utf8")) as StoredResponse;
  }

  /** Store an HTTP-successful response; a no-op in `bypass` mode. */
  put(stage: string, key: string, value: StoredResponse): void {
    if (this.mode === "bypass") return;
    const p = this.path(stage, key);
    this.fs.mkdirSync(dirname(p), { recursive: true });
    this.fs.writeFileSync(p, JSON.stringify(value));
  }
}
