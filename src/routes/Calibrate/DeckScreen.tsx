/**
 * Calibrate's first screen: the decks stored in the owner's account (open
 * one or all, remove one), upload from deck files, or open a file for this
 * device only without storing it.
 */

import { useState, type ReactElement } from "react";

import { progress } from "../../lib/labelDeck/session.ts";
import type { AccountDeck } from "../../services/calibration.ts";

export const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 dark:focus-visible:ring-zinc-100 dark:focus-visible:ring-offset-zinc-950";
export const PRIMARY_BUTTON = `rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`;
export const SECONDARY_BUTTON = `rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`;

export type AccountState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ready"; readonly decks: readonly AccountDeck[] };

export interface DeckScreenProps {
  readonly account: AccountState;
  /** An upload or removal in flight, as a short status line. */
  readonly busy: string | null;
  readonly loadError: string | null;
  readonly onOpenAccount: (deckIds: readonly string[]) => void;
  readonly onUploadFiles: (files: File[]) => void;
  readonly onOpenFiles: (files: File[]) => void;
  readonly onRemoveDeck: (deckId: string) => void;
}

/** A file input dressed as a button; resets so the same file can be picked twice. */
export function FilePick({ label, className, onFiles, disabled }: { readonly label: string; readonly className: string; readonly onFiles: (files: File[]) => void; readonly disabled?: boolean }): ReactElement {
  return (
    <label className={`inline-flex cursor-pointer ${disabled ? "pointer-events-none opacity-50" : ""} ${className}`}>
      <input
        type="file"
        accept="application/json,.json"
        multiple
        disabled={disabled}
        className="sr-only"
        aria-label={label}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length) onFiles(files);
        }}
      />
      {label}
    </label>
  );
}

function DeckRow({ entry, onOpen, onRemove, disabled }: { readonly entry: AccountDeck; readonly onOpen: () => void; readonly onRemove: () => void; readonly disabled: boolean }): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const p = entry.session ? progress(entry.session.state) : { done: 0, total: entry.deck.cards.length };
  // Cells are named `<résumé>__<job>`; two short lines read better on a phone than one truncated one.
  const [resumeId, jobId] = entry.deck.deck_id.split("__");
  const status = p.done === 0 ? "Not started" : p.done === p.total ? "Done" : `${p.done} of ${p.total} labelled`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={entry.deck.deck_id}>
          {resumeId}
        </p>
        {jobId && (
          <p className="truncate text-xs text-zinc-600 dark:text-zinc-300" title={entry.deck.deck_id}>
            {jobId}
          </p>
        )}
        <p className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          {status} · {p.total} cards
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Remove deck and its labels?</span>
          <button type="button" disabled={disabled} onClick={onRemove} className={`${SECONDARY_BUTTON} border-red-600 text-red-600 dark:border-red-500 dark:text-red-500`}>
            Remove
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={SECONDARY_BUTTON}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" disabled={disabled} onClick={onOpen} className={SECONDARY_BUTTON}>
            {p.done === p.total ? "Review" : p.done ? "Resume" : "Start"}
          </button>
          <button type="button" disabled={disabled} onClick={() => setConfirming(true)} aria-label={`Remove ${entry.deck.deck_id}`} className={`text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

export default function DeckScreen({ account, busy, loadError, onOpenAccount, onUploadFiles, onOpenFiles, onRemoveDeck }: DeckScreenProps): ReactElement {
  const decks = account.status === "ready" ? account.decks : [];
  const working = busy !== null;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Calibrate</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Judge the calibration review one card at a time. Decks built by <code className="text-xs">build-deck.mts</code> are uploaded once, here or on any device,
          and then open from your account anywhere you sign in.
        </p>
      </div>

      <section aria-label="Your decks" className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Your decks</h2>
          {decks.length > 0 && (
            <button type="button" disabled={working} onClick={() => onOpenAccount(decks.map((d) => d.deck.deck_id))} className={PRIMARY_BUTTON}>
              Label all
            </button>
          )}
        </div>
        {account.status === "loading" && <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}
        {account.status === "error" && (
          <p role="alert" className="px-4 py-3 text-sm text-red-600 dark:text-red-500">
            Could not load your decks: {account.error}
          </p>
        )}
        {account.status === "ready" && decks.length === 0 && (
          <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No decks yet. Upload the deck files to start.</p>
        )}
        {decks.length > 0 && (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {decks.map((entry) => (
              <DeckRow
                key={entry.deck.deck_id}
                entry={entry}
                disabled={working}
                onOpen={() => onOpenAccount([entry.deck.deck_id])}
                onRemove={() => onRemoveDeck(entry.deck.deck_id)}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <FilePick label="Upload deck files…" className={SECONDARY_BUTTON} onFiles={onUploadFiles} disabled={working} />
        <FilePick
          label="Open a file without uploading"
          className={`text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}
          onFiles={onOpenFiles}
          disabled={working}
        />
      </div>
      {busy && (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          {busy}
        </p>
      )}
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
          ["Tap · Space", "Full text and source"],
          ["Z · N", "Undo · note after False or Mixed"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Uploaded decks and their labels are stored in your own Matchline account, readable only by you. A deck opened without uploading stays on this device, and its
        progress is kept in this browser only.
      </p>
    </div>
  );
}
