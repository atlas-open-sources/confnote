#!/bin/sh
# Validate, build both signed channels, smoke-test, then install locally.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/packages/local-app/.venv/bin/python"
# The installed app may be older than these sources. Check candidates below.
CONFNOTE_TEST_APP="$ROOT/.no-installed-test-candidate" make lint
make e2e
make test-web
NO_INSTALL=1 packages/local-app/build-macos.sh
NO_INSTALL=1 packages/local-app/build-macos.sh dev "${DEV_TAG:-local}"
# Both dist candidates: codesign, Info.plist, first launch and a Playwright UI smoke; installs nothing.
make app-smoke
# Gracefully stop only the exact installed bundles before replacing them.
for NAME in confnote 'confnote dev'; do
  APP="/Applications/$NAME.app"
  /usr/bin/pkill -TERM -f "^$APP/Contents/MacOS/$NAME$" 2>/dev/null || true
  for ATTEMPT in 1 2 3 4 5; do
    /usr/bin/pgrep -f "^$APP/Contents/MacOS/$NAME$" > /dev/null || break
    sleep 1
  done
  if /usr/bin/pgrep -f "^$APP/Contents/MacOS/$NAME$" > /dev/null; then
    printf '%s\n' "App is still running; leaving $APP in place." >&2
    exit 1
  fi
  rm -rf "$APP"
  /usr/bin/ditto "$ROOT/packages/local-app/dist/$NAME.app" "$APP"
  touch "$APP"
  CONFNOTE_TEST_APP="$APP" "$PY" -m pytest -q tests/test_static_serving.py
done
printf '%s\n' 'Installed and HTTP-verified: /Applications/confnote.app and /Applications/confnote dev.app'
