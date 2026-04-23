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
