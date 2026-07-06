#!/usr/bin/env bash
# scripts/firebase/with-java.sh — locate a Java runtime for the
# Firestore emulator and `exec` the wrapped command with
# `JAVA_HOME` + `PATH` set.
#
# The Firebase Firestore emulator needs Java. macOS ships with
# `/usr/bin/java` as a stub that prompts the user to install
# Java; Homebrew's `openjdk` formulae aren't auto-symlinked into
# the system Java home, so `firebase emulators:exec` fails with:
#
#   "Process `java -version` has exited with code 1. Please make
#    sure Java is installed and on your system PATH."
#
# This wrapper checks several common install paths in order:
#
#   1. $JAVA_HOME if already set + functional.
#   2. Homebrew's `openjdk@21` (the Firebase emulator's pinned
#      target as of 2026).
#   3. Homebrew's unversioned `openjdk` (latest LTS).
#   4. `java` on PATH (Linux apt-installed openjdk-jre, manual
#      installs, sdkman managed JVMs, etc.). cursor caught the
#      original wrapper's gap on PR #125 — without this step,
#      Linux/system-package setups that previously had `java`
#      working on PATH but no `JAVA_HOME` exported would
#      regress to "no working Java runtime found."
#   5. `/usr/libexec/java_home` (macOS-shipped JVMs, if any —
#      last resort because the macOS stub at /usr/bin/java is
#      a prompt-to-install shim that exits 1, which our PATH
#      step at #4 would correctly skip via `is_working_java`).
#
# If none work, fail loudly with install instructions rather
# than letting `firebase emulators:exec` produce its less-clear
# error. Usage:
#
#   scripts/firebase/with-java.sh firebase emulators:exec \
#     --only firestore "vitest run tests/foo.integration.test.ts"
#
# This sits in `scripts/firebase/` next to `op-firebase-deploy`
# and `op-firebase-setup` because it's part of the Firebase
# tooling surface, not part of CI proper. Cross-platform note:
# on Linux CI runners (`ubuntu-latest`), `setup-java` is the
# preferred path; this wrapper's fallbacks would still find a
# system JVM if installed, but the right thing on CI is to
# pin a setup-java step.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

is_working_java() {
  local jhome="${1:-}"
  [[ -n "$jhome" && -x "$jhome/bin/java" ]] || return 1
  "$jhome/bin/java" -version >/dev/null 2>&1
}

resolve_java_home() {
  # 1. Already set + functional.
  if is_working_java "${JAVA_HOME:-}"; then
    echo "$JAVA_HOME"
    return 0
  fi

  # 2 + 3. Homebrew openjdk. Prefer pinned major version 21
  # (Firebase emulator's target as of 2026-04). Fall back to
  # the unversioned formula. Skipped silently if `brew` isn't
  # on PATH (Linux runners, dev containers without homebrew).
  if command -v brew >/dev/null 2>&1; then
    local brew_prefix
    for formula in openjdk@21 openjdk; do
      if brew_prefix=$(brew --prefix "$formula" 2>/dev/null) && is_working_java "$brew_prefix"; then
        echo "$brew_prefix"
        return 0
      fi
    done
  fi

  # 4. `java` on PATH. Catches Linux apt-installed openjdk-jre
  # and other system-package setups where `java` works but
  # `JAVA_HOME` isn't exported. Derive the JDK root by
  # resolving the symlink chain back to the real install dir;
  # the parent of the resolved binary's `bin/` is JAVA_HOME.
  # The macOS `/usr/bin/java` stub exits non-zero on
  # `-version`, so `is_working_java` correctly skips it here.
  # cursor CHANGES_REQUESTED round 1 on PR #125.
  if command -v java >/dev/null 2>&1; then
    local java_bin resolved_java_bin path_jhome
    java_bin=$(command -v java)
    # `readlink -f` follows symlinks recursively; available on
    # GNU coreutils (Linux) and macOS 12.3+. For older macOS
    # without -f, ask the JVM itself for its home directory
    # rather than deriving a bogus root from the unresolved
    # binary path (e.g. `/usr/bin/java` → `/usr`).
    if resolved_java_bin=$(readlink -f "$java_bin" 2>/dev/null); then
      # resolved_java_bin now points at the real `java` binary.
      # JAVA_HOME is two levels up (from `<jdk>/bin/java` →
      # `<jdk>`).
      path_jhome=$(dirname "$(dirname "$resolved_java_bin")")
    else
      # Under `set -euo pipefail` a broken `java` shim (non-zero
      # exit) would abort the whole script here, skipping the
      # remaining fallbacks. Make the probe non-fatal so a failed
      # self-report just leaves `path_jhome` empty and falls
      # through to `/usr/libexec/java_home` / the curated error.
      path_jhome=$("$java_bin" -XshowSettings:properties -version 2>&1 \
        | awk -F'= ' '/^[[:space:]]*java.home = /{print $2; exit}') || true
    fi
    if [[ -n "${path_jhome:-}" ]] && is_working_java "$path_jhome"; then
      echo "$path_jhome"
      return 0
    fi
  fi

  # 5. macOS-shipped JVM, if installed. Last resort because the
  # default /usr/bin/java is a stub.
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    local sysjava
    if sysjava=$(/usr/libexec/java_home 2>/dev/null) && is_working_java "$sysjava"; then
      echo "$sysjava"
      return 0
    fi
  fi

  return 1
}

if java_home=$(resolve_java_home); then
  export JAVA_HOME="$java_home"
  export PATH="$JAVA_HOME/bin:$PATH"
  exec "$@"
else
  cat >&2 <<'EOF'
ERROR: no working Java runtime found for the Firestore emulator.

The Firebase Firestore emulator requires Java.

macOS:

  brew install openjdk@21

  After install, verify:

    brew --prefix openjdk@21
    $(brew --prefix openjdk@21)/bin/java -version

  You do NOT need to symlink it into /Library/Java/JavaVirtualMachines/
  — this wrapper picks it up from Homebrew's prefix automatically.

Linux (Debian/Ubuntu):

  sudo apt-get install -y openjdk-21-jre-headless

  After install, verify:

    java -version

  This wrapper auto-discovers `java` on PATH and derives
  JAVA_HOME from the binary's resolved location.

If you've installed openjdk a different way, point JAVA_HOME at
the install root before re-running:

  export JAVA_HOME=/path/to/jdk
  npm run test:rules
EOF
  exit 1
fi
