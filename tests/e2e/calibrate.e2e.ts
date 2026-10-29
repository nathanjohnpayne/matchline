/**
 * Browser smoke test for Calibrate (`/calibrate`, #636) at phone size:
 * upload a deck to the account, label every card with drags and buttons,
 * re-queue one with Can't tell, undo, note, resume from the account with
 * this browser's copy cleared, and download the labels file.
 *
 * The deck is built from the synthetic fixture packet in
 * `tools/label-swipe/fixtures/packet/` (invented names only), written to
 * the test's output folder, and opened through the file input, as on a
 * phone. Set CALIBRATE_SHOTS to a folder to keep screenshots of each state.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { buildDecks } from "../../tools/label-swipe/build-deck.mts";
import { EMAIL, PASSWORD, resetAndCreateOwner } from "./emulator.ts";

const PACKET = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "label-swipe", "fixtures", "packet");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.CALIBRATE_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Drag the card like a finger: press, move in steps, release. */
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const card = page.getByTestId("calibrate-card");
  // Opening the full text scrolls the page down to it; scroll back first.
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error("no card");
  const x = box.x + box.width / 2;
  const y = box.y + 60;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
  await page.waitForTimeout(260);
}

const labelled = (page: Page) => page.getByText(/\d+ of \d+ labelled/);

test("a deck can be labelled end to end on a phone-sized screen", async ({ page }, testInfo) => {
  await resetAndCreateOwner();
  const [deck] = buildDecks(PACKET, join(PACKET, "no-fixtures"));
  const deckPath = testInfo.outputPath(`${deck.deck_id}.json`);
  writeFileSync(deckPath, JSON.stringify(deck));
  const total = deck.cards.length;

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in");
  await page.getByRole("link", { name: "Calibrate" }).click();
  await expect(page.getByRole("heading", { name: "Calibrate" })).toBeVisible();
  await shot(page, "1-picker");

  // Upload waits for the deck list: it checks a re-upload against stored labels.
  await expect(page.getByText("No decks yet.", { exact: false })).toBeVisible();
  await page.getByLabel("Upload deck files…").setInputFiles(deckPath);
  await expect(page.getByText(deck.deck_id.split("__")[0], { exact: true })).toBeVisible();
  await expect(page.getByText(`Not started · ${total} cards`)).toBeVisible();
  await shot(page, "1b-decks");
  await page.getByRole("button", { name: "Label all" }).click();
  await expect(labelled(page)).toHaveText(new RegExp(`0 of ${total} labelled`));
  await shot(page, "2-card");

  // A short drag springs back; a long one swipes.
  await drag(page, 50, 0);
  await expect(labelled(page)).toHaveText(new RegExp(`0 of ${total}`));
  await page.mouse.move(195, 300);
  const box = await page.getByTestId("calibrate-card").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 60);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 - 70, box!.y + 66, { steps: 6 });
  await shot(page, "3-dragging");
  await page.mouse.up();
  await page.waitForTimeout(260);

  await drag(page, 0, -180); // Can't tell: re-queued
  await expect(page.getByRole("status")).toContainText("Moved to the end");
  await drag(page, -180, 10); // False
  await expect(labelled(page)).toHaveText(new RegExp(`1 of ${total}`));
  await page.getByRole("button", { name: /Add a note to the last card/ }).click();
  await page.getByLabel("Note for the last card").fill("invented note");
  await page.getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: /Undo/ }).click();
  await expect(labelled(page)).toHaveText(new RegExp(`0 of ${total}`));
  await page.getByTestId("calibrate-card").tap();
  await expect(page.getByRole("region", { name: "Full source" })).toBeVisible();
  await shot(page, "4-source");

  // Progress lives in the account: with this browser's copy cleared, a
  // reload resumes where the account says.
  await drag(page, 180, 0);
  await expect(labelled(page)).toHaveText(new RegExp(`1 of ${total}`));
  await expect(labelled(page)).toContainText("· saved"); // the account write has landed
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(`1 of ${total} labelled · ${total} cards`)).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(labelled(page)).toHaveText(new RegExp(`1 of ${total}`));

  // Label the rest: swipe right, or the True button, until the cell ends.
  for (let i = 0; i < total + 2 && !(await page.getByRole("region", { name: "Cell done" }).isVisible()); i += 1) {
    if (i % 2 === 0) await drag(page, 180, 0);
    else {
      await page.getByRole("button", { name: /True/ }).click();
      await page.waitForTimeout(240);
    }
  }
  const done = page.getByRole("region", { name: "Cell done" });
  await expect(done).toBeVisible();
  await shot(page, "5-done");

  const [download] = await Promise.all([page.waitForEvent("download"), done.getByRole("button", { name: "Download labels" }).click()]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^labels-${deck.deck_id}-\\d{8}T\\d{6}Z\\.json$`));
  const labels = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(labels.items).toHaveLength(total);
  expect(labels.items.some((i: { undos: number }) => i.undos > 0)).toBe(true);
  expect(Object.keys(labels).sort()).toEqual(["attention", "deck_id", "items", "seed", "session_id"]);

  // Remove deletes the deck and its labels together (one batch).
  await page.getByRole("button", { name: "Decks" }).click();
  await page.getByRole("button", { name: `Remove ${deck.deck_id}` }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("No decks yet.", { exact: false })).toBeVisible();
});
