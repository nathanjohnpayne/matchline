# Deployment

## New Machine Setup

Run these steps on any new or temporary machine. Tell your AI agent:

> "Set up this machine for development. Run the new machine setup from DEPLOYMENT.md."

### 1. Install system tools

```bash
# 1Password CLI
brew install --cask 1password-cli

# Firebase CLI
npm install -g firebase-tools

# Google Cloud SDK
brew install google-cloud-sdk

# GitHub CLI
brew install gh
```

### 2. Authenticate

```bash
# 1Password — enables biometric unlock for op CLI
# (Follow the prompts to sign in and enable Touch ID)
op signin

# GitHub CLI
gh auth login

# Google Cloud — use 1Password-backed ADC (no interactive login needed
# if op is authenticated and the GCP ADC item exists in 1Password)
```

### 3. Install deploy scripts

```bash
# Clone the template repo if not already present
git clone https://github.com/nathanjohnpayne/mergepath.git ~/Documents/GitHub/mergepath

# Install canonical helper scripts
mkdir -p ~/.local/bin
cp ~/Documents/GitHub/mergepath/scripts/gcloud/gcloud ~/.local/bin/
cp ~/Documents/GitHub/mergepath/scripts/firebase/op-firebase-deploy ~/.local/bin/
cp ~/Documents/GitHub/mergepath/scripts/firebase/op-firebase-setup ~/.local/bin/
chmod +x ~/.local/bin/gcloud ~/.local/bin/op-firebase-deploy ~/.local/bin/op-firebase-setup

# Ensure PATH includes ~/.local/bin
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

### 4. Clone and bootstrap all repos

```bash
cd ~/Documents/GitHub

for repo in friends-and-family-billing device-platform-reporting device-source-of-truth swipewatch nathanpaynedotcom overridebroadway matchline; do
  git clone "https://github.com/nathanjohnpayne/$repo.git" 2>/dev/null || (cd "$repo" && git pull)
  cd "$repo"
  ./scripts/bootstrap.sh    # restores .env.local from 1Password via op inject
  cd ..
done
```

The bootstrap script for each repo:
- Resolves `op://` references in `.env.tpl` → writes `.env.local` (via `op inject`)
- Runs `npm install`
- Runs `npm run build` (if applicable)

### 5. Verify

```bash
# Quick check that each repo's local config was restored
for repo in friends-and-family-billing device-platform-reporting device-source-of-truth overridebroadway matchline; do
  echo "=== $repo ==="
  ls ~/Documents/GitHub/$repo/.env* 2>/dev/null || echo "  (no env files expected)"
done
```

---

## Returning to Your Main Machine

When you return from a temporary machine, tell your agent:

> "Sync any changes from this session back. Run the return-to-main workflow from DEPLOYMENT.md."

### 1. On the temporary machine (before leaving)

```bash
cd ~/Documents/GitHub
for repo in friends-and-family-billing device-platform-reporting device-source-of-truth swipewatch nathanpaynedotcom overridebroadway matchline; do
  cd "$repo"
  # Push any local config changes to 1Password
  ./scripts/bootstrap.sh --sync
  # Ensure all code changes are committed and pushed
  git status
  cd ..
done
```

### 2. On the main machine (when you return)

```bash
cd ~/Documents/GitHub
for repo in friends-and-family-billing device-platform-reporting device-source-of-truth swipewatch nathanpaynedotcom overridebroadway matchline; do
  cd "$repo"
  git pull                          # get code changes from the temp machine
  ./scripts/bootstrap.sh --force    # re-resolve .env.tpl from 1Password (latest values)
  cd ..
done
```

The `--force` flag overwrites existing `.env.local` files with freshly resolved
values from 1Password. This ensures you pick up any secrets that were updated
on the temporary machine via `--sync`.

### Conflict resolution

If both machines modified the same 1Password item:
- 1Password keeps the latest write (last-writer-wins)
- The `.env.tpl` templates are in git, so structural changes merge normally
- For true conflicts, compare with `op item get <id>` and resolve manually

---

## Prerequisites

- [Firebase CLI](https://firebase.google.com/docs/cli) (`firebase-tools`) installed globally
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed
- [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) installed and signed in
- `gcloud`, `op-firebase-deploy`, and `op-firebase-setup` on PATH (see Script Installation below)
- Access to the project SA key in `op://Firebase/{project-id} — Firebase Deployer SA Key` (preferred for CI/headless) or the shared 1Password source credential `op://Private/c2v6emkwppjzjjaq2bdqk3wnlm/credential`, or another explicit `GOOGLE_APPLICATION_CREDENTIALS` file
- Permission to create resources in the target Firebase/GCP project and impersonate the deployer service account

## Script Installation

The canonical helper scripts live in the Mergepath reference
implementation. Copies are shipped in `scripts/` here for offline use;
treat the Mergepath copies as canonical and flow updates from there.
Install them once per machine:

```bash
# From the mergepath repo (canonical):
cd ~/Documents/GitHub/mergepath
mkdir -p ~/.local/bin
cp scripts/gcloud/gcloud ~/.local/bin/gcloud
cp scripts/firebase/op-firebase-deploy ~/.local/bin/
cp scripts/firebase/op-firebase-setup ~/.local/bin/
chmod +x ~/.local/bin/gcloud ~/.local/bin/op-firebase-deploy ~/.local/bin/op-firebase-setup
```

Ensure `~/.local/bin` is on your `PATH` (add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` if needed), then run `hash -r` or open a new shell.

If you update the installed copies on your machine, sync the changes back
to Mergepath (the canonical source) and then refresh the vendored copies
in this repo's `scripts/`.

## New Project Setup

Do this once when creating a project from scratch. Skip if the Firebase project already exists.

### 1. Create the Firebase project

```bash
firebase projects:create {project-id} --display-name "{Display Name}"
```

Or create it in [Firebase Console](https://console.firebase.google.com/) → Add project.

### 2. Enable Firebase services

In [Firebase Console](https://console.firebase.google.com/project/{project-id}), enable whichever services the project needs:

- **Hosting** — always required
- **Firestore** — if the app uses a database (start in production mode)
- **Authentication** — if the app has user sign-in
- **Cloud Functions** — requires Blaze (pay-as-you-go) billing plan
- **Storage** — if the app stores files

### 3. Initialize the repository

From the repository root:

```bash
firebase init
```

When prompted:
- Select the services to configure (Hosting, Firestore, Functions, Storage — match what you enabled above)
- **Use existing project** → select `{project-id}`
- **Public directory**: `dist` (or `out` for Next.js static export, `.` for no-build static sites)
- **Configure as single-page app**: Yes (if the app uses client-side routing)
- **Set up automatic builds**: No
- **Overwrite existing files**: No (if any already exist)

This creates `firebase.json` and `.firebaserc`. Commit both.

### 4. Set up keyless deploy impersonation

```bash
op-firebase-setup {project-id}
```

See [First-Time Setup](#first-time-setup) for details. After this, deploys use short-lived impersonated credentials instead of stored keys.

If `op://Private/c2v6emkwppjzjjaq2bdqk3wnlm/credential` does not exist yet, seed it once by running `gcloud auth application-default login`, then copy `~/.config/gcloud/application_default_credentials.json` into the 1Password item `Private/GCP ADC`, field `credential`. After that, the normal maintainer flow returns to 1Password-backed, non-browser auth.

---

## Machine User Setup (New Project)

When creating a new repository from this template, complete these steps to enable the AI agent cross-review system. All steps are manual (human-only) unless noted.

### 1. Add machine users as collaborators

Go to the new repo → Settings → Collaborators → Invite each:

- `nathanpayne-claude` — Write access
- `nathanpayne-codex` — Write access
- `nathanpayne-cursor` — Write access

### 2. Accept collaborator invitations

Log into each machine user account and accept the invitation:

- https://github.com/notifications (as `nathanpayne-claude`)
- https://github.com/notifications (as `nathanpayne-codex`)
- https://github.com/notifications (as `nathanpayne-cursor`)

Alternatively, use `gh` CLI or the invite URL directly: `https://github.com/{owner}/{repo}/invitations`

**Note:** Fine-grained PATs cannot accept invitations via API. Use the browser or a classic PAT with `repo` scope.

### 3. Store PATs as repository secrets

Go to the new repo → Settings → Secrets and variables → Actions → New repository secret. Add:

| Secret name | Value | PAT type |
|---|---|---|
| `REVIEWER_ASSIGNMENT_TOKEN` | PAT for `nathanjohnpayne` | Fine-grained OK (owns repo) |

Or use the CLI (faster):

```bash
gh secret set REVIEWER_ASSIGNMENT_TOKEN --repo {owner}/{repo} --body "$(op read 'op://Private/sm5kopwk6t6p3xmu2igesndzhe/token')"
```

**Reviewer identity PATs (`nathanpayne-claude`, `nathanpayne-codex`,
`nathanpayne-cursor`) are intentionally NOT stored as repo CI secrets.**
Phase 2 internal self-peer review runs in the agent's own session: the
agent switches its Git identity to its reviewer account with a PAT
read directly from 1Password (`op read 'op://Private/<item-id>/token'`)
and posts the review with that PAT. See REVIEW_POLICY.md § Phase 2 and
each repo's `CLAUDE.md` / `AGENTS.md` for the identity-switch procedure.

**Do NOT add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CLAUDE_PAT` /
`CODEX_PAT` / `CURSOR_PAT` as repo secrets.** An earlier iteration of
`agent-review.yml` had an `invoke-reviewer` job that ran the Claude
Code CLI headlessly as a CI-side reviewer; this was the wrong flow
(parallel to the authoring session, stale-API-key failure surface,
duplicate work) and was removed. Phase 2 now lives entirely inside
the authoring agent's session.

### 4. Configure branch protection

Go to the new repo → Settings → Branches → Add branch protection rule for `main`:

1. **Require pull request reviews before merging:** Yes
2. **Required number of approving reviews:** 1
3. **Dismiss stale pull request approvals when new commits are pushed:** Yes
4. **Require status checks to pass before merging:** Yes
   - Add `Self-Review Required`
   - Add `Label Gate`
5. **Do not allow bypassing the above settings:** Disabled (so Nathan can force-merge in emergencies)

Or use the CLI:

```bash
gh api --method PUT "repos/{owner}/{repo}/branches/main/protection" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      {"context": "Self-Review Required"},
      {"context": "Label Gate"}
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null
}
EOF
```

**Note:** Branch protection requires the repo to be public, or requires GitHub Pro/Team for private repos.

**Known issue:** The `Self-Review Required` and `Label Gate` status checks are
configured as required but may never report if the CI workflows that post them
(`pr-review-policy.yml`) fail silently due to misconfigured repository secrets.
This blocks all merges. Workarounds:
- Fix the CI secrets so status checks report, **or**
- Use the GitHub web UI "Merge without waiting for requirements" bypass checkbox

The `--admin` flag on `gh pr merge` does **not** bypass required status checks —
it only bypasses review requirements. The break-glass hook (`BREAK_GLASS_ADMIN=1`)
only bypasses the Claude Code PreToolUse guard, not GitHub's branch protection API.

### 5. Create required labels

The workflows expect these labels to exist. Create them if they don't:

```bash
gh label create "needs-external-review" --color "D93F0B" --description "Blocks merge until external reviewer approves" --repo {owner}/{repo}
gh label create "needs-human-review" --color "B60205" --description "Agent disagreement — requires human review" --repo {owner}/{repo}
gh label create "policy-violation" --color "000000" --description "Review policy violation detected" --repo {owner}/{repo}
gh label create "audit" --color "FBCA04" --description "Weekly PR audit report" --repo {owner}/{repo}
```

### 6. Verify setup

Run these checks after completing the steps above:

```bash
REPO="{owner}/{repo}"

# Check collaborators
echo "=== Collaborators ==="
gh api "repos/$REPO/collaborators" --jq '.[].login'

# Check secrets exist
echo "=== Secrets ==="
gh secret list --repo "$REPO"

# Check branch protection
echo "=== Branch Protection ==="
DEFAULT=$(gh api "repos/$REPO" --jq '.default_branch')
gh api "repos/$REPO/branches/$DEFAULT/protection/required_status_checks" --jq '.checks[].context'

# Check labels
echo "=== Labels ==="
gh label list --repo "$REPO" --search "needs-external-review"
gh label list --repo "$REPO" --search "needs-human-review"
gh label list --repo "$REPO" --search "policy-violation"
```

### Token type: classic PATs required

Machine user reviewer identities (nathanpayne-claude, etc.) are **collaborators**,
not repo owners. GitHub fine-grained PATs on personal accounts only cover repos
owned by the token account — they cannot access collaborator repos. The "All
repositories" scope in fine-grained PATs means all repos the account *owns* (zero
for collaborators), not repos they collaborate on.

**Use classic PATs with `repo` scope for all reviewer identities.** This is stored
in 1Password with the field name `token` (not `credential` or `password`).

1Password item IDs (all classic PATs with `ghp_` prefix, field `token`, vault `Private`):

| Reviewer Identity | 1Password Item ID | `op read` command |
|---|---|---|
| `nathanpayne-claude` | `pvbq24vl2h6gl7yjclxy2hbote` | `op read "op://Private/pvbq24vl2h6gl7yjclxy2hbote/token"` |
| `nathanpayne-cursor` | `bslrih4spwxgookzfy6zedz5g4` | `op read "op://Private/bslrih4spwxgookzfy6zedz5g4/token"` |
| `nathanpayne-codex` | `etak327mpz4drd4byxszfex4vm` | `op read "op://Private/etak327mpz4drd4byxszfex4vm/token"` |
| `nathanjohnpayne` | `sm5kopwk6t6p3xmu2igesndzhe` | `op read "op://Private/sm5kopwk6t6p3xmu2igesndzhe/token"` |

> The item `o6ekjxjjl5gq6rmcneomrjahpu` is **not** in this table on purpose: it is the `nathanpayne-robot` CI service account, which holds no reviewer standing and must never post a review. It was the Codex item until 2026-08-21 — see REVIEW_POLICY.md § PAT lookup table for the hazard note. It changed hands on 2026-08-21 because the robot PAT was created by repurposing the existing Codex item instead of minting a fresh one.

Use the item ID (not the item title) to avoid shell issues with parentheses in
1Password item names like `GitHub PAT (pr-review-claude)`.

### Reviewer PAT quick check

Before asking a reviewer identity to approve a PR, verify the token with
`gh api user` and then reuse the same explicit `GH_TOKEN` override for
`gh pr review`:

```bash
# Example: verify the Claude reviewer identity before approving a PR
GH_TOKEN="$(op read 'op://Private/pvbq24vl2h6gl7yjclxy2hbote/token')" \
  gh api user --jq '.login'
# expected: nathanpayne-claude

GH_TOKEN="$(op read 'op://Private/pvbq24vl2h6gl7yjclxy2hbote/token')" \
  gh pr review <PR#> --repo <owner/repo> --approve --body "Review comment"
```

- Use the item ID from the table above for your agent identity. Do not use the 1Password item title.
- If `gh auth status` still shows `nathanjohnpayne`, that is okay.
  `GH_TOKEN=...` overrides the ambient login for that command.
- On local interactive machines, the `op read` command itself may trigger the
  1Password biometric prompt even if `op whoami` says you are not signed in.
- `Review Can not approve your own pull request` means the wrong GitHub
  identity is still being used. Check the table above and verify you are using
  your agent's item ID, not the author identity's.

### Token rotation (as needed)

The current PATs are set to never expire. If you ever need to rotate
a reviewer identity PAT (`nathanpayne-claude`, `nathanpayne-codex`,
`nathanpayne-cursor`):

1. Generate a new **classic** PAT with `repo` scope for the machine user account
2. Update the `token` field on the corresponding 1Password item
3. Revoke the old token in GitHub
4. Verify agent access still works: `GH_TOKEN="$(op read 'op://Private/<item-id>/token')" gh api user`

Note: reviewer identity PATs are NOT stored as repo CI secrets. They are
read from 1Password per-session by the authoring agent for the in-session
identity switch, so rotation does not require updating any repo secrets.

The `REVIEWER_ASSIGNMENT_TOKEN` repo secret (Nathan's PAT used by the
Agent Review Pipeline workflow) follows a similar process but also
needs a `gh secret set REVIEWER_ASSIGNMENT_TOKEN --repo {owner}/{repo}`
call on every repo after rotating the 1Password item.

---

## Environments

| Environment | Firebase Project | URL |
|-------------|-----------------|-----|
| Production | `{project-id}` | https://{project-id}.web.app |

There is no staging environment by default. All deploys go directly to production unless the repo adds preview channels or a separate project.

## Build Process

```bash
npm run build
```

Build output goes to `dist/`. Never edit `dist/` directly.

## Deployment Steps

The canonical deploy entry point is **`scripts/deploy.sh`**. It wraps `op-firebase-deploy` with two safety guards and the Cloudflare cache purge step so a single `scripts/deploy.sh` (or `npm run deploy`) is the complete, safe deploy surface.

```bash
# Full deploy (build + deploy + cache purge)
scripts/deploy.sh

# Scope the deploy to a single Firebase target
scripts/deploy.sh -- --only hosting
scripts/deploy.sh -- --only firestore:rules

# Skip the build step (assume dist/ is already current)
scripts/deploy.sh --skip-build

# Skip the Cloudflare purge (no CF env vars set, or purge separately)
scripts/deploy.sh --skip-cf-purge

# Break-glass: bypass the main-only / must-be-current-with-origin guards
scripts/deploy.sh --force
```

The guards (see [mergepath#77](https://github.com/nathanjohnpayne/mergepath/issues/77) for the incident that motivated them):

1. **Current branch must be `main`.** Deploys should ship the reviewed, merged state of the project, not a worktree's in-progress branch.
2. **Local `main` must not be behind `origin/main`.** After `git fetch`, `git rev-list --count HEAD..origin/main` must be 0. Otherwise the deploy refuses.

Both guards can be bypassed with `--force` for break-glass scenarios. Never use `--force` during routine deploys.

Cloudflare cache purge runs when `CF_API_TOKEN` and `CF_ZONE_ID` are set in the environment (typical source: `op read 'op://...'`). Without both variables the purge step no-ops with a clear log line.

**Do not run `op-firebase-deploy` or `firebase deploy` directly for routine deploys.** They skip the branch + freshness guards and the cache purge. Direct invocation is reserved for debugging or one-off flows where the deploy surface is known.

Under the hood, `scripts/deploy.sh` delegates to `op-firebase-deploy` with any arguments after `--`:

```bash
op-firebase-deploy              # full deploy
op-firebase-deploy --only hosting
op-firebase-deploy --only firestore:rules
op-firebase-deploy --only functions
```

`op-firebase-deploy`:
1. Auto-detects the Firebase project from `.firebaserc`
2. Reads source credentials in order: `GOOGLE_APPLICATION_CREDENTIALS`, then the project SA key from `op://Firebase/{project-id} — Firebase Deployer SA Key`, then `op://Private/c2v6emkwppjzjjaq2bdqk3wnlm/credential`, then `~/.config/gcloud/application_default_credentials.json`
3. If the source credential is a `service_account` key matching the target `firebase-deployer@{project-id}.iam.gserviceaccount.com`, uses it directly (no impersonation wrapper needed — faster, no `serviceAccountTokenCreator` required)
4. Otherwise, unwraps nested impersonated credentials if needed, stamps the target project into `quota_project_id`, and writes a temporary `impersonated_service_account` credential file
5. Runs `firebase deploy --non-interactive`
6. Cleans up the temp credentials on exit

No browser prompt is needed for routine use once a valid credential exists in the resolution chain and the 1Password CLI is unlocked.

This 1Password-first source-credential model is the default for template-derived repos. Do not replace it with ADC-first day-to-day docs, routine browser-login steps, `firebase login`, or long-lived deploy keys unless a human explicitly asks for that change.

The local `gcloud` wrapper uses the same source-credential precedence so ordinary `gcloud` commands work without a routine interactive `gcloud auth login`. It resolves quota attribution in this order: explicit `--billing-project`, explicit `--project`, the nearest repo `.firebaserc` project, then the active `gcloud` config.

## First-Time Setup

Run once per maintainer/project to create the deployer service account, grant deploy roles, and grant your user permission to impersonate it:

```bash
op-firebase-setup {project-id}
```

If the principal receiving impersonation rights should differ from the principal in the source credential, set:

```bash
FIREBASE_IMPERSONATION_MEMBER=email@example.com op-firebase-setup {project-id}
```

### What op-firebase-setup does

1. Enables `iamcredentials.googleapis.com` on the target project
2. Creates `firebase-deployer@{project-id}.iam.gserviceaccount.com` if it does not already exist
3. Grants the deployer service account these project roles:
   - `roles/firebase.admin`
   - `roles/cloudfunctions.admin`
   - `roles/iam.serviceAccountUser`
   - `roles/artifactregistry.writer`
   - `roles/run.admin`

> **`roles/secretmanager.viewer` is NOT in that list and is required.**
> Any function declaring `secrets: [...]` makes `firebase deploy` call
> `secretmanager.secrets.get` as the *deployer* service account, which
> fails with `403 Permission 'secretmanager.secrets.get' denied` — and
> the message's "or it may not exist" wording sends you looking for a
> missing secret that is present. `roles/firebase.admin` does not
> include it. Note the check runs as the deployer SA, not as you, so
> your own access proves nothing here.
>
> Until `op-firebase-setup` grants it upstream, add it per project:
>
> ```bash
> gcloud projects add-iam-policy-binding {project-id} \
>   --member=serviceAccount:firebase-deployer@{project-id}.iam.gserviceaccount.com \
>   --role=roles/secretmanager.viewer --condition=None
> ```
>
> Granted on `matchline-dev` on 2026-09-02 after it blocked a deploy.
>
> **`viewer` is enough only while no NEW secret binding is needed.** When a
> function declares a secret its runtime service account cannot yet access,
> `firebase deploy` does not merely read it — `Fabricator.applyPlan` calls
> `grantSecretAccess`, which writes the secret's IAM policy via
> `secretmanager.secrets.setIamPolicy` (verified in the installed
> `firebase-tools@15.28.2`: `fabricator.js` → `gcp/secretManager.js`).
> `roles/secretmanager.viewer` is read-only, so the deploy clears
> `secrets.get` and then fails while adding
> `roles/secretmanager.secretAccessor`.
>
> The 2026-09-02 deploy did not hit this: both secrets already had their
> runtime bindings, so the plan had nothing to grant. The first deploy that
> introduces a secret will.
>
> Least-privilege fix — pre-grant the function's **runtime** service account
> on the secret, leaving the deployer read-only and giving firebase-tools
> nothing to write:
>
> ```bash
> gcloud secrets add-iam-policy-binding {SECRET_NAME} --project={project-id} \
>   --member=serviceAccount:{RUNTIME_SA} \
>   --role=roles/secretmanager.secretAccessor
> ```
>
> `{RUNTIME_SA}` is the function's own `serviceAccount` option when it sets
> one, and the compute default —
> `{project-number}-compute@developer.gserviceaccount.com` — only when it
> does not. `firebase-tools` resolves it that way
> (`deploy/functions/ensure.js`: `e.serviceAccount || defaultServiceAccount(e)`),
> so granting the compute default for a function that configures its own
> account leaves the real principal unbound and the deploy still fails.
>
> The blunt alternative is `roles/secretmanager.admin` on the deployer, which
> lets it manage every secret in the project. Prefer the per-secret grant.
4. Grants your user `roles/iam.serviceAccountTokenCreator` on the deployer service account
5. Creates or updates a dedicated `gcloud` configuration named `{project-id}` with project, impersonation, and `billing/quota_project` defaults

`op-firebase-setup` can still print Google Cloud's generic ADC quota warning if the source credential was originally stamped for another project. That warning is expected here: the wrapper and `op-firebase-deploy` both override quota attribution to the target project for actual commands and deploys.

Optional after setup:

```bash
gcloud config configurations activate {project-id}
```

That makes `gcloud` default to the project-specific impersonated configuration for manual GCP work.

## Rollback Procedure

Firebase Hosting supports instant rollback:

```bash
# List recent releases
firebase hosting:releases:list

# Roll back via CLI
firebase hosting:channel:deploy live --release-id <VERSION_ID>
```

Or use Firebase Console → Hosting → Release History → Roll back.

## Post-Deployment Verification

1. Open the live URL in an incognito window
2. Verify core app functionality
3. Check browser DevTools → Console for errors

## CI/CD Integration

Deploys are manual via `op-firebase-deploy`. CI workflows (repo linting, review policy enforcement) run on push/PR via GitHub Actions — see `.github/workflows/`.

When connecting CI, prefer Workload Identity Federation or another `external_account` credential as the source credential. If CI already exposes `GOOGLE_APPLICATION_CREDENTIALS` pointing at an `external_account` file, `op-firebase-deploy` can reuse it to impersonate the deployer service account and attribute quota to the target project.

### CI/CD & Headless Deploy

For headless environments (Claude Code cloud tasks, GitHub Actions, etc.) where
1Password biometric auth is unavailable, use the project SA key directly:

```bash
# Pull the SA key from 1Password (one-time, requires biometric on an interactive machine)
op document get "{project-id} — Firebase Deployer SA Key" \
  --vault Firebase --out-file ~/firebase-keys/{project-id}-sa-key.json

# Deploy with the SA key (no impersonation, no 1Password needed at deploy time)
GOOGLE_APPLICATION_CREDENTIALS=~/firebase-keys/{project-id}-sa-key.json npm run deploy
```

When the source credential is a `service_account` key matching the target deployer SA, `op-firebase-deploy` skips the impersonation wrapper and uses the key directly.

For Claude Code cloud scheduled tasks:
1. Retrieve the key: `op document get "{project-id} — Firebase Deployer SA Key" --vault Firebase`
2. Copy the JSON contents
3. In the task's cloud environment, add an env var: `FIREBASE_SA_KEY=<paste JSON>`
4. Add a setup script:
   ```bash
   echo "$FIREBASE_SA_KEY" > /tmp/sa-key.json
   export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa-key.json
   ```

Each project's SA key is stored in the 1Password **Firebase** vault with the naming convention `{project-id} — Firebase Deployer SA Key`.

## Secrets Management

- No API keys or secrets should be committed to the repository.
- Deploy auth should use short-lived impersonated credentials, not stored service-account keys.
- Runtime secrets can still use `op://Private/<item>/<field>` references in committed template files and `op inject` into gitignored runtime files when a repo actually needs 1Password-managed application secrets.
- Never commit resolved secret output, service-account JSON, or ADC credentials.

### Writing a secret value: never use `echo`

`echo` appends a trailing newline, and Secret Manager stores the bytes verbatim and mounts them verbatim into the function's environment. A key written that way is sent as `x-api-key: sk-ant-…\n` — a malformed HTTP header. Every provider call then fails in under a second, the retry budget burns instantly, and the user sees "Extraction failed after retries; needs manual review."

```bash
# WRONG — stores a trailing newline
echo "$KEY" | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-

# RIGHT — stores exactly the bytes of the key
printf '%s' "$KEY" | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-
```

This bit `matchline-dev` in #426 and cost hours, because it is invisible to the obvious way of checking. Reading the secret back with `$(gcloud secrets versions access …)` strips the trailing newline in command substitution, so a local reproduction using "the same key" succeeds while production keeps failing. Compare raw bytes instead:

```bash
gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=<proj> > /tmp/k
echo "raw=$(wc -c < /tmp/k) stripped=$(printf '%s' "$(cat /tmp/k)" | wc -c)"   # must match
rm -f /tmp/k
```

`functions/src/llm/apiKey.ts` now trims defensively at client construction, so a contaminated secret can no longer cause this. The guidance still matters: the trim is a backstop, not a licence to store dirty values.

## Cloud Run IAM prerequisites (Functions)

Firebase callables are **not** protected by Cloud Run IAM. Auth is enforced *inside* each function against the Firebase ID token in the callable envelope (`request.auth?.uid`). Cloud Run must therefore let the request through, or the browser's CORS preflight is rejected with a 403 carrying no `Access-Control-*` headers, `fetch` rejects, and the SDK reports a bare `internal` with no diagnostic.

Two things are required, and **neither is created by `firebase deploy`**:

**1. The invoker must be permitted.** Normally `allUsers` → `roles/run.invoker`:

```bash
gcloud run services add-iam-policy-binding <service> --region=us-central1   --project=<proj> --member=allUsers --role=roles/run.invoker
```

Under a **domain restricted sharing** org policy (`constraints/iam.allowedPolicyMemberDomains`) that fails with `FAILED_PRECONDITION: One or more users named in the policy do not belong to a permitted customer`. The legacy constraint cannot be given an `allUsers` exception — that requires migrating to a custom CEL constraint. Per [Cloud Run's docs](https://docs.cloud.google.com/run/docs/authenticating/public), disable the invoker IAM check instead:

```bash
gcloud run services update <service> --region=us-central1   --project=<proj> --no-invoker-iam-check
```

This is a service-level setting, so it does **not** create a new revision and it **does** survive `firebase deploy` (verified on matchline-dev, #422).

**Service naming.** Firebase Tools derives the Cloud Run service id from the function id by lowercasing it and replacing `_` with `-`. So `webhook_receiver` deploys as `webhook-receiver`, not `webhook_receiver`.

**Region.** The commands below assume `us-central1`. A function that sets its own `region` option deploys elsewhere, and the command must name that region — targeting the wrong one silently "succeeds" against a service that is not the one serving traffic.

### Function inventory

Every function exported from `functions/src/index.ts` appears here. HTTP-triggered functions (`onCall` / `onRequest`) need the invoker step above once, on first deploy. Event-triggered functions must **NOT** get it: they rely on authenticated event delivery, and making one publicly invokable would be a security regression.

**This table is maintained by hand.** A CI check to enforce it was attempted and withdrawn (PR #452): deciding which exports become which Cloud Run services requires resolving TypeScript binding forms and firebase-tools' naming rules, and five review rounds kept finding valid shapes it parsed wrongly — at one point it would have advised making an event-triggered function publicly invokable. Approximating a compiler in a lint script produced a guard that was confidently wrong more often than the drift it was meant to catch.

So when you add a function to `functions/src/index.ts`, add a row here, and set the `invoker step` column deliberately — HTTP-triggered functions need it, event-triggered functions must not have it.

| function (`index.ts`) | Cloud Run service | invoker step |
|---|---|---|
| `health` | `health` | required |
| `extractFromResume` | `extractfromresume` | required |
| `parseJobRequirements` | `parsejobrequirements` | required |
| `generateResume` | `generateresume` | required |
| `validateAsset` | `validateasset` | required |
| `reembedExperienceUnit` | `reembedexperienceunit` | required |
| `runMatching` | `runmatching` | required |
| `deriveMatchEvidence` | `derivematchevidence` | required |

> **Every NEW callable needs this once.** `firebase deploy` creates the
> Cloud Run service but cannot set the invoker policy, so the deploy
> reports `Failed to set the IAM Policy on the Service ...` and exits
> non-zero *after* the function itself deployed successfully. The
> service then exists and rejects every browser call at the CORS
> preflight. `deriveMatchEvidence` hit exactly this on first deploy
> (#441).
>
> **Nothing enforces this.** The inventory above is maintained by hand
> and no CI check verifies it — see the note under the table. Adding a
> function without adding its row is silent until the deploy fails.

**2. The runtime service account needs Firestore.** Functions run as the compute default SA (`<project-number>-compute@developer.gserviceaccount.com`). Where the org disables automatic grants for default service accounts, that account holds only build-time roles and every admin-SDK call fails with `7 PERMISSION_DENIED: Missing or insufficient permissions` — note the admin SDK bypasses `firestore.rules` but still needs IAM:

```bash
gcloud projects add-iam-policy-binding <proj> \
  --member=serviceAccount:<project-number>-compute@developer.gserviceaccount.com \
  --role=roles/datastore.user --condition=None
```

`roles/datastore.user` is the least-privilege fit: document read/write, no database or index administration.

**3. Composite indexes deploy separately.** `firestore.indexes.json` ships only with `firebase deploy --only firestore:indexes` (or a full deploy). A missing index surfaces at runtime as "no matching composite index found", not at deploy time. Verify with:

```bash
gcloud firestore indexes composite list --project=<proj>
```

### Triage order when a callable fails

Cheapest checks first — this is the order that would have resolved #422 fastest:

1. `curl -X OPTIONS <function-url> -H 'Origin: …' -H 'Access-Control-Request-Method: POST'` — a 403 means invoker config, and the function never ran.
2. An unauthenticated `POST` returning your own `UNAUTHENTICATED` message means Cloud Run is fine and the function is executing.
3. `gcloud logging read '… severity>=ERROR'` — since #426, an exhausted retry budget logs its per-attempt `kinds` for every LLM pipeline: extraction, JD parsing, generation, and the three validation checks (claim extraction, traceability, specificity). All `transport_error` points at credentials or connectivity, and a `status: 401` alongside it names the credential outright; `schema_error` points at the prompt or the response contract, and the logged Zod issue `code`s and `path`s say which field. The log deliberately carries no provider or validator message text — see the redaction note in `functions/src/llm/retryDiagnostics.ts` — so a failure that needs the raw message must be reproduced against the CLI harness rather than read out of Cloud Logging.
4. Compare request latency against the function's `timeoutSeconds`. Failing in seconds is a rejected upstream call; failing at the ceiling is a real timeout.

## Auth Maintenance

**Interactive machines (biometric available):** If day-to-day auth stops working, first make sure the 1Password CLI is signed in and either the project SA key in `op://Firebase/{project-id} — Firebase Deployer SA Key` or the shared ADC at `op://Private/c2v6emkwppjzjjaq2bdqk3wnlm/credential` is readable.

**Headless environments:** Use the project SA key from the Firebase vault as the primary credential source (see CI/CD & Headless Deploy above). The shared ADC requires interactive refresh and is not suitable for unattended use.

If the shared source credential itself needs rotation, refresh it once with `gcloud auth application-default login`, overwrite the `Private/GCP ADC` item with the new `application_default_credentials.json`, and, if desired, align its own quota project with:

```bash
gcloud auth application-default set-quota-project {project-id}
```

If deploy impersonation breaks because IAM bindings or project configuration drifted:

```bash
op-firebase-setup {project-id}
```

### Firebase CLI "Authentication Error: credentials are no longer valid" (daily reauth)

`op-firebase-deploy` (and `scripts/deploy.sh` by extension) occasionally fails
mid-deploy with:

```
Authentication Error: Your credentials are no longer valid. Please run firebase login --reauth
```

The 1Password source-credential chain is still healthy when this fires —
`gcloud auth application-default print-access-token` against the materialized
ADC still mints a valid token. The failure is inside firebase CLI, which
ignores `GOOGLE_APPLICATION_CREDENTIALS` in some hosting-deploy code paths
and falls back to the user-login cache at
`~/.config/configstore/firebase-tools.json`. That cache's access token
expires roughly daily and is not refreshed by the 1Password flow.

**Workaround:** run `firebase login --reauth` once, then re-run the exact
same `scripts/deploy.sh` (or `op-firebase-deploy`) command. It will succeed
on the next attempt. See nathanjohnpayne/mergepath#137 for the open
investigation and the longer-term fix under consideration
(detect stale configstore in `op-firebase-deploy` and print a clear message
instead of the current cryptic "Assertion failed: resolving hosting target"
trailer).

### 1Password ADC item refresh token expired (#137 failure mode B)

A closely-related but distinct failure can fire immediately after the
reauth above. If `scripts/op-preflight.sh` materializes a 1Password ADC
item whose underlying `refresh_token` has been revoked or expired by
Google, `op-firebase-deploy` will refuse the credential with:

```
Error: GOOGLE_APPLICATION_CREDENTIALS points to an unusable credential file: /var/folders/.../op-preflight-adc-*
```

Starting with the #137 fix, `op-preflight.sh` now validates the
materialized ADC against the OAuth2 `/token` endpoint before exporting
`GOOGLE_APPLICATION_CREDENTIALS`. When the credential is stale,
preflight prints an actionable warning and skips the export — downstream
callers (`op-firebase-deploy`, `gcloud` wrappers) then fall back to the
local firebase-login / ADC path that the reauth has just refreshed.

**Fix permanently** by refreshing the 1Password item:

```bash
gcloud auth application-default login
# then copy the freshly-written JSON into the 1Password item:
op document edit 'GCP ADC' --vault=Private \
  ~/.config/gcloud/application_default_credentials.json
# (or `op item edit` if stored as an item field)
```

After that, the next preflight run will materialize a usable credential
and the `GOOGLE_APPLICATION_CREDENTIALS` export resumes normally.
