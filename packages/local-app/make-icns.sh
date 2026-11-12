#!/bin/sh
# Rasterize static/<name>.svg -> static/<name>.icns (macOS app icon).
#   make-icns.sh            # icon.svg     -> icon.icns      (prod, green)
#   make-icns.sh icon-dev   # icon-dev.svg -> icon-dev.icns  (dev, amber)
# Uses rsvg-convert if present, else macOS Quick Look (qlmanage). No deps.
#
# SVG sources + .icns outputs both live in core-ui/static (UI assets travel
# with the shared SPA, not with the local-app build scripts).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
STATIC="$DIR/../core-ui/static"
NAME="${1:-icon}"
SVG="$STATIC/$NAME.svg"
OUT="$STATIC/$NAME.icns"
TMP="$(mktemp -d)"
SET="$TMP/icon.iconset"
mkdir -p "$SET"
BASE="$TMP/base.png"

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$BASE"
elif command -v qlmanage >/dev/null 2>&1; then
  qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1 || true
  P="$(ls "$TMP"/*.png 2>/dev/null | head -1 || true)"
  [ -n "$P" ] && mv "$P" "$BASE"
fi
if [ ! -f "$BASE" ]; then
  echo "No SVG rasterizer (try: brew install librsvg). Skipped icon.icns."
  exit 0
fi

# exact filenames iconutil expects
gen() { sips -z "$2" "$2" "$BASE" --out "$SET/$1" >/dev/null; }
gen icon_16x16.png 16;       gen icon_16x16@2x.png 32
gen icon_32x32.png 32;       gen icon_32x32@2x.png 64
gen icon_128x128.png 128;    gen icon_128x128@2x.png 256
gen icon_256x256.png 256;    gen icon_256x256@2x.png 512
gen icon_512x512.png 512;    gen icon_512x512@2x.png 1024
iconutil -c icns "$SET" -o "$OUT"
echo "Wrote $OUT"
