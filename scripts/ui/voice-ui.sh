#!/bin/sh
# Browser QA of the Voice page, MOCK voice only (nothing is paid, no key is read):
# builds the dashboard, seeds a throwaway database (scripts/ui/voice-fixture.ts),
# serves it with the job worker, and clicks through the page at 360, 412 and
# 1280 px (scripts/ui/voice-ui.mjs). Needs PostgreSQL (DATABASE_URL, from .env
# if present), psql, and Playwright with Chromium (PLAYWRIGHT_MODULE, or a global
# install). Screenshots and the server log go to VOICE_UI_OUT.
#
#   sh scripts/ui/voice-ui.sh                       # build, seed, check
#   VOICE_UI_SKIP_BUILD=1 sh scripts/ui/voice-ui.sh # reuse apps/web/dist
set -eu
cd "$(dirname "$0")/../.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB="${VOICE_UI_DB:-docengine_voice_ui}"
# It is dropped and created again: only a throwaway database (the fixture refuses others too).
case "$DB" in
  *ui*) ;;
  *) echo "[voice-ui] VOICE_UI_DB must name a throwaway database (its name contains \"ui\"): $DB"; exit 1 ;;
esac
URL="${DATABASE_URL%/*}/$DB"
PORT="${VOICE_UI_PORT:-3102}"
OUT="${VOICE_UI_OUT:-${TMPDIR:-/tmp}/voice-ui}"
mkdir -p "$OUT"

if [ "${VOICE_UI_SKIP_BUILD:-}" != 1 ]; then
  echo "[voice-ui] building the dashboard"
  pnpm --filter @docengine/web build > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }
fi

echo "[voice-ui] seeding $DB"
PGOPTIONS="-c client_min_messages=warning" psql "$DATABASE_URL" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" > /dev/null
(cd packages/database && DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy > "$OUT/migrate.log" 2>&1) || { cat "$OUT/migrate.log"; exit 1; }

UI_DATABASE_URL="$URL" PORT="$PORT" ./node_modules/.bin/tsx scripts/ui/voice-fixture.ts > "$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2> /dev/null || true' EXIT INT TERM
i=0
until grep -q '^READY ' "$OUT/server.log"; do
  i=$((i + 1))
  if [ $i -gt 360 ] || ! kill -0 $SERVER 2> /dev/null; then
    echo "[voice-ui] the fixture did not start:"
    cat "$OUT/server.log"
    exit 1
  fi
  sleep 0.5
done
FIXTURE=$(grep '^READY ' "$OUT/server.log" | head -1 | cut -c7-)
echo "[voice-ui] fixture $FIXTURE"

BASE="http://127.0.0.1:$PORT" FIXTURE="$FIXTURE" OUT="$OUT" node scripts/ui/voice-ui.mjs
