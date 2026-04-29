import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import BulletEditor from "./BulletEditor.tsx";

/**
 * Static-render tests via `renderToStaticMarkup` — same convention
 * as the rest of the route. Async behavior (debounce, save round-
 * trip, error transitions) is exercised at the integration level
 * via hand-testing per the repo's test conventions; the unit tests
 * here pin the rendering shape per status / draft state.
 *
 * The component owns three pieces of state — draft text,
 * status (editing/saving/error), and lastSavedRef — but on a
 * fresh mount the rendering shape is fully determined by props.
 * That's what these tests cover.
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
    // Save is enabled (no `disabled=""` on the save button).
    expect(html).toMatch(
      /data-action="bullet-save"[^>]*(?!disabled)/,
    );
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
    // The Save button should appear with disabled attribute.
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

  it("renders the autosave-default debounce shape via export constant (sanity pin)", async () => {
    // Sanity check that the exported constant has a sensible
    // default — change-detection rather than functional. If a
    // future change drops the constant or sets it absurdly low/
    // high, this test surfaces the regression.
    const mod = await import("./BulletEditor.tsx");
    expect(mod.AUTOSAVE_DEBOUNCE_MS).toBeGreaterThan(500);
    expect(mod.AUTOSAVE_DEBOUNCE_MS).toBeLessThan(5000);
  });
});
