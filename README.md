# Matchline

**A career operating system for one serious job search.**

Matchline turns actual work history into structured, reusable evidence,
maps that evidence against specific job requirements, and generates tailored
applications grounded in what the user has actually done. It is not a
resume builder, not an ATS optimizer, and not a generative writer.

V1 has exactly one user and one goal: run a disciplined senior-PM search
end-to-end without a spreadsheet or a rotating stack of resume variants.
See [`specs/matchline.md`](specs/matchline.md) for the authoritative
product spec (derived from the PRD at
`~/GitHub/docs/projects/matchline/matchline-prd.md`).

## For AI Agents

Read these files in order before taking any action:

1. `AGENTS.md` — behavioral instructions and operating rules
2. `rules/repo_rules.md` — binding structural constraints
3. `specs/matchline.md` — intended V1 behavior (core loop, data model, validation)
4. `.ai_context.md` — supplemental system context

This repo follows the AI Agent Tooling Standard
([`ai_agent_tooling_standard.md`](ai_agent_tooling_standard.md)). Mergepath
is the reference implementation of that Standard; Matchline is an
application of it.

## Core loop (V1)

```
Career → Experience Units → Matching → Application
```

Four steps, one hard constraint: **zero fabrication**. Every claim in every
generated output traces back to an approved Experience Unit, or it doesn't
ship. See [`specs/matchline.md`](specs/matchline.md) for the full
specification.

## Code Review Policy

Every change in this repository goes through the policy in
[`REVIEW_POLICY.md`](REVIEW_POLICY.md), including a self-peer review by the
authoring agent's reviewer identity and, for changes that cross the
threshold or touch protected paths, automated external review via the
OpenAI Codex GitHub app (Phase 4a) or a manual CLI fallback (Phase 4b).

## Key Files

| File | Purpose |
|---|---|
| `AGENTS.md` | Instructions for AI agents |
| `CLAUDE.md` | Claude-specific reading order and PR checklist |
| `REVIEW_POLICY.md` | Multi-identity review workflow |
| `DEPLOYMENT.md` | Build and deployment (1Password-backed GCP auth) |
| `CONTRIBUTING.md` | Development workflow |
| `specs/matchline.md` | V1 product spec |
| `.ai_context.md` | High-level system context |
| `ai_agent_tooling_standard.md` | Full repository standard (reference) |

## Firebase Auth

This repo uses the canonical Google Cloud and Firebase helper scripts for
this account:

- `scripts/gcloud/gcloud` installs a local wrapper so ordinary `gcloud`
  commands can use 1Password-backed or explicit source credentials without
  a routine interactive `gcloud auth login`, while attributing quota to
  the resolved target project from explicit flags, the repo's
  `.firebaserc`, or the active `gcloud` config.
- `scripts/firebase/op-firebase-setup` creates a per-project
  `firebase-deployer@{project-id}.iam.gserviceaccount.com`, grants deploy
  roles, and configures impersonation.
- `scripts/firebase/op-firebase-deploy` turns a 1Password-backed or
  explicit source credential, or a CI-provided `external_account`
  credential, into a temporary impersonated credential for
  `firebase deploy`, with the target project stamped in as the quota
  project.

Human maintainers should use 1Password-backed GCP ADC plus service
account impersonation. CI should prefer Workload Identity Federation or
another `external_account` source credential instead of stored
service-account keys. See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full
bootstrap and deploy flow.

## Stack (V1)

- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Firebase Functions (Node)
- Database: Firestore
- Auth: Firebase Auth
- Hosting: Firebase Hosting + Firebase Functions
- LLMs: Anthropic + OpenAI, keys in Firebase secrets
- Embeddings: OpenAI `text-embedding-3-small`, stored on Firestore documents

## Directory Structure

| Directory | Purpose |
|---|---|
| `rules/` | Binding repository constraints |
| `specs/` | Intended system behavior |
| `plans/` | Execution and migration plans |
| `tests/` | Automated validation |
| `src/` | Application code (added in Sprint 0) |
| `functions/` | Backend handlers (Cloud Functions) |
| `scripts/` | Build, CI, and automation tooling |
| `docs/` | Architecture and design documentation |
| `dist/` | Generated build artifacts (do not edit manually) |
