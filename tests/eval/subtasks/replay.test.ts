import { describe, expect, it } from "vitest";

import { replayKey, ReplayStore, type MiniFs, type StoredResponse } from "./replay.ts";
import { toolMessage } from "./testSupport.ts";

const BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: "You check traceability.",
  tools: [{ name: "record_traceability", input_schema: { type: "object", properties: { supports: { type: "boolean" } } } }],
  tool_choice: { type: "tool", name: "record_traceability" },
  messages: [{ role: "user", content: "Claim: x\n\n[Unit u1]\nraw_text: \"a\"" }],
  stream: false,
};
const BASE = { tokenSource: "api" as const, cliAdapterVersion: null, repeat: 0, body: BODY };

function memFs(): MiniFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p)!,
    writeFileSync: (p, d) => void files.set(p, d),
    mkdirSync: () => undefined,
  };
}

const STORED: StoredResponse = {
  message: toolMessage("record_traceability", { supports: false, rationale: "none at all" }),
  producedByRunId: "eval-run-1",
  producedAt: "2026-10-28T00:00:00.000Z",
  latencyMs: 10,
};

describe("replayKey", () => {
  const key = replayKey(BASE);
  const variants: [string, unknown][] = [
    ["model", { ...BODY, model: "claude-haiku-4-5-20251001" }],
    ["max_tokens", { ...BODY, max_tokens: 2048 }],
    ["tool_choice", { ...BODY, tool_choice: { type: "auto" } }],
    ["effort", { ...BODY, output_config: { effort: "medium" } }],
    ["system retry reminder", { ...BODY, system: BODY.system + "\n\nYour previous response failed." }],
    ["tool schema", { ...BODY, tools: [{ ...BODY.tools[0], input_schema: { type: "object" } }] }],
    ["rendered Unit", { ...BODY, messages: [{ role: "user", content: "Claim: x\n\n[Unit u1]\nraw_text: \"b\"" }] }],
  ];
  for (const [what, body] of variants) {
    it(`changes when the ${what} changes`, () => {
      expect(replayKey({ ...BASE, body })).not.toBe(key);
    });
  }

  it("changes with the sample index, token source and CLI adapter version", () => {
    expect(replayKey({ ...BASE, repeat: 1 })).not.toBe(key);
    expect(replayKey({ ...BASE, tokenSource: "claude-cli" })).not.toBe(key);
    expect(replayKey({ ...BASE, tokenSource: "claude-cli", cliAdapterVersion: "3" })).not.toBe(
      replayKey({ ...BASE, tokenSource: "claude-cli", cliAdapterVersion: "2" }),
    );
  });

  it("ignores key order inside the body", () => {
    const reordered = Object.fromEntries(Object.entries(BODY).reverse());
    expect(replayKey({ ...BASE, body: reordered })).toBe(key);
  });
});

describe("ReplayStore", () => {
  const key = replayKey(BASE);

  it("fresh writes but never reads, even its own entries", () => {
    const fs = memFs();
    const store = new ReplayStore({ mode: "fresh", fs, dir: "/r" });
    store.put("traceability", key, STORED);
    expect(fs.files.size).toBe(1);
    expect(store.get("traceability", key)).toBeNull();
  });

  it("replay reads what was stored, with its producing run id", () => {
    const fs = memFs();
    new ReplayStore({ mode: "fresh", fs, dir: "/r" }).put("traceability", key, STORED);
    const got = new ReplayStore({ mode: "replay", fs, dir: "/r" }).get("traceability", key);
    expect(got?.producedByRunId).toBe("eval-run-1");
    expect(got?.message.content[0]).toMatchObject({ type: "tool_use" });
  });

  it("treats a truncated or non-JSON replay entry as a miss and records the read error", () => {
    const fs = memFs();
    const writer = new ReplayStore({ dir: "/r", mode: "fresh", fs });
    const key = replayKey(BASE);
    writer.put("traceability", key, STORED);
    const [path] = [...fs.files.keys()];
    fs.files.set(path!, fs.files.get(path!)!.slice(0, 40)); // a put interrupted mid-write
    const reader = new ReplayStore({ dir: "/r", mode: "replay", fs });
    expect(reader.get("traceability", key)).toBeNull();
    expect(reader.readErrors).toHaveLength(1);
    expect(reader.readErrors[0]!.path).toBe(path);
    fs.files.set(path!, JSON.stringify({ not: "a stored response" }));
    expect(reader.get("traceability", key)).toBeNull();
    expect(reader.readErrors).toHaveLength(2);
    expect(reader.readErrors[1]!.message).toMatch(/not a StoredResponse/);
    fs.files.set(path!, JSON.stringify(STORED));
    expect(reader.get("traceability", key)?.producedByRunId).toBe("eval-run-1");
    expect(reader.readErrors).toHaveLength(2);
  });

  it("treats an unreadable replay entry as a miss and records the read error", () => {
    const fs = memFs();
    const writer = new ReplayStore({ dir: "/r", mode: "fresh", fs });
    const key = replayKey(BASE);
    writer.put("traceability", key, STORED);
    const broken: MiniFs = { ...fs, readFileSync: () => { throw new Error("EIO: i/o error"); } };
    const reader = new ReplayStore({ dir: "/r", mode: "replay", fs: broken });
    expect(reader.get("traceability", key)).toBeNull();
    expect(reader.readErrors[0]!.message).toMatch(/EIO/);
  });

  it("bypass neither reads nor writes", () => {
    const fs = memFs();
    const store = new ReplayStore({ mode: "bypass", fs, dir: "/r" });
    store.put("traceability", key, STORED);
    expect(fs.files.size).toBe(0);
    expect(store.get("traceability", key)).toBeNull();
  });

  it("refuses a malformed stage or key rather than writing outside its directory", () => {
    const store = new ReplayStore({ mode: "fresh", fs: memFs(), dir: "/r" });
    expect(() => store.put("../x", key, STORED)).toThrow(/unexpected stage or key/);
    expect(() => store.put("traceability", "../../etc", STORED)).toThrow(/unexpected stage or key/);
  });
});
