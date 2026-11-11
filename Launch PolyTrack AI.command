#!/bin/zsh
# 1-Click Launcher for PolyPilot AI in Brave Browser
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
BRAVE_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
PROFILE_DIR="$HOME/.polypilot-brave-profile"

printf "%s" "$EXT_DIR" | pbcopy

echo "========================================================"
echo "  PolyPilot AI — PolyTrack Neural Driver for Brave"
echo "========================================================"
echo "Extension folder copied to clipboard:"
echo "  $EXT_DIR"
echo ""

if [ ! -x "$BRAVE_BIN" ]; then
  echo "Error: Brave Browser not found at /Applications/Brave Browser.app"
  exit 1
fi

echo "Launching dedicated Brave racing window with PolyPilot AI pre-loaded..."
mkdir -p "$PROFILE_DIR"
"$BRAVE_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --disable-extensions-except="$EXT_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.kodub.com/apps/polytrack" >/dev/null 2>&1 &

echo "Done! PolyTrack is opening in Brave with the PolyPilot AI HUD in the top-right corner."
echo "(Tip: To also install into your main Brave profile permanently, open brave://extensions,"
echo " enable Developer mode, click 'Load unpacked', and paste Cmd+V: $EXT_DIR)"
