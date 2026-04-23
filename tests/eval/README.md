# Eval harness

Runs the Matchline extraction/matching/generation pipeline against a
fixture corpus and reports accuracy, latency, and cost. Exists to
enforce the 80/80 quality bar in `specs/matchline.md § Success
metrics`.

## Usage

```bash
npm run eval             # smoke mode (default) — 1 fixture, no LLM calls in Phase 0
npm run eval -- --full   # full corpus — projection-guard gated
```

`--full` is opt-in because a daily full run of the 10×10 corpus at the
PRD's target $0.75/flow is ~$270/month — 5.4× the combined LLM cap.
The projection guard short-circuits `--full` runs that would exceed
any per-provider monthly cap (see `tests/eval/projection.ts`,
defaults from `memory/matchline_budget_ceilings.md`).

## Layout

```
tests/eval/
├── run.ts          CLI entry point
├── scoring.ts      pure: jaccard, unit-set accuracy, top-K overlap
├── projection.ts   pure: monthly-spend cap check
├── report.ts       pure: stdout formatter
└── *.test.ts       vitest unit tests for the pure helpers
```

All pipeline work (extraction, matching, generation, validation)
runs through the same `functions/src/llm/` wrappers as production,
so cost tracking and model config flow through unchanged.

## Fixture layout

```
tests/fixtures/
├── resumes/             raw resume text, one file per fixture
├── jds/                 raw JD text, one file per fixture
├── expected-units/      hand-labeled ExperienceUnit[] per resume
├── expected-matches/    hand-labeled top-K match IDs per (resume, jd)
└── expected-asset-traces/   per-generated-output claim → Unit map
```

Phase 0 ships the directory skeleton only; the 10×10 corpus is
populated in [#25](https://github.com/nathanjohnpayne/matchline/issues/25)
(Phase 1).

## Current status

- **Phase 0** (this ticket, [#48](https://github.com/nathanjohnpayne/matchline/issues/48)): harness runnable on an empty / single-fixture set; pure scoring & projection helpers ship with tests; no live extraction yet.
- **Phase 1** (#25): populate fixtures; wire real `extraction`, `jdParsing`, `matching`, `generation`, `validation` calls into `run.ts`; flip the 80/80 CI gate to blocking.
- **Phase 3** (#41): replace the mocked `currentUsage` in the projection guard with a live `llm_calls` Firestore aggregation.

## Exit codes

- `0` — clean (empty fixtures OR all gates passed).
- `1` — one of the 80/80 gates regressed (Phase 1+).
- `2` — harness itself crashed (uncaught exception).
