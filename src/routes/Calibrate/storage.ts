/**
 * Per-browser persistence for Calibrate sessions. Only the session (item
 * ids, labels, notes, timings, seed, content hash) is stored, never card
 * text: decks hold private résumé and JD text and stay in memory. Storage
 * can be unavailable (private mode, blocked site data), so every access is
 * guarded and the route works without it.
 */

import type { Deck } from "../../lib/labelDeck/deck.ts";
import { sessionMatchesDeck, type StoredSession } from "../../lib/labelDeck/session.ts";

export type { StoredSession };

const PREFIX = "matchline:calibrate:v1:";

export function loadSession(deck: Deck, storage: Storage | undefined = globalThis.localStorage): StoredSession | null {
  try {
    const raw = storage?.getItem(PREFIX + deck.deck_id);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { session_id, state } = parsed as Partial<StoredSession>;
    return typeof session_id === "string" && sessionMatchesDeck(state, deck) ? { session_id, state } : null;
  } catch {
    return null;
  }
}

export function saveSession(stored: StoredSession, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(PREFIX + stored.state.deck_id, JSON.stringify(stored));
  } catch {
    // Full or blocked storage: the session still works, it just won't resume.
  }
}

export function clearSession(deckId: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(PREFIX + deckId);
  } catch {
    // As above.
  }
}
