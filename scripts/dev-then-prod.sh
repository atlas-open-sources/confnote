#!/bin/sh
# Validate, install dev, wait for UI acceptance, then install prod.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/packages/local-app/.venv/bin/python"

printf '%s\n' 'Save your work in both apps before delivery; their installers restart them.'
CONFNOTE_TEST_APP="$ROOT/.no-installed-test-candidate" make lint
make e2e
make test-web

make app-dev "DEV_TAG=${DEV_TAG:-local}"
CONFNOTE_TEST_APP='/Applications/confnote dev.app' \
  "$PY" -m pytest -q tests/test_static_serving.py
open '/Applications/confnote dev.app'
printf '%s\n' \
  'Dev installed and HTTP-verified. Check the native UI before proceeding.' \
  'For schedule changes: test +30, 0, +30, 0; verify times and preserved notes.' \
  'Save any new work. Type prod to build/install production, or anything else to stop:'
if ! IFS= read -r answer || [ "$answer" != 'prod' ]; then
  printf '%s\n' 'Stopped after dev; production was not built or installed.'
  exit 0
fi

make app-prod
CONFNOTE_TEST_APP='/Applications/confnote.app' \
  "$PY" -m pytest -q tests/test_static_serving.py
open '/Applications/confnote.app'
printf '%s\n' \
  'Dev and prod installed and HTTP-verified. Verify the production native UI.' \
  'No conference schedule was changed by this script.'
