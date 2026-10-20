// @vitest-environment jsdom
/**
 * DOM tests for moving Pipeline cards (#511). The rest of the route's
 * tests are static renders; this file needs real events (keydown,
 * drag/drop) and state updates, so it opts into jsdom for itself only.
 *
 * The container is rendered with injected fake readers and a fake
 * `moveApplicationToStage`, so these tests exercise the real reducer,
 * view and container wiring without Firestore.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Application,
  ApplicationStage,
  Company,
  Role,
} from "../../types/crm.ts";

import Pipeline, { type PipelineDeps } from "./index.tsx";
import { PIPELINE_CARD_MIME } from "./PipelineView.tsx";

const NOW = new Date("2026-10-20T12:00:00.000Z");

function app(id: string, stage: ApplicationStage, roleId: string): Application {
  return {
    id,
    owner_uid: "u",
    role_id: roleId,
    stage,
    last_activity_at: "2026-10-10T12:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: [],
  };
}

const ROLES: Role[] = [
  {
    id: "r1",
    owner_uid: "u",
    company_id: "c1",
    title: "Staff PM",
    jd_raw: "",
    discovered_at: "2026-10-01T00:00:00.000Z",
  },
];
const COMPANIES: Company[] = [
  { id: "c1", owner_uid: "u", name: "Acme", priority: "high" },
];

function deps(
  move: PipelineDeps["moveApplicationToStage"],
  applications: Application[] = [app("a1", "saved", "r1")],
): PipelineDeps {
  return {
    listApplications: () => Promise.resolve(applications),
    listRoles: () => Promise.resolve(ROLES),
    listCompanies: () => Promise.resolve(COMPANIES),
    listInteractions: () => Promise.resolve([]),
    listPeople: () => Promise.resolve([]),
    moveApplicationToStage: move,
    now: () => NOW,
  };
}

async function renderBoard(d: PipelineDeps): Promise<void> {
  render(
    <MemoryRouter>
      <Pipeline deps={d} />
    </MemoryRouter>,
  );
  await screen.findByTestId("pipeline-board");
}

function column(stage: ApplicationStage): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="pipeline-column"][data-stage="${stage}"]`,
  );
  if (el === null) throw new Error(`no column ${stage}`);
  return el;
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="pipeline-card"][data-application-id="${id}"]`,
  );
  if (el === null) throw new Error(`no card ${id}`);
  return el;
}

/** Minimal DataTransfer stand-in (jsdom does not implement one). */
function dataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

afterEach(() => {
  cleanup();
});

describe("Pipeline card moves (#511)", () => {
  it("moves a focused card one stage right with ArrowRight and writes it", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move));

    act(() => card("a1").focus());
    fireEvent.keyDown(card("a1"), { key: "ArrowRight" });

    // Optimistic: the card is in Drafting before the write settles.
    expect(within(column("drafting")).getByText("Acme")).toBeTruthy();
    expect(move).toHaveBeenCalledWith("a1", "drafting", NOW.toISOString());
    await waitFor(() =>
      expect(card("a1").getAttribute("aria-busy")).toBe("false"),
    );
    // Focus follows the card so the next arrow press keeps moving it.
    expect(document.activeElement).toBe(card("a1"));
    expect(screen.getByTestId("pipeline-announcement").textContent).toBe(
      "Moved Acme: Staff PM to Drafting.",
    );
    // Days in stage reset with the new last_activity_at.
    expect(within(card("a1")).getByTestId("pipeline-card-days").textContent).toBe("0d");
  });

  it("moves left with ArrowLeft and does nothing past either end", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move, [app("a1", "saved", "r1")]));

    fireEvent.keyDown(card("a1"), { key: "ArrowLeft" });
    expect(move).not.toHaveBeenCalled();
    expect(within(column("saved")).getByText("Acme")).toBeTruthy();

    fireEvent.keyDown(card("a1"), { key: "ArrowRight" });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(card("a1"), { key: "ArrowLeft" });
    await waitFor(() => expect(move).toHaveBeenLastCalledWith("a1", "saved", NOW.toISOString()));
  });

  it("ignores arrow keys with a modifier held", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move));
    fireEvent.keyDown(card("a1"), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(card("a1"), { key: "ArrowRight", shiftKey: true });
    expect(move).not.toHaveBeenCalled();
  });

  it("rolls a rejected move back and shows an inline error, not a toast", async () => {
    const move = vi.fn(() => Promise.reject(new Error("permission-denied")));
    await renderBoard(deps(move));

    fireEvent.keyDown(card("a1"), { key: "ArrowRight" });
    expect(within(column("drafting")).getByText("Acme")).toBeTruthy();

    const alert = await screen.findByTestId("pipeline-move-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(
      "Couldn't move Acme: Staff PM to Drafting: permission-denied. It's back in Saved.",
    );
    expect(within(column("saved")).getByText("Acme")).toBeTruthy();
    expect(within(column("drafting")).queryByText("Acme")).toBeNull();
    // The original days in stage is restored with the original timestamp.
    expect(within(card("a1")).getByTestId("pipeline-card-days").textContent).toBe("10d");

    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("pipeline-move-error")).toBeNull();
  });

  it("refuses a second move while the first write is in flight", async () => {
    let settle: () => void = () => {};
    const move = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await renderBoard(deps(move));

    fireEvent.keyDown(card("a1"), { key: "ArrowRight" });
    expect(card("a1").getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(card("a1"), { key: "ArrowRight" });
    expect(move).toHaveBeenCalledTimes(1);

    await act(async () => settle());
    expect(card("a1").getAttribute("aria-busy")).toBe("false");
  });

  it("moves a card by drag and drop, highlighting the drop target", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move));

    const dt = dataTransfer();
    fireEvent.dragStart(card("a1"), { dataTransfer: dt });
    expect(dt.getData(PIPELINE_CARD_MIME)).toBe("a1");

    fireEvent.dragOver(column("applied"), { dataTransfer: dt });
    expect(column("applied").getAttribute("data-drop-target")).toBe("true");
    expect(column("applied").className).toContain("border-zinc-900");

    fireEvent.drop(column("applied"), { dataTransfer: dt });
    expect(column("applied").getAttribute("data-drop-target")).toBeNull();
    expect(within(column("applied")).getByText("Acme")).toBeTruthy();
    expect(move).toHaveBeenCalledWith("a1", "applied", NOW.toISOString());
  });

  it("writes nothing when a card is dropped on its own column", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move));

    const dt = dataTransfer();
    fireEvent.dragStart(card("a1"), { dataTransfer: dt });
    fireEvent.dragOver(column("saved"), { dataTransfer: dt });
    fireEvent.drop(column("saved"), { dataTransfer: dt });
    expect(move).not.toHaveBeenCalled();
    expect(within(column("saved")).getByText("Acme")).toBeTruthy();
  });

  it("ignores a drag that does not carry a card", async () => {
    const move = vi.fn(() => Promise.resolve());
    await renderBoard(deps(move));

    const dt = dataTransfer();
    dt.setData("text/plain", "a1");
    fireEvent.dragOver(column("applied"), { dataTransfer: dt });
    expect(column("applied").getAttribute("data-drop-target")).toBeNull();
    fireEvent.drop(column("applied"), { dataTransfer: dt });
    expect(move).not.toHaveBeenCalled();
  });
});
