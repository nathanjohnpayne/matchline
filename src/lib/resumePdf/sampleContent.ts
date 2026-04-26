/**
 * Sample GeneratedAssetContent for the PDF prototype (#50).
 *
 * Hand-curated to approximate what Phase 1 generation
 * (#22) would produce for Nathan's resume × the Google
 * Compute SPM JD pair already shipped as eval fixture
 * #135. The generation pipeline output is the contract;
 * the PDF prototype renders that contract.
 *
 * Why hand-curated and not a real `runGenerateResume`
 * output:
 *
 *   The prototype's purpose is to evaluate `react-pdf`'s
 *   LAYOUT fidelity, not to validate the generation
 *   pipeline. A hand-curated fixture controls for content
 *   quality so layout problems surface cleanly. Once the
 *   user runs generation against the real fixture (with
 *   their API key + #136's harness), the prototype can
 *   swap in real generated content trivially — the
 *   GeneratedAssetContent shape is identical.
 *
 * V1 schema is intentionally flat (`bullets[]`, no
 * employer/tenure grouping per #122). The PDF prototype
 * reflects that shape honestly; tenure-grouped sections
 * are a Phase 2 schema migration.
 */

import type { GeneratedAssetContent } from "../../types/crm.ts";

/**
 * The display-side metadata that doesn't live in
 * `GeneratedAssetContent`. The generation pipeline's
 * scope is grounded prose; identity / contact info comes
 * from the user's profile (TBD which surface owns it
 * structurally — for V1 the prototype takes them as
 * props).
 */
export interface ResumeHeader {
  readonly name: string;
  readonly title: string;
  readonly location: string;
  readonly contact: ReadonlyArray<{ label: string; value: string }>;
}

export const SAMPLE_HEADER: ResumeHeader = {
  name: "Nathan Payne",
  title: "Senior Product Manager — Streaming Platforms, Developer Tools, AI-Augmented Product",
  location: "San Francisco, CA",
  contact: [
    { label: "Email", value: "hire@example.com" },
    { label: "Phone", value: "(555) 010-0100" },
    { label: "Web", value: "nathanpayne.com" },
    { label: "LinkedIn", value: "linkedin.com/in/nathanpayne" },
    { label: "GitHub", value: "github.com/nathanjohnpayne" },
  ],
};

/**
 * The grounded resume content. Each item references one or
 * more source Unit IDs (mnemonic mocks of #135's labeler
 * IDs); a real `runGenerateResume` output would have
 * server-stamped UUIDs. The PDF prototype doesn't render
 * source_unit_ids — they're metadata for the validator
 * (#23) to grade traceability.
 */
export const SAMPLE_CONTENT: GeneratedAssetContent = {
  summary: {
    id: "s1",
    text: "Senior product manager bridging silicon-to-software platforms and the partner ecosystems they ship through. Ten years owning the SDK + device-certification surface that runs Disney+, Hulu, and ESPN across PlayStation, Xbox, Fire TV, and smart TVs. I treat operational ambiguity as a product problem and have repeatedly turned messy multi-stakeholder integrations into shipped, on-time launches.",
    source_unit_ids: ["u_kepler", "u_disney_plus_launch"],
  },
  bullets: [
    {
      id: "b1",
      text: "Led ground-up platform launch (Amazon Kepler) replacing Fire TV's Android stack with native Linux. Ported all three native client apps; hit September 2025 announcement; shipped on-time in October with zero negative impact to engagement metrics across ~18M monthly active devices.",
      source_unit_ids: ["u_kepler"],
    },
    {
      id: "b2",
      text: "Brought Disney+ from concept to launch on multiple connected device platforms — fastest-growing streaming service of all time. Drove cross-functional execution across Engineering, Design, and Product.",
      source_unit_ids: ["u_disney_plus_launch", "u_playstation_proto"],
    },
    {
      id: "b3",
      text: "Owned multi-version SDK release cadence (ADK 1 through 4.0 GA) — DMP hot-swappable player, text-to-speech, encrypted audio, and Sentry → DataDog observability migration. Owned scope tradeoffs, partner communication, and certification gate decisions across releases.",
      source_unit_ids: ["u_adk_releases", "u_platform_health"],
    },
    {
      id: "b4",
      text: "Drove cross-tier data infrastructure transformation — replaced 40+ inconsistent partner spreadsheets with Snowflake + Looker dashboards backed by a two-tier ADK4 questionnaire. Forcing function: a German HEVC patent enforcement action; the same infrastructure now supports AV1/HEVC compliance work across Germany and Brazil.",
      source_unit_ids: ["u_partner_data"],
    },
    {
      id: "b5",
      text: "Introduced AI-powered code review at the team-and-policy level — reduced median PR cycle time from 7.4 days to 4, beating the 30% Q2 OKR target. Policy is now AI review plus 2 human reviewers, moving toward AI plus 1 human.",
      source_unit_ids: ["u_ai_pr_review"],
    },
    {
      id: "b6",
      text: "Led NCPv3 — JavaScript/React support on native client devices enabling the mature BBD application to run on PlayStation, Xbox, Vega OS, set-top boxes, and smart TVs without a separate Rust implementation.",
      source_unit_ids: ["u_ncp_v3"],
    },
    {
      id: "b7",
      text: "Built Mergepath — agent governance infrastructure with multi-identity code review, automated external review via the OpenAI Codex GitHub App, and binding CI constraints. Currently deployed across seven repositories.",
      source_unit_ids: ["u_mergepath"],
    },
    {
      id: "b8",
      text: "Designed and implemented broadcast-grade SAN (180 TB shared, 99.9% SLA, 100+ concurrent users) at CNN; rolled out a non-linear editing studio (25 Final Cut Pro bays + StorNext SAN) that became the network standard for ten years.",
      source_unit_ids: ["u_san", "u_nle"],
    },
  ],
  skills: [
    {
      id: "sk1",
      text: "0-to-1 platform launches across constrained / partner-controlled device targets",
      source_unit_ids: ["u_kepler", "u_disney_plus_launch", "u_ncp_v3"],
    },
    {
      id: "sk2",
      text: "Cross-functional leadership: engineering, design, partner, legal, executive stakeholders",
      source_unit_ids: ["u_kepler", "u_partner_data", "u_disney_plus_launch"],
    },
    {
      id: "sk3",
      text: "Release engineering + observability migrations + KPI-driven exec reporting",
      source_unit_ids: ["u_adk_releases", "u_platform_health"],
    },
    {
      id: "sk4",
      text: "Data infrastructure consolidation (Snowflake, Looker) for compliance + operational decision-making",
      source_unit_ids: ["u_partner_data"],
    },
    {
      id: "sk5",
      text: "AI-augmented engineering tooling adoption + governance (Mergepath, AI PR review)",
      source_unit_ids: ["u_ai_pr_review", "u_mergepath"],
    },
    {
      id: "sk6",
      text: "Storage / SAN architecture + multi-site operational rollout",
      source_unit_ids: ["u_san", "u_nle"],
    },
  ],
  education: [
    {
      id: "e1",
      text: "B.S., Management Information Systems & Decision Sciences — George Mason University, 2002",
      source_unit_ids: [],
    },
    {
      id: "e2",
      text: "Continuing: Building & Scaling Subscription Businesses (Stanford Continuing Studies, 2021)",
      source_unit_ids: [],
    },
  ],
};
