#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# promote.sh — sandbox → production, gated on tests
#
# Replaces patch-all.sh / patch-index-sync.sh / patch-server-sync.sh.
# Those three scripts each copied a hand-maintained list of files and
# none of them checked that the result parsed. This one diffs the two
# checkouts, refuses to run if `npm test` fails, and copies only what
# actually changed.
#
# Usage:
#   scripts/promote.sh            # dry run: show what would change
#   scripts/promote.sh --apply    # actually copy
#   scripts/promote.sh --apply --with-android
#
# Layout assumed:
#   ~/projects/deepseek-editor-sandbox   (this repo, port 3002)
#   ~/projects/deepseek-editor           (production, port 3001)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SANDBOX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD="${DS_PROD_DIR:-$HOME/projects/deepseek-editor}"

APPLY=0
WITH_ANDROID=0
for arg in "$@"; do
  case "$arg" in
    --apply)        APPLY=1 ;;
    --with-android) WITH_ANDROID=1 ;;
    -h|--help)      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Paths that are sandbox-only and must never be promoted.
EXCLUDES=(
  "node_modules"
  ".git"
  ".patch-backup"
  ".chk"
  "ds-run.log"
  "ROADMAP.md"
  "scripts/promote.sh"
)

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$PROD" ] || die "production checkout not found: $PROD
Set DS_PROD_DIR=/path/to/deepseek-editor and retry."

say "sandbox:    $SANDBOX"
say "production: $PROD"
echo

# ── 1. gate on tests ───────────────────────────────────────────────
say "1. tests"
( cd "$SANDBOX" && npm test --silent ) || die "npm test failed — refusing to promote."
ok "npm test passed"

# ── 2. syntax-check every JS file that would move ──────────────────
say "2. syntax"
fail=0
while IFS= read -r f; do
  case "$f" in
    *.js)
      if ! node --check "$SANDBOX/$f" 2>/dev/null; then
        # ESM files need the module flag; retry as a module.
        if ! node --input-type=module --check < "$SANDBOX/$f" 2>/dev/null; then
          warn "syntax error: $f"; fail=1
        fi
      fi
      ;;
  esac
done < <(cd "$SANDBOX" && git ls-files 2>/dev/null || find . -type f -name '*.js' -not -path './node_modules/*')
[ "$fail" -eq 0 ] || die "syntax errors above — refusing to promote."
ok "all JS parses"

# ── 3. diff ────────────────────────────────────────────────────────
say "3. changes"
CHANGED=()
while IFS= read -r f; do
  skip=0
  for ex in "${EXCLUDES[@]}"; do
    case "$f" in "$ex"|"$ex"/*) skip=1 ;; esac
  done
  [ "$skip" -eq 1 ] && continue
  if [ ! -e "$PROD/$f" ] || ! cmp -s "$SANDBOX/$f" "$PROD/$f"; then
    CHANGED+=("$f")
  fi
done < <(cd "$SANDBOX" && find . -type f \
           -not -path './node_modules/*' -not -path './.git/*' \
           -not -path './.patch-backup/*' -not -path './.chk/*' \
           | sed 's|^\./||' | sort)

if [ "${#CHANGED[@]}" -eq 0 ]; then
  ok "nothing to promote — production is up to date"
  exit 0
fi

for f in "${CHANGED[@]}"; do
  if [ ! -e "$PROD/$f" ]; then
    printf '  \033[32m+\033[0m %s\n' "$f"
  else
    printf '  \033[33m~\033[0m %s\n' "$f"
  fi
done
echo
say "${#CHANGED[@]} file(s) differ"

# ── 4. apply ───────────────────────────────────────────────────────
if [ "$APPLY" -eq 0 ]; then
  echo
  warn "dry run — re-run with --apply to copy"
  exit 0
fi

say "4. copying"
for f in "${CHANGED[@]}"; do
  mkdir -p "$PROD/$(dirname "$f")"
  cp -p "$SANDBOX/$f" "$PROD/$f"
  ok "$f"
done

# ── 5. verify production still parses ──────────────────────────────
say "5. verify production"
( cd "$PROD" && node --check server.js ) || die "production server.js no longer parses!"
ok "production server.js parses"

echo
say "done — restart the production backend to pick up the changes:"
echo "  cd $PROD && node server.js"
