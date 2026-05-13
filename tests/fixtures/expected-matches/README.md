# Expected top-K match labels

One JSON file per (resume, JD) pair. Filename is
`<resume-fixture>__<jd-fixture>.json`:
`nathan-2026__mux-senior-pm-2026.json`.

## Schema

```jsonc
{
  "resume_fixture_id": "nathan-2026",
  "jd_fixture_id": "mux-senior-pm-2026",
  "k": 10,

  // Expected match IDs in the matcher's top-K, as composite
  // "unit_id:requirement_id" strings. This format matches what
  // tests/eval/scoring.ts::topKOverlap consumes (readonly string[]).
  //
  // Earlier drafts documented this as { unit_id, requirement_id }
  // objects, but the scorer expects strings — the composite form
  // keeps a single ID-per-pair contract and round-trips cleanly
  // through the Set lookup topKOverlap performs.
  "expected_top_matches": [
    "u_disney_ncp:r_video_infra",
    "u_device_cert:r_device_certification"
  ]
}
```

At scoring time, the harness flattens the actual top-K `UnitMatch`
list into the same `"${unit_id}:${requirement_id}"` form before
calling `topKOverlap`. Callers that want more structured labels
(rationale fixtures, per-pair confidence) can keep a sibling
`expected_match_rationales` key — but the primary
`expected_top_matches` is `string[]` by contract.

## Choosing `k`

`tests/eval/scoring.ts::topKOverlap` returns
`hits / expected.length` after slicing the actual list to the
first `k` items. **`k` MUST be ≥ `expected_top_matches.length`,
otherwise the scorer's max ratio is `k / expected.length` and the
fixture cannot meet the 0.80 gate even with a perfect matching
engine.** The convention in this repo is to set `k =
expected_top_matches.length` directly. A prior shape (k=5 with 22
expected) capped achievable accuracy at 22.7%.

## Stable mnemonic IDs

Each entry's `<unit_id>` and `<requirement_id>` is a stable
mnemonic the labeler controls (e.g. `u_kepler`, `r_3yr_zero_to_one`),
NOT the random UUID the runtime extraction / parsing assigns. The
harness wiring (#136) is responsible for mapping runtime UUIDs to
the labeler's mnemonic IDs by content (e.g. `normalized_summary`
+ skills overlap on the Unit side, `raw_text` substring + category
on the Requirement side). The `id` field on each entry in the
sibling `expected-units/<id>.json` file uses the same mnemonic so
cross-file references resolve. The runtime matching engine is
unaware of this convention; it's purely a labeler-side aid.

## Optional sections

- `expected_requirements` — labeler's view of how the JD parses
  into requirements with mnemonic IDs. Useful for cross-file
  reference and as a sanity check on what the parsing pipeline
  should produce.
- `expected_gaps` — must-have requirements with no honest
  matching Unit. The Gaps view in the Matches tab (#130) renders
  these.
- `downgraded_matches` — pairs explicitly REMOVED from
  `expected_top_matches` during review, with the rationale.
  Documents the curation history so a future labeler doesn't
  re-add a match that was deliberately downgraded.
