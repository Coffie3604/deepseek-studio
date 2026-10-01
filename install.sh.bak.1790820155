#!/data/data/com.termux/files/usr/bin/bash
#
# DeepSeek Studio — One-time installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Coffie3604/deepseek-studio/main/install.sh | bash
#

set -e

REPO="https://github.com/Coffie3604/deepseek-studio.git"
INSTALL_DIR="$HOME/deepseek-projects/deepseek-editor"
BIN_DIR="$PREFIX/bin"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   DeepSeek Studio — Installer             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

# ─── Prerequisites ───
echo -e "${YELLOW}→${NC} Updating packages..."
pkg update -y >/dev/null 2>&1 || true

echo -e "${YELLOW}→${NC} Installing git + nodejs..."
pkg install -y git nodejs >/dev/null 2>&1

if ! command -v node &>/dev/null; then
    echo -e "${RED}✗ Node.js install failed${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# ─── Clone or update ───
mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "${YELLOW}→${NC} Updating existing install..."
    cd "$INSTALL_DIR"
    git pull --quiet
else
    echo -e "${YELLOW}→${NC} Cloning repository..."
    rm -rf "$INSTALL_DIR"
    git clone --quiet "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Repo at $INSTALL_DIR"

# ─── npm install ───
echo -e "${YELLOW}→${NC} Installing dependencies..."
cd "$INSTALL_DIR"
npm install --no-audit --no-fund --silent
echo -e "${GREEN}✓${NC} Dependencies installed"

# ─── Install shortcut commands ───
echo -e "${YELLOW}→${NC} Installing shortcuts (ds-start, ds-stop, ds-status)..."

cat > "$BIN_DIR/ds-start" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/deepseek-projects/deepseek-editor" 2>/dev/null || { echo "DeepSeek Studio not installed. Run install.sh first."; exit 1; }

# Kill any existing server
pkill -f "node server.js" 2>/dev/null || true
sleep 0.5

# Start server in background with nohup
nohup node server.js > "$HOME/.ds-studio.log" 2>&1 &
sleep 1.5

# Verify it's running
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/fs/list 2>/dev/null | grep -q "200"; then
    echo "✅ DeepSeek Studio running at http://127.0.0.1:3001"
    # Try to auto-open in browser
    am start -a android.intent.action.VIEW -d "http://127.0.0.1:3001" >/dev/null 2>&1 &
else
    echo "⚠️  Server may not be running. Check log:"
    echo "   cat ~/.ds-studio.log"
fi
EOF
chmod +x "$BIN_DIR/ds-start"

cat > "$BIN_DIR/ds-stop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
if pkill -f "node server.js" 2>/dev/null; then
    echo "🛑 DeepSeek Studio stopped"
else
    echo "ℹ️  DeepSeek Studio was not running"
fi
EOF
chmod +x "$BIN_DIR/ds-stop"

cat > "$BIN_DIR/ds-restart" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
ds-stop
sleep 1
ds-start
EOF
chmod +x "$BIN_DIR/ds-restart"

cat > "$BIN_DIR/ds-status" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
if pgrep -f "node server.js" >/dev/null; then
    echo "✅ DeepSeek Studio is running (PID $(pgrep -f 'node server.js' | head -1))"
    CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/fs/list 2>/dev/null)
    echo "   HTTP status: $CODE"
    echo "   URL:         http://127.0.0.1:3001"
    echo "   Log:         ~/.ds-studio.log"
else
    echo "🛑 DeepSeek Studio is not running"
    echo "   Start it with: ds-start"
fi
EOF
chmod +x "$BIN_DIR/ds-status"

cat > "$BIN_DIR/ds-log" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/.ds-studio.log"
EOF
chmod +x "$BIN_DIR/ds-log"

cat > "$BIN_DIR/ds-update" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/deepseek-projects/deepseek-editor" || { echo "Not installed"; exit 1; }
echo "→ Pulling latest..."
git pull --quiet
echo "→ Updating deps..."
npm install --no-audit --no-fund --silent
echo "✅ Updated. Run 'ds-restart' to apply."
EOF
chmod +x "$BIN_DIR/ds-update"

echo -e "${GREEN}✓${NC} Shortcuts installed"

# ─── Termux widget shortcut ───
mkdir -p ~/.shortcuts
ln -sf "$BIN_DIR/ds-start" ~/.shortcuts/DeepSeekStart
ln -sf "$BIN_DIR/ds-stop" ~/.shortcuts/DeepSeekStop
echo -e "${GREEN}✓${NC} Termux widget shortcuts linked"

# ─── Storage (optional) ───
if [ ! -d "$HOME/storage/external-1" ]; then
    echo ""
    echo -e "${YELLOW}ℹ️  SD card access not configured${NC}"
    echo "   To enable SD-card backups, run:"
    echo "     termux-setup-storage"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Installation complete                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo "Available commands:"
echo "  ds-start     — start server + open browser"
echo "  ds-stop      — stop server"
echo "  ds-restart   — restart server"
echo "  ds-status    — show status"
echo "  ds-log       — tail the log file"
echo "  ds-update    — pull latest + reinstall deps"
echo ""
echo "Or add a Termux widget to home screen:"
echo "  Widgets → Termux:Widget → DeepSeekStart"
echo ""
echo "First time? Install Chrome bookmark:"
echo "  http://127.0.0.1:3001"
echo ""
