/**
 * Mock Anthropic messages and clients for the subtask-suite tests.
 * No network: every response is scripted.
 */

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";
import { vi } from "vitest";

import { BudgetLedger } from "./budget.ts";
import type { RunCtx } from "./instrument.ts";
import { ReplayStore } from "./replay.ts";

export function toolMessage(
  name: string,
  input: unknown,
  opts: { model?: string; usage?: Partial<Anthropic.Messages.Usage>; stopReason?: string } = {},
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "toolu_test", name, input }],
    stop_reason: opts.stopReason ?? "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, ...opts.usage },
  } as Anthropic.Messages.Message;
}

export function textMessage(text: string, model = "claude-sonnet-4-6"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 20 },
  } as Anthropic.Messages.Message;
}

export interface RequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly tools: { name: string; input_schema: unknown }[];
  readonly tool_choice: { type: string; name?: string };
  readonly output_config?: { effort: string };
  readonly messages: { role: string; content: string }[];
}

/** A client whose responses come from `handler`, keyed however the test likes (usually tool name). */
export function scriptedClient(
  handler: (body: RequestBody) => Anthropic.Messages.Message | Error | Promise<Anthropic.Messages.Message>,
): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (body: RequestBody) => {
    const out = await handler(body);
    if (out instanceof Error) throw out;
    return out;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

/** Default valid tool answers per validation tool, for a happy path. */
export function defaultValidationAnswer(body: RequestBody): Anthropic.Messages.Message {
  const tool = body.tools[0]!.name;
  const user = body.messages[0]!.content;
  if (tool === "record_claims") {
    const bullet = user.slice(user.lastIndexOf("\n\n") + 2);
    return toolMessage(tool, { claims: [{ text: bullet.length >= 3 ? bullet : "The user did x." }] }, { model: body.model });
  }
  if (tool === "record_traceability") {
    const tail = user.slice(user.lastIndexOf("Candidate Experience Units:"));
    const id = /\[Unit ([^\]]+)\]/.exec(tail)?.[1];
    return toolMessage(
      tool,
      id === undefined
        ? { supports: false, rationale: "No candidate Unit supports it." }
        : { supports: true, supporting_unit_id: id, rationale: "The first candidate supports it." },
      { model: body.model },
    );
  }
  if (tool === "record_specificity") {
    return toolMessage(tool, { specific: true, rationale: "Concrete and checkable." }, { model: body.model });
  }
  throw new Error(`no default answer for tool ${tool}`);
}

/** A run context over `rawClient`, with an in-memory replay store and an injected clock. */
export function makeCtx(opts: {
  readonly rawClient: Anthropic;
  readonly suite?: "validation" | "generation";
  readonly tokenSource?: "api" | "claude-cli";
  readonly maxUsd?: number | null;
  readonly store?: ReplayStore;
  readonly clock?: () => number;
}): RunCtx {
  const runAbort = new AbortController();
  let seq = 0;
  let t = 0;
  return {
    runId: "eval-test",
    suite: opts.suite ?? "validation",
    tokenSource: opts.tokenSource ?? "api",
    cliAdapterVersion: opts.tokenSource === "claude-cli" ? "2" : null,
    rawClient: opts.rawClient,
    store: opts.store ?? new ReplayStore({ mode: "bypass" }),
    ledger: new BudgetLedger({ maxUsd: opts.maxUsd ?? null, abort: runAbort }),
    runAbort,
    clock: opts.clock ?? (() => (t += 10)),
    nextId: () => String(seq++),
    calls: [],
    invocations: [],
    settingsMismatches: [],
  };
}
