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

### Per-flow records (`--record`)

The sweep table prints one aggregate row per variant, and `runForFixture` returns only summed cost and end-to-end latency, so a decision rule that needs per-sample values, retries, truncations, refusals, per-step latency or cost, or the extracted Units cannot be computed from a run's output. `--record <dir>` keeps all of it, on the ordinary path and on the `--variant` sweep path alike:

```bash
npm run eval -- --full --samples 6 --no-cache --record ~/.matchline/eval-records/2026-10-28-extraction \
  --variant 'sonnet:model.extraction=claude-sonnet-4-6' \
  --variant 'haiku55:model.extraction=claude-haiku-5-5'
```

- The directory must resolve outside this repository (symlinks resolved): outside the checkout the command runs from (the check the fit-brief harness uses), and outside the main checkout and every worktree of the same repository, which `git rev-parse --git-common-dir` and `git worktree list` report. If either git command fails, the directory is refused. It must also not already hold a record: one directory is one invocation. Both are checked before any spend. The fixtures are public, so the records are safe to keep; the refusal keeps run output out of commits.
- `invocation.json`: invocation id, HEAD sha and whether the tree was dirty, argv, token source, cache mode, samples, mode, `--prompt` overrides, the arms (each variant's requested models, efforts and prompt versions, and after the run the configuration each actually resolved to; a plain run is one arm labelled `default` with its stage configuration), and started/finished timestamps.
- `flows.jsonl`: one JSON line per flow with `schemaVersion` and `invocationId`; `variant`, the variant label (`default` outside a sweep); `tokenSource`, the token source the flow ran under (the variant's own when it sets one, else the command's, so the effort recorded as sent matches that source: CLI sources send none); `stages`, per LLM stage the provider, the requested model, the effort requested and the effort sent, the prompt version and prompt fingerprint; `embeddingModel`; `resumeId`, `jdId` and the `cell` id they form (`<resumeId>__<jdId>`); `sampleIndex` within (variant, cell); `startedAt`/`finishedAt` and `latencyMs`; `ok`, and on failure `error` with its kind, name, message and failing step (an LLM step, `matching` or `scoring`; null when the throw came between steps); `extractionAccuracy` and `matchAccuracy` (null on a failed flow, where the result reports 0); `extractedUnitCount`, `parsedRequirementCount` and `parsedMustHaveCount` (from the saved objects, so known even when a later stage failed) and `matchCount`; `cacheHits`/`cacheMisses` and `stepCacheHits` (which steps the stage cache served); `calls`, every usage record of the flow with all its fields, including the served model when the provider reports one, its step (`extraction`, `unit_embedding`, `requirement_parsing`, `requirement_embedding`), whether it was replayed from the stage cache, and the derived flags below; `failures`, the failing stage's `failures` array; `units` and `requirements`, the extracted Units and parsed Requirements as the stages returned them; `costUsd` and `modeledCostUsd`.
- Files appear with the first recorded flow, so a run refused before any flow runs leaves nothing behind: a `--variant` sweep whose projection guard blocks it (the sweep checks the guard before it starts), or a sweep with nothing runnable. The ordinary (non-sweep) path checks its projection guard only after the corpus has run, so a run refused there has already recorded its flows, and the directory keeps them. The location is printed to stderr; stdout keeps the report.
- `invocation.json` is rewritten after every recorded flow (to a temp file renamed over it, so a kill mid-write cannot truncate it), so its `flowCount` matches `flows.jsonl` even when the run is interrupted (SIGINT, a kill) or aborts. `finishedAt` stays null until the run finishes, when it is stamped in a `finally`; a null `finishedAt` therefore marks a run that never finished.
- A failed write to the record directory never aborts a run: by then the flow is paid for. The error goes to stderr, recording stops for the rest of the run, the run and its report carry on, and `invocation.json` gets a `recordingError` with the flows recorded before the failure.

Use `--no-cache` (or `--samples` above 1, which bypasses the cache) when the records are meant to measure variance: a cache hit replays the stored output and its original usage, and the record marks those calls `replayed: true` and the step in `stepCacheHits`. `eval:analyze` drops the task metrics of a replay that repeats a counted sample, and the match accuracy of a flow that replayed both extraction and requirement parsing with a counted flow's outputs (see below), so several cached `--samples 1` invocations pooled under one label do not shrink the spread to zero.

#### Derived per-call fields

The pipeline does not expose a stop reason per call (extraction and JD parsing record usage before inspecting `stop_reason`, and `UsageRecord` has no field for it), and this harness does not change `functions/src`. Each recorded call therefore carries flags derived from what is recorded:

- `truncated`: `maxTokens` is set and `outputTokens >= maxTokens`, or the stage's thrown `failures` list a `max_tokens_exceeded` at that attempt.
- `retry`: `attempt > 0`. A transport error records no usage but advances `attempt`, so the call after it counts as a retry.
- `refusal`: the failing stage's `failures` list a `refusal` at that attempt. A stage throws `failures` only when it gives up, so a recovered failure (for example a truncated attempt followed by a good one) is visible through `truncated`/`retry`, not through `failures`.
- There is no reasoning-token field: Anthropic counts thinking inside `outputTokens`.

### Comparing arms (`eval:analyze`)

```bash
npm run eval:analyze -- --records ~/.matchline/eval-records/run-a ~/.matchline/eval-records/run-b \
  --task extraction --incumbent sonnet [--candidates haiku55,opus55] [--out <dir>] [--seed N]
```

Reads `flows.jsonl` from each records directory (a `.jsonl` path works too), pools flows by variant label across invocations, scores the saved Units or Requirements against the public labels under `tests/fixtures/`, prints Markdown, and writes the full result as `analysis-<task>.json` to `--out` (default: the first records directory; refused inside the repository, its main checkout or any of its worktrees, by the same check as `--record`). It makes no model call. `--candidates` defaults to every other label in the records. Output is deterministic for a given seed (default 20261028).

Per arm: flows, failed flows, how many of those failed in the task's own step (`extraction` or `requirement_parsing`), refusals (failed flows whose error kind is `refusal`) and other error kinds; flows whose task stage returned an output, how many of those replayed it from the stage cache, how many replays were left out as repeats, and how many full replays had their match accuracy left out; retry share (live records with `attempt > 0` / live records); truncations; per-cell mean, SD and min–max of every metric over the flows the rules below admit; an aggregate that is the mean of cell means, so every cell weighs the same; per-step latency p50 (nearest rank) and max from per-call `latencyMs`; modeled cost per flow by step at list price (`priceUsage`), with a count of records no rate could price. Replayed (cache-hit) records are left out of the retry, truncation and latency figures, because they repeat a call measured in an earlier run; they stay in the modeled cost, which prices what the flow would cost uncached.

Metrics:

- Which flows count. Task metrics (everything except match accuracy) count every flow whose task stage returned: `units !== null` for `--task extraction`, `requirements !== null` for `--task jd`. A flow whose extraction succeeded and whose embedding or matching then failed still contributes its Units, so an outage in a stage the comparison does not vary cannot reshape an extraction comparison's per-cell n. Match accuracy counts successful (`ok`) flows only, since a failed flow has none. Failed-flow and refusal counts still cover every stage, and the "in task step" count separates the task's own failures from downstream ones.
- Replays. A flow whose task step was served from the stage cache (`stepCacheHits.extraction` or `stepCacheHits.requirement_parsing`) and whose saved output equals that of a live flow, or of an earlier counted replay, in the same arm and cell is not an independent sample: its task metrics are left out and the report warns with the count. A replay whose output no counted flow has keeps its values. Match accuracy follows a narrower rule, because matching depends on both sides: it is left out only when the flow replayed both `extraction` and `requirement_parsing` and its (Units, Requirements) pair equals that of a counted flow (live, or an earlier counted replay) in the same arm and cell, since matching then ran on identical inputs and the value is a copy. A live parse of either side yields a new match sample, so a flow that replayed only one stage keeps its match accuracy. These flows are counted separately ("repeated match replays dropped") and get their own warning.
- "Mapped" pairs. Unit precision, must-have agreement and requirement precision use a threshold-first one-to-one assignment, the rule mapping.ts `mapUnitIds`/`mapRequirementIds` use: every (expected, extracted) pair at or above the threshold, taken in descending score order (ties: lower expected index, then lower extracted index), each side used once. So an expected item that scores below the threshold cannot take an item a later expected item maps above it. The pair score is the metric's own (the `unitSetAccuracy` score for Units; the overlap coefficient below for requirements), not mapping.ts's Jaccard, and the thresholds are 0.5 and 0.3. Extraction accuracy and requirement-set accuracy keep the expected-order greedy assignment (the `unitSetAccuracy` shape).
- `--task extraction`: extraction accuracy (`unitSetAccuracy` against `tests/fixtures/expected-units`, recomputed from the saved Units); Unit precision (share of extracted Units mapped to an expected Unit at score ≥ 0.5); extracted-Unit count; mean summary length in whitespace-delimited words; grounding share (share of Units whose `raw_text`, normalized as the fit-brief evidence gate normalizes, appears at word boundaries within one line of the résumé fixture); match accuracy as reported.
- `--task jd`: requirement-set accuracy (for each `expected_requirements` entry in label order, the best unused parsed requirement by `tokenOverlapCoefficient(tokenize(text), tokenize(normalized_requirement))`, averaged; the `unitSetAccuracy` shape); must-have agreement on pairs mapped at ≥ 0.3; requirement precision (share of parsed requirements mapped at ≥ 0.3), both with "mapped" as above; parsed-requirement and must-have counts; match accuracy as reported.

Versus the incumbent, per metric: the difference of means (mean over the cells both arms hold of candidate minus incumbent cell means); a 95% percentile CI from a stratified bootstrap (10,000 resamples, each arm resampled with replacement within each cell, seeded; blank when any common cell has fewer than two values in either arm, since a single value is redrawn unchanged every resample and would narrow the interval, so the CI and the p-value below are blank together); a two-sided stratified Welch t p-value on the same equal-cell-weight difference (`D = (1/C)·Σ_c (m_cand,c − m_inc,c)`, `se² = (1/C²)·Σ_c (s²_cand,c/n_cand,c + s²_inc,c/n_inc,c)`, Welch–Satterthwaite df over the 2C variance components; blank when any common cell has fewer than two values in either arm), so the p-value and the CI test the printed difference rather than a pooled, cell-mix-dependent one; per-cell differences and the number of cells where the candidate is ahead. Guard `ran-cell-no-values`: when a cell both arms ran (any flow) has values for a metric in one arm only (for example every candidate flow in it refused), the difference, CI and p-value for that metric print as unavailable (—) instead of being computed on the remaining cells, which would favour the arm that produced nothing in a hard cell; the row's "failed guards" column names the guard and the cell, and a warning says which arm has no values. A cell with no values in either arm is left out with a warning but fails no guard, since that treats both arms alike.

Power check, for the incumbent: s is the pooled within-cell SD (`sqrt(Σ(n_c−1)s_c² / Σ(n_c−1))`). The half-width at n = 6 samples per cell is `1.96·s/√(2n)`; the report also shows the C-cell form `1.96·s·√(2/(C·n))`, the half-width of an equal-cell-weight difference over C cells, which equals the first at C = 4 (today's labeled corpus). For share metrics it gives the n per cell needed for a ±2.5-point half-width from both forms.

### Fit-brief eval — private corpus (#495 Phase 3)

`npm run eval:fit-brief` generates a fit brief for each job description in a **private** corpus and scores it against the brief the owner wrote and approved for that role. The corpus is the owner's real job search, and this repository is public, so the harness enforces three rules:

- The corpus is read only from the directory named by `MATCHLINE_PRIVATE_CORPUS`, and the harness refuses to start if that directory resolves inside this repository, symlinks included.
- Every generated brief, judgement and per-pair score is written to `--out` (default `~/.matchline/eval-private/fit-brief/<run-id>`), which must also be outside the repository and empty, so one run's artifacts are never mixed with another's. Each artifact records the run configuration, including the generator prompt version and a fingerprint of the judge request.
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

- **Evidence gate (deterministic).** Every evidence quote must appear within a single bullet, heading or line of the résumé or inventory, so adjacent claims cannot be stitched into one quote. Formatting and case are ignored; wording is not. Dates are never certified by this gate: in units mode the generator receives the Units as JSON, one object per Unit in extraction order with the extracted dates in their own field, so no date sits on quotable text, and any date a brief asserts is checked by the claim gate against the canonical résumé.
- **Claim gate (model-graded).** The judge (default `claude-opus-5-5`, effort `high`) lists statements about the candidate that the sources don't support, and claim-rule violations. A brief passes the gates only with none of these and no unsupported evidence.
- **Coverage (model-graded).** Recall: the reference's strengths and exposures that the brief covers, with half credit for partial coverage. Precision: the brief's points that match the reference.
- **Verdict agreement** with the reference.

The printed aggregate names every failure with one of a closed set of categories, each shown as briefs failing (failing items): `evidence-quote` (a quote found in neither the résumé nor the inventory, nor in units mode any Unit), `extraction-paraphrase` (units mode only: a quote that matches a Unit's `raw_text` under the gate's normalization but not the résumé or inventory, so the brief quoted the extraction's paraphrase), `unsupported-claim` and `claim-rule` (the judge's two lists), and `unscored` (generation or judging failed). Both evidence classes fail the gate; the split only says where the quote came from. Each brief's artifact carries the classified quotes (`evidence.extractionParaphrase`, `evidence.unsupportedQuote`), their counts and `failureCategories`, and an unscored brief's artifact records `failureCategories: ["unscored"]`. `gates passed` divides by every brief, so an unscored brief counts as a gate failure.

`--evidence units` feeds the generator Experience Units extracted from the résumé by the current extraction pin, instead of the résumé itself. Each Unit contributes its verbatim text and its date range; other structured fields are left out. The inventory reaches the generator in both modes, so the comparison changes only how the résumé is represented. Both gates still ground on the canonical résumé and inventory, never on the extracted Units, so an extraction error cannot certify a claim. The mode tests whether Units are sufficient evidence for a brief. Extraction is stochastic, so each units-mode run saves the Units it used as `units.json` in its output directory. Pass that file to later runs with `--units-from <path>` to compare generators on identical evidence; the report and artifacts record the extraction pin that made the Units, whether they were extracted or reused, and a hash of the evidence the generator read.

`--max-usd` is required for a paid run. Every paid request checks the bound first, including retries inside generation, judging and extraction. A run that reaches the bound stops and reports itself as incomplete; a request already in flight still completes, and the report states any overrun. Errors that could quote the corpus (pair ids, manifest paths) are withheld from the terminal unless `FIT_BRIEF_VERBOSE=1` is set.

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
├── flowTrace.ts       pure: per-flow trace collector (--record)
├── flowRecord.ts      pure: flow/invocation record shapes, derived flags, JSONL parser
├── recorder.ts        --record: writes invocation.json + flows.jsonl
├── analyze.ts         eval:analyze CLI
├── analysis/          pure: metrics, statistics, arm comparison for eval:analyze
├── fitBrief/          private-corpus fit-brief eval (#495)
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
