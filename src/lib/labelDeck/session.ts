/**
 * Swipe-labelling session for one deck: seeded order, decisions, unsure
 * re-queue, undo, notes, timing and the labels export (#636).
 *
 * Every function is pure (state in, new state out) so the route can keep
 * the session in React state and persist it as-is. A session holds item
 * ids, labels, notes, timings and a content hash, never card text, which
 * is what makes it safe to keep in localStorage.
 */

import { LABELS, allowsMixed, type Deck, type Label, type LabelsFile } from "./deck.ts";

export interface Decision {
  label: Label;
  note: string;
  ms: number;
  order: number;
}

export interface SessionState {
  deck_id: string;
  /** Hash of the deck's cards and sources; a changed deck starts fresh. */
  fingerprint: string;
  seed: number;
  queue: string[];
  types: Record<string, string>;
  decisions: Record<string, Decision>;
  history: { kind: "decide" | "requeue"; id: string; ms: number }[];
  undos: Record<string, number>;
  elapsed: Record<string, number>;
  requeued: Record<string, boolean>;
  counter: number;
  /**
   * Revision: +1 on every change that is saved (decision, re-queue, undo,
   * note). It only grows, so two copies of one session (this browser, the
   * account) compare by it, and the rules refuse an account write that
   * would replace a newer revision with an older one.
   */
  rev: number;
}

/** A session plus the id its labels file carries. */
export interface StoredSession {
  session_id: string;
  state: SessionState;
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Fisher-Yates with the seeded PRNG; the input is not modified. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = prng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

export function newSessionId(): string {
  return globalThis.crypto.randomUUID();
}

export function deckFingerprint(deck: Pick<Deck, "cards" | "sources">): string {
  const text = JSON.stringify([deck.cards, deck.sources]);
  return `${hashString(text).toString(16).padStart(8, "0")}:${text.length}`;
}

export function initSession(deck: Deck, seed: number): SessionState {
  const types: Record<string, string> = {};
  for (const card of deck.cards) types[card.item_id] = card.type;
  return {
    deck_id: deck.deck_id,
    fingerprint: deckFingerprint(deck),
    seed,
    queue: shuffle(
      deck.cards.map((c) => c.item_id),
      seed,
    ),
    types,
    decisions: {},
    history: [],
    undos: {},
    elapsed: {},
    requeued: {},
    counter: 0,
    rev: 0,
  };
}

export const current = (state: SessionState): string | null => state.queue[0] ?? null;

const whole = (ms: number) => Math.max(0, Math.round(ms || 0));

/**
 * Record a decision on the current card. `unsure` the first time re-queues
 * the card at the end, to be shown again with its source open; a second
 * `unsure` is final. `mixed` on a true/false-only card is ignored.
 */
export function decide(state: SessionState, label: Label, ms: number): SessionState {
  const id = current(state);
  if (id === null || !LABELS.includes(label)) return state;
  if (label === "mixed" && !allowsMixed(state.types[id])) return state;
  const spent = whole(ms);
  if (label === "unsure" && !state.requeued[id]) {
    return {
      ...state,
      queue: [...state.queue.slice(1), id],
      requeued: { ...state.requeued, [id]: true },
      elapsed: { ...state.elapsed, [id]: (state.elapsed[id] ?? 0) + spent },
      history: [...state.history, { kind: "requeue", id, ms: spent }],
      rev: state.rev + 1,
    };
  }
  const order = state.counter + 1;
  return {
    ...state,
    queue: state.queue.slice(1),
    counter: order,
    decisions: { ...state.decisions, [id]: { label, note: "", ms: (state.elapsed[id] ?? 0) + spent, order } },
    history: [...state.history, { kind: "decide", id, ms: spent }],
    rev: state.rev + 1,
  };
}

/** Attach a one-line note to a decided `false` / `mixed` item. */
export function setNote(state: SessionState, id: string, note: string): SessionState {
  const d = state.decisions[id];
  if (!d || (d.label !== "false" && d.label !== "mixed")) return state;
  const text = note.replace(/\s+/g, " ").trim().slice(0, 300);
  return { ...state, decisions: { ...state.decisions, [id]: { ...d, note: text } }, rev: state.rev + 1 };
}

/**
 * Bank time spent on the current card without deciding it (before an undo
 * moves another card in front of it), so its exported ms stays cumulative.
 */
export function addTime(state: SessionState, ms: number): SessionState {
  const id = current(state);
  const spent = whole(ms);
  if (id === null || spent === 0) return state;
  return { ...state, elapsed: { ...state.elapsed, [id]: (state.elapsed[id] ?? 0) + spent } };
}

/** Undo the last decide / re-queue: the card returns to the front, its time kept. */
export function undo(state: SessionState): SessionState {
  const last = state.history.at(-1);
  if (!last) return state;
  const history = state.history.slice(0, -1);
  const undos = { ...state.undos, [last.id]: (state.undos[last.id] ?? 0) + 1 };
  if (last.kind === "requeue") {
    const queue = state.queue.slice();
    queue.splice(queue.lastIndexOf(last.id), 1);
    const requeued = { ...state.requeued };
    delete requeued[last.id];
    return { ...state, history, undos, requeued, queue: [last.id, ...queue], rev: state.rev + 1 };
  }
  const decisions = { ...state.decisions };
  const undone = decisions[last.id];
  delete decisions[last.id];
  return {
    ...state,
    history,
    undos,
    decisions,
    counter: state.counter - 1,
    rev: state.rev + 1,
    queue: [last.id, ...state.queue],
    elapsed: { ...state.elapsed, [last.id]: undone ? undone.ms : (state.elapsed[last.id] ?? 0) },
  };
}

export function progress(state: SessionState): { done: number; total: number } {
  return { done: Object.keys(state.decisions).length, total: Object.keys(state.types).length };
}

/** The labels file `tools/label-swipe/import-labels.mts` reads. */
export function buildExport(deck: Deck, state: SessionState, sessionId: string): LabelsFile {
  const byId = new Map(deck.cards.map((c) => [c.item_id, c]));
  const items = Object.entries(state.decisions)
    .map(([id, d]) => {
      const card = byId.get(id);
      return {
        item_id: id,
        type: card?.type ?? state.types[id],
        label: d.label,
        note: d.note,
        ms: d.ms,
        order: d.order,
        undos: state.undos[id] ?? 0,
        catch: Boolean(card?.catch),
      };
    })
    .sort((a, b) => a.order - b.order);
  const catches = items.filter((i) => i.catch);
  return {
    deck_id: deck.deck_id,
    seed: state.seed,
    session_id: sessionId,
    items,
    attention: {
      catch_cards: catches.length,
      catch_correct: catches.filter((i) => byId.get(i.item_id)?.expected === i.label).length,
    },
  };
}

export function exportFilename(deckId: string, date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
  return `labels-${deckId}-${stamp}.json`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A persisted session is usable only if it is well-formed and describes
 * exactly this deck: same id, same item ids, same content hash.
 */
export function sessionMatchesDeck(state: unknown, deck: Deck): state is SessionState {
  if (!isRecord(state) || state.deck_id !== deck.deck_id || !isRecord(state.types)) return false;
  if (state.fingerprint !== deckFingerprint(deck)) return false;
  if (!Array.isArray(state.queue) || !Array.isArray(state.history)) return false;
  if (!["decisions", "requeued", "undos", "elapsed"].every((f) => isRecord(state[f]))) return false;
  if (typeof state.seed !== "number" || typeof state.counter !== "number" || typeof state.rev !== "number") return false;
  const types = state.types;
  return deck.cards.length === Object.keys(types).length && deck.cards.every((c) => types[c.item_id] === c.type);
}
