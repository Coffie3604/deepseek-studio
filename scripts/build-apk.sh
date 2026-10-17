#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  build-apk.sh — build DeepSeek Studio's Android APK on Termux.
#
#  Gradle cannot run reliably on Termux, so this script drives the Android SDK
#  build tools directly:
#
#      aapt2 compile  →  aapt2 link  →  javac  →  d8  →  zipalign  →  apksigner
#
#  Requirements (all already present on this device):
#      pkg install aapt openjdk-17
#      ~/android-sdk/build-tools/35.0.0/{lib/d8.jar,lib/apksigner.jar}
#      ~/android-sdk/platforms/android-35/android.jar
#
#  Usage:
#      ./scripts/build-apk.sh              # debug build (default)
#      ./scripts/build-apk.sh release      # release build, signed
#      ./scripts/build-apk.sh --clean      # wipe build/ first
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/android"
APP_DIR="$ANDROID_DIR/app"
BUILD_DIR="$ANDROID_DIR/build"

# ── Configuration ────────────────────────────────────────────────────────────
APP_NAME="DeepSeekStudio"
VERSION_NAME="2.7.0"
VERSION_CODE="270"
MIN_SDK="24"
TARGET_SDK="35"
COMPILE_SDK="35"
KEYSTORE_DIR="$HOME/.deepseek-keystores"
KEYSTORE="$KEYSTORE_DIR/deepseek-studio.jks"
KEY_ALIAS="deepseek"
KEY_PASS_FILE="$KEYSTORE_DIR/.pass"

# ── Colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
    R=$'\033[0m'; B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'; C=$'\033[36m'
else
    R=''; B=''; G=''; Y=''; E=''; C=''
fi
step() { printf '%s▸ %s%s\n' "$C" "$*" "$R"; }
ok()   { printf '%s  ✓ %s%s\n' "$G" "$*" "$R"; }
warn() { printf '%s  ! %s%s\n' "$Y" "$*" "$R"; }
die()  { printf '%s✗ %s%s\n' "$E" "$*" "$R" >&2; exit 1; }

# ── Arguments ────────────────────────────────────────────────────────────────
BUILD_TYPE="debug"
CLEAN=0
for arg in "$@"; do
    case "$arg" in
        release) BUILD_TYPE="release" ;;
        debug)   BUILD_TYPE="debug" ;;
        --clean) CLEAN=1 ;;
        -h|--help)
            sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "unknown argument: $arg" ;;
    esac
done

printf '%s\n' "${B}DeepSeek Studio — APK build${R}"
printf '  type: %s   version: %s (%s)\n\n' "$BUILD_TYPE" "$VERSION_NAME" "$VERSION_CODE"

# ── 1. Locate the toolchain ──────────────────────────────────────────────────
step "Locating Android toolchain"

SDK_CANDIDATES=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "$HOME/android-sdk"
    "$HOME/Android/Sdk"
    "/data/data/com.termux/files/usr/opt/android-sdk"
)
SDK=""
for d in "${SDK_CANDIDATES[@]}"; do
    [ -n "$d" ] && [ -d "$d/build-tools" ] && { SDK="$d"; break; }
done
[ -n "$SDK" ] || die "Android SDK not found. Set ANDROID_HOME or install to ~/android-sdk"
ok "SDK: $SDK"

# Newest build-tools directory.
BUILD_TOOLS="$(ls -1 "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS" ] || die "no build-tools installed in $SDK/build-tools"
BUILD_TOOLS="$SDK/build-tools/$BUILD_TOOLS"
ok "build-tools: $(basename "$BUILD_TOOLS")"

# Newest platform android.jar.
PLATFORM="$(ls -1 "$SDK/platforms" 2>/dev/null | grep -E '^android-[0-9]+$' | sort -V | tail -1)"
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"
[ -f "$ANDROID_JAR" ] || die "android.jar not found (looked in $SDK/platforms)"
ok "platform: $PLATFORM"

D8_JAR="$BUILD_TOOLS/lib/d8.jar"
APKSIGNER_JAR="$BUILD_TOOLS/lib/apksigner.jar"
[ -f "$D8_JAR" ] || die "d8.jar missing from $BUILD_TOOLS/lib"
[ -f "$APKSIGNER_JAR" ] || die "apksigner.jar missing from $BUILD_TOOLS/lib"

# aapt2: the SDK copy is a glibc binary and cannot run on Termux, so prefer the
# Termux-native package (`pkg install aapt`) and only fall back to the SDK copy.
AAPT2=""
if command -v aapt2 >/dev/null 2>&1 && aapt2 version >/dev/null 2>&1; then
    AAPT2="$(command -v aapt2)"
    ok "aapt2: $AAPT2 (termux)"
elif [ -x "$BUILD_TOOLS/aapt2" ] && "$BUILD_TOOLS/aapt2" version >/dev/null 2>&1; then
    AAPT2="$BUILD_TOOLS/aapt2"
    ok "aapt2: $AAPT2 (sdk)"
else
    die "aapt2 not usable. Run: pkg install aapt"
fi

# zipalign: Google's build-tools binary is glibc/x86_64 and cannot run on
# Termux, and there is no `zipalign` package either. scripts/zipalign.js is a
# pure-JS drop-in (`-f -p -c -v`), so prefer any native binary and fall back to
# it — an unaligned APK is rejected by Play and mmaps resources slower.
ZIPALIGN=""
for cand in "$(command -v zipalign-termux 2>/dev/null || true)" \
            "$(command -v zipalign 2>/dev/null || true)" \
            "$BUILD_TOOLS/zipalign-termux" "$BUILD_TOOLS/zipalign"; do
    if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -h >/dev/null 2>&1; then
        ZIPALIGN="$cand"; break
    fi
done
if [ -z "$ZIPALIGN" ] && command -v node >/dev/null 2>&1 \
        && [ -f "$PROJECT_ROOT/scripts/zipalign.js" ]; then
    ZIPALIGN="node $PROJECT_ROOT/scripts/zipalign.js"
fi
if [ -n "$ZIPALIGN" ]; then ok "zipalign: $ZIPALIGN"; else warn "zipalign unavailable — APK will be unaligned"; fi

command -v javac >/dev/null 2>&1 || die "javac not found. Run: pkg install openjdk-17"
command -v keytool >/dev/null 2>&1 || die "keytool not found. Run: pkg install openjdk-17"
ok "java: $(javac -version 2>&1)"

# ── 2. Prepare the build tree ────────────────────────────────────────────────
if [ "$CLEAN" -eq 1 ]; then
    step "Cleaning"
    rm -rf "$BUILD_DIR"
    ok "removed $BUILD_DIR"
fi

OUT_DIR="$BUILD_DIR/$BUILD_TYPE"
RES_COMPILED="$BUILD_DIR/res-compiled"
GEN_DIR="$BUILD_DIR/gen"
CLASSES_DIR="$BUILD_DIR/classes"
DEX_DIR="$BUILD_DIR/dex"
mkdir -p "$OUT_DIR" "$RES_COMPILED" "$GEN_DIR" "$CLASSES_DIR" "$DEX_DIR"

# ── 3. Compile resources ─────────────────────────────────────────────────────
step "Compiling resources (aapt2 compile)"
"$AAPT2" compile --dir "$APP_DIR/src/main/res" -o "$RES_COMPILED/" \
    || die "aapt2 compile failed"
ok "$(find "$RES_COMPILED" -name '*.flat' | wc -l | tr -d ' ') resource files"

# ── 4. Link resources + generate R.java ──────────────────────────────────────
step "Linking resources (aapt2 link)"
# Debug builds get a .debug suffix so they can sit beside a release install.
if [ "$BUILD_TYPE" = "debug" ]; then
    PACKAGE_ID="com.coffie.deepseekstudio.debug"
else
    PACKAGE_ID="com.coffie.deepseekstudio"
fi

LINK_ARGS=(
    -o "$OUT_DIR/$APP_NAME-unsigned.apk"
    -I "$ANDROID_JAR"
    --manifest "$APP_DIR/src/main/AndroidManifest.xml"
    --java "$GEN_DIR"
    --min-sdk-version "$MIN_SDK"
    --target-sdk-version "$TARGET_SDK"
    --version-code "$VERSION_CODE"
    --version-name "$VERSION_NAME"
    --auto-add-overlay
)
if [ "$BUILD_TYPE" = "debug" ]; then
    LINK_ARGS+=(--debug-mode)
fi

"$AAPT2" link "${LINK_ARGS[@]}" "$RES_COMPILED"/*.flat \
    || die "aapt2 link failed"
ok "linked → $APP_NAME-unsigned.apk"

# ── 5. Compile Java ──────────────────────────────────────────────────────────
step "Compiling Java sources (javac)"
JAVA_SOURCES=()
while IFS= read -r -d '' f; do JAVA_SOURCES+=("$f"); done \
    < <(find "$APP_DIR/src/main/java" "$GEN_DIR" -name '*.java' -print0)

[ "${#JAVA_SOURCES[@]}" -gt 0 ] || die "no Java sources found"
ok "${#JAVA_SOURCES[@]} source files"

# android.jar goes on the classpath (not -bootclasspath: JDK 21 rejects that
# together with -target). d8 desugars the result down to minSdk anyway.
javac -source 17 -target 17 \
      -classpath "$ANDROID_JAR" \
      -d "$CLASSES_DIR" \
      -encoding UTF-8 \
      -nowarn \
      "${JAVA_SOURCES[@]}" 2>&1 | grep -vE 'bootstrap class path|source value 17|target value 17|deprecat' || true

# Verify the compiler actually emitted bytecode.
[ -n "$(find "$CLASSES_DIR" -name '*.class' -print -quit)" ] \
    || die "javac produced no classes"
ok "$(find "$CLASSES_DIR" -name '*.class' | wc -l | tr -d ' ') classes"

# ── 6. Dex ───────────────────────────────────────────────────────────────────
step "Dexing (d8)"
CLASS_FILES=()
while IFS= read -r -d '' f; do CLASS_FILES+=("$f"); done \
    < <(find "$CLASSES_DIR" -name '*.class' -print0)

java -cp "$D8_JAR" com.android.tools.r8.D8 \
     --min-api "$MIN_SDK" \
     --lib "$ANDROID_JAR" \
     --output "$DEX_DIR" \
     "${CLASS_FILES[@]}" || die "d8 failed"
ok "$(ls "$DEX_DIR"/*.dex | wc -l | tr -d ' ') dex file(s)"

# ── 7. Package classes.dex into the APK ──────────────────────────────────────
step "Packaging classes.dex"
UNSIGNED_APK="$OUT_DIR/$APP_NAME-unsigned.apk"
# `zip` is not part of a base Termux install, so use Python's stdlib zipfile.
# It rewrites the archive while preserving the existing (stored) resource
# entries that aapt2 wrote.
python3 - "$UNSIGNED_APK" "$DEX_DIR" <<'PY' || die "failed to add classes.dex to APK"
import os, shutil, sys, zipfile

apk, dex_dir = sys.argv[1], sys.argv[2]
tmp = apk + ".tmp"

with zipfile.ZipFile(apk, "r") as src, \
     zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
    for item in src.infolist():
        dst.writestr(item, src.read(item.filename))
    for name in sorted(os.listdir(dex_dir)):
        if name.endswith(".dex"):
            dst.write(os.path.join(dex_dir, name), name)

shutil.move(tmp, apk)
print("    added: " + ", ".join(
    n for n in sorted(os.listdir(dex_dir)) if n.endswith(".dex")))
PY
ok "classes.dex added"

# ── 8. Align ─────────────────────────────────────────────────────────────────
ALIGNED_APK="$OUT_DIR/$APP_NAME-aligned.apk"
if [ -n "$ZIPALIGN" ]; then
    step "Aligning (zipalign)"
    # $ZIPALIGN may be "node /path/zipalign.js", so do not quote it.
    $ZIPALIGN -f -p 4 "$UNSIGNED_APK" "$ALIGNED_APK" || die "zipalign failed"
    $ZIPALIGN -c -p 4 "$ALIGNED_APK" >/dev/null || die "zipalign verification failed"
    ok "aligned + verified"
else
    ALIGNED_APK="$UNSIGNED_APK"
    warn "skipped alignment"
fi

# ── 9. Sign ──────────────────────────────────────────────────────────────────
step "Signing (apksigner)"
mkdir -p "$KEYSTORE_DIR"
chmod 700 "$KEYSTORE_DIR"

if [ ! -f "$KEYSTORE" ]; then
    ok "generating keystore (first run)"
    # Random password, stored 0600 next to the keystore.
    if [ ! -f "$KEY_PASS_FILE" ]; then
        head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-24 > "$KEY_PASS_FILE"
        chmod 600 "$KEY_PASS_FILE"
    fi
    STOREPASS="$(cat "$KEY_PASS_FILE")"
    keytool -genkeypair \
        -keystore "$KEYSTORE" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$STOREPASS" -keypass "$STOREPASS" \
        -dname "CN=DeepSeek Studio, OU=Termux, O=Coffie, L=Local, S=Local, C=US" \
        2>/dev/null || die "keytool failed to create keystore"
    ok "keystore: $KEYSTORE"
fi

STOREPASS="$(cat "$KEY_PASS_FILE")"
SIGNED_APK="$OUT_DIR/$APP_NAME-$BUILD_TYPE.apk"

java -jar "$APKSIGNER_JAR" sign \
     --ks "$KEYSTORE" \
     --ks-key-alias "$KEY_ALIAS" \
     --ks-pass "pass:$STOREPASS" \
     --key-pass "pass:$STOREPASS" \
     --min-sdk-version "$MIN_SDK" \
     --out "$SIGNED_APK" \
     "$ALIGNED_APK" || die "apksigner sign failed"

java -jar "$APKSIGNER_JAR" verify --min-sdk-version "$MIN_SDK" "$SIGNED_APK" \
    || die "apksigner verify failed"
ok "signature verified"

# ── 10. Report ───────────────────────────────────────────────────────────────
SIZE="$(du -h "$SIGNED_APK" | cut -f1)"
printf '\n%s✓ Build complete%s\n' "$G$B" "$R"
printf '  APK:      %s\n' "$SIGNED_APK"
printf '  size:     %s\n' "$SIZE"
printf '  package:  %s\n' "$PACKAGE_ID"
printf '  version:  %s (%s)\n' "$VERSION_NAME" "$VERSION_CODE"
printf '  minSdk:   %s   targetSdk: %s\n' "$MIN_SDK" "$TARGET_SDK"
printf '\n  Install:  adb install -r "%s"\n' "$SIGNED_APK"
printf '  Or tap the APK in a file manager.\n\n'

# Machine-readable line for the server's /api/deploy endpoints.
printf 'APK_PATH=%s\n' "$SIGNED_APK"
