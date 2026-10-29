/**
 * Calibrate container (`/calibrate`). Reads deck files the user picks,
 * resumes or starts a session per deck, persists sessions per browser, and
 * downloads the labels file `tools/label-swipe/import-labels.mts` reads.
 *
 * Decks hold private résumé and JD text: they are read with the File API,
 * kept in memory only, and never sent anywhere. No Firestore, no callable.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";

import { parseDeck } from "../../lib/labelDeck/deck.ts";
import { buildExport, exportFilename, initSession, newSessionId, randomSeed } from "../../lib/labelDeck/session.ts";

import CalibrateView, { type DeckRun } from "./CalibrateView.tsx";
import { loadSession, saveSession, type StoredSession } from "./storage.ts";

/** Parse the picked files into runs, in cell order, resuming saved sessions. */
export async function openDecks(files: readonly File[], storage?: Storage): Promise<DeckRun[]> {
  const runs: DeckRun[] = [];
  for (const file of files) {
    let deck;
    try {
      deck = parseDeck(JSON.parse(await file.text()));
    } catch (err) {
      throw new Error(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const session = loadSession(deck, storage) ?? { session_id: newSessionId(), state: initSession(deck, randomSeed()) };
    runs.push({ deck, session });
  }
  return runs.sort((a, b) => a.deck.cell_order - b.deck.cell_order);
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

export default function Calibrate(): ReactElement {
  const [runs, setRuns] = useState<DeckRun[]>([]);
  const [active, setActive] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const onOpenFiles = useCallback(async (files: File[]) => {
    setLoadError(null);
    try {
      const opened = await openDecks(files);
      setRuns(opened);
      // Resume at the first cell with cards left.
      const next = opened.findIndex((r) => r.session.state.queue.length > 0);
      setActive(next < 0 ? opened.length - 1 : next);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onSession = useCallback((index: number, next: StoredSession) => {
    saveSession(next);
    setRuns((prev) => prev.map((r, i) => (i === index ? { ...r, session: next } : r)));
  }, []);

  return (
    <CalibrateView
      runs={runs}
      active={active}
      loadError={loadError}
      reducedMotion={reducedMotion}
      onOpenFiles={(files) => void onOpenFiles(files)}
      onSession={onSession}
      onOpenCell={setActive}
      onDownload={() => runs[active] && downloadLabels(runs[active])}
    />
  );
}
