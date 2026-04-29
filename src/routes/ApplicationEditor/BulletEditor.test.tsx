import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import BulletEditor from "./BulletEditor.tsx";

/**
 * Static-render tests via `renderToStaticMarkup` — same convention
 * as the rest of the route. Async behavior (debounce timing, save
 * round-trip, error transitions, keybinding events) is exercised
 * at the integration level via hand-testing per the repo's test
 * conventions; the unit tests here pin the rendering shape per
 * status / draft state.
 *
 * The component owns three pieces of state — draft text, status
 * (editing/saving/error), and lastSavedRef — but on a fresh mount
 * the rendering shape is fully determined by props. That's what
 * these tests cover.
 */

describe("BulletEditor", () => {
  it("renders the textarea pre-populated with initialText", () => {
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Existing bullet content."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain("Existing bullet content.");
    expect(html).toContain('data-testid="bullet-editor-textarea"');
    expect(html).toContain('data-testid="bullet-editor"');
  });

  it("starts in 'editing' status with both Save and Cancel enabled when text is non-empty", () => {
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('data-edit-status="editing"');
    expect(html).toContain('data-action="bullet-save"');
    expect(html).toContain('data-action="bullet-cancel"');
    expect(html).not.toContain('data-testid="bullet-editor-saving"');
    expect(html).not.toContain('data-testid="bullet-editor-error"');
  });

  it("disables Save when initialText is whitespace-only", () => {
    // The textarea allows empty/whitespace input but the Save
    // button refuses to submit until there's real text. Empty
    // bullets corrupt the asset shape; the popover's Remove path
    // is the right exit for "this bullet shouldn't be here."
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="   "
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toMatch(
      /<button[^>]*data-action="bullet-save"[^>]*disabled[^>]*>/,
    );
  });

  it("does not render the saving indicator on initial mount", () => {
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).not.toContain("Saving");
  });

  it("does not render the error banner on initial mount", () => {
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('data-testid="bullet-editor-error"');
  });

  it("exposes an aria-label on the textarea for screen readers", () => {
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Bullet text"');
  });

  it("renders a keybinding hint surfacing Enter / Shift+Enter / Esc behaviors (sub-issue #188 design AC)", () => {
    // Per UI guidance rule 4: "Enter commits, Escape cancels."
    // The hint makes the keybindings discoverable for users who
    // haven't memorized the convention. The hint is shown next
    // to the action buttons in the editor footer.
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="bullet-editor-hint"');
    expect(html).toContain("Enter");
    expect(html).toContain("Shift+Enter");
    expect(html).toContain("Esc");
    // Each shortcut is rendered as <kbd> per the typography
    // convention.
    expect(html).toMatch(/<kbd[^>]*>Enter<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>Esc<\/kbd>/);
  });

  it("auto-focuses the textarea on mount (autofocus attribute present)", () => {
    // Click-Edit → field is editable in place is per UI guidance
    // rule 4. autofocus puts the cursor in the textarea
    // immediately so the user can start typing without an extra
    // click.
    const html = renderToStaticMarkup(
      <BulletEditor
        initialText="Initial."
        onSave={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toMatch(
      /<textarea[^>]*autofocus|<textarea[^>]*autoFocus/i,
    );
  });

  it("renders the autosave-default debounce shape via export constant (sanity pin)", async () => {
    const mod = await import("./BulletEditor.tsx");
    expect(mod.AUTOSAVE_DEBOUNCE_MS).toBeGreaterThan(500);
    expect(mod.AUTOSAVE_DEBOUNCE_MS).toBeLessThan(5000);
  });
});
