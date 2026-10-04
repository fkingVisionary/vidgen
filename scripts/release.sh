#!/bin/sh
# Release step, run before each deploy goes live (Railway pre-deploy command).
#  1. Apply pending database migrations (safe to re-run; never resets data).
#  2. Seed the demo project if missing (idempotent; never modifies an existing one).
set -eu
cd "$(dirname "$0")/.."

echo "[release] applying database migrations"
(cd packages/database && ./node_modules/.bin/prisma migrate deploy)

echo "[release] seeding demo project (idempotent)"
node apps/api/dist/seed.js

echo "[release] done"
