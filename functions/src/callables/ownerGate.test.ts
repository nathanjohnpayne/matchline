/**
 * Owner allowlist + input-size gate (#439).
 *
 * Two layers:
 *
 *   1. The pure helpers — allowlist parsing, `requireOwner`,
 *      `assertTextWithinLimit`.
 *   2. Every exported callable, invoked through `onCall`'s `.run()`
 *      with the real `MATCHLINE_OWNER_UIDS` param resolution. A
 *      stranger must be refused with `permission-denied` before the
 *      handler reaches Firestore or a model — which these tests can
 *      observe directly, because no Firestore app or API key exists
 *      in this process: anything that got past the gate would fail
 *      with a different error.
 *
 * The callable table is the regression guard for "a new callable
 * forgot the gate": add every new `onCall` export here.
 */

import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveMatchEvidenceCallable } from "./deriveMatchEvidence.ts";
import { extractFromResumeCallable } from "./extractFromResume.ts";
import { generateResumeCallable } from "./generateResume.ts";
import {
  MAX_TEXT_INPUT_BYTES,
  assertTextWithinLimit,
  parseOwnerAllowlist,
  requireOwner,
} from "./ownerGate.ts";
import { parseJobRequirementsCallable } from "./parseJobRequirements.ts";
import { reembedExperienceUnitCallable } from "./reembedExperienceUnit.ts";
import { runMatchingCallable } from "./runMatching.ts";
import { validateAssetCallable } from "./validateAsset.ts";

const OWNER = "owner-uid-1";
const STRANGER = "stranger-uid-2";

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function codeOf(err: unknown): string | undefined {
  return err instanceof HttpsError ? err.code : undefined;
}

describe("parseOwnerAllowlist", () => {
  it("parses a single uid", () => {
    expect([...parseOwnerAllowlist("abc")]).toEqual(["abc"]);
  });

  it("parses comma-separated uids and trims whitespace", () => {
    expect([...parseOwnerAllowlist(" a , b,c ")].sort()).toEqual(["a", "b", "c"]);
  });

  it("drops empty segments so a stray comma cannot allowlist ''", () => {
    const set = parseOwnerAllowlist("a,, ,");
    expect([...set]).toEqual(["a"]);
    expect(set.has("")).toBe(false);
  });

  it("returns an empty set for unset, empty or whitespace-only input (fail closed)", () => {
    expect(parseOwnerAllowlist(undefined).size).toBe(0);
    expect(parseOwnerAllowlist("").size).toBe(0);
    expect(parseOwnerAllowlist("   ").size).toBe(0);
  });
});

describe("requireOwner", () => {
  const allow = new Set([OWNER]);

  it("returns the uid for an allowlisted caller", () => {
    expect(requireOwner({ auth: { uid: OWNER, token: {} } } as never, "x", allow)).toBe(OWNER);
  });

  it("rejects a missing auth context as unauthenticated", () => {
    expect(codeOf(caught(() => requireOwner({ auth: undefined }, "x", allow)))).toBe(
      "unauthenticated",
    );
  });

  it("rejects a signed-in stranger as permission-denied", () => {
    const err = caught(() =>
      requireOwner({ auth: { uid: STRANGER, token: {} } } as never, "x", allow),
    );
    expect(codeOf(err)).toBe("permission-denied");
    // The refusal must not describe the allowlist or its contents.
    expect((err as HttpsError).message).not.toContain(OWNER);
  });

  it("admits nobody when the allowlist is empty", () => {
    expect(
      codeOf(
        caught(() => requireOwner({ auth: { uid: OWNER, token: {} } } as never, "x", new Set())),
      ),
    ).toBe("permission-denied");
  });
});

describe("assertTextWithinLimit", () => {
  it("accepts text at exactly the limit", () => {
    expect(() => assertTextWithinLimit("a".repeat(MAX_TEXT_INPUT_BYTES))).not.toThrow();
  });

  it("rejects text one byte over the limit with invalid-argument", () => {
    const err = caught(() => assertTextWithinLimit("a".repeat(MAX_TEXT_INPUT_BYTES + 1)));
    expect(codeOf(err)).toBe("invalid-argument");
  });

  it("counts UTF-8 bytes, not characters", () => {
    // "é" is 2 bytes in UTF-8: 60 KB of characters is 120 KB on the wire.
    const text = "é".repeat(60 * 1024);
    expect(text.length).toBeLessThan(MAX_TEXT_INPUT_BYTES);
    expect(codeOf(caught(() => assertTextWithinLimit(text)))).toBe("invalid-argument");
  });

  it("honors an explicit limit", () => {
    expect(() => assertTextWithinLimit("abcd", 4)).not.toThrow();
    expect(codeOf(caught(() => assertTextWithinLimit("abcde", 4)))).toBe("invalid-argument");
  });
});

// -- Every callable is gated ----------------------------------------------

interface RunnableCallable {
  run(request: CallableRequest<unknown>): unknown;
}

/**
 * Each entry carries a payload that is otherwise VALID for that
 * callable, so the only thing standing between the request and the
 * pipeline is the owner gate.
 */
const CALLABLES: ReadonlyArray<{
  readonly name: string;
  readonly fn: RunnableCallable;
  readonly data: Record<string, unknown>;
}> = [
  { name: "extractFromResume", fn: extractFromResumeCallable, data: { text: "Led a team." } },
  {
    name: "parseJobRequirements",
    fn: parseJobRequirementsCallable,
    data: { roleId: "role-1", text: "Must know SQL." },
  },
  { name: "generateResume", fn: generateResumeCallable, data: { applicationId: "app-1" } },
  {
    name: "validateAsset",
    fn: validateAssetCallable,
    data: { applicationId: "app-1", assetId: "asset-1" },
  },
  { name: "reembedExperienceUnit", fn: reembedExperienceUnitCallable, data: { unitId: "u-1" } },
  { name: "runMatching", fn: runMatchingCallable, data: { roleId: "role-1" } },
  { name: "deriveMatchEvidence", fn: deriveMatchEvidenceCallable, data: { roleId: "role-1" } },
];

function request(uid: string | null, data: Record<string, unknown>): CallableRequest<unknown> {
  return {
    data,
    auth: uid === null ? undefined : { uid, token: {} },
    rawRequest: {} as never,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe("every callable enforces the owner allowlist", () => {
  // Blank the provider keys so a regression that let a call past the
  // gate could never turn into a real, billed request from a
  // developer machine that happens to export one.
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const { name, fn, data } of CALLABLES) {
    it(`${name}: refuses a signed-in stranger with permission-denied`, async () => {
      vi.stubEnv("MATCHLINE_OWNER_UIDS", OWNER);
      const err = await caughtAsync(async () => fn.run(request(STRANGER, data)));
      expect(codeOf(err)).toBe("permission-denied");
    });

    it(`${name}: refuses everyone when MATCHLINE_OWNER_UIDS is empty`, async () => {
      vi.stubEnv("MATCHLINE_OWNER_UIDS", "");
      const err = await caughtAsync(async () => fn.run(request(OWNER, data)));
      expect(codeOf(err)).toBe("permission-denied");
    });

    it(`${name}: still refuses an unauthenticated caller as unauthenticated`, async () => {
      vi.stubEnv("MATCHLINE_OWNER_UIDS", OWNER);
      const err = await caughtAsync(async () => fn.run(request(null, data)));
      expect(codeOf(err)).toBe("unauthenticated");
    });
  }
});

describe("text-bearing callables cap their input size", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const oversized = "a".repeat(MAX_TEXT_INPUT_BYTES + 1);

  it("extractFromResume rejects oversized text with invalid-argument", async () => {
    vi.stubEnv("MATCHLINE_OWNER_UIDS", OWNER);
    const err = await caughtAsync(async () =>
      extractFromResumeCallable.run(request(OWNER, { text: oversized })),
    );
    expect(codeOf(err)).toBe("invalid-argument");
  });

  it("parseJobRequirements rejects oversized text with invalid-argument, before the role lookup", async () => {
    // No Firestore app exists in this process, so reaching the role
    // read would throw something other than an HttpsError.
    vi.stubEnv("MATCHLINE_OWNER_UIDS", OWNER);
    const err = await caughtAsync(async () =>
      parseJobRequirementsCallable.run(request(OWNER, { roleId: "role-1", text: oversized })),
    );
    expect(codeOf(err)).toBe("invalid-argument");
  });
});
