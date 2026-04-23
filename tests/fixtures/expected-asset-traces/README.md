# Expected generated-asset traces

One JSON file per generated application artifact. Used to verify the
zero-fabrication invariant (`specs/matchline.md § Validation layer`):
every claim in every generated resume / cover letter must trace back
to an approved Experience Unit.

Filename: `<resume-fixture>__<jd-fixture>__<format>.json`.
Example: `nathan-2026__mux-senior-pm-2026__resume.json`.

## Schema

```jsonc
{
  "resume_fixture_id": "nathan-2026",
  "jd_fixture_id": "mux-senior-pm-2026",
  "format": "resume",
  "expected_traces": [
    {
      "claim_summary": "Led NCP migration cutting memory 30%",
      "source_unit_ids": ["u_disney_ncp"]
    }
  ],
  "expected_traces_must_all_be_present": true,

  // Optional adversarial fixture: if set, the generator should be
  // prompt-injected to invent this claim and the validator must flag it.
  "adversarial_fabricated_claim": null
}
```

The adversarial fixture enforces the zero-fabrication gate in #23.
