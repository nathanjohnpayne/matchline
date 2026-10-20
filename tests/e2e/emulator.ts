/**
 * Shared emulator helpers for the Playwright smoke specs: reset both
 * emulators, create the signed-in owner, seed Firestore documents over
 * the emulator REST API, and sign in through the app's own form.
 *
 * Firestore seeding uses the emulator's `Bearer owner` token, which
 * bypasses security rules (seeding and verification only); everything
 * the app does in the browser goes through the rules.
 */

import { expect, type Page } from "@playwright/test";

import { E2E_PROJECT_ID } from "../../playwright.config.ts";

const AUTH = "http://127.0.0.1:9099";
const FIRESTORE = "http://127.0.0.1:8080";
const DOCS = `${FIRESTORE}/v1/projects/${E2E_PROJECT_ID}/databases/(default)/documents`;

export const EMAIL = "owner@example.test";
export const PASSWORD = "e2e-password-123";

type FirestoreValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { arrayValue: { values?: FirestoreValue[] } };

export type SeedValue = string | boolean | string[];

function toValue(v: SeedValue): FirestoreValue {
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  }
  return typeof v === "boolean" ? { booleanValue: v } : { stringValue: v };
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

/** Wipe both emulators and create the owner account; returns its uid. */
export async function resetAndCreateOwner(): Promise<string> {
  await ok(
    await fetch(
      `${FIRESTORE}/emulator/v1/projects/${E2E_PROJECT_ID}/databases/(default)/documents`,
      { method: "DELETE" },
    ),
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
        body: JSON.stringify({
          email: EMAIL,
          password: PASSWORD,
          returnSecureToken: true,
        }),
      },
    ),
    "create user",
  );
  const { localId: uid } = (await signUp.json()) as { localId: string };
  // firestore.rules admits only allowlisted owners (#439).
  await seedDoc("config/access", { owner_uids: [uid] });
  return uid;
}

export async function seedDoc(
  path: string,
  data: Record<string, SeedValue>,
): Promise<void> {
  await ok(
    await fetch(`${DOCS}/${path}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, toValue(v)]),
        ),
      }),
    }),
    `seed ${path}`,
  );
}

/** Raw fields of a document, or `undefined` when it does not exist. */
export async function readFields(
  path: string,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  const res = await fetch(`${DOCS}/${path}`, {
    headers: { Authorization: "Bearer owner" },
  });
  if (res.status === 404) return undefined;
  await ok(res, `read ${path}`);
  const doc = (await res.json()) as { fields?: Record<string, Record<string, unknown>> };
  return doc.fields ?? {};
}

/** Every document in a top-level collection, as raw fields. */
export async function listFields(
  collection: string,
): Promise<Record<string, Record<string, unknown>>[]> {
  const res = await ok(
    await fetch(`${DOCS}/${collection}`, {
      headers: { Authorization: "Bearer owner" },
    }),
    `list ${collection}`,
  );
  const body = (await res.json()) as {
    documents?: { fields?: Record<string, Record<string, unknown>> }[];
  };
  return (body.documents ?? []).map((d) => d.fields ?? {});
}

/** Seed one Acme / Staff PM Role (and its Company) for `uid`. */
export async function seedAcmeRole(uid: string): Promise<void> {
  await seedDoc("companies/c-acme", { owner_uid: uid, name: "Acme", priority: "high" });
  await seedDoc("roles/r-pm", {
    owner_uid: uid,
    company_id: "c-acme",
    title: "Staff PM",
    jd_raw: "",
    discovered_at: "2026-10-01T00:00:00.000Z",
  });
}

export async function seedApplication(
  uid: string,
  id: string,
  stage: string,
  lastActivityAt: string,
): Promise<void> {
  await seedDoc(`applications/${id}`, {
    owner_uid: uid,
    role_id: "r-pm",
    stage,
    last_activity_at: lastActivityAt,
    generated_assets: [],
    approved_unit_ids: [],
  });
}

export async function signInAndOpenPipeline(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in");
  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline-board")).toBeVisible();
}
