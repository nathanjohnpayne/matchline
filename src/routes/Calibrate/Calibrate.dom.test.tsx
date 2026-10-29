// @vitest-environment jsdom
/**
 * DOM tests for the Calibrate route (#636): keyboard, pointer swipes, tap,
 * unsure re-queue, undo, notes, the cell end and the labels download. The
 * view runs with the real session reducer in a small stateful harness, the
 * way the container wires it, so nothing here touches Firebase.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Card, Deck, LabelsFile } from "../../lib/labelDeck/deck.ts";
import { deckFingerprint, initSession, type StoredSession } from "../../lib/labelDeck/session.ts";
import { FirebaseError } from "firebase/app";

import type { AccountDeck } from "../../services/calibration.ts";

import CalibrateView, { type CalibrateViewProps, type DeckRun } from "./CalibrateView.tsx";
import Calibrate, { downloadLabels, openDecks, pickSession, readDeckFiles, setsAsideLocal, type CalibrationServices } from "./index.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function card(item_id: string, type: Card["type"], claim: string): Card {
  return {
    item_id,
    type,
    catch: false,
    claim: [{ label: "Extracted raw_text", text: claim }],
    evidence: [{ label: "Résumé line", text: `${claim} (source)` }],
    source: "resume",
    highlight: { resume: [1], jd: [] },
  };
}

const deck: Deck = {
  format: "matchline-label-deck/1",
  deck_id: "demo-cell",
  cell_order: 0,
  sources: { resume: { title: "Résumé demo", text: "Riley Demo\nBuilt the widget API.\nShipped Gizmo 3." }, jd: { title: "JD demo", text: "PM, Widgets" } },
  cards: [card("ext:u_a:A/fact-correct", "fact-correct", "Built the widget API."), card("ext:u_a:A/verbatim", "verbatim", "Shipped Gizmo 3."), card("pair:u_a:r_b/match-pair-agree", "match-pair-agree", "Led the launch.")],
};

const NOOP_PROPS: Omit<CalibrateViewProps, "runs" | "onSession" | "onDownload"> = {
  active: 0,
  openCount: 1,
  account: { status: "ready", decks: [] },
  busy: null,
  loadError: null,
  saveState: { kind: "idle" },
  reducedMotion: true,
  onOpenAccount: () => {},
  onUploadFiles: () => {},
  onOpenFiles: () => {},
  onRemoveDeck: () => {},
  onOpenCell: () => {},
  onBackToDecks: () => {},
  onKeepThisDevice: () => {},
};

/** The container's wiring, minus decks and storage; queue in deck order unless given. */
function Harness({
  onDownload = () => {},
  clock,
  queue = deck.cards.map((c) => c.item_id),
  reducedMotion = true,
}: {
  onDownload?: (run: DeckRun) => void;
  clock: { t: number };
  queue?: string[];
  reducedMotion?: boolean;
}) {
  const [session, setSession] = useState<StoredSession>({ session_id: "s-test", state: { ...initSession(deck, 1), queue } });
  const run: DeckRun = { deck, session, source: "account" };
  return (
    <CalibrateView
      {...NOOP_PROPS}
      reducedMotion={reducedMotion}
      runs={[run]}
      onSession={(_i, next) => setSession(next)}
      onDownload={() => onDownload(run)}
      now={() => clock.t}
    />
  );
}

/** Run the harness and capture the decisions at download time. */
function exportedDecisions(clock: { t: number }, queue?: string[]) {
  const out: { current: Record<string, { label: string; ms: number }> } = { current: {} };
  render(
    <Harness
      clock={clock}
      queue={queue}
      onDownload={(run) => {
        out.current = JSON.parse(JSON.stringify(run.session.state.decisions));
      }}
    />,
  );
  return () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Download labels" })[0]);
    return out.current;
  };
}

const question = () => screen.getByTestId("calibrate-card").querySelector("h2")?.textContent;
const key = (k: string) => fireEvent.keyDown(document, { key: k });

describe("Calibrate view", () => {
  it("opens on the deck screen when no deck is loaded", () => {
    render(<CalibrateView {...NOOP_PROPS} loadError="bad.json: not a label deck" runs={[]} onSession={() => {}} onDownload={() => {}} />);
    expect(screen.getByLabelText("Upload deck files…")).toBeTruthy();
    expect(screen.getByLabelText("Open a file without uploading")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("bad.json");
    expect(screen.getByText(/No decks yet/)).toBeTruthy();
  });

  it("labels with the arrow keys, times each card, and refuses Mixed on a True/False card", () => {
    const clock = { t: 0 };
    let exported: LabelsFile | null = null;
    render(
      <Harness
        clock={clock}
        onDownload={(run) => {
          exported = JSON.parse(JSON.stringify(run.session.state.decisions));
        }}
      />,
    );
    expect(question()).toBe("Is this a true fact from the résumé?");
    clock.t = 1500;
    key("ArrowDown"); // fact-correct takes Mixed
    expect(screen.getByText(/1 of 3 labelled/)).toBeTruthy();
    expect(question()).toBe("Is the raw_text a quote from one résumé line?");
    expect((screen.getByRole("button", { name: /Mixed/ }) as HTMLButtonElement).disabled).toBe(true);
    key("ArrowDown"); // verbatim does not
    expect(screen.getByText(/1 of 3 labelled/)).toBeTruthy();
    expect(screen.getByText(/takes True or False only/)).toBeTruthy();
    clock.t = 2000;
    key("ArrowRight");
    fireEvent.click(screen.getAllByRole("button", { name: "Download labels" })[0]);
    expect(exported).toMatchObject({
      "ext:u_a:A/fact-correct": { label: "mixed", ms: 1500, order: 1 },
      "ext:u_a:A/verbatim": { label: "true", ms: 500, order: 2 },
    });
  });

  it("swipes with the pointer past the threshold and springs back short of it", () => {
    render(<Harness clock={{ t: 0 }} />);
    const swipe = (dx: number, dy: number) => {
      const el = screen.getByTestId("calibrate-card");
      fireEvent.pointerDown(el, { button: 0, isPrimary: true, clientX: 200, clientY: 300, pointerId: 1 });
      fireEvent.pointerMove(el, { isPrimary: true, clientX: 200 + dx / 2, clientY: 300 + dy / 2, pointerId: 1 });
      fireEvent.pointerMove(el, { isPrimary: true, clientX: 200 + dx, clientY: 300 + dy, pointerId: 1 });
      fireEvent.pointerUp(el, { isPrimary: true, clientX: 200 + dx, clientY: 300 + dy, pointerId: 1 });
    };
    swipe(60, 0);
    expect(screen.getByText(/0 of 3 labelled/)).toBeTruthy();
    expect(screen.getByTestId("calibrate-card").style.transform).toBe("");
    swipe(-160, 20);
    expect(screen.getByText(/1 of 3 labelled/)).toBeTruthy();
    expect(question()).toBe("Is the raw_text a quote from one résumé line?");
  });

  it("opens the full source on a tap, with the evidence line highlighted", () => {
    render(<Harness clock={{ t: 0 }} />);
    const el = screen.getByTestId("calibrate-card");
    fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { isPrimary: true, pointerId: 1, clientX: 12, clientY: 11 });
    const source = screen.getByRole("region", { name: "Full source" });
    expect(source.querySelector("[data-hit]")?.textContent).toBe("Built the widget API.");
    key(" ");
    expect(screen.queryByRole("region", { name: "Full source" })).toBeNull();
  });

  it("re-queues Can't tell at the end with the source open, then records a second Can't tell", () => {
    render(<Harness clock={{ t: 0 }} />);
    key("ArrowUp");
    expect(screen.getByRole("status").textContent).toContain("Moved to the end");
    key("ArrowRight");
    key("ArrowRight");
    expect(question()).toBe("Is this a true fact from the résumé?");
    expect(screen.getByText("Second look")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Full source" })).toBeTruthy();
    key("ArrowUp");
    expect(screen.getByRole("region", { name: "Cell done" }).textContent).toContain("2 · 0 · 0 · 1");
  });

  it("undoes with Z, back to the same card, and notes a False card with N", () => {
    render(<Harness clock={{ t: 0 }} />);
    key("ArrowLeft");
    key("z");
    expect(question()).toBe("Is this a true fact from the résumé?");
    expect(screen.getByText(/0 of 3 labelled/)).toBeTruthy();
    key("ArrowLeft");
    key("n");
    const input = screen.getByLabelText("Note for the last card");
    fireEvent.change(input, { target: { value: "  wrong   year " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(screen.getByRole("status").textContent).toBe("Note saved");
    key("ArrowRight");
    key("ArrowRight");
    const done = screen.getByRole("region", { name: "Cell done" });
    expect(within(done).getByText("Undos").nextSibling?.textContent).toBe("1");
  });

  it("lets the last card of a cell take a note on the end screen", () => {
    render(<Harness clock={{ t: 0 }} />);
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft");
    expect(screen.getByRole("region", { name: "Cell done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add a note to the last card/ }));
    expect(screen.getByLabelText("Note for the last card")).toBeTruthy();
  });
});

describe("Calibrate timing and input edge cases", () => {
  it("restarts the clock and opens the source when Can't tell leaves the last card on screen", () => {
    const clock = { t: 0 };
    const download = exportedDecisions(clock, ["ext:u_a:A/verbatim"]);
    const el = screen.getByTestId("calibrate-card");
    clock.t = 1000;
    fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(el, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.pointerMove(el, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerUp(el, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 150 });
    expect(screen.getByText("Second look")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Full source" })).toBeTruthy();
    expect(screen.getByTestId("calibrate-card").style.transform).toBe("");
    clock.t = 1500;
    key("ArrowRight");
    expect(download()["ext:u_a:A/verbatim"]).toMatchObject({ label: "true", ms: 1500 });
  });

  it("ignores a second pointer while one finger is dragging", () => {
    render(<Harness clock={{ t: 0 }} />);
    const el = screen.getByTestId("calibrate-card");
    fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerDown(el, { button: 0, isPrimary: false, pointerId: 2, clientX: 50, clientY: 300 });
    fireEvent.pointerMove(el, { isPrimary: false, pointerId: 2, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(el, { isPrimary: false, pointerId: 2, clientX: 400, clientY: 300 });
    expect(screen.getByText(/0 of 3 labelled/)).toBeTruthy();
    fireEvent.pointerUp(el, { isPrimary: true, pointerId: 1, clientX: 202, clientY: 300 });
    expect(screen.getByRole("region", { name: "Full source" })).toBeTruthy();
  });

  it("ignores a held arrow key", () => {
    render(<Harness clock={{ t: 0 }} />);
    key("ArrowRight");
    fireEvent.keyDown(document, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(document, { key: "ArrowRight", repeat: true });
    expect(screen.getByText(/1 of 3 labelled/)).toBeTruthy();
  });

  it("pauses the clock while the tab is hidden and while a note is open, and banks time across an undo", () => {
    const clock = { t: 0 };
    const download = exportedDecisions(clock);
    const hidden = (value: boolean) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      fireEvent(document, new Event("visibilitychange"));
    };
    clock.t = 100;
    hidden(true);
    clock.t = 10_100; // 10 s away from the tab
    hidden(false);
    clock.t = 10_300;
    key("ArrowLeft"); // fact-correct: 300 ms on screen
    clock.t = 10_400;
    key("n");
    clock.t = 40_400; // 30 s typing the note
    fireEvent.submit(screen.getByLabelText("Note for the last card").closest("form") as HTMLFormElement);
    clock.t = 41_000; // verbatim card: 100 ms before the note + 600 after it
    key("z"); // back to fact-correct; verbatim keeps its 700 ms
    clock.t = 41_200;
    key("ArrowRight"); // fact-correct again: 300 + 200
    clock.t = 41_300;
    key("ArrowRight"); // verbatim: 700 + 100
    hidden(false);
    const d = download();
    expect(d["ext:u_a:A/fact-correct"].ms).toBe(500);
    expect(d["ext:u_a:A/verbatim"].ms).toBe(800);
  });

  it("does not replay the last fly-out after undo from the cell end", async () => {
    render(<Harness clock={{ t: 0 }} reducedMotion={false} queue={["ext:u_a:A/verbatim"]} />);
    key("ArrowRight");
    expect(screen.getByRole("region", { name: "Cell done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo last" }));
    await waitFor(() => expect(screen.getByTestId("calibrate-card")).toBeTruthy());
    expect(document.querySelectorAll('[aria-hidden="true"].z-20').length).toBe(0);
  });

  it("leaves Space to a focused button, and moves focus to the next card after a button decision", () => {
    render(<Harness clock={{ t: 0 }} />);
    const undoButton = screen.getByRole("button", { name: /Undo/ });
    undoButton.focus();
    fireEvent.keyDown(undoButton, { key: " " });
    expect(screen.queryByRole("region", { name: "Full source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /True/ }));
    expect(document.activeElement).toBe(screen.getByTestId("calibrate-card"));
    expect(document.querySelector("[aria-live]")?.textContent).toContain("True. 2 left");
  });
});

describe("Calibrate container with account decks", () => {
  /**
   * An in-memory account with the rules' compare-and-swap: a session write
   * must name the stored revision, and its deck must be stored with the
   * same content. `bump` plays another device saving in between.
   */
  function fakeAccount(initialDecks: Deck[] = []) {
    const decks = new Map(initialDecks.map((d) => [d.deck_id, d]));
    const sessions = new Map<string, { rev: number; stored: StoredSession; fingerprint: string }>();
    const calls = { uploads: [] as string[], saves: [] as number[], removes: [] as string[] };
    const denied = () => new FirebaseError("permission-denied", "Missing or insufficient permissions.");
    const services: CalibrationServices = {
      listAccountDecks: async () => ({
        decks: [...decks.values()].map((d): AccountDeck => {
          const s = sessions.get(d.deck_id);
          return { deck: d, uploadedAt: "now", session: s && s.fingerprint === deckFingerprint(d) ? s.stored : null, accountRev: s?.rev ?? -1 };
        }),
        unreadable: [],
      }),
      uploadDeck: async (d) => {
        calls.uploads.push(d.deck_id);
        decks.set(d.deck_id, d);
      },
      deleteAccountDeck: async (id) => {
        calls.removes.push(id);
        decks.delete(id);
        sessions.delete(id);
      },
      saveAccountSession: async (d, stored, base) => {
        const current = sessions.get(d.deck_id);
        const storedDeck = decks.get(d.deck_id);
        if (!storedDeck || deckFingerprint(storedDeck) !== deckFingerprint(d) || (current?.rev ?? -1) !== base) throw denied();
        sessions.set(d.deck_id, { rev: base + 1, stored: JSON.parse(JSON.stringify(stored)), fingerprint: deckFingerprint(d) });
        calls.saves.push(base + 1);
        return base + 1;
      },
      ownerUid: () => "uid-test",
      inspectAccountSession: async (d) => ({
        deckExists: decks.has(d.deck_id),
        deckCurrent: decks.has(d.deck_id) && deckFingerprint(decks.get(d.deck_id) as Deck) === deckFingerprint(d),
        rev: sessions.get(d.deck_id)?.rev ?? -1,
      }),
    };
    const bump = (id: string) => {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, rev: s.rev + 1 });
    };
    return { services, calls, sessions, decks, bump };
  }
  const file = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: "application/json" });
  const saved = () => screen.findByText(/· saved/, undefined, { timeout: 3000 });

  it("uploads deck files, lists them, labels from the account and saves each decision there", async () => {
    const { services, calls, sessions } = fakeAccount();
    render(<Calibrate services={services} />);
    await screen.findByText(/No decks yet/);
    fireEvent.change(screen.getByLabelText("Upload deck files…"), { target: { files: [file("a.json", deck)] } });
    await screen.findByText("demo-cell");
    expect(calls.uploads).toEqual(["demo-cell"]);
    fireEvent.click(screen.getByRole("button", { name: "Label all" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await saved();
    key("ArrowLeft");
    await saved();
    expect(calls.saves).toEqual([0, 1]);
    expect(Object.keys(sessions.get("demo-cell")?.stored.state.decisions ?? {})).toHaveLength(2);
  });

  /** A save the test settles by hand, like a write queued while offline. */
  function deferredSaves(account: ReturnType<typeof fakeAccount>) {
    const queue: { run: () => Promise<number>; resolve: (n: number) => void; reject: (e: unknown) => void }[] = [];
    const save = (d: Deck, st: StoredSession, base: number, owner: string) =>
      new Promise<number>((resolve, reject) => queue.push({ run: () => account.services.saveAccountSession(d, st, base, owner), resolve, reject }));
    const land = async () => {
      const next = queue.shift()!;
      await act(async () => {
        await next.run().then(next.resolve, next.reject);
      });
    };
    return { save, queue, land };
  }

  it("never sends a second write while one is unsettled, shows the wait, and lands both in order", async () => {
    const account = fakeAccount([deck]);
    const slow = deferredSaves(account);
    render(<Calibrate services={{ ...account.services, saveAccountSession: slow.save }} slowSaveMs={50} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    key("ArrowRight");
    expect((await screen.findByRole("alert", undefined, { timeout: 3000 })).textContent).toContain("waiting for the connection");
    await new Promise((r) => setTimeout(r, 1000));
    expect(slow.queue).toHaveLength(1); // the second decision waits for the first write
    await slow.land();
    await waitFor(() => expect(slow.queue).toHaveLength(1));
    await slow.land();
    await saved();
    expect(account.calls.saves).toEqual([0, 1]);
  });

  it("resumes this device's own labels after a reload between two saves", async () => {
    const account = fakeAccount([deck]);
    const slow = deferredSaves(account);
    const first = render(<Calibrate services={{ ...account.services, saveAccountSession: slow.save }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    key("ArrowRight"); // pending behind the first write
    await slow.land(); // the first write lands; the second is now in flight
    first.unmount(); // the tab goes before the second lands
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByTestId("calibrate-card");
    expect(screen.getByText(/2 of 3 labelled/)).toBeTruthy();
    expect(screen.queryByText(/replaced by it/)).toBeNull();
    // The resumed labels are sent to the account without waiting for a new decision.
    await saved();
    expect(Object.keys(account.sessions.get("demo-cell")?.stored.state.decisions ?? {})).toHaveLength(2);
  });

  it("keeps labels made during an in-flight save when going back and reopening the deck", async () => {
    const account = fakeAccount([deck]);
    const slow = deferredSaves(account);
    render(<Calibrate services={{ ...account.services, saveAccountSession: slow.save }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    key("ArrowLeft"); // pending behind the in-flight write
    fireEvent.click(screen.getByRole("button", { name: "Decks" }));
    fireEvent.click(await screen.findByRole("button", { name: /Resume|Start/ }));
    await screen.findByTestId("calibrate-card");
    expect(screen.getByText(/2 of 3 labelled/)).toBeTruthy();
    await slow.land();
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    await slow.land();
    await saved();
    expect(Object.keys(account.sessions.get("demo-cell")?.stored.state.decisions ?? {})).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem("matchline:calibrate:v1:account:uid-test:demo-cell") ?? "{}").state.counter).toBe(2);
  });

  it("pauses on a save the account can never accept, with the reason", async () => {
    const account = fakeAccount([deck]);
    render(<Calibrate services={{ ...account.services, saveAccountSession: () => Promise.reject(new Error("The session for demo-cell is too large to store.")) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    expect((await screen.findByRole("alert", undefined, { timeout: 3000 })).textContent).toContain("too large");
    expect((screen.getByRole("button", { name: /True/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pauses labelling when another device saved in between, then keeps this device's copy on request", async () => {
    const account = fakeAccount([deck]);
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await saved();
    account.bump("demo-cell"); // another device saves
    key("ArrowRight");
    expect((await screen.findByRole("alert", undefined, { timeout: 3000 })).textContent).toContain("saved from another device");
    // Paused: no decision is taken while the conflict stands.
    key("ArrowRight");
    expect(screen.getByText(/2 of 3 labelled/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /True/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep this device's copy" }));
    await saved();
    expect(account.sessions.get("demo-cell")?.rev).toBe(2);
    expect(Object.keys(account.sessions.get("demo-cell")?.stored.state.decisions ?? {})).toHaveLength(2);
  });

  it("opens the account copy, not this browser's, when another device saved since", async () => {
    const account = fakeAccount([deck]);
    const first = render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await saved();
    first.unmount();
    // Another device labels two more cards on top of revision 0.
    const other = account.sessions.get("demo-cell")!;
    let st = other.stored.state;
    st = { ...st, rev: st.rev + 5 };
    account.sessions.set("demo-cell", { ...other, rev: 1, stored: { ...other.stored, state: st } });
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await saved();
    expect(account.calls.saves).toEqual([0, 2]);
  });

  it("tells the reviewer, in the opened review, when this browser's unsaved labels were replaced", async () => {
    const account = fakeAccount([deck]);
    // This browser holds labels on revision 0 that never reached the account,
    // while another device has moved the account on to revision 1.
    const accountCopy = { session_id: "s", state: { ...initSession(deck, 1), rev: 2 } };
    account.sessions.set("demo-cell", { rev: 1, stored: accountCopy, fingerprint: deckFingerprint(deck) });
    localStorage.setItem(
      "matchline:calibrate:v1:account:uid-test:demo-cell",
      JSON.stringify({
        ...accountCopy,
        base_rev: 0,
        state: { ...accountCopy.state, rev: 5, decisions: { [deck.cards[0].item_id]: { label: "false", note: "wrong year", ms: 1, order: 1 } } },
      }),
    );
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start|Resume/ }));
    await screen.findByTestId("calibrate-card");
    expect(screen.getByRole("alert").textContent).toContain("replaced by it");
  });

  it("keeps a save that lands after an account switch in the scope of the owner who made it", async () => {
    const account = fakeAccount([deck]);
    const slow = deferredSaves(account);
    let uid = "alice";
    render(<Calibrate services={{ ...account.services, ownerUid: () => uid, saveAccountSession: slow.save }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    key("ArrowLeft"); // Alice's next decision, pending behind the first write
    uid = "bob";
    await slow.land();
    expect(localStorage.getItem("matchline:calibrate:v1:account:bob:demo-cell")).toBeNull();
    const alices = JSON.parse(localStorage.getItem("matchline:calibrate:v1:account:alice:demo-cell") ?? "{}");
    expect(alices.base_rev).toBe(0);
    expect(alices.state.counter).toBe(2);
    // Alice's pending labels are never sent while Bob is signed in.
    await new Promise((r) => setTimeout(r, 1200));
    expect(slow.queue).toHaveLength(0);
    expect(account.calls.saves).toEqual([0]);
  });

  it("keeps a newer mount's labels when an older mount's save lands after leaving and returning", async () => {
    const account = fakeAccount([deck]);
    const slow = deferredSaves(account);
    const services = { ...account.services, saveAccountSession: slow.save };
    const first = render(<Calibrate services={services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    first.unmount(); // leave Calibrate while the write is in flight
    render(<Calibrate services={services} />);
    fireEvent.click(await screen.findByRole("button", { name: /Resume|Start/ }));
    await screen.findByTestId("calibrate-card");
    key("ArrowLeft"); // a new decision on the new mount, queued behind the old write
    await slow.land();
    expect(JSON.parse(localStorage.getItem("matchline:calibrate:v1:account:uid-test:demo-cell") ?? "{}").state.counter).toBe(2);
    await waitFor(() => expect(slow.queue).toHaveLength(1), { timeout: 3000 });
    await slow.land();
    await saved();
    expect(Object.keys(account.sessions.get("demo-cell")?.stored.state.decisions ?? {})).toHaveLength(2);
  });

  it("names a removed deck instead of calling it a conflict", async () => {
    const account = fakeAccount([deck]);
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("calibrate-card");
    account.decks.delete("demo-cell");
    key("ArrowRight");
    expect((await screen.findByRole("alert", undefined, { timeout: 3000 })).textContent).toContain("removed from your account");
  });

  it("refuses to replace a deck whose labels belong to different content, and shows unreadable decks", async () => {
    const labelled = { session_id: "s", state: { ...initSession(deck, 1), rev: 1, decisions: { [deck.cards[0].item_id]: { label: "true" as const, note: "", ms: 1, order: 1 } } } };
    const account = fakeAccount([deck]);
    render(
      <Calibrate
        services={{ ...account.services, listAccountDecks: async () => ({ decks: [{ deck, uploadedAt: "now", session: labelled, accountRev: 0 }], unreadable: ["old-cell"] }) }}
      />,
    );
    expect((await screen.findAllByRole("alert"))[0].textContent).toContain("old-cell");
    const edited = { ...deck, sources: { ...deck.sources, jd: { title: "JD demo", text: "edited" } } };
    fireEvent.change(screen.getByLabelText("Upload deck files…"), { target: { files: [file("a.json", edited)] } });
    expect((await screen.findByText(/has 1 labels for different deck content/)).textContent).toContain("Download its labels");
    expect(account.calls.uploads).toEqual([]);
  });

  it("removes a deck only after confirming, with this browser's copy", async () => {
    const account = fakeAccount([deck]);
    localStorage.setItem("matchline:calibrate:v1:account:uid-test:demo-cell", "{}");
    render(<Calibrate services={account.services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove demo-cell" }));
    expect(account.calls.removes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText(/No decks yet/);
    expect(account.calls.removes).toEqual(["demo-cell"]);
    expect(localStorage.getItem("matchline:calibrate:v1:account:uid-test:demo-cell")).toBeNull();
  });

  it("names a deck picked twice, and resumes this browser's copy only when it builds on the account's revision", async () => {
    await expect(readDeckFiles([file("a.json", deck), file("b.json", deck)])).rejects.toThrow(/picked twice/);
    const base = { session_id: "x", state: initSession(deck, 1) };
    const accountCopy = { ...base, state: { ...base.state, rev: 3 } };
    const ahead = { ...base, session_id: "local", base_rev: 5, state: { ...base.state, rev: 4 } };
    expect(pickSession(deck, accountCopy, 5, ahead).session_id).toBe("local");
    expect(pickSession(deck, accountCopy, 6, ahead).session_id).toBe("x");
    // Set-aside is about lost labels, not counters: equal revisions, different decisions.
    const mine = { ...base, base_rev: 5, state: { ...base.state, rev: 3, decisions: { a: { label: "true" as const, note: "", ms: 1, order: 1 } } } };
    const theirs = { ...base, state: { ...base.state, rev: 3, decisions: { a: { label: "false" as const, note: "", ms: 1, order: 1 } } } };
    expect(setsAsideLocal(theirs, 6, mine)).toBe(true);
    expect(setsAsideLocal({ ...theirs, state: { ...theirs.state, decisions: mine.state.decisions } }, 6, mine)).toBe(false);
    expect(setsAsideLocal(theirs, 5, mine)).toBe(false);
    expect(pickSession(deck, null, -1, ahead).session_id).toBe("local");
    expect(pickSession(deck, null, -1, null).state.deck_id).toBe("demo-cell");
  });
});

describe("Calibrate container helpers", () => {
  const file = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: "application/json" });

  it("opens decks in cell order and names a file that is not a deck", async () => {
    const second = { ...deck, deck_id: "b-cell", cell_order: 1 };
    const runs = await openDecks([file("b.json", second), file("a.json", deck)]);
    expect(runs.map((r) => r.deck.deck_id)).toEqual(["demo-cell", "b-cell"]);
    await expect(openDecks([file("labels.json", { deck_id: "x", items: [] })])).rejects.toThrow(/^labels\.json: not a label deck/);
  });

  it("downloads labels-<deck_id>-<timestamp>.json with the export shape", async () => {
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:test";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("labels-demo-cell-20261029T080910Z.json");
    });
    const [run] = await openDecks([file("a.json", deck)]);
    expect(run.source).toBe("file");
    act(() => downloadLabels(run, new Date("2026-10-29T08:09:10Z")));
    expect(click).toHaveBeenCalledOnce();
    const data = JSON.parse(await blobs[0].text());
    expect(Object.keys(data).sort()).toEqual(["attention", "deck_id", "items", "seed", "session_id"]);
    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});
