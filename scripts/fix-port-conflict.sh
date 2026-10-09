#!/data/data/com.termux/files/usr/bin/bash
# fix-port-conflict.sh
# Fixes process-scoping bug in ds-* launchers.
# Backups written to <file>.bak-<timestamp>.

set -e

BIN="/data/data/com.termux/files/usr/bin"
LIVE_DIR="${DS_INSTALL_DIR:-$HOME/projects/deepseek-editor}"
SANDBOX_DIR="$HOME/projects/deepseek-editor-sandbox"
SANDBOX_TOOL="$HOME/projects/_tools/ds-sandbox"
STAMP="$(date +%s)"

[ -d "$BIN" ]      || { echo "❌ $BIN not found"; exit 1; }
[ -d "$LIVE_DIR" ] || { echo "❌ live dir not found: $LIVE_DIR"; exit 1; }

echo "→ Backing up originals..."
for f in ds-start ds-stop ds-boot; do
  if [ -f "$BIN/$f" ]; then
    cp "$BIN/$f" "$BIN/$f.bak-$STAMP"
    echo "  $BIN/$f → $BIN/$f.bak-$STAMP"
  fi
done
if [ -f "$SANDBOX_TOOL" ]; then
  cp "$SANDBOX_TOOL" "$SANDBOX_TOOL.bak-$STAMP"
  echo "  $SANDBOX_TOOL → $SANDBOX_TOOL.bak-$STAMP"
fi

echo "→ Rewriting ds-stop (scoped kill)..."
cat > "$BIN/ds-stop" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$LIVE_DIR}"
KILLED=0
for pid in \$(pgrep -f "node server.js" 2>/dev/null); do
  cwd=\$(readlink /proc/\$pid/cwd 2>/dev/null)
  if [ "\$cwd" = "\$DIR" ]; then
    kill -TERM "\$pid" 2>/dev/null && KILLED=\$((KILLED+1))
  fi
done
if [ "\$KILLED" -gt 0 ]; then
  echo "🛑 DeepSeek Studio (live) stopped"
else
  echo "ℹ️  Live server was not running"
fi
EOF
chmod +x "$BIN/ds-stop"

echo "→ Rewriting ds-start (scoped kill)..."
cat > "$BIN/ds-start" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$LIVE_DIR}"
[ -f "\$DIR/server.js" ] || { echo "❌ server.js not found at \$DIR"; exit 1; }
cd "\$DIR" || exit 1

for pid in \$(pgrep -f "node server.js" 2>/dev/null); do
  cwd=\$(readlink /proc/\$pid/cwd 2>/dev/null)
  if [ "\$cwd" = "\$DIR" ]; then kill -9 "\$pid" 2>/dev/null || true; fi
done
sleep 1

setsid nohup node server.js > "\$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true

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
chmod +x "$BIN/ds-start"

echo "→ Rewriting ds-boot (scoped kill)..."
cat > "$BIN/ds-boot" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DIR="\${DS_INSTALL_DIR:-$LIVE_DIR}"
[ -f "\$DIR/server.js" ] || exit 1
cd "\$DIR" || exit 1
curl -sf -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null && exit 0
for pid in \$(pgrep -f "node server.js" 2>/dev/null); do
  cwd=\$(readlink /proc/\$pid/cwd 2>/dev/null)
  if [ "\$cwd" = "\$DIR" ]; then kill -9 "\$pid" 2>/dev/null || true; fi
done
sleep 1
setsid nohup node server.js > "\$HOME/.ds-studio.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
EOF
chmod +x "$BIN/ds-boot"

if [ -f "$SANDBOX_TOOL" ] && grep -q 'pkill -f "node server.js"' "$SANDBOX_TOOL"; then
  echo "→ Patching $SANDBOX_TOOL (scoped kill)..."
  sed -i "s|pkill -f \"node server.js\"|for pid in \$(pgrep -f \"node server.js\" 2>/dev/null); do cwd=\$(readlink /proc/\$pid/cwd 2>/dev/null); [ \"\$cwd\" = \"$SANDBOX_DIR\" ] \&\& kill -9 \"\$pid\" 2>/dev/null; done|" "$SANDBOX_TOOL"
  chmod +x "$SANDBOX_TOOL"
else
  echo "→ ds-sandbox tool already scoped or not found — no change"
fi

echo ""
echo "✓ done — all launcher scripts scoped by directory"
echo ""
echo "Now test:"
echo "  pkill -9 -f \"node server.js\"; sleep 2"
echo "  ds-start"
echo "  ~/projects/_tools/ds-sandbox"
echo "  curl -s http://127.0.0.1:3001/api/version | grep -o '\"version\":\"[^\"]*\"'"
echo "  curl -s http://127.0.0.1:3002/api/version | grep -o '\"version\":\"[^\"]*\"'"
echo "  ds-restart"
echo "  curl -s http://127.0.0.1:3002/api/version | grep -o '\"version\":\"[^\"]*\"'"
