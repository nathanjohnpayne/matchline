/**
 * Calibration decks and sessions stored in the owner's account (#636), so a
 * deck uploaded once from the Mac can be labelled on the phone and the
 * progress follows between devices.
 *
 * Two owner-scoped collections, both limited by `firestore.rules`:
 *   - `calibrationDecks/{uid}__{deck_id}`: the deck as JSON text. Text
 *     rather than a nested map, so the deck's cards are not each indexed
 *     and the document stays one opaque value under the 1 MiB limit.
 *   - `calibrationSessions/{uid}__{deck_id}`: the labelling session, also
 *     as JSON text, tagged with the deck's content hash so a re-uploaded,
 *     changed deck starts a fresh session instead of reusing old labels.
 *
 * Decks hold private résumé and JD text. They stay in the owner's own
 * project under the owner allowlist; nothing here sends them anywhere else.
 */

import { FirebaseError } from "firebase/app";
import { deleteDoc, getDocs, query, setDoc } from "firebase/firestore";

import { parseDeck, type Deck } from "../lib/labelDeck/deck.ts";
import { beginAppBusy } from "../lib/appBusy.ts";
import { deckFingerprint, sessionMatchesDeck, type StoredSession } from "../lib/labelDeck/session.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

export const DECKS = "calibrationDecks";
export const SESSIONS = "calibrationSessions";

/**
 * Limits `firestore.rules` enforces (in characters); checked here so a
 * failure names its cause. Firestore's own 1 MiB document limit counts
 * UTF-8 bytes, so the deck is also checked in bytes, with headroom.
 */
export const MAX_DECK_JSON = 900_000;
export const MAX_DECK_BYTES = 1_000_000;
export const MAX_SESSION_JSON = 200_000;
/** A write that has not settled by then is reported (offline, or a stalled connection). */
export const WRITE_TIMEOUT_MS = 20_000;

export interface DeckDoc {
  id: string;
  owner_uid: string;
  deck_id: string;
  cell_order: number;
  card_count: number;
  fingerprint: string;
  deck_json: string;
  uploaded_at: string;
}

export interface SessionDoc {
  id: string;
  owner_uid: string;
  deck_id: string;
  fingerprint: string;
  session_id: string;
  /** The session's revision; the rules only accept a higher one for the same deck content. */
  rev: number;
  state_json: string;
  updated_at: string;
}

export const docIdFor = (ownerUid: string, deckId: string): string => `${ownerUid}__${deckId}`;

/** The stored deck document for `deck`. Pure, so the rules' shape is testable. */
export function buildDeckDoc(deck: Deck, ownerUid: string, now: Date): DeckDoc {
  const deck_json = JSON.stringify(deck);
  const bytes = new TextEncoder().encode(deck_json).length;
  if (deck_json.length > MAX_DECK_JSON || bytes > MAX_DECK_BYTES) {
    throw new Error(`${deck.deck_id} is too large to store (${bytes} bytes; the limit is ${MAX_DECK_BYTES}).`);
  }
  return {
    id: docIdFor(ownerUid, deck.deck_id),
    owner_uid: ownerUid,
    deck_id: deck.deck_id,
    cell_order: deck.cell_order,
    card_count: deck.cards.length,
    fingerprint: deckFingerprint(deck),
    deck_json,
    uploaded_at: now.toISOString(),
  };
}

export function buildSessionDoc(deck: Deck, stored: StoredSession, ownerUid: string, now: Date): SessionDoc {
  const state_json = JSON.stringify(stored.state);
  if (state_json.length > MAX_SESSION_JSON) throw new Error(`The session for ${deck.deck_id} is too large to store.`);
  return {
    id: docIdFor(ownerUid, deck.deck_id),
    owner_uid: ownerUid,
    deck_id: deck.deck_id,
    fingerprint: deckFingerprint(deck),
    session_id: stored.session_id,
    rev: stored.state.rev,
    state_json,
    updated_at: now.toISOString(),
  };
}

/** A stored session, if it is well-formed and belongs to exactly this deck. */
export function parseSessionDoc(data: SessionDoc | undefined, deck: Deck): StoredSession | null {
  if (!data || data.fingerprint !== deckFingerprint(deck)) return null;
  try {
    const state: unknown = JSON.parse(data.state_json);
    return sessionMatchesDeck(state, deck) ? { session_id: data.session_id, state } : null;
  } catch {
    return null;
  }
}

/** Settle `promise` within `ms`, or fail naming `what` (a pending write never settles offline). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish; check the connection`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True for the rules' refusal of a stale session write (or any permission failure). */
export const isPermissionDenied = (err: unknown): boolean => err instanceof FirebaseError && err.code === "permission-denied";

export interface AccountDeck {
  readonly deck: Deck;
  readonly uploadedAt: string;
  /** The saved session, if one matches this deck. */
  readonly session: StoredSession | null;
}

export interface AccountDeckList {
  readonly decks: AccountDeck[];
  /** Stored decks this version could not read, by deck id. */
  readonly unreadable: string[];
}

/** The owner's decks with their sessions, in cell order. */
export async function listAccountDecks(): Promise<AccountDeckList> {
  const [decks, sessions] = await Promise.all([
    getDocs(query(typedCollection<DeckDoc>(DECKS), ...ownerScope())),
    getDocs(query(typedCollection<SessionDoc>(SESSIONS), ...ownerScope())),
  ]);
  const sessionById = new Map(sessions.docs.map((d) => [d.id, d.data()]));
  const out: AccountDeck[] = [];
  const unreadable: string[] = [];
  for (const snap of decks.docs) {
    const data = snap.data();
    let deck: Deck;
    try {
      deck = parseDeck(JSON.parse(data.deck_json));
    } catch {
      unreadable.push(String(data.deck_id ?? snap.id));
      continue;
    }
    out.push({ deck, uploadedAt: data.uploaded_at, session: parseSessionDoc(sessionById.get(snap.id), deck) });
  }
  out.sort((a, b) => a.deck.cell_order - b.deck.cell_order || a.deck.deck_id.localeCompare(b.deck.deck_id));
  return { decks: out, unreadable };
}

/** Store (or replace) a deck in the owner's account. */
export async function uploadDeck(deck: Deck, now: Date = new Date()): Promise<void> {
  const data = buildDeckDoc(deck, getOwnerUidOrThrow(), now);
  const release = beginAppBusy("calibration.uploadDeck");
  try {
    await withTimeout(setDoc(typedDoc<DeckDoc>(DECKS, data.id), data), WRITE_TIMEOUT_MS, `Uploading ${deck.deck_id}`);
  } finally {
    release();
  }
}

/** Remove a deck and its session from the owner's account. */
export async function deleteAccountDeck(deckId: string): Promise<void> {
  const id = docIdFor(getOwnerUidOrThrow(), deckId);
  const release = beginAppBusy("calibration.deleteDeck");
  try {
    // Session first: a deck with no session is harmless, the reverse is an
    // orphan. A deck never labelled has no session, and the rules deny
    // deleting a missing document (permission-denied), so that is skipped.
    try {
      await withTimeout(deleteDoc(typedDoc<SessionDoc>(SESSIONS, id)), WRITE_TIMEOUT_MS, `Removing the labels of ${deckId}`);
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
    }
    await withTimeout(deleteDoc(typedDoc<DeckDoc>(DECKS, id)), WRITE_TIMEOUT_MS, `Removing ${deckId}`);
  } finally {
    release();
  }
}

/**
 * Save a deck's session to the owner's account. The rules refuse it
 * (permission-denied) when the account already holds a newer revision of
 * this session, e.g. saved from another device since this one opened it.
 */
export async function saveAccountSession(deck: Deck, stored: StoredSession, now: Date = new Date()): Promise<void> {
  const data = buildSessionDoc(deck, stored, getOwnerUidOrThrow(), now);
  const release = beginAppBusy("calibration.saveSession");
  try {
    await withTimeout(setDoc(typedDoc<SessionDoc>(SESSIONS, data.id), data), WRITE_TIMEOUT_MS, "Saving your labels");
  } finally {
    release();
  }
}
