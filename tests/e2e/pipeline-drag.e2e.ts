/**
 * Browser smoke test for moving Pipeline cards (#511): the real app in
 * Chromium, signed in through the Auth emulator, reading and writing
 * the Firestore emulator. Covers what the jsdom tests cannot: the
 * browser's own HTML5 drag sequence, and that a move survives a real
 * page reload.
 *
 * Each test resets both emulators and seeds one owner with one
 * Application in Saved. Seeding goes through the emulators' REST APIs;
 * the Firestore writes use the emulator's `Bearer owner` token, which
 * bypasses security rules (seeding only; the app's own reads and the
 * move write go through the rules).
 */

import { expect, test, type Page } from "@playwright/test";

import { E2E_PROJECT_ID } from "../../playwright.config.ts";

const AUTH = "http://127.0.0.1:9099";
const FIRESTORE = "http://127.0.0.1:8080";
const DOCS = `${FIRESTORE}/v1/projects/${E2E_PROJECT_ID}/databases/(default)/documents`;

const EMAIL = "owner@example.test";
const PASSWORD = "e2e-password-123";

type FirestoreValue =
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } };

function fields(
  data: Record<string, string | string[]>,
): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      Array.isArray(v)
        ? { arrayValue: { values: v.map((s) => ({ stringValue: s })) } }
        : { stringValue: v },
    ]),
  );
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

async function seedDoc(
  path: string,
  data: Record<string, string | string[]>,
): Promise<void> {
  await ok(
    await fetch(`${DOCS}/${path}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ fields: fields(data) }),
    }),
    `seed ${path}`,
  );
}

async function readStage(applicationId: string): Promise<string | undefined> {
  const res = await ok(
    await fetch(`${DOCS}/applications/${applicationId}`, {
      headers: { Authorization: "Bearer owner" },
    }),
    "read application",
  );
  const doc = (await res.json()) as { fields?: { stage?: { stringValue?: string } } };
  return doc.fields?.stage?.stringValue;
}

test.beforeEach(async () => {
  await ok(
    await fetch(`${FIRESTORE}/emulator/v1/projects/${E2E_PROJECT_ID}/databases/(default)/documents`, {
      method: "DELETE",
    }),
    "reset firestore",
  );
  await ok(
    await fetch(`${AUTH}/emulator/v1/projects/${E2E_PROJECT_ID}/accounts`, {
      method: "DELETE",
    }),
    "reset auth",
  );
  const signUp = await ok(
    await fetch(
      `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
      },
    ),
    "create user",
  );
  const { localId: uid } = (await signUp.json()) as { localId: string };

  // firestore.rules admits only allowlisted owners (#439).
  await seedDoc("config/access", { owner_uids: [uid] });
  await seedDoc("companies/c-acme", { owner_uid: uid, name: "Acme", priority: "high" });
  await seedDoc("roles/r-pm", {
    owner_uid: uid,
    company_id: "c-acme",
    title: "Staff PM",
    jd_raw: "",
    discovered_at: "2026-10-01T00:00:00.000Z",
  });
  await seedDoc("applications/a-1", {
    owner_uid: uid,
    role_id: "r-pm",
    stage: "saved",
    last_activity_at: "2026-10-01T00:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: [],
  });
});

async function signInAndOpenPipeline(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in");
  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline-board")).toBeVisible();
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
