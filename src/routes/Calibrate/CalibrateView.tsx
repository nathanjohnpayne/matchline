/**
 * Calibrate: swipe through a calibration deck (#636) one judgment at a time.
 *
 * Right / → / True, left / ← / False, down / ↓ / Mixed (only where the sheet
 * takes `partial`), up / ↑ / Can't tell (the card comes back at the end of
 * the cell with its full source open). Z undoes, N adds a note after False
 * or Mixed, Space or a tap opens the full text and source.
 *
 * The view owns interaction state (timer, open source, note, the card
 * flying out); the session itself is lifted to the container, which
 * persists it and handles decks, files and downloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type Ref } from "react";

import { allowsMixed, type Card, type Deck, type Label } from "../../lib/labelDeck/deck.ts";
import { addTime, current, decide, progress, setNote, undo, type StoredSession } from "../../lib/labelDeck/session.ts";

import DeckScreen, { FOCUS_RING, PRIMARY_BUTTON, SECONDARY_BUTTON, type DeckScreenProps } from "./DeckScreen.tsx";
import { DIRECTION_FOR, LABEL_FOR, dragTransform, exitTransform, type Direction } from "./gesture.ts";
import { QUESTIONS } from "./questions.ts";
import SwipeCard, { CARD_SURFACE, CardFace, FieldList, STAMPS } from "./SwipeCard.tsx";

export type DeckSource = "account" | "file";

/** The state of saving to the account (decks opened from a file only save in the browser). */
export type SaveState =
  | { readonly kind: "idle" | "saving" | "saved" }
  /** A save is not confirmed yet (offline); it is still queued and lands when it can. */
  | { readonly kind: "error"; readonly message: string }
  /** A save was refused; finding out why. Labelling is already paused. */
  | { readonly kind: "checking" }
  /** Another device saved this deck since this one read it; the account is at `accountRev`. */
  | { readonly kind: "conflict"; readonly accountRev: number }
  /** The deck was removed from the account, or replaced with different content. */
  | { readonly kind: "removed" | "replaced" }
  /** Refused for another reason (for example, access revoked). */
  | { readonly kind: "refused"; readonly message: string };

/** Save states that stop labelling on this device until the owner resolves them. */
const LOCKING: readonly SaveState["kind"][] = ["checking", "conflict", "removed", "replaced", "refused"];

export interface DeckRun {
  readonly deck: Deck;
  readonly session: StoredSession;
  /** Where progress is saved: the owner's account, or this browser only. */
  readonly source: DeckSource;
}

export interface CalibrateViewProps extends DeckScreenProps {
  readonly runs: readonly DeckRun[];
  readonly active: number;
  /** Changes every time decks are (re)opened, so a re-opened card starts a fresh clock. */
  readonly openCount: number;
  readonly saveState: SaveState;
  readonly reducedMotion: boolean;
  readonly onSession: (index: number, next: StoredSession) => void;
  readonly onOpenCell: (index: number) => void;
  readonly onDownload: () => void;
  readonly onBackToDecks: () => void;
  /** After a conflict: write this device's copy over the account's. */
  readonly onKeepThisDevice: () => void;
  /** Clock for decision timing; injectable for tests. */
  readonly now?: () => number;
}

const ACTIONS: { label: Label; text: string; glyph: string; key: string; glyphClass: string }[] = [
  { label: "false", text: "False", glyph: "✕", key: "←", glyphClass: "text-red-600 dark:text-red-500" },
  { label: "mixed", text: "Mixed", glyph: "◐", key: "↓", glyphClass: "text-amber-500" },
  { label: "unsure", text: "Can't tell", glyph: "?", key: "↑", glyphClass: "text-zinc-500 dark:text-zinc-400" },
  { label: "true", text: "True", glyph: "✓", key: "→", glyphClass: "text-emerald-600 dark:text-emerald-500" },
];

const SPOKEN: Record<Label, string> = { true: "True", false: "False", mixed: "Mixed", unsure: "Can't tell" };

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
      <div className="max-h-[55svh] overflow-hidden sm:max-h-none">
        <CardFace card={ghost.card} secondLook={ghost.secondLook} />
      </div>
    </div>
  );
}

/** The full card (never clipped) and the source text with its evidence lines marked. */
function SourcePanel({ deck, card }: { readonly deck: Deck; readonly card: Card }): ReactElement {
  const firstHit = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    firstHit.current?.scrollIntoView?.({ block: "nearest" });
  }, [card.item_id]);
  const parts = card.source === "both" ? (["resume", "jd"] as const) : ([card.source] as const);
  let marked = false;
  return (
    <section aria-label="Full source" className="mt-4 space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="grid gap-4 sm:hidden">
        <div>
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Claim</h3>
          <FieldList fields={card.claim} />
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Evidence</h3>
          <FieldList fields={card.evidence} />
        </div>
      </div>
      {parts.map((part) => {
        const hits = new Set(card.highlight[part]);
        return (
          <div key={part}>
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

export default function CalibrateView(props: CalibrateViewProps): ReactElement {
  const { runs, active, openCount, saveState, reducedMotion, onSession, onOpenCell, onDownload, onBackToDecks, onKeepThisDevice } = props;
  const locked = LOCKING.includes(saveState.kind);
  const now = props.now ?? (() => performance.now());
  const run = runs[active];

  const [expanded, setExpanded] = useState(false);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [refusal, setRefusal] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const shownAt = useRef(0);
  const pausedAt = useRef<number | null>(null);
  const ghostKey = useRef(0);
  const cardRef = useRef<HTMLElement | null>(null);
  const cellEndRef = useRef<HTMLHeadingElement | null>(null);
  const focusCard = useRef(false);
  const nowRef = useRef(now);
  nowRef.current = now;

  const state = run?.session.state;
  const currentId = state ? current(state) : null;
  const cards = useMemo(() => new Map((run?.deck.cards ?? []).map((c) => [c.item_id, c])), [run?.deck]);
  const card = currentId ? cards.get(currentId) : undefined;
  // One value per showing of a card. The history grows with every decision
  // and re-queue and shrinks with undo, so this changes even when the same
  // card comes straight back (a Can't tell on the last card left).
  const showing = `${openCount}:${active}:${state?.history.length ?? 0}:${currentId ?? ""}`;

  // Each showing starts its own clock; a re-queued card comes back open.
  useEffect(() => {
    shownAt.current = nowRef.current();
    pausedAt.current = null;
    setExpanded(Boolean(currentId && state?.requeued[currentId]));
    setRefusal(false);
    if (focusCard.current) {
      focusCard.current = false;
      (cardRef.current ?? cellEndRef.current)?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the showing, not on every session change
  }, [showing]);

  // The fly-out belongs to the decision just made; nothing may replay it later.
  useEffect(() => {
    if (!card) setGhost(null);
  }, [card]);

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
    if (!run || !state || !card || locked) return;
    if (label === "mixed" && !allowsMixed(card.type)) {
      setRefusal(true);
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
    const requeued = label === "unsure" && !next.decisions[card.item_id];
    if (requeued) setToast("Moved to the end, with the source open");
    const left = next.queue.length;
    const following = current(next);
    const nextChip = following ? QUESTIONS[cards.get(following)?.type ?? "verbatim"].chip : null;
    setAnnouncement(
      `${requeued ? "Can't tell, moved to the end" : SPOKEN[label]}. ${following ? `${left} left. Next: ${nextChip}` : "Cell done."}`,
    );
  };

  const doUndo = () => {
    if (!run || !state || state.history.length === 0 || locked) return;
    closeNote();
    setNoteTarget(null);
    setGhost(null);
    const banked = currentId ? addTime(state, elapsed()) : state;
    onSession(active, { ...run.session, state: undo(banked) });
    setToast("Undone");
    setAnnouncement("Undone.");
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
      // A held key would otherwise label a run of cards at the repeat rate.
      if (e.repeat && (KEY_LABELS[e.key] || e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        return;
      }
      if (h.card && KEY_LABELS[e.key]) {
        e.preventDefault();
        h.record(KEY_LABELS[e.key]);
      } else if (h.card && e.key === " " && !(t instanceof Element && t.closest("button, a, label"))) {
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

  if (!run || !state) return <DeckScreen {...props} />;

  const p = progress(state);
  const percent = p.total ? (p.done / p.total) * 100 : 0;
  const nextCard = state.queue[1] ? cards.get(state.queue[1]) : undefined;

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
        <h1 className="truncate text-lg font-semibold" title={run.deck.deck_id}>
          Calibrate
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onBackToDecks} className={SECONDARY_BUTTON}>
            Decks
          </button>
          <button type="button" onClick={onDownload} className={SECONDARY_BUTTON}>
            Download labels
          </button>
        </div>
      </div>
      {saveState.kind === "error" && (
        <p role="alert" className="mt-2 text-sm text-amber-600 dark:text-amber-500">
          Not saved to your account yet ({saveState.message}). Progress is kept in this browser, and the save completes when the connection returns.
        </p>
      )}
      {locked && (
        <div role="alert" className="mt-2 space-y-2 rounded-md border border-amber-500/50 p-3 text-sm text-amber-700 dark:text-amber-400">
          <p>
            {saveState.kind === "checking"
              ? "Your account refused the last save. Checking why; labelling here is paused."
              : saveState.kind === "conflict"
              ? "This deck was saved from another device after this one opened it. Labelling here is paused so neither copy overwrites the other."
              : saveState.kind === "removed"
                ? "This deck was removed from your account. Labelling here is paused; this device's labels can still be downloaded."
                : saveState.kind === "replaced"
                  ? "This deck was replaced in your account with different content. Labelling here is paused; this device's labels can still be downloaded."
                  : `Your account refused the save (${saveState.kind === "refused" ? saveState.message : ""}). Labelling here is paused; this device's labels can still be downloaded.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onBackToDecks} className={SECONDARY_BUTTON}>
              {saveState.kind === "conflict" ? "Load the latest" : "Back to decks"}
            </button>
            {saveState.kind === "conflict" && (
              <button type="button" onClick={onKeepThisDevice} className={SECONDARY_BUTTON}>
                {"Keep this device's copy"}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full bg-zinc-900 motion-safe:transition-[width] motion-safe:duration-200 dark:bg-zinc-100" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          Cell {active + 1} of {runs.length} · {p.done} of {p.total} labelled
          {run.source === "file" ? " · this device only" : saveState.kind === "saving" ? " · saving…" : saveState.kind === "saved" ? " · saved" : ""}
        </p>
      </div>

      {card ? (
        <>
          {/* overflow-x-clip: the fly-out must not add a horizontal scrollbar. */}
          <div className="relative mt-4 overflow-x-clip">
            {nextCard && (
              <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-2 bottom-0 scale-[0.97] opacity-60 ${CARD_SURFACE}`} />
            )}
            {ghost && <GhostCard key={ghost.key} ghost={ghost} onDone={clearGhost} />}
            <SwipeCard
              key={showing}
              ref={cardRef}
              card={card}
              secondLook={Boolean(state.requeued[card.item_id])}
              mixedAllowed={allowsMixed(card.type)}
              reducedMotion={reducedMotion}
              onSwipe={(direction, offset) => record(LABEL_FOR[direction], offset)}
              onMixedRefused={() => setRefusal(true)}
              onTap={() => setExpanded((v) => !v)}
            />
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2">
            {ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={locked || (a.label === "mixed" && !allowsMixed(card.type))}
                onClick={() => {
                  // Focus moves to the next card, so Enter or Space on a
                  // still-focused button cannot record a second decision.
                  focusCard.current = true;
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
          {refusal && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">This card takes True or False only; Mixed is for the two partial-credit questions.</p>}
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={doUndo} disabled={locked || state.history.length === 0} className={SECONDARY_BUTTON}>
              Undo (Z)
            </button>
            <button type="button" onClick={() => setExpanded((v) => !v)} className={`text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}>
              {expanded ? "Hide full text" : "Show full text"}
            </button>
          </div>
          {noteBar}
          {expanded && <SourcePanel deck={run.deck} card={card} />}
        </>
      ) : (
        <CellEnd headingRef={cellEndRef} run={run} index={active} total={runs.length} onDownload={onDownload} onUndo={doUndo} onNext={() => onOpenCell(active + 1)} noteBar={noteBar} />
      )}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div
        role="status"
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
  headingRef,
  run,
  index,
  total,
  onDownload,
  onUndo,
  onNext,
  noteBar,
}: {
  readonly headingRef: Ref<HTMLHeadingElement>;
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
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold focus:outline-none">
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
        {index < total - 1 && (
          <button type="button" onClick={onNext} className={PRIMARY_BUTTON}>
            Next cell
          </button>
        )}
        <button type="button" onClick={onDownload} className={index < total - 1 ? SECONDARY_BUTTON : PRIMARY_BUTTON}>
          Download labels
        </button>
        <button type="button" onClick={onUndo} className={SECONDARY_BUTTON}>
          Undo last
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {run.source === "account"
          ? "Your labels are saved in your account. To fill the review sheet, open Calibrate on the Mac, download the labels, and run "
          : "To fill the review sheet, download the labels and run "}
        <code>npx tsx tools/label-swipe/import-labels.mts &lt;file&gt;</code>.
      </p>
    </section>
  );
}
