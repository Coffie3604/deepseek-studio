#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  setup-apk-signing.sh — create a release keystore and register it as GitHub
#  Actions secrets so every CI-built APK is signed with the same key.
#
#  Why: Android refuses to install an APK over an existing one unless both are
#  signed with the same key. Without this, each CI run would produce an APK
#  that forces an uninstall/reinstall (losing app data).
#
#  Usage:
#      ./scripts/setup-apk-signing.sh            # create + upload secrets
#      ./scripts/setup-apk-signing.sh --local    # create keystore only
#
#  Requires the GitHub CLI (`pkg install gh`) logged in: gh auth login
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE_DIR="$HOME/.deepseek-keystores"
KEYSTORE="$KEYSTORE_DIR/deepseek-studio.jks"
PASS_FILE="$KEYSTORE_DIR/.pass"
ALIAS="deepseek"
LOCAL_ONLY=0
[ "${1:-}" = "--local" ] && LOCAL_ONLY=1

mkdir -p "$KEYSTORE_DIR"
chmod 700 "$KEYSTORE_DIR"

if [ -f "$KEYSTORE" ]; then
    echo "✓ keystore already exists: $KEYSTORE"
else
    echo "▸ generating keystore"
    head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-24 > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    keytool -genkeypair \
        -keystore "$KEYSTORE" \
        -alias "$ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$(cat "$PASS_FILE")" -keypass "$(cat "$PASS_FILE")" \
        -dname "CN=DeepSeek Studio, OU=Termux, O=Coffie, L=Local, S=Local, C=US"
    echo "✓ keystore: $KEYSTORE"
    echo "  password:  $PASS_FILE  (keep this file safe — needed for future builds)"
fi

if [ "$LOCAL_ONLY" -eq 1 ]; then
    echo
    echo "Keystore ready. To upload the secrets manually:"
    echo "  base64 -w0 \"$KEYSTORE\"   → paste as secret DS_KEYSTORE_B64"
    echo "  cat \"$PASS_FILE\"          → paste as secret DS_KEYSTORE_PASS"
    exit 0
fi

command -v gh >/dev/null 2>&1 || {
    echo "✗ GitHub CLI not found. Run: pkg install gh && gh auth login" >&2
    exit 1
}
gh auth status >/dev/null 2>&1 || {
    echo "✗ Not logged in to GitHub. Run: gh auth login" >&2
    exit 1
}

echo "▸ uploading secrets to $(git -C "$PROJECT_ROOT" remote get-url origin)"
base64 -w0 "$KEYSTORE" | gh secret set DS_KEYSTORE_B64 --repo "$(git -C "$PROJECT_ROOT" remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"
gh secret set DS_KEYSTORE_PASS --body "$(cat "$PASS_FILE")" \
    --repo "$(git -C "$PROJECT_ROOT" remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"

echo "✓ secrets DS_KEYSTORE_B64 and DS_KEYSTORE_PASS are set"
echo "  Next: git push  →  the Build APK workflow publishes a signed release."
