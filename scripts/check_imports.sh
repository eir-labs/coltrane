#!/usr/bin/env bash
# check_imports.sh
#
# Import hygiene pre-commit hook. Runs the project's allowlist eslint config
# against staged source files. Non-zero exit = at least one violation.
#
# Wiring (opt-in; not auto-installed):
#   - copy to .git/hooks/pre-commit, OR
#   - reference from .husky/pre-commit if husky is adopted.
# See docs/CONTAINMENT.md.
#
# Modes:
#   default       — scan files staged in git index (pre-commit use).
#   stdin-piped   — read newline-separated paths from stdin (CI use).
#
# Optional overlay:
#   scripts/.private/extra_patterns.list — newline-separated grep -E patterns.
#   If present, each pattern is grep-scanned across the same file set, in
#   addition to the eslint pass. The file is gitignored; absence is normal.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONFIG="${REPO_ROOT}/eslint.config.js"

if [ ! -f "$CONFIG" ]; then
  echo "error: ${CONFIG} not found" >&2
  exit 2
fi

# ----- file list -----
FILES=()
if [ ! -t 0 ]; then
  # stdin piped — read paths
  while IFS= read -r line; do
    [ -n "$line" ] && FILES+=("$line")
  done
else
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: not inside a git work tree; pass file list on stdin instead" >&2
    exit 2
  fi
  while IFS= read -r line; do
    [ -n "$line" ] && FILES+=("$line")
  done < <(git diff --cached --name-only --diff-filter=ACMR)
fi

# ----- filter to JS/TS source files that still exist -----
SCAN=()
for f in "${FILES[@]:-}"; do
  [ -e "$f" ] || continue
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) SCAN+=("$f") ;;
  esac
done

if [ "${#SCAN[@]}" -eq 0 ]; then
  exit 0
fi

# ----- eslint pass -----
if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx not found in PATH; install Node.js to run the hook" >&2
  exit 2
fi

# Run eslint in isolated config mode so we are not affected by any other
# .eslintrc in scope. Plugins/parsers used by the project root config (if any)
# are intentionally ignored — this hook is allowlist-only.
ESLINT_OUT="$(mktemp)"
trap 'rm -f "$ESLINT_OUT"' EXIT

set +e
npx --no-install eslint \
  --config "$CONFIG" \
  --no-error-on-unmatched-pattern \
  "${SCAN[@]}" \
  >"$ESLINT_OUT" 2>&1
ESLINT_RC=$?
set -e

# ----- optional private overlay -----
OVERLAY="${REPO_ROOT}/scripts/.private/extra_patterns.list"
OVERLAY_RC=0
if [ -f "$OVERLAY" ]; then
  while IFS= read -r pattern; do
    # skip blank lines + comments
    [ -z "$pattern" ] && continue
    case "$pattern" in \#*) continue ;; esac
    if grep -nE "$pattern" "${SCAN[@]}" >/dev/null 2>&1; then
      echo "import-hygiene: overlay pattern matched: $pattern" >&2
      OVERLAY_RC=1
    fi
  done < "$OVERLAY"
fi

if [ $ESLINT_RC -ne 0 ]; then
  cat "$ESLINT_OUT" >&2
fi

if [ $ESLINT_RC -ne 0 ] || [ $OVERLAY_RC -ne 0 ]; then
  exit 1
fi

exit 0
