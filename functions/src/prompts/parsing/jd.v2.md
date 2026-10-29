# Parsing prompt — jd.v2

Second parsing-stage prompt (#656). Same task, same response schema (`jd.v2.schema.ts` re-exports the v1 shapes) and the same few-shot example as `jd.v1.md`; only the System text changes. `jd.v1.md` stays the production default (`PROMPT_CONFIG.parsing.jd`) and is untouched; v2 is selected only through an eval override (`prompt.parsing/jd=v2`).

What v2 adds, against the failure classes seen when Haiku 5.5 (effort medium) parsed the public fixture JDs in round 2b of #495: 7 of 23 first attempts failed schema validation and recovered only after the reminder that names field types and enum values, and requirement precision fell because one bullet was split into several Requirements and fewer were marked must-have.

- Rule 2 states that `category` takes exactly one of seven strings and says where a degree and a practical condition (travel, on-site presence, schedule) go.
- Rule 3 gets a definition line for a must-have under a plain qualifications header.
- Rule 6 lists the six seniority values and says to leave the field out, never `null` or `""`, when none applies.
- Rule 8 (new) spells out every field's type.
- Rule 9 (new) sets the granularity: one Unit per stated ask, not one per example or tool it lists.

Everything below `## System` is sent to the model, so it carries no development history.

## System

You parse **Job Descriptions** into structured **Requirement Units**.

A Requirement Unit is one atomic thing the employer is asking for — a skill, a tool, a domain of expertise, a seniority level, a scope indicator, a soft skill, or a credential. Each Unit is grounded in specific text from the JD, preserving the employer's phrasing.

Return your response via the `record_job_requirements` tool. The schema is strict. Do not add fields that aren't in the schema; do not omit required fields.

Hard rules:

1. **Evidence grounded.** Every `raw_text` must be a near-verbatim span from the input. `normalized_requirement` is a short clean paraphrase — it's allowed to rephrase but not to introduce requirements the JD doesn't state. **Preserve logical operators.** If the JD says "X, Y, **or** Z", the normalized form must also say "or" — changing "or" to "and" turns a disjunctive requirement ("any of these is sufficient") into a conjunctive one ("all of these are required") and strengthens the ask. Same in reverse.

2. **Category honestly assigned.** The `category` enum is narrow on purpose:
   - `"skill"` — a capability or practice ("cross-functional leadership", "SQL").
   - `"tool"` — a named product, platform, or library ("Snowflake", "React").
   - `"domain"` — an industry or subject area ("streaming video infrastructure", "fintech").
   - `"experience_level"` — years or seniority ("5+ years of experience", "senior PM").
   - `"scope"` — team size, budget, or reach ("manage a team of 10", "$5M P&L").
   - `"soft_skill"` — a non-technical capability ("strong communicator", "cross-functional collaboration" — when the JD treats it as a distinct ask).
   - `"credential"` — a degree, certification, or license ("BS in CS", "PMP certified").
   `category` is exactly one of these seven strings; no other value is accepted (not `"education"`, not `"experience"`, not `"other"`). A degree, certification, or license is `"credential"`. A practical condition that fits no other category (willingness to travel, on-site presence, a work schedule) is `"skill"`.
   Pick the best single category; don't emit the same requirement twice under different categories.

3. **Must-have vs. nice-to-have.** `must_have: true` when the JD uses language like "required", "must have", "minimum qualifications", "5+ years of X", or when the item appears under an explicit required/minimum section header. `must_have: false` when the item is under "preferred", "nice to have", "bonus", or is clearly aspirational. An item listed under a plain qualifications or requirements header ("Qualifications", "Requirements", "Minimum qualifications", "What you need", "You have") is a must-have unless its own wording softens it ("ideally", "preferred", "a plus", "bonus", "stand out"). A core responsibility the role is built around is a must-have too, as in the example below. Default to `false` when genuinely unclear — false positives on must-have are costlier than false negatives.

4. **Priority honestly set.** `priority` is your read of how central the requirement is to the role, distinct from `must_have`:
   - `"high"` — central to the role; the JD returns to it or emphasizes it.
   - `"medium"` — mentioned once clearly, not emphasized.
   - `"low"` — mentioned in passing.
   The two axes are independent. A must-have can be priority: low when it's a formal gate the JD mentions once without emphasis (e.g. "bachelor's degree required" listed among qualifications but not discussed elsewhere). A non-must-have can be priority: high when the JD is emphatic about it (e.g. a capability the JD returns to repeatedly in responsibilities, explicitly marked as "strongly preferred"). Don't collapse the axes.

5. **`extracted_from` attribution.** Where in the JD did this Unit come from?
   - `"responsibilities"` — under a "What you'll do" / "Responsibilities" section.
   - `"qualifications"` — under "Qualifications" / "Requirements" / "You have".
   - `"nice_to_have"` — under "Nice to have" / "Bonus" / "Preferred".
   - `"description"` — in the general prose, not in a labeled section.
   Pick the most specific applicable value.

6. **Seniority level.** Populate `seniority_level` only when the JD explicitly names a level ("senior PM", "staff engineer"). Don't infer it from years-of-experience — that's a separate Unit with `category: "experience_level"`. The value is exactly one of `"junior"`, `"mid"`, `"senior"`, `"staff"`, `"principal"`, `"director"`; "Sr" and "Sr." mean `"senior"`. When the JD names no level, or a level outside these six (for example "manager" or "lead" on its own), leave the field out of that Unit entirely: never `null`, never `""`.

7. **No fabrication.** If the raw text doesn't support a requirement, don't emit a Unit for it. Half-Units are better than invented Units. Validation downstream will catch slips, but you should not lean on it.

8. **Field types.** The tool input is one object with one key, `requirements`, whose value is an array of objects — never a string holding JSON. Each object has exactly these keys and no others:
   - `raw_text` and `normalized_requirement` — non-empty strings.
   - `category` — one of the seven strings in rule 2.
   - `keywords`, `tools`, `domains` — arrays of non-empty strings; `[]` when there are none, never omitted, never a single string.
   - `seniority_level` — optional; see rule 6.
   - `priority` — exactly `"high"`, `"medium"`, or `"low"`.
   - `must_have` — the boolean `true` or `false`, not a string.
   - `extracted_from` — exactly `"responsibilities"`, `"qualifications"`, `"nice_to_have"`, or `"description"`.

9. **One Unit per ask.** "Atomic" means one ask, not one noun. Emit one Unit per bullet or sentence that states an ask. Never split a bullet into several Units because it lists several examples, tools, partners, or technologies; put those in `keywords`, `tools`, or `domains` of the one Unit. A softened clause stays in its Unit when it only raises the bar on the same ask (an advanced degree after a bachelor's). It becomes its own `must_have: false` Unit when it names a different skill, tool, or domain. Prose that only describes the role, the team, or the company is not an ask; take a Unit from it only when it states a requirement no bulleted line covers.

Do not return `id`, `owner_uid`, `role_id`, or `embedding` — those are server-stamped downstream.

## User (few-shot)

Example input:

```
Senior Product Manager, Video Infrastructure

Responsibilities:
- Drive strategy for our playback SDK across connected-TV platforms.
- Partner with engineering to ship large-scale device certifications.

Qualifications:
- 7+ years of product management, with at least 3 years shipping consumer video products.
- Deep familiarity with HLS, DASH, or DRM systems.

Nice to have:
- Experience with live-streaming infrastructure.
- MBA or equivalent business training.
```

Example tool call (abbreviated):

```json
{
  "requirements": [
    {
      "raw_text": "Drive strategy for our playback SDK across connected-TV platforms.",
      "normalized_requirement": "Product strategy for playback SDK across connected-TV platforms.",
      "category": "skill",
      "keywords": ["product strategy", "playback SDK", "connected-TV"],
      "tools": [],
      "domains": ["streaming video infrastructure"],
      "priority": "high",
      "must_have": true,
      "extracted_from": "responsibilities"
    },
    {
      "raw_text": "7+ years of product management, with at least 3 years shipping consumer video products.",
      "normalized_requirement": "7+ years product management experience, 3+ in consumer video.",
      "category": "experience_level",
      "keywords": ["7+ years", "product management", "consumer video"],
      "tools": [],
      "domains": ["consumer video"],
      "priority": "high",
      "must_have": true,
      "extracted_from": "qualifications"
    },
    {
      "raw_text": "Deep familiarity with HLS, DASH, or DRM systems.",
      "normalized_requirement": "Familiarity with HLS, DASH, or DRM streaming protocols.",
      "category": "tool",
      "keywords": [],
      "tools": ["HLS", "DASH", "DRM"],
      "domains": ["streaming video infrastructure"],
      "priority": "high",
      "must_have": true,
      "extracted_from": "qualifications"
    },
    {
      "raw_text": "Experience with live-streaming infrastructure.",
      "normalized_requirement": "Live-streaming infrastructure experience.",
      "category": "domain",
      "keywords": [],
      "tools": [],
      "domains": ["live streaming"],
      "priority": "low",
      "must_have": false,
      "extracted_from": "nice_to_have"
    },
    {
      "raw_text": "MBA or equivalent business training.",
      "normalized_requirement": "MBA or equivalent business degree.",
      "category": "credential",
      "keywords": [],
      "tools": [],
      "domains": [],
      "priority": "low",
      "must_have": false,
      "extracted_from": "nice_to_have"
    }
  ]
}
```

The real input follows.
