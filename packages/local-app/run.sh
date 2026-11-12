#!/bin/sh
# Run the notes app WITH the chat bubble (bootstraps a local venv + the
# Claude Agent SDK; uses your existing `claude` login — no API key).
#
# Plain `python3 packages/local-app/server.py` still works, just without chat.
#
#   packages/local-app/run.sh            → server + opens your browser
#   packages/local-app/run.sh desktop    → native window (pywebview)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"
# The localhost dev loop is the "dev" channel — its vault selection + recents
# persist separately from the packaged prod app's. CONF_NOTES_DIR still wins.
export CONFNOTE_CHANNEL="${CONFNOTE_CHANNEL:-dev}"
if [ ! -x "$VENV/bin/python" ]; then
  echo "• creating venv…"
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip -q install pip==25.3
fi
"$VENV/bin/python" -m pip --version >/dev/null 2>&1 || "$VENV/bin/python" -m ensurepip --upgrade
"$VENV/bin/python" -m pip -q install -r "$DIR/requirements-ci.txt"
if [ "${1-}" = "desktop" ]; then
  shift
  "$VENV/bin/python" -m pip -q install -r "$DIR/requirements.lock"
  exec "$VENV/bin/python" "$DIR/desktop.py" "$@"
fi
exec "$VENV/bin/python" "$DIR/server.py" "$@"
