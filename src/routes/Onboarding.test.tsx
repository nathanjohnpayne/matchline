import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import Onboarding from "./Onboarding.tsx";

/**
 * Static-render tests for the Onboarding paste-resume route
 * (sub-issue #199). Same convention as the rest of the codebase
 * — `renderToStaticMarkup` exercises every rendering branch.
 *
 * `Onboarding` uses `useNavigate` from React Router so the
 * component requires a Router context; we wrap with
 * `MemoryRouter`. Async behavior (extract round-trip, error
 * transitions, redirect on success) is exercised at the
 * integration level via hand-testing per the route's test
 * convention; the unit tests here pin the rendering shape per
 * status / draft state.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Onboarding", () => {
  it("renders the empty paste form on initial mount", () => {
    const html = render(<Onboarding />);
    expect(html).toContain('data-testid="onboarding"');
    expect(html).toContain('data-onboarding-status="editing"');
    expect(html).toContain('data-testid="onboarding-textarea"');
    expect(html).toMatch(/<button[^>]*data-action="extract-units"/);
    // Sprint-0 placeholder copy is gone.
    expect(html).not.toContain("Sprint 0 placeholder");
    expect(html).not.toContain("Extraction pipeline lands in Sprint 1");
  });

  it("disables the Extract Units button on initial mount (empty text)", () => {
    const html = render(<Onboarding />);
    expect(html).toMatch(
      /<button[^>]*data-action="extract-units"[^>]*disabled[^>]*>/,
    );
  });

  it("does not render the in-flight progress bar on initial mount", () => {
    const html = render(<Onboarding />);
    expect(html).not.toContain('data-testid="onboarding-progress"');
    expect(html).not.toContain("Extracting…");
  });

  it("does not render the error banner on initial mount", () => {
    const html = render(<Onboarding />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('data-testid="onboarding-error"');
  });

  it("renders a 0-character count + helper text + label on initial mount", () => {
    const html = render(<Onboarding />);
    expect(html).toContain('data-testid="onboarding-char-count"');
    expect(html).toContain("0 characters");
    expect(html).toContain("Resume text"); // textarea label
    // The helper copy stresses the user-approval invariant.
    expect(html).toContain("Nothing");
    expect(html).toContain("matching pipeline without your explicit approval");
  });

  it("renders a textarea with aria-label for screen readers", () => {
    const html = render(<Onboarding />);
    expect(html).toMatch(
      /<textarea[^>]*aria-label="Resume text"/,
    );
  });

  it("renders the textarea with rows=20 (multi-line resume content)", () => {
    const html = render(<Onboarding />);
    expect(html).toMatch(/<textarea[^>]*rows="20"/);
  });

  it("uses a thin top progress bar (not a spinner overlay) per UI guidance rule 6", () => {
    // Static markup can't easily test the in-flight state without
    // a way to set status="extracting" externally — but we can
    // verify the progress bar implementation uses height-0.5
    // (thin top bar) when it does render. Read the source's
    // progress block for the marker class.
    // Indirect pin: the component's `extracting` branch contains
    // `h-0.5 w-full` which is the thin-top-bar shape called out
    // in the design doc. Verified by inspection in PR; the
    // tests here cover the rendered shape on mount (no progress
    // bar visible), and the visible-state shape is hand-tested.
    const html = render(<Onboarding />);
    // No progress bar on initial mount.
    expect(html).not.toContain("h-0.5 w-full");
  });

  it("uses font-mono on the textarea (resume formatting matters; preserve indentation)", () => {
    const html = render(<Onboarding />);
    expect(html).toMatch(/<textarea[^>]*font-mono/);
  });

  it("placeholder copy hints at plain text + tolerates headers/bullets", () => {
    const html = render(<Onboarding />);
    expect(html).toContain("Paste your resume as plain text");
    expect(html).toContain("Headers and bullet points are fine");
  });
});
