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
 * Session writes are compare-and-swap. `rev` counts writes to the account
 * document; each write carries `base_rev`, the revision it was based on,
 * and the rules accept it only when that is still the stored revision. A
 * device that fell behind another one is refused, never silently merged.
 *
 * Decks hold private résumé and JD text. They stay in the owner's own
 * project under the owner allowlist; nothing here sends them anywhere else.
 */

import { FirebaseError } from "firebase/app";
import { getDoc, getDocs, query, setDoc, writeBatch } from "firebase/firestore";

import { getDb } from "../firebase.ts";

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
  /** Writes to this document so far, minus one (0 for the first). */
  rev: number;
  /** The `rev` this write replaces; -1 for the first write. */
  base_rev: number;
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

export function buildSessionDoc(deck: Deck, stored: StoredSession, ownerUid: string, now: Date, baseRev: number): SessionDoc {
  const state_json = JSON.stringify(stored.state);
  if (state_json.length > MAX_SESSION_JSON) throw new Error(`The session for ${deck.deck_id} is too large to store.`);
  return {
    id: docIdFor(ownerUid, deck.deck_id),
    owner_uid: ownerUid,
    deck_id: deck.deck_id,
    fingerprint: deckFingerprint(deck),
    session_id: stored.session_id,
    rev: baseRev + 1,
    base_rev: baseRev,
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
  /** The account session document's `rev`, whatever deck content it was for; -1 if none. */
  readonly accountRev: number;
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
    const sessionDoc = sessionById.get(snap.id);
    out.push({
      deck,
      uploadedAt: data.uploaded_at,
      session: parseSessionDoc(sessionDoc, deck),
      accountRev: typeof sessionDoc?.rev === "number" ? sessionDoc.rev : -1,
    });
  }
  out.sort((a, b) => a.deck.cell_order - b.deck.cell_order || a.deck.deck_id.localeCompare(b.deck.deck_id));
  return { decks: out, unreadable };
}

/** Store (or replace) a deck in the owner's account. */
/**
 * Hold a busy lease until `write` settles. A timeout only stops waiting:
 * the SDK keeps the write queued, so the update prompt must stay
 * suppressed until it lands (a reload would drop it).
 */
export function leaseUntilSettled<T>(label: string, write: Promise<T>): Promise<T> {
  const release = beginAppBusy(label);
  write.then(release, release);
  return write;
}

export async function uploadDeck(deck: Deck, now: Date = new Date()): Promise<void> {
  const data = buildDeckDoc(deck, getOwnerUidOrThrow(), now);
  const write = leaseUntilSettled("calibration.uploadDeck", setDoc(typedDoc<DeckDoc>(DECKS, data.id), data));
  await withTimeout(write, WRITE_TIMEOUT_MS, `Uploading ${deck.deck_id}`);
}

/** Remove a deck and its session from the owner's account. */
export async function deleteAccountDeck(deckId: string): Promise<void> {
  const id = docIdFor(getOwnerUidOrThrow(), deckId);
  // One batch, so an interrupted removal (offline, timed out) can never
  // delete the labels and leave the deck, or the reverse. The rules deny
  // deleting a missing document, so a never-labelled deck's absent session
  // is left out of the batch; reading a missing one is denied too, which
  // here just means "none".
  const sessionRef = typedDoc<SessionDoc>(SESSIONS, id);
  let hasSession = false;
  try {
    hasSession = (await getDoc(sessionRef)).exists();
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
  }
  const batch = writeBatch(getDb());
  if (hasSession) batch.delete(sessionRef);
  batch.delete(typedDoc<DeckDoc>(DECKS, id));
  await withTimeout(leaseUntilSettled("calibration.deleteDeck", batch.commit()), WRITE_TIMEOUT_MS, `Removing ${deckId}`);
}

/**
 * Save a deck's session to the owner's account, replacing revision
 * `baseRev`; resolves to the new revision once the write is committed,
 * which offline can be much later. Any rejection is final: the SDK retries
 * network failures itself and rejects only what will not succeed. The rules refuse it
 * (permission-denied) when the stored revision is no longer `baseRev`
 * (another device saved since), when the stored deck has different
 * content, or when the deck was removed; `inspectAccountSession` tells
 * which.
 */
export async function saveAccountSession(deck: Deck, stored: StoredSession, baseRev: number, now: Date = new Date()): Promise<number> {
  const data = buildSessionDoc(deck, stored, getOwnerUidOrThrow(), now, baseRev);
  const release = beginAppBusy("calibration.saveSession");
  try {
    // No timeout here: offline, the SDK keeps this write queued and commits it
    // later, so giving up on it and sending another would race the two (and
    // the compare-and-swap would refuse ours). The caller shows the wait. The
    // busy lease is held for that whole time on purpose: reloading for an
    // update while a save is queued would drop it.
    await setDoc(typedDoc<SessionDoc>(SESSIONS, data.id), data);
    return data.rev;
  } finally {
    release();
  }
}

export interface AccountSessionState {
  /** The deck is still stored, with the same content as `deck`. */
  readonly deckCurrent: boolean;
  readonly deckExists: boolean;
  /** The stored session's revision, or -1 if there is none. */
  readonly rev: number;
}

/**
 * Why a session write was refused. The rules deny reading a missing
 * document (permission-denied), which here means "not there".
 */
export async function inspectAccountSession(deck: Deck): Promise<AccountSessionState> {
  const id = docIdFor(getOwnerUidOrThrow(), deck.deck_id);
  const read = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (isPermissionDenied(err)) return null;
      throw err;
    }
  };
  const [deckSnap, sessionSnap] = await Promise.all([
    read(() => getDoc(typedDoc<DeckDoc>(DECKS, id))),
    read(() => getDoc(typedDoc<SessionDoc>(SESSIONS, id))),
  ]);
  const deckData = deckSnap?.exists() ? deckSnap.data() : null;
  const sessionData = sessionSnap?.exists() ? sessionSnap.data() : null;
  return {
    deckExists: deckData !== null,
    deckCurrent: deckData?.fingerprint === deckFingerprint(deck),
    rev: typeof sessionData?.rev === "number" ? sessionData.rev : -1,
  };
}
