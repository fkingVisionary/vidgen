# Documentary Engine

AI-assisted production system for premium historical & economic documentaries
(10–15 minutes, YouTube). Research → story → script → narration → storyboard →
visuals & infographics → edit → QA → render → publish, with a human approving
every important step.

**Current state: V1, milestone 2 — the research engine.** The pipeline,
database, job system, provider abstractions and dashboard are real and tested
(milestone 1). The **Research** stage is real when Anthropic (Claude) and
Tavily are configured: it plans questions, searches, retrieves full texts,
extracts verbatim-verified evidence, builds a versioned dossier of claims with
verdicts and citations, and stops at a quality gate for human review. Every
later stage (story, script, voice, visuals, edit, publish) is still a clearly
labelled **MOCK**. First test episode: *Tulip Mania — The Bubble That Became a
Legend* (seeded, status *Idea*).

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, data model, providers, jobs, decisions
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Railway, environment variables, operations
- [docs/STATUS.md](docs/STATUS.md) — implemented vs mocked vs planned vs not built

## Stack

TypeScript (Node 22) · Fastify 5 · PostgreSQL 16 + Prisma 7 · React 19 + Vite 8
+ Tailwind 4 · zod · pino · Vitest · Docker · Railway · Anthropic (Claude) ·
Tavily (search + extraction). Planned: ElevenLabs (voice), Higgsfield (video),
Cloudflare R2 (storage), FFmpeg + Remotion (rendering), YouTube Data API.

## Repository

```
apps/api           Fastify API + dashboard host + embedded job worker (bundled with esbuild)
apps/web           Dashboard shell
packages/core      Domain: statuses, pipeline/state machine, contracts, cost math (browser-safe)
packages/database  Prisma schema, migrations, client
packages/providers Provider interfaces, MOCK implementations, registry, contract tests
packages/pipeline  Project state service, job queue & runner, stage handler contract
modules/research   The RESEARCH stage: plan → search → retrieve → read → synthesise → quality gate
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
| `pnpm research:run [slug]` | Run real research for a project (default `tulip-mania`) to completion and print the evidence report |
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

With mock providers, **Run Research** on a project page starts the research
phase; the MOCK job finishes in milliseconds and the project waits at *Research review*. Approve,
reject or flag with notes, then continue stage by stage. Every job, provider
call and decision is recorded (Jobs, Cost, Approvals, Activity panels). A mock
publish deliberately leaves the project at *Approved*: only a real publishing
provider can mark it *Published*. Use a throwaway project for this — the
seeded Tulip Mania project is meant for the real episode.

## Running real research

Set in `.env` (or Railway Variables — never in code):

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=…
RESEARCH_PROVIDER=tavily
TAVILY_API_KEY=…              # or TAVILY_ACCESS_MODE=keyless for Tavily's free, rate-limited access
TAVILY_USD_PER_CREDIT=0.008   # your plan's price, for cost estimates
RESEARCH_MAX_COST_USD=40      # a run stops once its recorded cost passes this
```

Then either click **Run Research** on the project page, or from a shell:

```bash
pnpm research:run tulip-mania                   # development
node apps/api/dist/research.js tulip-mania      # production image / Railway shell
```

`GET /api/health` lists the stages that are real (`realStages`). Progress
appears in the project's Activity panel. (A full run with real Claude has not
been timed yet; expect tens of minutes — about 45 documents are read.) The
dossier opens at **Research dossier** on the project page: claims with
verdicts (ESTABLISHED / PROBABLE / DISPUTED / UNVERIFIED / MYTH), supporting
and contradicting citations with verified quotes, sources by type, open
questions, the quality gate and the run's cost. Approve, reject or flag it
there; nothing proceeds without a human decision.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Short version: Railway project
from this repo + PostgreSQL; set `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
`NODE_ENV=production`, `DASHBOARD_PASSWORD`; generate a domain.
