import type { App } from "firebase-admin/app";
import { getApps, initializeApp } from "firebase-admin/app";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeAdminAppForTests } from "./admin.js";

// `initializeAdminAppForTests` guards the firebase-admin default-app
// registry. Mock the registry so the reuse/mismatch branches are
// observable without a real Firebase app.
vi.mock("firebase-admin/app", () => ({
  getApps: vi.fn(),
  initializeApp: vi.fn(),
}));

const getAppsMock = vi.mocked(getApps);
const initializeAppMock = vi.mocked(initializeApp);

function appWith(projectId: string | undefined): App {
  return { name: "[DEFAULT]", options: { projectId } } as App;
}

describe("initializeAdminAppForTests", () => {
  beforeEach(() => {
    getAppsMock.mockReset();
    initializeAppMock.mockReset();
  });

  it("initializes the default app when none exists", () => {
    getAppsMock.mockReturnValue([]);
    initializeAdminAppForTests("proj-a");
    expect(initializeAppMock).toHaveBeenCalledWith({ projectId: "proj-a" });
  });

  it("no-ops when the existing app targets the same projectId", () => {
    getAppsMock.mockReturnValue([appWith("proj-a")]);
    expect(() => initializeAdminAppForTests("proj-a")).not.toThrow();
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("throws when the existing app targets a different projectId", () => {
    getAppsMock.mockReturnValue([appWith("proj-a")]);
    expect(() => initializeAdminAppForTests("proj-b")).toThrow(
      /already initialized with projectId="proj-a", expected "proj-b"/,
    );
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("no-ops (does not throw) when the existing app has no recorded projectId", () => {
    getAppsMock.mockReturnValue([appWith(undefined)]);
    expect(() => initializeAdminAppForTests("proj-b")).not.toThrow();
    expect(initializeAppMock).not.toHaveBeenCalled();
  });
});
