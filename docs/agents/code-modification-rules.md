# Code Modification Rules

## File and directory hygiene

- Prefer modifying existing files over creating new ones.
- Never duplicate logic or instructions.
- Do not introduce new top-level directories without documented
  justification in `AGENTS.md` or a `plans/` entry.
- Place canonical instructions only in root files or the appropriate
  supporting directory — never in `.cursor/`, `.claude/`, or
  `.vscode/`.

## L/XL issue decomposition runbook

Before an agent moves any L- or XL-sized issue from `Backlog` (or
`Ready`) into `In Progress`, the agent must confirm the issue has
been decomposed per `rules/repo_rules.md § Issue Decomposition`.
This is an operational gate — the agent owns the check, because
`scripts/ci/` can't see Project v2 field state.

### Decomposition checklist

Before moving a parent L/XL ticket to `In Progress`, verify:

1. **Native sub-issues exist** on the ticket (`GET
   repos/{owner}/{repo}/issues/{num}/sub_issues` returns at least two
   entries), OR the parent body contains a `- [ ] #NNN`-style
   checklist referencing each sub-issue by number.
2. **Each sub-issue body defines Inputs, Outputs, and Acceptance
   Criteria.** Grep the issue body for the three headers; if any is
   missing, the sub-issue is not ready.
3. **Each sub-issue is sized** on the Project v2 `Size` field.
   Unsized sub-issues are not valid decompositions.
4. **No sub-issue is itself L/XL.** If decomposition produced another
   L/XL, decompose that one too before proceeding. XS/S/M only.
5. **Sub-issues cover the parent's full scope.** If the parent's
   acceptance criteria reference capabilities no sub-issue owns, the
   decomposition is incomplete.

### If the parent is already In Progress when this rule is hit

Move the parent back to `Ready`, run the decomposition, then re-enter
`In Progress`. Do not continue work on an undecomposed L/XL parent
just because it moved before the rule applied.

### Exceptions

- **Phase parents (#5, #15, #27, #37)** are themselves decompositions
  of the PRD. They do not require additional decomposition.
- **Bug-triage umbrellas** (e.g. #42) whose scope is "whatever breaks
  in real use" can't be fully decomposed in advance. They must still
  split concrete bugs into sub-issues as they surface, before working
  on them.

## Sizing discipline

The four Project v2 size buckets map roughly to:

| Size | Effort | Typical form |
|------|--------|--------------|
| XS | < 2h | Typo fix, one-line config, add a label |
| S | 2h–1d | Single focused PR, one file or two |
| M | 1–3d | Feature with tests, multiple files |
| L | 3–7d | Would produce a hard-to-review PR; usually means decomposition pending |
| XL | 1+wk | Phase parent or architectural review; explicit decomposition expected |

When in doubt, size down. Most L sizings are latent "didn't think
about decomposition yet" signals — decompose first, resize the parent
to M or smaller, and the question goes away.

## Test coverage

Every PR that modifies production code ships with tests per
`docs/agents/testing-requirements.md`. Sub-issues created under this
rule must carry their tests, not punt them to a sibling ticket.
