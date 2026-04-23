# Expected top-K match labels

One JSON file per (resume, JD) pair. Filename is
`<resume-fixture>__<jd-fixture>.json`:
`nathan-2026__mux-senior-pm-2026.json`.

## Schema

```jsonc
{
  "resume_fixture_id": "nathan-2026",
  "jd_fixture_id": "mux-senior-pm-2026",
  "expected_top_matches": [
    // Ordered list of expected (unit_id, requirement_id) pairs that
    // the matching engine should surface in its top-K.
    { "unit_id": "u_disney_ncp", "requirement_id": "r_video_infra" },
    { "unit_id": "u_device_cert", "requirement_id": "r_device_certification" }
  ],
  "k": 10
}
```

Scoring is done by `tests/eval/scoring.ts::topKOverlap`.
