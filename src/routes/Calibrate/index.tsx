/**
 * Calibrate container (`/calibrate`). Lists the decks stored in the owner's
 * account, uploads deck files to it, opens decks (from the account, or from
 * a file for this device only), saves each session, and downloads the
 * labels file `tools/label-swipe/import-labels.mts` reads.
 *
 * Account decks and their sessions live in the owner's own Firestore
 * (`src/services/calibration.ts`, owner-only rules). Every session is also
 * kept in this browser's localStorage (ids, labels, notes, timings, no card
 * text), so a failed or offline save loses nothing: on open, whichever
 * matching copy has more history wins.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { parseDeck, type Deck } from "../../lib/labelDeck/deck.ts";
import { buildExport, deckFingerprint, exportFilename, initSession, newSessionId, progress, randomSeed, type StoredSession } from "../../lib/labelDeck/session.ts";
import {
  deleteAccountDeck,
  isPermissionDenied,
  listAccountDecks,
  saveAccountSession,
  uploadDeck,
  type AccountDeckList,
} from "../../services/calibration.ts";

import CalibrateView, { type DeckRun, type SaveState } from "./CalibrateView.tsx";
import type { AccountState } from "./DeckScreen.tsx";
import { clearSession, loadSession, saveSession } from "./storage.ts";

/** Account saves are coalesced: at most one write per deck in flight, the latest state after this pause. */
export const SAVE_DELAY_MS = 800;

export interface CalibrationServices {
  readonly listAccountDecks: () => Promise<AccountDeckList>;
  readonly uploadDeck: (deck: Deck) => Promise<void>;
  readonly deleteAccountDeck: (deckId: string) => Promise<void>;
  readonly saveAccountSession: (deck: Deck, stored: StoredSession) => Promise<void>;
}

const FIRESTORE_SERVICES: CalibrationServices = { listAccountDecks, uploadDeck, deleteAccountDeck, saveAccountSession };

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
 * The session to resume: the matching copy with the higher revision (every
 * saved change, undo included, raises it), else a new one. On a tie the
 * account copy wins; the two are then the same save.
 */
export function pickSession(deck: Deck, account: StoredSession | null, local: StoredSession | null): StoredSession {
  if (account && local) return local.state.rev > account.state.rev ? local : account;
  return account ?? local ?? { session_id: newSessionId(), state: initSession(deck, randomSeed()) };
}

/** Account decks as listed, with each one's best known session (this browser may be ahead). */
const withLocal = (list: AccountDeckList): AccountDeckList => ({
  ...list,
  decks: list.decks.map((d) => {
    const local = loadSession(d.deck);
    return local || d.session ? { ...d, session: pickSession(d.deck, d.session, local) } : d;
  }),
});

/** Open picked files for this device only, resuming any session saved in this browser. */
export async function openDecks(files: readonly File[], storage?: Storage): Promise<DeckRun[]> {
  return (await readDeckFiles(files)).map((deck) => ({ deck, session: pickSession(deck, null, loadSession(deck, storage)), source: "file" as const }));
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
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const reducedMotion = usePrefersReducedMotion();

  // Account saves: the latest unsaved session per deck, and the decks with a write in flight.
  const pending = useRef(new Map<string, { deck: Deck; stored: StoredSession }>());
  const inflight = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflicted = useRef(false);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    for (const [deckId, item] of [...pending.current]) {
      // One write per deck at a time, so revisions reach the account in order.
      if (inflight.current.has(deckId) || conflicted.current) continue;
      pending.current.delete(deckId);
      inflight.current.add(deckId);
      setSaveState({ kind: "saving" });
      services.saveAccountSession(item.deck, item.stored).then(
        () => {
          inflight.current.delete(deckId);
          if (pending.current.size) flush();
          else if (inflight.current.size === 0) setSaveState((s) => (s.kind === "saving" || s.kind === "error" ? { kind: "saved" } : s));
        },
        (err: unknown) => {
          inflight.current.delete(deckId);
          if (isPermissionDenied(err)) {
            // The account holds a newer revision: another device saved since this one opened the deck.
            conflicted.current = true;
            pending.current.clear();
            setSaveState({ kind: "conflict" });
          } else {
            setSaveState({ kind: "error", message: message(err) });
          }
        },
      );
    }
  }, [services]);

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

  const refresh = useCallback(async () => {
    try {
      const list = withLocal(await services.listAccountDecks());
      setAccount({ status: "ready", decks: list.decks, unreadable: list.unreadable });
    } catch (err) {
      setAccount({ status: "error", error: message(err) });
    }
  }, [services]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = (opened: DeckRun[]) => {
    flush();
    conflicted.current = false;
    setLoadError(null);
    setSaveState({ kind: "idle" });
    setRuns(opened);
    setOpenCount((n) => n + 1);
    // Resume at the first cell with cards left.
    const next = opened.findIndex((r) => r.session.state.queue.length > 0);
    setActive(next < 0 ? opened.length - 1 : next);
  };

  const onOpenAccount = (deckIds: readonly string[]) => {
    if (account.status !== "ready") return;
    const wanted = new Set(deckIds);
    start(
      account.decks
        .filter((d) => wanted.has(d.deck.deck_id))
        .map((d) => ({ deck: d.deck, session: pickSession(d.deck, d.session, loadSession(d.deck)), source: "account" as const })),
    );
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
    try {
      const decks = await readDeckFiles(files);
      // Replacing a deck whose content changed makes its labels unusable (they
      // belong to the old content). Refuse while any exist, so nothing is lost
      // before it has been downloaded.
      const stored = account.status === "ready" ? account.decks : [];
      for (const deck of decks) {
        const old = stored.find((d) => d.deck.deck_id === deck.deck_id);
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
    saveSession(next);
    setRuns((prev) => prev.map((r, i) => (i === index ? { ...r, session: next } : r)));
    if (run.source === "account" && !conflicted.current) {
      pending.current.set(run.deck.deck_id, { deck: run.deck, stored: next });
      setSaveState({ kind: "saving" });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    }
  };

  const onBackToDecks = () => {
    flush();
    setRuns([]);
    void refresh();
  };

  return (
    <CalibrateView
      runs={runs}
      active={active}
      openCount={openCount}
      account={account}
      busy={busy}
      loadError={loadError}
      saveState={saveState}
      reducedMotion={reducedMotion}
      onOpenAccount={onOpenAccount}
      onOpenFiles={(files) => void onOpenFiles(files)}
      onUploadFiles={(files) => void onUploadFiles(files)}
      onRemoveDeck={(id) => void onRemoveDeck(id)}
      onSession={onSession}
      onOpenCell={setActive}
      onDownload={() => runs[active] && downloadLabels(runs[active])}
      onBackToDecks={onBackToDecks}
    />
  );
}
