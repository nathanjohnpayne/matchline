# Validation cases (#488)

Labeled cases for the validation-subtask suite (`npm run eval:subtasks -- --suite validation`). Each case freezes one generated item, the Experience Units it cites (plus any uncited distractor), and gold atomic assertions. The suite grades claim extraction, traceability and specificity against these labels in isolation, then runs the production orchestrator once over the item and grades only its passed/failed status.

## Status: drafts pending owner review

Every case here is `"review_status": "draft-pending-owner-review"` and `"labeled_by": "claude-draft"`. The schema refuses `"owner-reviewed"` with `"labeled_by": "claude-draft"`, so flipping one field cannot drop the DRAFT banner. A run over drafts prints a DRAFT banner and is not a comparison of record. The owner reviews a case by checking its assertions, flipping it to `"owner-reviewed"` with their own `labeled_by`, and landing that as a relabel (see below).

`vc-14-adversarial-fabrication` takes its item text, its four unsupported assertions and its expected status from the owner-labeled `expected-asset-traces/adversarial-fabrication.json`; the loader refuses the case if they ever disagree. Only its cited Units and gold terms are drafts.

## Public fixtures only

Every Unit `raw_text` is a verbatim substring of a resume under `tests/fixtures/resumes/`, and every Unit id exists in the matching `tests/fixtures/expected-units/` file (the runtime id is the mnemonic id). The loader enforces both, and refuses a `raw_text` that contains an email address, a phone number or a URL. Never build a case from private material.

## Schema

`schema_version` 1. Required fields: `id` (equal to the filename stem, `vc-NN-slug`), `category`, `review_status`, `labeled_by`, `labeled_at`, `label_version`, `source` (`resume_fixture_id`, `derived_from`), `units`, `item` (`id`, `section`, `text`, `source_unit_ids`), `gold` (`assertions`, `relationships`, `expected_asset_status`) and `notes`. The schema lives in `tests/eval/subtasks/fixtures.ts`.

A gold assertion has the canonical claim `text` (fed verbatim to traceability and specificity), `required_terms` (an AND of groups, each group a string or a list of alternatives, every group present in the item text), `supported` (by the CITED Units only), `supporting_unit_ids` (empty when unsupported, cited Units otherwise) and `specific` (`null` when the assertion carries no specificity label). A relationship names two or more assertions and the `co_terms` one extracted claim must carry together. `expected_asset_status` is `failed` exactly when some assertion is unsupported or not specific.

## Categories

`valid_paraphrase`, `equivalent_numeric_notation`, `swapped_employer_project`, `wrong_metric_magnitude`, `wrong_direction`, `percent_vs_percentage_points`, `unsupported_title`, `unsupported_skill`, `missing_cited_evidence`, `vague_but_traceable`, `cross_unit_fusion`, `embedded_prompt_instructions`, `multi_clause`, `adversarial_fabrication`, `date_drift`. There are 15 cases, one per category (`vc-01` to `vc-15`).

A `date_drift` case (`vc-15`) claims a year or tenure that contradicts a cited Unit's `date_range`. The loader requires a cited Unit with a `date_range` and an unsupported assertion. It is scored under traceability v2's date rule (a `date_range` supports only its own start and end) with the eval's fixed run date, `FIXED_RUN_DATE` in `tests/eval/subtasks/fixtures.ts` (2026-01-15), as `Today:`. A Unit's optional `date_range` (`start`, optional `end`, `YYYY-MM-DD`) must lie before that date, and the loader refuses one that does not, so no fixture date reads as a future one.

A `missing_cited_evidence` case must include an uncited Unit whose `raw_text` carries every gold term of an unsupported assertion, so the case proves the evidence exists but was not cited (and the traceability call is actually made against the cited Unit).

## Labels are immutable for a comparison

`tests/fixtures/eval-labels.lock.json` records each file's sha256 by `label_version`. To relabel: edit the file and bump its `label_version`; append `{ label_version, sha256 }` to its `history` in the lock; land it as a separately reviewed PR. Runs with a different `fixtureSetHash` are not comparable. `tests/eval/subtasks/labelsLock.test.ts` fails on any unlocked change.
