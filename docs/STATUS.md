# Status — what exists, honestly

Last updated: milestone 1 (architecture & scaffold).

## IMPLEMENTED (real, tested)

| Area | What | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces, TypeScript 7 strict typecheck, shared tsconfig, pnpm catalog for shared versions | `pnpm typecheck` |
| Domain model | Status machine (20 statuses, 7 transition kinds), pipeline table, stage derivation, progress, available actions | `packages/core/src/*.test.ts` |
| Contracts | zod schemas: API inputs, StoryBeats, VoiceSettings, ShotDirection, QaFindings, InfographicSpec (mandatory source, finite numbers, approximate flags, reference checks) | `contracts.test.ts` |
| Cost math | Usage × rate card in micro-dollars, unpriced-usage reporting, exact sums | `cost.test.ts` |
| Database | Prisma 7 schema (21 tables, 21 enums), initial migration, timestamptz, UUIDv7, cascade rules, enum parity test vs core | `enum-parity.test.ts`, integration tests |
| Project service | Create (with master language version), enqueue, retry, approve/reject/flag, rewind; row-locked transactions; audit events; stale-job protection | `project-service.int.test.ts`, `runner.int.test.ts` |
| Job system | Postgres queue (`SKIP LOCKED`), runner with concurrency, heartbeat, exponential backoff, non-retryable errors, abandoned-job recovery, shutdown release, provider-call ledger | `runner.int.test.ts` |
| API | Fastify: health, projects (list/create/detail by id or slug), jobs (enqueue/get/retry), approvals, rewind; zod validation; error mapping; Basic auth; security headers; static dashboard + SPA fallback; graceful shutdown | `app.int.test.ts`, `env.test.ts`, manual SIGTERM test |
| Dashboard shell | Project list (title, status, progress, runtime, created, updated), create form, project page (9 stages, next actions, approval gate with notes, rewind, jobs with retry and results, cost, approvals, activity), MOCK banner/badges, live polling | Browser E2E (Playwright/Chromium): full pipeline click-through, no console errors |
| Seed | Idempotent *Tulip Mania* demo project (title, working title, category, style, 10–15 min, editorial brief) | `app.int.test.ts`, run twice in container |
| Deployment | Multi-stage Dockerfile, `railway.json` (validated against Railway's schema), release script (migrate + seed), non-root runtime, build-time check that bundled imports resolve | Docker build + container run against Postgres (see note) |
| Local dev | `docker-compose.yml` (Postgres + test DB), `.env.example`, `pnpm dev` (API + Vite with proxy) | |

Test counts at time of writing: **124 unit** (8 files) + **28 integration** (3 files), all passing — verified from a clean clone following the README.

Docker note: in the development sandbox, outbound TLS from inside Docker is
intercepted, so the image was built with a test-only copy of the Dockerfile
that adds two lines trusting the sandbox CA. The committed Dockerfile is
otherwise identical and needs no changes on Railway. A Railway deploy itself
has **not** been performed (no Railway account access from the sandbox).

## MOCKED (runs, clearly labelled MOCK, does no real work)

| Area | Mock behaviour |
|---|---|
| All 7 providers | See ARCHITECTURE.md §6. $0 cost, realistic usage, `MOCK` labels, `MOCK_FAIL` failure trigger |
| All 11 stage handlers | Call their provider interface once through the ledger and return a `{ mock: true, note: "No research was performed…" }` result. They create **no** research claims, stories, scripts, scenes, storyboards, shots, infographics, timelines, renders or QA reports |
| Storage | In-memory; contents vanish on restart |

## PLANNED (designed — interface/schema exists — not implemented)

- Real providers: Anthropic LLM, research (web search), ElevenLabs, Higgsfield, S3/R2 storage, FFmpeg + Remotion rendering, YouTube publishing
- Writing creative artifacts: tables for sources/claims/dossiers, story, script/scenes/narration, storyboard/shots, infographics, timelines, renders, QA reports exist but nothing writes them
- Standalone worker deployment (entry point exists, not deployed); BullMQ queue (interface designed)
- Per-shot child jobs for visual generation fan-out
- Language versions beyond the master (schema ready; no translation stage, no UI to add a language)

## NOT YET BUILT (no code, no schema beyond notes)

- Research engine, story architecture, script engine, script QA scores
- Narration generation, subtitles (SRT/VTT), audio mixing, sound design, music/SFX selection
- Visual director, continuity bibles (character/location/object/style), image/video generation
- Infographic renderer, editing/timeline engine, final render, automated QA
- Localization/translation, YouTube publishing
- Editing artifacts in the dashboard (the brief's EDIT control), "regenerate" shortcut, artifact viewers
- User accounts/roles (single shared Basic-auth credential for now)
- CI pipeline (tests run locally; no GitHub Actions workflow yet)
- Unit tests for timeline calculations and subtitle timing — those modules do not exist yet
