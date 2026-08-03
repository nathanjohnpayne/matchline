# Eval harness

Runs the Matchline extraction/matching/generation pipeline against a
fixture corpus and reports accuracy, latency, and cost. Exists to
enforce the 80/80 quality bar in `specs/matchline.md § Success
metrics`.

## Usage

```bash
# Stub mode — fixtures listed, no LLM calls. Runs without API keys.
npm run eval

# Real-scoring mode — calls Anthropic + OpenAI against every (resume, JD) pair.
# Smoke mode = first resume × first JD; full mode = cross product.
export ANTHROPIC_API_KEY=$(op read 'op://Private/<anthropic-item>/credential')
export OPENAI_API_KEY=$(op read 'op://Private/<openai-item>/credential')
npm run eval                # smoke
npm run eval -- --full      # full corpus — projection-guard gated
```

### Stage cache (#389)

One 4-cell × 3-sample run costs **$2.06** against a $25/mo Anthropic
cap (#177) — about 12 tuning runs a month. The stage cache removes
most of that.

Extraction is a pure function of the resume text and JD parsing a pure
function of the JD text, but `runForFixture` calls both inside the
per-(resume × JD) loop. On the 10×10 corpus #137 targets that is 100
extractions for 10 distinct resumes. The cache is content-addressed on
`(stage, provider, model, prompt version, input text)`, so changing the
extraction prompt busts only extraction entries and JD parses stay
warm.

The matching layer has **no LLM call at all** — it is pure math over
cached embeddings and the ontology. So with the upstream stages warm,
tuning mapping thresholds (#177 workstream A), score weights, and
ontology coverage runs **offline at zero cost, with no API keys set**.

```bash
npm run eval                      # cache on by default
npm run eval -- --no-cache        # bypass entirely
npm run eval -- --refresh-cache   # ignore prior runs' entries, rewrite them
rm -rf tests/eval/.cache          # invalidate everything
```

Notes:

- **`--samples N` (N > 1) forces bypass.** Sampling exists to measure
  run-to-run variance; replaying one cached answer N times would
  report variance of exactly zero and silently invalidate the metric.
- **`--refresh-cache` still reuses within a run.** It ignores entries
  from *previous* runs but reuses each key once this run recomputes
  it — otherwise a 10×10 refresh would re-extract each resume once per
  JD, and non-determinism would give one resume different Units in
  different cells.
- **Cost is reported twice.** `cost` is real new spend and drops to $0
  as the cache warms; `uncached` is what the configuration costs cold,
  and is the number to compare between configurations.
- **Warm-run latency is not production latency.** A warm run measures
  matching only, so the report labels it. Use
  `--no-cache` for a figure comparable to the <20s p95 target.
- **Partially warm runs keep a conservative budget projection.** The
  projection guard discounts a provider only when every one of its
  stages was cache-served; stage counts are not a safe proxy for cost
  when those stages use different models.
- **Bump `STAGE_IMPL_VERSION` in `cache.ts`** when you change
  extraction, JD parsing, embeddings, or their schemas in a way that
  can alter output for unchanged inputs. Otherwise the cache replays
  pre-change results and the run bypasses the code you are evaluating.

`--full` is opt-in because a daily full run of the 10×10 corpus (100
flows/run) at the PRD's target $0.75/flow is $75/run — ~$2,250/month
run daily, roughly 45× the combined $50/mo LLM cap. The projection
guard short-circuits `--full` runs that would exceed any per-provider
monthly cap (see `tests/eval/projection.ts`, defaults from
`memory/matchline_budget_ceilings.md`).

### Token sources (#389)

By default the harness bills the metered API. `--token-source` routes
the LLM calls through a subscription CLI instead, so tuning iterations
do not draw on the $25/mo Anthropic cap.

```bash
npm run eval -- --token-source claude-cli
```

| source | billing | status |
|---|---|---|
| `api` (default) | metered Anthropic + OpenAI | the fidelity reference, and the only source that yields meaningful latency |
| `claude-cli` | Claude Code subscription | verified end-to-end: 27 schema-valid Units on `nathan-2026` |
| `codex-cli` | ChatGPT subscription | transport verified on `codex` 0.146.0, but **not usable end-to-end** — see #402 |

`OPENAI_API_KEY` is required by **every** source, because embeddings
have no CLI equivalent. `ANTHROPIC_API_KEY` is required only by `api`.

**`codex-cli` cannot currently run.** `extractFromResume` and
`parseJobRequirements` throw when `modelFor(stage).provider !==
"anthropic"`, before the injected client is called — so the default
config sends `claude-sonnet-4-6` to Codex (rejected) and naming a
`gpt-*` model is refused at parse time. Tracked in #402. Point
`MATCHLINE_CODEX_HOME` at an isolated home when that is resolved; the
default `~/.codex/config.toml` starts MCP servers that stall
`codex exec`.

#### Fidelity — the CLI path ranks, it does not replicate

- **No `tool_use` enforcement.** The API constrains output with
  `tool_choice`; the CLI is instructed to write JSON to a file and the
  result is validated after the fact.
- **No output-token budget.** Production sets `max_tokens: 16_384`
  (raised in #145 after real truncation). Neither CLI exposes an
  equivalent, so a model whose default ceiling is lower could truncate
  here and not in production.
- **Latency is not comparable.** Wall-clock includes agent startup —
  399s measured on a call the API serves far faster.

Confirm the top finalists on `--token-source api` before editing
`functions/src/llm/config.ts`.

#### Security constraints

The subprocess environment is built by **allowlist**, not by filtering
`process.env` (`buildChildEnv`), mirroring the `env -i` invocations in
`scripts/phase-4b/adapters/`. No ambient credentials —
`OP_PREFLIGHT_*`, `GH_TOKEN`, GCP paths — reach the child.

⚠️ **Fixture text is untrusted input to a process that can execute
things.** Resume and JD text is embedded verbatim in the agent prompt.
The Claude adapter grants `Write` only (never `Read`), but `--add-dir`
is not an OS-level sandbox and the Claude subprocess retains the real
`HOME` because its OAuth lives there. **Do not point a CLI token
source at scraped or third-party fixtures until that is sandboxed.**
The corpus is repo-controlled today; #38, #87, and #28 change that.

### Model sweep (#389)

`--variant` runs the corpus once per configuration and prints a
quality-vs-cost Pareto table, so the model pins in
`functions/src/llm/config.ts` can be chosen from data.

```bash
npm run eval -- --token-source claude-cli \
  --variant 'sonnet:model.extraction=claude-sonnet-4-6' \
  --variant 'haiku:model.extraction=claude-haiku-4-5-20251001'
```

Grammar: `--variant '<label>:<key>=<value>[,<key>=<value>...]'`, where
`<key>` is `model.<stage>` or `prompt.<stage>/<name>`. Repeatable.
Command-wide `--prompt` flags carry into every variant; a variant's own
prompt override wins on conflict.

Cost is **modeled** — payload tokens priced through
`functions/src/llm/rates.ts` — never the CLI's reported
`total_cost_usd`, which is shadow cost of the agent harness (measured
$0.105 against ~$0.066 of real Haiku payload).

The sweep refuses to start rather than produce a mislabeled table. It
rejects a model with no `rates.ts` entry (it would report $0.00 and win
on cost), a misspelled stage, a stage the corpus never runs
(`generation`, `validation`, `rationale`), an OpenAI model (see #402),
and a prompt version containing path separators (it would resolve to a
different prompt file while the table credited this variant).

### API keys

Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are required for real
scoring on the default `api` token source (see § Token sources for the
subscription-backed alternatives, which need only `OPENAI_API_KEY`). Without them the harness falls back to listing fixtures
without scoring (clear "set API keys" note in each fixture's
output). The `*ForCli()` factories in `functions/src/llm/{anthropic,openai}.ts`
read the env vars directly, bypassing `defineSecret` (which only
resolves inside the Cloud Functions runtime).

CI runs the harness in stub mode (no keys) — gating on real
accuracy lands in [#137](https://github.com/nathanjohnpayne/matchline/issues/137)
once the corpus is large enough for stable percentiles.

## Layout

```text
tests/eval/
├── run.ts             CLI entry point
├── runForFixture.ts   per-fixture orchestration (#136)
├── loadFixtures.ts    typed fixture-file readers (#136)
├── mapping.ts         runtime UUID → labeler mnemonic (#136)
├── cache.ts           content-addressed stage cache (#389)
├── tokenSource.ts     api / claude-cli / codex-cli adapters (#389)
├── sweep.ts           pure: model×prompt matrix + Pareto table (#389)
├── scoring.ts         pure: jaccard, unit-set accuracy, top-K overlap
├── projection.ts      pure: monthly-spend cap check
├── report.ts          pure: stdout formatter
├── .cache/            stage-cache entries (gitignored)
└── *.test.ts          vitest unit tests
```

All pipeline work (extraction, matching, generation, validation)
runs through the same `functions/src/llm/` wrappers as production,
so cost tracking and model config flow through unchanged.

## Fixture layout

```text
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

- **Phase 0** (#48): harness runnable on an empty / single-fixture set; pure scoring & projection helpers ship with tests; no live extraction yet. ✅ shipped.
- **Phase 1 / #25 sub-issue 1/3** (#135): first hand-curated fixture pair (Nathan + Google JD) + adversarial-fab pin. ✅ shipped at `27aeb36`.
- **Phase 1 / #25 sub-issue 2/3** (#136): wire real `extraction` + `jdParsing` + `matching` calls into `run.ts`; CLI key plumbing; runtime-UUID → mnemonic mapping. **THIS PR.**
- **Phase 1 / #25 sub-issue 3/3** (#137): populate the 10×10 corpus; flip the 80/80 CI gate to blocking; needs more user input for prospect-list JDs.
- **Phase 3** (#41): replace the mocked `currentUsage` in the projection guard with a live `llm_calls` Firestore aggregation.
- **#389**: content-addressed stage cache, so #177's matching-layer tuning is not priced out by the $25/mo Anthropic cap. ✅ shipped.

## Architecture (#136)

```text
runForFixture(input, deps)
  ├─ loadResumeText             reads tests/fixtures/resumes/<id>.txt
  ├─ loadJdText                 reads tests/fixtures/jds/<id>.txt
  ├─ loadExpectedUnits          parses expected-units/<id>.json
  ├─ loadExpectedMatches        parses expected-matches/<id>__<id>.json
  ├─ extractFromResume          Anthropic Haiku — in-memory Units
  ├─ embedMany on Units         OpenAI text-embedding-3-small
  ├─ parseJobRequirements       Anthropic Haiku — in-memory Reqs
  ├─ embedMany on Reqs          OpenAI text-embedding-3-small
  ├─ runMatchingPipeline        no Firestore: listUnits + listRequirements + persistBatch all overridden
  ├─ mapUnitIds                 runtime UUID → labeler mnemonic (relative best-match; 0.10 sanity floor, #148)
  ├─ mapRequirementIds          same shape for Reqs
  ├─ unitSetAccuracy            extraction score vs. expected_units
  ├─ compositeIdsFromMatches    "<unit_mnemonic>:<req_mnemonic>" strings
  └─ topKOverlap                match score vs. expected_top_matches
```

Generation + validation scoring isn't wired in this PR; those layers
need Firestore for AssetRef persist and aren't end-to-end purely
in-memory. Future enhancement.

## Exit codes

- `0` — clean (empty fixtures OR all gates passed).
- `1` — one of the 80/80 gates regressed (Phase 1+).
- `2` — harness itself crashed (uncaught exception).
