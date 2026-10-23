---
spec_id: matchline
name: Matchline V1
status: draft
tested: false
reason: Whole-product spec; behavior is covered by per-surface unit, DOM and integration tests rather than one spec-level suite.
derived_from: ../../docs/projects/matchline/prds/matchline.md
---

# Matchline V1

Feature: A single-user career operating system that converts a user's
work history into structured evidence, matches that evidence against
specific job requirements, and generates tailored applications grounded
only in user-approved evidence.

The authoritative PRD lives in the `docs` sibling repo at
`~/GitHub/docs/projects/matchline/prds/matchline.md` (read-only mirror:
`docs/projects/matchline/prds/matchline.md`). This spec is the
repo-local derivation. On conflict, the PRD wins; file a plan entry to
reconcile.

This spec tracks PRD v0.3 (2026-10-22). Descriptive statements
reflect shipped behavior unless marked **Target** (approved, not built
or not yet met) or **Deferred** (out of this release by decision), as
the PRD defines them. Acceptance criteria and execution targets are
requirements; where shipped behavior does not meet one yet, it is
marked **Target** with the measured result. Target
requirements are summarized here only where they constrain shipped
code; the PRD's "Target interface" and "Core requirements and
enhancements" sections are the full list.

## Non-goals

- Not an ATS keyword stuffer.
- Not a generative writer — no claim ships that the user hasn't confirmed.
- Not a job board, mass-apply tool, coaching product, or team product.
  Two exceptions are **Target**: a scheduled scan of employer boards
  the user names, and interview preparation and debriefs. The scan
  never scrapes aggregators, and an aggregator-only result stays an
  unverified lead until the employer's posting confirms it.
- Not a replacement for networks. The Network Layer is V2+.
- Not a native mobile app. V1 is a responsive web app; phone layouts
  for agreed workflows are **Target**.

## Core loop

```
Career → Experience Units → Matching → Application
```

The loop has four steps. Each must satisfy its own acceptance criteria;
the loop as a whole must satisfy the end-to-end criteria below.

**Target:** the PRD's revised loop, `Evidence → Role → Fit brief →
Package → Process`, contains these four steps and extends them through
the interview process.

### Step 1 — Career into Experience Units

Acceptance criteria:

- The user can import their career by pasting resume text.
  **Deferred** (PRD decision 3): LinkedIn profile HTML (#28), long-form
  career context (#29), and artifact upload (#87). The `artifact`
  `source_type` and the `artifact://` `source_ref` format (#592) are a
  data-model change only, with no upload, storage, or parsing behind
  them.
- Extraction produces structured Experience Units conforming to the
  `ExperienceUnit` schema in `## Data model`.
- Extraction generates embeddings for every Unit's `normalized_summary`
  using `text-embedding-3-small` and stores them on the Unit document.
- Every extracted Unit carries a `confidence_score` in `[0, 1]`, a
  `source_type`, and a `source_ref` pointing back to the input that
  produced it.
- The Unit Review screen is the non-skippable landing surface
  post-extraction. No Unit enters the matching pipeline until
  `user_approved == true`.
- Onboarding succeeds when the user has ≥ 20 approved Experience
  Units after the first session.

### Step 2 — Job into Requirement Units

Acceptance criteria:

- The user can paste a JD as plain text into a Role, either when
  creating it or later for a Role saved with only a title (#431).
- Parsing produces `JobRequirementUnit` records conforming to the schema
  in `## Data model`, including `priority`, `must_have`, `category`, and
  `extracted_from`.
- Parsing generates embeddings for every Requirement's
  `normalized_requirement`, cached per Role.
- Every parsed Requirement is editable inline from the Role Detail →
  Requirements tab.

### Step 3 — Match Units to Requirements

Acceptance criteria:

- For every `(ExperienceUnit, JobRequirementUnit)` pair in a Role, the
  matching engine computes a `UnitMatch` with the scores defined in
  `## Matching engine`.
- `final_score` is multiplied by the Experience Unit's
  `confidence_score`; a low-confidence Unit can never produce a
  high-confidence match.
- The Role Detail → Matches tab surfaces ranked matches with scores,
  rationales, and a specific `surface_evidence` string — **except where
  the stored explanation cannot be trusted.** A match written before the
  rationale was restricted to axes the engine actually evaluated may
  describe a comparison that never happened, so its rationale and
  `surface_evidence` are withheld and the card says so. The score, the
  ranking, and the approve/reject actions are unaffected; only the
  explanation is suppressed.

  Withholding is deliberate and follows from the neutral-fallback rule
  below: an explanation that may describe an unevaluated axis is a
  claim the data does not support, and no explanation is better than a
  false one. The card offers no remedy, because the only rematch path
  available today is destructive.
- Requirements with no qualifying match appear in an explicit **Gaps**
  view, not hidden.
- No match is auto-approved. Generation uses only matches with
  `approved_for_use == true`.

### Step 4 — Generate an application

Acceptance criteria:

- Generation produces a resume grounded only in approved Experience
  Units and their approved matches. **Target:** cover letters (#30) and
  the other package artifacts (application answers, referral note,
  outreach), under the same grounding and validation. `AssetRef.kind`
  already reserves `cover_letter` and `outreach`; no writer produces
  them yet.
- The validation layer (see `## Validation layer`) attaches a
  claim-to-Unit map and flags any claim that does not trace to an
  approved Unit. It runs on edit or on an explicit re-run, after the
  draft is shown; running it before the draft is shown is **Target**.
- The Application Editor blocks export while any validation flag is
  unresolved.
- A passing validation result covers the evidence as the validator read it. Export is also blocked while any Unit the output cites is missing, no longer approved, or has changed since that read (the asset records each cited Unit's version as `validated_unit_versions`).
- **Target:** export to PDF, DOCX, and plain text (#33), from the
  Package. Today the Export control enforces the gate above, but its
  action is a stub.

### End-to-end acceptance

- **Full flow (Target, not met).** From a populated Capability Graph,
  a user can paste a JD and produce a validated, exportable resume in
  under 20 seconds at p95. Measured: 236 s at p95 (#177), and export is
  not built (#33).
- **Cost (Target).** Per-application LLM spend (parse + match +
  generate + validate) is under $1 at p95; target $0.75. Per-call cost
  is attributed by task since #483; no per-application p95 has been
  reported against this target yet.
- **Zero fabrication.** Every claim in every exported or sent output
  traces to an approved Experience Unit. This is an invariant, not a
  metric. Today it is enforced at the export gate, which requires a
  passing, server-attested validation; export itself is not built yet
  (#33). A freshly generated draft is shown before validation runs
  (see Validation layer), so it can carry an untraced claim until the
  user validates it. **Target:** validation completes before generated
  output is first shown.

## Data model

CRM objects and Capability Graph objects are defined in the PRD § Data
model. For each object, the repo ships TypeScript types in
`src/types/` that must match the JSON shape below. Foreign keys use
UUIDs; all timestamps are ISO 8601 strings in Firestore documents.

### CRM objects

- `Person { id, name, role, company_id, relationship_type, last_contacted_at?, notes? }`
- `Company { id, name, industry?, size?, priority, url?, notes? }`
- `Role { id, company_id, title, jd_raw, jd_url?, location?, remote_policy?, comp_range?, discovered_at }`
  - **Target** (PRD decision 7): `origin: "manual" | "scan"` and `source_url?`. A scan-created Role exists only for a result verified on the employer's posting, which becomes its `jd_url`. New Role stamps a placeholder `company_id` because there is no Company UI yet; adding Company and Source fields to the form, and persisting them, is Target work.
  - `jd_raw` may be the empty string. A Role can be saved with only a title, as a lead whose JD arrives later (#431). Parsing, matching and generation stay gated on the JD: an empty `jd_raw` yields no Requirements, matching does not run without Requirements, and generation needs approved matches.
- `Application { id, role_id, stage, applied_at?, last_activity_at, generated_assets[], approved_unit_ids[] }`
  - `stage` is one of seven values: `saved`, `drafting`, `applied`, `interviewing`, `offer`, `rejected`, `withdrawn`. These stay for this release (PRD decision 1); finer process steps belong to the dossier, not to `stage`.
  - An Application is created when the user generates a resume for a Role, in `drafting`. A Role with no Application does not appear on the Pipeline.
- `Interaction { id, person_id, application_id?, type, direction, summary, occurred_at }`
  - Companies, People and Interactions have service-layer readers and writers but no entry UI; the Pipeline reads People and Interactions only to show a key contact.
- `Task { id, application_id, title, due_at?, completed, created_at }` (#34): a follow-up reminder on an Application. Completing one also stamps the Application's `last_activity_at`. V1 sends nothing; tasks are reminders the human acts on.

### Capability Graph

- `ExperienceUnit { id, source_type, source_ref, raw_text, normalized_summary, unit_type, skills[], tools[], domains[], seniority_signals[], scope_signals[], business_outcomes[], metrics[], evidence_type, confidence_score, user_approved, date_range?, created_at, updated_at }`
- `Metric { claim, value?, unit?, direction?, confidence }`
- `JobRequirementUnit { id, role_id, raw_text, normalized_requirement, category, keywords[], tools[], domains[], seniority_level?, priority, must_have, extracted_from }`
- `UnitMatch { id, experience_unit_id, job_requirement_unit_id, semantic_score, rule_score, final_score, components?, structural_evidence?, component_applicability?, rationale, surface_evidence, approved_for_use, user_rejected, created_at }`
  - `components`, `structural_evidence` and `component_applicability`
    are **optional**: records written before those fields existed carry
    none of them, and the coverage gate depends on being able to
    recognize such a record. A rerun of matching populates all three.
    A record missing `structural_evidence` is resolved on read by the
    derivation below, and falls back to its pre-existing coverage
    behaviour when no verdict is available — never to a stricter
    reading, so neither deploying the gate nor a failed derivation can
    make an already-matched Role sprout gaps.
  - `schema_version` declares what a reader may conclude from the
    record. Version 1 means `components` and `component_applicability`
    are present and the `rationale` was generated under the axis-gated
    rule, so it may be presented to the user as a claim. **Provenance
    must be read from this field, never inferred from another field's
    presence** — an inference that happens to hold because two things
    shipped together is a coincidence, not a contract, and cannot fail
    loudly when it stops holding. Records written before the field
    existed but carrying `component_applicability` are also
    trustworthy; that bridge is explicit and ends once every Role has
    been re-matched.
  - `component_applicability` records, per axis, whether the engine
    actually evaluated it for this pair. A `false` axis means the
    corresponding value in `components` is a no-constraint neutral, and
    **no consumer may present it as a measurement** — the breakdown
    renders it as unavailable rather than as a score. When the field is
    absent, readers must assume nothing was measured: pre-existing
    records store the same neutrals without marking them.
- `UnitCluster { id, application_id, label, experience_unit_ids[], narrative_purpose, generated_text? }`

### Dossier objects (Target)

The PRD's § Dossier objects sketches `CanonicalResume`, `ResumeLine`,
`TailoredResume`, `ClaimRule`, `FitBrief`, `InterviewRound`,
`Correspondence` and `ScanResult`. None is persisted. Invariants the
build must keep:

- A `TailoredResume` pins `canonical_version`. An unsent view changes
  only through an explicit Rebase; Keep leaves it pinned. Staleness
  against the current canonical is a visible, non-blocking warning
  (PRD decision 2).
- A sent package is immutable. Rebase does not apply to it, and a
  correction to it is logged as a linked record rather than an edit.
- A `ClaimRule` violation blocks export, as an untraceable claim does.
- A `ScanResult` records its discovery source apart from the
  employer's posting. One not verified on the employer's board cannot
  become a Role or count as a verified opportunity (PRD decision 6).
- Next actions are the shipped `Task`; there is no separate
  `NextAction` object.

The fit-brief generator (`functions/src/generation/fitBrief.ts`, #581)
emits the `FitBrief` fields, citing verbatim evidence quotes rather
than line ids. It is eval-only: no callable, route, or persisted
document uses it.

### Invariants

- `ExperienceUnit.user_approved == true` is required for the Unit to
  enter any match or generation pipeline.
- `UnitMatch.approved_for_use == true` is required for the match to
  contribute to generation, and is **not sufficient**: the match's
  `job_requirement_unit_id` must still resolve to a Requirement the
  Role currently has. A JD re-parse replaces the Requirement set under
  new ids, so an approved match can outlive the requirement it
  answered; grounding a generated claim on one would assert relevance
  to something the job description no longer asks for. Such matches are
  refused at generation rather than deleted — the approval is the
  user's decision to keep, and a rematch may well reinstate the pair.
  The check is applied again inside the persist transaction, because
  the inputs are read minutes before the artifact is written and a
  re-parse can land in between; a generation whose grounding stops
  holding mid-flight is discarded rather than saved.
- `Application.approved_unit_ids` is a snapshot of the Units used to
  generate a specific artifact. Changing a Unit later must not mutate
  a historical Application's grounding set.
- Experience Units are permanent across applications; UnitMatches are
  per-application and regenerated.

## Matching engine

```
final_score = confidence_score × (
  0.30 × semantic_similarity +
  0.20 × skill_overlap       +
  0.15 × domain_overlap      +
  0.10 × tool_overlap        +
  0.10 × seniority_alignment +
  0.10 × scope_alignment     +
  0.05 × recency
)
```

Acceptance criteria:

- Each component is normalized to `[0, 1]` before weighting.
- Seniority alignment is a penalty function, not a similarity score:
  a one-level gap scores 0.5, and a gap of more than one level drives
  the score to zero.
- Scope alignment scores 1.0 for a Requirement whose category is not
  `scope`. For a scope Requirement it is the Jaccard overlap between
  the Unit's `scope_signals` and the Requirement's `keywords`, with the
  directional empty-set rule below. **Target:** a scope-level penalty
  function like seniority's, which needs a scope ladder.
- Recency is exponential decay on the Unit's end date, floored so
  ancient-but-relevant experience still contributes.
- Skill, tool, and domain overlaps use Jaccard similarity on canonical
  vocabularies normalized at extraction time. The empty-set case is
  **directional**: when the Requirement side carries nothing the
  canonical vocabulary recognizes, the axis places no evaluable
  constraint and scores a neutral `0.5`; when the Requirement side is
  populated and the Unit's is empty, the axis scores `0.0`. An
  unrecognized Requirement must not be scored as a candidate
  deficiency — that inversion made an out-of-domain Role unmatchable
  in principle (#430).
- Every neutral fallback in the scoring layer is a **statement of
  ignorance, not a measurement**, and no consumer may read it as
  evidence. This covers the Jaccard neutral above, the `1.0` that
  seniority and scope alignment return when the Requirement doesn't
  constrain them, the `0.5` seniority alignment returns when a Unit's
  signals are all unmapped by the ladder, and the `0.5` recency
  returns when a Unit carries no usable date.
- The rule is about MEANING, not about values. Seniority alignment
  also returns a hard `0` when a Unit has no seniority signals at
  all, and that IS a measurement — "no evidence of meeting the bar" —
  so it must be presented as one. Only the signals-present-but-
  unmapped case is ignorance. A consumer that keys off the number
  rather than the reason will get this backwards.
- `UnitMatch.structural_evidence` records, per (Unit, Requirement)
  pair, whether the Unit scored above zero on at least one axis the
  Requirement actually constrains. It is a property of the pair, not
  of the Requirement: a Requirement naming one recognized term must
  not mark every Unit as evidenced. Seniority counts only when the
  Unit carries a ladder-mapped signal, since the mapped and unmapped
  cases produce an identical `0.5`.
- A must-have Requirement is **covered** only by a non-rejected match
  that both clears the score threshold and carries
  `structural_evidence`. Semantic similarity alone cannot establish
  coverage: embedding proximity with no shared skill, tool, domain,
  seniority or scope vocabulary is what produces
  plausible-but-unfounded generated claims downstream. Such matches
  still rank and still render — see the non-goals below — they simply
  cannot silently satisfy a hard requirement.
- Structural evidence for a record that lacks it is **derived on
  read**, never backfilled by a write. The derivation recomputes the
  five structural axes from the ID-linked Unit and Requirement, which
  is possible because none of those axes reads an embedding, and
  applies the same predicate the matcher applies at write time.
  Persisted ids, `approved_for_use` and `user_rejected` are untouched
  by it; an explicit rematch remains the only path that changes what
  is stored.
- The derivation has **three outcomes, not two**. Beyond evidenced and
  unevidenced, a pair the matching pipeline would currently decline to
  produce is **unverifiable** — a missing Unit or Requirement, a Unit
  that is unapproved or awaiting re-embedding, either side lacking a
  usable embedding, or two embeddings of incompatible dimensions. The test is whether a rematch would yield the
  pair, not whether the structural axes can be computed: they can be
  in every one of those cases, and answering anyway would outlive the
  match the answer describes. A Requirement carrying only an unverifiable match
  is reported distinctly from one carrying no match at all: they call
  for different actions, and collapsing them either invents a gap the
  user cannot act on or hides one they need to see.
- Stored `structural_evidence` is **authoritative over any derived
  verdict**. A derivation is a snapshot; the document is live, and a
  snapshot that folded a value in at build time does not track it
  afterwards.
- A match whose Requirement no longer exists is reported at the Role
  level rather than attributed to a surviving Requirement, and is
  determined structurally — from whether the id is in the current
  Requirement set — not from a derived verdict, so it holds for matches
  of every vintage and needs no round trip. The
  stranding is a consequence of the Requirement set being replaced
  wholesale, so tying it to whichever Requirement remains would assert
  a relationship that does not exist.
- A derivation that cannot run degrades to the permissive reading and
  says so, and the affirmative "every must-have is covered" statement
  is withheld entirely until the check has actually run. Silence would let "every must-have has a qualifying match"
  stand on a check that never happened.
- Matching is nearly-free after embeddings exist; no per-match LLM call
  is required. Rationale strings may be LLM-generated but must be
  cached per `UnitMatch`.

Non-goals:

- Does not auto-approve matches.
- Does not hide low-quality matches; they appear in the Gaps view.
- Does not pretend to certainty; every score surfaces its reasoning.

### Persisting a run, and runs that stop part-way

A run replaces the Role's whole match set. When the writes and orphan deletes fit one commit (`MATCH_WRITES_PER_COMMIT`), the replacement is a single transaction, so a failed run leaves the previous set intact. Above that size it is committed in chunks, and a run that stops between chunks leaves some pairs rescored and the rest from an earlier run. The user must be told when that happens, because the Matches tab otherwise presents a mixed set as one run's result (#504).

Each (owner, Role) has one run marker in `matchingRuns`, written only by the matching pipeline and readable by its owner. Its contract (`functions/src/matching/runMarker.ts`) is:

- `run_id` names the run that may commit. Each run claims a fresh one before reading its inputs (last writer wins), and every commit re-checks it, so the run whose claim landed last is the one that may commit. That is the most recently invoked run unless two invocations race to claim. A superseded run stops writing and reports that it did not complete.
- `state` is `running`, `complete` or `failed`. A run that throws tries to mark itself `failed` if it is still the current run; this is best effort, and if that write fails the marker stays `running`. A run that is killed (a crash or the callable's timeout) cannot mark anything and also stays `running`. Either way the deadline below eventually reads it as dead.
- `partial` means the persisted set may mix runs. Every chunked commit sets it in the same transaction as its writes. Each new claim carries it forward until a run completes, so a later run that fails before writing cannot hide an earlier run's mixed set. Only the commit that completes a run clears it.
- A Role is **incomplete** when `partial` is set and no run is plausibly still finishing: `state` is `failed`, or `state` is `running` and more than the `runMatching` callable's timeout plus a clock-skew margin has passed since `started_at`, or `state` is `running` and `started_at` is absent or unparseable (nothing proves the run alive). A marker with no `state` (written before this contract) reads as complete.

While a Role is incomplete and no run is in progress in the tab, the Matches tab shows a status notice next to **Re-run matching**. The notice is advisory: if the marker cannot be read, the tab shows no notice and keeps working.

## Validation layer

Validation runs these steps:

1. Parse the output into discrete claims.
2. For each claim, verify it maps to an approved Experience Unit.
3. Flag generic non-specific language that cannot be tied to any Unit.
4. Surface flagged issues as inline annotations in the Application
   Editor. The editor blocks export while any flag is unresolved.

The validation layer is a hard constraint on export: nothing exports
without a passing, server-attested traceability pass. Generation saves
the asset with `validation_status: "pending"` and the Application
Editor opens it at once, so the user sees an unvalidated draft;
validation runs when the user edits it or chooses "Re-run
validation." **Target:** validation completes before generated output
is first shown.

**Target:**

- A claim-rule check runs every generated artifact against the user's
  claim rules. A violation blocks export.
- A tailored resume's staleness against the canonical is reported
  beside the validation results and never blocks export. Traceability
  and claim-rule failures always block.

The verdict is attested by the server, not by the asset. The asset's `validation_status` and `validation_flags` sit in a client-writable list (edits mark it `stale`, undo restores an earlier value), so they are display state only. Each validation run also writes an attestation to `applications/{id}/validations`, readable by the owner and writable only by `validateAsset`, keyed by the asset and a fingerprint of the content it validated (`functions/src/validation/attestation.ts`, #502). The fingerprint ignores object key order and item order within a section, because neither can change a verdict: flags are keyed by item id, and reordering keeps `passed` without re-validating. Export is enabled only when the attestation for the asset's current content says `passed` and every Unit that content cites is still at the version the attestation recorded. Any other edit moves the content to a fingerprint with no attestation, which reads as unvalidated; undoing back to validated content finds that content's attestation again.

## AI pipeline

Async (cached):

1. Experience Unit extraction (per career input)
2. Job Requirement parsing (per Role)
3. Embedding generation (per Unit and per Requirement)

Real-time:

4. Matching (vector + rules, minimal LLM)
5. Generation (controlled-generation prompt using approved Units as
   ground truth)
6. Validation (LLM claim-to-Unit check, or deterministic where possible)

Model strategy:

- Production defaults (`functions/src/llm/config.ts`): Claude Sonnet 4.6
  for extraction and validation; Claude Haiku 4.5 for requirement
  parsing and generation. Embeddings use OpenAI
  `text-embedding-3-small`. Match rationales make no LLM call: they
  come from a deterministic template (`generateRationale()` in
  `functions/src/matching/rationale.ts`, #100). The config's
  `rationale` entry (Sonnet 4.6) is set but unused.
- The Claude 5.5 models are wired for evaluation runs only (#579). A
  production default changes only through its own approved change,
  informed by #495.
- Per-stage model choice is tunable via configuration; no model
  identifier is hardcoded in application logic.

## Streaming progress

Extraction and JD parsing run long enough that silence reads as failure — extraction was measured at 108.6s against the p95 target below. Both callables therefore stream progress to the client while they work, and the contract is specified here because the event vocabulary is necessarily declared twice (once in `functions/src/llm/progress.ts`, once in `src/services/progress.ts`) and neither copy should become the source of truth by default.

### Event schema

A chunk is `{ stage, attempt?, maxAttempts? }`. Stages are a closed set:

| Stage | Meaning |
|---|---|
| `analyzing` | the LLM call is running; `attempt` is 1-based |
| `retrying` | an attempt failed and the backoff is being waited out |
| `embedding` | batch embeddings over the returned units |
| `saving` | the atomic Firestore write |

`attempt` and `maxAttempts` accompany `analyzing` and `retrying` only, and are positive integers with `maxAttempts >= attempt`. A chunk failing any of these rules is discarded rather than rendered: the deployed function is not necessarily the version the client was built against.

`retrying` is a distinct stage rather than a variant of `analyzing` because the two are different states — one is working, the other waiting — and a wait can be long when a 429 carries `retry-after`. Reporting a wait as work is the apparent-hang this feature exists to remove.

### Guarantees

- **Progress never affects the outcome.** Emission is best-effort: `sendChunk` resolves `false` for a non-streaming request rather than throwing, and `safeProgress` absorbs both a synchronous throw and a rejected promise from an async reporter. A broken sink cannot fail a call that would otherwise succeed, the same invariant cost telemetry holds.
- **The UI degrades honestly.** With no events — an older deployed function, a dropped stream, a non-streaming caller — the surface shows elapsed time and a duration expectation, never an invented stage.
- **Backwards compatible.** A client that passes no progress callback takes the non-streaming path unchanged.

### Timeout semantics

`HttpsCallableStreamOptions` carries no `timeout`, and the SDK's streaming path races nothing, so the client budget is re-supplied as an `AbortSignal` driven by the same table as the non-streaming path (`src/services/callable-timeouts.ts`). The SDK maps any abort to `cancelled`, so a deadline we imposed is relabelled `deadline-exceeded` before it reaches the UI — otherwise a timeout would read to the user as though they had cancelled something.

### Cancellation

`response.signal` bounds *new* spend only. Both retry loops check it before every attempt and the backoff wait is abort-aware, so a disconnect stops work that has not started. It is never used to discard work already done: by the time the pipeline reaches embedding or persistence the model output is complete and already billed, and the resulting Units are what the user returns to. Aborting there would maximise waste rather than bound it.

## Update prompt

The app is a single-page bundle with no service worker, so a browser tab keeps running whatever build it loaded until something reloads it. A tab left open across a deploy therefore issues calls from stale client code against a moved contract, and the user has no way to know. The prompt exists to make that observable and to let the user act on it at a moment of their choosing rather than mid-operation.

### Build stamp and detection

Each build stamps an id (`__BUILD_ID__`) into the bundle and emits the same value to `dist/version.json`. The running tab polls that file and compares. Two hosting rules make the comparison meaningful: `version.json` is served `no-cache` so a deploy is observable, and `/assets/**` is `immutable` because those filenames are content-hashed.

`version.json` is a deployment contract, not merely a convenience. `firebase.json` rewrites `**` to `/index.html`, so a build that stops emitting the file returns the SPA's HTML with a 200 rather than a 404. A client that simply tries to parse that body and swallows the failure would disable update detection permanently and indistinguishably from "no update available". The client therefore checks the payload *shape* and treats anything that is not a version document as "no reading" — never as "no update" — and says so once in the console. A response body must be read and parsed explicitly for this to hold: `Response.json()` rejects on an HTML body before any shape check can run.

### When the prompt may appear

The prompt is display-only and never reloads on its own; a reload happens only when the user asks for one.

| Condition | Behavior |
|---|---|
| Current or latest build id unknown | No prompt — guessing produces a banner that cannot be dismissed |
| Latest equals current | No prompt |
| A long-running operation is in flight | Suppressed until it settles |
| The user declined this exact build | Suppressed for that build only |

**Suppression during work is a cost rule, not a politeness rule.** Extraction runs ~108s and resume generation carries a 330s budget, both billed per call. Offering a reload mid-flight invites the user to destroy a call that is about to succeed and pay for it twice; where the operation also writes, a reload can discard a write before it is acknowledged. Any code path that awaits a callable or a Firestore write must therefore hold a busy lease for the *whole* operation — including the write that precedes a callable, not just the callable itself.

Leases are per invocation rather than per named operation: a fixed key lets one completing call clear the entry still owed to a second, concurrent one, re-exposing the prompt while work continues. Suppression is display-only, so a newer build observed during work is still recorded and the prompt appears the moment the last lease releases.

**Dismissal is keyed to the build id.** An in-memory decline re-prompts on every later poll for the same build; a persisted session flag hides genuinely newer builds forever. Keying to the build gives both — that build stays quiet, the next one asks again.

Guarding *unsaved editor content* is a related but separate contract, tracked in #456: a busy lease suppresses the prompt outright, whereas unsaved work gates the reload behind a confirmation the user can override.

## Execution targets

These are **Target** values. Measured today: resume extraction about
108 s, and the full flow 236 s at p95 (#177).

Latency (p50 / p95):

| Step | p50 | p95 |
|------|-----|-----|
| Experience Unit extraction (per resume) | 8s | 20s |
| Job Requirement parsing | 1s | 4s |
| Matching (across existing embeddings) | <500ms | 2s |
| Resume generation | 3s | 8s |
| Cover letter generation | 4s | 10s |
| Validation | 1s | 3s |
| Full flow (paste JD → validated resume) | 6s | 18s |

Cost:

| Operation | Target |
|-----------|--------|
| Career extraction (one-time) | $2–$5 |
| Per new role (parse + match + generate + validate) | $0.50–$1.00 |
| Re-generation of existing application | $0.20–$0.50 |

Reliability:

- Structured-output failures retry with stricter prompts up to twice,
  then surface to the user as "needs manual review."
- Validation failures never auto-regenerate. They always surface for
  explicit user approval.
- No silent fallbacks. If the system cannot produce a confident result,
  it says so.

## V1 surfaces

The shipped product has six screens behind sign-in. Nothing ships
that isn't directly serving matching or generation.

1. **Onboarding** — one-time; paste resume text, with streamed
   progress; lands in Unit Review. The four-source import picker is
   **Deferred**.
2. **Unit Review** — list of Experience Units, filterable by skill, tool, domain, date range, and approval status (approved, pending, flagged); inline editing that marks the Unit `reembed_pending`, which keeps it out of matching until it is re-embedded; approve / reject / flag; "Add Unit manually" action. Rejected Units drop out of the list. **Target:** a source-type filter; a client call to `reembedExperienceUnit` after an edit, so the re-embed runs (today the callable has no client call site and no trigger); a separate view for reviewing and restoring rejected Units (`listRejectedExperienceUnits()` exists with no caller). **Deferred:** artifact upload.
3. **Role Detail** — header (title and Role id) + three tabs
   (Requirements, Matches, Applications); resume generation lives in
   the Applications tab. This is the current implementation,
   superseded in the target design by the five-tab dossier (Fit brief,
   Requirements & matches, Package, Process, Correspondence). The
   header details and persistent action bar described in PRD v0.1 were
   never built.
4. **Application Editor** — two-pane view (output ↔ approved Units),
   inline traceability annotations, validation flag badges, inline
   editing with undo, re-run validation, and blocked export until flags
   resolve. **Transitional** (PRD decision 5): the Package tab becomes
   the home for editing, validation, and export, and any expanded
   editor is another view of the same package.
5. **Pipeline** — kanban by application stage
   (Saved, Drafting, Applied, Interviewing, Offer, Rejected,
   Withdrawn), with drag-and-drop and arrow-key moves; cards show
   company, title, a day count labeled "days in stage" that measures
   days since `last_activity_at` (a completed task resets it; true
   time in stage, which needs a stage-entry timestamp, is **Target**),
   next action (the first open task),
   and key contact; a collapsible sidebar with Due today, Upcoming, and
   Follow-ups (Applied or Interviewing, quiet for more than 7 days, no
   open task).
6. **New Role** (`/roles/new`, the "+ New Role" nav entry) — a form
   with a required title and optional job description, JD URL,
   location, remote policy, and comp range; the draft persists across
   reloads until saved or cancelled. Saving creates the Role, even
   with only a title (#431), and opens its Role Detail. **Target**
   (PRD decision 7): Company and Source fields, persisted on the Role.

**Target:** the navigation, dossier, Evidence (canonical resume and
claim rules), Package, Process, Correspondence, and Scan surfaces in
the PRD's "Target interface," and responsive layouts down to phone
widths for the agreed workflows (PRD decision 8). Today the Pipeline
board and the Application Editor stack below 768 px, and New Role's
short fields drop from two columns to one below 640 px. The top
navigation and the other screens have no breakpoint-specific layout.

## Technical principles

- **Evidence over narrative.** The validation layer is a hard
  constraint.
- **User-approved, not AI-approved.** User approval is the only gate
  into generation.
- **Explainable by default.** Every score, match, and claim surfaces
  its reasoning.
- **Fail visibly.** No silent fallbacks; surface the gap instead.
- **One user at a time.** No sharing, collaboration, or team features.
- **Capability Graph is portable.** JSON export is a V1 feature
  (**Target**, #35).
- **Cost is a feature.** The per-application budget is a hard
  constraint, not a target.

## Access control

V1 is single-user, and that is an authorization rule, not only a product scope. Signing in to Firebase Auth is not enough; Firebase Auth admits any account that can sign in.

- **Owner allowlist, two layers.** Every callable rejects a caller whose uid is not in the `MATCHLINE_OWNER_UIDS` function param with `permission-denied`, before argument parsing and before any LLM or Firestore client is built. `firestore.rules` admits a client read or write only when the caller's uid is listed in the single fixed document `config/access` (`owner_uids`), which the deploy writes with a full overwrite from the same value. Each layer fails closed on its own: an empty param, or a missing or malformed `config/access`, admits nobody, including the owner. A per-uid document grants nothing, so nothing a client wrote before these rules can become access after them.
- **No self-service.** The sign-in surface offers no account creation, and no client can read or write `config/`.
- **Explicit collections.** The rules name every collection. A collection that is not named is denied to clients, and pipeline-only writes (`llm_calls`, plus creates and deletes of `jobRequirementUnits` and `unitMatches`) are closed to clients; the owner may edit only a parsed Requirement's content fields and a match's approve/reject decision. Server-owned fields (`experienceUnits.embedding`, Application grounding and asset creation) are not client-writable.
- **Bounded input.** Pasted resume and JD text is capped at 100 KB (UTF-8) per call.

Configuration and deploy order: `DEPLOYMENT.md` § Owner allowlist.

## Stack

V1:

- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Firebase Functions (Node)
- Database: Firestore
- Auth: Firebase Auth
- Hosting: Firebase Hosting + Firebase Functions
- LLMs: Anthropic + OpenAI; keys in Firebase secrets
- Embeddings: OpenAI `text-embedding-3-small`, stored on Firestore
  documents
- Firebase Storage is not configured. It is **Target** for export
  files (#521) and **Deferred** with artifact upload (#519).

Data-model discipline (even on Firestore):

- UUIDs for all primary keys.
- Explicit foreign-key fields on every relationship.
- No business logic embedded in Firestore queries.
- Clean separation between Experience Units (permanent) and
  UnitMatches (per-application).
- All write paths go through a typed service layer, not direct
  Firestore calls from the UI.

This discipline preserves a future migration path to Postgres + pgvector
without forcing it.

## Out of scope for V1

Deferred to V2+ (do not scaffold or build):

- Decision Engine (should-I-apply scoring)
- Learning Layer (outcome-driven tuning)
- Network Layer (relationship graph, referral suggestions)
- Browser extension for JD / profile import
- LinkedIn import, long-form context import, and artifact upload
  (deferred by PRD decision 3)
- Native mobile apps, offline support, or a separate mobile feature
  set (V1 is responsive web)
- Any generalization beyond the single V1 user
- Multi-user, sharing, or team features
- Integrations with job boards or ATS systems, including aggregator
  scraping

See the PRD § V2+ layers for the longer list.
