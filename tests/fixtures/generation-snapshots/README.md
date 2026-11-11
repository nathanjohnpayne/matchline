# Generation snapshots (#488)

Frozen inputs for the generation suite (`npm run eval:subtasks -- --suite generation`). A snapshot holds the Experience Units, the Job Requirements and the approved matches at the point `runGenerationPipeline` starts, so JD parsing and matching are not re-run and every run sees the same ids. The suite generates from the snapshot, then validates the output with the validator pinned to production defaults.

| Snapshot | Pair | Evidence |
| --- | --- | --- |
| `gs-rich-nathan-google` | `nathan-2026` × `google-compute-spm-2026` | Every Unit in the 24 owner-labeled top matches (all approved) plus every Unit cited by the owner-labeled expected traces |
| `gs-sparse-sofia-openai` | `sofia-fullstack-founder-2026` × `openai-sse-fullstack-b2b-2026` | Three Units and five approved matches; two must-haves (`r_9yr_eng`, `r_reliability_safety_perf`) present with no approved match |

## Status: drafts pending owner review

Both snapshots are `"review_status": "draft-pending-owner-review"` and `"labeled_by": "claude-draft"`: the owner confirms they stand in for approved evidence by flipping them to `"owner-reviewed"` through a relabel.

## Public fixtures only

Unit `raw_text` is verbatim from `tests/fixtures/resumes/`, requirement `raw_text` is verbatim from `tests/fixtures/jds/`, every approved match is in the pair's `expected-matches` `expected_top_matches`, and every requirement id is in its `expected_requirements`. The loader (`tests/eval/subtasks/fixtures.ts`) enforces all of it, plus: when `expected_traces` is set, every Unit those traces cite is in the snapshot. `item_upper_bound` is used only by the dry-run projection.

## Relabeling

Same rule as `validation-cases/`: bump `label_version`, append to `tests/fixtures/eval-labels.lock.json`, land it as its own reviewed PR. A relabel changes `fixtureSetHash`, so earlier runs stop being comparable.
