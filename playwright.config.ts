/**
 * Playwright smoke tests (#511; docs/agents/testing-requirements.md
 * § Phase 2: UI tickets add browser smoke tests for critical paths
 * such as drag-to-stage).
 *
 * Run with `npm run test:e2e`, which starts the Auth and Firestore
 * emulators for the offline `demo-matchline-e2e` project around
 * `playwright test`. The web server below is the Vite dev server built
 * against that project with `VITE_FIREBASE_EMULATORS=true`, so the app
 * talks only to the local emulators (see `src/firebase.ts`).
 *
 * Specs live in `tests/e2e/` and end in `.e2e.ts`, a suffix vitest
 * does not collect, so `npm test` never tries to run them.
 */

import { defineConfig, devices } from "@playwright/test";

export const E2E_PROJECT_ID = "demo-matchline-e2e";
const PORT = 5175;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  // The specs share one emulator project and reset it per test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_FIREBASE_EMULATORS: "true",
      VITE_FIREBASE_API_KEY: "demo-api-key",
      VITE_FIREBASE_AUTH_DOMAIN: `${E2E_PROJECT_ID}.firebaseapp.com`,
      VITE_FIREBASE_PROJECT_ID: E2E_PROJECT_ID,
      VITE_FIREBASE_APP_ID: "demo-app-id",
    },
  },
});
