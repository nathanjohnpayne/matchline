# Repository Rules

Agents must treat every entry here as a binding constraint, not a
suggestion. If a proposed change would violate a rule below, stop and
flag the conflict before proceeding.

## Structure Invariants

- Canonical root files must always exist:
  README.md, AGENTS.md, CLAUDE.md, DEPLOYMENT.md, CONTRIBUTING.md, .ai_context.md
- `CLAUDE.md` must contain only a reading-order pointer to `AGENTS.md`.
  It must never duplicate instructions from AGENTS.md or any other file.
- `AGENTS.md` is a lightweight index pointing to `docs/agents/`. Agent
  instructions live in focused sub-files under `docs/agents/`.
- Tool folders (.cursor/, .claude/, .vscode/) must contain
  configuration only—no instructions, no behavioral rules.
- No new top-level directories without justification documented in
  AGENTS.md or a plans/ entry.

## Forbidden Patterns

- Never push directly to `main`. All changes must go through a
  pull request—even single-line fixes and documentation updates.
  The only exception is if the human explicitly authorizes a
  direct push in chat as a break-glass override.
- Instructions must not be duplicated between root files and
  tool folders.
- `dist/` must not be edited manually. Regenerate through the
  build system only.
- Tests must not be deleted to force a build to pass.
- Secrets must never be committed. Use environment variables or
  a secrets manager.

## Issue Decomposition (L/XL gate)

Any issue estimated **L** or **XL** on the Project v2 `Size` field
must be decomposed into smaller sub-issues **before** it enters the
`In Progress` swimlane. This gate is operational, not advisory.

- **Atomicity.** Each sub-issue must be scoped so that an agent can
  execute, verify, and retry it independently. If the sub-issue still
  needs a human to sequence or un-stick it, decompose further.
- **Contract.** Each sub-issue body must define, at minimum:
  1. **Inputs** — files, data, prior tickets it depends on.
  2. **Outputs** — files created or modified, artifacts produced.
  3. **Acceptance criteria** — executable checks or stated
     pass/fail conditions. Tests that would cover the change
     belong in the acceptance criteria, not as a follow-on.
- **Linkage.** Sub-issues are linked to the parent via GitHub's
  native sub-issue mechanism (`POST
  repos/{owner}/{repo}/issues/{num}/sub_issues`) OR tracked as a
  checklist in the parent body with per-item `#NNN` references.
  Native sub-issues are preferred — the parent's progress bar rolls
  up automatically in the Project v2 UI.
- **Swimlane discipline.** Sub-issues move through
  `Backlog → Ready → In Progress → In Review → Done` with work
  progress. The parent stays in `In Progress` while any sub-issue is
  unresolved; it moves to `Done` only when every sub-issue is
  `Done` and the parent's own acceptance criteria are met.
- **Phase parents exempt from re-decomposition.** The four Matchline
  phase parents (#5, #15, #27, #37) are themselves decompositions of
  the PRD; their sub-issues are the per-phase tickets. They do not
  require additional decomposition.
- **Estimation discipline.** Sizing a ticket L or XL is itself a
  signal that decomposition is probably warranted. Prefer sizing a
  ticket M or smaller where possible; reach for L only when the
  work is genuinely one atomic unit (rare); reach for XL only for
  phase parents or architecture reviews.

The L/XL decomposition rule above is enforced at agent-workflow time,
not via a CI script — Project v2 field state isn't available to
`scripts/ci/` runs. See `docs/agents/code-modification-rules.md` for
the runbook an agent follows before moving an L/XL ticket to
`In Progress`.

## CI Enforcement

The following checks run from `scripts/ci/` locally and, in CI, from one of two
workflows. `.github/workflows/repo_lint.yml` is manifest-canonical — propagated
byte-for-byte from mergepath, so it cannot carry matchline-specific wiring.
Checks with no mergepath counterpart are wired in the never-propagated annex
`.github/workflows/repo_lint_local.yml`, which `check_ci_scripts_wired` scans as
a union with the canonical file. Currently in the annex:
`check_prompt_schema_pairs`, `check_no_other_skill_normalization`,
`check_fixture_match_ids`, `check_no_duplicate_document_contracts`,
`check_deploy_service_list`.

The annex runs no `npm ci`, so a check wired there must depend on nothing
beyond a stock shell and the checked-out tree.

All checks must pass before merge.

- check_required_root_files
- check_no_tool_folder_instructions
- check_no_forbidden_top_level_dirs
- check_dist_not_modified
- check_spec_test_alignment
- check_duplicate_docs
- check_review_policy_exists (inline in repo_lint.yml): .github/review-policy.yml and REVIEW_POLICY.md must both exist
- check_codex_scripts: `scripts/codex-review-request.sh` and `scripts/codex-review-check.sh` must exist and be executable in every repo. Required for `CLAUDE.md` step 8 Phase 4a (automated external review via the OpenAI Codex GitHub App) — missing either script silently forces callers to Phase 4b fallback.
- check_prompt_schema_pairs: every `functions/src/prompts/<stage>/<name>.v<N>.md` must have a co-located `<name>.v<N>.schema.ts` and vice versa. Enforces the versioned-prompt pair invariant the loader in `functions/src/prompts/loader.ts` depends on. See issue #49.
- check_no_duplicate_document_contracts: the Firestore document contracts (`ExperienceUnit`, `JobRequirementUnit`, `UnitMatch`, `UnitCluster`, `ScoreComponents` and the enums they use) are declared exactly once **repo-wide**, in `functions/src/types/capability.ts`. Every `.ts`/`.tsx` file under `src/`, `functions/src/` and `tests/` is scanned; `src/types/capability.ts` type-only re-exports and must never redeclare. The two files were previously hand-synced copies and had already drifted — each documented invariants the other could not see, and nothing failed. See #443.
- check_no_other_skill_normalization: only `functions/src/matching/normalize.ts` may define `normalizeSkill` / `normalizeTool` / `normalizeDomain`, and only that module may import the `*.seed.json` ontology files directly. Enforces the single-source-of-truth invariant for canonical-vocabulary normalization (#96, parent #20).
- check_fixture_match_ids: every `expected_top_matches` entry in `tests/fixtures/expected-matches/*.json` must resolve to a real unit id in `tests/fixtures/expected-units/<resume>.json` and a real requirement id in the same expected-matches file's `expected_requirements`. Closes the silent ID-drift window flagged on #138.
- check_deploy_service_list: every function exported from `functions/src/index.ts` must appear in the function-inventory table in `DEPLOYMENT.md` § Cloud Run IAM prerequisites, and vice versa. The check verifies **accounting only** — it deliberately does not infer trigger type, Cloud Run service name, or region, because approximating firebase-tools' naming and the TypeScript compiler's binding resolution produced a check that was confidently wrong in new ways each round (PR #452), at one point advising that an event-triggered function be made publicly invokable. Those columns are human judgement recorded in the table; this only enforces that nobody adds a function and forgets. Fails closed on a missing heading, a missing table, or zero parsed exports.
