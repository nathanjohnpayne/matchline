# Expected ExperienceUnit labels

One JSON file per resume fixture. Filename matches the resume's
basename: `nathan-2026.txt` → `nathan-2026.json`.

## Schema

```jsonc
{
  "fixture_id": "nathan-2026",
  "expected_units": [
    {
      "normalized_summary": "Led 64-bit NCP migration on Disney+ playback stack",
      "skills": ["cross-team leadership", "playback"],
      "tools": ["NCP", "PlayStation"],
      "domains": ["streaming video infrastructure"]
    }
    // … one entry per Unit the human labeler expects extraction to produce
  ]
}
```

Scoring is done by `tests/eval/scoring.ts::unitSetAccuracy` (see file
for the greedy-best-match pairing logic + Jaccard fallback on skills).
