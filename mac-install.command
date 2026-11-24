#!/bin/bash
# Install / update the preflight panel for Adobe Illustrator (macOS)
# Same panel as the Windows installer bat - unsigned extension, needs CEP debug mode.
set -u

# --- self-heal the two things a GitHub ZIP download breaks (v11.81b) ---------
# 1) GitHub's ZIP archive stores every entry as os=DOS with external attr 0, i.e.
#    it carries NO POSIX mode. Whatever mode the git tree has, the extracted file
#    lands as 644, so Finder double-click fails with
#    "cannot be executed because you do not have the correct access permissions".
#    The FIRST run therefore has to go through Terminal ("bash mac-install.command").
#    Fix our own mode here so that every later double-click just works.
# 2) A file extracted from a downloaded ZIP also inherits com.apple.quarantine,
#    which makes Gatekeeper block the next run. Clear it on ourselves.
# Both are best-effort: a read-only volume must not abort the install.
[ -x "$0" ] || chmod +x "$0" 2>/dev/null || true
xattr -d com.apple.quarantine "$0" 2>/dev/null || true

SRC="$(cd "$(dirname "$0")" && pwd)"
# 3) v11.95: clear quarantine on the shipped payload (NOT on $SRC itself -- if the
#    user unpacked straight into ~/Downloads, -cr on the folder would strip the
#    Gatekeeper mark from every unrelated download too). Files copied out of a
#    downloaded ZIP keep com.apple.quarantine, and CEP refuses to load an extension
#    whose files carry it -> panel comes up blank with no error at all (that is the
#    "mac blank panel" symptom we never got to the bottom of). Clear it first, so
#    everything copied below is already clean.
for _p in "$SRC/mac-install.command" "$SRC/CSXS" "$SRC/css" "$SRC/js" "$SRC/jsx" \
          "$SRC/images" "$SRC/index.html"; do
  if [ -e "$_p" ]; then xattr -cr "$_p" 2>/dev/null || true; fi
done
CEP="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$CEP/yinqianjiancha"
LEGACY="$CEP/com.workbuddy.ai.preflight"

echo "============================================"
echo "  AI Preflight Panel - Install (macOS)"
echo "============================================"
echo ""
echo "[0/4] Remove older copies"
# v11.86: the extension folder was renamed in 2026-10. A leftover copy of the old
#   name keeps showing up in the Illustrator menu next to the new one, so people
#   click the old panel and conclude the update never installed.
#   The Windows bat has done this since day one; the mac script never did.
if [ -d "$LEGACY" ]; then
  rm -rf "$LEGACY"
  echo "      removed legacy folder: com.workbuddy.ai.preflight"
else
  echo "      no legacy folder."
fi
echo ""

echo "[1/4] Copy files"
echo "      from : $SRC"
echo "      to   : $DEST"
echo ""
mkdir -p "$DEST"
FAIL=""

# v11.86: wipe the old subfolders before copying.
#   `cp -R src/CSXS dest/` MERGES into an existing dest/CSXS instead of
#   replacing it (verified: a file the new package no longer ships stays behind
#   forever), and anything already one level too deep only grows. Deleting first
#   makes the installed tree an exact copy of the package - which the version
#   check further down can then actually prove.
#   The Windows bat has the equivalent rmdir lines; the mac script was missing them.
rm -rf "$DEST/CSXS" "$DEST/css" "$DEST/js" "$DEST/jsx"

cp -R "$SRC/CSXS" "$DEST/" || FAIL=1
cp -R "$SRC/css" "$DEST/" || FAIL=1
cp -R "$SRC/js" "$DEST/" || FAIL=1
cp -R "$SRC/jsx" "$DEST/" || FAIL=1
# v10.44 menu icon lives in images/. The repo mirror does not include it, so a package
#   downloaded from GitHub has no images/ at all. Missing icon is cosmetic (the panel
#   still opens) -> skip with a note instead of failing the install. (v11.63b, same as the bat)
#   v11.86: when the package does carry images/, wipe the old one first - same nesting trap.
if [ -d "$SRC/images" ]; then
  rm -rf "$DEST/images"
  cp -R "$SRC/images" "$DEST/" || FAIL=1
else
  echo "      NOTE - no images/ in this package; menu icon will be missing."
  echo "             The panel itself works fine. Any existing icon is kept."
fi
cp "$SRC/index.html" "$DEST/" || FAIL=1

if [ -f "$DEST/CSXS/manifest.xml" ] && [ -f "$DEST/js/main.js" ] && [ -f "$DEST/jsx/preflight.jsx" ] && [ -f "$DEST/index.html" ]; then
  echo "      OK - files copied."
else
  echo "      FAILED - copy step. Check the folder is not inside the downloaded ZIP."
  exit 1
fi

# v11.86: prove the copy actually replaced what was there.
#   A failed cp used to be invisible: the OLD files were still on disk, so the
#   existence check above passed and the script printed OK while nothing had been
#   updated. Compare the bundle version instead of trusting cp's exit code.
ver() { sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$1" 2>/dev/null | tr -d '\r' | head -1; }
SRC_VER="$(ver "$SRC/CSXS/manifest.xml")"
DST_VER="$(ver "$DEST/CSXS/manifest.xml")"
echo "      version: package=$SRC_VER installed=$DST_VER"
if [ -z "$SRC_VER" ] || [ "$SRC_VER" != "$DST_VER" ]; then
  echo "      FAILED - the installed version does not match the package."
  FAIL=1
fi

if [ -n "$FAIL" ]; then
  echo ""
  echo "      INSTALL INCOMPLETE. Nothing was deleted from your system -"
  echo "      it is safe to run this script again."
  exit 1
fi

echo ""
echo "[2/4] Enable CEP debug mode (required for unsigned extensions)"
for V in 9 10 11 12 13 14 15 16; do
  defaults write "com.adobe.CSXS.$V" PlayerDebugMode 1 2>/dev/null || true
done
# flush the preference cache so the change takes effect without a reboot
killall cfprefsd 2>/dev/null || true
# v11.86: read it back. `defaults write` can fail silently on machines with a
#   managed preference domain, and the old script still printed OK - so the panel
#   never appeared and nobody knew why.
bad=""
for V in 9 10 11 12 13 14 15 16; do
  got="$(defaults read "com.adobe.CSXS.$V" PlayerDebugMode 2>/dev/null || true)"
  [ "$got" = "1" ] || bad="$bad $V"
done
if [ -z "$bad" ]; then
  echo "      OK - PlayerDebugMode=1 verified for CSXS 9 to 16."
else
  echo "      WARN - could not set or read back CSXS:$bad"
  echo "             The panel will NOT appear while this is off."
  echo "             Run this script from Terminal again to see the real error,"
  echo "             or check System Settings > Privacy & Security."
fi

echo ""
echo "[3/4] Done."
echo ""
echo "  NEXT : restart Adobe Illustrator"
echo "         Menu: Window > Extensions > the preflight panel"
echo ""
echo "  IF THE PANEL STILL LOOKS OLD : another copy may be sitting in the CEP"
echo "         folder. Only these should be there:"
echo "         ls \"$CEP\""
echo ""
echo "  TIP  : the FIRST run must go through Terminal - files unzipped from a"
echo "         GitHub download have no execute bit, so double-click is refused:"
echo "         bash \"$(basename \"$0\")\"  (from this folder)"
echo "         This run fixed the execute bit and cleared the quarantine flag, so"
echo "         double-clicking works from now on."
echo ""
