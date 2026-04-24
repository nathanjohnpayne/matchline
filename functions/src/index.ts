import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";

initializeApp();

/**
 * Sprint 0 health endpoint. Keeps the `functions` package deployable
 * before the real extraction / matching / generation endpoints land
 * in Sprint 1.
 */
export const health = onRequest((_req, res) => {
  res.json({ status: "ok", service: "matchline", version: "0.0.0" });
});

/** Phase 1: pasted resume → array of extracted ExperienceUnits. */
export { extractFromResumeCallable as extractFromResume } from "./callables/extractFromResume.js";
