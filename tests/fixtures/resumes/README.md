# Fixture resumes

One plain-text resume per file. Format: `.txt`, UTF-8, no frontmatter.
Filename is the fixture ID used across `expected-units/`,
`expected-matches/`, and `expected-asset-traces/`.

**Example:** `nathan-2026.txt` pairs with `expected-units/nathan-2026.json`.

## Populating

Phase 1 (#25) populates this directory with 10 resumes:

- Nathan's own resume (`nathan-2026.txt`).
- 9 additional resumes. Prefer synthetic or publicly-sharable sources.
  Obtain explicit permission for any real resume used.

## Never commit

- Real names / contact info for anyone who didn't explicitly consent.
- Resumes Nathan received in confidence from recruiters or applicants.

## PII redaction convention

Direct contact info (email, phone) is **always** replaced with
placeholders even when the fixture is the resume owner's own data:

- Email: `hire@example.com` (or `<role>@example.com` per RFC 6761).
- Phone: a number from the `(555) 010-XXXX` reserved range
  (the 555-01XX block is reserved for fictitious use).

Reasoning: a public-checked-in test fixture is reachable by repo
scrapers, fork-makers, and anyone browsing the project. Even
consenting personal contact info attracts spam and propagates
without the owner's awareness as the fixture is copied. Public
identifiers (personal website, LinkedIn, GitHub URLs) are fine to
keep — they're already on the owner's public footprint and the
matching pipeline doesn't read them.

cursor #138 r1 + CodeRabbit caught this on the first commit;
keep the convention.
