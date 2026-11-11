import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application, Company, Role } from "../../types/crm.ts";

import { loadPipelineData, type PipelineReaders } from "./loadPipelineData.ts";

const APP: Application = {
  id: "a1",
  owner_uid: "u",
  role_id: "r1",
  stage: "applied",
  last_activity_at: "2026-10-19T00:00:00.000Z",
  generated_assets: [],
  approved_unit_ids: [],
};
const ROLE: Role = {
  id: "r1",
  owner_uid: "u",
  company_id: "c1",
  title: "Staff PM",
  jd_raw: "",
  discovered_at: "2026-10-01T00:00:00.000Z",
};
const COMPANY: Company = { id: "c1", owner_uid: "u", name: "Acme", priority: "high" };

function readers(overrides: Partial<PipelineReaders> = {}): PipelineReaders {
  return {
    listApplications: () => Promise.resolve([APP]),
    listRoles: () => Promise.resolve([ROLE]),
    listCompanies: () => Promise.resolve([COMPANY]),
    listInteractions: () => Promise.resolve([]),
    listPeople: () => Promise.resolve([]),
    listTasks: () => Promise.resolve([]),
    ...overrides,
  };
}

describe("loadPipelineData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns every collection and partial=false when all reads succeed", async () => {
    const data = await loadPipelineData(readers());
    expect(data.applications).toEqual([APP]);
    expect(data.roles).toEqual([ROLE]);
    expect(data.companies).toEqual([COMPANY]);
    expect(data.tasksLoaded).toBe(true);
    expect(data.partial).toBe(false);
  });

  it("rejects when Applications cannot be read", async () => {
    await expect(
      loadPipelineData(
        readers({
          listApplications: () => Promise.reject(new Error("permission-denied")),
        }),
      ),
    ).rejects.toThrow("permission-denied");
  });

  it("wraps a non-Error Applications rejection in an Error", async () => {
    await expect(
      loadPipelineData(
        readers({ listApplications: () => Promise.reject("offline") }),
      ),
    ).rejects.toThrow("offline");
  });

  it("rejects on an Applications failure without waiting for enrichment reads", async () => {
    // Codex P2 on PR #576: an enrichment read that never settles must
    // not hold the board in its loading state once Applications failed.
    const never = <T>(): Promise<T> => new Promise<T>(() => {});
    await expect(
      loadPipelineData(
        readers({
          listApplications: () => Promise.reject(new Error("permission-denied")),
          listRoles: never,
          listCompanies: never,
          listInteractions: never,
          listPeople: never,
          listTasks: never,
        }),
      ),
    ).rejects.toThrow("permission-denied");
  });

  it("degrades a failed tasks read like any other enrichment read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loadPipelineData(
      readers({ listTasks: () => Promise.reject(new Error("unavailable")) }),
    );
    expect(data.applications).toEqual([APP]);
    expect(data.tasks).toEqual([]);
    expect(data.tasksLoaded).toBe(false);
    expect(data.partial).toBe(true);
  });

  it("degrades a failed enrichment read to an empty list and partial=true", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loadPipelineData(
      readers({ listRoles: () => Promise.reject(new Error("unavailable")) }),
    );
    expect(data.applications).toEqual([APP]);
    expect(data.roles).toEqual([]);
    expect(data.companies).toEqual([COMPANY]);
    expect(data.partial).toBe(true);
  });

  it("starts every read before any of them settles", async () => {
    // A sequential loader would wait on Applications before starting
    // the rest; here every reader must have been called while the
    // first is still pending.
    const started: string[] = [];
    let releaseApps: (apps: Application[]) => void = () => {};
    const promise = loadPipelineData({
      listApplications: () => {
        started.push("applications");
        return new Promise<Application[]>((resolve) => {
          releaseApps = resolve;
        });
      },
      listRoles: () => {
        started.push("roles");
        return Promise.resolve([ROLE]);
      },
      listCompanies: () => {
        started.push("companies");
        return Promise.resolve([COMPANY]);
      },
      listInteractions: () => {
        started.push("interactions");
        return Promise.resolve([]);
      },
      listPeople: () => {
        started.push("people");
        return Promise.resolve([]);
      },
      listTasks: () => {
        started.push("tasks");
        return Promise.resolve([]);
      },
    });
    expect(started).toHaveLength(6);
    releaseApps([APP]);
    await expect(promise).resolves.toMatchObject({ applications: [APP] });
  });
});
