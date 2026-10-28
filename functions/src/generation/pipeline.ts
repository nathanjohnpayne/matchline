/**
 * Resume generation pipeline (sub-issue #120 of #22). Step 5
 * of the core loop (extraction → JD parsing → matching →
 * validation → generation).
 *
 * Composes:
 *   { ownerUid, applicationId }
 *     → loadInputs        (approved Units + Role + Requirements + Matches)
 *     → empty-Units guard (throw if no Units; nothing to ground on)
 *     → render input      (`./resumeInput.ts`: the shared Unit evidence
 *                          text, the target role and the approved links,
 *                          in tagged sections, #485)
 *     → LLM call + retry  (Sonnet schema + 3-attempt budget)
 *     → schema validation (#119's strict response shape)
 *     → cross-validation  (every source_unit_ids id ∈ loaded Units)
 *     → server-stamp ids  (UUIDs on summary + each bullet/skill/edu)
 *     → GeneratedAssetContent + cost/latency telemetry  (returned)
 *
 * Mirror of `parsing/pipeline.ts` (#19) + `validation/validate.ts`
 * (#109): same DI shape, same retry + cost-tracking discipline,
 * same defense-in-depth pattern (schema + value-level cross-
 * validation; the validator at #23 is a third layer).
 *
 * The cross-validation that every emitted `source_unit_ids`
 * value matches a loaded Unit is the load-bearing zero-fab pin
 * on the write side, parallel to the validator's traceability
 * check (#107) on the read side. A fabricated id triggers a
 * retry; on third occurrence the call fails. Same shape as
 * #107's value-level guard catching the model's confident-
 * looking-but-fabricated supporting_unit_id.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { logger } from "firebase-functions";
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { getAdminDb } from "../firestore/admin.js";
import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import {
  anthropicUsageFields,
  priceUsage,
  promptVersionLabel,
  recordUsage,
  type UsageRecord,
} from "../llm/cost.js";
import { transportBackoffMs } from "../llm/retry.js";
import { loadPromptText } from "../prompts/loader.js";
import {
  ResumeGenerationResponseV2Schema,
  type ResumeGenerationResponseV2,
} from "../prompts/generation/resume.v2.schema.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";
import type { Role } from "../types/crm.js";
import { logRetryExhaustion } from "../llm/retryDiagnostics.js";
import type {
  GeneratedAssetContent,
  GeneratedItem,
} from "../types/crm.js";

import {
  GenerationError,
  GenerationNoApprovedUnitsError,
  type GenerationAttemptFailure,
} from "./errors.js";
import {
  generationSnapshotOf,
  renderResumeInput,
  renderedLinksOf,
  sortById,
  type GenerationSnapshot,
  type ResumeInput,
} from "./resumeInput.js";
import { citedEntityId } from "../validation/unitPromptText.js";

export interface RunGenerationContext {
  readonly ownerUid: string;
  readonly applicationId: string;
}

export interface GenerationInputs {
  readonly units: readonly ExperienceUnit[];
  readonly role: Role;
  readonly requirements: readonly JobRequirementUnit[];
  readonly approvedMatches: readonly UnitMatch[];
}

export interface RunGenerationResult {
  readonly content: GeneratedAssetContent;
  /**
   * The Requirement set the prompt was built from, as a token.
   * The persist transaction rejects the write if it no longer
   * matches — see `requirementSetToken`.
   */
  readonly requirement_set_token: string;
  /**
   * What the prompt rendered beyond the Requirement set: the role
   * title, each rendered Unit's evidence version and each rendered
   * approved link. The persist transaction re-checks it against live
   * documents and refuses the write if any of it changed or was
   * withdrawn (`findSnapshotDrift` in `./snapshot.ts`, #485).
   */
  readonly snapshot: GenerationSnapshot;
  /**
   * List-price estimate of every attempt, priced through the shared
   * rate table (`llm/rates.ts`) on the model that served each call.
   * `null` when any attempt could not be priced: an unknown cost is
   * reported as unknown, never as a lower number.
   */
  readonly cost_usd: number | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
}

export interface GenerationDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  /** Override for tests. Default reads from Firestore. */
  readonly loadInputs?: (
    ctx: RunGenerationContext,
  ) => Promise<GenerationInputs>;
  /** Injectable for deterministic ids in tests. */
  readonly generateId?: () => string;
  /** Sleep for transport backoff; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 4096;
const TOOL_NAME = "record_resume";

/**
 * Model-visible reminder appended to the system prompt after a failed
 * attempt, keyed by what went wrong (#485). The previous list was keyed
 * by attempt index, so attempt 1 always blamed "schema validation",
 * even after a fabricated id or a transport failure. A transport
 * failure says nothing about the response, so the reminder comes from
 * the latest failure that produced a response (`lastResponseFailure`):
 * after schema_error then transport_error, attempt 3 still gets the
 * schema reminder, because the last response the model actually sent
 * was schema-invalid.
 */
const RETRY_REMINDER: Readonly<Record<GenerationAttemptFailure["kind"], string>> = {
  transport_error: "",
  no_tool_use:
    "\n\nYour previous response did not call the `record_resume` tool. Respond only by calling it.",
  schema_error:
    "\n\nYour previous response did not match the `record_resume` schema. Send only the schema's fields. Leave out any item you cannot support; never send an item with empty text or empty `source_unit_ids`.",
  value_error:
    "\n\nYour previous response cited an id that is not a `[Unit …]` id in `<candidate_evidence>`. Cite only those ids, exactly as written. Never cite a `[Requirement …]` id or an id from the example.",
};

/**
 * The latest failure whose attempt got a response from the model, or
 * `undefined` when every failure so far was a transport error (or there
 * is none). The retry reminder is chosen from it.
 */
export function lastResponseFailure(
  failures: readonly GenerationAttemptFailure[],
): GenerationAttemptFailure | undefined {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i]!;
    if (f.kind !== "transport_error") return f;
  }
  return undefined;
}

export async function runGenerationPipeline(
  ctx: RunGenerationContext,
  deps: GenerationDeps = {},
): Promise<RunGenerationResult> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const loadInputs = deps.loadInputs ?? defaultLoadInputs;
  const generateId = deps.generateId ?? randomUUID;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const inputs = await loadInputs(ctx);

  // Filter to Units that have at least one APPROVED match for
  // this Role. The spec's gate is "approved Units AND their
  // approved matches" — both signals required, mirroring the
  // zero-fab discipline at every other layer of the pipeline.
  // A Unit the user approved but never connected to a Role
  // Requirement (no approved match) is generic content; using
  // it as ground for THIS Role's resume invites generic prose
  // the user hasn't reviewed in context.
  // cursor CHANGES_REQUESTED round 1 on PR #123 caught the gap:
  // the prior version loaded approvedMatches but didn't use
  // them to gate the prompt input.
  // Drop approved matches whose Requirement no longer exists
  // (#442).
  //
  // A JD re-parse replaces the Role's Requirements under NEW ids
  // (`parsing/pipeline.ts` clear-and-replace) before matching
  // runs. `RoleDetail` fires `runMatching` straight afterwards to
  // close that window, but if that call fails — a timeout, a
  // transient callable error, the user closing the tab — the old
  // matches survive pointing at ids that are gone.
  //
  // Those matches are not inert. They keep `approved_for_use`,
  // and this gate reads only `experience_unit_id`, so a stranded
  // match made its Unit eligible to ground a resume on the
  // strength of a Requirement the employer's JD no longer
  // contains. That is a zero-fabrication violation reached
  // through stale data rather than through a bad model output,
  // which is why it survived every other guard in the pipeline.
  //
  // `requirements` is already loaded here, role- and
  // owner-scoped, so the check costs nothing.
  const liveApprovedMatches = liveApprovedMatchesOf(
    inputs.approvedMatches,
    inputs.requirements,
  );
  const strandedApprovedCount =
    inputs.approvedMatches.length - liveApprovedMatches.length;

  const approvedMatchedUnitIds = new Set(
    liveApprovedMatches.map((m) => m.experience_unit_id),
  );
  const eligibleUnits = inputs.units.filter((u) =>
    approvedMatchedUnitIds.has(u.id),
  );

  if (eligibleUnits.length === 0) {
    // Empty-eligible-Units short-circuit. Two distinct upstream
    // causes both land here: (a) no approved Units, or (b)
    // approved Units but no approved matches connecting any of
    // them to this Role's Requirements. The error message
    // distinguishes for the editor surface (#24)'s UX.
    // Three causes now, and the third needs a DIFFERENT remedy.
    // "Approve at least one match" is wrong advice for a user who
    // already approved matches that a re-parse then stranded —
    // there is nothing left to approve, and the fix is to re-run
    // matching against the current Requirements.
    //
    // **Order matters, and the first version got it wrong.**
    // Matches are loaded Role-wide while Units come from the
    // Application's `approved_unit_ids` snapshot, so an
    // Application with no loaded Units can coexist with orphaned
    // Role matches — a legacy Application with an empty snapshot,
    // or one whose Units were later deleted or unapproved.
    // Reporting the stranded case there printed the
    // self-contradicting "Approved Units present (0)" AND told
    // the user to re-run matching, which cannot make such an
    // Application generate. The no-Units diagnosis is the
    // actionable one and has to win. Codex P2 on PR #449.
    // An empty Requirement set needs its own remedy, and it is
    // NOT a rematch. Matching against zero Requirements can only
    // delete the stale rows; it cannot produce grounding, so
    // sending the user there leaves them exactly where they
    // started. The JD has to be parsed again first. Codex P2 on
    // PR #449.
    // No Requirements at all — regardless of whether any approved
    // match survived. The stranded-count precondition was wrong:
    // a Role that parses to an empty set, or one whose stale rows
    // a later matching run already cleared, has zero Requirements
    // AND zero approved matches, and fell through to the generic
    // "approve a match in the Matches tab" — advice that cannot
    // be followed when there is nothing to match against.
    // CodeRabbit on PR #449.
    if (inputs.units.length > 0 && inputs.requirements.length === 0) {
      const stranded =
        strandedApprovedCount > 0
          ? ` ${strandedApprovedCount} approved UnitMatch(es) still point at ` +
            `requirements from a previous version of the description.`
          : "";
      throw new GenerationNoApprovedUnitsError(
        `Approved Units present (${inputs.units.length}), but this Role has ` +
          `no Requirements at all — the job description has not been parsed, ` +
          `or was parsed into an empty set, so there is nothing to ground ` +
          `against.${stranded} Nothing to generate from for application ` +
          `${ctx.applicationId}; parse the job description again on the ` +
          `Requirements tab.`,
      );
    }
    if (
      inputs.units.length > 0 &&
      liveApprovedMatches.length === 0 &&
      strandedApprovedCount > 0
    ) {
      throw new GenerationNoApprovedUnitsError(
        `Approved Units present (${inputs.units.length}) and ` +
          `${strandedApprovedCount} approved UnitMatch(es) for this Role, but ` +
          `every one points at a Requirement that no longer exists — the job ` +
          `description was re-parsed and matching has not been re-run since. ` +
          `Nothing to generate from for application ${ctx.applicationId}; ` +
          `re-run matching on the Matches tab before generating.`,
      );
    }
    const detail =
      inputs.units.length === 0
        ? "No approved ExperienceUnits"
        : `Approved Units present (${inputs.units.length}) but no approved UnitMatches for this Role`;
    throw new GenerationNoApprovedUnitsError(
      `${detail} for application ${ctx.applicationId}; nothing to generate from. Approve at least one match in the Matches tab before generating.`,
    );
  }

  const prompt = loadPromptText("generation", "resume");
  const { provider, model } = modelFor("generation");
  if (provider !== "anthropic") {
    throw new Error(
      `Generation stage expects an Anthropic model; modelFor("generation") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToToolSchema(ResumeGenerationResponseV2Schema);

  // The cross-validation Unit set is the ELIGIBLE Units only —
  // the same set the prompt sees. A fabricated id catches both
  // pure inventions AND attempts to ground on a Unit the user
  // approved but didn't connect to this Role via an approved
  // match. Same gate, two failure modes.
  const validUnitIds = new Set(eligibleUnits.map((u) => u.id));
  const failures: GenerationAttemptFailure[] = [];

  // The rendered input (#485): the eligible Units through the shared
  // evidence formatter, the Role's title and every Requirement with its
  // id, and the approved links among those Units. Rendered once; it
  // does not change between attempts. Eligibility is unchanged — this
  // only decides what the model sees of the Units already admitted.
  const resumeInput: ResumeInput = {
    units: sortById(eligibleUnits),
    // `Role.company_id` is a UUID, not a display name — the
    // human-readable Company name lives on the Company doc and
    // isn't loaded here in V1. Emit only the title; the LLM
    // grounds from Units (where employer info lives implicitly
    // in `raw_text`). CodeRabbit caught this leak on PR #123
    // (advisory finding round 1). Phase 2 follow-up: load
    // Company doc + pass its `name` field.
    roleTitle: inputs.role.title ?? "",
    requirements: sortById(inputs.requirements),
    links: renderedLinksOf(liveApprovedMatches, validUnitIds),
  };
  const userContent = `${prompt.userFewShot}\n\n${renderResumeInput(resumeInput)}`;

  // Total elapsed time for the whole operation (including
  // retries + transport backoff). The returned `latency_ms`
  // reflects this so the caller's p95 SLA tracking sees true
  // end-to-end time, not just the last successful LLM call.
  // CodeRabbit caught the prior reset-per-attempt bug on PR
  // #123 (advisory finding round 1).
  const operationStart = Date.now();

  // Cumulative token + cost counters across ALL attempts. The
  // returned values reflect the full cost of the operation, not
  // just the final successful LLM call — a fabricated-id retry
  // burns real tokens that the caller's per-application budget
  // tracker (#26 cost telemetry) needs to see. Same shape fix
  // as the latency split above; CodeRabbit caught the symmetric
  // gap on PR #123 (advisory finding round 2).
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCostUsd: number | null = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Per-attempt timing for telemetry recordUsage — we want
    // each LLM call's latency reported separately to the cost
    // tracker for accurate provider-side benchmarking.
    const attemptStart = Date.now();
    const last = lastResponseFailure(failures);
    const systemWithReminder =
      prompt.system + (last === undefined ? "" : RETRY_REMINDER[last.kind]);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Record the structured generated resume content for the application.",
            input_schema: toolSchema as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userContent }],
        stream: false,
      });
    } catch (err) {
      failures.push({
        attempt,
        kind: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
      // Backoff before next attempt — same #112 pattern as
      // claimExtraction / traceability / specificity. Skip
      // sleep on the last attempt (no retry coming).
      //
      // Pass `err` so the helper can pull `retry-after` /
      // `anthropic-ratelimit-*-reset` headers off the SDK's
      // APIError and elevate the delay to the server-supplied
      // window (#114 / PR #144). Without `err`, generation
      // retries silently fall back to the exponential schedule
      // and ignore the server's hint — caught post-merge on
      // PR #144 (cursor review).
      if (attempt < MAX_ATTEMPTS - 1)
        await sleep(transportBackoffMs(attempt, err));
      continue;
    }

    const attemptLatencyMs = Date.now() - attemptStart;

    const usage: UsageRecord = {
      stage: "generation",
      provider: "anthropic",
      model,
      ...anthropicUsageFields(response),
      latencyMs: attemptLatencyMs,
      promptVersion: promptVersionLabel(prompt),
      attempt,
      maxTokens: MAX_OUTPUT_TOKENS,
      ownerUid: ctx.ownerUid,
      applicationId: ctx.applicationId,
    };

    // Accumulate immediately on a successful LLM round-trip,
    // BEFORE any of the schema / fabricated-id / no-tool-use
    // continues below. Tokens are billed even when the response
    // fails our gates and we retry. Each attempt is counted
    // exactly once, here; transport errors return no usage and
    // add nothing.
    cumulativeInputTokens += response.usage.input_tokens;
    cumulativeOutputTokens += response.usage.output_tokens;
    // Price through the same rate table as `llm_calls` telemetry
    // (#483). The previous local estimate used $0.25/$1.25 per MTok
    // against the configured Haiku 4.5's $1/$5 — a quarter of the
    // real list price for identical tokens.
    if (cumulativeCostUsd !== null) {
      try {
        cumulativeCostUsd += priceUsage(usage).costUsd;
      } catch (err) {
        logger.error("generation.resume: could not price attempt; cost reported as unknown", {
          model,
          servedModel: usage.servedModel,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        cumulativeCostUsd = null;
      }
    }

    // recordUsage is non-fatal — telemetry outages shouldn't
    // block generation. Mirror of #118's pattern.
    try {
      await record(usage);
    } catch (err) {
      console.warn("recordUsage failed (non-fatal)", err);
    }

    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (!toolUse) {
      failures.push({
        attempt,
        kind: "no_tool_use",
        message:
          "Anthropic response did not include a tool_use block; model returned text instead.",
      });
      continue;
    }

    const parsed = ResumeGenerationResponseV2Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
      });
      continue;
    }

    // Value-level cross-validation: every `source_unit_ids`
    // entry must match a Unit the pipeline loaded. The schema
    // can only check shape; this catches the LLM emitting a
    // confident-looking-but-fabricated id. Mirror of #107's
    // finalizeResult guard.
    // A model may echo the quotes `renderEntityId` puts around an
    // unsafe id; map those back to the raw ids before the check, so
    // the stored `source_unit_ids` are the raw ids.
    const cited = withCitedUnitIds(parsed.data);
    const fabricatedId = findFabricatedId(cited, validUnitIds);
    if (fabricatedId !== null) {
      failures.push({
        attempt,
        kind: "value_error",
        message: `Emitted source_unit_id "${fabricatedId}" does not match any loaded Unit. Valid ids: ${Array.from(validUnitIds).join(", ")}`,
      });
      continue;
    }

    // All gates passed. Stamp ids and return cumulative cost +
    // tokens (total spend across all attempts), with total
    // elapsed time. The caller's per-application budget tracker
    // sees the true cost of a successful generation, including
    // any preceding failed attempts that still burned tokens.
    return {
      content: stampIds(cited, generateId),
      // Captured from the SAME `inputs` the prompt was built
      // from, so the persist transaction can prove the set has
      // not moved underneath it.
      requirement_set_token: requirementSetToken(inputs.requirements),
      snapshot: generationSnapshotOf(resumeInput),
      cost_usd: cumulativeCostUsd,
      input_tokens: cumulativeInputTokens,
      output_tokens: cumulativeOutputTokens,
      latency_ms: Date.now() - operationStart,
    };
  }

  // Retry budget exhausted — record why, server-side (#426).
  logRetryExhaustion("generation.resume", model, failures);
  throw new GenerationError(
    `Resume generation failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

/**
 * Approved matches whose Requirement still exists (#442).
 *
 * Exported because the persist transaction in
 * `runGenerateResume.ts` re-applies the same rule against
 * freshly-read documents, and the two must not drift — a
 * revalidation that disagreed with the gate would either refuse
 * sound work or admit the very rows the gate rejected.
 */
export function liveApprovedMatchesOf(
  approvedMatches: readonly UnitMatch[],
  requirements: readonly JobRequirementUnit[],
): readonly UnitMatch[] {
  const currentRequirementIds = new Set(requirements.map((r) => r.id));
  return approvedMatches.filter((m) =>
    currentRequirementIds.has(m.job_requirement_unit_id),
  );
}

/**
 * A stable token for the Requirement set a generation ran
 * against (#442, Codex P1 on PR #449).
 *
 * `findStaleGroundingId` reduces both sides to Unit ids, so it
 * cannot tell "the grounding still holds" from "a DIFFERENT
 * requirement now grounds the same Unit". Concretely: a re-parse
 * lands mid-generation, the user approves a freshly computed
 * match for the same Unit, and the cited Unit looks grounded
 * again — while the artifact in hand was written for requirements
 * that no longer exist.
 *
 * Only an identity check on the set itself catches that, so the
 * token is compared verbatim and ANY change is rejected.
 *
 * **Content, not just ids.** The first version hashed ids alone,
 * which misses an edit in place: `services/roles.ts`'s
 * `upsertRequirement` merges into an existing document id, and
 * the rules permit owner-preserving updates, so a Requirement's
 * text can change while every id stays put. An id-only token used
 * as an equality proof would then certify a prompt built from
 * wording that no longer exists. Codex P2 on PR #449.
 *
 * The fields covered are the ones the prompt renders for each
 * Requirement — its id, `normalized_requirement` and the must-have
 * tag (`renderResumeInput` in `./resumeInput.ts`). A field the
 * prompt never shows cannot invalidate the artifact, and including
 * it would discard sound generations for edits the model never saw.
 * The rest of the rendered input — the Units, the approved links and
 * the role title — is covered by `RunGenerationResult.snapshot` and
 * `findSnapshotDrift` (`./snapshot.ts`, #485).
 *
 * JSON rather than a delimiter join, for the reason the
 * derivation key learned on #446: `["a","b"]` and `["a|b"]` must
 * not collide.
 */
export function requirementSetToken(
  requirements: readonly {
    readonly id: string;
    readonly normalized_requirement?: string;
    readonly must_have?: boolean;
  }[],
): string {
  return JSON.stringify(
    requirements
      .map(
        (r) =>
          [r.id, r.normalized_requirement ?? "", r.must_have === true] as const,
      )
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/**
 * The first cited `source_unit_ids` value no longer backed by an
 * approved match against a Requirement the Role still has, or
 * null if every citation still holds.
 *
 * Read at persist time. `loadInputs` reads Requirements and
 * matches through plain parallel queries, so a JD re-parse
 * committing between that read and the persist leaves the gate
 * above having approved grounding that has since evaporated —
 * and the window is the whole LLM call, which is minutes.
 * Codex P1 on PR #449.
 */
export function findStaleGroundingId(
  content: {
    readonly summary: { readonly source_unit_ids: readonly string[] };
    readonly bullets: readonly {
      readonly source_unit_ids: readonly string[];
    }[];
    readonly skills: readonly {
      readonly source_unit_ids: readonly string[];
    }[];
    readonly education?: readonly {
      readonly source_unit_ids: readonly string[];
    }[];
  },
  approvedMatches: readonly UnitMatch[],
  requirements: readonly JobRequirementUnit[],
): string | null {
  const stillGrounded = new Set(
    liveApprovedMatchesOf(approvedMatches, requirements).map(
      (m) => m.experience_unit_id,
    ),
  );
  const allItems = [
    content.summary,
    ...content.bullets,
    ...content.skills,
    ...(content.education ?? []),
  ];
  for (const item of allItems) {
    for (const id of item.source_unit_ids) {
      if (!stillGrounded.has(id)) return id;
    }
  }
  return null;
}

/**
 * `data` with every `source_unit_ids` entry passed through
 * `citedEntityId`, which undoes only the quoting `renderEntityId`
 * applies to an unsafe id. Safe ids (every UUID) are unchanged.
 */
function withCitedUnitIds(data: ResumeGenerationResponseV2): ResumeGenerationResponseV2 {
  const fix = <T extends { readonly source_unit_ids: readonly string[] }>(item: T): T => ({
    ...item,
    source_unit_ids: item.source_unit_ids.map(citedEntityId),
  });
  return {
    ...data,
    summary: fix(data.summary),
    bullets: data.bullets.map(fix),
    skills: data.skills.map(fix),
    ...(data.education === undefined ? {} : { education: data.education.map(fix) }),
  };
}

/**
 * Walk every fact-bearing item's `source_unit_ids` and return
 * the first id that doesn't match a loaded Unit. Returns null
 * if every emission cross-validates.
 *
 * Iterates the same shape as the validator's orchestrator
 * (#109): summary + bullets + skills + (education ?? []).
 */
function findFabricatedId(
  data: ResumeGenerationResponseV2,
  validUnitIds: ReadonlySet<string>,
): string | null {
  const allItems = [
    data.summary,
    ...data.bullets,
    ...data.skills,
    ...(data.education ?? []),
  ];
  for (const item of allItems) {
    for (const id of item.source_unit_ids) {
      if (!validUnitIds.has(id)) return id;
    }
  }
  return null;
}

/**
 * Server-stamp UUIDs onto every fact-bearing item. The LLM
 * doesn't emit ids (the schema rejects them); the pipeline
 * mints them after schema + cross-validation pass so the
 * downstream validator's content_snapshot mechanism (#109)
 * has stable ids to key flag records on.
 */
function stampIds(
  data: ResumeGenerationResponseV2,
  generateId: () => string,
): GeneratedAssetContent {
  const stampItem = (
    item: ResumeGenerationResponseV2["summary"],
  ): GeneratedItem => ({
    id: generateId(),
    text: item.text,
    source_unit_ids: [...item.source_unit_ids],
  });
  return {
    summary: stampItem(data.summary),
    bullets: data.bullets.map(stampItem),
    skills: data.skills.map(stampItem),
    ...(data.education !== undefined && {
      education: data.education.map(stampItem),
    }),
  };
}

// -- Default Firestore loader -----------------------------------------------

const APPLICATIONS_COLLECTION = "applications";
const ROLES_COLLECTION = "roles";
const UNITS_COLLECTION = "experienceUnits";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const MATCHES_COLLECTION = "unitMatches";

/** Firestore's cap on the values of one `in` filter. */
export const FIRESTORE_IN_LIMIT = 30;

/**
 * The approved-Units query, for one chunk of at most
 * `FIRESTORE_IN_LIMIT` ids: the owner's Units, approved, among `ids`.
 * Shared by the loader and the persist re-check (#485) so the two
 * cannot read the evidence differently.
 */
export function approvedUnitsQuery(
  db: FirebaseFirestore.Firestore,
  ownerUid: string,
  ids: readonly string[],
) {
  return db
    .collection(UNITS_COLLECTION)
    .where("owner_uid", "==", ownerUid)
    .where("user_approved", "==", true)
    .where("id", "in", [...ids]);
}

interface ApplicationDoc {
  readonly id: string;
  readonly owner_uid: string;
  readonly role_id: string;
  readonly approved_unit_ids?: readonly string[];
}

async function defaultLoadInputs(
  ctx: RunGenerationContext,
): Promise<GenerationInputs> {
  const db = getAdminDb();
  const appSnap = await db
    .collection(APPLICATIONS_COLLECTION)
    .doc(ctx.applicationId)
    .get();
  if (!appSnap.exists) {
    throw new GenerationApplicationNotFound(
      `Application ${ctx.applicationId} not found.`,
    );
  }
  const app = appSnap.data() as ApplicationDoc;
  if (app.owner_uid !== ctx.ownerUid) {
    // Anti-enumeration: same shape as #109's not-found-or-not-yours.
    throw new GenerationApplicationNotFound(
      `Application ${ctx.applicationId} not found.`,
    );
  }

  // Approved Units: filter to the application's
  // `approved_unit_ids` AND `user_approved == true` (defense
  // in depth — #82's invariant). Chunk on Firestore's 30-id
  // `in` cap.
  const approvedIds = app.approved_unit_ids ?? [];
  const units: ExperienceUnit[] = [];
  if (approvedIds.length > 0) {
    for (let i = 0; i < approvedIds.length; i += FIRESTORE_IN_LIMIT) {
      const chunk = approvedIds.slice(i, i + FIRESTORE_IN_LIMIT);
      const snap = await approvedUnitsQuery(db, ctx.ownerUid, chunk).get();
      units.push(...(snap.docs.map((d) => d.data()) as ExperienceUnit[]));
    }
  }

  const [roleSnap, reqsSnap, matchesSnap] = await Promise.all([
    db.collection(ROLES_COLLECTION).doc(app.role_id).get(),
    db
      .collection(REQUIREMENTS_COLLECTION)
      .where("owner_uid", "==", ctx.ownerUid)
      .where("role_id", "==", app.role_id)
      .get(),
    db
      .collection(MATCHES_COLLECTION)
      .where("owner_uid", "==", ctx.ownerUid)
      .where("role_id", "==", app.role_id)
      .where("approved_for_use", "==", true)
      .get(),
  ]);

  if (!roleSnap.exists) {
    throw new GenerationApplicationNotFound(
      `Role ${app.role_id} not found for application ${ctx.applicationId}.`,
    );
  }
  const role = roleSnap.data() as Role;
  if (role.owner_uid !== ctx.ownerUid) {
    throw new GenerationApplicationNotFound(
      `Role ${app.role_id} not found for application ${ctx.applicationId}.`,
    );
  }

  // `id` from the document id, not from the stored fields.
  //
  // The admin SDK uses no converter, while `services/firestore.ts`
  // strips `id` on every client-side write (the document id is
  // canonical). Requirements happen to be server-written today, so
  // their `id` is present — but the stranded-match gate above now
  // DEPENDS on these ids resolving, and if they were ever absent
  // the set would be `{undefined}` and every approved match would
  // read as stranded. That failure mode blocks all generation, so
  // the gate should not rest on a property of the current write
  // path. Same fix as `matching/evidence-read.ts` (#441); the
  // remaining admin readers are tracked in #447.
  return {
    units,
    role,
    requirements: reqsSnap.docs.map(
      (d) => ({ ...(d.data() as JobRequirementUnit), id: d.id }),
    ),
    approvedMatches: matchesSnap.docs.map(
      (d) => ({ ...(d.data() as UnitMatch), id: d.id }),
    ),
  };
}

// -- Errors (re-exported for consumers) -------------------------------------

export {
  GenerationError,
  GenerationNoApprovedUnitsError,
} from "./errors.js";

export class GenerationApplicationNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationApplicationNotFound";
  }
}
