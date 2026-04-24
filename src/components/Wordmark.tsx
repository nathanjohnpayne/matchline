/**
 * Canonical logo treatments per `docs/design/ui-guidance.md` and
 * issue #75. Purely typographic — `match|line` (wordmark) or `m|`
 * (monogram) — with the pipe at weight 700 to assert the seam.
 *
 * Render as inline JSX rather than importing SVGs so:
 *   - color inherits from parent (automatic light/dark parity)
 *   - no font-loading ceremony for two words
 *   - Tailwind text-size utilities on the parent or on `className`
 *     control the scale
 *
 * Size via `className` (e.g. `text-lg`, `text-3xl`) or via the
 * enclosing element. See #75 for usage conventions.
 */

import type { ReactElement } from "react";

export interface WordmarkProps {
  /** Extra Tailwind / CSS classes; typically the text-size utility. */
  readonly className?: string;
  /**
   * `true` renders the monogram (`m|`); default renders the full
   * wordmark (`match|line`).
   */
  readonly monogram?: boolean;
}

export default function Wordmark({
  className,
  monogram = false,
}: WordmarkProps): ReactElement {
  return (
    <span
      className={`font-medium tracking-tight ${className ?? ""}`.trim()}
      aria-label="matchline"
    >
      {monogram ? "m" : "match"}
      <span className="font-bold">|</span>
      {monogram ? null : "line"}
    </span>
  );
}
