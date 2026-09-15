# Repository Overview

This repository is **Matchline** — a career operating system for one
serious job search. It turns work history into structured, reusable
evidence, maps that evidence against specific job requirements, and
generates tailored applications grounded only in user-approved evidence.

Matchline is an application of the AI Agent Tooling Standard
([`ai_agent_tooling_standard.md`](../../ai_agent_tooling_standard.md)).
Mergepath (`~/GitHub/mergepath`) is the reference implementation of that
Standard; this repo adopts its conventions, review policy, and deploy
tooling.

Primary stack (V1): React + TypeScript + Vite + Tailwind on the frontend;
Firebase Functions (Node) on the backend; Firestore for storage;
Anthropic + OpenAI for LLM calls; OpenAI `text-embedding-3-small` for
embeddings. See [`specs/matchline.md`](../../specs/matchline.md) for the
authoritative product spec and [`BRAND.md`](../../BRAND.md) for the
vocabulary (Experience Unit, Job Requirement Unit, UnitMatch,
Capability Graph, and the V1 screens).

Agent role: implement and maintain the V1 core loop — Career →
Experience Units → Matching → Application — under the hard constraint
that every generated claim traces back to an approved Experience Unit.
Zero fabrication is a product-defining invariant, not a target.

The repository enables current-head external-review enforcement through `codex.external_review_gate.enabled`; see [the local review policy](../../REVIEW_POLICY.md#external-clearance-enforcement-in-this-repository) for activation and approval-count rollout requirements.

Blocked Codex external-clearance diagnostics bind request age and acknowledgement to an exact `@codex review` command comment; later prose mentions do not replace it. The filter preserves requester deduplication, clearance decisions, and blocked exits ([mergepath#1276](https://github.com/nathanjohnpayne/mergepath/issues/1276)).
