# Testing Requirements

Unit tests are part of the default scope for every agent-action PR
that touches production code. This is a coverage expectation, not a
stretch goal — agents must land tests alongside the change, not file
a follow-on ticket.

## Required on every PR

1. **Unit tests for every new pure function.** If a function has
   deterministic inputs and outputs (matching math, validation
   primitives, score calculation, rate lookup, ontology normalization,
   claim extraction from known text), it gets tests covering:
   - Happy path with realistic inputs.
   - At least one boundary / zero-input case.
   - At least one failure mode (invalid input, throws).
2. **Integration / fixture tests for I/O-bound code.** When a function
   hits Firestore, an LLM, or the filesystem, the PR adds a fixture
   test that exercises the happy path via emulator (Firestore) or
   mocked provider (LLM). It's fine to cite an already-scoped ticket
   (#25 for the eval-harness corpus, #48 for harness scaffolding) as
   the home for broader coverage, but the basic happy-path fixture
   ships with the feature.
3. **Rules tests for Firestore rule changes.** Any change under
   `firestore.rules` requires a `@firebase/rules-unit-testing` case
   that demonstrates the change works as intended (auth enforcement,
   cross-owner rejection, etc).
4. **Update tests when behavior changes.** Do not let a failing test
   "pass" by changing the assertion to match the regression. If the
   test was wrong, fix it and explain why in the PR description.
5. **Do not delete tests to make a build pass.** Removing a test is
   a decision that gets documented in the PR description with the
   reason, never a commit-message afterthought. CI enforces this via
   `scripts/ci/` checks.

## Spec alignment

Every spec file under `specs/` must have a corresponding test file
under `tests/` (or an explicit `tested: false` with a `reason:` in
the spec's frontmatter). The `scripts/ci/check_spec_test_alignment`
check enforces this.

## What "counts" as a test

- Vitest assertions on TypeScript code: yes.
- Playwright E2E walking a user flow (Phase 1 `#24` onward): yes.
- Firebase rules tests via emulator: yes.
- A `console.log` sanity check: no.
- "I ran it locally once": no.

## The zero-fabrication invariant test

`specs/matchline.md § Validation layer` specifies that every
generated output must trace back to an approved Experience Unit. The
validation-layer PR (`#23`) must include an adversarial test: a
generator prompt-injected to invent a claim; the validator must flag
it and the editor must block export. This is a binary correctness
test, not a metric — it moves from pass to fail the moment it regresses.

## Per-phase expectations

- **Phase 0** (`#5`): every new module under `functions/src/llm/`,
  `src/services/`, and `shared/` ships with unit tests for its pure
  functions. Firestore rules changes ship with rules-unit-testing
  coverage. The eval-harness scaffolding (`#48`) stands up the
  structure for Phase 1 fixture tests.
- **Phase 1** (`#15`): extraction, parsing, matching, generation, and
  validation all ship with schema-level tests and at least one real
  fixture from `tests/fixtures/`. The 80/80 quality gate lands with
  `#25` on a populated corpus.
- **Phase 2** (`#27`): UI-bearing tickets (Editor, Pipeline) add
  Playwright smoke tests for the critical paths (flag resolution,
  drag-to-stage, export-blocked-on-flag). Extraction variants
  (LinkedIn, long-form) reuse the Phase 1 fixture harness.
- **Phase 3** (`#37`): prompt-tuning changes run the full eval
  harness on every push and block merge if 80/80 regresses. Cost and
  latency telemetry (`#41`) ships with a fixture test that proves the
  budget alarm fires at the configured threshold.

## What a good PR test plan looks like

The PR description's "Test plan" checklist should concretely state
which of the above applied. Example from a recent PR:

```
- [x] npm test → 17 passing (rates.test.ts:8, cost.test.ts:9).
- [x] npm --prefix functions run build green.
- [x] scripts/ci/check_spec_test_alignment passes.
- [ ] Firestore emulator integration for recordUsage write path —
      deferred to #48's harness.
```

Not-applicable checkpoints should be called out explicitly as "not
applicable because X." Silent omissions read as missed coverage.
