/**
 * Browser smoke test for the card's Next action (#512), the issue's
 * manual check end to end: two tasks with different due dates on one
 * Application, the card shows the earlier one, completing it shows the
 * next, and that survives a reload. Seeding helpers: `./emulator.ts`.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  readFields,
  resetAndCreateOwner,
  seedAcmeRole,
  seedApplication,
  seedDoc,
  signInAndOpenPipeline,
} from "./emulator.ts";

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number): string => new Date(Date.now() + n * DAY).toISOString();

const chip = (page: Page) =>
  page
    .locator('[data-testid="pipeline-card"][data-application-id="a-1"]')
    .getByTestId("pipeline-card-next-action");

test("the card shows the earliest open task and moves on when it is done", async ({ page }) => {
  const uid = await resetAndCreateOwner();
  await seedAcmeRole(uid);
  await seedApplication(uid, "a-1", "applied", inDays(-1));
  const base = { owner_uid: uid, application_id: "a-1", completed: false, created_at: inDays(-1) };
  await seedDoc("tasks/t-later", { ...base, title: "Send portfolio", due_at: inDays(5) });
  await seedDoc("tasks/t-soon", { ...base, title: "Email Dana", due_at: inDays(1) });

  await signInAndOpenPipeline(page);
  await expect(chip(page)).toHaveText("Email Dana");

  await page.getByRole("checkbox", { name: /Email Dana/ }).click();
  await expect(chip(page)).toHaveText("Send portfolio");
  // Let the completion write land before reloading.
  await expect
    .poll(async () => (await readFields("tasks/t-soon"))?.completed?.booleanValue)
    .toBe(true);

  await page.reload();
  await expect(page.getByTestId("pipeline-board")).toBeVisible();
  await expect(chip(page)).toHaveText("Send portfolio");
});
