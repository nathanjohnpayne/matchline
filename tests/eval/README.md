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
(`generation`, `claim_extraction`, `traceability`, `specificity`,
`rationale`; the old single `validation` stage was split by #489, so
`model.validation` is now an unknown stage), an OpenAI model (see #402),
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

The pipeline does not expose a stop reason per call (extraction and JD parsing record usage before inspecting `stop_reason`, and `UsageRecord` has no field for it), and the harness adds no stop-reason field to `functions/src`. #656 changed two things there: `parsing/jd.ts` picks its schema by prompt version, and it gained an optional per-attempt failure hook (`onAttemptFailure`) that only the harness passes. Nothing else in the call path changed, and production's request is the same. Each recorded call therefore carries flags derived from what is recorded:

- `truncated`: `maxTokens` is set and `outputTokens >= maxTokens`, or the stage's thrown `failures` list a `max_tokens_exceeded` at that attempt.
- `retry`: `attempt > 0`. A transport error records no usage but advances `attempt`, so the call after it counts as a retry.
- `refusal`: the failing stage's `failures` list a `refusal` at that attempt. A stage throws `failures` only when it gives up, so a recovered failure (for example a truncated attempt followed by a good one) is visible through `truncated`/`retry`, not through `failures`.
- `failureKind` and `issues` (JD parsing only, #656): set on a live `requirement_parsing` call whose attempt failed, whether or not a later attempt recovered. `failureKind` is the attempt's failure kind (`schema_error`, `no_tool_use`, `max_tokens_exceeded`, `refusal`). `issues` lists each Zod issue's `code` and `path`, with no message, expected value or model output. They come from the stage's `onAttemptFailure` hook, which runs for every failed attempt, so recovered schema failures are classifiable without a thrown `failures` array. A transport error records no call, so it is tagged nowhere; it still shows as the gap in the attempt sequence. A call replayed from the stage cache is never tagged, because a replay runs no attempt. Records written before #656 have neither field.
- There is no reasoning-token field: Anthropic counts thinking inside `outputTokens`.

### Comparing arms (`eval:analyze`)

```bash
npm run eval:analyze -- --records ~/.matchline/eval-records/run-a ~/.matchline/eval-records/run-b \
  --task extraction --incumbent sonnet [--candidates haiku55,opus55] [--out <dir>] [--seed N]
```

Reads `flows.jsonl` from each records directory (a `.jsonl` path works too), pools flows by variant label across invocations, scores the saved Units or Requirements against the public labels under `tests/fixtures/`, prints Markdown, and writes the full result as `analysis-<task>.json` to `--out` (default: the first records directory; refused inside the repository, its main checkout or any of its worktrees, by the same check as `--record`). It makes no model call. Each invocation's records may be passed once: a flow identity (`invocationId`, variant, cell, `sampleIndex`) that appears more than once across `--records` (the same directory twice, a directory plus its own `flows.jsonl`, a copied file) is refused, because the replay filter cannot see it and one observation counted twice narrows every interval. `--candidates` defaults to every other label in the records. Output is deterministic for a given seed (default 20261028).

Per arm: flows, failed flows, how many of those failed in the task's own step (`extraction` or `requirement_parsing`), refusals (failed flows whose error kind is `refusal`) and other error kinds; flows whose task stage returned an output, how many of those replayed it from the stage cache, how many replays were left out as repeats, and how many full replays had their match accuracy left out; retry share (live records with `attempt > 0` / live records); truncations; per-cell mean, SD and min–max of every metric over the flows the rules below admit; an aggregate that is the mean of cell means, so every cell weighs the same; per-step latency p50 (nearest rank) and max from per-call `latencyMs`; modeled cost per flow by step at list price (`priceUsage`), with a count of records no rate could price. Replayed (cache-hit) records are left out of the retry, truncation and latency figures, because they repeat a call measured in an earlier run; they stay in the modeled cost, which prices what the flow would cost uncached.

Metrics:

- Which flows count. Task metrics (everything except match accuracy) count every flow whose task stage returned: `units !== null` for `--task extraction`, `requirements !== null` for `--task jd`. A flow whose extraction succeeded and whose embedding or matching then failed still contributes its Units, so an outage in a stage the comparison does not vary cannot reshape an extraction comparison's per-cell n. Match accuracy counts successful (`ok`) flows only, since a failed flow has none. Failed-flow and refusal counts still cover every stage, and the "in task step" count separates the task's own failures from downstream ones.
- Replays. A flow whose task step was served from the stage cache (`stepCacheHits.extraction` or `stepCacheHits.requirement_parsing`) and whose saved output equals that of a live flow, or of an earlier counted replay, in the same arm and cell is not an independent sample: its task metrics are left out and the report warns with the count. A replay whose output no counted flow has keeps its values. Match accuracy follows a narrower rule, because matching depends on both sides: it is left out only when the flow replayed both `extraction` and `requirement_parsing` and its (Units, Requirements) pair equals that of a counted flow (live, or an earlier counted replay) in the same arm and cell, since matching then ran on identical inputs and the value is a copy. A live parse of either side yields a new match sample, so a flow that replayed only one stage keeps its match accuracy. These flows are counted separately ("repeated match replays dropped") and get their own warning.
- "Mapped" pairs. Unit precision, must-have agreement and requirement precision use a threshold-first one-to-one assignment, the rule mapping.ts `mapUnitIds`/`mapRequirementIds` use: every (expected, extracted) pair at or above the threshold, taken in descending score order (ties: lower expected index, then lower extracted index), each side used once. So an expected item that scores below the threshold cannot take an item a later expected item maps above it. The pair score is the metric's own (the `unitSetAccuracy` score for Units; the overlap coefficient below for requirements), not mapping.ts's Jaccard, and the thresholds are 0.5 and 0.3. Extraction accuracy and requirement-set accuracy keep the expected-order greedy assignment (the `unitSetAccuracy` shape).
- `--task extraction`: extraction accuracy (`unitSetAccuracy` against `tests/fixtures/expected-units`, recomputed from the saved Units); Unit precision (share of extracted Units mapped to an expected Unit at score ≥ 0.5); extracted-Unit count; mean summary length in whitespace-delimited words; grounding share (share of Units whose `raw_text`, normalized as the fit-brief evidence gate normalizes, appears at word boundaries within one line of the résumé fixture); match accuracy as reported.
- `--task jd`: requirement-set accuracy (for each `expected_requirements` entry in label order, the best unused parsed requirement by `tokenOverlapCoefficient(tokenize(text), tokenize(normalized_requirement))`, averaged; the `unitSetAccuracy` shape); must-have agreement on pairs mapped at ≥ 0.3; requirement precision (share of parsed requirements mapped at ≥ 0.3), both with "mapped" as above; parsed-requirement and must-have counts; match accuracy as reported.

Versus the incumbent, per metric: the difference of means (mean over the cells both arms hold of candidate minus incumbent cell means); a 95% percentile CI from a stratified bootstrap (10,000 resamples, each arm resampled with replacement within each cell, seeded; blank when any common cell has fewer than two values in either arm, since a single value is redrawn unchanged every resample and would narrow the interval, so the CI and the p-value below are blank together); a two-sided stratified Welch t p-value on the same equal-cell-weight difference (`D = (1/C)·Σ_c (m_cand,c − m_inc,c)`, `se² = (1/C²)·Σ_c (s²_cand,c/n_cand,c + s²_inc,c/n_inc,c)`, Welch–Satterthwaite df over the 2C variance components; blank when any common cell has fewer than two values in either arm), so the p-value and the CI test the printed difference rather than a pooled, cell-mix-dependent one; per-cell differences and the number of cells where the candidate is ahead. Guard `ran-cell-no-values`: when a cell both arms ran (any flow) has values for a metric in one arm only (for example every candidate flow in it refused), the difference, CI and p-value for that metric print as unavailable (—) instead of being computed on the remaining cells, which would favour the arm that produced nothing in a hard cell; the row's "failed guards" column names the guard and the cell, and a warning says which arm has no values. A cell with no values in either arm is left out with a warning but fails no guard, since that treats both arms alike.

Power check, for the incumbent: s is the pooled within-cell SD (`sqrt(Σ(n_c−1)s_c² / Σ(n_c−1))`). The half-width at n = 6 samples per cell is `1.96·s/√(2n)`; the report also shows the C-cell form `1.96·s·√(2/(C·n))`, the half-width of an equal-cell-weight difference over C cells, which equals the first at C = 4 (today's labeled corpus). For share metrics it gives the n per cell needed for a ±2.5-point half-width from both forms.

### JD parsing prompt v2 (`parsing/jd=v2`, #656)

`functions/src/prompts/parsing/jd.v2.md` is an eval-only revision of the JD parsing prompt. Production keeps `jd.v1.md` (`PROMPT_CONFIG.parsing.jd` is `v1`, and `jd.v1.*` is unchanged). Labels and scorers are unchanged.

**Why.** In round 2b of #495, `claude-haiku-5-5` at effort medium beat the incumbent on requirement-set accuracy (+6.7 points) at about a fifth of the parsing cost. It failed two checks: rule 1, because 7 of 23 first attempts failed schema validation (6 of those 7 also failed the second attempt, so 13 retry calls in all, and every flow recovered on the third), and the precision guard (−5.3 points), with more parsed Requirements and fewer must-haves per JD. All 13 failed attempts are `schema_error`. Tool choice is forced, nothing was truncated or refused, and the attempt sequence has no transport gap. The failures cluster on one JD: one of the four public cells failed 6 of 6 first attempts, a second cell 1 of 6, and the other two none. Their Zod paths and codes were not recorded. Before #656 a flow kept `failures[].zodIssues` only when its stage threw, and every one of these flows recovered. Recovered attempts now record their codes and paths (`failureKind` and `issues` in "Derived per-call fields"), but the 2b records cannot be read again for them. The recovery pattern is indirect evidence, though. One of 7 attempts recovered after the generic reminder, and all 6 recovered after the reminder that names field types and enum values. That points to an out-of-enum value or a wrong field type, not to unknown or missing keys.

**What v2 changes.** Only the System text. The few-shot and the response schema are v1's: `jd.v2.schema.ts` re-exports the v1 shapes. The System gains:

- an explicit statement that `category` is one of exactly seven strings, with a home for a degree (`credential`) and for a practical condition such as travel (`skill`);
- a must-have definition line for items under a plain qualifications header;
- the six `seniority_level` values, with an instruction to leave the field out rather than send `null` or `""`;
- a field-type rule covering every key;
- a granularity rule: one Unit per stated ask, usually one per bullet; a bullet whose two sentences each state their own ask gives one Unit per sentence, and an ask is never split because it lists several examples or tools;
- a note that the few-shot is abbreviated and omits one responsibility bullet, so the example is not read as permission to skip an ask.

**How it is selected.** Use a variant clause `prompt.parsing/jd=v2` or a command-wide `--prompt parsing/jd=v2`. `parseJobRequirements` builds its tool schema from the schema of the version it loaded, and validates against that same schema (`functions/src/parsing/jdResponseSchema.ts`). An unregistered version throws before any request. The corpus scope lists the dispatched versions (`dispatchedSchemaVersions`), so the schema pre-flight accepts v2 and refuses any unregistered `parsing/jd` version before a token is spent, even one whose schema file is byte-identical to v1's or absent, because the stage would throw on it.

**What the records show.** Every v2 call records `promptVersion: "parsing/jd.v2"`. Each flow's `stages.requirement_parsing` records `promptVersion: "v2"` and a `promptFingerprint` of the form `v2:<hash>`. `invocation.json` records the requested and resolved prompt versions for each arm. The stage-cache key includes the fingerprint, so a v2 run never reads or overwrites a v1 entry, and v1 and v2 runs are never comparable by accident. `STAGE_IMPL_VERSION` does not move, because v1's request is byte-for-byte unchanged.

**Re-run plan (not run; project it on #495 and get owner approval first).** Haiku 5.5 at effort medium, over the four labelled public cells × 6 samples. As in 2b, that is two invocations of `--samples 3`. Each invocation runs two arms on the same HEAD: v2, and v1 as a same-HEAD control. The v1 arm is what lets the run classify v1's failures by schema path and Zod code, which the 2b records cannot do. The ticket estimates about $4 for the v2 arm alone, so both arms come to about $8. The projection guard prints the exact figure before the run starts. If only the v2 arm is approved, v1's failure classification stays open and the report must say so.

```bash
npm run eval -- --full --samples 3 --token-source api --record ~/.matchline/eval-records/<date>-jd-haiku55-med-v1v2-1 \
  --variant 'jd-haiku55-med-v1:model.requirement_parsing=claude-haiku-5-5,effort.requirement_parsing=medium,prompt.parsing/jd=v1' \
  --variant 'jd-haiku55-med-v2:model.requirement_parsing=claude-haiku-5-5,effort.requirement_parsing=medium,prompt.parsing/jd=v2'
# ...then the same command again with a -2 record directory.

npm run eval:analyze -- --task jd \
  --records <2b incumbent record dirs> ~/.matchline/eval-records/<date>-jd-haiku55-med-v1v2-1 ~/.matchline/eval-records/<date>-jd-haiku55-med-v1v2-2 \
  --incumbent <2b incumbent label> --candidates jd-haiku55-med-v1,jd-haiku55-med-v2

# Failure classification: one line per (prompt version, attempt, kind, Zod code, path),
# with array indexes folded to `*`, counted. Metadata only; no text field is read.
jq -r '.stages.requirement_parsing.promptVersion as $v
  | .calls[] | select(.step == "requirement_parsing" and .failureKind != null)
  | . as $c | ((.issues // [{code: "-", path: []}])[])
  | [$v, "attempt \($c.attempt)", $c.failureKind, .code, (.path | map(if type == "number" then "*" else . end) | join("."))]
  | @tsv' ~/.matchline/eval-records/<date>-jd-haiku55-med-v1v2-{1,2}/flows.jsonl | sort | uniq -c
```

Report these together:

- rule 1: first-attempt schema failures at most 5%, which is at most 1 of 24;
- the failure classification for each arm: failed attempts by Zod code and path, and the share of failed attempts that carry issue detail (the ticket asks for at least 90%);
- the precision guard (5 points);
- requirement-set accuracy;
- the parsed-requirement count and the must-have count.

A prompt that makes Haiku 5.5 parse more coarsely can give back the +6.7. The incumbent records come from the 2b frozen baseline (`2b9debf`). The HEAD difference is a caveat to state in the report, not a reason to refuse the comparison. The guidance was written against the four public cells and may overfit them. Its wording is general, and the few-shot is unchanged. The v2 rules target the failure class inferred from the 2b recovery pattern, not a measured one. The v1 arm's classification is what confirms or refutes that inference.

### Fixed-input matching runner (`eval:fixed-inputs`, #648)

**Match-accuracy numbers from this runner are diagnostic until the labels and the owner corrections are reviewed (#636).** Use them to choose bounded fixes, not as measured quality.

The runner holds the matcher's inputs fixed so that representation loss (a labelled Unit or Requirement never reaches the matcher) can be told apart from ranking loss (both reach it and the pair ranks too low). It makes no LLM call: it re-runs matching on Units and Requirements a `--record` run already saved.

```bash
npm run eval:fixed-inputs -- --records ~/.matchline/eval-records/2a-inc-ext-1 ~/.matchline/eval-records/2a-sonnet55-high-1 \
  --units gold --requirements gold --scorer current,renormalized,cosine \
  [--k 24] [--embeddings-cache ~/.matchline/eval-embeddings/embeddings.jsonl] \
  [--out ~/.matchline/eval-analysis/fixed-inputs-<date>] [--max-usd 0.10] [--dry-run]
```

- **Conditions.** `--units` and `--requirements` each name the alternative to the recorded side: `record` (the default), `gold`, or an owner-corrected file. For every flow the runner evaluates {record, `--units`} × {record, `--requirements`}, collapsing the duplicates when an alternative is `record`. So `--units gold --requirements gold` gives four conditions, `record/record`, `gold/record`, `record/gold` and `gold/gold` (Units side first).
- **Gold inputs** are the labels used as inputs. A gold Unit is an `expected_units` entry: its id, `normalized_summary` (also used as `raw_text`), skills, tools and domains, with confidence 1 and no date range, seniority or scope signals, outcomes or metrics. A gold Requirement is an `expected_requirements` entry: its id, text (as `raw_text` and `normalized_requirement`), category and must-have flag (priority `high` for a must-have, else `medium`). **Gold Requirements carry no structure**: no keywords, tools, domains or seniority level, so every structural axis of the scorer is unsignalled on them (applicability false). Under the current scorer the unconstrained axes still pay their fixed defaults: 0.5 for skills, tools and domains, 1.0 for seniority, and 1.0 for scope, except 0.5 on a scope-category gold Requirement (`scopeAlignment` falls through to `jaccard` for that category). The renormalized and cosine scorers ignore unsignalled axes. Gold sides map to label ids by identity; record and corrected sides map with `mapUnitIds` / `mapRequirementIds` at the 0.10 floor, as `runForFixture` does.
- **Matching.** Each condition runs the production `runMatchingPipeline` unchanged, with in-memory `listUnits` / `listRequirements` / `persistBatch` and `asOf` pinned to the flow's `finishedAt`, so recency does not drift with the calendar.
- **Scorers** (`--scorer`, a comma list; default `current`). `current` is production `score()`. `renormalized` (#433/#601) and `cosine` are **experimental scorers** that live in `tests/eval/fixedInputs/scorers.ts`, are injected through `MatchingDeps.score`, and do not touch `functions/src`. `renormalized` keeps only the axes the pair's `component_applicability` marks applicable and renormalizes the PRD weights over them (0 with none); `cosine` ranks on `confidence × semantic_similarity`. Both keep `score()`'s components, so the rationale generator still runs on real values.
- **Metric.** Without `--k`, match accuracy exactly as the eval computes it: `topKOverlap` over the label's `expected_top_matches` and k. With `--k N`, recall@N: labelled pairs in the top N over the number of unique labelled pairs, not capped at the label's k.
- **Output.** A Markdown report on stdout: the plan; a table of condition × scorer per arm (variant label), with the equal-cell-weight mean (mean of cell means, the `eval:analyze` convention); the same per cell; and the decomposition of labelled pairs, each of which is found (in the window) or missed for one reason: **A** Unit missing (no input Unit mapped to its Unit label; A∧B also lacks the Requirement), **B** Requirement missing (Unit mapped, Requirement label not), **C** ranking (both mapped, ranked below the window, with the median rank). found + A + B + C = the labelled pairs. FP counts window entries that are not labelled pairs, and how many have an unmapped side. Without `--k`, a last table compares `record/record` under the current scorer with the match accuracy and match count each flow recorded; a mismatch there comes from embedding jitter (the API returns slightly different vectors for one text in different batches, which can flip a pair at the window boundary). Each mismatched flow is listed below that table (arm, cell, sample index, recorded and rerun accuracy, the difference, and both match counts) and named in a stderr warning; a mismatch does not change the exit code, which stays 0. The plan also prints the worktree HEAD (`git rev-parse HEAD`). `--out <dir>` also writes `fixed-inputs.json` (every flow × condition × scorer with its decomposition, the plan, the spend, the HEAD, the manifest pin, the corrections and the reproduction mismatches) and `report.md`. The directory is refused inside the repository (the `--record` check) and when it already holds either file.
- **Skipped flows.** Flows that saved no Units or no Requirements (an upstream stage failed) and flows whose cell has no labels under `tests/fixtures/` are skipped and counted in the plan. So are repeated cache replays, by the `eval:analyze` rule: a flow that replayed both extraction and requirement parsing from the stage cache (`stepCacheHits`) and whose (Units, Requirements) pair equals a counted flow's in the same arm and cell. Matching would run on identical inputs, so counting it again would weight that sample twice. A flow that parsed either side live is always counted.
- **Not reproduced.** The diagnostic's fifth condition (gold Requirement text on parsed structure) and its strict 0.5/0.3 mapping view are not part of this runner.

#### Embeddings, cache and spend

The only paid call is embedding texts the cache does not hold (`text-embedding-3-small`, through the production `embedMany`).

- The cache is an append-only JSONL file, by default `~/.matchline/eval-embeddings/embeddings.jsonl` (`--embeddings-cache` overrides it; a path inside the repository is refused). Each line is `{"v":1,"model":...,"sha256":<hex of the UTF-8 text>,"dims":...,"vector":[...]}`: keyed by model and text hash, with no text stored. The same text across flows, arms and runs is embedded once, so a repeated run spends nothing and a changed correction re-embeds only what changed. On a duplicate key the first line wins. A file whose last line has no trailing newline (a hand-seeded cache, say) loads, and the first append to it writes the missing newline first, so the new entries never join that line.
- The run prices the uncached texts before any request and refuses, without building a client, when the price exceeds `--max-usd` (default $0.10). **The guard uses the byte-length bound**: each text's UTF-8 byte length as its token count, at the `rates.ts` price. `text-embedding-3-small` tokenizes with a byte-level BPE (cl100k_base), in which every token covers at least one byte, so this is a strict upper bound on the tokens billed, including for CJK, emoji and digit runs. The plan also shows the characters / 4 × 1.35 estimate, which is closer to the bill for English prose but can undercount those texts, so it is displayed only. While embedding, the run checks the bound again before each request of up to 256 texts and appends each request's vectors as soon as they return, so an interrupted run keeps what it paid for. Usage is priced locally and never written to Firestore. A request whose served usage cannot be priced (no rate card for the model string) is never counted as free: it is charged at the larger of its served tokens at the embedding rate and the request's byte-length bound, with a warning on stderr, so the running total the guard checks never falls below the bound it checked.
- `--dry-run` prints the plan (flows, conditions, scorers, distinct, cached and uncached texts, estimated and bounded tokens and USD, the cache path, the worktree HEAD, the corrections and their manifest status) and exits 0 without constructing a client.
- With uncached texts and no `OPENAI_API_KEY` the run refuses (exit 1). A fully cached run needs no key at all.

Exit codes: 0 done (or a dry run), including a run whose `record/record` rerun does not reproduce some recorded flows (listed in the report and warned about on stderr) and a corrections run whose manifest is not committed (marked and warned about); 1 refused (the byte-length bound over `--max-usd`, no key for uncached texts, or a corrections file the manifest does not list); 2 usage error, an in-repo path, or a crash.

#### Owner-corrected inputs

`--units <file.json>` and `--requirements <file.json>` take an owner-filled calibration scaffold (`corrections/<cell>.json`: one flow's saved Units and Requirements with `owner_verdict` and the corrected fields). The flags may repeat, one file per cell; one file can serve both sides.

- **Named by hash.** A file is accepted only when the sha256 of its bytes is listed in the frozen manifest `tests/eval/fixedInputs/corrections-manifest.json` (`{"version":1,"entries":[{"sha256","name","cell"}]}`), with the cell the file is for. The manifest ships empty: each corrected set is added in a reviewed commit, and a listed file is never edited (an edit is a new set with a new hash). An unlisted file is refused with its computed hash. The run prints each set's name and hash. The file is read once, so the bytes hashed are the bytes parsed. The manifest itself is read from disk, so an entry not yet committed is accepted (the owner may be iterating); the run records the worktree HEAD and whether `corrections-manifest.json` differs from it (`git diff --quiet HEAD -- <manifest>`) in the report and `fixed-inputs.json`, and when it does it warns on stderr and marks the plan and each corrected set "manifest not committed". It does not refuse. When git cannot answer, the status is "commit status unknown", with a warning.
- **Verdicts.** Units take `keep`, `fix`, `drop` or `add`; Requirements take `keep`, `fix` or `drop`. Every item on a side in use needs a non-null verdict, and every saved item of the source flow must be listed. `keep` must equal the saved item. A Unit `fix` takes `owner_corrected_raw_text`, when set, as `raw_text` plus any in-place edits (`normalized_summary`, which is what the matcher embeds, and `skills`); a fix that changes only `normalized_summary` or `skills` may leave `owner_corrected_raw_text` null. A Requirement `fix` takes `owner_corrected_text` as `normalized_requirement` and `owner_must_have` as `must_have`, plus in-place edits. A `fix` must change something. Every scoring field of a fixed item is validated, since the matcher catches a scoring exception and omits the pair, which the decomposition would then count as ranking loss (C): a fixed Unit's string lists (`skills`, `tools`, `domains`, `seniority_signals`, `scope_signals`, `business_outcomes`), `metrics`, `confidence_score` and `date_range` take the checks an added Unit's do (below), and all but `date_range` must be present; a fixed Requirement's `keywords`, `tools` and `domains` must be lists of strings, `must_have` a boolean, and `priority`, `category` and (when set) `seniority_level` values of the production JD-parsing enums. A malformed field is refused with the item's id and the field's name. On a `keep` or `drop` item, an `owner_corrected_raw_text`, `owner_corrected_text` or `owner_must_have` equal to the saved value is a confirmation and is accepted (the packet asks for `owner_must_have` on every Requirement); a value that differs is refused, since only `fix` changes an item. An `add` Unit needs `raw_text`, `normalized_summary` and `skills`, gets the id `added_<n>`, and may also set `confidence_score` (a number in [0, 1]), `date_range` (`{start, end?}`), `tools`, `domains`, `seniority_signals`, `scope_signals` and `business_outcomes` (lists of strings) and `metrics` (a list of the Unit `Metric` shape, `{claim, value?, unit?, direction?: up|down, confidence: high|medium|low}`). Each is validated, and any other key on an `add` item (including `id` and `owner_uid`) is refused with its name; `owner_*` review fields are allowed and stripped. Added-Unit defaults are not ranking-neutral beside extracted Units: the gold-Unit constants are neutral only when every Unit carries them (the `gold` input), and every scorer multiplies by `confidence_score`. So an added Unit's default `confidence_score` is the median `confidence_score` of the source flow's kept and fixed Units (of all its saved Units when none is kept or fixed; 1 when it saved none), not the gold 1. Without `seniority_signals` the seniority term measures 0 on a Requirement that sets a seniority level, and without `date_range` the current scorer pays the neutral 0.5 for recency where dated Units get a real value, so the owner sets both when the résumé states them. Other unset fields take the gold-Unit constants (no scope signals, outcomes or metrics). The owner-review fields (`owner_*` other than `owner_uid`) are stripped, and the result maps to labels like any record side.
- **Source flow.** The scaffold names no invocation or arm (that is sealed in the packet's `KEY.json`, which the runner never reads). The source flow is the one flow in `--records` for the file's cell whose saved ids include every non-added id in the file; zero or several are refused. A corrections run evaluates only the source flows, so its `record` side is the flow the scaffold came from. When both sides are corrected they must cover the same cells and resolve to the same flow.
- **Provenance.** The report lists, per corrected side, the ids kept, fixed (with the fields that changed), dropped and added, and each Requirement text or must-have override. Each added Unit is printed with the `confidence_score` the matcher was given and where it came from (`owner` or `source median`), its `date_range` and its `seniority_signals`. `fixed-inputs.json` holds the same.
- **Corrections the matcher cannot see.** The matcher embeds `normalized_summary` and `normalized_requirement` and scores the structured signals; nothing under `functions/src/matching` reads `raw_text`, `must_have` or `priority`. So a must-have override (which leaves `priority` at its parsed value) and a Unit fix that changes only `raw_text` cannot move match accuracy: the matcher sees the `record` inputs for those items. The report tags those fields "no effect on matching", and when a side's only changes are such fixes (nothing dropped or added) the report says so and the run warns on stderr.

#### Validating offline

`tests/eval/fixedInputs/diagnosticReproduction.test.ts` reproduces the read-only matching diagnostic from its saved vectors without a request. It is skipped unless `MATCHLINE_DIAG_EMBEDDINGS` (the diagnostic's `emb-all.json`) and `MATCHLINE_DIAG_RECORDS` (the directory holding `2a-inc-ext-1/` and `2a-sonnet55-high-1/`) are set. It seeds a cache first-wins in the diagnostic's order (incumbent flows, Sonnet flows, gold texts) and checks incumbent 22.6, Sonnet 5.5 high 20.1 and gold + gold 0.3125 (90 of 288 pairs, which the diagnostic printed as 31.2) with the current scorer; Sonnet 5.5 high's renormalized and cosine figures (23.26 and 28.47, printed 23.3 and 28.5); the two mixed conditions as the mean of the two arms, against the #648 four-way table (`gold/record` 25.0 / 31.6 / 26.7 and `record/gold` 28.3 / 29.9 / 31.1, current / renormalized / cosine); and the one Sonnet flow that embedding jitter keeps from reproducing, listed in the report and named in the only stderr warning.

### Extraction only (`npm run eval -- --extraction-only`, #648)

```bash
npm run eval -- --extraction-only [--samples N] [--variant '<label>:model.extraction=...'] [--prompt extraction/resume=vN] \
  [--token-source api|claude-cli] [--record ~/.matchline/eval-records/<run>] [--no-cache|--refresh-cache]
```

Runs extraction alone over every labelled résumé, with no JD parsing, embedding or matching, so extraction arms can be compared on all résumés instead of only the cells that have match labels.

- **Corpus.** A labelled résumé is `tests/fixtures/resumes/<id>.txt` with `tests/fixtures/expected-units/<id>.json`. The set is read from the fixtures (10 today), not hard-coded. A résumé without a label is listed as skipped; a label without a résumé is an error. `--full` and `--smoke` do not apply and are refused.
- **Flow.** Each sample runs the full flow's extraction stage through `runExtractionForFixture` (same stage-cache key and discriminators, so extraction-only and full runs share cache entries; same cost and modeled-cost accounting), then scores `unitSetAccuracy`. The OpenAI client is never called, so `OPENAI_API_KEY` is not needed: `--token-source api` needs `ANTHROPIC_API_KEY` (or a warm cache in read-write mode, served offline), and `claude-cli` needs neither.
- **Table.** Per arm (variant label) and résumé, over the flows that returned Units: extraction accuracy, Unit precision (extracted Units mapped to a label at ≥ 0.5), extracted-Unit count, summary tokens (mean whitespace-delimited words) and grounding share (Units whose `raw_text` appears within one résumé line), plus the equal-weight mean of résumé means. The values are `analysis/metrics.ts` `extractionMetrics` on the same flow record `--record` writes, so they equal what `eval:analyze --task extraction` later computes from the records.
- **Records.** With `--record`, each flow is written with the sentinel JD id `extraction-only` and the cell `<resumeId>__extraction-only` (hyphenated so tools that split cells on `__` still work; a fixture named `extraction-only` is refused). `matchAccuracy`, `matchCount` and `requirements` are null, `calls` and `stepCacheHits` hold only the `extraction` step, `stages` lists only `extraction`, and `invocation.json` has `mode: "extraction-only"`. `eval:analyze --task extraction` reads these records (its labels are keyed by résumé). An extraction-only cell never equals a full-flow cell (`<resumeId>__<jdId>`), so `eval:analyze` prints no comparison between an extraction-only arm and a full-flow arm: compare extraction-only arms with each other.
- **Projection guard.** Checked before any flow runs, on résumés × samples × max(1, variants) flows, with the same per-flow estimate as the full flow's Anthropic share (conservative, since a full flow also parses a JD) and no OpenAI spend. With `--token-source api` that is $0.525 of Anthropic spend per flow, so 45 flows ($23.625) run and 46 ($24.15) are refused against the $25 cap's $23.75 hard threshold; use fewer samples or `--token-source claude-cli`. A refused run leaves no record files. A run in which every flow failed exits 1.
- **Variants.** `--variant` takes extraction knobs only. A variant that sets `model.requirement_parsing`, `effort.requirement_parsing` or `prompt.parsing/jd`, and a command-wide `--prompt parsing/jd=...`, are refused: they would change nothing while being reported as part of the arm.

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

### Generation and validation-subtask suites (#488, #489)

`npm run eval:subtasks` evaluates the three validation subtasks (claim extraction, traceability, specificity) and the JD-to-validated-résumé path from frozen approved matches. It is a separate entry point from `npm run eval`: the corpus report, its cache and its CI no-keys path are unchanged, and onboarding extraction stays in `npm run eval`.

```bash
# Plan and projection only: no keys, no client, no request
npm run eval:subtasks -- --suite validation --dry-run
npm run eval:subtasks -- --suite generation --dry-run

# A cheaper specificity model against the baseline (a paid run: project first, post on #495)
npm run eval:subtasks -- --suite validation --max-usd 10 \
  --variant 'spec-haiku:model.specificity=claude-haiku-4-5-20251001'

# A supported effort on a registered 5.5 model
npm run eval:subtasks -- --suite validation --max-usd 10 \
  --variant 't55:model.traceability=claude-sonnet-5-5,effort.traceability=medium'
```

Flags: `--suite validation|generation` (required), `--case <id>` (repeatable), `--samples N`, `--prompt <stage>/<name>=vN`, `--variant` (same grammar as the corpus sweep), `--token-source api|claude-cli`, `--dry-run`, `--max-usd <n>`, `--replay` or `--no-cache`, `--report-json <path>`. Unknown flags exit 2. An implicit `baseline` variant with no overrides always runs first; the label is reserved.

**Scopes.** Each suite accepts overrides only for what it runs; anything else is refused before a request, like the corpus sweep's "not exercised" rule.

| Suite | `model.` / `effort.` stages | Prompt keys |
| --- | --- | --- |
| corpus (`npm run eval`) | `extraction`, `requirement_parsing` | `extraction/resume`, `parsing/jd` |
| validation | `claim_extraction`, `traceability`, `specificity` | `validation/claimExtraction`, `validation/traceability`, `validation/specificity` |
| generation | `generation` | `generation/resume` |

`rationale` is in no scope: rationales are a deterministic template and the config entry is never read. The old single `validation` stage is an unknown stage since #489. Generation variants are limited to models whose profile is forced tool choice, no effort and budget factor 1 (today `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`): `functions/src/generation/pipeline.ts` does not apply model profiles yet, so an effort or a 5.5 model there would run without the requested setting or fail on forced tool choice.

**What is graded, and by what.** The validator under test is graded only against labels, never against another model. Traceability and specificity are called on the GOLD assertion text, with the item's cited Units as the only candidates (the same rule as `validateBullet`); claim extraction is scored by lexical coverage of the gold assertions; a whole-asset pass runs `validateAsset` with in-memory loaders and is graded only on its status. In the generation suite, downstream validation runs with the validator pinned to production defaults (`assertValidationAtDefaults`), and its verdict is reported as the baseline validator's, not as ground truth.

**Fixtures.** `tests/fixtures/validation-cases/` (15 cases covering the #488 categories plus multi-clause, date drift and the owner's adversarial fabrication) and `tests/fixtures/generation-snapshots/` (one rich, one sparse), built only from public fixtures. All are drafts (`"review_status": "draft-pending-owner-review"`, `"labeled_by": "claude-draft"`) until the owner reviews them; every report over drafts carries a DRAFT banner and is not a comparison of record. See the README in each directory for the schema and the loader's refusals.

**Labels are immutable for a comparison.** `tests/fixtures/eval-labels.lock.json` holds each labeled file's sha256 per `label_version` (cases, snapshots and `expected-asset-traces/`). To relabel: edit the file and bump `label_version`, append `{ label_version, sha256 }` to its lock history, and land it as a separately reviewed PR. `labelsLock.test.ts` fails on any unlocked change, and the run refuses to start. Every report prints a `fixtureSetHash`; runs whose hashes differ are not comparable (`comparable()` in `tests/eval/subtasks/report.ts`).

**Comparability.** `comparable()` treats two runs as comparable row for row only when they share the suite, `fixtureSetHash`, token source, replay mode (live or replayed), `samples`, the fixed run date (`fixedRunDate`, the `Today:` the validator and generator saw), every enforced tool-schema hash (`schemas`), and, for each variant label both ran (always `baseline`), the resolved stage settings (model, effort, `max_tokens`, tool choice) and prompt fingerprints. A generation run also records its `judge`: the pinned downstream validator's settings and prompt fingerprints, resolved at production defaults outside any variant, so two runs whose downstream pass rates come from different validators (a validation prompt edited in place, or a default moved to a new version) are refused. Any change to prompt wording is a new experiment input, not a re-judge of earlier results. A different git sha alone does not refuse a comparison, but it is returned as a caveat: module code that builds a request (for example how Units are rendered into a prompt) is not covered by a prompt fingerprint.

**Metrics** (pure, in `tests/eval/subtasks/metrics.ts`; every rate shows its numerator and denominator):

- Claim extraction: assertion coverage, scored one to one (a maximum matching between gold assertions and extracted claims, so one claim is credited to at most one assertion: an extractor that repeats the whole item scores 1/|A|, not full coverage), the number of fused claims (claims that carry the terms of two or more assertions), and relationship coverage. These are kept apart from schema validity (first-attempt pass, pass after retry, hard fail, outcome histogram per stage): an extraction that hard-failed (schema or transport) is left out of the coverage denominators, listed by case, and counted only under hard fail, so a schema failure never reads as poor decomposition. A secondary end-to-end line, printed only when an extraction hard-failed, scores those cases as covering nothing (`assertionCoverageHardFailsAsZero`, `relationshipCoverageHardFailsAsZero`).
- Traceability: fabrication false accept, supported-claim false flag, wrong supporting Unit. A fabrication whose check hard-failed is listed as unverified, never counted as caught.
- Specificity: false flag and miss.
- Whole asset, split by why the labels expect a failure: fabrication false accept (cases with an unsupported assertion that passed), specificity false accept (cases expected to fail only on specificity that passed) and false block. A specificity regression is therefore never reported as a fabrication accepted. An errored run is neither.
- Every traceability, specificity and whole-asset rate is counted over distinct labeled units (assertions, or cases) with a Wilson 95% interval. With `--samples N`, the N verdicts on one unit count once, so repeats never narrow the interval; the pooled sample count is printed beside it. The two fabrication false-accept rates (traceability and whole asset) count a unit as accepted when any of its samples accepted it: zero fabrication means zero false acceptance across all repetitions, so a fabrication accepted once in three samples is reported as accepted, not caught. Every other rate counts a unit by majority (a tie counts against the model), so one noisy false flag in N samples does not mark a supported claim or a passing asset as flagged.
- Generation: schema-valid and first-attempt rates, invented-id retry rate, requirement coverage through approved pairs, expected-trace recall (rich snapshot), unmatched must-haves (listed, not scored), and the baseline validator's pass rate.
- Retry and error rate per stage, over invocations that made a model call. An invocation with no call (e.g. traceability with no candidate Units), one the validation call pool cancelled after another call failed, and one the budget stopped are counted on their own and left out of the rates; budget-stopped and cancelled verdicts are also left out of coverage and of the traceability and specificity rates.
- Cost: total modeled and actual cost over every call; per flow, the generation suite reports cost per completed flow (all its flows' cost, failed flows included, over completed flows) and the validation suite reports cost per validated asset over the whole-asset pass only, with the isolated pass (an evaluation-only workload) on its own line.
- Wall time: per pass and stage, the span and per-call latency with p50/p95 (spans, never sums of concurrent calls), and an end-to-end span (the whole-asset `validateAsset` run, or generation plus baseline validation), live calls only: a flow with a replayed call is left out.

**Run metadata.** Each run has a `runId`; every attempt has an `attemptId` and records the requested and served model, `max_tokens`, tool choice and effort as sent, the request key, usage, modeled cost and token fidelity (`metered` for api, `estimated` for the CLI). An api call with a missing or mismatched served model makes the variant `invalid: served-model`; a usage record whose `max_tokens` or effort differs from the wire makes it `invalid: settings-mismatch`. An answer no outcome schema can classify makes it `invalid: unclassified`: each classifier is the single `*ResponseV<N>Schema` export of `functions/src/prompts/<stage>/<name>.v<N>.schema.ts` (the convention `loadPromptWithSchema` uses), loaded at pre-flight for the prompt version whose schema the module imports (the `PROMPT_CONFIG` default). Nothing is listed by hand, so moving a default to a new version that has a schema file needs no harness edit; the run refuses to start, and `sweepScope.test.ts` fails, only when that file is missing or does not export exactly one such schema. A variant where every invocation failed and no request got a response (a revoked key, an outage, an offline replay miss) is `incomplete: all_failed`. Invalid and incomplete variants are printed but marked not comparable, and an invalid or incomplete baseline exits 1. `--report-json` writes the whole `RunRecord` privately.

**Local replay is not the provider cache.** Requests are keyed by the full request body (model, `max_tokens`, tool choice, effort, system prompt with suffix and retry reminder, tool schema, rendered messages) plus token source, CLI adapter version and sample index, so every setting, prompt and rendering change is in the key. The default mode, `fresh`, stores outputs but never reads them, so independent live runs never reuse an output; `--replay` reuses stored outputs to rescore offline; `--no-cache` neither reads nor writes. The report shows local replay and provider prompt-cache tokens as separate rows. The corpus `StageCache` is untouched.

**Spend.** `--dry-run` prints the request plan with an expected case and a retry-inclusive conservative estimate (3 attempts at the full output cap, input with a 1.25 margin, ×1.35 for the 5.5 tokenizer). The estimate is not a bound: the number of claims the whole-asset pass extracts, the items a generation produces and the claims per generated item are heuristics (no schema caps them), and downstream inputs are estimated from the snapshot's three largest Units. A live api run requires `--max-usd` and refuses when the estimate exceeds it or a monthly cap. The budget ledger is the actual stop: before each request it reserves that request's worst case and refuses it when spent plus the worst cases of every request still in flight plus this one would cross `--max-usd` (up to six run at once); a request with no response releases its reservation. Reaching the bound aborts the run without retries and marks the remaining cases `skipped: budget_reached`. A `--replay` run with no key cannot spend (a miss fails offline), so it is not held to the monthly caps. A stored entry that cannot be read or parsed (a `put` interrupted mid-write, or a foreign file) is treated as a miss and counted on the store's `readErrors`, never as a crash. Post the projection on #495 before any paid run. Fifteen cases and two snapshots cannot support production p95 or reliability claims; every report says so.

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
├── runForFixture.ts   per-fixture orchestration (#136); extraction-only flow (#648)
├── extractionOnly.ts  --extraction-only: extraction over every labelled résumé (#648)
├── flowTrace.ts       pure: per-flow trace collector (--record)
├── flowRecord.ts      pure: flow/invocation record shapes, derived flags, JSONL parser
├── recorder.ts        --record: writes invocation.json + flows.jsonl
├── analyze.ts         eval:analyze CLI
├── analysis/          pure: metrics, statistics, arm comparison for eval:analyze
├── fixedInputs/       eval:fixed-inputs: matcher on fixed record/gold/corrected inputs (#648)
├── fitBrief/          private-corpus fit-brief eval (#495)
├── loadFixtures.ts    typed fixture-file readers (#136)
├── mapping.ts         runtime UUID → labeler mnemonic (#136)
├── cache.ts           content-addressed stage cache (#389)
├── tokenSource.ts     api / claude-cli adapters (#389)
├── sweep.ts           pure: model×prompt matrix + Pareto table (#389)
├── sweepScope.ts      which stages / prompt keys each suite may override (#488)
├── subtasks/          generation and validation-subtask suites (#488, #489)
├── scoring.ts         pure: jaccard, unit-set accuracy, top-K overlap
├── projection.ts      pure: monthly-spend cap check
├── report.ts          pure: stdout formatter
├── .cache/            stage-cache and subtask replay entries (gitignored)
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
├── expected-asset-traces/   per-generated-output claim → Unit map
├── validation-cases/    draft labeled cases for the validation suite (#488)
├── generation-snapshots/    draft frozen generation inputs (#488)
└── eval-labels.lock.json    label lock for the three labeled directories above
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
