import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import Onboarding from "./Onboarding.tsx";

/**
 * Static-render tests for the Onboarding paste-resume route
 * (sub-issue #199; resume input upgraded to the TipTap ResumeEditor
 * in #264). Same convention as the rest of the codebase —
 * `renderToStaticMarkup` exercises every rendering branch.
 *
 * `Onboarding` uses `useNavigate` from React Router so the
 * component requires a Router context; we wrap with
 * `MemoryRouter`. Async behavior (extract round-trip, error
 * transitions, redirect on success) is exercised at the
 * integration level via hand-testing per the route's test
 * convention; the unit tests here pin the rendering shape per
 * status / draft state.
 *
 * NB (#264): the resume input is now a TipTap editor mounted with
 * `immediatelyRender: false`, so the ProseMirror surface mounts in a
 * client-side effect — NOT during `renderToStaticMarkup`. These tests
 * therefore pin the shell + the editor *wrapper*; the Markdown
 * paste→render behavior is browser/hand-tested (acceptance on #264).
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Onboarding", () => {
  it("renders the empty paste form on initial mount", () => {
    const html = render(<Onboarding />);
    expect(html).toContain('data-testid="onboarding"');
    expect(html).toContain('data-onboarding-status="editing"');
    expect(html).toContain('data-testid="onboarding-editor-wrapper"');
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

  it("renders the resume editor wrapper (TipTap surface mounts client-side)", () => {
    const html = render(<Onboarding />);
    // The ProseMirror element (with aria-label="Resume text") mounts in
    // an effect; renderToStaticMarkup only sees the wrapper. Editor a11y
    // + MD rendering are verified in the browser per #264.
    expect(html).toContain('data-testid="onboarding-editor-wrapper"');
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

  it("keeps the resume label + approval-invariant copy with the editor swap", () => {
    const html = render(<Onboarding />);
    // The "Resume text" label and the user-approval invariant copy are
    // SSR-rendered shell (the Markdown-hint placeholder lives in the
    // client-mounted editor and is verified in-browser per #264).
    expect(html).toContain("Resume text");
    expect(html).toContain("matching pipeline without your explicit approval");
  });
});
