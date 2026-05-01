import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import RoleNew from "./RoleNew.tsx";

/**
 * Static-render tests for the Create Role form (sub-issue #200).
 * Same convention as Onboarding.test.tsx (#199): the route uses
 * `useNavigate`, so we wrap in `MemoryRouter`. Async behavior
 * (submit round-trip, error transitions, redirect on success) is
 * exercised at the integration level via hand-testing.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("RoleNew", () => {
  it("renders the empty form on initial mount", () => {
    const html = render(<RoleNew />);
    expect(html).toContain('data-testid="role-new"');
    expect(html).toContain('data-role-new-status="editing"');
    expect(html).toContain('data-testid="role-new-title"');
    expect(html).toContain('data-testid="role-new-jd"');
    expect(html).toContain('data-testid="role-new-url"');
    expect(html).toContain('data-testid="role-new-location"');
    expect(html).toContain('data-testid="role-new-remote"');
    expect(html).toContain('data-testid="role-new-comp"');
  });

  it("disables Create Role on initial mount (empty title + jdRaw)", () => {
    const html = render(<RoleNew />);
    expect(html).toMatch(
      /<button[^>]*data-action="role-new-submit"[^>]*disabled[^>]*>/,
    );
  });

  it("renders Cancel button alongside submit", () => {
    const html = render(<RoleNew />);
    expect(html).toContain('data-action="role-new-cancel"');
    expect(html).toMatch(/<button[^>]*data-action="role-new-cancel"[^>]*>/);
  });

  it("marks Title + JD as required (asterisks + native required attr)", () => {
    const html = render(<RoleNew />);
    // Visible asterisks per UI guidance.
    expect(html).toMatch(/Title <span[^>]*>\*<\/span>/);
    expect(html).toMatch(/Job description <span[^>]*>\*<\/span>/);
    // Native required attribute on the underlying inputs (order-
    // agnostic check: capture the tag then assert presence).
    const titleTag = html.match(
      /<input[^>]*data-testid="role-new-title"[^>]*>/,
    );
    expect(titleTag).not.toBeNull();
    expect(titleTag?.[0]).toContain("required");
    const jdTag = html.match(
      /<textarea[^>]*data-testid="role-new-jd"[^>]*>/,
    );
    expect(jdTag).not.toBeNull();
    expect(jdTag?.[0]).toContain("required");
  });

  it("marks URL / Location / Remote / Comp as optional in label copy", () => {
    const html = render(<RoleNew />);
    const optionalCount = (html.match(/\(optional\)/g) ?? []).length;
    expect(optionalCount).toBe(4);
  });

  it("renders the remote-policy select with all three options + an empty default", () => {
    const html = render(<RoleNew />);
    // Each policy renders as an <option value="…">
    for (const policy of ["onsite", "hybrid", "remote"]) {
      expect(html).toMatch(
        new RegExp(`<option[^>]*value="${policy}"[^>]*>${policy}</option>`),
      );
    }
    // Empty default option marked as "—" so the user knows
    // unselected is meaningful.
    expect(html).toMatch(/<option[^>]*value=""[^>]*>—<\/option>/);
  });

  it("renders the JD textarea with rows=12 + font-mono (paste preservation)", () => {
    const html = render(<RoleNew />);
    const jdTag = html.match(
      /<textarea[^>]*data-testid="role-new-jd"[^>]*>/,
    );
    expect(jdTag).not.toBeNull();
    expect(jdTag?.[0]).toContain('rows="12"');
    expect(jdTag?.[0]).toContain("font-mono");
  });

  it("renders the JD URL input with type='url' (browser-side basic validation)", () => {
    const html = render(<RoleNew />);
    const urlTag = html.match(
      /<input[^>]*data-testid="role-new-url"[^>]*>/,
    );
    expect(urlTag).not.toBeNull();
    expect(urlTag?.[0]).toContain('type="url"');
  });

  it("does not render the saving indicator on initial mount", () => {
    const html = render(<RoleNew />);
    expect(html).not.toContain('data-testid="role-new-saving"');
    expect(html).not.toContain("Saving");
  });

  it("does not render the error banner on initial mount", () => {
    const html = render(<RoleNew />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('data-testid="role-new-error"');
  });

  it("renders helper copy explaining the next step (parse → match)", () => {
    const html = render(<RoleNew />);
    expect(html).toContain("parses the requirements");
    expect(html).toContain("matches them against your approved Experience");
  });
});
