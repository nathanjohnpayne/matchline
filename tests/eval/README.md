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
| `claude-cli` | Claude Code subscription | verified end-to-end on `nathan-2026` — see `claudeCliClient`'s docstring in `tokenSource.ts` for the spike record |

`OPENAI_API_KEY` is required by **every** source, because embeddings
have no CLI equivalent. `ANTHROPIC_API_KEY` is required only by `api`.

#### Fidelity — the CLI path ranks, it does not replicate

- **Different structured-output semantics.** The API constrains output
  with `tool_choice`; Claude CLI validates its final JSON response
  against the same schema but does not replicate an API tool call.
- **No output-token budget.** Production sets `max_tokens: 16_384`
  (raised in #145 after real truncation). The CLI does not expose an
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

⚠️ **Fixture text is untrusted prompt input.** Resume and JD text is
embedded verbatim in the agent prompt. The Claude adapter uses native
JSON-schema output with `--tools ""` and `--safe-mode`: it grants the
model neither filesystem nor shell tools, while the environment
allowlist keeps ambient credentials out of the child. Keep those flags
in place before widening the corpus to scraped or third-party fixtures
(#38, #87, and #28).

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
`<key>` is `model.<stage>`, `prompt.<stage>/<name>` or `effort.<stage>`. Repeatable.
Command-wide `--prompt` flags carry into every variant; a variant's own
prompt override wins on conflict.

#### Claude 5.5 models and effort (#495)

How each model is called lives in `functions/src/llm/modelProfile.ts`, and a model must be registered there (and in `rates.ts`) before it can be swept. The current pins are called exactly as before. The 5.5 family differs in three ways the profile absorbs:

- **Tool choice.** Opus 5.5 and Sonnet 5.5 reject a forced `tool_choice`, so they are asked to answer through the tool with `tool_choice: auto` and a system instruction. A text answer is the existing `no_tool_use` failure and retries. Haiku 5.5 keeps the forced choice.
- **Output budget.** The 5.5 tokenizer counts about 30–35% more tokens for the same text, and Opus/Sonnet 5.5 thinking counts toward `max_tokens`, so their budget is doubled. Above the SDK's non-streaming limit the call passes an explicit timeout.
- **Effort.** `output_config.effort` is always sent for 5.5 models: the profile default (`medium` for Opus and Haiku 5.5, `high` for Sonnet 5.5) unless the variant sets one.

```bash
npm run eval -- --full --samples 3 \
  --variant 'haiku55:model.extraction=claude-haiku-5-5' \
  --variant 'sonnet55-low:model.extraction=claude-sonnet-5-5,effort.extraction=low' \
  --variant 'opus55:model.extraction=claude-opus-5-5,effort.extraction=medium'
```

The sweep refuses to start when a variant names a model with no profile, an effort its model does not accept (the 4.x pins take none), or an effort on a subscription-CLI token source, whose adapters do not forward `output_config.effort`; CLI rows record no effort. The results table shows the effort each stage actually sent, defaults included. An effort override is part of the stage-cache key; with no override the key is unchanged, so existing cache entries stay valid. A safety decline (`stop_reason: "refusal"`) is recorded as a `refusal` failure and is not retried.

Cost is **modeled** — payload tokens priced through
`functions/src/llm/rates.ts` — never the CLI's reported
`total_cost_usd`, which is shadow cost of the agent harness (measured
$0.105 against ~$0.066 of real Haiku payload).

The sweep refuses to start rather than produce a mislabeled table. It
rejects a model with no `rates.ts` entry (it would report $0.00 and win
on cost), a misspelled stage, a stage the corpus never runs
(`generation`, `validation`, `rationale`), an OpenAI model (see #402),
a prompt key the corpus never resolves — only `extraction/resume` and
`parsing/jd` are exercised, so `--variant
'x:prompt.validation/traceability=v2'` and a command-wide `--prompt`
naming any other key both fail before the run starts — a variant label
outside `[A-Za-z0-9._-]` (it would corrupt the Markdown results table),
and a prompt version containing path separators (it would resolve to a
different prompt file while the table credited this variant).

Unknown command-line flags are rejected too, for the same reason one
level up: an ignored `--tokn-source claude-cli` would leave the default
metered API selected and spend real money on a run you meant to bill to
a subscription.

### Fit-brief eval — private corpus (#495 Phase 3)

`npm run eval:fit-brief` generates a fit brief for each job description in a **private** corpus and scores it against the brief the owner wrote and approved for that role. The corpus is the owner's real job search, and this repository is public, so the harness enforces three rules:

- The corpus is read only from the directory named by `MATCHLINE_PRIVATE_CORPUS`, and the harness refuses to start if that directory resolves inside this repository, symlinks included.
- Every generated brief, judgement and per-pair score is written to `--out` (default `~/.matchline/eval-private/fit-brief/<run-id>`), which must also be outside the repository.
- The printed report contains configuration and aggregates only, never a pair id, quote or corpus text.

Nothing from the corpus belongs in a commit: no fixtures, examples or test expectations. The tests here use invented data.

The corpus directory holds `matchline-fit-brief-manifest.json`, which names the canonical résumé, an optional skills inventory, optional claim rules, and the pairs. Each pair has an `id`, a `jd`, a `reference` brief, and a `split` of `dev` or `test`. Paths are relative to the corpus directory and may not leave it. See `fitBrief/corpus.ts`.

```bash
export MATCHLINE_PRIVATE_CORPUS=/path/outside/this/repo
npm run eval:fit-brief -- --model claude-sonnet-5-5 --dry-run            # validate, print the plan, no API calls
npm run eval:fit-brief -- --model claude-sonnet-5-5 --effort medium --max-usd 10
npm run eval:fit-brief -- --model claude-opus-5-5 --evidence units --split test --samples 2 --max-usd 15
```

Each brief is scored on:

- **Evidence gate (deterministic).** Every evidence quote must appear in the résumé or inventory. Formatting and case are ignored; wording is not.
- **Claim gate (model-graded).** The judge (default `claude-opus-5-5`, effort `high`) lists statements about the candidate that the sources don't support, and claim-rule violations. A brief passes the gates only with none of these and no unsupported evidence.
- **Coverage (model-graded).** Recall: the reference's strengths and exposures that the brief covers, with half credit for partial coverage. Precision: the brief's points that match the reference.
- **Verdict agreement** with the reference.

`--evidence units` feeds the generator Experience Units extracted from the résumé by the current extraction pin, instead of the résumé itself. It tests whether Units are sufficient evidence for a brief. `--max-usd` is required for a paid run. The run stops at that bound and reports itself as incomplete.

The claim gate is model-graded rather than reusing the claim-extraction and traceability validators. Those validators assume every claim is about the candidate, as in a résumé bullet. A fit brief also states facts about the role and gives advice, and traceability would flag those as fabrications.

### What the cost figures are

Every dollar figure the harness prints is a **list-price estimate**: provider-reported token counts priced through `functions/src/llm/rates.ts` by `priceUsage` in `functions/src/llm/cost.ts`, the same function production telemetry uses. It is not an invoice. Credits, discounts and billing adjustments never show up here, so check the provider console for what was actually billed.

- **`api` token source:** an estimate of metered spend.
- **`claude-cli` token source:** modeled cost for tokens that were billed to a subscription, not metered. It answers "what would this have cost on the API", not "what did this cost".
- **Pricing model:** each call is priced on the model the provider reports serving when that model has a rate, and on the requested model otherwise. Cache writes and reads are priced on their own rates. Haiku 5.5 prompts over 100,000 tokens, cache traffic included, use its long-prompt rates.

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
├── tokenSource.ts     api / claude-cli adapters (#389)
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
