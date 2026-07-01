#!/bin/bash
# Preview the Scriptable widget layout without an iOS device.
#   ./render.sh out.png "ch=78&r=30"      # override params (see preview.html)
# Requires a Chromium binary (set CHROME, or it tries common locations).
# The window is deliberately large so the full rounded card + corners render;
# a too-small window silently clips the card bottom (which once fooled us).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-widget.png}"
PARAMS="${2:-}"
CHROME="${CHROME:-/opt/pw-browsers/chromium}"
[ -x "$CHROME" ] || CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
[ -x "$CHROME" ] || { echo "No Chromium found; set CHROME=/path/to/chromium"; exit 1; }
"$CHROME" --headless=new --no-sandbox --hide-scrollbars --force-device-scale-factor=3 \
  --virtual-time-budget=3000 --run-all-compositor-stages-before-draw \
  --screenshot="$OUT" --window-size=460,420 \
  "file://$DIR/preview.html?$PARAMS" >/dev/null 2>&1
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
