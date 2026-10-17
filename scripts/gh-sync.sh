#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────
# DeepSeek Studio — GitHub sync helper for Termux
#
# A thin, dependency-light CLI that talks to the running DeepSeek Studio
# backend (default http://127.0.0.1:3001) so you can sign in, verify,
# and sync a project to GitHub straight from a Termux shell.
#
# Usage:
#   scripts/gh-sync.sh status                 # who am I signed in as?
#   scripts/gh-sync.sh login                  # OAuth device-flow sign in
#   scripts/gh-sync.sh token <PAT>            # save + verify a personal token
#   scripts/gh-sync.sh verify                 # re-check the stored token
#   scripts/gh-sync.sh logout                 # clear the stored token
#   scripts/gh-sync.sh repos                  # list your GitHub repos
#   scripts/gh-sync.sh sync <project> [msg]   # stage → commit → pull → push
#   scripts/gh-sync.sh clone <owner/repo> [dir]
#
# Env:
#   DS_API   backend base URL (default http://127.0.0.1:3001)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

API="${DS_API:-http://127.0.0.1:3001}"
CMD="${1:-status}"
shift || true

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
info(){ printf '\033[36m%s\033[0m\n' "$*"; }

# Minimal JSON field extractor (no jq dependency).
jget() {
  # jget <key> ; reads JSON from stdin
  node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const o=JSON.parse(s);const k=process.argv[1];
        const v=k.split(".").reduce((a,p)=>a==null?a:a[p],o);
        process.stdout.write(v==null?"":String(v));}catch(e){process.stdout.write("");}
    });' "$1"
}

api() {
  # api <METHOD> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$API$path" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$API$path"
  fi
}

require_backend() {
  curl -fsS "$API/api/health" >/dev/null 2>&1 \
    || die "Backend not reachable at $API — start it with: npm start"
}

case "$CMD" in
  status)
    require_backend
    out="$(api GET /api/github/status)"
    if [ "$(printf '%s' "$out" | jget connected)" = "true" ]; then
      ok "Signed in as $(printf '%s' "$out" | jget login) ($(printf '%s' "$out" | jget name))"
    else
      info "Not signed in. Run: $0 login"
    fi
    ;;

  login)
    require_backend
    start="$(api POST /api/github/device/start '{}')"
    code="$(printf '%s' "$start" | jget userCode)"
    uri="$(printf '%s' "$start" | jget verificationUriComplete)"
    dcode="$(printf '%s' "$start" | jget deviceCode)"
    [ -n "$dcode" ] || die "Could not start device flow: $start"
    info "Open: $uri"
    info "Enter code: $code"
    command -v termux-open-url >/dev/null 2>&1 && termux-open-url "$uri" || true
    printf 'Waiting for authorization'
    while true; do
      sleep 5
      poll="$(api POST /api/github/device/poll "{\"deviceCode\":\"$dcode\"}")"
      st="$(printf '%s' "$poll" | jget status)"
      case "$st" in
        authorized) printf '\n'; ok "Signed in as $(printf '%s' "$poll" | jget user.login)"; break ;;
        pending)    printf '.' ;;
        expired)    printf '\n'; die "Code expired — try again" ;;
        denied)     printf '\n'; die "Authorization denied" ;;
        *)          printf '\n'; die "Error: $poll" ;;
      esac
    done
    ;;

  token)
    require_backend
    [ -n "${1:-}" ] || die "Usage: $0 token <PAT>"
    out="$(api POST /api/github/token "{\"token\":\"$1\"}")"
    ok "Token saved — signed in as $(printf '%s' "$out" | jget user.login)"
    ;;

  verify)
    require_backend
    out="$(api POST /api/github/verify '{}')"
    if [ "$(printf '%s' "$out" | jget ok)" = "true" ]; then
      ok "Token valid — $(printf '%s' "$out" | jget user.login)"
      scopes="$(printf '%s' "$out" | jget scopes)"
      [ -n "$scopes" ] && info "Scopes: $scopes"
    else
      die "Token invalid: $(printf '%s' "$out" | jget error)"
    fi
    ;;

  logout)
    require_backend
    api POST /api/github/signout '{}' >/dev/null
    ok "Signed out (token + git credential store cleared)"
    ;;

  repos)
    require_backend
    api GET '/api/github/repos?per_page=100' \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const o=JSON.parse(s);(o.repos||[]).forEach(r=>
            console.log((r.private?"🔒":"  ")+" "+r.fullName+"  ["+r.defaultBranch+"]"));});'
    ;;

  sync)
    require_backend
    proj="${1:-}"; msg="${2:-Sync from Termux $(date '+%Y-%m-%d %H:%M')}"
    [ -n "$proj" ] || die "Usage: $0 sync <project> [commit-message]"
    info "Syncing '$proj' → GitHub…"
    out="$(api POST /api/git/sync "{\"cwd\":\"$proj\",\"message\":\"$msg\",\"autoCommit\":true}")"
    printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const o=JSON.parse(s);
        (o.steps||[]).forEach(st=>console.log("  ["+st.status+"] "+st.step+(st.detail?" — "+st.detail:"")));
        console.log(o.ok?"\n✓ sync complete":"\n✗ sync failed");}catch(e){console.log(s);}});'
    ;;

  clone)
    require_backend
    slug="${1:-}"; dir="${2:-}"
    [ -n "$slug" ] || die "Usage: $0 clone <owner/repo> [dir]"
    info "Cloning $slug…"
    out="$(api POST /api/git/clone "{\"url\":\"https://github.com/$slug.git\",\"dir\":\"$dir\"}")"
    ok "Cloned to $(printf '%s' "$out" | jget dir)"
    ;;

  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
