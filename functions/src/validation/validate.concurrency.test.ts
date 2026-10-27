import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CALLABLE_TIMEOUT_SECONDS } from "../callables/timeouts.ts";
import type { ExperienceUnit } from "../types/capability.ts";
import type { AssetRef, GeneratedAssetContent, GeneratedBullet } from "../types/crm.ts";

import {
  CallPoolAborted,
  MAX_VALIDATION_CONCURRENCY,
  ValidationDeadlineExceeded,
  createCallPool,
  settleInOrder,
} from "./callPool.ts";
import type { Claim } from "./claimExtraction.ts";
import { TraceabilityCheckError } from "./errors.ts";
import { checkTraceability } from "./traceability.ts";
import type { SpecificityResult } from "./specificity.ts";
import type { TraceabilityResult } from "./traceability.ts";
import {
  VALIDATION_CONCURRENCY,
  VALIDATION_DEADLINE_MARGIN_MS,
  validateAsset,
  type ValidateAssetContext,
  type ValidationDeps,
} from "./validate.ts";

/**
 * Bounded-concurrency pins for the validation orchestrator (#619,
 * #491). The checks are fakes that take a fixed time each, so these
 * tests pin the scheduling, not the model: the in-flight cap,
 * document-order output, traceability before specificity, fail-fast
 * on an error, and that a normal-size résumé fits inside the
 * callable's budget while a sequential run would not.
 */

const CTX: ValidateAssetContext = {
  ownerUid: "user-alice",
  applicationId: "app-1",
  assetId: "asset-1",
};

const UNIT: ExperienceUnit = {
  id: "u1",
  owner_uid: "user-alice",
  source_type: "resume",
  source_ref: "ref",
  raw_text: "Unit u1 raw text",
  normalized_summary: "Unit u1 summary",
  unit_type: "project",
  skills: [],
  tools: [],
  domains: [],
  seniority_signals: [],
  scope_signals: [],
  business_outcomes: [],
  metrics: [],
  evidence_type: "verified",
  confidence_score: 1,
  user_approved: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const TRACED: TraceabilityResult = {
  supports: true,
  supporting_unit_id: "u1",
  rationale: "Unit u1 supports the claim.",
};
const SPEC_OK: SpecificityResult = { specific: true, rationale: "Verifiable." };

const item = (id: string): GeneratedBullet => ({ id, text: `Text of ${id}.`, source_unit_ids: ["u1"] });

/**
 * A résumé with the given item counts. "Normal size" below is a
 * summary, 12 bullets, 10 skills and 2 education entries: longer than
 * #616's fixture (a summary, 3 bullets, 6 skills), which timed out.
 */
function content(bullets: number, skills: number, education: number): GeneratedAssetContent {
  return {
    summary: item("summary"),
    bullets: Array.from({ length: bullets }, (_, i) => item(`b${i + 1}`)),
    skills: Array.from({ length: skills }, (_, i) => item(`s${i + 1}`)),
    education: Array.from({ length: education }, (_, i) => item(`e${i + 1}`)),
  };
}

function deps(c: GeneratedAssetContent, overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  const asset: AssetRef = {
    id: "asset-1",
    owner_uid: "user-alice",
    application_id: "app-1",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: c,
    validation_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  let n = 0;
  return {
    loadAsset: async () => ({ asset, content: c }),
    loadUnits: async () => [UNIT],
    persistFlags: async () => {},
    generateId: () => `flag-${++n}`,
    now: () => "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

const claimsFor = (bulletId: string, count: number): Claim[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${bulletId}-c${i + 1}`, bullet_id: bulletId, text: "x" }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe("validateAsset bounded concurrency (#619)", () => {
  it("overlaps calls but never runs more than the cap at once", async () => {
    let active = 0;
    let peak = 0;
    const timed = async <T>(value: T): Promise<T> => {
      active++;
      peak = Math.max(peak, active);
      await sleep(2);
      active--;
      return value;
    };
    const result = await validateAsset(
      CTX,
      deps(content(5, 4, 1), {
        concurrency: 3,
        extractClaims: async (_bullet, ctx) => timed(claimsFor(ctx.bulletId!, 3)),
        checkTraceability: async () => timed(TRACED),
        checkSpecificity: async () => timed(SPEC_OK),
      }),
    );
    expect(result.flags).toHaveLength(11 * 3);
    expect(peak).toBe(3);
  });

  it("emits flags, ids included, in document order whatever order the calls finish in", async () => {
    // Earlier items' checks are slower, so they finish last.
    const c = content(3, 2, 0);
    const order = [c.summary, ...c.bullets, ...c.skills].map((b) => b.id);
    const delay = (bulletId: string) => (order.length - order.indexOf(bulletId)) * 3;
    const result = await validateAsset(
      CTX,
      deps(c, {
        extractClaims: async (_bullet, ctx) => {
          await sleep(delay(ctx.bulletId!));
          return claimsFor(ctx.bulletId!, 2);
        },
        checkTraceability: async (claim) => {
          await sleep(delay(claim.bullet_id) + (claim.id.endsWith("c1") ? 2 : 0));
          return TRACED;
        },
        checkSpecificity: async () => SPEC_OK,
      }),
    );
    expect(result.flags.map((f) => f.claim_id)).toEqual(
      order.flatMap((id) => [`${id}-c1`, `${id}-c2`]),
    );
    expect(result.flags.map((f) => f.id)).toEqual(
      Array.from({ length: order.length * 2 }, (_, i) => `flag-${i + 1}`),
    );
  });

  it("checks a claim's specificity only after its traceability returns", async () => {
    const events: string[] = [];
    await validateAsset(
      CTX,
      deps(content(4, 0, 0), {
        extractClaims: async (_bullet, ctx) => claimsFor(ctx.bulletId!, 3),
        checkTraceability: async (claim) => {
          events.push(`trace-start ${claim.id}`);
          await sleep(1);
          events.push(`trace-end ${claim.id}`);
          return TRACED;
        },
        checkSpecificity: async (claim) => {
          events.push(`spec-start ${claim.id}`);
          return SPEC_OK;
        },
      }),
    );
    const specs = events.filter((e) => e.startsWith("spec-start"));
    expect(specs).toHaveLength(5 * 3);
    for (const spec of specs) {
      const claimId = spec.slice("spec-start ".length);
      expect(events.indexOf(`trace-end ${claimId}`)).toBeLessThan(events.indexOf(spec));
    }
  });

  it("a failed call stops queued calls, surfaces its own error and persists nothing", async () => {
    let traceCalls = 0;
    const persistFlags = vi.fn(async () => {});
    const run = validateAsset(
      CTX,
      deps(content(12, 10, 2), {
        concurrency: 2,
        persistFlags,
        extractClaims: async (_bullet, ctx) => claimsFor(ctx.bulletId!, 3),
        checkTraceability: async (claim) => {
          traceCalls++;
          await sleep(1);
          if (claim.id === "summary-c2") throw new TraceabilityCheckError("budget exhausted", []);
          return TRACED;
        },
        checkSpecificity: async () => SPEC_OK,
      }),
    );
    await expect(run).rejects.toBeInstanceOf(TraceabilityCheckError);
    expect(persistFlags).not.toHaveBeenCalled();
    // 25 items × 3 claims would be 75 traceability calls.
    expect(traceCalls).toBeLessThan(75);
  });

  it("fits a normal-size résumé inside the callable budget at 2× #616's per-call p50", async () => {
    vi.useFakeTimers();
    const CALL_MS = 5_000;
    const budgetMs = CALLABLE_TIMEOUT_SECONDS.validateAsset * 1000;
    const slow = async <T>(value: T): Promise<T> => {
      await sleep(CALL_MS);
      return value;
    };
    const run = (concurrency: number) =>
      validateAsset(
        CTX,
        deps(content(12, 10, 2), {
          concurrency,
          budgetMs,
          extractClaims: async (_bullet, ctx) => slow(claimsFor(ctx.bulletId!, 3)),
          checkTraceability: async () => slow(TRACED),
          checkSpecificity: async () => slow(SPEC_OK),
        }),
      ).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );

    // 25 items, 75 claims: 25 + 75 × 2 = 175 calls, 875 s one at a time.
    const start = Date.now();
    const pending = run(VALIDATION_CONCURRENCY);
    await vi.runAllTimersAsync();
    const parallel = await pending;
    expect(parallel.error).toBeUndefined();
    expect(parallel.result!.flags).toHaveLength(75);
    // 175 calls in waves of 6 at 5 s: 150 s, well before the deadline.
    expect(Date.now() - start).toBeLessThanOrEqual(budgetMs - VALIDATION_DEADLINE_MARGIN_MS);

    // The same résumé one call at a time hits the deadline and says so,
    // instead of running into the platform's kill.
    const sequentialStart = Date.now();
    const sequentialPending = run(1);
    await vi.runAllTimersAsync();
    const sequential = await sequentialPending;
    expect(sequential.error).toBeInstanceOf(ValidationDeadlineExceeded);
    expect(Date.now() - sequentialStart).toBeLessThan(budgetMs);
  });

  it("throws at the deadline even when an in-flight call stalls, and cancels it (Codex on #621)", async () => {
    vi.useFakeTimers();
    const budgetMs = CALLABLE_TIMEOUT_SECONDS.validateAsset * 1000;
    let cancelled = 0;
    const start = Date.now();
    const run = validateAsset(
      CTX,
      deps(content(1, 0, 0), {
        budgetMs,
        extractClaims: async (_bullet, ctx) => claimsFor(ctx.bulletId!, 2),
        // Stalls far past the platform's timeout; only an abort ends it.
        checkTraceability: (_claim, _units, ctx) =>
          new Promise<TraceabilityResult>((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              cancelled++;
              reject(new Error("aborted"));
            });
            setTimeout(() => reject(new Error("never reached")), 10 * budgetMs);
          }),
        checkSpecificity: async () => SPEC_OK,
      }),
    ).then(
      () => undefined,
      (error: unknown) => ({ error, at: Date.now() - start }),
    );
    await vi.advanceTimersByTimeAsync(budgetMs);
    const outcome = await run;
    expect(outcome?.error).toBeInstanceOf(ValidationDeadlineExceeded);
    expect(outcome?.at).toBe(budgetMs - VALIDATION_DEADLINE_MARGIN_MS);
    // Both claims of both items were in flight and are cancelled.
    expect(cancelled).toBe(4);
  });

  it("reports the real failure, not the abort errors of the calls it cancelled", async () => {
    const run = validateAsset(
      CTX,
      deps(content(3, 0, 0), {
        extractClaims: async (_bullet, ctx) => claimsFor(ctx.bulletId!, 2),
        checkTraceability: (claim, _units, ctx) =>
          new Promise<TraceabilityResult>((resolve, reject) => {
            // Cancelled calls fail the way a check's retry budget does,
            // with the same error class as the real failure.
            ctx.signal?.addEventListener("abort", () =>
              reject(new TraceabilityCheckError(`cancelled ${claim.id}`, [])),
            );
            if (claim.id === "b3-c1") {
              setTimeout(() => reject(new TraceabilityCheckError("real failure", [])), 2);
            } else {
              setTimeout(() => resolve(TRACED), 50);
            }
          }),
        checkSpecificity: async () => SPEC_OK,
      }),
    );
    await expect(run).rejects.toThrow("real failure");
  });

  it("still ends at the deadline when a failure came first and a call won't settle (Codex on #621)", async () => {
    vi.useFakeTimers();
    const budgetMs = CALLABLE_TIMEOUT_SECONDS.validateAsset * 1000;
    const start = Date.now();
    const run = validateAsset(
      CTX,
      deps(content(1, 0, 0), {
        budgetMs,
        extractClaims: async (_bullet, ctx) => claimsFor(ctx.bulletId!, 1),
        // The summary's claim fails at once; b1's ignores the abort and
        // settles long after the platform's timeout.
        checkTraceability: (claim) =>
          claim.id === "summary-c1"
            ? Promise.reject(new TraceabilityCheckError("real failure", []))
            : new Promise<TraceabilityResult>((resolve) => setTimeout(() => resolve(TRACED), 10 * budgetMs)),
        checkSpecificity: async () => SPEC_OK,
      }),
    ).then(
      () => ({ error: undefined, at: Date.now() - start }),
      (error: unknown) => ({ error, at: Date.now() - start }),
    );
    await vi.advanceTimersByTimeAsync(budgetMs);
    const outcome = await run;
    expect(outcome.error).toBeInstanceOf(TraceabilityCheckError);
    expect((outcome.error as Error).message).toBe("real failure");
    expect(outcome.at).toBe(budgetMs - VALIDATION_DEADLINE_MARGIN_MS);
  });

  it("counts the Firestore reads against the budget (CodeRabbit on #621)", async () => {
    vi.useFakeTimers();
    const budgetMs = CALLABLE_TIMEOUT_SECONDS.validateAsset * 1000;
    const deadlineMs = budgetMs - VALIDATION_DEADLINE_MARGIN_MS;
    const c = content(1, 0, 0);
    const base = deps(c);
    const start = Date.now();
    const run = validateAsset(
      CTX,
      deps(c, {
        budgetMs,
        // The read leaves 10 s before the deadline; extraction takes 20 s.
        // A clock started after the read would let the run finish.
        loadAsset: async (ctx) => {
          await sleep(deadlineMs - 10_000);
          return base.loadAsset!(ctx);
        },
        extractClaims: async (_bullet, ctx) => {
          await sleep(20_000);
          return claimsFor(ctx.bulletId!, 1);
        },
        checkTraceability: async () => TRACED,
        checkSpecificity: async () => SPEC_OK,
      }),
    ).then(
      () => ({ error: undefined, at: Date.now() - start }),
      (error: unknown) => ({ error, at: Date.now() - start }),
    );
    await vi.advanceTimersByTimeAsync(budgetMs);
    const outcome = await run;
    expect(outcome.error).toBeInstanceOf(ValidationDeadlineExceeded);
    expect(outcome.at).toBe(deadlineMs);
  });

  it("ends at the deadline when a Firestore read never returns (CodeRabbit on #621)", async () => {
    vi.useFakeTimers();
    const budgetMs = CALLABLE_TIMEOUT_SECONDS.validateAsset * 1000;
    const extractClaims = vi.fn(async () => []);
    const start = Date.now();
    const run = validateAsset(
      CTX,
      deps(content(1, 0, 0), {
        budgetMs,
        loadAsset: () => new Promise(() => {}),
        extractClaims,
        checkTraceability: async () => TRACED,
        checkSpecificity: async () => SPEC_OK,
      }),
    ).then(
      () => ({ error: undefined, at: Date.now() - start }),
      (error: unknown) => ({ error, at: Date.now() - start }),
    );
    await vi.advanceTimersByTimeAsync(budgetMs);
    const outcome = await run;
    expect(outcome.error).toBeInstanceOf(ValidationDeadlineExceeded);
    expect(outcome.at).toBe(budgetMs - VALIDATION_DEADLINE_MARGIN_MS);
    expect(extractClaims).not.toHaveBeenCalled();
  });

  it("rejects a concurrency outside 1..MAX_VALIDATION_CONCURRENCY", () => {
    for (const concurrency of [0, MAX_VALIDATION_CONCURRENCY + 1, 1.5, Number.NaN]) {
      expect(() => createCallPool({ concurrency })).toThrow(RangeError);
    }
    expect(() => createCallPool({ concurrency: MAX_VALIDATION_CONCURRENCY })).not.toThrow();
  });
});

describe("settleInOrder", () => {
  it("throws the first real failure, not a CallPoolAborted it caused", async () => {
    const real = new Error("real");
    await expect(
      settleInOrder([Promise.reject(new CallPoolAborted()), Promise.reject(real), Promise.resolve(1)]),
    ).rejects.toBe(real);
  });

  it("waits for every promise before throwing", async () => {
    let finished = false;
    const slow = sleep(5).then(() => {
      finished = true;
    });
    await expect(settleInOrder([Promise.reject(new Error("fast")), slow])).rejects.toThrow("fast");
    expect(finished).toBe(true);
  });
});

describe("validation checks honor the orchestrator's abort", () => {
  it("an abort during backoff ends the wait and skips the next attempt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const create = vi.fn(async () => {
      // A 429 asking for a minute's wait.
      const err = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "60" },
      });
      throw err;
    });
    const run = checkTraceability(
      { id: "c1", bullet_id: "b1", text: "x" },
      [UNIT],
      { ownerUid: "user-alice", signal: controller.signal },
      { client: { messages: { create } } as unknown as Anthropic, record: async () => 0 },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("pool aborted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBeInstanceOf(Error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("an aborted traceability call is not retried", async () => {
    const controller = new AbortController();
    const create = vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
      controller.abort();
      expect(options?.signal).toBe(controller.signal);
      throw new Error("Request was aborted.");
    });
    const run = checkTraceability(
      { id: "c1", bullet_id: "b1", text: "x" },
      [UNIT],
      { ownerUid: "user-alice", signal: controller.signal },
      { client: { messages: { create } } as unknown as Anthropic, record: async () => 0 },
    );
    await expect(run).rejects.toThrow("Request was aborted.");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
