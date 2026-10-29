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
import { initSession, type StoredSession } from "../../lib/labelDeck/session.ts";
import type { AccountDeck } from "../../services/calibration.ts";

import CalibrateView, { type CalibrateViewProps, type DeckRun } from "./CalibrateView.tsx";
import Calibrate, { downloadLabels, openDecks, pickSession, readDeckFiles, type CalibrationServices } from "./index.tsx";

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
  saveError: null,
  reducedMotion: true,
  onOpenAccount: () => {},
  onUploadFiles: () => {},
  onOpenFiles: () => {},
  onRemoveDeck: () => {},
  onOpenCell: () => {},
  onBackToDecks: () => {},
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
  function fakeServices(initial: AccountDeck[] = []) {
    let stored = [...initial];
    const calls = { uploads: [] as string[], saves: [] as string[], removes: [] as string[] };
    const services: CalibrationServices = {
      listAccountDecks: async () => stored,
      uploadDeck: async (d) => {
        calls.uploads.push(d.deck_id);
        stored = [...stored.filter((s) => s.deck.deck_id !== d.deck_id), { deck: d, uploadedAt: "now", session: null }];
      },
      deleteAccountDeck: async (id) => {
        calls.removes.push(id);
        stored = stored.filter((s) => s.deck.deck_id !== id);
      },
      saveAccountSession: async (d) => {
        calls.saves.push(d.deck_id);
      },
    };
    return { services, calls };
  }
  const file = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: "application/json" });

  it("uploads deck files, lists them, labels from the account and saves each decision there", async () => {
    const { services, calls } = fakeServices();
    render(<Calibrate services={services} />);
    await screen.findByText(/No decks yet/);
    fireEvent.change(screen.getByLabelText("Upload deck files…"), { target: { files: [file("a.json", deck)] } });
    await screen.findByText("demo-cell");
    expect(calls.uploads).toEqual(["demo-cell"]);
    fireEvent.click(screen.getByRole("button", { name: "Label all" }));
    await screen.findByTestId("calibrate-card");
    key("ArrowRight");
    await waitFor(() => expect(calls.saves).toEqual(["demo-cell"]));
  });

  it("shows a failed save inline and keeps going", async () => {
    const { services } = fakeServices([{ deck, uploadedAt: "now", session: null }]);
    render(<Calibrate services={{ ...services, saveAccountSession: async () => Promise.reject(new Error("offline")) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    key("ArrowRight");
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.getByText(/1 of 3 labelled/)).toBeTruthy();
  });

  it("removes a deck only after confirming", async () => {
    const { services, calls } = fakeServices([{ deck, uploadedAt: "now", session: null }]);
    render(<Calibrate services={services} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove demo-cell" }));
    expect(calls.removes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText(/No decks yet/);
    expect(calls.removes).toEqual(["demo-cell"]);
  });

  it("names a deck picked twice, and resumes the session with more history", async () => {
    await expect(readDeckFiles([file("a.json", deck), file("b.json", deck)])).rejects.toThrow(/picked twice/);
    const base = { session_id: "x", state: initSession(deck, 1) };
    const longer = { session_id: "y", state: { ...base.state, history: [{ kind: "decide" as const, id: "a", ms: 1 }] } };
    expect(pickSession(deck, base, longer).session_id).toBe("y");
    expect(pickSession(deck, longer, null).session_id).toBe("y");
    expect(pickSession(deck, null, null).state.deck_id).toBe("demo-cell");
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
