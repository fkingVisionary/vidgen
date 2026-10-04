# Status — what exists, honestly

Last updated: milestone 2 (research engine), after the first live deployment and research run (2026-10-04).

## IMPLEMENTED (real, tested)

| Area | What | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces, TypeScript 7 strict typecheck, shared tsconfig, pnpm catalog for shared versions | `pnpm typecheck` |
| Domain model | Status machine (20 statuses, 7 transition kinds), pipeline table, stage derivation, progress, available actions | `packages/core/src/*.test.ts` |
| Contracts | zod schemas: API inputs, StoryBeats, VoiceSettings, ShotDirection, QaFindings, InfographicSpec (mandatory source, finite numbers, approximate flags, reference checks) | `contracts.test.ts` |
| Cost math | Usage × rate card in micro-dollars, unpriced-usage reporting, exact sums | `cost.test.ts` |
| Database | Prisma 7 schema (22 tables, 25 enums), three migrations (initial; research engine; job checkpoint), timestamptz, UUIDv7, cascade rules, enum parity test vs core | `enum-parity.test.ts`, integration tests |
| Project service | Create (with master language version), enqueue, retry, approve/reject/flag, rewind; row-locked transactions; audit events; stale-job protection | `project-service.int.test.ts`, `runner.int.test.ts` |
| Job system | Postgres queue (`SKIP LOCKED`), runner with concurrency, heartbeat, exponential backoff, non-retryable errors, abandoned-job recovery, shutdown release, provider-call ledger | `runner.int.test.ts` |
| API | Fastify: health, projects (list/create/detail by id or slug), jobs (enqueue/get/retry), approvals, rewind; zod validation; error mapping; Basic auth; security headers; static dashboard + SPA fallback; graceful shutdown | `app.int.test.ts`, `env.test.ts`, manual SIGTERM test |
| Dashboard shell | Project list (title, status, progress, runtime, created, updated), create form, project page (9 stages, next actions, approval gate with notes, rewind, jobs with retry and results, cost, approvals, activity), MOCK banner/badges, live polling | Browser E2E (Playwright/Chromium): full pipeline click-through, no console errors |
| Seed | Idempotent *Tulip Mania* demo project (title, working title, category, style, 10–15 min, editorial brief) | `app.int.test.ts`, run twice in container |
| Deployment | Multi-stage Dockerfile, release script (migrate + seed) as Railway pre-deploy command, non-root runtime, build-time check that bundled imports resolve. Railway: one app service + PostgreSQL, settings in DEPLOYMENT.md (`railway.json` is kept but no longer read by Railway) | **Live on Railway**: migrations, seed, health check, Basic auth (401 without password), auto-deploy on push |
| Local dev | `docker-compose.yml` (Postgres + test DB), `.env.example`, `pnpm dev` (API + Vite with proxy) | |
| **Tavily ResearchProvider** (M2) | Search (advanced depth, preferred/excluded domains, published dates, scores) and full-text extraction in batches; credits → estimated cost; keyless mode; retryable vs permanent errors | `tavily.test.ts` (fake HTTP) + **live** contract and discovery/retrieval runs against Tavily (keyless, $0) |
| **Anthropic AIProvider** (M2) | Streaming Messages API, structured outputs from zod (re-validated) with an automatic schema-in-instructions fallback when the API rejects a schema as too complex, adaptive thinking + effort, prompt caching, refusal fallback, token usage → estimated cost by served model, refusal/max-tokens/context errors | `anthropic.test.ts` with an injected client; **live** on Railway (plan, triage, 41 reads, synthesis, review) |
| **Research stage** (M2) | Plan → discover → triage → retrieve (+ open-access fallback, duplicate detection) → read (verbatim quote verification) → synthesise → deterministic verdict rules → coherence review → quality gate → versioned dossier; text cleaning (NUL/control characters); saved progress so retries resume instead of repeating paid steps; cost ceiling; progress events | `research.int.test.ts` (scripted fake providers, real Postgres, incl. resume after failures), unit tests. **Live run on Railway** (below) |
| **Dossier API + viewer** (M2) | `GET /api/projects/:id/research[?version=N]`; dashboard page with versions, gate, cost, approval panel, verdict summary, claims (filters, popular version, supporting/contradicting citations with quotes), sources, story material, questions & gaps, quality report | `app.int.test.ts`; Playwright screenshots of the viewer on a fake-provider dossier |
| **Cost accounting** (M2) | Ledger rows carry `cost_basis` (VENDOR_REPORTED / ESTIMATED / UNPRICED / MOCK), provider request id, cost note; failed calls keep reported usage; project cost card shows estimated vs reported, unpriced calls, per-provider totals | `context` / `app.int.test.ts` |
| `pnpm research:run` (M2) | CLI: run research for a project to completion and print the evidence report | Container run (refuses clearly without credentials) |

Test counts at time of writing: **214 unit** (13 files) + **35 integration** (4 files), all passing.

## FIRST LIVE RUN (Railway, 2026-10-04)

Project *Tulip Mania*, real Claude (`claude-opus-5-5`) and Tavily (API key):

| | |
|---|---|
| Discovery | 12 questions, 48 searches → 265 candidate sources |
| Selection | 44 selected → 41 unique documents retrieved and read |
| Evidence | 666 quotes verified verbatim against the retrieved text, 16 rejected |
| Dossier v1 | 79 claims, 41 cited sources, quality gate **PASSED**, awaiting human review |
| Verdicts | ESTABLISHED 42 · PROBABLE 9 · DISPUTED 15 · UNVERIFIED 3 · MYTH 10 |
| Timing | synthesis ≈ 15 min (one model call over all evidence) |
| Cost | on the project's Cost card; it includes the failed attempts below, so it is not the cost of a clean run |

Found live and fixed (each with tests):

1. `railway.json` is ignored for new Railway services (Config as Code is
   deprecated): migrations never ran. Fixed by setting the service settings
   on Railway; DEPLOYMENT.md now lists them.
2. Railway's GitHub import split the monorepo into three broken services.
   Fixed by creating one Empty Service and connecting the repository.
3. A retrieved PDF contained NUL characters, which PostgreSQL rejects; one
   document failed the whole run, and each automatic retry re-paid the plan,
   48 searches and triage. Fixed: text cleaning, per-document failure, and
   saved progress so retries resume (`cc69dd9`).
4. Anthropic rejected the synthesis schema as too large to compile ("compiled
   grammar is too large"; an unpublished internal limit). Fixed with an
   automatic schema-in-instructions fallback (`d55b038`); the retry resumed at
   synthesis and reused every earlier step.

Docker note: in the development sandbox, outbound TLS from inside Docker is
intercepted, so local image builds used a test-only copy of the Dockerfile
that trusts the sandbox CA. The committed Dockerfile is what Railway builds.

## NOT YET VERIFIED LIVE

- Human review of the first real dossier (pending).
- The cost of a clean research run end to end (the first run included failed
  attempts).

## MOCKED (runs, clearly labelled MOCK, does no real work)

| Area | Mock behaviour |
|---|---|
| Voice, video, storage, render, publishing providers (and AI/research when set to `mock`) | See ARCHITECTURE.md §6. $0 cost, realistic usage, `MOCK` labels, `MOCK_FAIL` failure trigger |
| All stage handlers except RESEARCH (and RESEARCH when AI or research is `mock`) | Call their provider interface once through the ledger and return a `{ mock: true, … }` result. They create **no** stories, scripts, scenes, storyboards, shots, infographics, timelines, renders or QA reports. The dashboard says which stages are real and which are MOCK placeholders |
| Storage | In-memory; contents vanish on restart |

## PLANNED (designed — interface/schema exists — not implemented)

- Real providers: ElevenLabs, Higgsfield, S3/R2 storage, FFmpeg + Remotion rendering, YouTube publishing; alternative research providers (Exa, Claude web search)
- Writing creative artifacts: tables for story, script/scenes/narration, storyboard/shots, infographics, timelines, renders, QA reports exist but nothing writes them
- Standalone worker deployment (entry point exists, not deployed); BullMQ queue (interface designed)
- Per-shot child jobs for visual generation fan-out
- Language versions beyond the master (schema ready; no translation stage, no UI to add a language)

## NOT YET BUILT (no code, no schema beyond notes)

- Story architecture, script engine, script QA scores (milestone 3 onward)
- Narration generation, subtitles (SRT/VTT), audio mixing, sound design, music/SFX selection
- Visual director, continuity bibles (character/location/object/style), image/video generation
- Infographic renderer, editing/timeline engine, final render, automated QA
- Localization/translation, YouTube publishing
- Editing artifacts in the dashboard (the brief's EDIT control), "regenerate" shortcut, artifact viewers
- User accounts/roles (single shared Basic-auth credential for now)
- CI pipeline (tests run locally; no GitHub Actions workflow yet)
- Unit tests for timeline calculations and subtitle timing — those modules do not exist yet
