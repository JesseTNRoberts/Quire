#!/usr/bin/env bash
# Full browser test run from scratch: builds a sample book, starts a fake GitHub and the app
# (wrangler dev, sign-in off), seeds the book, then runs every browser test in each engine.
#   bash test/e2e.sh                 # chromium
#   BROWSERS="chromium webkit" bash test/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BROWSERS=${BROWSERS:-chromium}
W=$(mktemp -d)
node test/make-fixture.mjs "$W/sync" >/dev/null
node scripts/migrate.mjs "$W/sync" "$W/repo" >/dev/null
printf 'DEV_NO_AUTH=1\nSNAPSHOT_MINUTES=30\nGITHUB_API=http://127.0.0.1:8799\nGITHUB_TOKEN=test-token\n' > .dev.vars
rm -rf .wrangler/state
setsid node test/mock-github.mjs "$W/repo" 8799 > "$W/github.log" 2>&1 & GH=$!
WRANGLER_SEND_METRICS=false setsid npx wrangler dev --port 8787 --ip 127.0.0.1 > "$W/wrangler.log" 2>&1 & WD=$!
# Stop both servers and everything they started (wrangler runs a child process).
trap 'kill -- -$GH -$WD 2>/dev/null || true' EXIT
for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:8787/api/me && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:8787/api/me || { echo "app did not start:"; tail -30 "$W/wrangler.log"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=app did not start::$(tail -n 20 "$W/wrangler.log" | awk 'BEGIN{ORS="%0A"} {print}')"; exit 1; }
# Run one test; on failure, show its output and (on GitHub) record it as an annotation.
run() {
  local name="$1"; shift
  if ! "$@" > "$W/out.txt" 2>&1; then
    cat "$W/out.txt"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      msg=$( { tail -n 25 "$W/out.txt"; echo "--- app log ---"; tail -n 12 "$W/wrangler.log"; } | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}')
      echo "::error title=$name failed::$msg"
    fi
    exit 1
  fi
  cat "$W/out.txt"
}
seed() {
  curl -sf -XPOST http://127.0.0.1:8787/api/books -d '{"slug":"keeper","title":"The Keeper’s Ledger"}' >/dev/null
  curl -sf -XPOST http://127.0.0.1:8787/api/book/keeper/import -d '{"owner":"o","repo":"r","force":true,"title":"The Keeper’s Ledger"}' >/dev/null
}
seed
run "connector" node test/mcp.e2e.mjs http://127.0.0.1:8787 /mcp
for B in $BROWSERS; do
  echo "== $B"; seed
  run "sync ($B)" env BROWSER=$B node test/ui.test.cjs
  seed
  run "features ($B)" env BROWSER=$B node test/features.e2e.cjs
done
echo "ALL E2E OK"
