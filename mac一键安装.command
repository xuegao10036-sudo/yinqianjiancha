#!/bin/bash
# Install / update the preflight panel for Adobe Illustrator (macOS)
# Same panel as the Windows installer bat - unsigned extension, needs CEP debug mode.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/yinqianjiancha"

echo "============================================"
echo "  AI Preflight Panel - Install (macOS)"
echo "============================================"
echo ""
echo "[1/3] Copy files"
echo "      from : $SRC"
echo "      to   : $DEST"
echo ""
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$DEST/"
cp -R "$SRC/css" "$DEST/"
cp -R "$SRC/js" "$DEST/"
cp -R "$SRC/jsx" "$DEST/"
cp "$SRC/index.html" "$DEST/"
if [ -f "$DEST/CSXS/manifest.xml" ] && [ -f "$DEST/js/main.js" ] && [ -f "$DEST/jsx/preflight.jsx" ]; then
  echo "      OK - files copied."
else
  echo "      FAILED - copy step. Check the folder is not inside the downloaded ZIP."
  exit 1
fi

echo ""
echo "[2/3] Enable CEP debug mode (required for unsigned extensions)"
ok=1
for V in 9 10 11 12 13 14 15 16; do
  defaults write "com.adobe.CSXS.$V" PlayerDebugMode 1 || ok=0
done
# flush the preference cache so the change takes effect without a reboot
killall cfprefsd 2>/dev/null || true
if [ "$ok" = 1 ]; then
  echo "      OK - PlayerDebugMode set for CSXS 9 to 16."
else
  echo "      WARN - could not write defaults."
  echo "             FIX: run 'bash \"$(basename "$0")\"' from Terminal and read the error."
fi

echo ""
echo "[3/3] Done."
echo ""
echo "  NEXT : restart Adobe Illustrator"
echo "         Menu: Window > Extensions > the preflight panel"
echo ""
echo "  TIP  : if macOS blocks double-click, run this in Terminal instead:"
echo "         bash \"$(basename "$0")\"  (from this folder)"
echo ""
