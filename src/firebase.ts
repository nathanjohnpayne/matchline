import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

/**
 * Firebase client config. Values are injected via Vite env vars (`VITE_*`)
 * so the bundle does not embed credentials at build time for the wrong
 * environment. See `.env.local` (gitignored) for local development.
 */
function readConfig() {
  const env = import.meta.env;
  const required = [
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_APP_ID",
  ] as const;

  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Firebase config missing env vars: ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and fill in the values.`,
    );
  }

  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
}

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let functions: Functions | undefined;

export function getApp(): FirebaseApp {
  if (!app) app = initializeApp(readConfig());
  return app;
}

export function getAuthClient(): Auth {
  if (!auth) auth = getAuth(getApp());
  return auth;
}

export function getDb(): Firestore {
  if (!db) db = getFirestore(getApp());
  return db;
}

/**
 * Firebase Functions client singleton. Used for HTTPS-callable
 * invocations from the browser (e.g. the Matches tab's
 * auto-trigger of `runMatching` per #131).
 */
export function getFunctionsClient(): Functions {
  if (!functions) functions = getFunctions(getApp());
  return functions;
}
