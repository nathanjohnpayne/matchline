<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/matchline/prds/matchline.md
source_ref: de4b144
project: matchline
document_class: prd
document_slug: matchline
sync_direction: central-to-repo
-->

---
tags:
  - matchline
  - prd
---
# Matchline — Product Requirements Document

Version: v0.1
Author: Nathan Payne
Last updated: October 5, 2026

**Status (2026-10-05):** Paused pre-launch since 2026-07-31. V1 was built through the core loop on the stack below (dev instance: `matchline-dev.web.app`) but did not ship by the July 2026 target; the result of record is 48.4% extraction and 19.1% match accuracy against the 80% bars, with p95 latency 236 s (matchline#177). Not yet built from the V1 scope below: LinkedIn and long-form context import, artifact upload, cover letters, and PDF/DOCX export. As of September 2026 the job search it was built for has resumed, so revisiting is under consideration (nathanpayne.com project page). Implementation detail: the repo's `specs/matchline.md` and `plans/matchline-implementation-plan.md`.

---
Matchline is a Career CRM + Capability Graph + AI Application Engine.

Tagline:
From what you've done to what's next.

Wordmark: match|line
Favicon: m|
## Contents

- [What Matchline is](#what-matchline-is)
- [Why this exists](#why-this-exists)
- [Who V1 is for](#who-v1-is-for)
- [What the V1 experience is](#what-the-v1-experience-is)
- [What Matchline is not](#what-matchline-is-not)
- [Success metrics for V1](#success-metrics-for-v1)
- [What's in scope vs. deferred](#whats-in-scope-vs-deferred)
- [Why me, why now](#why-me-why-now)
- [Product structure](#product-structure)
- [Data model](#data-model)
- [Matching engine](#matching-engine)
- [AI pipeline](#ai-pipeline)
- [Validation layer](#validation-layer)
- [Execution targets](#execution-targets)
- [V1 interface](#v1-interface)
- [V2+ layers](#v2-layers)
- [Technical principles](#technical-principles)
- [Stack and hosting](#stack-and-hosting)
- [Pricing model](#pricing-model)
- [Resolved questions](#resolved-questions)
- [What ships first](#what-ships-first)
- [Appendix: what's not in this document](#appendix-whats-not-in-this-document)
- [Closing](#closing)

---

## What Matchline is

Matchline is a career operating system for one person running a serious job search. It turns your actual work history into structured, reusable evidence, maps that evidence against specific job requirements, and generates tailored applications grounded in what you've actually done. It is not a resume builder, an ATS optimizer, or a generative writer. It is a system for making a job search legible, disciplined, and honest—with yourself and with the people reading your applications.

The core thesis: most job-search tools treat each application as a document-writing problem. Matchline treats it as an evidence problem. You already have the evidence; the work is structuring it, matching it to the right opportunities, and presenting it credibly. The AI helps with all three, but never invents what isn't there.

## Why this exists

Two things are true about the 2026 job market that weren't true three years ago. First, applicants can generate tailored resumes and cover letters in seconds with ChatGPT, so the floor of "looks reasonable" has collapsed—every application is now polished, and polish is no longer a signal. Second, recruiters and hiring managers are drowning in AI-generated applications that are technically on-target but substantively empty, which means credibility and specificity are now the signal.

The tools that rose to the top of the last hiring cycle (Teal, Huntr, Simplify, LinkedIn Easy Apply) were built for a market where the bottleneck was application volume. The bottleneck now is signal quality in a flood of plausible noise. Matchline is built for that market: fewer applications, each one specifically grounded in your real experience, each one easy for a human reader to verify.

The personal reason is that my last day at Disney was June 20, 2026. I'm running this search myself, and I want to run it with the discipline of a pipeline and the specificity of a product, not with a spreadsheet and a rotating set of resume variants. I am building the tool I need. If it generalizes later, that's a V2 conversation.

## Who V1 is for

V1 has exactly one user: me, running a senior PM search in video/streaming infrastructure, developer tools, and AI-augmented workflows, targeting smaller/faster-moving companies with hybrid or remote flexibility anchored to the SF Bay Area.

This is deliberate. Building for a known user with known constraints lets me make specific product decisions instead of abstract ones. The CRM needs to track Mux and GIGO Data because those are live. The capability graph needs to handle twelve years of streaming video infrastructure experience. The application engine needs to be tuned for a market where hiring managers care about device certification, not about how I optimize for an ATS.

V2 users are other individual job seekers in knowledge work—initially other tech PMs, then adjacent roles. But V2 is a future problem. V1 exists to prove the core loop works for one person running one serious search.

## What the V1 experience is

A new user (me) opens Matchline for the first time. Within the first session, they should be able to:

1. **Import their career.** Paste a resume, connect to LinkedIn, upload a long-form career document, or upload career artifacts—PRDs, decks, strategy memos, retros, one-pagers—the documents that contain the specifics resume bullets compress away. The system extracts structured Experience Units—atomic, verifiable claims about what they've done, with attached skills, tools, domains, metrics, and confidence scores. The user reviews, corrects, and confirms.

2. **Add a target role.** Paste a job description. The system parses it into structured Job Requirement Units with priority and must-have flags.

3. **See the match.** A side-by-side view showing which Experience Units map to which Requirements, which requirements are covered, and which are gaps. Gaps are surfaced honestly, not hidden.

4. **Generate an application.** A tailored resume and optional cover letter, grounded only in approved Experience Units, with every claim traceable to a source. Nothing generated that isn't backed by an actual unit of experience.

5. **Track the application.** Stage, last touched, who's involved, what's next. CRM-lite from day one.

The first session success criterion: the user generates one application they would actually send in under fifteen minutes, without editing out any fabricated claims. That's the V1 bar.

## What Matchline is not

Stating non-goals explicitly so they don't sneak back in as features:

- **Not an ATS keyword stuffer.** If the system suggests a keyword, it's because the user has genuine experience with it, not because the JD asked for it.
- **Not a generative writer.** The AI assembles and rephrases; it never introduces claims the user hasn't confirmed.
- **Not a job board.** No scraping listings, no "jobs you might like." The user brings the roles.
- **Not a mass-apply tool.** Matchline is for people applying to fewer roles with more care, not more roles with less.
- **Not a coaching product.** No interview prep, no career advice, no "should you leave your current role." The product's scope is the application itself.
- **Not a team or enterprise product.** Single-user, personal data, no sharing or collaboration in V1.
- **Not a replacement for networks.** The network graph (V2+) augments outreach; it doesn't replace real relationships.

## Success metrics for V1

V1 is a single-user tool, so traditional product metrics don't apply. Instead:

**Primary metric.** Does the user (me) use it as the primary job search tool throughout the entire active search period, or does it get abandoned in favor of a spreadsheet and ChatGPT? If it's used end-to-end for at least ten serious applications, V1 is validated.

**Quality metrics.**
- Experience Unit extraction: at least 80% of extracted units are accurate and useful without user editing, across a test set of ten resumes (mine plus nine others).
- Match accuracy: at least 80% of proposed matches between Experience Units and Job Requirements hold up to manual review.
- Zero fabrication: no generated application contains a claim that can't be traced to an approved Experience Unit. This is a hard constraint, not a target.

**Speed metrics.**
- Full flow (paste JD → generate resume) under twenty seconds at p95.
- Per-application cost under one dollar, including all LLM calls.

**Search outcome metrics.** Ultimately, does the user get interviews and offers for roles that matter? This is noisy at N=1, but it's the real test. A version of this tool that generates beautiful applications that never convert is a failed tool.

## What's in scope vs. deferred

**In V1 (original target: ship to one user by July 2026; missed, see Status above):**
- Career CRM: People, Companies, Roles, Applications, Interactions
- Experience Units with manual review and correction
- Multi-source career ingestion: resume paste, LinkedIn HTML, long-form prose, and artifact upload (PDF / DOCX / PPTX) into a shared extraction pipeline
- Job Requirement parsing with priority and must-have flags
- Matching engine with explainable scores and rationales
- Application generation: resume and cover letter, grounded in approved units
- Validation layer: flag unsupported claims before the user sees output
- Basic pipeline management: stages, tasks, follow-up reminders

**Deferred to V2 or later:**
- Outcome learning system (needs more data than one user generates)
- Network graph and referral engine (requires integrations that slow V1)
- Decision engine / "should I apply" scoring (nice-to-have, not core loop)
- Multi-user / sharing/team features
- Integrations with job boards or ATS systems
- Mobile app
- Any generalization beyond my own search

## Why me, why now

I've spent ten years at Disney shipping streaming video infrastructure across device ecosystems that don't forgive imprecision—PlayStation, Xbox, Fire TV, set-top boxes, smart TVs. I've lived the reality that credibility in a technical domain comes from specific, verifiable evidence, not a polished narrative. I've also spent the last six months vibe-coding side projects that gave me the stack and the habits to build this quickly: React, TypeScript, Vite, Tailwind, and Firebase.

The layoff was the forcing function. My last day was June 20, 2026, and I wanted a tool by then that would make my search honest and efficient, and I don't want to run it the way I've watched dozens of friends run theirs. If the tool works for me, it probably works for other thoughtful senior operators in the same position. That's the V2 case. V1 is personal.

---

---

## Product structure

Matchline is built around a single core loop and a set of layers that extend it. The core loop is what makes the product work at all; everything else is a layer that makes the core loop better over time. This distinction matters because it tells you what to build first, what to build next, and what to cut when scope pressure shows up.

### The core loop

```
Career → Experience Units → Matching → Application
```

Four steps. Each one is a component with a clear input, output, and quality bar. If any step breaks, the product doesn't work. If all four work, Matchline is already useful—even without any of the layers.

**Step 1: Career into Experience Units.** The user inputs their career (via resume paste, LinkedIn import, long-form dump, or artifact upload—PRDs, decks, strategy memos, retros), and the system produces a structured graph of atomic, verifiable claims. Each input source captures a different facet of the same career: resumes and LinkedIn compress history into sanitized bullets, long-form prose lets the user narrate context that never made it to a document, and artifacts preserve the specifics—metrics, scope, ownership signals, tradeoff framing—that resume bullets flatten out. Each Unit is a discrete piece of evidence—a shipped project, an owned metric, a technical decision, a managed team—with associated skills, tools, domains, and confidence. The user reviews and corrects. This is the single most important component in the product; everything downstream depends on the quality of these Units.

**Step 2: Job into Requirement Units.** The user pastes a job description, and the system parses it into structured requirements with priority, must-have flags, and signals (seniority, scope, domain). This step is mostly deterministic parsing plus light LLM classification. It's the easiest part of the pipeline, but critical to get right—if the requirements are wrong, the matches are wrong.

**Step 3: Match Units to Requirements.** The matching engine scores each Experience Unit against each Job Requirement Unit and produces a ranked set of matches plus a gap list. The output is a side-by-side view that the user can approve, reject, or promote. The engine's job is not to impress the user with AI; it's to make the user's existing evidence visible and navigable.

**Step 4: Generate an application.** Using only matches the user has approved, the generation engine produces a tailored resume and, optionally, a cover letter. Every claim in the output traces to an approved Experience Unit. The validation layer flags anything that isn't traceable before the user sees it. The user exports, edits if needed, and sends.

That's the product. Four steps, one loop, and a hard constraint on fabrication at every step. If this loop meets the quality bar set by the V1 success metrics, Matchline is already worth using.

### Layers on top of the core loop

These exist to improve the core loop, not to replace it. They are deferred to V2 or later.

- **CRM layer.** People, Companies, Roles, Applications, Interactions. Tracks the pipeline and the relationships around it. V1 includes a lightweight version (enough not to require a spreadsheet); V2 expands it.
- **Workflow layer.** Follow-up reminders, stage transitions, and task management. Makes the CRM active rather than passive.
- **Decision layer.** "Should I apply?" scoring that combines fit score with network signal and role quality. Nice-to-have, not core.
- **Learning layer.** Outcome tracking that improves matching weights and generation quality over time. Requires a data volume that the V1 user won't produce on their own.
- **Network layer.** Relationship graph and referral suggestions. Depends on integrations (LinkedIn, contacts, calendar) that slow V1.

The rest of this document focuses on the core loop. The layers get their own sections at the end, tagged as V2+.

---

## Data model

The data model has two halves: CRM objects (the pipeline) and the Capability Graph (the evidence). They connect through Applications.

### CRM objects

These are standard pipeline objects, kept minimal in V1.

```json
Person {
  id: string,
  name: string,
  role: string,
  company_id: string,
  relationship_type: "recruiter" | "hiring_manager" | "referral" | "peer" | "other",
  last_contacted_at?: timestamp,
  notes?: string
}
```

```json
Company {
  id: string,
  name: string,
  industry?: string,
  size?: "seed" | "early" | "growth" | "mid" | "enterprise",
  priority: "low" | "medium" | "high",
  url?: string,
  notes?: string
}
```

```json
Role {
  id: string,
  company_id: string,
  title: string,
  jd_raw: string,
  jd_url?: string,
  location?: string,
  remote_policy?: "onsite" | "hybrid" | "remote",
  comp_range?: string,
  discovered_at: timestamp
}
```

```json
Application {
  id: string,
  role_id: string,
  stage: "saved" | "drafting" | "applied" | "interviewing" | "offer" | "rejected" | "withdrawn",
  applied_at?: timestamp,
  last_activity_at: timestamp,
  generated_assets: AssetRef[],
  approved_unit_ids: string[]
}
```

```json
Interaction {
  id: string,
  person_id: string,
  application_id?: string,
  type: "email" | "call" | "meeting" | "message" | "note",
  direction: "inbound" | "outbound",
  summary: string,
  occurred_at: timestamp
}
```

### Capability Graph

This is the half of the model that makes Matchline different from every other job-search tool. Experience Units are the atomic evidence; Job Requirement Units are the atomic asks; UnitMatches connect them.

```json
ExperienceUnit {
  id: string,
  source_type: "resume" | "linkedin" | "long_form" | "artifact" | "manual",
  source_ref: string,   // artifact Units use "artifact://<storage-path>#<section-or-page>"
  raw_text: string,
  normalized_summary: string,
  unit_type: "project" | "achievement" | "ownership" | "skill_demo" | "leadership" | "technical_decision",

  // Evidence signals
  skills: string[],
  tools: string[],
  domains: string[],
  seniority_signals: string[],
  scope_signals: string[],
  business_outcomes: string[],
  metrics: Metric[],

  // Provenance
  evidence_type: "verified" | "inferred" | "user_confirmed",
  confidence_score: number,   // 0-1
  user_approved: boolean,

  // Temporal
  date_range?: { start: date, end?: date },

  created_at: timestamp,
  updated_at: timestamp
}
```

```json
Metric {
  claim: string,          // e.g. "reduced latency by 40%"
  value?: number,
  unit?: string,          // "%", "ms", "users", "USD"
  direction?: "up" | "down",
  confidence: "high" | "medium" | "low"
}
```

```json
JobRequirementUnit {
  id: string,
  role_id: string,
  raw_text: string,
  normalized_requirement: string,
  category: "skill" | "tool" | "domain" | "experience_level" | "scope" | "soft_skill" | "credential",

  keywords: string[],
  tools: string[],
  domains: string[],
  seniority_level?: "junior" | "mid" | "senior" | "staff" | "principal" | "director",

  priority: "high" | "medium" | "low",
  must_have: boolean,

  extracted_from: "responsibilities" | "qualifications" | "nice_to_have" | "description"
}
```

```json
UnitMatch {
  id: string,
  experience_unit_id: string,
  job_requirement_unit_id: string,

  semantic_score: number,
  rule_score: number,
  final_score: number,

  rationale: string,
  surface_evidence: string,      // the specific claim being matched

  approved_for_use: boolean,
  user_rejected: boolean,

  created_at: timestamp
}
```

```json
UnitCluster {
  id: string,
  application_id: string,
  label: string,
  experience_unit_ids: string[],
  narrative_purpose: "resume_bullet" | "resume_summary" | "cover_letter_body" | "cover_letter_hook" | "outreach",
  generated_text?: string
}
```

### One note on the model

What ties this together is the distinction between Experience Units (facts about the user) and UnitMatches (relationships to specific jobs). Experience Units are permanent—they belong to the user and persist across every application. UnitMatches are per-application and ephemeral. This means every new job the user targets is a fresh matching problem against a stable base of evidence. It also means the capability graph gets richer over time without bloating, because new Units get added, but old Units don't need to be rewritten for each new role.

---

## Matching engine

The matching engine is the component that users will judge the product by. If the matches feel accurate, the rest of the product earns trust. If the matches feel dumb, nothing else matters.

### Scoring formula

```
final_score = confidence_score × (
  0.30 × semantic_similarity   +
  0.20 × skill_overlap         +
  0.15 × domain_overlap        +
  0.10 × tool_overlap          +
  0.10 × seniority_alignment   +
  0.10 × scope_alignment       +
  0.05 × recency
)
```

Each component is normalized to 0-1 before weighting. The final score gets multiplied by the Experience Unit's confidence score, which means low-confidence units can never produce high-confidence matches. This is intentional: the system should never offer a strong match based on weak evidence.

### Component definitions

- **Semantic similarity.** Cosine similarity between the embedding of the normalized Experience Unit summary and the normalized Job Requirement. Generated once per Unit (cached) and per Requirement (cached per role).
- **Skill overlap.** Jaccard similarity on the canonical skill sets. Requires a skill ontology (see below).
- **Domain overlap.** Same, for domains. Streaming video infrastructure, developer tools, ML platforms, etc.
- **Tool overlap.** Same, for specific tools. React, Kubernetes, Snowflake, etc.
- **Seniority alignment.** Penalty function, not a similarity score. If the Requirement asks for "staff-level" and the Unit's seniority signals read "senior," the score drops, but isn't zero. If the gap is more than one level, the score goes to zero.
- **Scope alignment.** Similar penalty function for scope (team size, budget, customer reach).
- **Recency.** Exponential decay on the Unit's end date. A Unit from five years ago counts less than one from last year. Capped so ancient-but-relevant experience doesn't fall off entirely.

### Skill ontology

The matching engine depends on canonical skill/tool/domain vocabularies. V1 uses a seed ontology built from a corpus of tech PM job descriptions, with LLM-based normalization during extraction. V2 introduces user-specific ontology refinement based on correction patterns.

Non-goal: building a universal skill taxonomy. The product only needs to be right for the V1 user's domain. A tech PM search doesn't need coverage of nursing terminology.

### What the matching engine does not do

- **Does not auto-approve matches.** The engine surfaces matches with scores and rationales; the user approves or rejects. Generation only uses approved matches.
- **Does not hide low-quality matches entirely.** Gaps are surfaced explicitly in a separate view. If the user has no Experience Unit that matches a must-have Requirement, the system indicates as much.
- **Does not pretend to be certain.** Every match includes a confidence component and a surfaced piece of evidence. If the rationale is weak, the user should see that it's weak.

---

## AI pipeline

The pipeline is six stages, some real-time and some async. The split matters for latency and cost.

### Async (happens once per Unit or per Role, cached)

1. **Experience Unit extraction.** The user's career inputs are processed by an LLM with a strict schema to produce structured Units. Runs once per input, with incremental updates when the user adds new material. Artifact uploads (PDF / DOCX / PPTX) are first converted to text via format-specific parsers, then pass through an extraction prompt tuned for prose-heavy sources (PRDs and strategy docs narrate; resumes bullet). Image-only PDFs fail loudly in V1; OCR is deferred. Generates embeddings for semantic search.
2. **Job Requirement parsing.** Each JD gets parsed once into structured Requirements. Cheaper than Unit extraction because JDs are shorter and more structured than resumes.
3. **Embedding generation.** All normalized summaries get embedded with a consumer-grade model (OpenAI text-embedding-3-small or equivalent). Embeddings are stored and reused.

### Real-time (happens per match or per generation)

4. **Matching.** Given a Unit set and a Requirement set, score, and rank. Mostly vector math plus rule-based scoring; minimal LLM calls. Should feel instant.
5. **Generation.** Given approved matches and a target format (resume, cover letter, outreach), generate output grounded in approved evidence. Uses a "controlled generation" prompt pattern: the model receives the approved Units as ground truth and is instructed to only use what's provided.
6. **Validation.** A second LLM call (or a deterministic check) verifies that every claim in the output traces to an approved Unit. Flags anything that doesn't before the user sees the output.

### Model strategy

V1 uses a single frontier model (Claude Sonnet or GPT-4o class) for extraction, matching rationale generation, and validation, with a cheaper model (Haiku or GPT-4o-mini class) for generation where output volume is higher. This can be tuned per stage once there's real data on quality and cost.

### Cost budget

The cost targets from the original doc hold:

- Candidate setup (one-time extraction of career): low single-digit dollars
- Per application (match + generate + validate): under one dollar
- Target p95 full-flow cost: $0.75

Caching is critical. Experience Unit embeddings are cached forever. Job Requirement embeddings are cached per role. Matching is nearly free once embeddings exist. Generation is the main per-application cost and scales linearly with output length.

---

## Validation layer

This is the component that makes "zero fabrication" a hard constraint rather than a wish.

Before any generated output is shown to the user, it goes through validation:

1. **Claim extraction.** Parse the generated output into discrete claims. A resume bullet like "Led migration of Disney+ playback stack to 64-bit NCP, reducing memory footprint 30%" contains three claims: led a migration, worked on the Disney+ playback stack on NCP, and achieved a 30% memory reduction.
2. **Traceability check.** For each claim, verify it maps to an approved Experience Unit. Claims that don't map get flagged.
3. **Specificity check.** Flag generic language ("collaborated cross-functionally to drive results") that doesn't tie to any specific Unit.
4. **Surface to user.** Flagged issues appear as inline annotations on the generated output. The user resolves by either editing, removing, or adding a supporting Unit.

The bar: the user should never see an output with an un-sourced claim. If the model generates one, validation catches it before the user does.

---

## Execution targets

### Latency

| Step | p50 | p95 |
|------|-----|-----|
| Experience Unit extraction (per resume) | 8s | 20s |
| Job Requirement parsing | 1s | 4s |
| Matching (across existing embeddings) | <500ms | 2s |
| Generation (resume) | 3s | 8s |
| Generation (cover letter) | 4s | 10s |
| Validation | 1s | 3s |
| Full flow (paste JD → validated resume) | 6s | 18s |

The full-flow p95 target of under 20 seconds is the user-facing latency commitment. Below that, the flow feels responsive. Above that, it feels like batch processing.

### Cost

| Operation | Target |
|-----------|--------|
| Career extraction (one-time, resume + LinkedIn + long-form) | $2-5 |
| Artifact extraction (per uploaded PRD / deck / strategy doc, p95) | $0.50 |
| Per new role (parsing + matching + generation + validation) | $0.50-1.00 |
| Re-generation of existing application | $0.20-0.50 |

### Reliability

- Structured output failures (malformed JSON, schema violations) retry with stricter prompts up to twice, then surface to user as "needs manual review."
- Validation failures never auto-regenerate. They always surface to the user for explicit approval.
- No silent fallbacks. If the system can't produce a confident result, it says so.

---

## V1 interface

The V1 product has five screens. Each one earns its place in the core loop; nothing ships that isn't directly serving matching or generation.

### 1. Onboarding (one-time)

First-session flow that takes the user from zero to a populated Capability Graph.

- Welcome and brief explanation of the evidence model (two sentences, not a tour).
- Four import options, in priority order:
  - Paste resume text
  - Paste LinkedIn profile HTML (from browser view-source)
  - Paste or write long-form career context
  - Upload career artifacts (PDF / DOCX / PPTX — PRDs, decks, strategy memos, retros; single-file, ~10 MB cap in V1)
- Extraction runs asynchronously with a visible progress indicator, surfacing each pipeline stage (upload → text-extract → LLM → Units committed) for artifact uploads. The user sees Units appearing in real time as they're extracted.
- After extraction, the user lands in the **Unit review** view to approve, correct, or reject each extracted Unit before it is added to the graph. This step is non-skippable; the product's integrity depends on it.

Success criterion for this screen: the user completes onboarding with at least 20 approved Experience Units and a clear understanding of what a Unit is.

### 2. Unit review

The primary interface for maintaining the Capability Graph. The user spends time here during onboarding and whenever they add new career inputs.

- List view of all Experience Units, filterable by skill, tool, domain, date range, source type, and approval status.
- Each Unit shows: normalized summary, raw source, extracted signals (skills, tools, domains, metrics), confidence score, and source provenance. Artifact Units render with a visibly distinct provenance line (e.g. `artifact · retro-q3.pdf · page 2`) that round-trips back to the uploaded file.
- Inline editing for every field. Corrections re-run embeddings for that Unit.
- Approve / reject / flag buttons. Rejected Units are retained but excluded from matching; flagged Units surface in a review queue.
- Two entry CTAs for experiences that didn't come through onboarding: "Add Unit manually" (type a Unit directly) and "Upload an artifact" (drop a file and extract). Both feed the same review queue.

### 3. Role detail

The per-role workspace. One of these exists for every job the user pastes in.

- Header: company, title, JD source URL, application stage, key dates.
- Three tabs:
  - **Requirements**: the parsed Job Requirement Units with priority and must-have flags. Editable if parsing got something wrong.
  - **Matches**: side-by-side view of Experience Units matched to Requirements, with scores and rationales. Gaps surfaced separately. This is the primary decision surface.
  - **Applications**: the generated resumes, cover letters, and outreach drafts for this role, with version history.
- Persistent action bar: "Generate resume," "Generate cover letter," "Export," "Update stage."

The Matches tab is where most per-role time is spent. It's the heart of the product.

### 4. Application editor

The surface where generated output becomes something the user sends.

- Two-pane view: generated output on the left, approved Units on the right.
- Inline annotations mark claims that trace back to specific Units. Hovering a claim highlights its source Unit.
- Validation flags appear as inline badges on any claim that didn't pass traceability or specificity checks. The user can't export without resolving them.
- Standard editing: rewrite, add, remove. Edits preserve traceability when possible; claims that become untraceable through editing get flagged.
- Export to PDF, DOCX, and plain text.

### 5. Pipeline

The CRM-lite view that keeps the user from needing a spreadsheet.

- Kanban-style columns by application stage: Saved, Drafting, Applied, Interviewing, Offer, Rejected, Withdrawn.
- Each card shows: company, title, days in the current stage, next action, and key contact.
- Click through to the role detail for each application.
- Right sidebar: tasks and follow-up reminders (lightweight, not a full task manager).

V1 ends here. No dashboard with charts, no analytics view, no "insights" section. The pipeline is enough to see the state of the search at a glance.

---

## V2+ layers

These are the extensions that build on the core loop. They're deliberately deferred, not because they're unimportant, but because V1 has to prove the loop works before the layers matter.

### CRM expansion

Richer Person and Company objects. Relationship tracking that surfaces who's connected to which roles. Interaction threading that ties emails and messages to specific applications. Integrations with Gmail and Calendar to auto-populate Interactions.

### Workflow automation

Follow-up cadence suggestions based on stage age and interaction history. Stage-transition automations (applied → interview triggers an interview prep reminder). Template library for common outreach patterns.

### Decision engine

"Should I apply?" scoring that combines fit score, network signal, role quality, and user preferences. Outputs a recommendation with visible reasoning. Helps the user focus on the right applications, not more applications.

### Learning layer

Outcome tracking that records which applications led to interviews, offers, and rejections, and feeds those signals back into matching weights and generation prompts. Requires data volume that a single user can't produce alone, so this layer is gated on V2 having real users.

### Network layer

Relationship graph built from LinkedIn connections, email patterns, and user-provided context. Referral suggestions for open applications. Outreach prioritization based on connection strength. Depends on integrations that slow V1 considerably.

### Browser extension

One-click import of job descriptions from LinkedIn, Greenhouse, Lever, Ashby, and Workday. Replaces the paste-every-JD flow from V1. Also, could capture the user's own LinkedIn profile without view-source paste.

### Mobile

Read-only companion app for checking pipeline status, logging interactions, and reviewing generated drafts. Creation and editing stay on the desktop.

---

## Technical principles

These are the rules that govern every decision from V1 forward. If a feature violates one, the feature is wrong.

### Evidence over narrative

Every claim in every generated output must trace to an approved Experience Unit. The validation layer is a hard constraint, not a target. If the system can't generate a traceable output, it surfaces the gap instead of filling it with plausible text.

### User-approved, not AI-approved

Experience Units and UnitMatches enter the generation pipeline only after the user has explicitly approved them. The system never uses its own confidence scores as a substitute for user reviews. This is the cost the user pays for the product's core claim; the UX has to make that cost low, but it can't eliminate it.

### Explainable by default

Every score, match, and generated claim includes its reasoning. The user should never see a recommendation without being able to ask why.

### Fail visibly

When the system can't do something confidently, it says so. No silent fallbacks, no generic generation when matching fails, no hiding low-confidence outputs. Honestly surfacing limitations is a trust-building feature, not a bug.

### One user at a time

V1 is explicitly single-user. No sharing, no collaboration, no team features. This simplifies auth, data model, and UX, and reflects the actual product: a personal tool for a personal search.

### Capability Graph is portable

The user's Experience Units belong to the user. Export to JSON is a V1 feature, not V2. If someone wants to leave Matchline, they should be able to take their structured career with them.

### Cost is a feature

The per-application cost budget is a hard constraint. If a feature blows the budget, the feature gets redesigned, not the budget. Cheap generation is what makes the product sustainable without ad-supported or enterprise business models.

---

## Stack and hosting

### V1 (original target: ship by July 2026)

- **Frontend:** React + TypeScript + Vite + Tailwind
- **Backend:** Firebase Functions (Node)
- **Database:** Firestore
- **Storage:** Firebase Storage (user-scoped artifact uploads at `users/{uid}/artifacts/{filename}`, with Storage rules mirroring the Firestore `owner_uid == auth.uid` invariant)
- **Auth:** Firebase Auth
- **Hosting:** Firebase Hosting (frontend) + Firebase Functions (API)
- **LLM calls:** Anthropic + OpenAI, keys in Firebase secrets
- **Embeddings:** OpenAI text-embedding-3-small, stored in Firestore documents
- **Artifact text extraction:** `pdf-parse` (PDF), `mammoth` (DOCX), `jszip` + slide XML (PPTX), running server-side in Functions

### Rationale

V1 runs on the stack the author already uses daily. Cost of staying is near zero; cost of switching is real time that would come out of shipping. Firestore's document model fits the Capability Graph well enough at V1 scale, and the entire user base for V1 is one person.

### Data model discipline

Even on Firestore, the V1 data model follows Postgres-compatible conventions:

- UUIDs for all primary keys
- Explicit foreign key fields on every relationship
- No business logic embedded in Firestore queries
- Clean separation between Experience Units (permanent) and UnitMatches (per-application)
- All write paths go through a typed service layer, not direct Firestore calls from the UI

This discipline makes a future migration possible without forcing it. If V2 demands Postgres (vector search, graph queries, predictable scaling), the storage swap is a backend change, not a rewrite.

### V2 stack (when justified)

Deferred decision, but the current best guess:

- **Database:** Postgres on Fly.io with pgvector
- **Backend:** Node or Python on Fly.io
- **Vector search:** pgvector in the same Postgres instance
- **Background jobs:** Fly machines with a job queue
- **Auth:** Keep Firebase Auth or migrate to Clerk / Auth.js

---

## Pricing model

### V1

Free during the author's own job search. No paywall, no signup friction, no billing code in V1.

### V2

Single-user individual product: **one-time fee, good for one year, no auto-renew.**

The framing: you'll find a job within a year, and if you don't, the problem isn't Matchline. Pricing is aligned to that claim. Users pay once, get a year of access, and either succeed and move on or re-up if they're still searching.

This model has three useful consequences:

- **Aligned incentives.** The product gets paid when it delivers value to a user beginning a search, not when it extracts subscription revenue from users who forgot to cancel.
- **Clean success metric.** Renewal rate is a direct proxy for "people didn't find jobs." High renewal rate is a bad sign, not a good one.
- **Design pressure toward fast value.** Users need to feel the product's value in the first week, not the first quarter. That's a good constraint.

Specific pricing (amount, tiers, discounts for early users) is a V2 decision. Rough anchoring: a year of Matchline should cost less than an hour of a career coach and more than a single Teal subscription. Somewhere in the $100–250 range feels right, but the exact number can wait.

---

## Resolved questions

Five open questions shaped the V1 design. All five are now resolved:

1. **LinkedIn import:** View-source paste in V1. Browser extension in V2.
2. **Cover letter:** First-class output in V1, generated with the same validation layer as resumes.
3. **Job description source:** Paste-only in V1. Browser extension in V2.
4. **Stack:** Firebase for V1, with data model discipline that keeps Postgres viable for V2.
5. **Pricing:** Free in V1 during author's own search; one-time annual fee with no auto-renew for V2.

---

## What ships first

A sequenced build plan, not a promise.

### Sprint 0: foundations (1 week)
- Firebase project setup, auth, hosting, functions scaffolding
- Frontend shell in React + Vite + Tailwind
- Typed service layer abstraction over Firestore
- LLM client wrappers (Anthropic, OpenAI)

### Sprint 1: the core loop (3 weeks)
- Experience Unit extraction from pasted resume
- Unit review interface
- Job Requirement parsing from pasted JD
- Matching engine with explainable scores
- Resume generation grounded in approved matches
- Validation layer with inline flags

**Milestone:** end-to-end flow from paste resume → paste JD → validated tailored resume.

### Sprint 2: completeness (2 weeks)
- LinkedIn HTML parser
- Long-form career context parser
- Artifact upload + extraction (PDF / DOCX / PPTX) with Firebase Storage wiring, owner-scoped rules, and an extraction prompt tuned for prose-heavy sources
- Cover letter generation
- Application editor with traceability annotations
- Pipeline view (Kanban by stage)
- Export to PDF / DOCX / plain text

**Milestone:** Nathan uses Matchline as the primary tool for his first real application.

### Sprint 3: real use (ongoing)
- Fix everything that breaks during real use
- Tighten extraction quality on Nathan's own resumes
- Improve matching rationales based on Nathan's approval/rejection patterns
- Tune prompts for tone and specificity
- Add manual Unit creation for edge cases

**Milestone:** Nathan ships ten serious applications through Matchline.

After Sprint 3, V1 is done. V2 starts when either Nathan's search ends successfully or when real users other than Nathan enter the picture.

---

## Appendix: what's not in this document

Things that belong in separate documents, not this one:

- **Prompt library.** The extraction, parsing, matching-rationale, generation, and validation prompts are a living artifact that will change often. They belong in a repo, not a PRD.
- **Evaluation harness.** How extraction quality and match accuracy are measured, with test sets and thresholds. Lives in the code.
- **UI mockups.** Text descriptions of screens live here; actual visual mockups live in Figma.
- **Go-to-market plan.** V1 has no GTM. V2 GTM is its own document when the time comes.
- **Competitive analysis.** Teal, Huntr, Simplify, LinkedIn exist. The positioning paragraph in section one handles this; a full matrix is not useful at V1 scale.
- **Hiring plan.** V1 is one person. V2 might not be. That's a V2 document.

---

## Closing

The product this document describes is small and specific. That's intentional. A V1 that works for one person for one real job search is worth more than a V2 vision that never ships. Every decision in this doc—the four-step core loop, the deferred layers, the Firebase stack, the single-user scope, the one-time pricing—points at the same goal: ship something that actually helps Nathan find his next role, and let everything else be earned by what V1 proves.

If Matchline helps one person run a serious search with clarity and credibility, it's succeeded. If it helps more people later, that's a bonus.
