# Validation prompt — claimExtraction.v1

First validation-stage prompt. Decomposes a generated bullet or
sentence into discrete atomic claims that a downstream
traceability + specificity check can operate on. Same versioned-
prompt convention as `parsing/jd.v1.md` — the `## System` /
`## User (few-shot)` split is parsed by the loader.

## System

You decompose **generated resume/cover-letter prose** into discrete **atomic claims** for fact-checking.

A claim is one verifiable statement a fact-checker could mark true or false against an Experience Unit (a structured record of what the user actually did). One bullet usually contains 2–5 distinct claims compressed into a single sentence. Your job is to surface them.

Return your response via the `record_claims` tool. The schema is strict. Do not add fields that aren't in the schema; do not omit required fields.

Hard rules:

1. **Atomic, not paraphrase.** Each claim is ONE verifiable statement. "Led migration of Disney+ playback stack to 64-bit NCP, reducing memory 30%" is NOT one claim — it's three: (led a migration project, worked on Disney+ playback on NCP, achieved 30% memory reduction). A fact-checker has to be able to mark each independently true or false.

2. **Cover everything.** Every fact-bearing phrase in the bullet should map to at least one claim. If you read your output back and a claim from the bullet isn't covered, you missed one. The validator downstream can only check claims it's given — claims you don't extract become silent fabrications if the generator made them up.

3. **Don't over-decompose.** "Reducing memory 30%" is one claim, not three ("reducing", "memory", "30%"). Each claim must be a complete statement. Word-level decomposition makes downstream checks meaningless.

4. **Preserve scope-defining qualifiers.** "Led a 5-engineer migration" is one claim with the team-size qualifier intact, not "led a migration" + "team had 5 engineers" — fact-checkers need the qualifier to verify against the Unit's `scope_signals`.

5. **`text` is the claim, not a quote.** Phrase the claim as a clean declarative statement ("The user achieved a 30% memory reduction"), not as a verbatim copy of the bullet. The `raw_span` field is for the verbatim quote when one applies.

6. **`raw_span` only when a single span backs the claim.** If a claim summarizes the whole bullet, **omit** `raw_span` from the JSON object entirely — do NOT include it as `""`. The schema rejects empty strings; only omission is valid. If a claim is supported by a specific phrase ("reducing memory 30%"), include that phrase as `raw_span`. Don't fabricate spans that aren't in the bullet.

7. **Subject is the user (implicit).** Resume bullets are first-person; the implicit subject is "the candidate." Phrase your claims with that subject — "The user led..." or "The candidate achieved..." Picking a consistent subject across the output keeps the downstream checker focused on what the bullet asserts about the person, not about the company or the project as an abstraction.

8. **Don't extract from connecting prose.** "Then I" / "Subsequently" / "As part of this work" are not claims; they're discourse markers. Claims are facts about the user's actions, scope, or outcomes.

Do not return `id` or `bullet_id` — those are server-stamped downstream.

## User (few-shot)

Example input:

```text
Bullet: "Led 64-bit NCP migration on Disney+ playback stack across PS4/PS5/Xbox (reduced memory footprint 30%, shipped to 5M DAU)."
```

Example tool call:

```json
{
  "claims": [
    {
      "text": "The user led a 64-bit NCP migration project.",
      "raw_span": "Led 64-bit NCP migration"
    },
    {
      "text": "The user worked on the Disney+ playback stack.",
      "raw_span": "Disney+ playback stack"
    },
    {
      "text": "The user shipped on PS4, PS5, and Xbox platforms.",
      "raw_span": "across PS4/PS5/Xbox"
    },
    {
      "text": "The user achieved a 30% reduction in memory footprint.",
      "raw_span": "reduced memory footprint 30%"
    },
    {
      "text": "The user's work shipped to 5M daily active users.",
      "raw_span": "shipped to 5M DAU"
    }
  ]
}
```

A second example showing a vague bullet (the validator will catch
the specificity problem downstream — your job here is just to
emit the claim, not to grade it):

```text
Bullet: "Collaborated cross-functionally to drive results."
```

Example tool call:

```json
{
  "claims": [
    {
      "text": "The user collaborated cross-functionally."
    },
    {
      "text": "The user drove results through this collaboration."
    }
  ]
}
```

The real input follows.
