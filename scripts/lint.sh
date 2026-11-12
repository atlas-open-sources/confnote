#!/usr/bin/env bash
# Lint / format entrypoint for confnote.
#
# Usage:
#   scripts/lint.sh check   # report only, non-zero exit on problems (default)
#   scripts/lint.sh fix     # auto-fix in place
#
# Resolves paths relative to the repo root so it works from any cwd.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PY="${PYTHON:-$REPO_ROOT/packages/local-app/.venv/bin/python}"
MODE="${1:-check}"

have_node() { command -v npx >/dev/null 2>&1 && command -v node >/dev/null 2>&1; }

run_check() {
  echo "==> ruff check"
  "$PY" -m ruff check .

  echo "==> ruff format --check"
  "$PY" -m ruff format --check .

  if have_node; then
    echo "==> biome check (js/css)"
    npx --yes @biomejs/biome@2.4.15 check
  else
    echo "==> biome check SKIPPED (node/npx not found)"
  fi

  echo "==> pytest"
  set +e
  "$PY" -m pytest -q tests/
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    # Exit code 5 = no tests collected; tolerate an empty suite.
    [ "$rc" -eq 5 ] || exit "$rc"
    echo "    (no tests collected — treated as pass)"
  fi
}

run_fix() {
  echo "==> ruff check --fix"
  "$PY" -m ruff check --fix .

  echo "==> ruff format"
  "$PY" -m ruff format .

  if have_node; then
    echo "==> biome format --write (js/css)"
    npx --yes @biomejs/biome@2.4.15 format --write
  else
    echo "==> biome format SKIPPED (node/npx not found)"
  fi
}

case "$MODE" in
  check) run_check ;;
  fix)   run_fix ;;
  *) echo "unknown mode: $MODE (use 'check' or 'fix')" >&2; exit 2 ;;
esac
