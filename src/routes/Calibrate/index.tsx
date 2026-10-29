/**
 * Calibrate container (`/calibrate`). Lists the decks stored in the owner's
 * account, uploads deck files to it, opens decks (from the account, or from
 * a file for this device only), saves each session, and downloads the
 * labels file `tools/label-swipe/import-labels.mts` reads.
 *
 * Account decks and their sessions live in the owner's own Firestore
 * (`src/services/calibration.ts`, owner-only rules). Every session is also
 * kept in this browser's localStorage (ids, labels, notes, timings, no card
 * text), tagged with the account revision it builds on, so a failed or
 * offline save loses nothing.
 *
 * Account saves are compare-and-swap (see the service): each write names
 * the revision it replaces. When another device saved in between, the
 * write is refused, labelling on this device stops, and the owner chooses
 * between loading the account's copy and keeping this device's.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { parseDeck, type Deck } from "../../lib/labelDeck/deck.ts";
import { buildExport, deckFingerprint, exportFilename, initSession, newSessionId, progress, randomSeed, type StoredSession } from "../../lib/labelDeck/session.ts";
import {
  deleteAccountDeck,
  inspectAccountSession,
  isPermissionDenied,
  listAccountDecks,
  saveAccountSession,
  uploadDeck,
  type AccountDeckList,
  type AccountSessionState,
} from "../../services/calibration.ts";

import CalibrateView, { type DeckRun, type SaveState } from "./CalibrateView.tsx";
import type { AccountState } from "./DeckScreen.tsx";
import { clearSession, loadSession, saveSession } from "./storage.ts";

/** Account saves are coalesced: at most one write per deck in flight, the latest state after this pause. */
export const SAVE_DELAY_MS = 800;
/** Retry delays after a failed (not refused) save. */
const RETRY_MS = [5_000, 15_000, 60_000];

export interface CalibrationServices {
  readonly listAccountDecks: () => Promise<AccountDeckList>;
  readonly uploadDeck: (deck: Deck) => Promise<void>;
  readonly deleteAccountDeck: (deckId: string) => Promise<void>;
  readonly saveAccountSession: (deck: Deck, stored: StoredSession, baseRev: number) => Promise<number>;
  readonly inspectAccountSession: (deck: Deck) => Promise<AccountSessionState>;
}

const FIRESTORE_SERVICES: CalibrationServices = { listAccountDecks, uploadDeck, deleteAccountDeck, saveAccountSession, inspectAccountSession };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Parse picked deck files, in cell order; a bad file or a repeated deck id is named. */
export async function readDeckFiles(files: readonly File[]): Promise<Deck[]> {
  const decks: Deck[] = [];
  for (const file of files) {
    let deck: Deck;
    try {
      deck = parseDeck(JSON.parse(await file.text()));
    } catch (err) {
      throw new Error(`${file.name}: ${message(err)}`, { cause: err });
    }
    if (decks.some((d) => d.deck_id === deck.deck_id)) throw new Error(`${file.name}: deck ${deck.deck_id} was picked twice`);
    decks.push(deck);
  }
  return decks.sort((a, b) => a.cell_order - b.cell_order);
}

/**
 * The session to resume. This browser's copy wins when there is no account
 * copy, or when it builds on the account's current revision and has not
 * fallen behind it (it is the account copy plus changes not yet saved).
 * Otherwise another device has saved since, and the account copy wins.
 */
export function pickSession(deck: Deck, account: StoredSession | null, accountRev: number, local: StoredSession | null): StoredSession {
  if (local && (!account || (local.base_rev === accountRev && local.state.rev >= account.state.rev))) return local;
  return account ?? { session_id: newSessionId(), state: initSession(deck, randomSeed()) };
}

/** True when the account copy wins over browser labels that never reached the account. */
export function setsAsideLocal(account: StoredSession | null, accountRev: number, local: StoredSession | null): boolean {
  return Boolean(account && local && local.base_rev !== accountRev && local.state.rev > account.state.rev);
}

/** Account decks as listed, with each one's best known session (this browser may be ahead). */
const withLocal = (list: AccountDeckList): AccountDeckList => ({
  ...list,
  decks: list.decks.map((d) => {
    const local = loadSession(d.deck);
    return local || d.session ? { ...d, session: pickSession(d.deck, d.session, d.accountRev, local) } : d;
  }),
});

/** Open picked files for this device only, resuming any session saved in this browser. */
export async function openDecks(files: readonly File[], storage?: Storage): Promise<DeckRun[]> {
  return (await readDeckFiles(files)).map((deck) => ({ deck, session: pickSession(deck, null, -1, loadSession(deck, storage)), source: "file" as const }));
}

/** Save the labels file through a Blob download (the Files app on a phone). */
export function downloadLabels(run: DeckRun, date = new Date()): void {
  const data = buildExport(run.deck, run.session.state, run.session.session_id);
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(run.deck.deck_id, date);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function Calibrate({ services = FIRESTORE_SERVICES }: { readonly services?: CalibrationServices }): ReactElement {
  const [runs, setRuns] = useState<DeckRun[]>([]);
  const [active, setActive] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [account, setAccount] = useState<AccountState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<ReadonlyMap<string, SaveState>>(new Map());
  const reducedMotion = usePrefersReducedMotion();

  // Per deck: the account revision this device's next write replaces, the
  // latest unsaved session, the decks with a write in flight, those stopped
  // by a refused write, and the retry count after failures.
  const accountRev = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, { deck: Deck; stored: StoredSession }>());
  const inflight = useRef(new Set<string>());
  const stopped = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSaveState = useCallback((deckId: string, state: SaveState) => {
    setSaveStates((prev) => new Map(prev).set(deckId, state));
  }, []);

  const flushRef = useRef<() => void>(() => {});
  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), ms);
  }, []);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    for (const [deckId, item] of [...pending.current]) {
      // One write per deck at a time, so each names the revision it replaces.
      if (inflight.current.has(deckId) || stopped.current.has(deckId)) continue;
      pending.current.delete(deckId);
      inflight.current.add(deckId);
      const base = accountRev.current.get(deckId) ?? -1;
      setSaveState(deckId, { kind: "saving" });
      services.saveAccountSession(item.deck, item.stored, base).then(
        (rev) => {
          inflight.current.delete(deckId);
          retries.current.delete(deckId);
          accountRev.current.set(deckId, rev);
          // This browser's copy of that state now builds on the new revision.
          if (!pending.current.has(deckId)) saveSession({ ...item.stored, base_rev: rev });
          if (pending.current.has(deckId)) flushRef.current();
          else setSaveState(deckId, { kind: "saved" });
        },
        async (err: unknown) => {
          inflight.current.delete(deckId);
          if (!isPermissionDenied(err)) {
            // Offline, timed out, or transient: keep the newest state and try again later.
            if (!pending.current.has(deckId)) pending.current.set(deckId, item);
            const attempt = retries.current.get(deckId) ?? 0;
            retries.current.set(deckId, attempt + 1);
            setSaveState(deckId, { kind: "error", message: message(err) });
            schedule(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
            return;
          }
          // Refused by the rules: labelling on this deck stops; find out why before saying so.
          stopped.current.add(deckId);
          pending.current.delete(deckId);
          try {
            const now = await services.inspectAccountSession(item.deck);
            if (!now.deckExists) setSaveState(deckId, { kind: "removed" });
            else if (!now.deckCurrent) setSaveState(deckId, { kind: "replaced" });
            else if (now.rev !== base) setSaveState(deckId, { kind: "conflict", accountRev: now.rev });
            else setSaveState(deckId, { kind: "refused", message: message(err) });
          } catch (inspectErr) {
            setSaveState(deckId, { kind: "refused", message: message(inspectErr) });
          }
        },
      );
    }
  }, [services, setSaveState, schedule]);
  flushRef.current = flush;

  // Do not leave a decision unsaved when the tab is hidden or closed.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    globalThis.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      globalThis.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  /** Load the account list; returns it as stored (before merging this browser's copies). */
  const refresh = useCallback(async (): Promise<AccountDeckList | null> => {
    try {
      const list = await services.listAccountDecks();
      const merged = withLocal(list);
      setAccount({ status: "ready", decks: merged.decks, unreadable: merged.unreadable });
      return list;
    } catch (err) {
      setAccount({ status: "error", error: message(err) });
      return null;
    }
  }, [services]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = (opened: DeckRun[]) => {
    flush();
    setLoadError(null);
    setSaveStates(new Map());
    setRuns(opened);
    setOpenCount((n) => n + 1);
    // Resume at the first cell with cards left.
    const next = opened.findIndex((r) => r.session.state.queue.length > 0);
    setActive(next < 0 ? opened.length - 1 : next);
  };

  const onOpenAccount = async (deckIds: readonly string[]) => {
    // Re-read the account first: another device may have saved since the list loaded.
    const list = await refresh();
    if (!list) return;
    const wanted = new Set(deckIds);
    const setAside: string[] = [];
    const opened = list.decks
      .filter((d) => wanted.has(d.deck.deck_id))
      .map((d) => {
        const local = loadSession(d.deck);
        if (setsAsideLocal(d.session, d.accountRev, local)) setAside.push(d.deck.deck_id);
        accountRev.current.set(d.deck.deck_id, d.accountRev);
        stopped.current.delete(d.deck.deck_id);
        pending.current.delete(d.deck.deck_id);
        return { deck: d.deck, session: pickSession(d.deck, d.session, d.accountRev, local), source: "account" as const };
      });
    start(opened);
    if (setAside.length) {
      setLoadError(`Opened the account copy of ${setAside.join(", ")}: another device saved after this browser's last labels, which were set aside.`);
    }
  };

  const onOpenFiles = async (files: File[]) => {
    try {
      start(await openDecks(files));
    } catch (err) {
      setLoadError(message(err));
    }
  };

  const onUploadFiles = async (files: File[]) => {
    setLoadError(null);
    if (account.status !== "ready") return;
    try {
      const decks = await readDeckFiles(files);
      // Replacing a deck whose content changed makes its labels unusable (they
      // belong to the old content). Refuse while any exist, so nothing is lost
      // before it has been downloaded.
      for (const deck of decks) {
        const old = account.decks.find((d) => d.deck.deck_id === deck.deck_id);
        const done = old?.session ? progress(old.session.state).done : 0;
        if (old && done > 0 && deckFingerprint(old.deck) !== deckFingerprint(deck)) {
          throw new Error(
            `${deck.deck_id} has ${done} labels for different deck content. Download its labels, remove the deck, then upload the new version.`,
          );
        }
      }
      for (const [i, deck] of decks.entries()) {
        setBusy(`Uploading ${i + 1} of ${decks.length}: ${deck.deck_id}`);
        await services.uploadDeck(deck);
      }
      await refresh();
    } catch (err) {
      setLoadError(`Upload failed: ${message(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRemoveDeck = async (deckId: string) => {
    setLoadError(null);
    setBusy(`Removing ${deckId}`);
    try {
      await services.deleteAccountDeck(deckId);
      // "Remove deck and its labels" includes this browser's copy.
      clearSession(deckId);
      await refresh();
    } catch (err) {
      setLoadError(`Remove failed: ${message(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSession = (index: number, next: StoredSession) => {
    const run = runs[index];
    if (!run) return;
    const deckId = run.deck.deck_id;
    // A refused deck is locked until the owner loads the latest or keeps this copy.
    if (run.source === "account" && stopped.current.has(deckId)) return;
    saveSession(run.source === "account" ? { ...next, base_rev: accountRev.current.get(deckId) ?? -1 } : next);
    setRuns((prev) => prev.map((r, i) => (i === index ? { ...r, session: next } : r)));
    if (run.source === "account") {
      pending.current.set(deckId, { deck: run.deck, stored: next });
      setSaveState(deckId, { kind: "saving" });
      schedule(SAVE_DELAY_MS);
    }
  };

  /** After a conflict: write this device's copy over the account's newer one. */
  const onKeepThisDevice = () => {
    const run = runs[active];
    const state = run && saveStates.get(run.deck.deck_id);
    if (!run || state?.kind !== "conflict") return;
    const deckId = run.deck.deck_id;
    accountRev.current.set(deckId, state.accountRev);
    stopped.current.delete(deckId);
    pending.current.set(deckId, { deck: run.deck, stored: run.session });
    flush();
  };

  const onBackToDecks = () => {
    flush();
    setRuns([]);
    void refresh();
  };

  const run = runs[active];
  return (
    <CalibrateView
      runs={runs}
      active={active}
      openCount={openCount}
      account={account}
      busy={busy}
      loadError={loadError}
      saveState={(run && saveStates.get(run.deck.deck_id)) || { kind: "idle" }}
      reducedMotion={reducedMotion}
      onOpenAccount={(ids) => void onOpenAccount(ids)}
      onOpenFiles={(files) => void onOpenFiles(files)}
      onUploadFiles={(files) => void onUploadFiles(files)}
      onRemoveDeck={(id) => void onRemoveDeck(id)}
      onSession={onSession}
      onOpenCell={setActive}
      onDownload={() => runs[active] && downloadLabels(runs[active])}
      onBackToDecks={onBackToDecks}
      onKeepThisDevice={onKeepThisDevice}
    />
  );
}
