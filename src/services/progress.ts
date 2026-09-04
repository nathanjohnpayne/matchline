/**
 * Client mirror of the callable progress vocabulary (#428).
 *
 * The client cannot import `functions/src/llm/progress.ts` — separate
 * package, separate `node_modules` — so the vocabulary is declared
 * twice and `tests/progress-contract.test.ts` pins the two together,
 * the same arrangement `callable-timeouts.ts` uses for the timeout
 * tables.
 *
 * Also holds the copy mapping and elapsed formatting, as pure
 * functions: what the user reads during a two-minute wait is exactly
 * the kind of thing that should be testable without a timer.
 */

/** Must stay identical to `PROGRESS_STAGES` in the functions package. */
export const PROGRESS_STAGES = [
  "analyzing",
  "retrying",
  "embedding",
  "saving",
] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export interface ProgressEvent {
  readonly stage: ProgressStage;
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

/**
 * Narrow an untrusted stream chunk to a `ProgressEvent`.
 *
 * Chunks arrive over the wire and are shaped by whatever version of
 * the function is currently deployed — which, as #422 demonstrated at
 * length, is not necessarily the version this client was built
 * against. An unrecognized stage yields `null` so the caller can hold
 * its last known-good state rather than render a stage it has no copy
 * for.
 */
function isPositiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function parseProgressEvent(raw: unknown): ProgressEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { stage, attempt, maxAttempts } = raw as Record<string, unknown>;
  if (typeof stage !== "string") return null;
  if (!(PROGRESS_STAGES as readonly string[]).includes(stage)) return null;
  // Reject the whole chunk rather than sanitizing it. An earlier
  // version dropped bad counters and kept the event, which meant the
  // wire contract in `specs/matchline.md § Streaming progress` — where
  // counters belong to `analyzing`/`retrying` only and a violating
  // chunk is discarded — and the parser disagreed. Two contracts is
  // worse than either one: a version-skewed server would get a
  // partially-honoured event and the spec would be quietly false.
  // Discarding leaves the UI on its last known-good state, which is
  // the same treatment an unknown stage already gets (Codex P2, #436).
  const hasAttempt = attempt !== undefined;
  const hasMax = maxAttempts !== undefined;
  const countersAllowed = stage === "analyzing" || stage === "retrying";

  if ((hasAttempt || hasMax) && !countersAllowed) return null;
  if (hasAttempt && !isPositiveInt(attempt)) return null;
  if (hasMax && !isPositiveInt(maxAttempts)) return null;
  if (hasAttempt && hasMax && (maxAttempts as number) < (attempt as number)) {
    return null;
  }

  return {
    stage: stage as ProgressStage,
    ...(hasAttempt ? { attempt: attempt as number } : {}),
    ...(hasMax ? { maxAttempts: maxAttempts as number } : {}),
  };
}

/** Per-operation nouns, so shared stage copy reads correctly. */
export interface ProgressVocabulary {
  /** What the `analyzing` stage is reading, e.g. `"your resume"`. */
  readonly subject: string;
  /** What is produced, e.g. `"Experience Units"`. */
  readonly product: string;
}

export const EXTRACTION_VOCABULARY: ProgressVocabulary = {
  subject: "your resume",
  product: "Experience Units",
};

export const JD_PARSING_VOCABULARY: ProgressVocabulary = {
  subject: "the job description",
  product: "Requirements",
};

/**
 * The line shown to the user for a given event.
 *
 * A retry is called out explicitly. It is the single most useful thing
 * to surface during a long wait: a second attempt is otherwise
 * indistinguishable from a hang, and it is the leading indicator of
 * the "needs manual review" outcome. Saying so plainly is better than
 * a bar that implies steady progress toward success.
 */
export function progressMessage(
  event: ProgressEvent | null,
  vocab: ProgressVocabulary,
): string {
  if (event === null) return `Working on ${vocab.subject}…`;
  switch (event.stage) {
    case "analyzing": {
      const { attempt, maxAttempts } = event;
      if (attempt !== undefined && attempt > 1) {
        const of = maxAttempts !== undefined ? ` of ${maxAttempts}` : "";
        return `Retrying — the last attempt didn't come back usable. Attempt ${attempt}${of}.`;
      }
      return `Reading ${vocab.subject}…`;
    }
    case "retrying": {
      const { attempt, maxAttempts } = event;
      const of = maxAttempts !== undefined ? ` of ${maxAttempts}` : "";
      const which = attempt !== undefined ? ` Attempt ${attempt}${of} next.` : "";
      // Named separately from `analyzing` because the wait can be long
      // — a 429 carries `retry-after` — and saying "Reading…" through
      // it recreates the apparent hang (Codex P2, #436).
      return `That attempt didn't come back usable. Waiting before trying again.${which}`;
    }
    case "embedding":
      return `Indexing the ${vocab.product} for matching…`;
    case "saving":
      return `Saving your ${vocab.product}…`;
  }
}

/**
 * Elapsed time as a short human string. Seconds below a minute, then
 * `m:ss` — precise enough to show motion, coarse enough not to read
 * like a countdown the operation is failing to meet.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Typical durations, measured 2026-08-31 against the real corpus.
 * Used only for the "usually takes about…" expectation, never to
 * advance a stage — inventing progress is what route A of #428 was
 * rejected for.
 */
export const TYPICAL_DURATION_MS = {
  extraction: 110_000,
  jdParsing: 40_000,
} as const;

/**
 * The reassurance line under the status.
 *
 * Setting an expectation up front is what stops a user reloading at 45
 * seconds and abandoning a call that was going to succeed. Once the
 * operation runs past the typical duration, the copy stops implying
 * imminent completion rather than pretending nothing is unusual.
 */
export function durationHint(elapsedMs: number, typicalMs: number): string {
  const typicalSeconds = Math.round(typicalMs / 1000);
  if (elapsedMs <= typicalMs) {
    return `This usually takes about ${typicalSeconds} seconds.`;
  }
  return "Taking longer than usual — still working, and still worth waiting for.";
}
