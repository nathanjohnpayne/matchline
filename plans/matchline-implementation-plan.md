# Matchline — Implementation Plan

Author: Nathan Payne (planned with Claude)
Last updated: 2026-04-22
PRD: [`~/GitHub/docs/projects/matchline/matchline-prd.md`](../../docs/projects/matchline/matchline-prd.md)
Repo-local spec: [`specs/matchline.md`](../specs/matchline.md)

---

## Framing

This plan takes the PRD from narrative form to a sequenced, ticketed
build. It divides the work into four phases that map directly onto the
sprints in the PRD's "What ships first" section, with one additional
phase at the front (Phase 0) for the human + scaffolding work that has
to complete before feature work can start.

Each phase has a parent GitHub issue and a small set of child tickets
that are individually shippable through the PR review policy in
`REVIEW_POLICY.md`. The parent issue is the unit of planning; children
are the units of work.

The hard constraint on every phase is the same as the PRD's: **zero
fabrication**. No phase trades a schedule day for a shortcut in the
validation layer. If a surface can't ship with traceability intact, it
doesn't ship.

## Phase map

| Phase | Focus | Exit milestone | PRD sprint |
|---|---|---|---|
| **0** | Foundations & access | Firebase live, secrets provisioned, reviewer identities wired, PR #4 merged | Sprint 0 |
| **1** | Core loop | Paste resume → paste JD → validated tailored resume, E2E | Sprint 1 |
| **2** | Completeness | Nathan uses Matchline as the primary tool for his first real application | Sprint 2 |
| **3** | Real use | Ten serious applications shipped through Matchline; prompts tuned on real data | Sprint 3 |

Phase boundaries are commit points, not walls. If work from Phase 2
surfaces in Phase 1 (e.g. a pipeline card mockup needed for QA), pull it
forward — but don't pull the scope that makes Phase 2 a real milestone.

## Phase 0 — Foundations & access

Most of Phase 0 is human work: creating the Firebase project, running
`op-firebase-setup`, populating secrets, and granting review
collaborator access to the agent identities. The scaffold itself (PR #4)
is in review.

### Agent tasks

- Fix the P0 review finding on PR #4: invalid Haiku model ID in
  `functions/src/llm/config.ts`. (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`.)
- Fix the P1 review finding: owner-scoping seam between
  `firestore.rules` and the service-layer queries. Either (a) a shared
  `ownerScope()` helper stubbed now, or (b) inline comments on each
  `list*` function flagging the Sprint 1 dependency. Land the helper —
  it keeps the two sides from drifting.
- Fix the broken CI workflows: the missing `needs-external-review`
  label and the `github-token` input on `triage` / `assign`.
- Merge PR #4 once review and CI are clean.

### Human tasks

- Add `nathanpayne-claude`, `nathanpayne-cursor`, `nathanpayne-codex`
  as write collaborators on `nathanjohnpayne/matchline`. Without this,
  the Phase 2 review loop in `CLAUDE.md` can't post reviewer comments.
- `firebase projects:create matchline-dev` (and optionally
  `matchline-prod`).
- `op-firebase-setup matchline-dev` — creates the deployer service
  account and wires up 1Password-backed impersonation per
  [`DEPLOYMENT.md`](../DEPLOYMENT.md).
- Store `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in Firebase secrets
  on `matchline-dev`.
- Copy `.env.example` → `.env.local` and fill in the Firebase web-app
  config values from the Firebase console.
- Enable Firestore, Authentication, Hosting, Functions in the Firebase
  console.

### Exit criteria

- PR #4 merged.
- `op-firebase-deploy --only hosting` succeeds against `matchline-dev`.
- `npm run build` green; `npm --prefix functions run build` green.
- `repo_lint.yml` green on `main`.
- Reviewer identities can post comments on matchline PRs.

## Phase 1 — Core loop

End-to-end: a user pastes a resume and a job description and Matchline
produces a validated, exportable resume with every claim traceable to
an approved Experience Unit. This is the phase the product lives or
dies on.

Scope:

1. **Auth + owner invariant.** Sign-in, `owner_uid` added to every
   schema, service-layer queries scoped by owner, `firestore.rules`
   updated to match. All other Phase 1 work depends on this being in
   first.
2. **Experience Unit extraction.** Functions endpoint that takes
   pasted resume text and produces structured Units per the schema in
   `specs/matchline.md`. Anthropic Sonnet 4.6 for extraction per
   PRD § AI pipeline. Generates embeddings on the Unit.
3. **Unit Review surface.** List + filter + inline edit + approve /
   reject / flag. Manual Unit creation. This is the integrity surface;
   it gets more QA attention than any other screen in V1.
4. **Job Requirement parsing.** Functions endpoint that takes pasted
   JD text and produces `JobRequirementUnit` records with priority,
   must-have, and category populated. Embeddings per Requirement.
5. **Matching engine.** The weighted scoring formula from
   `specs/matchline.md § Matching engine`, implemented as pure
   functions with unit tests covering each component and the
   confidence-gating invariant.
6. **Canonical ontology seed.** Hand-curated skill / tool / domain
   vocabularies for the tech-PM domain, normalized at extraction time.
7. **Role Detail → Matches tab.** Ranked matches with scores and
   rationales, a separate Gaps view, approve / reject per match.
8. **Resume generation.** Controlled-generation prompt that takes
   approved matches as ground truth. Output format targets a plain
   resume structure the Application Editor can render.
9. **Validation layer.** Claim extraction + traceability check +
   specificity check. Runs before output is surfaced to the user.
10. **Application Editor surface.** Inline traceability annotations,
    flag badges, export blocked while flags exist. Two-pane layout.
11. **Evaluation harness.** Unit extraction accuracy test (≥ 80% on a
    10-resume corpus), match accuracy test (≥ 80% on manual review),
    zero-fabrication invariant test (every claim in every generated
    output maps to an approved Unit).
12. **Phase 1 milestone QA.** End-to-end: paste Nathan's resume →
    paste a real JD → export a validated resume.

### Exit criteria

- Milestone QA passes on at least three distinct real-world JDs.
- Full-flow p95 under 20 s; per-application LLM cost under $1.
- Zero fabrication: QA cannot produce a generated output with an
  un-sourced claim. If they can, it's a Phase 1 blocker.

## Phase 2 — Completeness

Turns the core loop into the product the user actually wants to run
their search with.

Scope:

1. **LinkedIn HTML parser.** Paste view-source HTML; extract Experience
   Units through the same Phase 1 extraction pipeline.
2. **Long-form career context parser.** Free-text career dumps get the
   same Unit treatment, with a clearer source-provenance string.
3. **Cover letter generation.** Same grounding + validation as resumes,
   with different narrative prompts.
4. **Application Editor polish.** Hover-to-highlight source Unit,
   editing that preserves traceability where possible and re-flags
   where it doesn't.
5. **Pipeline Kanban.** Seven-column board (Saved → Withdrawn), cards
   show company, title, days in stage, next action, key contact.
6. **Export.** PDF, DOCX, plain text. DOCX is the highest-fidelity
   format recruiters tend to ask for.
7. **Tasks + follow-up reminders sidebar.** Lightweight, not a
   full task manager.
8. **Capability Graph JSON export.** Portability is a V1 technical
   principle; the export ships in Phase 2.
9. **Phase 2 milestone.** Nathan submits his first real application
   through Matchline end-to-end.

### Exit criteria

- Nathan uses the product for one real application without editing any
  fabricated claims out (per the PRD's V1 success bar).
- Pipeline + Editor + Export work without breaking the zero-fabrication
  invariant from Phase 1.

## Phase 3 — Real use

Tuning and bug-fixing against real usage. Scope is data-driven; the
list below is the starting point, not the final scope.

Scope:

1. **Extraction prompt tuning.** Patterns Nathan's resumes surface
   that the seed prompt gets wrong. Regression tests.
2. **Matching rationale + weight tuning.** Patterns in Nathan's
   approve / reject decisions feed back into the formula's weights.
3. **Generation prompt tuning.** Tone and specificity pass; ensure
   generated bullets sound like Nathan's voice.
4. **Cost + latency telemetry.** Per-stage LLM spend and latency
   logged to a dashboard (simple Firestore collection + a small UI
   page, or Google Cloud Logging if the budget is easier).
5. **Bug triage and fixes.** Whatever real use breaks.
6. **Phase 3 milestone.** Ten serious applications shipped through
   Matchline end-to-end.

### Exit criteria

- PRD's V1 primary metric met: Matchline is Nathan's primary tool for
  the search, not abandoned for a spreadsheet.
- Ten serious applications through the product.
- Match accuracy ≥ 80% on manual review held against real data.

---

## Tracking

- **GitHub Project:** [`match|line v0.1`](https://github.com/users/nathanjohnpayne/projects/6) (Project #6).
- **Parent issues per phase** link to child tickets via GitHub's native
  sub-issue model; the parent's progress bar rolls up automatically.
- **Swimlane convention:** Backlog → Ready → In progress → In review → Done.
  Human-action tickets stay in Backlog until Nathan picks them up; the
  agent is not the assignee on any human-action ticket.
- **Driver script:**
  `~/GitHub/nathanpaynedotcom/scripts/gh-projects/examples/matchline/create-issues.sh`
  created every parent + child in one run. Rerunnable only against a
  fresh project.

## What this plan is not

- Not the spec. The authoritative V1 behavior lives in
  [`specs/matchline.md`](../specs/matchline.md). When this plan and the
  spec disagree, the spec wins.
- Not a prompt library. Extraction / matching / generation / validation
  prompts are their own artifacts — they'll live under `src/prompts/`
  or `functions/src/prompts/` once Phase 1 starts.
- Not a guarantee. Phase 3 scope is framed as data-driven for a reason:
  the real scope comes from what Nathan hits while using the product.
