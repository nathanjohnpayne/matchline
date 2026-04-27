#!/usr/bin/env bash
# scripts/hooks/__tests__/gh-pr-guard.test.sh
#
# Black-box tests for scripts/hooks/gh-pr-guard.sh. Specifically
# covers the mergeStateStatus check added per #171 layer 2 — one
# fixture-driven case per `mergeStateStatus` enum value (CLEAN,
# HAS_HOOKS, UNKNOWN, BLOCKED, DIRTY, UNSTABLE, BEHIND), plus
# the BREAK_GLASS_MERGE_STATE override and the
# unrecognized-state fail-closed branch.
#
# Strategy: feed the hook a `tool_input.command` JSON via stdin,
# put a fake `gh` shim on PATH that emits a fixture-controlled
# response, observe exit code + (optionally) stderr substrings.
# This is black-box: the hook's internal token walk is exercised
# end-to-end by the same code path the real PreToolUse caller
# would hit, with the network call stubbed.
#
# Why a bash test and not vitest: the hook itself is bash, and
# its exit-code contract IS the contract Claude Code's hook
# protocol consumes. A TS test would have to shell out to bash
# anyway; cutting out the indirection keeps the test surface
# the same shape as the production caller.
#
# Run manually:   ./scripts/hooks/__tests__/gh-pr-guard.test.sh
# Run from CI:    ./scripts/ci/check_hook_tests

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOK_DIR/gh-pr-guard.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- gh shim ---
#
# Emits the fixture string set in $GH_FIXTURE_RESPONSE and exits
# 0. The fixture is the post-`--jq` output the hook expects, in
# the form `MERGE_STATE|LABELS` — the shim does not actually
# evaluate `--json` or `--jq`. This is OK because the hook only
# ever calls `gh pr view` with one specific shape, and the test
# is black-box: we control the inputs and only care that the
# hook responds correctly to the expected output format.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'SHIM'
#!/usr/bin/env bash
# Test shim for gh — see scripts/hooks/__tests__/gh-pr-guard.test.sh.
if [[ "${GH_FIXTURE_FAIL:-0}" = "1" ]]; then
  echo "${GH_FIXTURE_RESPONSE:-fake gh error}" >&2
  exit 1
fi
# Optional stderr noise (Codex P1 on PR #174 r2): real `gh` can
# emit non-fatal notices on stderr — update available, telemetry
# opt-in prompts, deprecation warnings — even on a successful
# command. The hook MUST isolate stdout when parsing
# MERGE_STATE|LABELS or the noise will corrupt the parse.
if [[ -n "${GH_FIXTURE_STDERR:-}" ]]; then
  printf '%s\n' "$GH_FIXTURE_STDERR" >&2
fi
printf '%s' "${GH_FIXTURE_RESPONSE:-CLEAN|}"
SHIM
chmod +x "$TMP/bin/gh"

PASS=0
FAIL=0
FAILURES=""

# Run a single fixture-driven case.
#
# Args:
#   $1  test name
#   $2  expected exit code
#   $3  GH_FIXTURE_RESPONSE (post-jq form: MERGE_STATE|LABELS)
#   $4  command string to feed via stdin
#   $5  optional `KEY=VALUE` env prefix passed to env(1)
#   $6  optional stderr substring that MUST appear (empty = no check)
run_case() {
  local name="$1"
  local expected_exit="$2"
  local fixture="$3"
  local cmd="$4"
  local env_prefix="${5:-}"
  local expect_stderr="${6:-}"

  local input
  input=$(printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

  local out
  local actual_exit
  set +e
  if [ -n "$env_prefix" ]; then
    # shellcheck disable=SC2086
    out=$(PATH="$TMP/bin:$PATH" GH_FIXTURE_RESPONSE="$fixture" \
      env $env_prefix bash "$HOOK" <<< "$input" 2>&1)
  else
    out=$(PATH="$TMP/bin:$PATH" GH_FIXTURE_RESPONSE="$fixture" \
      bash "$HOOK" <<< "$input" 2>&1)
  fi
  actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "FAIL: $name"
    echo "  expected exit $expected_exit, got $actual_exit"
    echo "  output:"
    echo "$out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}${name}\n"
    return
  fi
  if [ -n "$expect_stderr" ] && ! echo "$out" | grep -qF "$expect_stderr"; then
    echo "FAIL: $name (exit code OK but expected stderr substring missing)"
    echo "  expected substring: $expect_stderr"
    echo "  output:"
    echo "$out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}${name}\n"
    return
  fi
  echo "PASS: $name"
  PASS=$((PASS + 1))
}

# --- mergeStateStatus = allow states ---

run_case "CLEAN allows merge" \
  0 "CLEAN|" "gh pr merge 123 --squash --delete-branch"

run_case "HAS_HOOKS allows merge" \
  0 "HAS_HOOKS|" "gh pr merge 123 --squash --delete-branch"

# UNKNOWN is allowed because it's typically a transient API state
# right after a push — blocking it would generate false positives
# during normal flow. See gh-pr-guard.sh comment block for full
# rationale.
run_case "UNKNOWN allows merge (transient API state)" \
  0 "UNKNOWN|" "gh pr merge 123 --squash --delete-branch"

# --- mergeStateStatus = block states ---

run_case "BLOCKED denies merge (default)" \
  2 "BLOCKED|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is BLOCKED"

run_case "DIRTY denies merge (default)" \
  2 "DIRTY|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is DIRTY"

run_case "UNSTABLE denies merge (default)" \
  2 "UNSTABLE|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is UNSTABLE"

run_case "BEHIND denies merge (default)" \
  2 "BEHIND|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is BEHIND"

# DRAFT has its own diagnostic (Codex P3 on PR #174 r2): blocking
# is correct but the message points at "mark draft as ready"
# rather than the generic "update the case statement" hint, since
# DRAFT is a known state, not a future-API surprise.
run_case "DRAFT denies merge with draft-specific diagnostic" \
  2 "DRAFT|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR is a draft (mergeStateStatus=DRAFT)."

run_case "DRAFT allowed under BREAK_GLASS_MERGE_STATE" \
  0 "DRAFT|" "gh pr merge 123 --squash --delete-branch" \
  "BREAK_GLASS_MERGE_STATE=1" \
  "BREAK-GLASS: merge of draft PR authorized by human."

# --- BREAK_GLASS_MERGE_STATE override ---

run_case "BREAK_GLASS_MERGE_STATE=1 allows BLOCKED via env(1) prefix" \
  0 "BLOCKED|" "gh pr merge 123 --squash --delete-branch" \
  "BREAK_GLASS_MERGE_STATE=1" \
  "BREAK-GLASS: merge with mergeStateStatus=BLOCKED authorized by human."

run_case "BREAK_GLASS_MERGE_STATE=1 inline prefix allows DIRTY" \
  0 "DIRTY|" "BREAK_GLASS_MERGE_STATE=1 gh pr merge 123 --squash --delete-branch" \
  "" \
  "BREAK-GLASS: merge with mergeStateStatus=DIRTY authorized by human."

# --- unknown / future API state fails closed ---

run_case "Unrecognized future state fails closed" \
  2 "FUTURE_STATE_X|" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus=FUTURE_STATE_X is not recognized"

run_case "Unrecognized state allowed under BREAK_GLASS" \
  0 "FUTURE_STATE_X|" "gh pr merge 123 --squash --delete-branch" \
  "BREAK_GLASS_MERGE_STATE=1" \
  "BREAK-GLASS: merge with unrecognized mergeStateStatus=FUTURE_STATE_X"

# --- existing label-gate behavior must still work ---

# CLEAN + needs-external-review without CODEX_CLEARED → block.
# (The mergeStateStatus check passes; the label check then
# refuses.)
run_case "CLEAN but needs-external-review without CODEX_CLEARED denies" \
  2 "CLEAN|needs-external-review" "gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR carries 'needs-external-review' and CODEX_CLEARED is not set."

run_case "CLEAN + needs-external-review + CODEX_CLEARED=1 allows" \
  0 "CLEAN|needs-external-review" "CODEX_CLEARED=1 gh pr merge 123 --squash --delete-branch"

# --- ordering: mergeStateStatus check runs BEFORE the label gate ---
#
# A PR with both BLOCKED state AND needs-external-review must
# fail with the mergeStateStatus message, not the label one,
# even when CODEX_CLEARED=1 is set. The merge-state guard is
# the more fundamental gate.
run_case "BLOCKED + label + CODEX_CLEARED denies on mergeStateStatus first" \
  2 "BLOCKED|needs-external-review" "CODEX_CLEARED=1 gh pr merge 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is BLOCKED"

# --- create gate is unaffected by the new check ---

run_case "create with required body sections still passes" \
  0 "anything-here-because-create-skips-gh" \
  'gh pr create --title T --body "Authoring-Agent: claude

## Self-Review

LGTM"'

run_case "create without Authoring-Agent still blocks" \
  2 "anything" \
  'gh pr create --title T --body "## Self-Review

ok"' \
  "" "Missing 'Authoring-Agent:' in PR body"

# --- --admin gate composes correctly with merge-state gate ---
#
# Per CodeRabbit on PR #174 r1: the `--admin` guard used to run
# BEFORE the mergeStateStatus check, meaning a BREAK_GLASS_ADMIN
# break-glass exited the hook before the new merge-state guard
# fired. The hook now evaluates merge-state FIRST, then admin —
# so an emergency `--admin` merge against a BLOCKED PR requires
# both BREAK_GLASS_MERGE_STATE=1 AND BREAK_GLASS_ADMIN=1. Each
# break-glass authorizes one specific gate; bypassing both
# requires acknowledging both risks.

run_case "--admin without break-glass still blocks (CLEAN)" \
  2 "CLEAN|" "gh pr merge --admin 123 --squash --delete-branch" \
  "" "BLOCKED: --admin merge requires explicit human authorization."

run_case "--admin with break-glass allows (CLEAN)" \
  0 "CLEAN|" "BREAK_GLASS_ADMIN=1 gh pr merge --admin 123 --squash --delete-branch"

# This is the case the original test suite missed — proves the
# merge-state gate runs even when the admin override is set.
run_case "--admin + BREAK_GLASS_ADMIN still blocks BLOCKED merge state" \
  2 "BLOCKED|" "BREAK_GLASS_ADMIN=1 gh pr merge --admin 123 --squash --delete-branch" \
  "" "BLOCKED: PR mergeStateStatus is BLOCKED"

run_case "--admin + both break-glass overrides allows BLOCKED" \
  0 "BLOCKED|" "BREAK_GLASS_ADMIN=1 BREAK_GLASS_MERGE_STATE=1 gh pr merge --admin 123 --squash --delete-branch" \
  "" "BREAK-GLASS: merge with mergeStateStatus=BLOCKED authorized by human."

run_case "--admin + only merge-state break-glass still blocks (admin gate)" \
  2 "BLOCKED|" "BREAK_GLASS_MERGE_STATE=1 gh pr merge --admin 123 --squash --delete-branch" \
  "" "BLOCKED: --admin merge requires explicit human authorization."

# --- gh stderr noise must not corrupt MERGE_STATE parsing ---
#
# Codex P1 on PR #174 r2: the prior parser ran `gh ... 2>&1`,
# which would prepend any stderr noise (update notifier, etc.)
# to the stdout payload and corrupt MERGE_STATE — turning a
# CLEAN PR into the unrecognized-state block path. These cases
# pin the regression: even with realistic stderr noise, MERGE_STATE
# must be parsed cleanly from stdout.
run_case_with_stderr() {
  local name="$1"
  local expected_exit="$2"
  local fixture="$3"
  local stderr_noise="$4"
  local cmd="$5"

  local input
  input=$(printf '{"tool_input":{"command":%s}}' \
    "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

  local out
  local actual_exit
  set +e
  out=$(PATH="$TMP/bin:$PATH" \
    GH_FIXTURE_RESPONSE="$fixture" \
    GH_FIXTURE_STDERR="$stderr_noise" \
    bash "$HOOK" <<< "$input" 2>&1)
  actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "FAIL: $name"
    echo "  expected exit $expected_exit, got $actual_exit"
    echo "  output:"
    echo "$out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}${name}\n"
    return
  fi
  echo "PASS: $name"
  PASS=$((PASS + 1))
}

run_case_with_stderr "CLEAN with gh update-notifier on stderr still allows" \
  0 "CLEAN|" \
  'gh: A new release of gh is available: 2.42.1 → 2.43.0' \
  "gh pr merge 123 --squash --delete-branch"

run_case_with_stderr "BLOCKED with stderr noise still blocks (no false-allow)" \
  2 "BLOCKED|" \
  'gh: telemetry hint' \
  "gh pr merge 123 --squash --delete-branch"

run_case_with_stderr "needs-external-review label survives stderr noise" \
  2 "CLEAN|needs-external-review" \
  'gh: deprecation warning' \
  "gh pr merge 123 --squash --delete-branch"

# --- summary ---

echo ""
echo "──────────────────────────────────"
echo "  passed: $PASS"
echo "  failed: $FAIL"
echo "──────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  # CodeRabbit on PR #174 (SC2059): a `%` in a future test
  # name would otherwise be interpreted as a printf format
  # specifier and corrupt the failure summary. Pass FAILURES
  # as data via `%b` (which preserves the embedded `\n`
  # escapes already in the buffer).
  printf '%b' "$FAILURES"
  exit 1
fi
exit 0
