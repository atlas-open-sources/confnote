#!/bin/sh
# Build a double-clickable confnote.app with PyInstaller.
#
#   packages/local-app/build-macos.sh              # PROD → "confnote.app"      (green)
#   packages/local-app/build-macos.sh dev [tag]    # DEV  → "confnote dev.app"  (amber)
#
# Dev and prod have different names + bundle ids + icons, so you can install
# and run BOTH side by side (test prod while iterating on dev). Dev app bundle
# ids include a build tag to force a fresh macOS permission identity.
# Developer ID signed by default so macOS sees the real app identity. Prod and
# pinned dev tags are stable; unpinned dev tags intentionally force fresh TCC.
# Set ALLOW_ADHOC=1 only for local throwaway builds on machines that do not
# have the Developer ID certificate installed.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"
# Shared SPA + icons live in the core-ui package (monorepo sibling).
STATIC="$DIR/../core-ui/static"
REPO="$(cd "$DIR/../.." && pwd)"

if [ "${CONFNOTE_HEADLESS_BUILD:-0}" = "1" ]; then
  CONFNOTE_SIGN_ID=""
  ALLOW_ADHOC=1
  NO_INSTALL=1
  NOTARIZE=""
fi

sanitize_bundle_tag() {
  tag="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  [ -n "$tag" ] || tag="local"
  case "$tag" in
    [a-z]*) ;;
    *) tag="b$tag" ;;
  esac
  printf '%s' "$tag"
}

default_dev_tag() {
  branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'local')"
  sha="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || printf 'nosha')"
  stamp="$(date +%Y%m%d%H%M%S)"
  printf '%s-%s-%s' "$branch" "$sha" "$stamp"
}

if [ "${1-}" = "dev" ]; then
  DEV_TAG_RAW="${CONFNOTE_DEV_TAG-${2-}}"
  [ -n "$DEV_TAG_RAW" ] || DEV_TAG_RAW="$(default_dev_tag)"
  DEV_TAG="$(sanitize_bundle_tag "$DEV_TAG_RAW")"
  NAME="confnote dev"; BID="com.atlas.confnote.dev.$DEV_TAG"; ICONSVG="icon-dev"
else
  NAME="confnote";     BID="com.atlas.confnote";     ICONSVG="icon"
fi

[ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV"; "$VENV/bin/python" -m pip -q install pip==25.3; }
"$VENV/bin/python" -m pip --version >/dev/null 2>&1 || "$VENV/bin/python" -m ensurepip --upgrade
"$VENV/bin/python" -m pip -q install -r "$DIR/requirements.lock"

if [ "${CONFNOTE_HEADLESS_BUILD:-0}" != "1" ]; then
  sh "$DIR/make-icns.sh" "$ICONSVG" || true
fi
ICON=""
[ -f "$STATIC/$ICONSVG.icns" ] && ICON="--icon $STATIC/$ICONSVG.icns"

cd "$DIR"
rm -rf "${DIR:?}/build" "${DIR:?}/dist/$NAME.app" "${DIR:?}/$NAME.spec"

# Stage the static dir into a temp location, EXCLUDING anything that's
# only there for dev (esbuild setup, node_modules, lockfiles). Without
# this, --add-data pulls modules/tldraw/build/node_modules into the .app
# (78MB of npm cruft that the runtime never touches).
STATIC_STAGE="$(mktemp -d -t confnote-static-XXXXXX)"
BACKEND_STAGE="$(mktemp -d -t confnote-backend-XXXXXX)"
trap 'rm -rf "${STATIC_STAGE:?}" "${BACKEND_STAGE:?}"' EXIT
rsync -a \
  --exclude '*/build/' \
  --exclude 'modules/tldraw/' \
  --exclude 'modules/bryntum/' \
  --exclude 'node_modules' \
  --exclude 'package-lock.json' \
  --exclude '.DS_Store' \
  "$STATIC/" "$STATIC_STAGE/"

# A distribution build supplies the reviewed events-data dist once; users need no env var.
if [ -n "${CONFNOTE_CATALOGUE_DIR:-}" ]; then
  mkdir -p "$STATIC_STAGE/catalogue"
  cp -p "$CONFNOTE_CATALOGUE_DIR/index.json" "$STATIC_STAGE/catalogue/index.json"
  # Prefer self-contained dist notices; support the original events-data parent layout.
  catalogue_dir="${CONFNOTE_CATALOGUE_DIR%/}"
  for notice in ATTRIBUTION.md LICENSE confs-tech-LICENSE geonames-sources.json; do
    if [ -f "$catalogue_dir/$notice" ]; then
      cp "$catalogue_dir/$notice" "$STATIC_STAGE/catalogue/$notice"
    elif [ "$(basename "$catalogue_dir")" = dist ] && [ -f "$catalogue_dir/../$notice" ]; then
      cp "$catalogue_dir/../$notice" "$STATIC_STAGE/catalogue/$notice"
    fi
  done
fi

# The default OSS artifact excludes the restricted vendor modules (tldraw, Bryntum), including their
# Python tools. AG Grid Community (modules/aggrid, MIT) ships, as in the OSS export.
"$VENV/bin/python" - "$STATIC_STAGE/modules.config.json" <<'PYCONFIG'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_text())
data["slots"] = [name for name in data.get("slots", []) if name not in {"tldraw", "bryntum"}]
data["_comment"] = "Default OSS modules; restricted vendor modules are excluded."
p.write_text(json.dumps(data, indent=2) + "\n")
PYCONFIG
rsync -a --exclude 'tldraw/' --exclude 'bryntum/' "$DIR/modules/" "$BACKEND_STAGE/"

"$VENV/bin/python" -m PyInstaller --noconfirm --clean --windowed \
  --name "$NAME" \
  --osx-bundle-identifier "$BID" \
  $ICON \
  --add-data "$STATIC_STAGE:static" \
  --add-data "$BACKEND_STAGE:modules" \
  --add-data "$DIR/skills:skills" \
  --add-data "$REPO/tools:tools" \
  --add-data "$REPO/packages/contracts/tools.json:contracts" \
  --add-data "$REPO/LICENSE:." \
  --add-data "$REPO/NOTICE:." \
  --add-data "$REPO/licenses:licenses" \
  --add-data "$REPO/packages/events-model/LICENSE:packages/events-model" \
  --collect-all webview \
  --collect-all claude_agent_sdk \
  --collect-submodules Security \
  --hidden-import Security \
  --hidden-import CoreFoundation \
  --hidden-import chatgpt_auth \
  --hidden-import chatgpt_agent \
  --collect-all jwt \
  --collect-all cryptography \
  desktop.py

APPP="$DIR/dist/$NAME.app"

# Drop the claude-agent-sdk's _bundled/claude fallback binary (~196 MB).
# We don't need it: desktop.py:_harden_path() widens PATH so the user's
# locally-installed `claude` CLI is always found at runtime. If the user
# DOESN'T have claude installed, the chat surface gracefully shows an
# install prompt instead — no bundled fallback required.
# Net: bundle drops from ~250 MB to ~55 MB.
BUNDLED="$APPP/Contents/Frameworks/claude_agent_sdk/_bundled"
[ -d "$BUNDLED" ] && rm -rf "${BUNDLED:?}" && echo "stripped $BUNDLED"
RES_BUNDLED="$APPP/Contents/Resources/claude_agent_sdk/_bundled"
[ -e "$RES_BUNDLED" ] && rm -rf "${RES_BUNDLED:?}"

# Mic usage description — required for in-app audio recording (getUserMedia /
# AVFoundation). Without it macOS silently denies mic access. Must be set
# BEFORE codesign (signing seals Info.plist). Idempotent.
PLIST="$APPP/Contents/Info.plist"
MIC_MSG="confnote records talk audio to transcribe it locally or via your chosen provider."
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MIC_MSG" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $MIC_MSG" "$PLIST"

# Code signing. Sign with a Developer ID so the app has a real code identity.
# Prod keeps a stable bundle id; dev bundle ids vary by tag when we want fresh
# macOS permission prompts. Ad-hoc signatures change every build and make
# Keychain behaviour noisy.
# Override the identity with CONFNOTE_SIGN_ID. Set ALLOW_ADHOC=1 to permit
# fallback ad-hoc signing; this is not suitable for Keychain auth testing.
SIGN_ID="${CONFNOTE_SIGN_ID-Developer ID Application: Atlas Codes LTD (599WAZ6282)}"
ENT="$DIR/entitlements.plist"
if [ -n "$SIGN_ID" ] && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGN_ID"; then
  echo "signing: $SIGN_ID (hardened runtime + entitlements)"
  # A secure timestamp is REQUIRED for notarization but adds a network call
  # per signature (slow). Only request it for release/notarize builds.
  # A Developer ID signature asks Apple's timestamp server by default, so
  # local builds say --timestamp=none: an unreachable server otherwise leaves
  # the bundle half-signed, which runs from the shell but `open` refuses.
  TS="--timestamp=none"
  [ -n "$NOTARIZE" ] && TS="--timestamp"
  if ! codesign --force --deep --options runtime $TS --entitlements "$ENT" --sign "$SIGN_ID" "$APPP"; then
    echo "codesign failed: $APPP is not validly signed" >&2
    exit 1
  fi
  if ! codesign --verify --deep --strict --verbose=1 "$APPP"; then
    echo "codesign --verify failed: $APPP would not launch via open" >&2
    exit 1
  fi
else
  if [ -z "$ALLOW_ADHOC" ]; then
    echo "Developer ID signing identity not available: '$SIGN_ID'" >&2
    echo "Refusing to build an ad-hoc app because auth and permission behaviour would not be representative." >&2
    echo "Install the Developer ID cert or rerun with ALLOW_ADHOC=1 for a throwaway local build." >&2
    exit 1
  fi
  if [ -n "$NOTARIZE" ]; then
    echo "notarization requires a Developer ID signing identity; missing '$SIGN_ID'" >&2
    exit 1
  fi
  echo "signing: ad-hoc (no '$SIGN_ID' identity found) — Keychain will re-prompt per build"
  codesign --force --deep --sign - "$APPP" 2>/dev/null || true
fi

# Notarization (opt-in: NOTARIZE=1) — required for OTHER Macs to open the app
# without a Gatekeeper block. One-time credential setup (stores an
# app-specific password in your login keychain, NOT in this repo):
#   xcrun notarytool store-credentials confnote-notary \
#     --apple-id <you@example.com> --team-id 599WAZ6282 --password <app-specific-pw>
# Preferred: ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID (the team API key; make app-publish loads
# them from ~/.config/confnote/release.env). Or APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD
# (the same shape used by GitHub Actions release workflows).
if [ -n "$NOTARIZE" ]; then
  PROFILE="${CONFNOTE_NOTARY_PROFILE:-confnote-notary}"
  ZIP="$DIR/dist/$NAME-notarize.zip"
  if [ -n "$ASC_KEY_PATH" ] && [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ]; then
    echo "notarizing via the App Store Connect API key (this can take a few minutes)…"
    NOTARY_MODE="asc"
  elif [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
    echo "notarizing via APPLE_ID/APPLE_TEAM_ID/APPLE_APP_PASSWORD (this can take a few minutes)…"
    NOTARY_MODE="env"
  else
    echo "notarizing via profile '$PROFILE' (this can take a few minutes)…"
    NOTARY_MODE="profile"
  fi
  ditto -c -k --keepParent "$APPP" "$ZIP"
  set +e
  if [ "$NOTARY_MODE" = "asc" ]; then
    xcrun notarytool submit "$ZIP" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" \
      --issuer "$ASC_ISSUER_ID" --wait
    NOTARY_RC=$?
  elif [ "$NOTARY_MODE" = "env" ]; then
    xcrun notarytool submit "$ZIP" \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_PASSWORD" \
      --wait
    NOTARY_RC=$?
  else
    xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
    NOTARY_RC=$?
  fi
  set -e
  if [ "$NOTARY_RC" -eq 0 ]; then
    xcrun stapler staple "$APPP" && echo "notarized + stapled ✓"
  else
    echo "notarization FAILED — inspect with:"
    if [ "$NOTARY_MODE" = "env" ]; then
      echo "  xcrun notarytool history --apple-id <redacted> --team-id $APPLE_TEAM_ID --password <app-specific-pw>"
      echo "  xcrun notarytool log <submission-id> --apple-id <redacted> --team-id $APPLE_TEAM_ID --password <app-specific-pw>"
    else
      echo "  xcrun notarytool history --keychain-profile $PROFILE"
      echo "  xcrun notarytool log <submission-id> --keychain-profile $PROFILE"
    fi
    rm -f "${ZIP:?}"
    exit 1
  fi
  rm -f "${ZIP:?}"
fi

# Install into /Applications so the new build is what Launchpad / Spotlight /
# the menu-bar app-switcher pick up. Pass NO_INSTALL=1 to skip (e.g. if you
# want to keep an older copy alongside for testing).
INSTALLED="/Applications/$NAME.app"
if [ -z "$NO_INSTALL" ]; then
  # Kill any running instance of THIS app so the bundle isn't locked.
  # `pkill -f "$NAME"` would also kill the other variant; match the .app path.
  pkill -9 -f "$INSTALLED" 2>/dev/null || true
  # `ditto` preserves bundle metadata better than `cp -R` on macOS.
  rm -rf "${INSTALLED:?}"
  ditto "$APPP" "$INSTALLED"
  # Nudge the Finder/Dock icon cache so the new icon picks up immediately.
  touch "$INSTALLED"
  echo "installed → $INSTALLED"
fi
cat <<EOF

Built: $APPP
Bundle ID: $BID

Run it pointing at your notes folder:
  CONF_NOTES_DIR="\$HOME/Documents/mochi/conferences" \\
    "$APPP/Contents/MacOS/$NAME"

Notes:
 • DEV (amber icon) and PROD (green icon) are separate apps — build both:
     packages/local-app/build-macos.sh        # prod
     packages/local-app/build-macos.sh dev    # dev
   Dev defaults to a fresh bundle id per build:
     com.atlas.confnote.dev.<tag>
   Pin it with CONFNOTE_DEV_TAG=<tag> when you want to reuse a permission set.
   The Makefile in-place target uses DEV_TAG=local by default.
 • Local installs are Developer ID signed so macOS sees the real app identity.
   Prod stays stable; unpinned dev intentionally gets fresh permissions.
   ALLOW_ADHOC=1 is only for throwaway local builds.
 • Bundled .app still shells the local 'claude' CLI for chat/research;
   desktop.py widens PATH so a Finder-launched bundle still finds it.
 • Distributing to OTHER Macs = Developer ID + notarization:
     xcrun notarytool store-credentials confnote-notary \\
       --apple-id <you@example.com> --team-id 599WAZ6282 --password <app-specific-pw>
     NOTARIZE=1 packages/local-app/build-macos.sh
   Or use CI-style env vars:
     APPLE_ID=... APPLE_TEAM_ID=599WAZ6282 APPLE_APP_PASSWORD=... \\
       NOTARIZE=1 packages/local-app/build-macos.sh
 • Next refinement: first-run folder picker instead of CONF_NOTES_DIR.
EOF
