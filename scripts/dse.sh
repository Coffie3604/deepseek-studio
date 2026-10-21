#!/usr/bin/env bash
# dse — deepseek-editor control command for Termux.
#
#   dse            restart the server (default)
#   dse restart    restart the server
#   dse start      start if not already running
#   dse stop       stop the server (also pauses the watchdog)
#   dse status     show whether it is running + health
#   dse log [n]    tail the server log
#
# Works from any directory.

set -u

PROJECT="${DSE_PROJECT:-$HOME/projects/deepseek-editor}"
PORT="${PORT:-3001}"
LOG="$PROJECT/server.log"
BASE="http://127.0.0.1:$PORT"

if [ ! -d "$PROJECT" ]; then
  echo "!! project not found: $PROJECT" >&2
  echo "   set DSE_PROJECT=/path/to/deepseek-editor" >&2
  exit 1
fi

# Scan /proc for processes whose cmdline matches a glob.
# Usage: _scan <glob>
_scan() {
  local pat="$1" p c
  for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    [ "$p" = "$$" ] && continue
    [ -r "/proc/$p/cmdline" ] || continue
    c=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) || continue
    case "$c" in
      $pat)
        # Re-check: the process may have exited since we scanned /proc.
        [ -r "/proc/$p/cmdline" ] && echo "$p"
        ;;
    esac
  done
}

server_pids()   { _scan '*node*server.js*'; }
watchdog_pids() { _scan '*ds-watchdog.sh*'; }

health() {
  curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" 2>/dev/null
}

do_stop() {
  local pids wd
  wd=$(watchdog_pids)
  if [ -n "$wd" ]; then
    echo "  pausing watchdog (pid $(echo $wd)) so it won't respawn"
    for p in $wd; do kill "$p" 2>/dev/null; done
    sleep 0.5
  fi
  pids=$(server_pids)
  if [ -z "$pids" ]; then
    echo "  not running"
    return 0
  fi
  for p in $pids; do
    echo "  stopping pid $p"
    kill "$p" 2>/dev/null
  done
  for i in $(seq 1 10); do
    [ -z "$(server_pids)" ] && return 0
    sleep 0.3
  done
  for p in $(server_pids); do
    echo "  force-killing pid $p"
    kill -9 "$p" 2>/dev/null
  done
  sleep 0.5
}

do_start() {
  cd "$PROJECT" || return 1
  nohup node server.js >"$LOG" 2>&1 &
  local newpid=$!
  echo "  pid=$newpid  log=$LOG"
  for i in $(seq 1 30); do
    if [ "$(health)" = "200" ]; then
      echo "  listening on $BASE after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "!! server did not become healthy on $BASE" >&2
  echo "---- last 40 log lines ----" >&2
  tail -n 40 "$LOG" 2>/dev/null >&2
  return 1
}

case "${1:-restart}" in
  restart)
    echo "== stopping =="
    do_stop
    echo "== starting =="
    do_start || exit 1
    echo "== ok: $BASE =="
    ;;
  start)
    if [ "$(health)" = "200" ]; then
      echo "  already running on $BASE"
      exit 0
    fi
    echo "== starting =="
    do_start || exit 1
    echo "== ok: $BASE =="
    ;;
  stop)
    echo "== stopping =="
    do_stop
    echo "== stopped =="
    ;;
  status)
    pids=$(server_pids)
    wd=$(watchdog_pids)
    if [ -z "$pids" ]; then
      echo "  stopped"
      [ -n "$wd" ] && echo "  (watchdog still running: pid $(echo $wd))"
      exit 1
    fi
    echo "  running: pid(s) $(echo $pids)"
    echo "  health:  $(health)  ($BASE)"
    [ -n "$wd" ] && echo "  watchdog: pid $(echo $wd)"
    ;;
  log)
    tail -n "${2:-40}" "$LOG"
    ;;
  *)
    echo "usage: dse [restart|start|stop|status|log]" >&2
    exit 2
    ;;
esac
