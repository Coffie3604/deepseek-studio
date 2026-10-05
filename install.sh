#!/data/data/com.termux/files/usr/bin/bash
#
# DeepSeek Studio — One-time installer (v2)
# ─────────────────────────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Coffie3604/deepseek-studio/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --ref v2.0.0
#   curl -fsSL .../install.sh | bash -s -- --update
#
set -euo pipefail

REPO="https://github.com/Coffie3604/deepseek-studio.git"
REF="${DS_REF:-main}"
INSTALL_DIR="${DS_INSTALL_DIR:-$HOME/deepseek-projects/deepseek-editor}"
BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
UPDATE_ONLY=0

# ─── Colors ───
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

say()  { printf "${BLUE}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
fail() { printf "${RED}✗${NC} %s\n" "$*"; }
hr()   { printf "${BLUE}─────────────────────────────────────────────${NC}\n"; }

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
    *) fail "Unknown option: $1"; usage ;;
  esac
done

trap 'fail "Install failed. Re-run with: bash install.sh --update"' ERR

# ─── Preflight ───
if [ ! -d "/data/data/com.termux/files/usr" ]; then
  warn "This installer is designed for Termux. Proceeding anyway..."
fi

echo ""
printf "${BLUE}╔═══════════════════════════════════════════╗${NC}\n"
printf "${BLUE}║${NC}   ${BOLD}DeepSeek Studio — Installer v2${NC}          ${BLUE}║${NC}\n"
printf "${BLUE}╚═══════════════════════════════════════════╝${NC}\n"
echo ""

# ─── System packages ───
if [ "$UPDATE_ONLY" -eq 0 ]; then
  say "Updating Termux packages…"
  pkg update -y >/dev/null 2>&1 || true

  say "Installing git + nodejs…"
  pkg install -y git nodejs >/dev/null 2>&1

  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js install failed"; exit 1
  fi
  ok "Node.js $(node -v)  ·  npm $(npm -v 2>/dev/null || echo '?')"

  # Optional: termux-api (wake-lock, notifications)
  if ! command -v termux-wake-lock >/dev/null 2>&1; then
    say "Installing termux-api (wake-lock, notifications)…"
    pkg install -y termux-api >/dev/null 2>&1 && ok "termux-api installed" || warn "termux-api not installed — wake-lock disabled"
  else
    ok "termux-api already installed"
  fi
fi

# ─── Repo clone/update ───
mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing install (ref: $REF)…"
  cd "$INSTALL_DIR"
  git fetch --quiet origin "$REF"
  git checkout --quiet "$REF" 2>/dev/null || git checkout --quiet "origin/$REF"
  git pull --ff-only --quiet 2>/dev/null || true
else
  say "Cloning (ref: $REF)…"
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR" 2>/dev/null \
    || git clone --quiet "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "Repo at $INSTALL_DIR"

# ─── Dependencies (with node-pty fallback) ───
say "Installing Node dependencies…"

install_deps() {
  if npm install --no-audit --no-fund --silent 2>/tmp/ds-npm.log; then
    return 0
  fi
  warn "Full install failed — retrying without node-pty (native module)…"
  cp package.json package.json.bak 2>/dev/null || true
  node -e '
    try {
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      if (pkg.dependencies) delete pkg.dependencies["node-pty"];
      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    } catch (_) {}
  ' 2>/dev/null || true
  if npm install --no-audit --no-fund --silent 2>/tmp/ds-npm-2.log; then
    warn "Installed without node-pty — terminal will use pipe fallback"
    return 0
  fi
  fail "npm install failed. See /tmp/ds-npm.log"
  return 1
}

install_deps
ok "Dependencies installed"

# Verify critical deps
verify_dep() {
  node -e "require.resolve('$1')" 2>/dev/null
}
for dep in express cors ws; do
  verify_dep "$dep" || { fail "Required dep missing: $dep"; exit 1; }
done
for dep in simple-git @octokit/rest node-pty editkit; do
  if verify_dep "$dep"; then
    ok "  + $dep"
  else
    warn "  − $dep (using fallback)"
  fi
done

# ─── Shortcut scripts ───
say "Installing shortcut commands in $BIN_DIR…"
mkdir -p "$BIN_DIR"

write_script() {
  local name="$1"; shift
  cat > "$BIN_DIR/$name"
  chmod +x "$BIN_DIR/$name"
}

# ds-start — kill any running instance, start fresh, wait for health, open browser
write_script ds-start <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$INSTALL_DIR}"
[ -f "\$DIR/server.js" ] || { echo "❌ server.js not found at \$DIR"; exit 1; }
cd "\$DIR" || exit 1

# Kill any existing instance
pkill -f "node server.js" 2>/dev/null && sleep 1 || true
pgrep -f "node server.js" >/dev/null && pkill -9 -f "node server.js" 2>/dev/null || true

# Start detached
setsid nohup node server.js > "\$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true

# Wait for health (up to 20s)
for i in \$(seq 1 20); do
  sleep 1
  curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null && break
done

VER=\$(curl -s http://127.0.0.1:3001/api/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
if [ -n "\$VER" ]; then
  echo "✅ DeepSeek Studio v\${VER} running — http://127.0.0.1:3001"
else
  echo "⚠️  Server may not have started. Check: ds-log"
fi

command -v termux-open-url >/dev/null 2>&1 && termux-open-url "http://127.0.0.1:3001" 2>/dev/null &
exit 0
EOF

# ds-boot — start silently if not already running (used by Termux:Boot)
write_script ds-boot <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$INSTALL_DIR}"
[ -f "\$DIR/server.js" ] || exit 1
cd "\$DIR" || exit 1
curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null && exit 0
pkill -f "node server.js" 2>/dev/null || true
sleep 1
setsid nohup node server.js > "\$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
EOF

# ds-launch — one-tap: start if needed, then open browser
write_script ds-launch <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null || {
  ds-boot
  for i in $(seq 1 20); do
    sleep 1
    curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null && break
  done
}
command -v termux-open-url >/dev/null 2>&1 \
  && termux-open-url "http://127.0.0.1:3001" 2>/dev/null \
  || am start -a android.intent.action.VIEW -d "http://127.0.0.1:3001" >/dev/null 2>&1 &
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
  echo "✅ DeepSeek Studio running (PID $(pgrep -f 'node server.js' | head -1))"
  echo "   URL: http://127.0.0.1:3001"
  echo "   Log: ~/.ds-studio.log"
  curl -s http://127.0.0.1:3001/api/version 2>/dev/null | head -c 400; echo
else
  echo "🛑 DeepSeek Studio not running — start with: ds-launch"
fi
EOF

write_script ds-log <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/.ds-studio.log"
EOF

# NEW: ds-doctor — full self-diagnostic
write_script ds-doctor <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$INSTALL_DIR}"
BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo ""
echo "\${BLUE}🩺 DeepSeek Studio — Diagnostics\${NC}"
echo "\${BLUE}──────────────────────────────────\${NC}"
echo "Install:  \$DIR"
echo "Node:     \$(node -v 2>/dev/null || echo 'missing')"
echo "npm:      \$(npm -v 2>/dev/null || echo 'missing')"
echo "Git:      \$(git --version 2>/dev/null | head -1 || echo 'missing')"
echo ""

echo "Dependencies:"
cd "\$DIR" 2>/dev/null || exit 1
for pkg in express cors ws simple-git @octokit/rest node-pty editkit; do
  if node -e "require.resolve('\$pkg')" 2>/dev/null; then
    printf "  \${GREEN}✓\${NC} %s\n" "\$pkg"
  else
    printf "  \${RED}✗\${NC} %s\n" "\$pkg"
  fi
done
echo ""

echo "Termux tools:"
for tool in termux-wake-lock termux-notification termux-open-url termux-setup-storage; do
  if command -v "\$tool" >/dev/null 2>&1; then
    printf "  \${GREEN}✓\${NC} %s\n" "\$tool"
  else
    printf "  \${YELLOW}−\${NC} %s\n" "\$tool"
  fi
done
echo ""

echo "Storage:"
if [ -d "\$HOME/storage/external-1" ]; then
  printf "  \${GREEN}✓\${NC} SD card mounted\n"
else
  printf "  \${YELLOW}−\${NC} SD card not mounted (run: termux-setup-storage)\n"
fi
echo ""

if curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then
  echo -e "\${GREEN}Server: ✅ running\${NC}"
  echo -n "  "
  curl -s http://127.0.0.1:3001/api/version 2>/dev/null | head -c 300
  echo
  echo -n "  Features: "
  curl -s http://127.0.0.1:3001/api/diagnostics 2>/dev/null | grep -o '"features":{[^}]*}' | head -1
  echo
else
  echo -e "\${RED}Server: 🛑 not running\${NC}"
  echo "  Start with: ds-launch"
fi
echo ""
EOF

# ds-update — pull latest + reinstall deps + restart
write_script ds-update <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$INSTALL_DIR}"
[ -d "\$DIR/.git" ] || { echo "❌ Not installed at \$DIR"; exit 1; }
cd "\$DIR" || exit 1

echo "→ Pulling latest..."
git pull --ff-only --quiet

echo "→ Updating dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --silent 2>/dev/null \
    || npm install --no-audit --no-fund --silent 2>/dev/null \
    || {
      echo "⚠️  Install failed, retrying without node-pty..."
      node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.dependencies["node-pty"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' 2>/dev/null
      npm install --no-audit --no-fund --silent
    }
else
  npm install --no-audit --no-fund --silent
fi

echo "✅ Updated. Run 'ds-restart' to apply."
EOF

ok "Shortcuts installed: ds-start ds-stop ds-restart ds-status ds-log ds-update ds-launch ds-doctor"

# ─── Widget shortcuts (Termux:Widget) ───
mkdir -p ~/.shortcuts
ln -sf "$BIN_DIR/ds-launch"  "$HOME/.shortcuts/🚀 DeepSeek"
ln -sf "$BIN_DIR/ds-start"   "$HOME/.shortcuts/🐳 DeepSeek Start"
ln -sf "$BIN_DIR/ds-stop"    "$HOME/.shortcuts/🛑 DeepSeek Stop"
ln -sf "$BIN_DIR/ds-restart" "$HOME/.shortcuts/🔄 DeepSeek Restart"
ln -sf "$BIN_DIR/ds-status"  "$HOME/.shortcuts/ℹ️  DeepSeek Status"
ln -sf "$BIN_DIR/ds-doctor"  "$HOME/.shortcuts/🩺 DeepSeek Doctor"
ok "Widget shortcuts created (~/.shortcuts/)"

# ─── Termux:Boot auto-start ───
BOOT_DIR="$HOME/.termux/boot"
if [ -d "$HOME/.termux" ] || [ -d "/data/data/com.termux/files/home/.termux" ]; then
  mkdir -p "$BOOT_DIR"
  cat > "$BOOT_DIR/00-deepseek" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
sleep 5
$BIN_DIR/ds-boot
EOF
  chmod +x "$BOOT_DIR/00-deepseek"
  ok "Boot hook installed (needs Termux:Boot app to activate)"
else
  warn "Skipping boot hook — install Termux:Boot, then re-run installer"
fi

# ─── Storage hint ───
if [ ! -d "$HOME/storage/external-1" ]; then
  echo ""
  warn "SD card access not configured"
  echo "   Run: termux-setup-storage   (enables SD-card backups)"
fi

echo ""
printf "${GREEN}╔═══════════════════════════════════════════╗${NC}\n"
printf "${GREEN}║${NC}   ✅ ${BOLD}Installation complete${NC}                 ${GREEN}║${NC}\n"
printf "${GREEN}╚═══════════════════════════════════════════╝${NC}\n"
echo ""
echo -e "${BOLD}Commands:${NC}"
echo "  ds-launch   →  start server + open browser"
echo "  ds-start    →  start server only"
echo "  ds-stop     →  stop server"
echo "  ds-restart  →  full restart"
echo "  ds-status   →  show uptime + version"
echo "  ds-log      →  tail live server log"
echo "  ds-update   →  pull latest + reinstall deps"
echo "  ds-doctor   →  full diagnostics"
echo ""
echo -e "${CYAN}Tip:${NC} add the ${BOLD}🚀 DeepSeek${NC} widget for one-tap launch (Termux:Widget from F-Droid)"
echo ""
echo -e "${CYAN}First-time setup:${NC} open the app, tap ${BOLD}Setup${NC} in the sidebar, paste your DeepSeek API key."
echo ""