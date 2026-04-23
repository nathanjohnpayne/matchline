# Matchline — Sprint 0: Foundations

Goal: land the scaffolding needed to build the V1 core loop in Sprint 1.
No product surface ships in this sprint. Duration target: 1 week.

Reference: `specs/matchline.md` and PRD § What ships first → Sprint 0.

## Tasks

1. **Firebase project**
   - Create the Firebase project (`matchline-{env}`) in the GCP account.
   - Enable Hosting, Firestore, Functions, Auth.
   - Run `op-firebase-setup` to create the deployer service account and
     wire up 1Password-backed impersonation per `DEPLOYMENT.md`.
   - Commit `.firebaserc` and `firebase.json`.

2. **Frontend shell**
   - Scaffold React + TypeScript + Vite + Tailwind in `src/`.
   - Wire up Firebase Auth and a typed Firestore client.
   - Add a minimal app shell with routes for the five V1 surfaces
     (Onboarding, Unit Review, Role Detail, Application Editor,
     Pipeline). Each route renders a placeholder; no real UI yet.

3. **Typed service layer**
   - Under `src/services/`, add typed wrappers over Firestore for the
     CRM and Capability Graph objects defined in `specs/matchline.md`.
   - No direct Firestore calls from React components — all reads and
     writes go through the service layer. This is invariant, not
     preference.

4. **LLM client wrappers**
   - Under `functions/src/llm/`, add thin wrappers for Anthropic and
     OpenAI. No model identifiers hardcoded in call sites; per-stage
     model choice comes from config.
   - Add an embeddings client for `text-embedding-3-small`.

5. **Secrets**
   - Store `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in Firebase
     secrets. Do not commit plaintext keys. Reference them via the
     1Password-backed flow in `DEPLOYMENT.md`.

6. **CI**
   - Keep `repo_lint.yml` green. Add a stub `npm test` that runs no
     suites yet but exits `0`.

## Milestone

End-to-end "hello world": a signed-in user lands on an empty Unit
Review screen, the service layer returns an empty Experience Unit
list from Firestore, and the deploy pipeline ships the build to
Firebase Hosting via impersonated credentials.

## Exit criteria

- `npm run build` succeeds locally and in CI.
- `op-firebase-deploy` succeeds against the live Firebase project.
- Each CI lint in `scripts/ci/` passes.
- No surface-level feature work has been attempted (Sprint 1 territory).
