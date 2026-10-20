// @vitest-environment jsdom
/**
 * DOM test for the Applications tab's `+ task` control (#34): the
 * shared quick-add opens per row, pre-fills the due date the container
 * supplies, writes through `onAddTask`, and confirms in place.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dateInputToIso } from "../../lib/taskDates.ts";
import type { Application } from "../../types/crm.ts";

import ApplicationsTab from "./ApplicationsTab.tsx";

const APP: Application = {
  id: "app-1",
  owner_uid: "u",
  role_id: "r1",
  stage: "applied",
  last_activity_at: "2026-10-10T12:00:00.000Z",
  generated_assets: [],
  approved_unit_ids: [],
};

function renderTab(props: Partial<Parameters<typeof ApplicationsTab>[0]> = {}): void {
  render(
    <ApplicationsTab
      applications={[APP]}
      hasApprovedMatches
      status="editing"
      error={null}
      onGenerate={() => {}}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ApplicationsTab + task (#34)", () => {
  it("adds a task for the row's Application with the supplied default due date", async () => {
    const onAddTask = vi.fn(() => Promise.resolve());
    const due = dateInputToIso("2026-10-23");
    renderTab({ onAddTask, defaultDueAtFor: () => due });

    fireEvent.click(screen.getByText("+ task"));
    expect((screen.getByTestId("task-quick-add-due") as HTMLInputElement).value).toBe(
      "2026-10-23",
    );
    fireEvent.change(screen.getByTestId("task-quick-add-title"), {
      target: { value: "Ask about the panel" },
    });
    fireEvent.submit(screen.getByTestId("task-quick-add"));

    await waitFor(() =>
      expect(screen.getByTestId("applications-task-added").textContent).toContain("Task added"),
    );
    expect(onAddTask).toHaveBeenCalledWith("app-1", "Ask about the panel", due);
    expect(screen.queryByTestId("task-quick-add")).toBeNull();
  });

  it("has no + task control when tasks are not wired", () => {
    renderTab();
    expect(screen.queryByText("+ task")).toBeNull();
  });
});
