/**
 * Resume generation pipeline (sub-issue #120 of #22). Step 5
 * of the core loop (extraction → JD parsing → matching →
 * validation → generation).
 *
 * Composes:
 *   { ownerUid, applicationId }
 *     → loadInputs        (approved Units + Role + Requirements + Matches)
 *     → empty-Units guard (throw if no Units; nothing to ground on)
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
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { getAdminDb } from "../firestore/admin.js";
import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import { transportBackoffMs } from "../llm/retry.js";
import { loadPromptText } from "../prompts/loader.js";
import {
  ResumeGenerationResponseV1Schema,
  type ResumeGenerationResponseV1,
} from "../prompts/generation/resume.v1.schema.js";
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
  readonly cost_usd: number;
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
const TOOL_NAME = "record_resume";

const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields. Every item MUST have non-empty `source_unit_ids[]` referencing a Unit ID from the input.",
  "\n\nYour previous two attempts failed. Be strict about the schema. Every emitted `source_unit_ids` value MUST exactly match a Unit ID from the input — do NOT invent ids. If a Requirement can't be grounded in any provided Unit, leave the bullet/skill/education entry out rather than fabricate.",
];

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
  const currentRequirementIds = new Set(inputs.requirements.map((r) => r.id));
  const liveApprovedMatches = inputs.approvedMatches.filter((m) =>
    currentRequirementIds.has(m.job_requirement_unit_id),
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
    if (liveApprovedMatches.length === 0 && strandedApprovedCount > 0) {
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

  const toolSchema = zodToToolSchema(ResumeGenerationResponseV1Schema);

  // The cross-validation Unit set is the ELIGIBLE Units only —
  // the same set the prompt sees. A fabricated id catches both
  // pure inventions AND attempts to ground on a Unit the user
  // approved but didn't connect to this Role via an approved
  // match. Same gate, two failure modes.
  const validUnitIds = new Set(eligibleUnits.map((u) => u.id));
  const eligibleInputs: GenerationInputs = { ...inputs, units: eligibleUnits };
  const failures: GenerationAttemptFailure[] = [];

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
  let cumulativeCostUsd = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Per-attempt timing for telemetry recordUsage — we want
    // each LLM call's latency reported separately to the cost
    // tracker for accurate provider-side benchmarking.
    const attemptStart = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = buildUserContent(prompt.userFewShot, eligibleInputs);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 4096,
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

    // Accumulate immediately on a successful LLM round-trip,
    // BEFORE any of the schema / fabricated-id / no-tool-use
    // continues below. Tokens are billed even when the response
    // fails our gates and we retry.
    cumulativeInputTokens += response.usage.input_tokens;
    cumulativeOutputTokens += response.usage.output_tokens;
    cumulativeCostUsd += estimateCostUsd(
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    // recordUsage is non-fatal — telemetry outages shouldn't
    // block generation. Mirror of #118's pattern.
    try {
      await record({
        stage: "generation",
        provider: "anthropic",
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: attemptLatencyMs,
        ownerUid: ctx.ownerUid,
      });
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

    const parsed = ResumeGenerationResponseV1Schema.safeParse(toolUse.input);
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
    const fabricatedId = findFabricatedId(parsed.data, validUnitIds);
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
      content: stampIds(parsed.data, generateId),
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
 * Walk every fact-bearing item's `source_unit_ids` and return
 * the first id that doesn't match a loaded Unit. Returns null
 * if every emission cross-validates.
 *
 * Iterates the same shape as the validator's orchestrator
 * (#109): summary + bullets + skills + (education ?? []).
 */
function findFabricatedId(
  data: ResumeGenerationResponseV1,
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
  data: ResumeGenerationResponseV1,
  generateId: () => string,
): GeneratedAssetContent {
  const stampItem = (
    item: ResumeGenerationResponseV1["summary"],
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

/**
 * Build the user-content block for the LLM call. Every field
 * is JSON-stringified to escape embedded quotes / backslashes,
 * mirroring the #107 / #108 pattern that addressed Codex's
 * quoted-input serializer regression.
 */
function buildUserContent(
  userFewShot: string,
  inputs: GenerationInputs,
): string {
  const unitsBlock = inputs.units.map(formatUnit).join("\n\n");
  const reqsBlock =
    inputs.requirements.length > 0
      ? inputs.requirements.map(formatRequirement).join("\n")
      : "(no parsed requirements)";
  return [
    userFewShot,
    "",
    "Approved Experience Units:",
    "",
    unitsBlock,
    "",
    // `Role.company_id` is a UUID, not a display name — the
    // human-readable Company name lives on the Company doc and
    // isn't loaded here in V1. Emit only the title; the LLM
    // grounds from Units (where employer info lives implicitly
    // in `raw_text`). CodeRabbit caught this leak on PR #123
    // (advisory finding round 1). Phase 2 follow-up: load
    // Company doc + pass its `name` field.
    `Target Role: ${quote(inputs.role.title)}`,
    "Role Requirements:",
    reqsBlock,
  ].join("\n");
}

function formatUnit(unit: ExperienceUnit): string {
  const lines: string[] = [
    `[Unit ${unit.id}]`,
    `raw_text: ${quote(unit.raw_text)}`,
    `normalized_summary: ${quote(unit.normalized_summary)}`,
  ];
  if (unit.skills.length > 0) {
    lines.push(`skills: [${unit.skills.map(quote).join(", ")}]`);
  }
  if (unit.tools.length > 0) {
    lines.push(`tools: [${unit.tools.map(quote).join(", ")}]`);
  }
  if (unit.domains.length > 0) {
    lines.push(`domains: [${unit.domains.map(quote).join(", ")}]`);
  }
  if (unit.date_range !== undefined) {
    const dr = unit.date_range;
    lines.push(
      `date_range: { start: ${quote(dr.start)}${dr.end !== undefined ? `, end: ${quote(dr.end)}` : ""} }`,
    );
  }
  return lines.join("\n");
}

function formatRequirement(req: JobRequirementUnit): string {
  const tag = req.must_have ? "MUST-HAVE" : "nice-to-have";
  return `- [${tag}] ${quote(req.normalized_requirement)}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Approximate per-call cost in USD for budget telemetry.
 * Rough Anthropic Haiku pricing: $0.25/MTok input, $1.25/MTok
 * output (subject to vendor changes; not load-bearing for
 * correctness — the cost tracker logs the real $ figure when
 * the modelConfig points at the real provider).
 */
function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
}

// -- Default Firestore loader -----------------------------------------------

const APPLICATIONS_COLLECTION = "applications";
const ROLES_COLLECTION = "roles";
const UNITS_COLLECTION = "experienceUnits";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const MATCHES_COLLECTION = "unitMatches";

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
    const FIRESTORE_IN_LIMIT = 30;
    for (let i = 0; i < approvedIds.length; i += FIRESTORE_IN_LIMIT) {
      const chunk = approvedIds.slice(i, i + FIRESTORE_IN_LIMIT);
      const snap = await db
        .collection(UNITS_COLLECTION)
        .where("owner_uid", "==", ctx.ownerUid)
        .where("user_approved", "==", true)
        .where("id", "in", chunk)
        .get();
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
