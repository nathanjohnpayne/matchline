import { describe, expect, it } from "vitest";

import type { Application, ApplicationStage, Task } from "../../types/crm.ts";

import {
  buildTaskSidebar,
  defaultDueAt,
  endOfLocalDay,
} from "./taskSidebar.ts";

// Local-time construction keeps every test independent of the
// machine's time zone: "today" is the viewer's local day by design.
const NOW = new Date(2026, 9, 20, 12, 0, 0); // 20 Oct 2026, 12:00 local
const local = (day: number, hour = 12): string =>
  new Date(2026, 9, day, hour, 0, 0).toISOString();

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    owner_uid: "u",
    application_id: "a1",
    title: `Task ${id}`,
    completed: false,
    created_at: local(1),
    ...overrides,
  };
}

function app(
  id: string,
  stage: ApplicationStage,
  lastActivityDay: number,
): Application {
  return {
    id,
    owner_uid: "u",
    role_id: `r-${id}`,
    stage,
    last_activity_at: local(lastActivityDay),
    generated_assets: [],
    approved_unit_ids: [],
  };
}

const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id);

describe("endOfLocalDay", () => {
  it("is the last millisecond of the local calendar day", () => {
    expect(endOfLocalDay(NOW)).toBe(new Date(2026, 9, 21, 0, 0, 0).getTime() - 1);
  });
});

describe("defaultDueAt", () => {
  it("is local noon three calendar days out for Applied and Interviewing", () => {
    const expected = new Date(2026, 9, 23, 12, 0, 0).toISOString();
    expect(defaultDueAt("applied", NOW)).toBe(expected);
    expect(defaultDueAt("interviewing", NOW)).toBe(expected);
  });

  it("is undefined for every other stage", () => {
    for (const stage of ["saved", "drafting", "offer", "rejected", "withdrawn"] as const) {
      expect(defaultDueAt(stage, NOW)).toBeUndefined();
    }
  });
});

describe("calendar-day boundaries (DST-safe)", () => {
  it("adds calendar days across a daylight-saving change", () => {
    // 23:30 the night before a DST change: +72h would be off by an hour
    // and can cross midnight; calendar days cannot.
    const lateNight = new Date(2026, 2, 7, 23, 30);
    expect(defaultDueAt("applied", lateNight)).toBe(new Date(2026, 2, 10, 12).toISOString());
    expect(endOfLocalDay(lateNight, 7)).toBe(new Date(2026, 2, 15, 0, 0, 0).getTime() - 1);
  });

  it("keeps a task due on the 7th day in Upcoming at any time of day", () => {
    const seventhDay = task("d7", { due_at: new Date(2026, 9, 27, 12).toISOString() });
    for (const hour of [0, 8, 12, 23]) {
      const s = buildTaskSidebar([seventhDay], [], new Date(2026, 9, 20, hour, 0));
      expect(ids(s.upcoming), `opened at ${hour}:00`).toEqual(["d7"]);
    }
    const eighthDay = task("d8", { due_at: new Date(2026, 9, 28, 9).toISOString() });
    expect(buildTaskSidebar([eighthDay], [], new Date(2026, 9, 20, 23, 0)).upcoming).toEqual([]);
  });
});

describe("buildTaskSidebar: tasks", () => {
  it("puts overdue and due-later-today tasks in Due today", () => {
    const s = buildTaskSidebar(
      [
        task("overdue", { due_at: local(18) }),
        task("tonight", { due_at: local(20, 23) }),
        task("tomorrow", { due_at: local(21, 9) }),
      ],
      [],
      NOW,
    );
    expect(ids(s.dueToday)).toEqual(["overdue", "tonight"]);
    expect(ids(s.upcoming)).toEqual(["tomorrow"]);
  });

  it("limits Upcoming to the next 7 days, then lists undated tasks", () => {
    const s = buildTaskSidebar(
      [
        task("undated-b", { created_at: local(3) }),
        task("in6", { due_at: local(26) }),
        task("in8", { due_at: local(28) }),
        task("undated-a", { created_at: local(2) }),
        task("in2", { due_at: local(22) }),
      ],
      [],
      NOW,
    );
    expect(ids(s.upcoming)).toEqual(["in2", "in6", "undated-a", "undated-b"]);
    expect(ids(s.dueToday)).toEqual([]);
  });

  it("leaves completed tasks out of every section", () => {
    const s = buildTaskSidebar(
      [
        task("done-today", { due_at: local(20), completed: true }),
        task("done-undated", { completed: true }),
      ],
      [],
      NOW,
    );
    expect(s.dueToday).toEqual([]);
    expect(s.upcoming).toEqual([]);
  });

  it("orders ties on due date by creation time", () => {
    const s = buildTaskSidebar(
      [
        task("later", { due_at: local(20, 9), created_at: local(5) }),
        task("earlier", { due_at: local(20, 9), created_at: local(4) }),
      ],
      [],
      NOW,
    );
    expect(ids(s.dueToday)).toEqual(["earlier", "later"]);
  });

  it("treats an unparseable due date as undated instead of dropping it", () => {
    const s = buildTaskSidebar([task("bad", { due_at: "not a date" })], [], NOW);
    expect(ids(s.upcoming)).toEqual(["bad"]);
  });
});

describe("buildTaskSidebar: follow-ups", () => {
  it("surfaces an Applied application silent for 8 days", () => {
    const s = buildTaskSidebar([], [app("a1", "applied", 12)], NOW);
    expect(s.followUps).toEqual([
      { application: app("a1", "applied", 12), daysSilent: 8 },
    ]);
  });

  it("waits until more than 7 days have passed", () => {
    const s = buildTaskSidebar([], [app("a1", "interviewing", 13)], NOW);
    expect(s.followUps).toEqual([]);
  });

  it("ignores stages that are not active", () => {
    const s = buildTaskSidebar(
      [],
      [app("s", "saved", 1), app("d", "drafting", 1), app("o", "offer", 1), app("r", "rejected", 1)],
      NOW,
    );
    expect(s.followUps).toEqual([]);
  });

  it("drops an application once it has an open task, but not a completed one", () => {
    const apps = [app("a1", "applied", 1), app("a2", "applied", 1)];
    const s = buildTaskSidebar(
      [
        task("open", { application_id: "a1" }),
        task("done", { application_id: "a2", completed: true }),
      ],
      apps,
      NOW,
    );
    expect(s.followUps.map((f) => f.application.id)).toEqual(["a2"]);
  });

  it("orders the most silent first, ties by id", () => {
    const s = buildTaskSidebar(
      [],
      [app("b", "applied", 10), app("c", "applied", 1), app("a", "interviewing", 10)],
      NOW,
    );
    expect(s.followUps.map((f) => f.application.id)).toEqual(["c", "a", "b"]);
  });
});
