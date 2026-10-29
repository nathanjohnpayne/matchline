/**
 * The top card of the Calibrate stack: claim beside evidence, a drag that
 * follows the pointer with a slight tilt, and direction stamps that fade in
 * with travel. Release past the threshold swipes; anything shorter springs
 * back. A press with no drag is a tap (opens the full source).
 *
 * Pointer events cover mouse, pen and touch alike; `touch-none` stops the
 * browser from turning a vertical swipe into a page scroll, which is why the
 * full source opens outside the card where it can scroll.
 */

import { useRef, useState, type PointerEvent, type ReactElement } from "react";

import type { Card, Field } from "../../lib/labelDeck/deck.ts";

import { DRAG_START_PX, dragTransform, stamp, swipeDirection, type Direction } from "./gesture.ts";
import { QUESTIONS } from "./questions.ts";

export interface SwipeCardProps {
  readonly card: Card;
  /** Re-queued after a Can't tell: this is its second look. */
  readonly secondLook: boolean;
  readonly mixedAllowed: boolean;
  readonly reducedMotion: boolean;
  /** A completed swipe, with the drag offset the card was released at. */
  readonly onSwipe: (direction: Direction, offset: { x: number; y: number }) => void;
  /** A down swipe on a True / False-only card. */
  readonly onMixedRefused: () => void;
  readonly onTap: () => void;
}

/**
 * Each stamp sits on the card's trailing edge, the side that stays on
 * screen while the card moves: True top-left for a right swipe, False
 * top-right for a left one, and so on.
 */
export const STAMPS: Record<Direction, { text: string; className: string; position: string }> = {
  right: { text: "True", className: "border-emerald-600 text-emerald-600 dark:border-emerald-500 dark:text-emerald-500", position: "left-4 top-4 -rotate-6" },
  left: { text: "False", className: "border-red-600 text-red-600 dark:border-red-500 dark:text-red-500", position: "right-4 top-4 rotate-6" },
  down: { text: "Mixed", className: "border-amber-500 text-amber-600 dark:text-amber-500", position: "left-1/2 top-4 -translate-x-1/2" },
  up: { text: "Can't tell", className: "border-zinc-500 text-zinc-600 dark:border-zinc-400 dark:text-zinc-300", position: "bottom-4 left-1/2 -translate-x-1/2" },
};

export function FieldList({ fields }: { readonly fields: readonly Field[] }): ReactElement {
  return (
    <dl className="space-y-2.5">
      {fields.map((f, i) => (
        <div key={i}>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">{f.label}</dt>
          <dd className="mt-0.5 text-sm leading-snug whitespace-pre-wrap break-words text-zinc-900 dark:text-zinc-100">{f.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The card's face; shared by the live card and the one flying out. */
export function CardFace({ card, secondLook }: { readonly card: Card; readonly secondLook: boolean }): ReactElement {
  const { chip, question } = QUESTIONS[card.type];
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{chip}</span>
        {secondLook && (
          <span className="rounded border border-zinc-300 px-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">Second look</span>
        )}
      </div>
      <h2 className="mt-1 text-base leading-snug font-semibold text-zinc-900 dark:text-zinc-100">{question}</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <section aria-label="Claim">
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase dark:text-zinc-500">Claim</h3>
          <FieldList fields={card.claim} />
        </section>
        <section aria-label="Evidence" className="border-t border-zinc-200 pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4 dark:border-zinc-800">
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase dark:text-zinc-500">Evidence</h3>
          <FieldList fields={card.evidence} />
        </section>
      </div>
    </>
  );
}

export const CARD_SURFACE =
  "rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900";

export default function SwipeCard({ card, secondLook, mixedAllowed, reducedMotion, onSwipe, onMixedRefused, onTap }: SwipeCardProps): ReactElement {
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean; last: { x: number; y: number } } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, textarea")) return;
    press.current = { x: e.clientX, y: e.clientY, moved: false, last: { x: 0, y: 0 } };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    const next = { x: e.clientX - p.x, y: e.clientY - p.y };
    if (!p.moved) {
      if (Math.hypot(next.x, next.y) < DRAG_START_PX) return;
      p.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    p.last = next;
    setOffset(next);
  };

  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (!p.moved) {
      // A tap, unless the press selected text to copy.
      if (globalThis.getSelection?.()?.isCollapsed ?? true) onTap();
      return;
    }
    const direction = swipeDirection(p.last.x, p.last.y);
    if (direction && (direction !== "down" || mixedAllowed)) {
      onSwipe(direction, p.last);
      return;
    }
    if (direction === "down") onMixedRefused();
    setOffset(null);
  };

  const onPointerCancel = () => {
    press.current = null;
    setOffset(null);
  };

  const shown = offset ? stamp(offset.x, offset.y) : null;
  const visible = shown && (shown.direction !== "down" || mixedAllowed) ? shown : null;

  return (
    <article
      data-testid="calibrate-card"
      aria-label={QUESTIONS[card.type].chip}
      className={`relative cursor-grab touch-none select-none ${CARD_SURFACE} ${offset ? "cursor-grabbing" : ""} ${
        offset || reducedMotion ? "" : "transition-transform duration-150 ease-out"
      } ${reducedMotion ? "" : "calibrate-card-in"}`}
      style={offset ? { transform: reducedMotion ? `translate(${offset.x}px, ${offset.y}px)` : dragTransform(offset.x, offset.y) } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {(Object.keys(STAMPS) as Direction[]).map((dir) => (
        <span
          key={dir}
          aria-hidden="true"
          className={`pointer-events-none absolute z-10 rounded-md border-2 bg-white/90 px-2 py-0.5 text-sm font-semibold tracking-wide uppercase dark:bg-zinc-900/90 ${STAMPS[dir].className} ${STAMPS[dir].position}`}
          style={{ opacity: visible?.direction === dir ? visible.strength : 0 }}
        >
          {STAMPS[dir].text}
        </span>
      ))}
      <CardFace card={card} secondLook={secondLook} />
      <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">Tap the card, or press Space, for the full source.</p>
    </article>
  );
}
