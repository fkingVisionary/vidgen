# Documentary Engine

AI-assisted production system for premium historical & economic documentaries
(10–15 minutes, YouTube). Research → story → script → narration → storyboard →
visuals & infographics → edit → QA → render → publish, with a human approving
every important step.

**Current state: V1, milestone 1 — architecture and scaffold.** The pipeline,
database, job system, provider abstractions and dashboard shell are real and
tested; every AI/voice/video/render/publishing provider is a clearly labelled
**MOCK**. No documentary content is produced yet. First test episode:
*Tulip Mania — The Bubble That Became a Legend* (seeded, status *Idea*).

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, data model, providers, jobs, decisions
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Railway, environment variables, operations
- [docs/STATUS.md](docs/STATUS.md) — implemented vs mocked vs planned vs not built

## Stack

TypeScript (Node 22) · Fastify 5 · PostgreSQL 16 + Prisma 7 · React 19 + Vite 8
+ Tailwind 4 · zod · pino · Vitest · Docker · Railway. Planned: Anthropic
(LLM), ElevenLabs (voice), Higgsfield (video), Cloudflare R2 (storage), FFmpeg
+ Remotion (rendering), YouTube Data API.

## Repository

```
apps/api           Fastify API + dashboard host + embedded job worker (bundled with esbuild)
apps/web           Dashboard shell
packages/core      Domain: statuses, pipeline/state machine, contracts, cost math (browser-safe)
packages/database  Prisma schema, migrations, client
packages/providers Provider interfaces, MOCK implementations, registry, contract tests
packages/pipeline  Project state service, job queue & runner, stage handler contract
modules/           Real stage implementations (from milestone 2)
docs/  scripts/  test/
```

## Local setup

Prerequisites: **Node 22.12+**, **pnpm 10** (`corepack enable` picks the pinned
version, or `npm i -g pnpm@10.28.0`), and **PostgreSQL 16** — via Docker
(below) or any local install.

```bash
git clone https://github.com/fkingVisionary/vidgen.git && cd vidgen
pnpm install
cp .env.example .env               # defaults work with docker-compose; all providers = mock

docker compose up -d postgres      # Postgres on :5432 (+ docengine_test DB for integration tests)

pnpm db:generate                   # generate the Prisma client
pnpm db:deploy                     # apply migrations
pnpm db:seed                       # create the Tulip Mania demo project (idempotent)

pnpm dev                           # API on :3000 + dashboard on :5173 (proxying /api)
```

Open <http://localhost:5173>. No credentials are needed locally unless you set
`DASHBOARD_PASSWORD` in `.env`.

Using your own Postgres instead of Docker: create a database, point
`DATABASE_URL` at it, and (for integration tests) create a second database
whose name contains `test` for `TEST_DATABASE_URL`.

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API (tsx watch) + dashboard (Vite) |
| `pnpm test` | Unit tests — no database, no network |
| `pnpm test:int` | Integration tests against `TEST_DATABASE_URL` (migrated automatically; tables are truncated) |
| `pnpm typecheck` | Strict type check of every package |
| `pnpm build` | Prisma client + dashboard + API bundle (`apps/api/dist`) |
| `pnpm release` | Production pre-deploy step: migrate + seed |
| `pnpm start` | Run the production build on `PORT` (default 3000), serving the dashboard |
| `pnpm start:worker` | Standalone worker (optional; normally embedded) |
| `pnpm db:migrate` | Create/apply a migration after editing `schema.prisma` |
| `pnpm db:studio` | Browse the database |

### Production build locally

```bash
pnpm build && pnpm release && pnpm start      # http://localhost:3000
# or the exact image Railway runs:
docker build -t docengine .
docker run --rm -e DATABASE_URL=… docengine sh scripts/release.sh
docker run --rm -p 3000:3000 -e DATABASE_URL=… -e NODE_ENV=production -e DASHBOARD_PASSWORD=… docengine
```

(From inside a container, a Postgres on your machine is `host.docker.internal`,
not `localhost`.)

## Trying the pipeline

On a project page, **Run Research** starts the research phase; the MOCK job
finishes in milliseconds and the project waits at *Research review*. Approve,
reject or flag with notes, then continue stage by stage. Every job, provider
call and decision is recorded (Jobs, Cost, Approvals, Activity panels). A mock
publish deliberately leaves the project at *Approved*: only a real publishing
provider can mark it *Published*. Use a throwaway project for this — the
seeded Tulip Mania project is meant for the real episode.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Short version: Railway project
from this repo + PostgreSQL; set `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
`NODE_ENV=production`, `DASHBOARD_PASSWORD`; generate a domain.
