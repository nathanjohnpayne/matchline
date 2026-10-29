// @vitest-environment jsdom
/**
 * DOM tests for the Calibrate route (#636): keyboard, pointer swipes, tap,
 * unsure re-queue, undo, notes, the cell end and the labels download. The
 * view runs with the real session reducer in a small stateful harness, the
 * way the container wires it, so nothing here touches Firebase.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Card, Deck, LabelsFile } from "../../lib/labelDeck/deck.ts";
import { initSession } from "../../lib/labelDeck/session.ts";

import CalibrateView, { type DeckRun } from "./CalibrateView.tsx";
import { downloadLabels, openDecks } from "./index.tsx";
import type { StoredSession } from "./storage.ts";

afterEach(cleanup);

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

/** The container's wiring, minus files and storage; queue in deck order. */
function Harness({ onDownload = () => {}, clock }: { onDownload?: (run: DeckRun) => void; clock: { t: number } }) {
  const [session, setSession] = useState<StoredSession>({
    session_id: "s-test",
    state: { ...initSession(deck, 1), queue: deck.cards.map((c) => c.item_id) },
  });
  const run = { deck, session };
  return (
    <CalibrateView
      runs={[run]}
      active={0}
      loadError={null}
      reducedMotion
      onOpenFiles={() => {}}
      onSession={(_i, next) => setSession(next)}
      onOpenCell={() => {}}
      onDownload={() => onDownload(run)}
      now={() => clock.t}
    />
  );
}

const question = () => screen.getByTestId("calibrate-card").querySelector("h2")?.textContent;
const key = (k: string) => fireEvent.keyDown(document, { key: k });

describe("Calibrate view", () => {
  it("opens on the deck picker when no deck is loaded", () => {
    render(<CalibrateView runs={[]} active={0} loadError="bad.json: not a label deck" reducedMotion onOpenFiles={() => {}} onSession={() => {}} onOpenCell={() => {}} onDownload={() => {}} />);
    expect(screen.getByLabelText("Deck files")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("bad.json");
    expect(screen.getByText(/never uploaded/)).toBeTruthy();
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
    expect(screen.getByRole("status").textContent).toBe("This card is True / False only");
    clock.t = 2000;
    key("ArrowRight");
    fireEvent.click(screen.getByRole("button", { name: "Download labels" }));
    expect(exported).toMatchObject({
      "ext:u_a:A/fact-correct": { label: "mixed", ms: 1500, order: 1 },
      "ext:u_a:A/verbatim": { label: "true", ms: 500, order: 2 },
    });
  });

  it("swipes with the pointer past the threshold and springs back short of it", () => {
    render(<Harness clock={{ t: 0 }} />);
    const swipe = (dx: number, dy: number) => {
      const el = screen.getByTestId("calibrate-card");
      fireEvent.pointerDown(el, { button: 0, clientX: 200, clientY: 300, pointerId: 1 });
      fireEvent.pointerMove(el, { clientX: 200 + dx / 2, clientY: 300 + dy / 2, pointerId: 1 });
      fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 300 + dy, pointerId: 1 });
      fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 300 + dy, pointerId: 1 });
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
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { clientX: 12, clientY: 11 });
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
    act(() => downloadLabels(run, new Date("2026-10-29T08:09:10Z")));
    expect(click).toHaveBeenCalledOnce();
    const data = JSON.parse(await blobs[0].text());
    expect(Object.keys(data).sort()).toEqual(["attention", "deck_id", "items", "seed", "session_id"]);
    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});
