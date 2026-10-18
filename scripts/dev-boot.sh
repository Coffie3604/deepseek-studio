#!/data/data/com.termux/files/usr/bin/bash
# Boot the sandbox backend on an isolated port for local verification.
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-3002}"
export HOST="${HOST:-127.0.0.1}"
export DS_WORKSPACE="${DS_WORKSPACE:-$HOME/projects}"
mkdir -p "$DS_WORKSPACE"
exec node server.js
