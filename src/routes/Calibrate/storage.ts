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

/**
 * The store to use, read inside each caller's `try`: with site data
 * blocked, merely reading `globalThis.localStorage` throws a SecurityError,
 * so it must not be a default-argument expression.
 */
const local = (storage?: Storage): Storage | undefined => storage ?? globalThis.localStorage;

/**
 * Where a copy lives: an account deck's copy is scoped to the signed-in
 * account (another account on this browser must not pick it up), a deck
 * opened from a file to this device.
 */
export interface StorageScope {
  /** The signed-in owner's uid for an account deck; omitted for a file deck. */
  readonly ownerUid?: string;
  readonly storage?: Storage;
}

const keyFor = (deckId: string, ownerUid?: string) => `${PREFIX}${ownerUid ? `account:${ownerUid}` : "device"}:${deckId}`;

export function loadSession(deck: Deck, { ownerUid, storage }: StorageScope = {}): StoredSession | null {
  try {
    const raw = local(storage)?.getItem(keyFor(deck.deck_id, ownerUid));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { session_id, state, base_rev } = parsed as Partial<StoredSession>;
    if (typeof session_id !== "string" || !sessionMatchesDeck(state, deck)) return null;
    return typeof base_rev === "number" ? { session_id, state, base_rev } : { session_id, state };
  } catch {
    return null;
  }
}

export function saveSession(stored: StoredSession, { ownerUid, storage }: StorageScope = {}): void {
  try {
    local(storage)?.setItem(keyFor(stored.state.deck_id, ownerUid), JSON.stringify(stored));
  } catch {
    // Full or blocked storage: the session still works, it just won't resume.
  }
}

export function clearSession(deckId: string, { ownerUid, storage }: StorageScope = {}): void {
  try {
    local(storage)?.removeItem(keyFor(deckId, ownerUid));
  } catch {
    // As above.
  }
}
