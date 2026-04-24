import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Wordmark from "./Wordmark.tsx";

/**
 * Static render of the Wordmark into HTML string. No React Testing
 * Library dependency — `renderToStaticMarkup` ships with
 * `react-dom` which is already a root dep. That's enough to pin
 * the classes + character composition of the variant-C logo from
 * issue #75.
 */
function renderWordmark(props?: Parameters<typeof Wordmark>[0]): string {
  return renderToStaticMarkup(<Wordmark {...(props ?? {})} />);
}

describe("Wordmark", () => {
  it("renders the full 'match|line' by default", () => {
    const html = renderWordmark();
    // Check text-node content, not attribute content (`aria-label="matchline"`
    // would match naive substring searches for "match" or "line").
    // `>match` = start of the "match" text node; `line</` = end of the
    // "line" text node just before the outer </span>.
    expect(html).toContain(">match");
    expect(html).toContain("line</span>");
    // Pipe lives inside a nested <span> with `font-bold` AND
    // `aria-hidden="true"` so screen readers don't announce the
    // separator glyph (the outer `aria-label="matchline"` is the
    // authoritative accessible name). Match the class fragment
    // rather than the full element so attribute-order tweaks don't
    // break the test.
    expect(html).toMatch(/<span[^>]*class="font-bold"[^>]*>\|<\/span>/);
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\|<\/span>/);
    // Sequence check: the text node `>match` precedes the bold pipe
    // precedes `line</`.
    const matchIdx = html.indexOf(">match");
    const pipeIdx = html.indexOf('class="font-bold">|');
    const lineIdx = html.indexOf("line</span>");
    expect(matchIdx).toBeLessThan(pipeIdx);
    expect(pipeIdx).toBeLessThan(lineIdx);
  });

  it("applies variant-C base classes (font-medium + tracking-tight)", () => {
    const html = renderWordmark();
    expect(html).toMatch(/font-medium[^"]*tracking-tight/);
  });

  it("does NOT use the old variant (font-semibold + zinc-gray pipe)", () => {
    // Regression pin: if a future refactor silently reintroduces
    // the pre-#75 treatment (font-semibold on the outer span or a
    // zinc-tinted pipe), this test fails. Variant C is monochrome
    // + weight-700 pipe; any zinc-* on the pipe is wrong.
    const html = renderWordmark();
    expect(html).not.toContain("font-semibold");
    expect(html).not.toContain("text-zinc-400");
    expect(html).not.toContain("text-zinc-500");
  });

  it("appends caller className to the base classes", () => {
    const html = renderWordmark({ className: "text-lg" });
    expect(html).toContain("font-medium");
    expect(html).toContain("tracking-tight");
    expect(html).toContain("text-lg");
  });

  it("renders the 'm|' monogram when monogram prop is set", () => {
    const html = renderWordmark({ monogram: true });
    // Monogram has `m` + bold pipe and nothing else in the text.
    // Check text-node content specifically: >m< is the single-character
    // text node between `>` and the pipe's `<span>`.
    expect(html).toContain(">m<");
    expect(html).toMatch(/<span[^>]*class="font-bold"[^>]*>\|<\/span>/);
    // No "match" or "line" in text nodes (they DO appear in the
    // aria-label="matchline" attribute; filter those out).
    expect(html).not.toContain(">match");
    expect(html).not.toContain("line</");
  });

  it("includes an aria-label so screen readers announce the wordmark", () => {
    const html = renderWordmark();
    expect(html).toContain('aria-label="matchline"');
  });

  it("uses role=\"img\" so aria-label is an authoritative accessible name", () => {
    // `aria-label` on a bare <span> with generic role is unreliable
    // across screen readers — the ARIA spec only guarantees `aria-label`
    // is honored on elements with a nameable role. `role="img"` makes
    // the whole treatment a single named graphic. See issue #75 and
    // the Codex P2 round that triggered this change.
    const html = renderWordmark();
    expect(html).toContain('role="img"');
  });

  it("hides the pipe separator from assistive tech (aria-hidden)", () => {
    // The pipe is a typographic seam, not content. If it's announced
    // separately the wordmark reads as "matchline pipe" or similar.
    // `aria-hidden="true"` on the inner span + `aria-label` on the
    // outer span together guarantee the announced name is exactly
    // "matchline".
    const html = renderWordmark();
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\|<\/span>/);
  });

  it("renders as a <span> (inline element) so it flows with surrounding text", () => {
    const html = renderWordmark();
    expect(html.startsWith("<span")).toBe(true);
  });
});
