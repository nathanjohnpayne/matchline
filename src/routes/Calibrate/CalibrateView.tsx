/**
 * Calibrate: swipe through a calibration deck (#636) one judgment at a time.
 *
 * Right / → / True, left / ← / False, down / ↓ / Mixed (only where the sheet
 * takes `partial`), up / ↑ / Can't tell (the card comes back at the end of
 * the cell with its full source open). Z undoes, N adds a note after False
 * or Mixed, Space or a tap opens the full source.
 *
 * The view owns interaction state (timer, open source, note, the card
 * flying out); the session itself is lifted to the container, which
 * persists it and handles files and downloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import { allowsMixed, type Card, type Deck, type Label } from "../../lib/labelDeck/deck.ts";
import { addTime, current, decide, progress, setNote, undo } from "../../lib/labelDeck/session.ts";

import { DIRECTION_FOR, LABEL_FOR, dragTransform, exitTransform, type Direction } from "./gesture.ts";
import type { StoredSession } from "./storage.ts";
import SwipeCard, { CARD_SURFACE, CardFace, STAMPS } from "./SwipeCard.tsx";

export interface DeckRun {
  readonly deck: Deck;
  readonly session: StoredSession;
}

export interface CalibrateViewProps {
  readonly runs: readonly DeckRun[];
  readonly active: number;
  readonly loadError: string | null;
  readonly reducedMotion: boolean;
  readonly onOpenFiles: (files: File[]) => void;
  readonly onSession: (index: number, next: StoredSession) => void;
  readonly onOpenCell: (index: number) => void;
  readonly onDownload: () => void;
  /** Clock for decision timing; injectable for tests. */
  readonly now?: () => number;
}

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 dark:focus-visible:ring-zinc-100 dark:focus-visible:ring-offset-zinc-950";
const PRIMARY_BUTTON = `rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`;
const SECONDARY_BUTTON = `rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`;

const ACTIONS: { label: Label; text: string; glyph: string; key: string; glyphClass: string }[] = [
  { label: "false", text: "False", glyph: "✕", key: "←", glyphClass: "text-red-600 dark:text-red-500" },
  { label: "mixed", text: "Mixed", glyph: "◐", key: "↓", glyphClass: "text-amber-500" },
  { label: "unsure", text: "Can't tell", glyph: "?", key: "↑", glyphClass: "text-zinc-500 dark:text-zinc-400" },
  { label: "true", text: "True", glyph: "✓", key: "→", glyphClass: "text-emerald-600 dark:text-emerald-500" },
];

const KEY_LABELS: Record<string, Label> = { ArrowRight: "true", ArrowLeft: "false", ArrowDown: "mixed", ArrowUp: "unsure" };

interface Ghost {
  readonly key: number;
  readonly card: Card;
  readonly secondLook: boolean;
  readonly from: string;
  readonly direction: Direction;
}

/** The card that was just decided, flying off in its swipe direction. */
function GhostCard({ ghost, onDone }: { readonly ghost: Ghost; readonly onDone: () => void }): ReactElement {
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setFlying(true));
    const done = setTimeout(onDone, 220);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [onDone]);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 transition-[transform,opacity] duration-200 ease-in ${CARD_SURFACE}`}
      style={{ transform: flying ? exitTransform(ghost.direction) : ghost.from, opacity: flying ? 0 : 1 }}
    >
      <span className={`absolute z-10 rounded-md border-2 bg-white/90 px-2 py-0.5 text-sm font-semibold tracking-wide uppercase dark:bg-zinc-900/90 ${STAMPS[ghost.direction].className} ${STAMPS[ghost.direction].position}`}>
        {STAMPS[ghost.direction].text}
      </span>
      <CardFace card={ghost.card} secondLook={ghost.secondLook} />
    </div>
  );
}

function SourcePanel({ deck, card }: { readonly deck: Deck; readonly card: Card }): ReactElement {
  const firstHit = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    firstHit.current?.scrollIntoView?.({ block: "nearest" });
  }, [card.item_id]);
  const parts = card.source === "both" ? (["resume", "jd"] as const) : ([card.source] as const);
  let marked = false;
  return (
    <section aria-label="Full source" className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      {parts.map((part) => {
        const hits = new Set(card.highlight[part]);
        return (
          <div key={part} className="mb-4 last:mb-0">
            <h3 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{deck.sources[part].title}</h3>
            <div className="text-sm leading-snug text-zinc-700 dark:text-zinc-300">
              {deck.sources[part].text.split("\n").map((line, i) => {
                const hit = hits.has(i);
                const ref = hit && !marked ? ((marked = true), firstHit) : undefined;
                return (
                  <div
                    key={i}
                    ref={ref}
                    data-hit={hit || undefined}
                    className={`rounded-sm px-1 whitespace-pre-wrap break-words ${hit ? "bg-amber-100 text-zinc-900 dark:bg-amber-500/20 dark:text-zinc-100" : ""}`}
                  >
                    {line || " "}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Picker({ loadError, onOpenFiles }: Pick<CalibrateViewProps, "loadError" | "onOpenFiles">): ReactElement {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Calibrate</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Judge the calibration review one card at a time. Open the deck files built by <code className="text-xs">build-deck.mts</code>; you can pick several, and the
          cells run in the review order.
        </p>
      </div>
      <label className={`inline-flex cursor-pointer ${PRIMARY_BUTTON}`}>
        <input
          type="file"
          accept="application/json,.json"
          multiple
          className="sr-only"
          aria-label="Deck files"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) onOpenFiles(files);
          }}
        />
        Open deck files…
      </label>
      {loadError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-500">
          {loadError}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        {[
          ["Swipe right · →", "True"],
          ["Swipe left · ←", "False"],
          ["Swipe down · ↓", "Mixed (partial), where the sheet allows it"],
          ["Swipe up · ↑", "Can't tell: comes back at the end with the source open"],
          ["Tap · Space", "Full source"],
          ["Z · N", "Undo · note after False or Mixed"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Decks stay on this device: they are read in the browser and never uploaded. Only item ids, labels, notes and timings are kept here so you can resume.
      </p>
    </div>
  );
}

export default function CalibrateView(props: CalibrateViewProps): ReactElement {
  const { runs, active, loadError, reducedMotion, onOpenFiles, onSession, onOpenCell, onDownload } = props;
  const now = props.now ?? (() => performance.now());
  const run = runs[active];

  const [expanded, setExpanded] = useState(false);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const shownAt = useRef(0);
  const pausedAt = useRef<number | null>(null);
  const ghostKey = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const state = run?.session.state;
  const currentId = state ? current(state) : null;
  const cards = useMemo(() => new Map((run?.deck.cards ?? []).map((c) => [c.item_id, c])), [run?.deck]);
  const card = currentId ? cards.get(currentId) : undefined;

  // A new card starts its own clock; a re-queued one comes back open.
  useEffect(() => {
    shownAt.current = nowRef.current();
    pausedAt.current = null;
    setExpanded(Boolean(currentId && state?.requeued[currentId]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the card, not on every session change
  }, [currentId, active]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  const pause = useCallback(() => {
    if (pausedAt.current === null) pausedAt.current = nowRef.current();
  }, []);
  const resume = useCallback(() => {
    if (pausedAt.current !== null) {
      shownAt.current += nowRef.current() - pausedAt.current;
      pausedAt.current = null;
    }
  }, []);
  const elapsed = () => (pausedAt.current ?? now()) - shownAt.current;

  useEffect(() => {
    const onVisibility = () => (document.hidden ? pause() : !noteOpen && resume());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [noteOpen, pause, resume]);

  const closeNote = () => {
    if (noteOpen) resume();
    setNoteOpen(false);
  };

  const record = (label: Label, offset?: { x: number; y: number }) => {
    if (!run || !state || !card) return;
    if (label === "mixed" && !allowsMixed(card.type)) {
      setToast("This card is True / False only");
      return;
    }
    closeNote();
    const next = decide(state, label, elapsed());
    onSession(active, { ...run.session, state: next });
    if (!reducedMotion) {
      ghostKey.current += 1;
      setGhost({
        key: ghostKey.current,
        card,
        secondLook: Boolean(state.requeued[card.item_id]),
        from: offset ? dragTransform(offset.x, offset.y) : "none",
        direction: DIRECTION_FOR[label],
      });
    }
    setNoteTarget(label === "false" || label === "mixed" ? card.item_id : null);
    if (label === "unsure" && !next.decisions[card.item_id]) setToast("Moved to the end, with the source open");
  };

  const doUndo = () => {
    if (!run || !state || state.history.length === 0) return;
    closeNote();
    setNoteTarget(null);
    const banked = currentId ? addTime(state, elapsed()) : state;
    onSession(active, { ...run.session, state: undo(banked) });
    setToast("Undone");
  };

  const openNote = () => {
    if (!noteTarget || !state?.decisions[noteTarget]) return;
    pause();
    setNoteDraft(state.decisions[noteTarget].note);
    setNoteOpen(true);
  };

  const saveNote = (e: FormEvent) => {
    e.preventDefault();
    if (run && state && noteTarget) {
      onSession(active, { ...run.session, state: setNote(state, noteTarget, noteDraft) });
      setToast("Note saved");
    }
    closeNote();
    setNoteTarget(null);
  };

  // Keyboard: arrows decide, Space toggles the source, Z undoes, N notes.
  const handlers = useRef({ record, doUndo, openNote, card, noteTarget });
  handlers.current = { record, doUndo, openNote, card, noteTarget };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const h = handlers.current;
      if (h.card && KEY_LABELS[e.key]) {
        e.preventDefault();
        h.record(KEY_LABELS[e.key]);
      } else if (h.card && e.key === " ") {
        e.preventDefault();
        setExpanded((v) => !v);
      } else if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        h.doUndo();
      } else if ((e.key === "n" || e.key === "N") && h.noteTarget) {
        e.preventDefault();
        h.openNote();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const clearGhost = useCallback(() => setGhost(null), []);

  if (!run || !state) return <Picker loadError={loadError} onOpenFiles={onOpenFiles} />;

  const p = progress(state);
  const percent = p.total ? (p.done / p.total) * 100 : 0;
  const nextId = state.queue[1];
  const nextCard = nextId ? cards.get(nextId) : undefined;

  const noteBar = noteTarget && state.decisions[noteTarget] && (
    <div className="mt-3">
      {noteOpen ? (
        <form onSubmit={saveNote} className="flex gap-2">
          <input
            autoFocus
            value={noteDraft}
            maxLength={300}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeNote();
              }
            }}
            placeholder="e.g. wrong year, merges two roles"
            aria-label="Note for the last card"
            className={`min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}
          />
          <button type="submit" className={SECONDARY_BUTTON}>
            Save
          </button>
        </form>
      ) : (
        <button type="button" onClick={openNote} className={`text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}>
          Add a note to the last card (N)
        </button>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Calibrate</h1>
        <div className="flex items-center gap-2">
          <label className={`cursor-pointer ${SECONDARY_BUTTON}`}>
            <input
              type="file"
              accept="application/json,.json"
              multiple
              className="sr-only"
              aria-label="Open other deck files"
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                if (files.length) onOpenFiles(files);
              }}
            />
            Open decks
          </label>
          <button type="button" onClick={onDownload} className={SECONDARY_BUTTON}>
            Download labels
          </button>
        </div>
      </div>
      {loadError && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-500">
          {loadError}
        </p>
      )}

      <div className="mt-3">
        <div className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full bg-zinc-900 motion-safe:transition-[width] motion-safe:duration-200 dark:bg-zinc-100" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          Cell {active + 1} of {runs.length} · {p.done} of {p.total} labelled
        </p>
      </div>

      {card ? (
        <>
          <div className="relative mt-4">
            {nextCard && (
              <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-2 bottom-0 scale-[0.97] opacity-60 ${CARD_SURFACE}`} />
            )}
            {ghost && <GhostCard key={ghost.key} ghost={ghost} onDone={clearGhost} />}
            <SwipeCard
              key={card.item_id + ":" + p.done}
              card={card}
              secondLook={Boolean(state.requeued[card.item_id])}
              mixedAllowed={allowsMixed(card.type)}
              reducedMotion={reducedMotion}
              onSwipe={(direction, offset) => record(LABEL_FOR[direction], offset)}
              onMixedRefused={() => setToast("This card is True / False only")}
              onTap={() => setExpanded((v) => !v)}
            />
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2">
            {ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={a.label === "mixed" && !allowsMixed(card.type)}
                onClick={(e) => {
                  // Blur: a focused button would turn a later Enter into a second decision.
                  e.currentTarget.blur();
                  record(a.label);
                }}
                className={`flex flex-col items-center gap-0.5 rounded-md border border-zinc-300 bg-white py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`}
              >
                <span aria-hidden="true" className={`text-lg leading-none ${a.glyphClass}`}>
                  {a.glyph}
                </span>
                <span>{a.text}</span>
                <span aria-hidden="true" className="hidden text-xs text-zinc-400 sm:inline dark:text-zinc-500">
                  {a.key}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={doUndo} disabled={state.history.length === 0} className={SECONDARY_BUTTON}>
              Undo (Z)
            </button>
            <button type="button" onClick={() => setExpanded((v) => !v)} className={`text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}>
              {expanded ? "Hide full source" : "Show full source"}
            </button>
          </div>
          {noteBar}
          {expanded && <SourcePanel deck={run.deck} card={card} />}
        </>
      ) : (
        <CellEnd run={run} index={active} total={runs.length} onDownload={onDownload} onUndo={doUndo} onNext={() => onOpenCell(active + 1)} noteBar={noteBar} />
      )}

      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed inset-x-0 bottom-6 mx-auto w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-zinc-50 shadow-sm dark:bg-zinc-100 dark:text-zinc-900 motion-safe:transition-opacity motion-safe:duration-200 ${
          toast ? "opacity-95" : "opacity-0"
        }`}
      >
        {toast}
      </div>
    </div>
  );
}

function CellEnd({
  run,
  index,
  total,
  onDownload,
  onUndo,
  onNext,
  noteBar,
}: {
  readonly run: DeckRun;
  readonly index: number;
  readonly total: number;
  readonly onDownload: () => void;
  readonly onUndo: () => void;
  readonly onNext: () => void;
  readonly noteBar: ReactElement | null | false | "";
}): ReactElement {
  const { decisions, undos } = run.session.state;
  const items = Object.values(decisions);
  const times = items.map((d) => d.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  const counts = { true: 0, false: 0, mixed: 0, unsure: 0 };
  for (const d of items) counts[d.label] += 1;
  const undoCount = Object.values(undos).reduce((a, b) => a + b, 0);
  return (
    <section aria-label="Cell done" className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold">
        Cell {index + 1} of {total} done
      </h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {[
          ["Labelled", String(items.length)],
          ["True · False · Mixed · Can't tell", `${counts.true} · ${counts.false} · ${counts.mixed} · ${counts.unsure}`],
          ["Median time per card", `${(median / 1000).toFixed(1)} s`],
          ["Undos", String(undoCount)],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {noteBar}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onDownload} className={PRIMARY_BUTTON}>
          Download labels
        </button>
        <button type="button" onClick={onUndo} className={SECONDARY_BUTTON}>
          Undo last
        </button>
        {index < total - 1 && (
          <button type="button" onClick={onNext} className={PRIMARY_BUTTON}>
            Next cell
          </button>
        )}
      </div>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Import on the Mac with <code>npx tsx tools/label-swipe/import-labels.mts &lt;file&gt;</code>.
      </p>
    </section>
  );
}
