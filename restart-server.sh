#!/data/data/com.termux/files/usr/bin/bash
# Restart the deepseek-editor server cleanly.
# Kills any stale node server.js, starts one instance, verifies it listens.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3001}"
LOG="$PWD/server.log"

echo "== killing stale server.js processes =="
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$p" = "$$" ] && continue
  c=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
  case "$c" in
    *server.js*)
      echo "  kill -9 $p: $c"
      kill -9 "$p" 2>/dev/null
      ;;
  esac
done

sleep 1

echo "== starting server =="
nohup node server.js >"$LOG" 2>&1 &
NEWPID=$!
echo "  pid=$NEWPID log=$LOG"

echo "== waiting for port $PORT =="
ok=0
for i in $(seq 1 30); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    ok=1
    echo "  listening after ${i}s"
    break
  fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "!! server did NOT bind port $PORT"
  echo "---- last 40 log lines ----"
  tail -n 40 "$LOG" 2>/dev/null
  exit 1
fi

echo "== health check =="
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
echo "  GET / -> $code"
[ "$code" = "200" ] || { echo "!! unexpected status"; tail -n 40 "$LOG"; exit 1; }

echo "== ok =="
