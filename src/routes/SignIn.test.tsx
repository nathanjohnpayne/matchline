import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// SignIn reads auth state through the context hook; a signed-out,
// resolved state is the only one that renders the form.
vi.mock("../lib/auth.tsx", () => ({
  useCurrentUser: () => ({ user: null, pending: false }),
}));

import SignIn from "./SignIn.tsx";

/**
 * Static-render tests for the sign-in surface. Same convention as
 * RoleNew.test.tsx.
 *
 * V1 is single-user, so the surface is sign-in only (#439): there is
 * no create-account mode to switch into. The real boundary is the
 * owner allowlist on the callables and in firestore.rules; this pins
 * that the UI no longer advertises self-registration.
 */
function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SignIn />
    </MemoryRouter>,
  );
}

describe("SignIn", () => {
  it("renders Google SSO and the email/password sign-in form", () => {
    const html = render();
    expect(html).toContain('data-action="sign-in-google"');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Sign in<\/button>/);
  });

  it("does not offer account creation", () => {
    const html = render();
    expect(html).not.toMatch(/create (an )?account/i);
    expect(html).not.toMatch(/create one/i);
    expect(html).not.toContain('autoComplete="new-password"');
    expect(html).not.toContain('autocomplete="new-password"');
  });
});
