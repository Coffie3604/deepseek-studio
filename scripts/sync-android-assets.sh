#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  sync-android-assets.sh — copy the web UI into the APK's assets/ folder.
#
#  The APK ships public/ as file:///android_asset/www so the app opens even
#  when the Termux backend is not running. When the backend IS running the
#  WebView is pointed at http://127.0.0.1:3001/ instead (see MainActivity).
#
#  Usage: ./scripts/sync-android-assets.sh [--clean]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$PROJECT_ROOT/public"
DEST="$PROJECT_ROOT/android/app/src/main/assets/www"

[ -d "$SRC" ] || { echo "✗ missing $SRC" >&2; exit 1; }

if [ "${1:-}" = "--clean" ]; then
    rm -rf "$DEST"
fi
mkdir -p "$DEST"

# Copy the UI. The service worker is pointless under file:// and its cache
# would shadow updated assets, so it is deliberately excluded.
for f in index.html app.css guide.html manifest.json icon-v2.svg icon-192.png icon-512.png; do
    [ -f "$SRC/$f" ] && cp -f "$SRC/$f" "$DEST/$f"
done

# Any other static assets (fonts, images) that show up later.
find "$SRC" -maxdepth 1 -type f \
    ! -name 'sw.js' ! -name 'index.html' ! -name 'app.css' ! -name 'guide.html' \
    ! -name 'manifest.json' ! -name 'icon-v2.svg' ! -name 'icon-192.png' ! -name 'icon-512.png' \
    -exec cp -f {} "$DEST/" \;

echo "✓ synced $(find "$DEST" -type f | wc -l | tr -d ' ') files → ${DEST#$PROJECT_ROOT/}"
