/**
 * Browser smoke test for moving Pipeline cards (#511): the real app in
 * Chromium, signed in through the Auth emulator, reading and writing
 * the Firestore emulator. Covers what the jsdom tests cannot: the
 * browser's own HTML5 drag sequence, and that a move survives a real
 * page reload. Seeding helpers: `./emulator.ts`.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  readFields,
  resetAndCreateOwner,
  seedAcmeRole,
  seedApplication,
  signInAndOpenPipeline,
} from "./emulator.ts";

test.beforeEach(async () => {
  const uid = await resetAndCreateOwner();
  await seedAcmeRole(uid);
  await seedApplication(uid, "a-1", "saved", "2026-10-01T00:00:00.000Z");
});

async function readStage(applicationId: string): Promise<unknown> {
  return (await readFields(`applications/${applicationId}`))?.stage?.stringValue;
}

const column = (page: Page, stage: string) =>
  page.locator(`[data-testid="pipeline-column"][data-stage="${stage}"]`);
const card = (page: Page) =>
  page.locator('[data-testid="pipeline-card"][data-application-id="a-1"]');

test("drags a card from Saved to Applied and it survives a reload", async ({ page }) => {
  await signInAndOpenPipeline(page);
  await expect(column(page, "saved").getByText("Acme")).toBeVisible();

  await card(page).dragTo(column(page, "applied"));

  await expect(column(page, "applied").getByText("Acme")).toBeVisible();
  await expect(card(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => readStage("a-1")).toBe("applied");

  await page.reload();
  await expect(page.getByTestId("pipeline-board")).toBeVisible();
  await expect(column(page, "applied").getByText("Acme")).toBeVisible();
  await expect(column(page, "saved").getByText("Acme")).toHaveCount(0);
  // last_activity_at was reset by the move.
  await expect(card(page).getByTestId("pipeline-card-days")).toHaveText("0d");
});

test("moves a focused card with the arrow keys, persisted across a reload", async ({ page }) => {
  await signInAndOpenPipeline(page);

  await card(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(column(page, "drafting").getByText("Acme")).toBeVisible();
  await expect(card(page)).toBeFocused();
  await expect(card(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("ArrowRight");
  await expect(column(page, "applied").getByText("Acme")).toBeVisible();
  await expect.poll(() => readStage("a-1")).toBe("applied");

  await page.reload();
  await expect(column(page, "applied").getByText("Acme")).toBeVisible();
});
