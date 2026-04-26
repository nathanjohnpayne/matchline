/**
 * Smoke-shape tests for the PDF prototype component
 * (#50). Verifies the React tree assembles without
 * throwing on the sample fixture and on edge-case
 * content shapes the generation pipeline can produce.
 *
 * NOT a render-to-PDF test — `@react-pdf/renderer`'s
 * actual PDF rendering is exercised by the CLI
 * (`npm run pdf:prototype`) since spinning the
 * stream-based renderer in unit tests would balloon
 * test latency. This file pins the JSX-tree shape and
 * the prop-handling logic; the production rendering is
 * the reviewer's "would I send this" call per the spec.
 */

import { describe, expect, it } from "vitest";

import { ResumePdf } from "./ResumePdf.tsx";
import { SAMPLE_CONTENT, SAMPLE_HEADER } from "./sampleContent.ts";

import type { GeneratedAssetContent } from "../../types/crm.ts";

describe("ResumePdf", () => {
  it("returns a non-null React element on the sample fixture", () => {
    const element = ResumePdf({
      header: SAMPLE_HEADER,
      content: SAMPLE_CONTENT,
    });
    expect(element).not.toBeNull();
    // The Document is the top-level element from
    // @react-pdf/renderer; verify shape by checking
    // that we got a React element with children.
    expect(element).toHaveProperty("type");
    expect(element).toHaveProperty("props");
  });

  it("handles missing optional `education` (Phase 1 generation may omit it)", () => {
    const noEducation: GeneratedAssetContent = {
      ...SAMPLE_CONTENT,
      education: undefined,
    };
    expect(() =>
      ResumePdf({ header: SAMPLE_HEADER, content: noEducation }),
    ).not.toThrow();
  });

  it("handles empty `education` array (zero entries)", () => {
    const emptyEducation: GeneratedAssetContent = {
      ...SAMPLE_CONTENT,
      education: [],
    };
    expect(() =>
      ResumePdf({ header: SAMPLE_HEADER, content: emptyEducation }),
    ).not.toThrow();
  });

  it("handles minimal content (one bullet, one skill, no education)", () => {
    const minimal: GeneratedAssetContent = {
      summary: { id: "s", text: "Brief summary.", source_unit_ids: ["u_a"] },
      bullets: [{ id: "b", text: "One bullet.", source_unit_ids: ["u_a"] }],
      skills: [{ id: "k", text: "One skill.", source_unit_ids: ["u_a"] }],
    };
    expect(() =>
      ResumePdf({ header: SAMPLE_HEADER, content: minimal }),
    ).not.toThrow();
  });

  it("handles a header with no contact entries (location only)", () => {
    expect(() =>
      ResumePdf({
        header: { ...SAMPLE_HEADER, contact: [] },
        content: SAMPLE_CONTENT,
      }),
    ).not.toThrow();
  });
});
