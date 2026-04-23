# Tests

Automated tests live here. Per `rules/repo_rules.md`, tests must not be
deleted to force a build to pass.

## Conventions

- Test filenames should match a spec's basename so
  `scripts/ci/check_spec_test_alignment` can link them automatically.
  When that isn't possible, add an entry to `.repo-template.yml`'s
  `spec_test_map`.
- Shell-based tests end in `.sh` and are executable.
- JavaScript/TypeScript tests follow the default glob
  `tests/**/*.test.*`.

## What to test

V1 spec surfaces that require automated coverage (add as they ship):

- Experience Unit extraction — schema conformance, confidence score
  range, zero-fabrication invariant on test resumes.
- Job Requirement parsing — priority and must-have extraction accuracy
  on a fixture set of JDs.
- Matching engine — scoring formula invariants (monotonicity,
  confidence gating, seniority penalty) and snapshot tests on a
  fixture Capability Graph × Requirement set.
- Validation layer — every generated claim maps to an approved Unit;
  flagged output cannot be exported.
- Data model — foreign-key integrity between Experience Units,
  Requirement Units, UnitMatches, and Applications.

Quality bars from the PRD (see `specs/matchline.md`):

- Unit extraction accuracy ≥ 80% on a test corpus of 10 resumes.
- Match accuracy ≥ 80% on manual review.
- Zero fabrication: a hard constraint, not a statistical target.
