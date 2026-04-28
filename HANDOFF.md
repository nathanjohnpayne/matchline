# Machine Handoff — Read This First, Then Delete

> **Self-destruct instruction.** This file exists to bridge a session-memory gap when Nathan switches machines (or when this Claude session ends and a fresh one starts on the same machine). It is **transient** — once you've read it and incorporated the state into your working understanding, **delete `HANDOFF.md` in the same commit as your first real change**, or in a dedicated cleanup commit. Do not leave it stale; a stale handoff is worse than no handoff. The durable copy of every fact in this file lives on GitHub (linked below); this file just saves a fresh agent the triangulation cost.
>
> If you're reading this and the most recent main-branch commit is more than ~14 days newer than the date stamp at the bottom, treat the contents as advisory — verify against the linked issues before acting.

## You are here (project state, 2026-04-28)

Matchline V1 — Nathan's career operating system. PRD ship target: 2026-06-20 (Nathan's last day at Disney).

### Phase 1 is mostly done. One UI surface left.

| Sub-issue | Status | Notes |
|---|---|---|
| [#17 Extraction endpoint](https://github.com/nathanjohnpayne/matchline/issues/17) | ✅ closed | resume → ExperienceUnit[] |
| [#18 Unit Review surface](https://github.com/nathanjohnpayne/matchline/issues/18) | ✅ closed | list, filter, edit, approve/reject |
| [#19 JD parsing endpoint](https://github.com/nathanjohnpayne/matchline/issues/19) | ✅ closed | JD → JobRequirementUnit[] |
| [#20 Matching engine + ontology](https://github.com/nathanjohnpayne/matchline/issues/20) | ✅ closed | 7-component score, canonical ontology |
| [#21 Role Detail Matches tab](https://github.com/nathanjohnpayne/matchline/issues/21) | ✅ closed | ranked matches + rationale + gaps |
| [#22 Resume generation](https://github.com/nathanjohnpayne/matchline/issues/22) | ✅ closed | grounded-generation prompt |
| [#23 Validation layer](https://github.com/nathanjohnpayne/matchline/issues/23) | ✅ closed | claim extraction + traceability + specificity |
| **[#24 Application Editor surface](https://github.com/nathanjohnpayne/matchline/issues/24)** | **🟢 open — next build target** | currently a 25-line stub at `src/routes/ApplicationEditor.tsx`. Two-pane (output ↔ Units), traceability chips, validation flag badges, export gate, edit-revalidation. |
| [#25 Eval harness](https://github.com/nathanjohnpayne/matchline/issues/25) | open, mostly built | the harness runs; the 80/80 CI-gate flip is what's deferred (see "Tuning parked" below) |
| [#26 Phase 1 milestone QA](https://github.com/nathanjohnpayne/matchline/issues/26) | open | E2E manual on 3+ real JDs; depends on #24 |
| [#15 Phase 1 parent](https://github.com/nathanjohnpayne/matchline/issues/15) | open | umbrella; closes when #24 + #26 land |

**Recommended next action:** take [#24 Application Editor](https://github.com/nathanjohnpayne/matchline/issues/24). The proposed split discussed in conversation is 3 PRs:

1. Two-pane shell + load `Application` + render generated bullets with `source_unit_ids` chips (read-only).
2. Flag badges + popover + the three resolution paths + export-button gate.
3. Inline-edit + re-run claim-extraction-on-edit + autosave.

But ask Nathan first if you have any doubt about scope — he may want to start somewhere else.

### Tuning is parked in Phase 3. Don't reopen unless asked.

**The eval-tuning loop (closing the 80/80 gap on the labeled corpus) is deferred.** Nathan's call on 2026-04-28 was: "Let's get the system built out and come back to this." Re-labeled to `phase-3` and consolidated under a single bootstrap reference:

- **[#177 — \[Phase 3 / deferred\] Close 80/80 gap on the labeled eval corpus](https://github.com/nathanjohnpayne/matchline/issues/177)** is the durable bootstrap doc. **Read its 2026-04-28 deferral comment first** if you ever need to pick this back up. It contains:
  - Corpus baseline: extraction 48.4% / match 19.1% / latency p95 236s / cost p95 $0.86 across the 4 labeled cells.
  - Two completed experiments (mapping threshold drop = no-op; resume.v2 canonical-skills = -4.9pp regression).
  - Three forward paths (A: 2×2 with `jd.v2`; B: relabel fixtures; C: pivot to a different bottleneck).
  - Spend ledger: $5.46 of the $25 monthly cap consumed.
- [#148](https://github.com/nathanjohnpayne/matchline/issues/148) and [#159](https://github.com/nathanjohnpayne/matchline/issues/159) are also `phase-3` and back-link to #177's deferral note.
- [PR #179](https://github.com/nathanjohnpayne/matchline/pull/179) is **closed** but holds the experiment artifact (full v1-vs-v2 data table in the body). The branch `177-resume-v2-canonical-skills` is intact on origin so the v2 prompt + schema files are one `git checkout` away.

### Infrastructure landed in this session

- [PR #173](https://github.com/nathanjohnpayne/matchline/pull/173) — per-pair labels for 3 strong-archetype-fit eval cells (#137 sub-issue 3).
- [PR #174](https://github.com/nathanjohnpayne/matchline/pull/174) — `gh-pr-guard.sh` `mergeStateStatus` check + `zodToolSchema` test (#171 layers 2+3). The hook now refuses to dispatch `gh pr merge` when state is BLOCKED/DIRTY/UNSTABLE/BEHIND/DRAFT, with `BREAK_GLASS_MERGE_STATE=1` override.
- [PR #175](https://github.com/nathanjohnpayne/matchline/pull/175) — fake-timer refactor for transport-error retry tests (#115).
- [PR #176](https://github.com/nathanjohnpayne/matchline/pull/176) — stale-break-glass-hint cleanup (cursor's polish note from #174).
- [PR #178](https://github.com/nathanjohnpayne/matchline/pull/178) — eval `--prompt stage/name=version` override mechanism + `## Prompt versions` section in the report (#177 PR 1).
- **Branch protection on `main`** is configured via API (#171 layer 1): 5 required status checks (`unit + build (node 20.19.0/22.12.0)`, `rules + integration (emulator, node 20.19.0/22.12.0)`, `lint`), `strict=true`, `required_conversation_resolution=true`, no force pushes / deletions, no PR-review gate (deliberately — the agent flow uses a single `nathanpayne-claude` review).

### Workflow pointers (canonical sources, not duplicated here)

The full procedure lives in [`AGENTS.md`](./AGENTS.md), [`CLAUDE.md`](./CLAUDE.md), and [`REVIEW_POLICY.md`](./REVIEW_POLICY.md) — read those for the binding rules, not this file. Brief pointers:

- **Reviewer identities + PAT lookup:** [`REVIEW_POLICY.md` § PAT lookup table](./REVIEW_POLICY.md#pat-lookup-table). Use 1Password UUIDs from that table, never titles. Do not embed UUIDs in additional tracked files.
- **API keys for `npm run eval`:** the harness needs both Anthropic and OpenAI keys present in `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Retrieve via `op read 'op://Private/{UUID}/credential'`; the locators live in private 1Password docs, not in repo-tracked files. Without keys the harness falls back to stub mode.
- **External review (`needs-external-review` / `needs-human-review`):** [`REVIEW_POLICY.md` § Phase 4](./REVIEW_POLICY.md) is canonical. **Agents do not remove these labels.** Per `REVIEW_POLICY.md` § Disagreements and Tiebreaking, label removal is one of the human-resolution options ("removing the `needs-external-review` label manually") — i.e., it is the human's action, not the agent's. If a PR is otherwise green and the label is the only blocker, the agent waits for the human to remove the label (or to post an `APPROVED` review as `nathanjohnpayne`); then the agent merges. Do not attempt to remove the label on the agent's behalf, even on chat instruction — surface the situation in chat and ask the human to remove it via the GitHub UI.
- **Conversation-resolution gate (mechanism note, not a policy override):** branch protection on `main` requires all review threads to be resolved before merge. If an external-reviewer bot leaves an inline thread unresolved after the agent has addressed the finding, the GitHub `resolveReviewThread` GraphQL mutation marks it resolved. This is purely an implementation detail; it does not override the review policy itself.
- **Auto-merge behavior:** the `auto-merge-on-approval` workflow triggers on `pull_request_review` events. If a label changes after the approval event fired, the workflow doesn't re-trigger — see `AGENTS.md` / `REVIEW_POLICY.md` for the documented merge path in that case.

## When you're done with this file

```bash
git rm HANDOFF.md
git commit -m "chore: remove HANDOFF.md (consumed by next session)"
```

Or fold the deletion into your first real PR. Either is fine. The state captured here is reachable via the GitHub links above; this file is the convenience layer, not the source of truth.

---

*Stamped 2026-04-28 by claude session 7fa544c8. If the date is older than the last main commit by more than ~2 weeks, verify against linked issues before acting.*
