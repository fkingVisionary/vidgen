# syntax=docker/dockerfile:1
# Documentary Engine — production image (API + dashboard + embedded worker).
# Used by Railway (see railway.json) and runnable anywhere Docker runs.

ARG NODE_VERSION=22.22.0

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
# openssl: required by Prisma's schema engine (`prisma migrate deploy`).
# FFmpeg is NOT installed yet: it arrives with the real render provider.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.28.0 \
 && npm cache clean --force
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app

# ── build: install everything, generate the Prisma client, build web + api ──
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── runtime: production dependencies + build output only ─────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/database/package.json packages/database/
COPY --from=build /app/packages/pipeline/package.json packages/pipeline/
COPY --from=build /app/packages/providers/package.json packages/providers/
# Runtime deps of the API and its workspace packages (includes the prisma CLI for migrations).
RUN pnpm install --frozen-lockfile --prod --filter "@docengine/api..." \
 && pnpm store prune
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/database/prisma packages/database/prisma
COPY --from=build /app/packages/database/prisma.config.ts packages/database/
COPY scripts/release.sh scripts/
USER node
EXPOSE 3000
# Railway runs `sh scripts/release.sh` (migrations + idempotent seed) as the pre-deploy command.
CMD ["node", "apps/api/dist/server.js"]
