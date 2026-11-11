/**
 * Browser smoke tests for Pipeline tasks + follow-ups (#34), covering
 * the issue's two manual checks end to end against the emulators:
 *   - an Application in Applied for 8 days surfaces as a follow-up,
 *     and turning it into a task persists;
 *   - a task added from a card lands in the right section, and
 *     completing it persists and resets the card's days in stage.
 * Seeding helpers: `./emulator.ts`.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  listFields,
  readFields,
  resetAndCreateOwner,
  seedAcmeRole,
  seedApplication,
  signInAndOpenPipeline,
} from "./emulator.ts";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();

const section = (page: Page, testId: string) => page.getByTestId(testId);
const card = (page: Page, id: string) =>
  page.locator(`[data-testid="pipeline-card"][data-application-id="${id}"]`);

test("an application quiet for 8 days in Applied becomes a follow-up task", async ({ page }) => {
  const uid = await resetAndCreateOwner();
  await seedAcmeRole(uid);
  await seedApplication(uid, "a-quiet", "applied", daysAgo(8));

  await signInAndOpenPipeline(page);
  const followUps = section(page, "pipeline-follow-ups");
  await expect(followUps.getByText("8 days quiet in Applied")).toBeVisible();

  await followUps.getByRole("button", { name: "Add task" }).click();

  const dueToday = section(page, "pipeline-tasks-due-today");
  await expect(dueToday.getByText("Follow up: Acme: Staff PM")).toBeVisible();
  await expect(followUps.getByRole("button", { name: "Add task" })).toHaveCount(0);
  await expect.poll(async () => (await listFields("tasks")).length).toBe(1);

  await page.reload();
  await expect(
    section(page, "pipeline-tasks-due-today").getByText("Follow up: Acme: Staff PM"),
  ).toBeVisible();
});

test("a task added from a card lands in Upcoming, and completing it persists", async ({ page }) => {
  const uid = await resetAndCreateOwner();
  await seedAcmeRole(uid);
  await seedApplication(uid, "a-1", "applied", daysAgo(2));

  await signInAndOpenPipeline(page);
  await expect(card(page, "a-1").getByTestId("pipeline-card-days")).toHaveText("2d");

  await page.getByRole("button", { name: "Add task for Acme: Staff PM" }).click();
  // Active stage: due date defaults to three days out, so Upcoming.
  await expect(page.getByTestId("task-quick-add-due")).not.toHaveValue("");
  await page.getByTestId("task-quick-add-title").fill("Send the case study");
  await page.getByTestId("task-quick-add-title").press("Enter");

  const upcoming = section(page, "pipeline-tasks-upcoming");
  await expect(upcoming.getByText("Send the case study")).toBeVisible();

  // click, not check(): the task leaves the list as soon as it is ticked.
  await page.getByRole("checkbox", { name: /Send the case study/ }).click();
  await expect(page.getByText("Send the case study")).toHaveCount(0);
  await expect(card(page, "a-1").getByTestId("pipeline-card-days")).toHaveText("0d");
  await expect
    .poll(async () => (await listFields("tasks"))[0]?.completed?.booleanValue)
    .toBe(true);

  await page.reload();
  await expect(page.getByTestId("pipeline-board")).toBeVisible();
  await expect(page.getByText("Send the case study")).toHaveCount(0);
  await expect(card(page, "a-1").getByTestId("pipeline-card-days")).toHaveText("0d");
  expect((await readFields("applications/a-1"))?.stage?.stringValue).toBe("applied");
});
