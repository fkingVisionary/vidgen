#!/bin/sh
# Browser QA of the Storyboard page and the visual profile library, every
# provider MOCK and a scripted model (nothing is paid, no key is read, no
# picture is generated): builds the dashboard, seeds a throwaway database
# (scripts/ui/storyboard-fixture.ts), serves it with the job worker, and
# clicks through the pages at 1280, 412 and 360 px (scripts/ui/storyboard-ui.mjs).
# Needs PostgreSQL (DATABASE_URL, from .env if present), psql, and Playwright
# with Chromium (PLAYWRIGHT_MODULE, or a global install). Screenshots and the
# server log go to STORYBOARD_UI_OUT.
#
#   sh scripts/ui/storyboard-ui.sh                            # build, seed, check
#   STORYBOARD_UI_SKIP_BUILD=1 sh scripts/ui/storyboard-ui.sh # reuse apps/web/dist
set -eu
cd "$(dirname "$0")/../.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB="${STORYBOARD_UI_DB:-docengine_storyboard_ui}"
# It is dropped and created again: only a throwaway database (the fixture refuses others too).
case "$DB" in
  *ui*) ;;
  *) echo "[storyboard-ui] STORYBOARD_UI_DB must name a throwaway database (its name contains \"ui\"): $DB"; exit 1 ;;
esac
URL="${DATABASE_URL%/*}/$DB"
PORT="${STORYBOARD_UI_PORT:-3103}"
OUT="${STORYBOARD_UI_OUT:-${TMPDIR:-/tmp}/storyboard-ui}"
mkdir -p "$OUT"

if [ "${STORYBOARD_UI_SKIP_BUILD:-}" != 1 ]; then
  echo "[storyboard-ui] building the dashboard"
  pnpm --filter @docengine/web build > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }
fi

echo "[storyboard-ui] seeding $DB"
PGOPTIONS="-c client_min_messages=warning" psql "$DATABASE_URL" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" > /dev/null
(cd packages/database && DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy > "$OUT/migrate.log" 2>&1) || { cat "$OUT/migrate.log"; exit 1; }

UI_DATABASE_URL="$URL" PORT="$PORT" ./node_modules/.bin/tsx scripts/ui/storyboard-fixture.ts > "$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2> /dev/null || true' EXIT INT TERM
i=0
until grep -q '^READY ' "$OUT/server.log"; do
  i=$((i + 1))
  if [ $i -gt 600 ] || ! kill -0 $SERVER 2> /dev/null; then
    echo "[storyboard-ui] the fixture did not start:"
    cat "$OUT/server.log"
    exit 1
  fi
  sleep 0.5
done
FIXTURE=$(grep '^READY ' "$OUT/server.log" | head -1 | cut -c7-)
echo "[storyboard-ui] fixture $FIXTURE"

BASE="http://127.0.0.1:$PORT" FIXTURE="$FIXTURE" OUT="$OUT" node scripts/ui/storyboard-ui.mjs
