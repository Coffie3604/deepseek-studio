#!/data/data/com.termux/files/usr/bin/bash
#
# DeepSeek Studio — One-time installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Coffie3604/deepseek-studio/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --ref v1.1.0
#   curl -fsSL .../install.sh | bash -s -- --update
#
set -euo pipefail

REPO="https://github.com/Coffie3604/deepseek-studio.git"
REF="${DS_REF:-main}"
INSTALL_DIR="${DS_INSTALL_DIR:-$HOME/deepseek-projects/deepseek-editor}"
BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
UPDATE_ONLY=0

# Colors
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

usage() {
  cat <<EOF
DeepSeek Studio installer
  --ref <ref>       Git ref to install (default: main)
  --update          Update existing install only
  --dir <path>      Install directory (default: ~/deepseek-projects/deepseek-editor)
  -h, --help        This help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --update) UPDATE_ONLY=1; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

trap 'echo -e "\n${RED}✗ Install failed.${NC}"' ERR

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   DeepSeek Studio — Installer             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

# ─── Prereqs ───
if [ "$UPDATE_ONLY" -eq 0 ]; then
  echo -e "${YELLOW}→${NC} Updating packages..."
  pkg update -y >/dev/null 2>&1 || true

  echo -e "${YELLOW}→${NC} Installing git + nodejs..."
  pkg install -y git nodejs >/dev/null 2>&1

  if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}✗ Node.js install failed${NC}"; exit 1
  fi
  echo -e "${GREEN}✓${NC} Node.js $(node -v)"
fi

# ─── Clone or update ───
mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${YELLOW}→${NC} Updating existing install (ref: $REF)..."
  cd "$INSTALL_DIR"
  git fetch --quiet origin "$REF"
  git checkout --quiet "$REF" 2>/dev/null || git checkout --quiet "origin/$REF"
  git pull --ff-only --quiet 2>/dev/null || true
else
  echo -e "${YELLOW}→${NC} Cloning (ref: $REF)..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR" 2>/dev/null \
    || git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Repo at $INSTALL_DIR"

# ─── Dependencies ───
echo -e "${YELLOW}→${NC} Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --silent 2>/dev/null || npm install --no-audit --no-fund --silent
else
  npm install --no-audit --no-fund --silent
fi
echo -e "${GREEN}✓${NC} Dependencies installed"

# ─── Shortcut scripts ───
echo -e "${YELLOW}→${NC} Installing shortcuts..."
mkdir -p "$BIN_DIR"

write_script() {
  local name="$1"; shift
  cat > "$BIN_DIR/$name"
  chmod +x "$BIN_DIR/$name"
}

# ── ds-start: boot server + open browser ──
write_script ds-start <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DIR="${DS_INSTALL_DIR:-$HOME/deepseek-projects/deepseek-editor}"
cd "$DIR" 2>/dev/null || { echo "❌ Not installed at $DIR"; exit 1; }
pkill -f "node server.js" 2>/dev/null || true
sleep 1
pgrep -f "node server.js" >/dev/null && pkill -9 -f "node server.js" 2>/dev/null || true
setsid nohup node server.js > "$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
READY=0
for i in $(seq 1 20); do
  sleep 1
  if curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then READY=1; break; fi
done
if [ "$READY" != "1" ]; then
  echo "⚠️  Server didn't respond in 20s."
  tail -20 "$HOME/.ds-studio.log"
  exit 1
fi
VER=$(curl -s http://127.0.0.1:3001/api/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
echo "✅ DeepSeek Studio v${VER:-1.0.0} running"
if command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "http://127.0.0.1:3001" 2>/dev/null &
else
  am start -a android.intent.action.VIEW -d "http://127.0.0.1:3001" >/dev/null 2>&1 &
fi
exit 0
EOF

# ── ds-launch: smart launcher — start only if needed, then open ──
write_script ds-launch <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# One-tap launcher: if server is already up, just open browser.
# Otherwise start it (silently, no browser) then open browser.
if curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then
  # Already running
  :
else
  ds-boot
  # Wait for it to come up
  for i in $(seq 1 20); do
    sleep 1
    if curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then break; fi
  done
fi
# Open browser
if command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "http://127.0.0.1:3001" 2>/dev/null &
else
  am start -a android.intent.action.VIEW -d "http://127.0.0.1:3001" >/dev/null 2>&1 &
fi
exit 0
EOF

# ── ds-boot: start server only (no browser) — for Termux:Boot ──
write_script ds-boot <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DIR="${DS_INSTALL_DIR:-$HOME/deepseek-projects/deepseek-editor}"
cd "$DIR" 2>/dev/null || exit 1
# Don't restart if already running
if curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then
  exit 0
fi
pkill -f "node server.js" 2>/dev/null || true
sleep 1
pgrep -f "node server.js" >/dev/null && pkill -9 -f "node server.js" 2>/dev/null || true
setsid nohup node server.js > "$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
EOF

write_script ds-stop <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
if pkill -f "node server.js" 2>/dev/null; then
  echo "🛑 DeepSeek Studio stopped"
else
  echo "ℹ️  DeepSeek Studio was not running"
fi
EOF

write_script ds-restart <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
ds-stop
sleep 1
ds-start
EOF

write_script ds-status <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
if pgrep -f "node server.js" >/dev/null; then
  echo "✅ DeepSeek Studio is running (PID $(pgrep -f 'node server.js' | head -1))"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/fs/list 2>/dev/null)
  echo "   HTTP status: $CODE"
  echo "   URL:         http://127.0.0.1:3001"
  echo "   Log:         ~/.ds-studio.log"
else
  echo "🛑 DeepSeek Studio is not running"
  echo "   Start it with: ds-launch"
fi
EOF

write_script ds-log <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/.ds-studio.log"
EOF

write_script ds-update <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DIR="${DS_INSTALL_DIR:-$HOME/deepseek-projects/deepseek-editor}"
cd "$DIR" || { echo "Not installed"; exit 1; }
echo "→ Pulling latest..."
git pull --ff-only --quiet
echo "→ Updating deps..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent
else
  npm install --no-audit --no-fund --silent
fi
echo "→ Re-installing shortcuts..."
# Re-run just the shortcut section by calling install.sh with --update
if [ -f install.sh ]; then
  bash install.sh --update 2>/dev/null || true
fi
echo "✅ Updated. Run 'ds-restart' to apply."
EOF

echo -e "${GREEN}✓${NC} Shortcuts installed"

# ─── Widget shortcuts ───
mkdir -p ~/.shortcuts
ln -sf "$BIN_DIR/ds-launch"  "$HOME/.shortcuts/🚀 DeepSeek"
ln -sf "$BIN_DIR/ds-start"   "$HOME/.shortcuts/🐳 DeepSeek Start"
ln -sf "$BIN_DIR/ds-stop"    "$HOME/.shortcuts/🛑 DeepSeek Stop"
ln -sf "$BIN_DIR/ds-restart" "$HOME/.shortcuts/🔄 DeepSeek Restart"
ln -sf "$BIN_DIR/ds-status"  "$HOME/.shortcuts/ℹ️  DeepSeek Status"
echo -e "${GREEN}✓${NC} Widget shortcuts created"

# ─── Termux:Boot auto-start ───
BOOT_DIR="$HOME/.termux/boot"
if [ -d "$HOME/.termux" ] || [ -d "/data/data/com.termux/files/home/.termux" ]; then
  mkdir -p "$BOOT_DIR"
  cat > "$BOOT_DIR/00-deepseek" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sleep 5
$BIN_DIR/ds-boot
EOF
  chmod +x "$BOOT_DIR/00-deepseek"
  echo -e "${GREEN}✓${NC} Boot hook installed (needs Termux:Boot app)"
else
  echo -e "${YELLOW}ℹ️  Skipping boot hook — run again after installing Termux:Boot${NC}"
fi

# ─── Storage hint ───
if [ ! -d "$HOME/storage/external-1" ]; then
  echo ""
  echo -e "${YELLOW}ℹ️  SD card access not configured${NC}"
  echo "   To enable SD-card backups, run: termux-setup-storage"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Installation complete                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo "Commands: ds-launch · ds-start · ds-stop · ds-restart · ds-status · ds-log · ds-update"
echo ""
echo "⭐ Add the 🚀 DeepSeek widget to your home screen for one-tap launch"
echo "   (Termux:Widget from F-Droid required)"
echo ""
echo "⚡ To auto-start on phone boot:"
echo "   1. Install Termux:Boot from F-Droid"
echo "   2. Open it once"
echo "   3. Re-run: bash install.sh --update"
echo ""