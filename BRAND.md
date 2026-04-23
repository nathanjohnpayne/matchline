# Matchline — brand vocabulary

**Matchline** is a career operating system for one serious job search.
It turns work history into structured evidence, matches that evidence
against specific job requirements, and generates tailored applications
grounded only in what the user has explicitly approved.

The product's defining constraint is **zero fabrication**: no claim
ships that doesn't trace back to an approved Experience Unit.
Everything in the brand — naming, copy, UI — should reinforce that
claim.

## V1 surfaces

The V1 product ships with five screens. Use these names consistently in
code, copy, and documentation.

- **Onboarding** — first-session import of resume, LinkedIn, and
  long-form career context into Experience Units.
- **Unit Review** — primary interface for approving, correcting, and
  maintaining the Capability Graph. The integrity-defining surface.
- **Role Detail** — per-role workspace with Requirements, Matches, and
  Applications tabs.
- **Application Editor** — generation surface with inline traceability
  annotations and validation flags. Export is blocked while any flag is
  unresolved.
- **Pipeline** — CRM-lite kanban by application stage. Replaces the
  spreadsheet.

## Reserved names (V2+)

These layers are explicitly deferred. Names are reserved so a future
agent doesn't pick one for the wrong surface.

- **Decision Engine** — "should I apply?" scoring combining fit,
  network signal, and role quality.
- **Learning Layer** — outcome-driven tuning of matching weights and
  generation prompts.
- **Network Layer** — relationship graph and referral suggestions.
- **Browser Extension** — one-click JD and profile import.

Do not scaffold files for these names until the surface is actually
designed.

## Vocabulary

- **Experience Unit** — an atomic, verifiable claim about what the user
  has done, with associated skills, tools, domains, metrics, and
  confidence. Permanent; belongs to the user across every application.
- **Job Requirement Unit** — a structured requirement parsed from a
  JD, with priority, must-have flag, and category.
- **UnitMatch** — a scored, per-application relationship between one
  Experience Unit and one Requirement. Ephemeral; regenerated per
  role.
- **UnitCluster** — a curated group of Experience Units used as the
  grounding for a specific generated artifact (resume bullet, cover
  letter hook, outreach draft).
- **Capability Graph** — the full set of a user's Experience Units
  plus their relationships to skills, tools, domains, and metrics.

## UI design direction

The V1 UI targets an **Attio-like** aesthetic — clean, modern, dense,
keyboard-first, monochrome with restrained accent. Full guidance
lives in [`docs/design/ui-guidance.md`](docs/design/ui-guidance.md),
which is the canonical reference for every `src/routes/**` surface.
Agents must read it before opening any UI PR.

## Relation to the Standard

Matchline follows the AI Agent Tooling Standard
([`ai_agent_tooling_standard.md`](ai_agent_tooling_standard.md)).
Mergepath (`~/GitHub/mergepath`) is the reference implementation of
that Standard; Matchline is an application of it. The Standard's
review policy, repo structure, and deploy-auth model are canonical and
should not be forked here unless a human explicitly authorizes the
divergence.
