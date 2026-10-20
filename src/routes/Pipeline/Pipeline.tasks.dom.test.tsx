// @vitest-environment jsdom
/**
 * DOM tests for the Pipeline's tasks + follow-ups (#34): the sidebar
 * sections, the card `+ task` quick-add, optimistic completion with
 * rollback, and turning a follow-up into a task. The container runs
 * with injected fakes (see `Pipeline.dom.test.tsx`).
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

import { dateInputToIso } from "../../lib/taskDates.ts";
import type { NewTask } from "../../services/tasks.ts";
import type {
  Application,
  ApplicationStage,
  Company,
  Role,
  Task,
} from "../../types/crm.ts";

import Pipeline, { type PipelineDeps } from "./index.tsx";

// Local noon, so "today" is unambiguous in every time zone.
const NOW = new Date(2026, 9, 20, 12, 0, 0);
const localDay = (day: number): string => new Date(2026, 9, day, 12).toISOString();

function app(id: string, stage: ApplicationStage, lastDay = 19): Application {
  return {
    id,
    owner_uid: "u",
    role_id: "r1",
    stage,
    last_activity_at: localDay(lastDay),
    generated_assets: [],
    approved_unit_ids: [],
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    owner_uid: "u",
    application_id: "a1",
    title: `Task ${id}`,
    completed: false,
    created_at: localDay(10),
    ...overrides,
  };
}

const ROLES: Role[] = [
  {
    id: "r1",
    owner_uid: "u",
    company_id: "c1",
    title: "Staff PM",
    jd_raw: "",
    discovered_at: localDay(1),
  },
];
const COMPANIES: Company[] = [
  { id: "c1", owner_uid: "u", name: "Acme", priority: "high" },
];

let created = 0;
function fakeCreate(): (input: NewTask, now: Date) => Promise<Task> {
  return vi.fn((input: NewTask, now: Date) =>
    Promise.resolve({
      id: `new-${++created}`,
      owner_uid: "u",
      application_id: input.application_id,
      title: input.title,
      completed: false,
      created_at: now.toISOString(),
      ...(input.due_at !== undefined && { due_at: input.due_at }),
    }),
  );
}

function deps(overrides: Partial<PipelineDeps> & {
  readonly applications?: Application[];
  readonly tasks?: Task[];
} = {}): PipelineDeps {
  const { applications = [app("a1", "applied")], tasks = [], ...rest } = overrides;
  return {
    listApplications: () => Promise.resolve(applications),
    listRoles: () => Promise.resolve(ROLES),
    listCompanies: () => Promise.resolve(COMPANIES),
    listInteractions: () => Promise.resolve([]),
    listPeople: () => Promise.resolve([]),
    listTasks: () => Promise.resolve(tasks),
    moveApplicationToStage: () => Promise.resolve(),
    createTask: fakeCreate(),
    completeTask: vi.fn(() => Promise.resolve()),
    now: () => NOW,
    ...rest,
  };
}

async function renderBoard(d: PipelineDeps): Promise<void> {
  render(
    <MemoryRouter>
      <Pipeline deps={d} />
    </MemoryRouter>,
  );
  await screen.findByTestId("pipeline-task-sidebar");
}

const section = (testId: string): HTMLElement => screen.getByTestId(testId);
const card = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="pipeline-card"][data-application-id="${id}"]`,
  );
  if (el === null) throw new Error(`no card ${id}`);
  return el;
};

afterEach(() => {
  cleanup();
});

describe("Pipeline tasks sidebar (#34)", () => {
  it("sorts open tasks into Due today and Upcoming and labels their Application", async () => {
    await renderBoard(
      deps({
        tasks: [
          task("overdue", { due_at: localDay(18), title: "Send thank-you" }),
          task("soon", { due_at: localDay(23), title: "Prep case study" }),
          task("later", { due_at: localDay(30), title: "Far off" }),
          task("done", { due_at: localDay(20), completed: true, title: "Done already" }),
        ],
      }),
    );
    const today = section("pipeline-tasks-due-today");
    expect(within(today).getByText("Send thank-you")).toBeTruthy();
    expect(within(today).getByText(/Acme: Staff PM/)).toBeTruthy();
    expect(within(section("pipeline-tasks-upcoming")).getByText("Prep case study")).toBeTruthy();
    expect(screen.queryByText("Far off")).toBeNull();
    expect(screen.queryByText("Done already")).toBeNull();
  });

  it("collapses and expands", async () => {
    await renderBoard(deps({ tasks: [task("t1", { due_at: localDay(20) })] }));
    const toggle = screen.getByRole("button", { name: /Tasks/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("pipeline-tasks-due-today")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("pipeline-tasks-due-today")).toBeTruthy();
  });
});

describe("card quick-add (#34)", () => {
  it("defaults an active Application's due date to now + 3 days and lands in Upcoming", async () => {
    const d = deps();
    await renderBoard(d);

    fireEvent.click(screen.getByRole("button", { name: "Add task for Acme: Staff PM" }));
    const due = screen.getByTestId("task-quick-add-due") as HTMLInputElement;
    expect(due.value).toBe("2026-10-23");
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Email the recruiter" },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => expect(screen.queryByTestId("task-quick-add")).toBeNull());
    expect(d.createTask).toHaveBeenCalledWith(
      {
        application_id: "a1",
        title: "Email the recruiter",
        due_at: dateInputToIso("2026-10-23"),
      },
      NOW,
    );
    expect(within(section("pipeline-tasks-upcoming")).getByText("Email the recruiter")).toBeTruthy();
  });

  it("leaves the due date empty for a Saved application and files the undated task under Upcoming", async () => {
    const d = deps({ applications: [app("a1", "saved")] });
    await renderBoard(d);

    fireEvent.click(screen.getByRole("button", { name: "Add task for Acme: Staff PM" }));
    expect((screen.getByTestId("task-quick-add-due") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Find a referral" },
    });
    fireEvent.submit(screen.getByTestId("task-quick-add"));

    await waitFor(() =>
      expect(within(section("pipeline-tasks-upcoming")).getByText("Find a referral")).toBeTruthy(),
    );
    expect(d.createTask).toHaveBeenCalledWith(
      { application_id: "a1", title: "Find a referral" },
      NOW,
    );
  });

  it("keeps the form and shows an inline error when the write fails", async () => {
    await renderBoard(
      deps({ createTask: vi.fn(() => Promise.reject(new Error("permission-denied"))) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add task for Acme: Staff PM" }));
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Email the recruiter" },
    });
    fireEvent.click(screen.getByText("Add"));

    const alert = await screen.findByTestId("task-quick-add-error");
    expect(alert.textContent).toContain("permission-denied");
    expect((screen.getByTestId("task-quick-add-title") as HTMLInputElement).value).toBe(
      "Email the recruiter",
    );
  });

  it("locks the + task toggle while a save is in flight", async () => {
    let finish: (t: Task) => void = () => {};
    const d = deps({
      createTask: vi.fn(
        (input: NewTask, now: Date) =>
          new Promise<Task>((resolve) => {
            finish = () =>
              resolve({ ...task("slow"), ...input, created_at: now.toISOString() });
          }),
      ),
    });
    await renderBoard(d);
    const toggle = screen.getByRole("button", { name: "Add task for Acme: Staff PM" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Email the recruiter" },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(toggle);
    expect(screen.getByTestId("task-quick-add")).toBeTruthy();

    await act(async () => finish(task("slow")));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(d.createTask).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without writing", async () => {
    const d = deps();
    await renderBoard(d);
    fireEvent.click(screen.getByRole("button", { name: "Add task for Acme: Staff PM" }));
    fireEvent.keyDown(screen.getByTestId("task-quick-add-title"), { key: "Escape" });
    expect(screen.queryByTestId("task-quick-add")).toBeNull();
    expect(d.createTask).not.toHaveBeenCalled();
  });
});

describe("completing a task (#34)", () => {
  it("removes it at once, writes it, and resets the card's days in stage", async () => {
    const d = deps({
      applications: [app("a1", "applied", 15)],
      tasks: [task("t1", { due_at: localDay(20), title: "Send thank-you" })],
    });
    await renderBoard(d);
    expect(within(card("a1")).getByTestId("pipeline-card-days").textContent).toBe("5d");

    fireEvent.click(screen.getByRole("checkbox", { name: /Send thank-you/ }));

    expect(screen.queryByText("Send thank-you")).toBeNull();
    expect(d.completeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", application_id: "a1" }),
      NOW.toISOString(),
    );
    await waitFor(() =>
      expect(within(card("a1")).getByTestId("pipeline-card-days").textContent).toBe("0d"),
    );
  });

  it("puts the task back with an inline error when the write fails", async () => {
    let reject: (err: Error) => void = () => {};
    const d = deps({
      tasks: [task("t1", { due_at: localDay(20), title: "Send thank-you" })],
      completeTask: vi.fn(
        () =>
          new Promise<void>((_, r) => {
            reject = r;
          }),
      ),
    });
    await renderBoard(d);

    fireEvent.click(screen.getByRole("checkbox", { name: /Send thank-you/ }));
    expect(screen.queryByText("Send thank-you")).toBeNull();

    await act(async () => reject(new Error("unavailable")));

    expect(within(section("pipeline-tasks-due-today")).getByText("Send thank-you")).toBeTruthy();
    const alert = screen.getByTestId("pipeline-task-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain('Couldn\'t complete "Send thank-you": unavailable.');
  });
});

describe("pending completion and the clock (#34)", () => {
  it("does not offer a follow-up while that application's task completion is in flight", async () => {
    let finish: () => void = () => {};
    const d = deps({
      applications: [app("a1", "applied", 1)],
      tasks: [task("t1", { due_at: localDay(20), title: "Send thank-you" })],
      completeTask: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    await renderBoard(d);
    fireEvent.click(screen.getByRole("checkbox", { name: /Send thank-you/ }));
    expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();

    await act(async () => finish());
    // The completion touched the Application, so it is not quiet.
    expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();
  });

  it("rolls tasks into Due today at local midnight while the page stays open", async () => {
    // Capture the scheduled midnight callback instead of using fake
    // timers: deterministic under load, and it pins the delay too.
    const scheduled: { fn: () => void; ms: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms !== undefined && ms >= 60_000) {
          scheduled.push({ fn, ms });
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout);
    try {
      let clock = new Date(2026, 9, 20, 23, 59, 0);
      await renderBoard(
        deps({
          now: () => clock,
          tasks: [task("t1", { due_at: localDay(21), title: "Call Dana" })],
        }),
      );
      expect(within(section("pipeline-tasks-upcoming")).getByText("Call Dana")).toBeTruthy();

      // The effect that schedules it may flush after the first paint.
      await waitFor(() => expect(scheduled.length).toBeGreaterThan(0));
      // One minute to midnight, plus the one-second margin.
      const midnight = scheduled.at(-1);
      expect(midnight?.ms).toBe(61_000);

      clock = new Date(2026, 9, 21, 0, 0, 1);
      act(() => midnight?.fn());
      expect(within(section("pipeline-tasks-due-today")).getByText("Call Dana")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("returning to the page (#34)", () => {
  it("re-reads the clock when the page becomes visible on a new day", async () => {
    let clock = new Date(2026, 9, 20, 22, 0, 0);
    await renderBoard(
      deps({
        now: () => clock,
        tasks: [task("t1", { due_at: localDay(21), title: "Call Dana" })],
      }),
    );
    expect(within(section("pipeline-tasks-upcoming")).getByText("Call Dana")).toBeTruthy();

    // The laptop slept through midnight; no timer fired.
    clock = new Date(2026, 9, 21, 9, 0, 0);
    // Retried because the listener is attached by an effect that may
    // flush after the first paint.
    await waitFor(() => {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(within(section("pipeline-tasks-due-today")).getByText("Call Dana")).toBeTruthy();
    });
  });
});

describe("card next action (#512)", () => {
  const chip = (id: string): string | null =>
    card(id).querySelector('[data-testid="pipeline-card-next-action"]')?.textContent ?? null;

  it("shows the earliest-due open task, then the next one once it is completed", async () => {
    await renderBoard(
      deps({
        tasks: [
          task("later", { due_at: localDay(25), title: "Send portfolio" }),
          task("soon", { due_at: localDay(20), title: "Email Dana" }),
        ],
      }),
    );
    expect(chip("a1")).toBe("Email Dana");

    fireEvent.click(screen.getByRole("checkbox", { name: /Email Dana/ }));
    expect(chip("a1")).toBe("Send portfolio");

    fireEvent.click(screen.getByRole("checkbox", { name: /Send portfolio/ }));
    await waitFor(() => expect(chip("a1")).toBeNull());
  });

  it("renders no chip for an Application without tasks", async () => {
    await renderBoard(deps());
    expect(chip("a1")).toBeNull();
  });

  it("shows a task added from the card as its next action", async () => {
    await renderBoard(deps());
    fireEvent.click(screen.getByRole("button", { name: "Add task for Acme: Staff PM" }));
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Prep questions" },
    });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chip("a1")).toBe("Prep questions"));
  });
});

describe("follow-ups that come due during the day (#589)", () => {
  // Last touched 7 days ago at 13:00; the board opens at 12:00, an
  // hour before it crosses the threshold.
  const almostQuiet = (): Application => ({
    ...app("a1", "applied"),
    last_activity_at: new Date(2026, 9, 13, 13, 0, 0).toISOString(),
  });

  it("schedules a clock re-read for the threshold and shows the follow-up then", async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms !== undefined && ms >= 60_000) {
          scheduled.push({ fn, ms });
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout);
    try {
      let clock = new Date(2026, 9, 20, 12, 0, 0);
      await renderBoard(deps({ now: () => clock, applications: [almostQuiet()] }));
      expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();

      await waitFor(() => expect(scheduled.length).toBeGreaterThan(0));
      // One hour (plus 1 ms) to the threshold, plus the 1 s margin;
      // earlier than midnight, so it wins.
      const threshold = scheduled.at(-1);
      expect(threshold?.ms).toBe(3_600_000 + 1 + 1000);

      clock = new Date(2026, 9, 20, 13, 0, 2);
      act(() => threshold?.fn());
      expect(within(section("pipeline-follow-ups")).getByText("Add task")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("shows it on return to the tab once the threshold has passed the same day", async () => {
    let clock = new Date(2026, 9, 20, 12, 0, 0);
    await renderBoard(deps({ now: () => clock, applications: [almostQuiet()] }));
    expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();

    clock = new Date(2026, 9, 20, 16, 0, 0);
    await waitFor(() => {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(within(section("pipeline-follow-ups")).getByText("Add task")).toBeTruthy();
    });
  });
});

describe("follow-ups (#34)", () => {
  it("surfaces an Applied application quiet for 8 days and turns it into a task due today", async () => {
    const d = deps({ applications: [app("a1", "applied", 12)] });
    await renderBoard(d);

    const followUps = section("pipeline-follow-ups");
    expect(within(followUps).getByText("8 days quiet in Applied")).toBeTruthy();

    fireEvent.click(within(followUps).getByText("Add task"));

    await waitFor(() =>
      expect(within(section("pipeline-tasks-due-today")).getByText("Follow up: Acme: Staff PM")).toBeTruthy(),
    );
    expect(d.createTask).toHaveBeenCalledWith(
      { application_id: "a1", title: "Follow up: Acme: Staff PM", due_at: NOW.toISOString() },
      NOW,
    );
    // An open task now covers it, so it is no longer a follow-up.
    expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();
  });

  it("hides follow-ups when the tasks read failed, so no duplicate can be added", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderBoard(
      deps({
        applications: [app("a1", "applied", 1)],
        listTasks: () => Promise.reject(new Error("unavailable")),
      }),
    );
    const followUps = section("pipeline-follow-ups");
    expect(within(followUps).queryByText("Add task")).toBeNull();
    expect(followUps.textContent).toContain("Tasks couldn't be loaded");
    vi.restoreAllMocks();
  });

  it("truncates a follow-up title to the 200-character limit", async () => {
    const longName = "A".repeat(250);
    const d = deps({
      applications: [app("a1", "applied", 1)],
      listCompanies: () =>
        Promise.resolve([{ id: "c1", owner_uid: "u", name: longName, priority: "high" }]),
    });
    await renderBoard(d);
    fireEvent.click(within(section("pipeline-follow-ups")).getByText("Add task"));
    await waitFor(() => expect(d.createTask).toHaveBeenCalledTimes(1));
    const title = (d.createTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(200);
    expect(title.endsWith("…")).toBe(true);
  });

  it("shows nothing for an application that is quiet but not in an active stage", async () => {
    await renderBoard(deps({ applications: [app("a1", "saved", 1)] }));
    expect(within(section("pipeline-follow-ups")).queryByText("Add task")).toBeNull();
  });
});
