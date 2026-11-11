---
tags:
  - matchline
  - prd
---
<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/matchline/prds/matchline.md
source_ref: a7b0c72c1a692a5529b247a2650d961e436d6b09
project: matchline
document_class: prd
document_slug: matchline
sync_direction: central-to-repo
-->

# Matchline — Product Requirements Document

Version: v0.3 (draft)
Author: Nathan Payne
Last updated: October 22, 2026

**Status (2026-10-22):** Unpaused. V1 was built through the core loop on the stack below (dev instance: `matchline-dev.web.app`) but did not ship by the July 2026 target. The quality result of record is still 48.4% extraction and 19.1% match accuracy against the 80% bars, with p95 full-flow latency of 236 s (matchline#177). Since work resumed in October 2026, the Pipeline board (#510, #511), the follow-ups sidebar (#34), next actions on Pipeline cards (#512), forward-only task completion (#588), follow-ups that come due during the day (#589), Roles saved without a JD (#431), cost attribution (#483), and the export gate's server attestation (#502) have shipped. The fit-brief generator and its private evaluation harness are merged but eval-only (#581). The artifact source type exists in the data model only (#592). The credit-funded evaluation window (matchline#495) runs through November 3; its code has merged, and its paid runs wait on owner approval. Export, cover letters, the canonical résumé, claim rules, the dossier tabs and the weekly scan are not built. LinkedIn import, long-form import and artifact upload are deferred. v0.3 separates what has shipped from the approved target and from deferred work, and it records eight product decisions; see [How to read this document](#how-to-read-this-document) and [Decisions in v0.3](#decisions-in-v03-october-2026). Implementation detail: the repo's `specs/matchline.md`. The repo's `plans/matchline-implementation-plan.md` is historical.

**Status history:** paused pre-launch 2026-07-31; revisiting considered from September 2026, when the job search it was built for resumed (nathanpayne.com project page); unpaused October 2026 with the dossier revision (v0.2, October 19); shipped, target and deferred separated (v0.3, October 22).

---
Matchline is a Career CRM + Capability Graph + AI Application Engine.

Tagline:
From what you've done to what's next.

Wordmark: match|line
Favicon: m|
## Contents

- [How to read this document](#how-to-read-this-document)
- [What Matchline is](#what-matchline-is)
- [Revision: the job-search dossier (October 2026)](#revision-the-job-search-dossier-october-2026)
- [Decisions in v0.3 (October 2026)](#decisions-in-v03-october-2026)
- [Why this exists](#why-this-exists)
- [Who V1 is for](#who-v1-is-for)
- [What the V1 experience is](#what-the-v1-experience-is)
- [What Matchline is not](#what-matchline-is-not)
- [Success metrics for V1](#success-metrics-for-v1)
- [What's shipped, targeted, and deferred](#whats-shipped-targeted-and-deferred)
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
- [Open questions](#open-questions)
- [What ships next (October 2026)](#what-ships-next-october-2026)
- [Historical: the original sprint plan (April 2026)](#historical-the-original-sprint-plan-april-2026)
- [Appendix: what's not in this document](#appendix-whats-not-in-this-document)
- [Closing](#closing)

---

## How to read this document

Every requirement in this PRD is in one of four states. Where a section mixes them, each item is labeled.

- **Shipped.** On `main` in the matchline repository and checked against the code on the date above. A wireframe, a spec entry or a merged data-model field is not evidence that something shipped.
- **Target.** Approved product behavior that is not built yet, or is built only in part. "Not built" does not mean "deferred": a target item stays in scope until a decision moves it.
- **Target (enhancement).** Approved, but not required for the release. An enhancement never blocks a phase exit.
- **Deferred.** Deliberately out of this release by a recorded decision. It may return in a later version.

**Historical** marks sections kept for the record that no longer direct work.

The wireframes (`plans/matchline-wireframes.html` in the matchline repository, #584) draw both shipped screens and target proposals. They illustrate this document; they do not add requirements. Where they disagree, this PRD wins, and the wireframes get corrected.

## What Matchline is

Matchline is a career operating system for one person running a serious job search. It turns your actual work history into structured, reusable evidence, maps that evidence against specific job requirements, and generates tailored applications grounded in what you've actually done. It is not a resume builder, an ATS optimizer, or a generative writer. It is a system for making a job search legible, disciplined, and honest—with yourself and with the people reading your applications.

The core thesis: most job-search tools treat each application as a document-writing problem. Matchline treats it as an evidence problem. You already have the evidence; the work is structuring it, matching it to the right opportunities, and presenting it credibly. The AI helps with all three, but never invents what isn't there.

## Revision: the job-search dossier (October 2026)

While Matchline was paused, the search it was built for went on by hand. From September 2026 that work lived in a private folder of Markdown files, one subfolder per company, kept current with an AI assistant and a few scripts. It has become the clearest specification Matchline has: it shows what one serious search actually produces and what quality bar those artifacts meet. This revision makes that folder the reference product. Where the V1 sections below conflict with this one, this one wins, and [Decisions in v0.3](#decisions-in-v03-october-2026) wins over both.

### What the reference shows

Each opportunity produces a **dossier**, not a résumé. A typical one grows through the process:

- **Before applying:** the captured JD; a **fit brief**; a résumé tailored from the canonical one; a cover letter; answers to application questions; a referral plan or note.
- **During the process:** a prep brief per interviewer, sometimes with a minute-by-minute runbook or flashcards; a debrief after each conversation, written from the transcript; an org map; a running scorecard of the whole loop; a leveling brief before compensation talks.
- **Throughout:** a correspondence log that keeps every sent message verbatim, so what is said later stays consistent with what is already on the record; and a folder index whose first line is "where things stand" and the next action.

Around the dossiers sit a **weekly market scan**, networking call briefs, and event prep.

The **fit brief** is the center of the dossier. It gives a bottom line, maps strengths to specific JD clauses with the evidence behind each, says plainly where the candidate is exposed, sets the positioning and any level strategy, lists homework and questions to ask, and ends with **what this package does not claim**. The résumé, cover letter, and interview prep are all derived from it.

### Three mechanisms behind the quality

1. **One canonical résumé; tailored versions are views of it.** Tailoring keeps canonical bullets verbatim and changes emphasis, order, and selection. Lines rewritten for one company are tracked as deliberate exceptions, and a script reports tailored versions that have gone stale against the canonical. Generation from scratch is the exception, not the method.
2. **Standing claim rules.** A short, durable list of things never to claim or to claim only one way: figures that have been retired, accomplishments that must stay attributed to a specific employer, projects that must not be described as shipped, numbers never to quote. Every package is checked against it, and every fit brief says what it deliberately does not claim.
3. **Primary sources and a corrected record.** Facts about people and companies are checked against transcripts and employers' own pages, not memory or aggregators. When a fact turns out wrong it is fixed once, at its source; unsent artifacts that repeat it are flagged until rebased, sent ones get a linked correction, and every correction is logged. Scans verify every role on the employer's own board and open with "corrections to the record."

### What changes in Matchline

All of these are **target** behavior; none of them has shipped.

- **The unit of work becomes the dossier.** The core loop no longer ends at a generated résumé. It runs from evidence through the fit brief to a package, and on through the interview process. See [The core loop, revised](#the-core-loop-revised-october-2026).
- **Tailored résumés become views of a canonical résumé**, with tracked exceptions. Each tailored view pins the canonical version it was built from. When the canonical changes, the view shows a visible, non-blocking staleness warning and offers **Rebase** or **Keep**; Rebase applies only to unsent views. Nothing silently rewrites a tailored view, and nothing rewrites a package that has been sent: it stays as sent, and a correction to it is a linked record. Experience Units remain the evidence model, and the canonical résumé becomes their primary, user-maintained source. Whether generation should read Units or the canonical lines directly is an open question that matchline#495 tests.
- **Claim rules become data** that the validation layer enforces alongside traceability.
- **The pipeline gains interview rounds, people, correspondence, and next actions**, because that is where most of the search's time actually goes after the application is sent. Next actions have shipped in a first form (tasks, #34 and #512); the rest is target.
- **Two non-goals are reversed:** the market scan and interview preparation. See [What Matchline is not](#what-matchline-is-not).

### Constraint: the owner's data stays private

The Matchline repository is public. The reference folder, and every dossier Matchline produces, is not. Evaluation against the owner's real artifacts reads them at run time from a private location and reports only aggregate results. Nothing from them is ever committed as a fixture, example, or test expectation. The fit-brief harness (#581) enforces this: it refuses to start if its corpus or output path resolves inside the repository, and it prints aggregates only.

## Decisions in v0.3 (October 2026)

The owner settled eight questions that v0.2 left in conflict. Each is applied throughout this document.

1. **Pipeline stages.** The seven shipped stages stay for this release: Saved, Drafting, Applied, Interviewing, Offer, Rejected, Withdrawn. The nine-stage vocabulary proposed in v0.2 is withdrawn. Finer process steps (researching, referral requested, screening, leveling) live inside the dossier, as interview rounds, next actions and correspondence, not as board columns.
2. **Stale tailored résumés.** A tailored résumé pins a canonical version. When the canonical moves, the view shows a visible, non-blocking staleness warning and offers Rebase or Keep; Rebase applies only to unsent views. Nothing silently rewrites a tailored view, and nothing rewrites a sent package: it is immutable, and a correction to it is a linked record. Traceability and claim-rule failures stay blocking. This is target behavior until canonical versioning exists.
3. **Career imports.** LinkedIn import (#28), long-form import (#29) and artifact upload (#87) are deferred. The `artifact` source type and `artifact://` reference format (#592) are a data-model change only; they do not count as shipped upload or parsing.
4. **Exit test.** The replacement test replaces "ten serious applications": new opportunities run in Matchline instead of in hand-built dossier folders. Two intermediate tests come first: a grounded, claim-rule-compliant package sent with only light edits, then one live process managed through every round. Owner-preference review is a manual acceptance step, not a capability of the evaluation harness.
5. **Application Editor vs. Package.** The Package tab is the home for editing, validation and export. An expanded editor can be another view of the same package, never a separate artifact or workflow. The shipped Application Editor is transitional.
6. **Aggregator results in Scan.** A role found only on an aggregator stays in Scan as an unverified lead. It cannot become a scan-created Role, or count as a verified opportunity, until it is confirmed against the employer's own posting. The discovery source (where a lead was seen) is recorded separately from the authoritative source (the employer's posting). This does not authorize scraping aggregators.
7. **Role provenance.** The target Role schema gains minimal provenance: whether the Role was entered by hand or created from a scan, and a source URL when one is available. The target New Role form has Company and Source fields, as the wireframes draw it. The shipped form has neither, so adding and persisting them is implementation work.
8. **Phone layouts.** Agreed V1 workflows get responsive web layouts down to phone widths. This adds no native apps, no offline support, and no separate mobile feature set.

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

1. **Import their career.** Paste a résumé. The system extracts structured Experience Units—atomic, verifiable claims about what they've done, with attached skills, tools, domains, metrics, and confidence scores. The user reviews, corrects, and confirms. *Shipped for pasted résumés.* LinkedIn import, long-form context, and artifact upload (PRDs, decks, strategy memos, retros) are *deferred* (decision 3).

2. **Add a target role.** Paste a job description, or save the Role with only a title and paste the JD later. The system parses it into structured Job Requirement Units with priority and must-have flags. *Shipped.*

3. **See the match.** A view showing which Experience Units map to which Requirements, which requirements are covered, and which are gaps. Gaps are surfaced honestly, not hidden. *Shipped.*

4. **Generate an application.** A tailored résumé and optional cover letter, grounded only in approved Experience Units, with every claim traceable to a source. Nothing generated that isn't backed by an actual unit of experience. *Résumé generation and validation are shipped, but a new draft is shown before validation runs, so traceability is enforced at the export gate, not at display. Validation before display, cover letters and export are target.*

5. **Track the application.** Stage, how long since the last activity, the next action, and the key contact. CRM-lite from day one. *Shipped on the Pipeline board.* Who's involved depends on People and Interactions, which have no entry UI yet.

The first-session success criterion: the user generates one application they would actually send in under fifteen minutes, without editing out any fabricated claims. That's the V1 bar. It cannot be met yet, because export is not built, and the measured full flow is slower than the target (see [Execution targets](#execution-targets)).

## What Matchline is not

Stating non-goals explicitly so they don't sneak back in as features:

- **Not an ATS keyword stuffer.** If the system suggests a keyword, it's because the user has genuine experience with it, not because the JD asked for it.
- **Not a generative writer.** The AI assembles and rephrases; it never introduces claims the user hasn't confirmed.
- **Not a job board.** No scraping of aggregator listings, no feed of "jobs you might like." *Revised October 2026:* Matchline does run a scheduled **scan of employer boards the user names** (target). It verifies each role on the employer's own posting, sorts results into tiers against the user's evidence, and states every gap. A role seen only on an aggregator can sit in Scan as an unverified lead, but it never becomes a scan-created Role or counts as a verified opportunity until the employer's posting confirms it (decision 6). That retention does not authorize scraping aggregators. The user still decides which roles exist for them; the scan saves the weekly legwork of checking those boards. This was a stated non-goal in v0.1 and is reversed because the manual weekly scan proved to be one of the highest-value recurring tasks of the search.
- **Not a mass-apply tool.** Matchline is for people applying to fewer roles with more care, not more roles with less. It drafts and logs submissions; it never submits an application or sends a message without the user's explicit action.
- **Not a coaching product.** No generic career advice, no "should you leave your current role." *Revised October 2026:* **interview preparation and debriefs are in scope** (target), grounded in the same evidence and the same claim rules as the application. v0.1 limited the scope to the application itself. In practice, most of the search's effort and most of its risk come after the application: prep for each interviewer, staying consistent with what is already on the record, and capturing what each conversation revealed.
- **Not a team or enterprise product.** Single-user, personal data, no sharing or collaboration in V1.
- **Not a replacement for networks.** The network graph (V2+) augments outreach; it doesn't replace real relationships.
- **Not a native mobile app.** V1 is a responsive web app (decision 8). Phone layouts cover the agreed V1 workflows; there is no native app, no offline mode, and no separate mobile feature set.

## Success metrics for V1

V1 is a single-user tool, so traditional product metrics don't apply. Instead:

**Primary metric: the replacement test (decision 4).** For new opportunities, the owner stops building dossier folders by hand and runs them in Matchline instead. Two intermediate tests come first, in order:

1. **A fit brief and a sendable package.** For a new role, a fit brief and a package (tailored résumé, cover letter) that pass traceability and the claim rules, and that the owner sends with only light edits.
2. **One live process.** One real process managed in Matchline through every round, from application to its outcome.

The v0.1 measure, "used end to end for at least ten serious applications," is withdrawn. Issue #43 still carries that milestone and should be retitled to match.

**Quality metrics.**
- Experience Unit extraction: at least 80% of extracted units are accurate and useful without user editing, across a test set of ten resumes (mine plus nine others). Result of record: 48.4% (#177).
- Match accuracy: at least 80% of proposed matches between Experience Units and Job Requirements hold up to manual review. Result of record: 19.1% (#177).
- Zero fabrication: no generated application contains a claim that can't be traced to an approved Experience Unit. This is a hard constraint, not a target.

Ten résumés carry extraction labels, and four résumé-and-JD pairs carry match labels; the #177 run scored the four pairs. The 80% bars stand, and matchline#495 does not reset the baseline.

**Speed metrics.**
- Full flow (paste JD → validated résumé) under 20 s at p95. Result of record: 236 s (#177).
- Per-application cost under one dollar, including all LLM calls, with a p95 target of $0.75.

**Search outcome metrics.** Ultimately, does the user get interviews and offers for roles that matter? This is noisy at N=1, but it's the real test. A version of this tool that generates beautiful applications that never convert is a failed tool.

**Artifact quality metrics (added October 2026).** Component accuracy says whether the parts work; these say whether the output is worth using. They are measured privately against the owner's own approved fit briefs (matchline#495). The harness for the first three is built (#581) but has not had a paid run.

- **Grounding (hard gate).** Every evidence quote in a generated brief must appear verbatim in the canonical résumé or skills inventory; this check is deterministic. A judge model also lists any statement about the candidate that the sources don't support. Any finding fails the brief.
- **Claim rules (hard gate).** The same judge lists claim-rule violations against a private claim-rules file. Zero tolerance. This check is model-graded.
- **Coverage and verdict.** The judge scores the generated brief's recall and precision against the strengths and gaps the owner's reference brief identifies, each tied to a JD clause, and whether it reaches the same verdict. Model-graded, with the judge named in every report.
- **Owner preference (manual acceptance step).** The owner rates generated and reference briefs side by side, unlabeled, on the held-out pairs. This is a human review step in the evaluation plan, not a capability of the harness, and three pairs support a direction, not a quality claim.

## What's shipped, targeted, and deferred

The original V1 target was to ship to one user by July 2026; it was missed (see Status above).

**Shipped** (on `main` as of October 22, 2026):
- Sign-in with Google or email and password, with no self-service sign-up; access is limited to an owner allowlist enforced in every callable and in the Firestore rules.
- Career ingestion from a pasted résumé, with streamed progress, into Experience Units.
- Unit Review: filters, inline editing, approve, flag and reject, and manual Unit entry. A manually entered Unit, or one whose raw text or summary is edited, is marked `reembed_pending` and stays out of matching until it is embedded; nothing in the client triggers that yet.
- New Role, including Roles saved with only a title (#431).
- Job Requirement parsing with priority and must-have flags. The JD can be edited and re-parsed; parsed Requirements can't be edited one by one.
- The matching engine with explainable scores, rationales, gaps and unverifiable matches, and re-run.
- Résumé generation grounded in approved matches.
- Validation: claim extraction, traceability and specificity checks, inline annotations, and an export gate that requires the server's attestation (#502).
- The Pipeline board: seven stages, drag-and-drop and keyboard moves, days since the last activity (labeled "days in stage"), the next action, the key contact, and the tasks and follow-ups sidebar (#510–#512, #34).
- Cost attribution per LLM call (#483).

**Target, core** (approved and required for this release):
- Export to PDF, DOCX and plain text (#33), from the Package.
- Cover letter generation (#30), with the same grounding and validation as résumés.
- Capability Graph JSON export (#35).
- The canonical résumé as line-addressable, versioned data, with tailored views that pin a version, Rebase (unsent views only) or Keep, and a non-blocking staleness warning (decision 2).
- Claim rules as data, enforced as a blocking validation check.
- The fit brief as a first-class artifact on the Role.
- The dossier: Role detail with "where things stand," the next action, and the five target tabs (Fit brief, Requirements & matches, Package, Process, Correspondence).
- Interview rounds with prep briefs and debriefs, the scorecard, the leveling brief, and the verbatim correspondence log.
- Company and People entry, and Role provenance (decision 7).
- Target navigation: Pipeline, Evidence, Scan and New Role.
- The weekly scan of employer boards the user names, with employer-board verification and tiering (decision 6).
- Workflow automations: prep briefs opened for scheduled rounds, debriefs drafted from transcripts, thank-you notes drafted from debriefs.
- Responsive web layouts for these workflows, down to phone widths (decision 8).
- Unit Review completion: a source-type filter; embed a Unit after an inline edit or a manual add (the `reembedExperienceUnit` callable exists but has no client call site or trigger), and a view for reviewing and restoring rejected Units (`listRejectedExperienceUnits()` exists with no caller).

**Target, enhancements** (approved, never release-blocking): see [Core requirements and enhancements](#core-requirements-and-enhancements).

**Deferred:**
- LinkedIn import (#28), long-form context import (#29), and artifact upload (#87 and its children #519, #520, #522, #524, #526 and #528). Export's children (#517, #521, #523, #525, #527) belong to #33 and are not deferred.
- A story bank, and outreach drafting (messages to people who are not yet part of an Application's process)
- Outcome learning system (needs more data than one user generates)
- Network graph and referral engine (requires integrations that slow V1)
- Decision engine / "should I apply" scoring (nice-to-have, not core loop)
- Multi-user / sharing/team features
- Integrations with job boards or ATS systems, including aggregator scraping
- Native mobile apps, offline support, or a separate mobile feature set
- Any generalization beyond my own search

## Why me, why now

I've spent ten years at Disney shipping streaming video infrastructure across device ecosystems that don't forgive imprecision—PlayStation, Xbox, Fire TV, set-top boxes, smart TVs. I've lived the reality that credibility in a technical domain comes from specific, verifiable evidence, not a polished narrative. I've also spent the last six months vibe-coding side projects that gave me the stack and the habits to build this quickly: React, TypeScript, Vite, Tailwind, and Firebase.

The layoff was the forcing function. My last day was June 20, 2026, and I wanted a tool by then that would make my search honest and efficient, and I don't want to run it the way I've watched dozens of friends run theirs. If the tool works for me, it probably works for other thoughtful senior operators in the same position. That's the V2 case. V1 is personal.

---

## Product structure

Matchline is built around a single core loop and a set of layers that extend it. The core loop is what makes the product work at all; everything else is a layer that makes the core loop better over time. This distinction matters because it tells you what to build first, what to build next, and what to cut when scope pressure shows up.

### The core loop

```
Career → Experience Units → Matching → Application
```

Four steps. Each one is a component with a clear input, output, and quality bar. If any step breaks, the product doesn't work. If all four work, Matchline is already useful—even without any of the layers. Steps 1–3 and résumé generation in step 4 are **shipped**; export is target.

**Step 1: Career into Experience Units.** The user inputs their career and the system produces a structured graph of atomic, verifiable claims. Each Unit is a discrete piece of evidence—a shipped project, an owned metric, a technical decision, a managed team—with associated skills, tools, domains, and confidence. The user reviews and corrects. This is the single most important component in the product; everything downstream depends on the quality of these Units. *Shipped input:* a pasted résumé. *Deferred inputs* (decision 3): LinkedIn import, long-form prose, and artifact upload. Each would capture a different facet of the same career: resumes and LinkedIn compress history into sanitized bullets, long-form prose lets the user narrate context that never made it to a document, and artifacts preserve the specifics—metrics, scope, ownership signals, tradeoff framing—that resume bullets flatten out.

**Step 2: Job into Requirement Units.** The user pastes a job description, and the system parses it into structured requirements with priority, must-have flags, and signals (seniority, scope, domain). This step is a single LLM parse of the whole JD into structured Requirements, followed by embedding. It's the easiest part of the pipeline, but critical to get right—if the requirements are wrong, the matches are wrong.

**Step 3: Match Units to Requirements.** The matching engine scores each Experience Unit against each Job Requirement Unit and produces a ranked set of matches plus a gap list. The output is a view that the user can approve or reject. The engine's job is not to impress the user with AI; it's to make the user's existing evidence visible and navigable.

**Step 4: Generate an application.** Using only matches the user has approved, the generation engine produces a tailored résumé and, as a target, a cover letter. Every claim in the output must trace to an approved Experience Unit. The validation layer flags anything that isn't traceable, and export stays blocked until validation passes. Today the draft is shown before validation runs, so the export gate is where traceability is enforced; validation before display is target. The user edits if needed, exports (target), and sends.

That's the product. Four steps, one loop, and a hard constraint on fabrication at every step. If this loop meets the quality bar set by the V1 success metrics, Matchline is already worth using.

### The core loop, revised (October 2026)

```
Evidence → Role → Fit brief → Package → Process
```

This is the **target** loop. Matching, résumé generation and validation from the original loop are shipped inside it; the canonical résumé, claim rules, fit brief on the Role, Package, and Process are not.

- **Evidence.** The canonical résumé (user-maintained, line-addressable, versioned), the Experience Units extracted from it and from other sources, and the claim rules. A story bank is deferred.
- **Role.** The captured JD, parsed into Requirement Units, with company, comp band, location, and provenance (decision 7). Roles arrive by manual entry or, once verified on the employer's posting, from the scan.
- **Fit brief.** The decision document. It covers the bottom line, strengths tied to JD clauses with evidence, where the candidate is exposed, positioning and level strategy, homework, questions to ask, and what the package does not claim. Matching (step 3 above) now serves this step: approved matches are the brief's evidence.
- **Package.** A tailored résumé as a view of the canonical, a cover letter, application answers, and a referral note, each positioned by the fit brief, validated for traceability and against the claim rules, and exported. The Package is where these artifacts are edited, validated and exported (decision 5).
- **Process.** Correspondence, interview rounds (prep brief, then debrief), a running scorecard, and the leveling brief, each grounded in the dossier so far.

Steps 1–4 of the original loop still exist inside this one. What changed is where the loop ends: at the end of the process, not at an exported résumé.

### Layers on top of the core loop

These exist to improve the core loop, not to replace it. They are deferred to V2 or later, except for the parts [V2+ layers](#v2-layers) marks as pulled forward.

- **CRM layer.** People, Companies, Roles, Applications, Interactions. Tracks the pipeline and the relationships around it. V1 includes a lightweight version (enough not to require a spreadsheet); V2 expands it. *Shipped:* the types, the Pipeline's reads, and Roles and Applications. *Target:* entry UI for Companies and People, which do not have one yet.
- **Workflow layer.** Follow-up reminders, stage transitions, and task management. Makes the CRM active rather than passive. *Shipped:* tasks, follow-ups and stage moves on the Pipeline.
- **Decision layer.** "Should I apply?" scoring that combines fit score with network signal and role quality. Nice-to-have, not core.
- **Learning layer.** Outcome tracking that improves matching weights and generation quality over time. Requires a data volume that the V1 user won't produce on their own.
- **Network layer.** Relationship graph and referral suggestions. Depends on integrations (LinkedIn, contacts, calendar) that slow V1.

The rest of this document focuses on the core loop. The layers get their own sections at the end, tagged as V2+.

---

## Data model

The data model has two halves: CRM objects (the pipeline) and the Capability Graph (the evidence). They connect through Applications.

Every shipped CRM and Capability Graph document also carries `owner_uid`, stamped by the service layer and enforced by the Firestore rules. The server-only `llm_calls` cost ledger is the exception: clients cannot read or write it at all, and it records an optional `ownerUid` instead. The schemas below omit it. The repo's `specs/matchline.md` and the TypeScript types are authoritative for shipped fields.

### CRM objects

These are standard pipeline objects, kept minimal in V1. All five types and `Task` are **shipped** as types. Companies, People and Interactions have no entry UI yet: New Role stamps a placeholder `company_id`, and the Pipeline reads People and Interactions only to show a key contact.

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
  jd_raw: string,               // "" means a lead saved before its JD (#431)
  jd_url?: string,
  location?: string,
  remote_policy?: "onsite" | "hybrid" | "remote",
  comp_range?: string,
  discovered_at: timestamp,

  // Target (decision 7): provenance. Not in the shipped type.
  origin: "manual" | "scan",
  source_url?: string           // where the Role came from, when there is a URL
}
```

`origin` is `scan` only for a Role created from a scan result that was verified on the employer's posting; that posting is the Role's `jd_url`, and `source_url` keeps where the lead was seen (the scan result's `discovery_url`). The target New Role form has a **Company** field and a **Source** field. The shipped form has neither: it stamps a placeholder `company_id` and records no source. Adding both fields and persisting them to `company_id` and `source_url` is implementation work. A non-URL source, such as a referral, has no field in this schema; see [Open questions](#open-questions).

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

The seven stages are the release vocabulary (decision 1). Today an Application is created only when the user generates a résumé for a Role, and it starts in Drafting, so a Role saved as a lead does not appear on the Pipeline until then.

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

```json
Task {
  id: string,
  application_id: string,
  title: string,
  due_at?: timestamp,
  completed: boolean,
  created_at: timestamp
}
```

`Task` shipped with #34. Completing one stamps the Application's `last_activity_at`, and completion is forward-only (#588). A Pipeline card's next action is its Application's first open task (#512).

### Capability Graph

This is the half of the model that makes Matchline different from every other job-search tool. Experience Units are the atomic evidence; Job Requirement Units are the atomic asks; UnitMatches connect them. All of these are **shipped**. `UnitCluster`, below, is declared as a type and in the Firestore rules, but nothing writes or reads it yet.

```json
ExperienceUnit {
  id: string,
  source_type: "resume" | "linkedin" | "long_form" | "artifact" | "manual",
  source_ref: string,   // artifact Units use "artifact://users/{uid}/artifacts/{filename}#{section-or-page}"
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

Only résumé extraction and manual entry create Units today. The `linkedin`, `long_form` and `artifact` source types are reserved for deferred inputs, though the Unit Review editor still lets the user set any of the five on an existing Unit; the `artifact://` `source_ref` format and its build and parse helpers shipped with #592 as a data-model change, with no upload, storage, document parsing or extraction behind them. The shipped Unit also carries `rejected` and `flagged` flags alongside `user_approved`, plus its stored `embedding` and a `reembed_pending` flag that keeps it out of matching until the embedding is current. Every persisted object, in this section and the CRM one, also carries an `owner_uid`.

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

The shipped `UnitMatch` also carries its `role_id`, since matches are stored per Role, and records per-axis `components`, whether each axis was actually evaluated (`component_applicability`), whether the pair has `structural_evidence`, and a `schema_version`. The spec defines how readers must treat them.

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

### Dossier objects (added October 2026)

**Target.** Sketches, not final schemas. Field names follow the existing conventions. None of these is persisted today. The fit-brief generator (#581) emits the `FitBrief` fields below, but only inside the evaluation harness, and its strengths cite verbatim evidence quotes rather than line ids, because canonical lines do not exist yet.

```json
CanonicalResume {
  id: string,
  version: string,              // bumps on every edit; tailored views pin one
  lines: ResumeLine[]           // stable ids, so a view can reference a line
}

ResumeLine {
  id: string,
  section: string,              // "headline" | "summary" | "<employer>" | "skills" | ...
  text: string,
  experience_unit_ids: string[] // the Units this line evidences
}

TailoredResume {
  id: string,
  application_id: string,
  canonical_version: string,    // the pinned version; changes only on an explicit Rebase, and never once sent
  line_ids: string[],           // selection and order
  exceptions: { line_id?: string, text: string, reason: string }[], // deliberate rewrites, tracked
  sent_at?: timestamp           // set when the package is marked sent; read-only from then on
}

ClaimRule {
  id: string,
  kind: "never_claim" | "attribute_only_to" | "never_imply_shipped" | "retired_figure" | "phrasing",
  statement: string,            // the rule as the user wrote it
  applies_to?: string,          // e.g. the employer an accomplishment must stay attributed to
  added_at: timestamp
}

FitBrief {
  id: string,
  role_id: string,              // a hand-entered Role can have a brief before it has an Application
  frozen_at?: timestamp,        // set when the package is sent
  bottom_line: string,
  strengths: { jd_clause: string, evidence_line_ids: string[], argument: string }[],
  exposures: { jd_clause: string, gap: string, handling: string }[],
  positioning: string,
  level_strategy?: string,
  homework: string[],
  questions_to_ask: string[],
  does_not_claim: string[],
  verdict: "apply" | "hold" | "referral_needed" | "skip"
}

InterviewRound {
  id: string,
  application_id: string,
  kind: "recruiter_screen" | "hiring_manager" | "panel" | "leadership" | "leveling" | "other",
  interviewer_person_ids: string[],
  scheduled_at?: timestamp,
  prep_brief?: string,
  transcript_ref?: string,       // e.g. a meeting-notes source; transcripts stay with the user
  debrief?: string,
  signal?: "warm" | "neutral" | "cool" | "unknown"
}

Correspondence {
  id: string,
  application_id?: string,
  person_ids: string[],
  direction: "inbound" | "outbound",
  status: "drafted" | "sent" | "received",
  subject?: string,
  body_verbatim: string,         // what was actually sent, kept exactly
  occurred_at: timestamp
}

ScanResult {
  id: string,
  scan_run_id: string,
  company_id: string,
  title: string,
  discovery_source: string,      // where the lead was seen: an employer board, an aggregator, a referral
  discovery_url?: string,
  employer_posting_url?: string, // the authoritative source; set only once verified
  verified_on_employer_board: boolean,
  comp_as_posted?: string,
  tier: 1 | 2 | 3,
  lines_up: string[],
  exposed: string[],
  referral_needed: boolean
}

Correction {
  id: string,
  target_ref: string,           // the record corrected: a canonical line, a Unit, a Role field, a sent package or message
  what_was_wrong: string,
  corrected_text: string,
  found_via: string,            // how it was found, e.g. a transcript or the employer's posting
  logged_at: timestamp
}
```

Next actions are the shipped `Task` (see CRM objects). The v0.2 `NextAction` sketch is folded into it; attaching a task to a person rather than an Application is a possible extension, not a requirement.

A `ScanResult` with `verified_on_employer_board: false` is an unverified lead. It cannot be turned into a Role until `employer_posting_url` is set by verification (decision 6).

`Application` gains `tailored_resume_id`; the fit brief hangs off the Role by `role_id`. A package is sent when its tailored résumé's `sent_at` is set; from then on the view and the fit brief are read-only, and a fix to either is a `Correction` linked to it. Its `stage` keeps the seven shipped values (decision 1); finer steps such as a requested referral, a recruiter screen or a leveling conversation are recorded as interview rounds, next actions and correspondence. `Interaction` is superseded by `Correspondence` for messages and by `InterviewRound` for conversations.

The wireframes draw an **org map** on the Process tab. It has no data model; it is an enhancement, and it would be derived from People attached to the Application's rounds and correspondence.

### One note on the model

What ties this together is the distinction between Experience Units (facts about the user) and UnitMatches (relationships to specific jobs). Experience Units are permanent—they belong to the user and persist across every application. UnitMatches are per Role and are regenerated on every matching run. This means every new job the user targets is a fresh matching problem against a stable base of evidence. It also means the capability graph gets richer over time without bloating, because new Units get added, but old Units don't need to be rewritten for each new role.

---

## Matching engine

The matching engine is the component that users will judge the product by. If the matches feel accurate, the rest of the product earns trust. If the matches feel dumb, nothing else matters. The engine below is **shipped**; its measured match accuracy is 19.1% against the 80% bar (#177).

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

The formula and weights above are shipped. Each axis has its own fallback when the Requirement doesn't constrain it: skill, tool and domain overlap score a neutral 0.5; seniority alignment scores 1.0; scope alignment scores 1.0 for a Requirement outside the scope category and 0.5 for a scope Requirement with no keywords; recency scores 0.5 for a Unit with no usable date. None of these is a measurement, and the score breakdown labels an unevaluated axis "not evaluated." #433 proposes dropping such axes and renormalizing the weights instead.

### Component definitions

- **Semantic similarity.** Cosine similarity between the embedding of the normalized Experience Unit summary and the normalized Job Requirement. Generated once per Unit (cached) and per Requirement (cached per role).
- **Skill overlap.** Jaccard similarity on the canonical skill sets. Requires a skill ontology (see below).
- **Domain overlap.** Same, for domains. Streaming video infrastructure, developer tools, ML platforms, etc.
- **Tool overlap.** Same, for specific tools. React, Kubernetes, Snowflake, etc.
- **Seniority alignment.** Penalty function, not a similarity score. If the Requirement asks for "staff-level" and the Unit's seniority signals read "senior," the score drops to 0.5. If the gap is more than one level, the score goes to zero. A Unit with no seniority signals scores zero; one whose signals don't map to the ladder scores 0.5.
- **Scope alignment.** *Shipped:* a Requirement whose category isn't `scope` scores 1.0 (no constraint). For a scope Requirement, the score is the Jaccard overlap between the Unit's scope signals and the Requirement's keywords, with the same empty-set rules as skill overlap. *Target:* a penalty function over scope levels (team size, budget, customer reach), like seniority's; it needs a scope ladder, which does not exist yet.
- **Recency.** Exponential decay on the Unit's end date. A Unit from five years ago counts less than one from last year. Capped so ancient-but-relevant experience doesn't fall off entirely.

### Skill ontology

The matching engine depends on canonical skill/tool/domain vocabularies. V1 uses a seed ontology built from a corpus of tech PM job descriptions. Extraction asks the model for canonical forms, and matching applies deterministic normalization at match time (`functions/src/matching/normalize.ts`); stored Units keep the extracted strings. V2 introduces user-specific ontology refinement based on correction patterns.

Non-goal: building a universal skill taxonomy. The product only needs to be right for the V1 user's domain. A tech PM search doesn't need coverage of nursing terminology.

### What the matching engine does not do

- **Does not auto-approve matches.** The engine surfaces matches with scores and rationales; the user approves or rejects. Generation only uses approved matches.
- **Does not hide low-quality matches entirely.** The Matches tab shows each Requirement's top five matches, low scores included. Gaps are surfaced explicitly in a separate view: if the user has no Experience Unit that matches a must-have Requirement, the system indicates as much. Nice-to-have Requirements are not listed there. A must-have whose only match can't be verified is reported separately from one with no match.
- **Does not pretend to be certain.** Every match includes a confidence component and a surfaced piece of evidence. If the rationale is weak, the user should see that it's weak.

---

## AI pipeline

The pipeline is six stages, some real-time and some async. The split matters for latency and cost.

### Async (happens once per Unit or per Role, cached)

1. **Experience Unit extraction.** The user's career inputs are processed by an LLM with a strict schema to produce structured Units. Runs once per pasted input; each new paste adds a fresh set of Units, with no merge or de-duplication against existing ones. Generates embeddings for semantic search. *Shipped* for pasted résumés, measured at about 108 s per extraction, with progress streamed to the client. *Deferred* (decision 3): artifact uploads (PDF / DOCX / PPTX) converted to text by format-specific parsers and passed through an extraction prompt tuned for prose-heavy sources, with image-only PDFs failing loudly.
2. **Job Requirement parsing.** Each JD gets parsed once into structured Requirements. Cheaper than Unit extraction because JDs are shorter and more structured than resumes. *Shipped.*
3. **Embedding generation.** Extracted Units and parsed Requirements are embedded with OpenAI `text-embedding-3-small`. Embeddings are stored and reused. *Shipped.* A manually added or text-edited Unit has no current embedding and stays out of matching until a re-embed caller exists.

### Real-time (happens per match or per generation)

4. **Matching.** Given a Unit set and a Requirement set, score, and rank. Vector math plus rule-based scoring, with rationales from a deterministic template; no LLM calls. Should feel instant. *Shipped.*
5. **Generation.** Given approved matches and a target format, generate output grounded in approved evidence. Uses a "controlled generation" prompt pattern: the model receives the approved Units as ground truth and is instructed to only use what's provided. *Shipped:* the résumé. *Target:* cover letter, application answers, referral note, and the fit brief as a product surface. *Deferred:* outreach drafting.
6. **Validation.** LLM claim extraction, traceability and specificity checks (the specificity check also passes the model a deny-list hint for vague PM phrases) verify that every claim in the output traces to an approved Unit, and flag anything that doesn't. *Shipped*, but it runs after the draft is shown, not before: see [Validation layer](#validation-layer).

### Model strategy

Each stage's model is configuration, not code. The **shipped** production defaults are:

| Stage | Model |
|---|---|
| Extraction | Claude Sonnet 4.6 |
| Requirement parsing | Claude Haiku 4.5 |
| Match rationale | None: a deterministic template (`generateRationale()`, #100). The config's `rationale` entry (Sonnet 4.6) is set but unused. |
| Generation | Claude Haiku 4.5 |
| Validation | Claude Sonnet 4.6 |
| Embeddings | OpenAI `text-embedding-3-small` |

The Claude 5.5 family is wired for evaluation runs only (#579): it is not a production default. The fit-brief generator (#581) takes its model as an explicit argument and adds no production default. Any change to the production defaults follows matchline#495's measured recommendation, in its own approved change.

### Cost budget

The cost targets from the original doc hold:

- Candidate setup (one-time extraction of career): low single-digit dollars
- Per application (match + generate + validate): under one dollar
- Target p95 full-flow cost: $0.75

Every LLM call is now priced on a shared rate table and attributed by task (#483), so these targets can be checked against measured spend.

Caching is critical. Experience Unit embeddings are cached until the Unit's raw text or summary changes, which marks it `reembed_pending`. Job Requirement embeddings are cached per role. Matching is nearly free once embeddings exist. Generation is the main per-application cost and scales linearly with output length.

---

## Validation layer

This is the component that makes "zero fabrication" a hard constraint rather than a wish.

Validation runs four steps, all **shipped**:

1. **Claim extraction.** Parse the generated output into discrete claims. A resume bullet like "Led migration of Disney+ playback stack to 64-bit NCP, reducing memory footprint 30%" contains three claims: led a migration, worked on the Disney+ playback stack on NCP, and achieved a 30% memory reduction.
2. **Traceability check.** For each claim, verify it maps to an approved Experience Unit among the Units its bullet cites. Claims that don't map get flagged.
3. **Specificity check.** Flag generic language ("collaborated cross-functionally to drive results") that doesn't tie to any specific Unit.
4. **Surface to user.** Flagged issues appear as inline annotations on the generated output. Today the user resolves a flag by removing the bullet or undoing the change. Editing a bullet clears its cited Units, so an edited or added bullet is flagged as untraceable when validation runs again, and "Add a supporting Unit" creates a Unit without attaching it to the bullet. *Target:* edits that keep or re-establish traceability, and attaching a new Unit to the bullet it supports.

**When it runs (shipped).** Generation saves the résumé with validation pending and opens it in the Application Editor at once, so the user sees an unvalidated draft. Validation runs when the user saves a text edit or chooses "Re-run validation"; removing or adding a bullet marks the draft unvalidated (`validation_status: "stale"`, which is unrelated to staleness against the canonical) until validation is re-run. Export stays blocked until it passes. The guarantee that holds today is that nothing unvalidated can be exported, not that nothing unvalidated is ever shown.

**The bar (target, not met).** The user should never see an output with an un-sourced claim: if the model generates one, validation catches it before the user does. That needs validation to run automatically between generation and display.

**Export gate (shipped).** The verdict is attested by the server, not by the asset (#502). Export is enabled only when the server's attestation for the asset's current content says it passed, and every Unit that content cites is still at the version validation read. An edit makes the content unvalidated until validation runs again. *Target:* once tailored views pin a canonical version, a canonical edit that changes a Unit a kept view cites is staleness against the canonical, not an attestation failure: the gate checks the view against the Unit versions its pinned canonical carried, so a kept view stays exportable (decision 2).

**Claim-rule check (target).** A third check, beside traceability and specificity, runs every generated artifact against the user's ClaimRules: fit briefs, résumé exceptions, cover letters, answers, prep briefs, and drafted messages. A violation blocks export like an untraceable claim does. Adding supporting evidence repairs traceability but never clears a claim-rule hit: the text must change, or the user must explicitly change the rule. Traceability asks "is this backed by evidence?"; the claim-rule check asks "is this a thing the user has decided never to say, or to say only one way?" Both are needed. A true, traceable claim can still be one the user has retired. Claim rules do not exist as data yet; today they reach only the fit-brief harness, as a private text file.

**Staleness against the canonical (target, non-blocking).** A tailored résumé built from an older canonical version passes or fails validation on its own content. Its staleness is reported as a visible warning next to the validation results, with Rebase (unsent views only; a sent package keeps its pinned version) and Keep, and never blocks export (decision 2). Traceability and claim-rule failures always block.

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
| Full flow (paste JD → validated résumé) | 6s | 20s |

The full-flow p95 target of under 20 s, ending at a validated résumé, is the user-facing latency commitment. Below that, the flow feels responsive. Above that, it feels like batch processing. Measured today: extraction about 108 s, and full flow 236 s at p95 (#177). Both are far over target, which is why progress is streamed and long calls hold off the update prompt.

### Cost

| Operation | Target |
|-----------|--------|
| Career extraction (one-time, from a pasted résumé) | $2-5 |
| Per new role (parsing + matching + generation + validation) | $0.50-1.00 |
| Re-generation of existing application | $0.20-0.50 |

Artifact extraction ($0.50 per uploaded document at p95) is deferred with artifact upload.

### Reliability

- Structured output failures (malformed JSON, schema violations) retry with stricter prompts up to twice, then surface to the user as "needs manual review" for extraction, parsing and generation. *Target:* the same for validation; the Application Editor shows a generic "Validation couldn't run" today.
- Validation failures never auto-regenerate. They always surface to the user for explicit approval.
- No silent fallbacks. If the system can't produce a confident result, it says so.

---

## V1 interface

### The five V1 screens

The original V1 product had five screens. Each one earns its place in the core loop. New Role, shipped with #431, is a sixth, covered in Role detail and Target interface. This section records each as **shipped**, then names what the target design changes. Sign-in also ships; it is the only surface before the app knows who the user is, and it has no sign-up.

#### 1. Onboarding

First-session flow that takes the user from zero to a populated Capability Graph.

- **Shipped:** a short explanation, a paste-résumé editor with Markdown rendering and a character count, "Extract Units," streamed progress with elapsed time and an expected duration, inline timeout and error copy that keeps the pasted text, and a landing in Unit Review.
- **Deferred** (decision 3): the four-source picker (LinkedIn profile HTML, long-form career context, and artifact upload alongside résumé paste) and the per-stage upload progress for artifacts.
- **Target (enhancement):** Units appearing in the page as they are extracted. The shipped route waits for the whole pipeline, then lands in Unit Review.

After extraction, the user lands in **Unit review** to approve, correct, or reject each extracted Unit before it is added to the graph. Navigation doesn't force this step; the approval gate does: no Unit enters matching until the user approves it. The product's integrity depends on it. Onboarding stays in the navigation, so the user can paste more material later.

Success criterion for this screen: the user completes onboarding with at least 20 approved Experience Units and a clear understanding of what a Unit is.

#### 2. Unit review

The primary interface for maintaining the Capability Graph. The user spends time here during onboarding and whenever they add new career inputs.

- **Shipped:** a list of all non-rejected Experience Units, filterable by skill, tool, domain, approval status (approved, pending, flagged) and date range, with filters kept in the URL; a global approved counter toward the 20-Unit milestone; each Unit's summary, type, source, state and confidence; inline editing of every field, where an edit to the raw text or summary marks the Unit `reembed_pending` and keeps it out of matching until it is re-embedded, and edits to other fields need no re-embedding and are used on the next matching run (existing scores and rationales change only when matching is re-run); approve, flag and reject, with rejected Units dropping out of the list and out of matching; and "Add Unit manually," whose Unit has no embedding and stays out of matching for the same reason.
- **Target, not built:** a filter by source type; a client call to embed a Unit after an inline edit or a manual add; and a separate view for reviewing and restoring rejected Units.
- **Deferred** (decision 3): the "Upload an artifact" entry and the artifact provenance line (for example, `artifact · retro-q3.pdf · page 2`) that round-trips to the uploaded file.
- **Target (enhancement):** bulk selection with keyboard shortcuts, and a detail pane beside the list.

#### 3. Role detail

The per-role workspace. One of these exists for every job the user adds.

**Current implementation, superseded in the target design.** The shipped Role detail has a header with the title and the Role's id, and three tabs:

- **Requirements:** the JD editor and the parsed Job Requirement Units with their priority, must-have flag, category, keywords, tools and domains, read-only; changing them means editing the JD and re-parsing. For a Role saved without a JD, this is where the JD gets pasted and parsed.
- **Matches:** each Requirement with its match cards, scores and rationales. Gaps and unverifiable must-haves are surfaced first, and matching can be re-run. This is the primary decision surface today, and the tab every Role opens on, including a new one; without a JD it points to the Requirements tab.
- **Applications:** "Generate resume" (enabled once a match is approved) and the Role's Applications, each opening in the Application Editor.

The v0.1 header details (JD source URL, application stage, key dates) and the persistent action bar ("Generate resume," "Generate cover letter," "Export," "Update stage") were never built. Stage changes happen on the Pipeline board.

The **target** replacement is the five-tab dossier described under [Target interface](#target-interface). Its Requirements & matches tab keeps the shipped Requirements and Matches behavior.

#### 4. Application editor

The surface where generated output becomes something the user sends. **Transitional** (decision 5): its editing, validation and export move into the Package tab, and any expanded editor becomes another view of the same package.

- **Shipped:** two panes, with the generated résumé on the left and the approved Units that ground it on the right; inline annotations on traced claims, with hover highlighting the source Unit; validation flags on untraceable and vague claims; inline editing with autosave and undo, plus adding, removing and reordering bullets; re-running validation; and an Export button gated on validation and the server's attestation.
- **Target, not built:** export itself. The button is gated, but its action is a stub; export to PDF, DOCX and plain text is #33, and it lands on the Package.
- **Target:** claim-rule hits as a blocking flag kind.

#### 5. Pipeline

The CRM-lite view that keeps the user from needing a spreadsheet. **Shipped** (#510–#512, #34):

- Kanban-style columns by application stage: Saved, Drafting, Applied, Interviewing, Offer, Rejected, Withdrawn. These seven stay for this release (decision 1).
- Each card shows company, title, a day count, the next action (the Application's first open task), and the key contact. Nothing in the app creates Companies, People or Interactions yet, so cards read "Unknown company" and show no contact. The count is labeled "days in stage," but it measures days since the Application's `last_activity_at`, which a completed task also updates; there is no stage-entry timestamp. *Target:* true time in stage, which needs a stage-entry timestamp.
- Cards move by drag-and-drop or, when focused, with the Left and Right arrow keys; moves are optimistic and roll back on a failed write.
- Click through to the role detail for each application.
- A collapsible sidebar with Due today (overdue included), Upcoming (the next 7 days, then undated tasks), and Follow-ups (Applied or Interviewing Applications quiet for more than 7 days with no open task). Tasks complete with one click.
- Below 768 px the board becomes a vertical stack of stages.

*Target:* the next scheduled round on each card. *Enhancement:* overdue next actions surfaced first.

V1 ends here. No dashboard with charts, no analytics view, no "insights" section. The pipeline is enough to see the state of the search at a glance.

### Target interface

These are the approved target surfaces from v0.2's interface additions, settled by the v0.3 decisions. None has shipped unless it says so.

- **Navigation.** Pipeline · Evidence (Units, Import, Canonical résumé, Claim rules) · Scan · + New Role, where Import is the shipped Onboarding paste flow, replacing the shipped top navigation (Onboarding · Unit Review · + New Role · Application Editor · Pipeline). On phones, a bottom tab bar.
- **Role detail becomes the dossier.** Its header reads "where things stand" and the next action, as each reference folder index does. The tabs become: **Fit brief** (the default), **Requirements & matches**, **Package**, **Process**, and **Correspondence**.
- **Fit brief.** Bottom line and verdict; strengths tied to JD clauses with their evidence; exposures with how the package handles each; positioning and level; homework; questions to ask; and what this package does not claim, citing the claim rules it reflects. The brief freezes when the package is sent.
- **Package.** Sub-views for the résumé view, cover letter, application answers and referral note. Validation shows traceability, claim rules and specificity as separate checks. The staleness warning against the canonical sits beside them, with Rebase (unsent views only) and Keep, and does not block. A sent package is read-only. Export records the canonical version it was cut from. This is the home for editing, validation and export (decision 5).
- **Process.** Interview rounds with people, a prep brief and a debrief from the transcript per round, and a signal; the scorecard; and the leveling brief.
- **Correspondence.** The verbatim log in order, "Log a message," and drafts that the user copies and sends, then marks sent, so Matchline logs them verbatim. An "on the record" summary keeps later messages consistent with what has been said.
- **Pipeline cards** add the next scheduled round; surfacing overdue next actions first is an enhancement.
- **Evidence** gains the canonical résumé editor, with line ids visible, and a list of tailored views with their pinned versions, behind-current ones first. It also gains the claim-rules list: short, user-written, always visible when editing.
- **New Role** adds Company and Source fields (decision 7).
- **Scan.** Board management, a weekly run every Monday plus "Run now," and an inbox for each run: corrections to the record first, then new and still-open roles by tier, with the verification note, comp as posted, what lines up, and where the candidate is exposed. "Turn into Role" captures the JD from the verified posting, creates the Role, and creates its Application in Saved, so it appears on the Pipeline at once. Aggregator-only results stay as unverified leads, with "Turn into Role" disabled (decision 6). A board that fails keeps last week's roles open with a note rather than closing them.
- **Responsive layouts** (decision 8). Every agreed V1 workflow works at desktop, tablet and phone widths in the browser. Shipped surfaces are only partly there: the Pipeline board and the Application Editor stack below 768 px, the Pipeline's task sidebar moves beside the board only at 1024 px and up, and the New Role form drops its short fields from two columns to one below 640 px. The app's navigation, Unit Review rows and the Role detail tabs have no phone layout yet.

### Core requirements and enhancements

The wireframes draw more than this release needs. A surface or detail listed as an enhancement is approved but never blocks a phase exit. One marked *proposed* is drawn in the wireframes but not yet approved.

| Surface | Core (required) | Enhancement (not release-blocking) |
|---|---|---|
| Navigation | Every target surface reachable from the shell at every width | ⌘K command palette |
| Onboarding | Paste résumé (shipped) | Units streaming into the page during extraction |
| Unit Review | Shipped behavior; source-type filter; embed after an edit or a manual add; rejected-Units view | Bulk selection and shortcuts; detail pane |
| Evidence | Canonical résumé editor; tailored-view list with Rebase (unsent) and Keep; claim-rules list | Drag to reorder lines; *proposed:* Export canonical |
| New Role | Company and Source, persisted | "Draft restored" notice |
| Dossier header | Where things stand; next action | *Proposed:* Update stage, Generate and Export actions |
| Fit brief | All sections listed above | Regenerate and hand-edit history |
| Requirements & matches | Shipped Requirements and Matches behavior | Inline Requirement editing; split view (requirements beside candidates) |
| Package | Résumé view, cover letter, answers, referral note; validation; export; staleness warning | An expanded editor view of the same package |
| Process | Rounds with prep brief and debrief; scorecard; leveling brief | **Org map, runbooks, flashcards** |
| Correspondence | Verbatim log; Log a message; drafts marked sent; "on the record" | — |
| Scan | Boards; weekly run; verification; tiers; corrections; Turn into Role | Import boards from a list |
| Pipeline | Shipped behavior; next scheduled round | Overdue next actions surfaced first; *proposed:* a New Role button on the page |

---

## V2+ layers

These are the extensions that build on the core loop. They're deliberately deferred, not because they're unimportant, but because V1 has to prove the loop works before the layers matter.

*October 2026: parts of the first two layers below move forward into the revised scope as target work. What moves is marked; the rest stays deferred.*

### CRM expansion

Richer Person and Company objects. Relationship tracking that surfaces who's connected to which roles. Interaction threading that ties emails and messages to specific applications. Integrations with Gmail and Calendar to auto-populate Interactions.

**Pulled forward (target):**
- Correspondence threaded to applications, with outbound messages drafted in Matchline, sent from the user's own mail client, and logged verbatim.
- Meeting transcripts from the user's notes tool feeding round debriefs.
- People attached to rounds and referrals.

### Workflow automation

Follow-up cadence suggestions based on stage age and interaction history. Stage-transition automations (applied → interview triggers an interview prep reminder). Template library for common outreach patterns.

**Pulled forward:**
- Next actions with due dates. *Shipped* as tasks (#34, #512), with generated follow-ups for quiet Applications.
- The weekly scan as a scheduled job. *Target.*
- A scheduled round automatically opening a prep-brief draft. *Target.*
- A finished round automatically opening a debrief draft from its transcript. *Target.*
- A thank-you note drafted from the debrief. *Target.*

### Decision engine

"Should I apply?" scoring that combines fit score, network signal, role quality, and user preferences. Outputs a recommendation with visible reasoning. Helps the user focus on the right applications, not more applications.

### Learning layer

Outcome tracking that records which applications led to interviews, offers, and rejections, and feeds those signals back into matching weights and generation prompts. Requires data volume that a single user can't produce alone, so this layer is gated on V2 having real users.

### Network layer

Relationship graph built from LinkedIn connections, email patterns, and user-provided context. Referral suggestions for open applications. Outreach prioritization based on connection strength. Depends on integrations that slow V1 considerably.

### Browser extension

One-click import of job descriptions from LinkedIn, Greenhouse, Lever, Ashby, and Workday. Replaces the paste-every-JD flow from V1. Also, could capture the user's own LinkedIn profile without view-source paste.

### Native mobile apps

Deferred. V1 covers phones with responsive web layouts for its agreed workflows (decision 8). A native app, offline support, or features specific to mobile would be a V2+ decision.

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

V1 is explicitly single-user. No sharing, no collaboration, no team features. This simplifies auth, data model, and UX, and reflects the actual product: a personal tool for a personal search. It is also an authorization rule: an owner allowlist gates every callable and every client read and write.

### Capability Graph is portable

The user's Experience Units belong to the user. Export to JSON is a V1 feature, not V2. If someone wants to leave Matchline, they should be able to take their structured career with them. *Target, not built (#35).*

### Claims are policy, not memory (added October 2026)

What the user has decided never to claim, or to claim only one way, is written down once as a claim rule and enforced on every artifact. It is never left to a prompt's recall or to the user's vigilance on the fifth application of the week.

### Never rewrite what was sent (added October 2026)

A tailored view pins the canonical version it was built from, and a sent package is a record. Changes to the canonical reach an unsent view only through an explicit Rebase. Rebase does not apply to a sent package: it stays as sent, and a correction to it is logged as a linked record.

### Correct the record (added October 2026)

When a fact in the dossier is found to be wrong, it is fixed once, at its source: the canonical line, the Unit or the Role field that holds it. Unsent views that repeat it pick up the fix through the staleness warning and an explicit Rebase; nothing rewrites them silently. The correction is logged, with what was wrong and how it was found. A fact checked against a primary source (a transcript, the employer's own posting) outranks one that wasn't, and the artifact says which kind it is. Sent messages and sent packages are not edited; the correction is logged against them as a linked record.

### Cost is a feature

The per-application cost budget is a hard constraint. If a feature blows the budget, the feature gets redesigned, not the budget. Cheap generation is what makes the product sustainable without ad-supported or enterprise business models.

---

## Stack and hosting

### V1

**Shipped:**

- **Frontend:** React + TypeScript + Vite + Tailwind
- **Backend:** Firebase Functions (Node)
- **Database:** Firestore
- **Auth:** Firebase Auth, with an owner allowlist in every callable and in the Firestore rules
- **Hosting:** Firebase Hosting (frontend) + Firebase Functions (API)
- **LLM calls:** Anthropic for every generation stage; keys in Firebase secrets
- **Embeddings:** OpenAI text-embedding-3-small, stored in Firestore documents

**Target:** Firebase Storage for export files (#521).

**Deferred with artifact upload:** user-scoped artifact storage at `users/{uid}/artifacts/{filename}` with Storage rules mirroring the Firestore owner invariant (#519), and server-side text extraction with `pdf-parse` (PDF), `mammoth` (DOCX), and `jszip` plus slide XML (PPTX) (#520). Firebase Storage is not configured today.

### Rationale

V1 runs on the stack the author already uses daily. Cost of staying is near zero; cost of switching is real time that would come out of shipping. Firestore's document model fits the Capability Graph well enough at V1 scale, and the entire user base for V1 is one person.

### Data model discipline

Even on Firestore, the V1 data model follows Postgres-compatible conventions:

- UUIDs for all entity primary keys (telemetry and attestation records use Firestore auto-ids and composite keys)
- Explicit foreign key fields on every relationship
- No business logic embedded in Firestore queries
- Clean separation between Experience Units (permanent) and UnitMatches (per Role)
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

Five open questions shaped the V1 design, and v0.3 settled eight more (see [Decisions in v0.3](#decisions-in-v03-october-2026)). The original five, as they stand now:

1. **LinkedIn import:** View-source paste was the V1 plan, with a browser extension in V2. *v0.3:* deferred, with long-form import and artifact upload (decision 3).
2. **Cover letter:** First-class output in V1, generated with the same validation layer as resumes. *Still target; not built (#30).*
3. **Job description source:** Paste-only in V1, with a browser extension in V2. *Revised:* paste, or a Role saved before its JD (shipped), or a scan result verified on the employer's posting (target).
4. **Stack:** Firebase for V1, with data model discipline that keeps Postgres viable for V2.
5. **Pricing:** Free in V1 during author's own search; one-time annual fee with no auto-renew for V2.

## Open questions

- **Units or canonical lines as generation evidence.** matchline#495 Phase 3 compares a fit brief generated from Units with one generated from the canonical résumé.
- **How aggregator-only leads enter Scan.** Decision 6 keeps them as unverified leads and rules out scraping aggregators, so a lead must come from something the user provides or from an employer board that links out. The mechanism is not designed.
- **Non-URL Role sources.** A Role found through a referral or an event has no URL. Whether `source_url` is enough or Role provenance needs a short label is open; decision 7 asks for the minimum.
- **Manual leads on the Pipeline.** A Role created from Scan gets a Saved Application (see Target interface). A Role entered by hand gets no Application until the user clicks "Generate resume," which creates it in Drafting even if generation then fails, so a lead saved with only a title stays off the Pipeline. Whether New Role should also create a Saved Application is open.
- **Where an expanded editor lives.** Decision 5 allows an expanded editor as another view of the Package. Whether that is a full-screen mode of the tab or a separate route is a design question; either way it edits the same package.

---

## What ships next (October 2026)

The revised order. Phase A is fixed by an expiring API-credit window; the rest is sequenced by what each step unblocks. Issue numbers are in the matchline repository.

Some Phase C work shipped first, out of this order: the Pipeline board (#510, #511), the follow-ups sidebar (#34), next actions on cards (#512), and Roles saved without a JD (#431).

### Phase A: measure before building (through 2026-11-03)

- Cost attribution, so every model comparison is priced correctly (#483). *Shipped.*
- A fresh baseline and a Claude 5.5 model sweep for extraction and JD parsing (#495, Phases 1–2). *Code shipped (#578, #579); paid runs await owner approval on #495.*
- A **fit-brief generator prototype**, evaluated privately against the owner's own briefs, comparing models and comparing Units against the canonical résumé as evidence (#495, Phase 3). *Generator and harness shipped, eval-only (#581); paid runs await owner approval, the corpus manifest, and review of the claim-rules draft.*

**Exit:** a keep / change / defer decision on fit-brief generation, and an answer to whether Units are sufficient evidence for it.

### Phase B: the evidence the package depends on

- Canonical résumé as line-addressable, versioned data, with tailored résumés as views that pin a version, tracked exceptions, Rebase (unsent views only) or Keep, and a non-blocking staleness warning (decision 2).
- Claim rules as data, enforced as a blocking check by the validation layer.
- Fit brief as a first-class artifact on the Role, built on Phase A's decision.
- A first Package tab (decision 5): the résumé view, cover letters (#30), and export to PDF, DOCX, and text (#33), because the exit below sends a package.

**Exit (intermediate test 1):** for a new role, a fit brief and a package (tailored résumé, cover letter) that pass traceability and claim rules and that the owner sends with only light edits.

### Phase C: the dossier and the pipeline

- Pipeline board, card details, and the next-action sidebar (#510–#512, #34). *Shipped.* The next scheduled round on cards remains; overdue next actions surfaced first is an enhancement.
- Roles saved before a JD is available (#431). *Shipped.*
- The dossier: "where things stand," the next action, and the remaining dossier tabs.
- The rest of the Package as the home for editing and validation (application answers and the referral note); the Application Editor's behavior moves here (decision 5).
- Interview rounds with people, the scorecard, the leveling brief, and the verbatim correspondence log.
- Company and People entry, and Role provenance persisted from New Role (decision 7).
- The target navigation, and responsive layouts for every surface this phase touches (decision 8).

**Exit (intermediate test 2):** one live process run entirely in Matchline from application through every round.

### Phase D: workflows

- The weekly scan as a scheduled job over employer boards the user names, with employer-board verification, tiering, and aggregator-only results kept as unverified leads (decision 6).
- Prep briefs opened automatically for scheduled rounds; debriefs drafted from transcripts; thank-you notes drafted from debriefs.
- Messages drafted in Matchline and sent by the user, then logged verbatim.

**Exit:** the replacement test in [Success metrics](#success-metrics-for-v1). New opportunities stop getting hand-built folders.

Enhancements can land in any phase and never gate an exit.

Still deferred: LinkedIn and long-form import (#28, #29), artifact upload (#87), outcome learning, the network graph, native mobile apps, and anything multi-user.

## Historical: the original sprint plan (April 2026)

**Historical.** This was the V1 build plan before the dossier revision. It no longer directs work: [What ships next](#what-ships-next-october-2026) replaces it, and the replacement test replaces its final milestone (decision 4). The repo's `plans/matchline-implementation-plan.md` and `plans/matchline-sprint-0.md` are historical for the same reason. It is kept for the record; Sprints 0 and 1 and most of the core loop shipped, and parts of Sprint 2 are now deferred.

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

- **Prompt library.** The extraction, parsing, generation (résumé and fit brief), and validation prompts are a living artifact that will change often. They belong in a repo, not a PRD.
- **Evaluation harness.** How extraction quality and match accuracy are measured, with test sets and thresholds. Lives in the code (`tests/eval/`, and `tests/eval/fitBrief/` for the private fit-brief harness).
- **UI mockups.** Text descriptions of screens live here; the wireframes live in the matchline repository at `plans/matchline-wireframes.html` (#584), drawn at desktop, tablet and phone widths. They mark each frame as shipped or target. Where they conflict with this document, this document wins.
- **Go-to-market plan.** V1 has no GTM. V2 GTM is its own document when the time comes.
- **Competitive analysis.** Teal, Huntr, Simplify, LinkedIn exist. The positioning paragraph in section one handles this; a full matrix is not useful at V1 scale.
- **Hiring plan.** V1 is one person. V2 might not be. That's a V2 document.

---

## Closing

The product this document describes is small and specific. That's intentional. A V1 that works for one person for one real job search is worth more than a V2 vision that never ships. Every decision in this doc—the evidence-to-process loop, the deferred layers, the Firebase stack, the single-user scope, the one-time pricing—points at the same goal: ship something that actually helps Nathan find his next role, and let everything else be earned by what V1 proves.

If Matchline helps one person run a serious search with clarity and credibility, it's succeeded. If it helps more people later, that's a bonus.
