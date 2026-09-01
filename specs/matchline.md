---
spec_id: matchline
name: Matchline V1
status: draft
tested: false
reason: Spec authored before implementation; tests land per-surface starting in Sprint 1.
derived_from: ../../docs/projects/matchline/matchline-prd.md
---

# Matchline V1

Feature: A single-user career operating system that converts a user's
work history into structured evidence, matches that evidence against
specific job requirements, and generates tailored applications grounded
only in user-approved evidence.

The authoritative PRD lives in the `docs` sibling repo at
`~/GitHub/docs/projects/matchline/matchline-prd.md`. This spec is the
repo-local derivation. On conflict, the PRD wins; file a plan entry to
reconcile.

## Non-goals

- Not an ATS keyword stuffer.
- Not a generative writer — no claim ships that the user hasn't confirmed.
- Not a job board, mass-apply tool, coaching product, or team product.
- Not a replacement for networks. The Network Layer is V2+.

## Core loop

```
Career → Experience Units → Matching → Application
```

The loop has four steps. Each must satisfy its own acceptance criteria;
the loop as a whole must satisfy the end-to-end criteria below.

### Step 1 — Career into Experience Units

Acceptance criteria:

- The user can import their career via at least one of: pasted resume
  text, pasted LinkedIn profile HTML (browser view-source), pasted or
  typed long-form career context.
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

- The user can paste a JD as plain text into a Role.
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
  rationales, and a specific `surface_evidence` string.
- Requirements with no qualifying match appear in an explicit **Gaps**
  view, not hidden.
- No match is auto-approved. Generation uses only matches with
  `approved_for_use == true`.

### Step 4 — Generate an application

Acceptance criteria:

- Generation accepts a target format (`resume`, `cover_letter`,
  `outreach`) and produces output grounded only in approved Experience
  Units and their approved matches.
- Before the output is shown, the validation layer (see
  `## Validation layer`) attaches a claim-to-Unit map. Any claim that
  does not trace to an approved Unit is flagged.
- The Application Editor blocks export while any validation flag is
  unresolved.
- Exports are available as PDF, DOCX, and plain text.

### End-to-end acceptance

- **Full flow.** From a populated Capability Graph, a user can paste
  a JD and produce a validated, exportable resume in under 20 seconds
  at p95.
- **Cost.** Per-application LLM spend (parse + match + generate +
  validate) is under $1 at p95; target $0.75.
- **Zero fabrication.** Every claim in every shipped output traces to
  an approved Experience Unit. This is an invariant, not a metric.

## Data model

CRM objects and Capability Graph objects are defined in the PRD § Data
model. For each object, the repo ships TypeScript types in
`src/types/` that must match the JSON shape below. Foreign keys use
UUIDs; all timestamps are ISO 8601 strings in Firestore documents.

### CRM objects

- `Person { id, name, role, company_id, relationship_type, last_contacted_at?, notes? }`
- `Company { id, name, industry?, size?, priority, url?, notes? }`
- `Role { id, company_id, title, jd_raw, jd_url?, location?, remote_policy?, comp_range?, discovered_at }`
- `Application { id, role_id, stage, applied_at?, last_activity_at, generated_assets[], approved_unit_ids[] }`
- `Interaction { id, person_id, application_id?, type, direction, summary, occurred_at }`

### Capability Graph

- `ExperienceUnit { id, source_type, source_ref, raw_text, normalized_summary, unit_type, skills[], tools[], domains[], seniority_signals[], scope_signals[], business_outcomes[], metrics[], evidence_type, confidence_score, user_approved, date_range?, created_at, updated_at }`
- `Metric { claim, value?, unit?, direction?, confidence }`
- `JobRequirementUnit { id, role_id, raw_text, normalized_requirement, category, keywords[], tools[], domains[], seniority_level?, priority, must_have, extracted_from }`
- `UnitMatch { id, experience_unit_id, job_requirement_unit_id, semantic_score, rule_score, final_score, components?, structural_evidence?, component_applicability?, rationale, surface_evidence, approved_for_use, user_rejected, created_at }`
  - `components`, `structural_evidence` and `component_applicability`
    are **optional**: records written before those fields existed carry
    none of them, and the coverage gate depends on being able to
    recognize such a record. A rerun of matching populates all three.
    A record missing `structural_evidence` retains its pre-existing
    coverage behaviour rather than being treated as unevidenced, so
    deploying the gate cannot make an already-matched Role sprout
    gaps.
  - `component_applicability` records, per axis, whether the engine
    actually evaluated it for this pair. A `false` axis means the
    corresponding value in `components` is a no-constraint neutral, and
    **no consumer may present it as a measurement** — the breakdown
    renders it as unavailable rather than as a score. When the field is
    absent, readers must assume nothing was measured: pre-existing
    records store the same neutrals without marking them.
- `UnitCluster { id, application_id, label, experience_unit_ids[], narrative_purpose, generated_text? }`

### Invariants

- `ExperienceUnit.user_approved == true` is required for the Unit to
  enter any match or generation pipeline.
- `UnitMatch.approved_for_use == true` is required for the match to
  contribute to generation.
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
- Seniority alignment and scope alignment are penalty functions, not
  similarity scores. A gap of more than one level drives the score to
  zero.
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
  constrain them, and the `0.5` seniority alignment returns when a
  Unit's signals are all unmapped by the ladder.
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
- Matching is nearly-free after embeddings exist; no per-match LLM call
  is required. Rationale strings may be LLM-generated but must be
  cached per `UnitMatch`.

Non-goals:

- Does not auto-approve matches.
- Does not hide low-quality matches; they appear in the Gaps view.
- Does not pretend to certainty; every score surfaces its reasoning.

## Validation layer

Before any generated output reaches the user:

1. Parse the output into discrete claims.
2. For each claim, verify it maps to an approved Experience Unit.
3. Flag generic non-specific language that cannot be tied to any Unit.
4. Surface flagged issues as inline annotations in the Application
   Editor. The editor blocks export while any flag is unresolved.

The validation layer is a hard constraint. No generated output may be
presented to the user without a completed traceability pass.

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

- Frontier model (Claude Sonnet or GPT-4o class) for extraction,
  rationale generation, and validation.
- Cheaper model (Haiku or GPT-4o-mini class) for bulk generation.
- Per-stage model choice is tunable via configuration; no model
  identifier is hardcoded in application logic.

## Execution targets

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

The V1 product has exactly five screens. Nothing ships that isn't
directly serving matching or generation.

1. **Onboarding** — one-time; import resume / LinkedIn / long-form
   career text; lands in Unit Review.
2. **Unit Review** — list of Experience Units, filterable by skill,
   tool, domain, date range, approval status; inline editing;
   approve / reject / flag; "Add Unit manually" action.
3. **Role Detail** — header (company, title, JD URL, stage, dates) +
   three tabs (Requirements, Matches, Applications) + persistent
   action bar (Generate resume, Generate cover letter, Export, Update
   stage).
4. **Application Editor** — two-pane view (output ↔ approved Units),
   inline traceability annotations, validation flag badges, blocked
   export until flags resolve.
5. **Pipeline** — kanban by application stage
   (Saved, Drafting, Applied, Interviewing, Offer, Rejected,
   Withdrawn); cards show company, title, days in stage, next action,
   key contact; right sidebar for tasks and follow-up reminders.

## Technical principles

- **Evidence over narrative.** The validation layer is a hard
  constraint.
- **User-approved, not AI-approved.** User approval is the only gate
  into generation.
- **Explainable by default.** Every score, match, and claim surfaces
  its reasoning.
- **Fail visibly.** No silent fallbacks; surface the gap instead.
- **One user at a time.** No sharing, collaboration, or team features.
- **Capability Graph is portable.** JSON export is a V1 feature.
- **Cost is a feature.** The per-application budget is a hard
  constraint, not a target.

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
- Mobile app
- Any generalization beyond the single V1 user
- Multi-user, sharing, or team features
- Integrations with job boards or ATS systems

See the PRD § V2+ layers for the longer list.
