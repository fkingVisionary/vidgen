# Status — what exists, honestly

Last updated: milestone 2 (research engine).

## IMPLEMENTED (real, tested)

| Area | What | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces, TypeScript 7 strict typecheck, shared tsconfig, pnpm catalog for shared versions | `pnpm typecheck` |
| Domain model | Status machine (20 statuses, 7 transition kinds), pipeline table, stage derivation, progress, available actions | `packages/core/src/*.test.ts` |
| Contracts | zod schemas: API inputs, StoryBeats, VoiceSettings, ShotDirection, QaFindings, InfographicSpec (mandatory source, finite numbers, approximate flags, reference checks) | `contracts.test.ts` |
| Cost math | Usage × rate card in micro-dollars, unpriced-usage reporting, exact sums | `cost.test.ts` |
| Database | Prisma 7 schema (22 tables, 25 enums), two migrations (initial; research engine), timestamptz, UUIDv7, cascade rules, enum parity test vs core | `enum-parity.test.ts`, integration tests |
| Project service | Create (with master language version), enqueue, retry, approve/reject/flag, rewind; row-locked transactions; audit events; stale-job protection | `project-service.int.test.ts`, `runner.int.test.ts` |
| Job system | Postgres queue (`SKIP LOCKED`), runner with concurrency, heartbeat, exponential backoff, non-retryable errors, abandoned-job recovery, shutdown release, provider-call ledger | `runner.int.test.ts` |
| API | Fastify: health, projects (list/create/detail by id or slug), jobs (enqueue/get/retry), approvals, rewind; zod validation; error mapping; Basic auth; security headers; static dashboard + SPA fallback; graceful shutdown | `app.int.test.ts`, `env.test.ts`, manual SIGTERM test |
| Dashboard shell | Project list (title, status, progress, runtime, created, updated), create form, project page (9 stages, next actions, approval gate with notes, rewind, jobs with retry and results, cost, approvals, activity), MOCK banner/badges, live polling | Browser E2E (Playwright/Chromium): full pipeline click-through, no console errors |
| Seed | Idempotent *Tulip Mania* demo project (title, working title, category, style, 10–15 min, editorial brief) | `app.int.test.ts`, run twice in container |
| Deployment | Multi-stage Dockerfile, `railway.json` (validated against Railway's schema), release script (migrate + seed), non-root runtime, build-time check that bundled imports resolve | Docker build + container run against Postgres (see note) |
| Local dev | `docker-compose.yml` (Postgres + test DB), `.env.example`, `pnpm dev` (API + Vite with proxy) | |
| **Tavily ResearchProvider** (M2) | Search (advanced depth, preferred/excluded domains, published dates, scores) and full-text extraction in batches; credits → estimated cost; keyless mode; retryable vs permanent errors | `tavily.test.ts` (fake HTTP) + **live** contract and discovery/retrieval runs against Tavily (keyless, $0) |
| **Anthropic AIProvider** (M2) | Streaming Messages API, structured outputs from zod (re-validated), adaptive thinking + effort, prompt caching, refusal fallback, token usage → estimated cost by served model, refusal/max-tokens/context errors | `anthropic.test.ts` with an injected client. **Not yet called live** (no API key in the development environment) |
| **Research stage** (M2) | Plan → discover → triage → retrieve (+ open-access fallback, duplicate detection) → read (verbatim quote verification) → synthesise → deterministic verdict rules → coherence review → quality gate → versioned dossier; caching; cost ceiling; progress events | `research.int.test.ts` (scripted fake providers, real Postgres), unit tests for URL/text/quote/open-access/draft/quality logic. Retrieval pieces also run live against Tavily |
| **Dossier API + viewer** (M2) | `GET /api/projects/:id/research[?version=N]`; dashboard page with versions, gate, cost, approval panel, verdict summary, claims (filters, popular version, supporting/contradicting citations with quotes), sources, story material, questions & gaps, quality report | `app.int.test.ts`; Playwright screenshots of the viewer on a fake-provider dossier |
| **Cost accounting** (M2) | Ledger rows carry `cost_basis` (VENDOR_REPORTED / ESTIMATED / UNPRICED / MOCK), provider request id, cost note; failed calls keep reported usage; project cost card shows estimated vs reported, unpriced calls, per-provider totals | `context` / `app.int.test.ts` |
| `pnpm research:run` (M2) | CLI: run research for a project to completion and print the evidence report | Container run (refuses clearly without credentials) |

Test counts at time of writing: **210 unit** (13 files) + **33 integration** (4 files), all passing.

Docker note: in the development sandbox, outbound TLS from inside Docker is
intercepted, so the image was built with a test-only copy of the Dockerfile
that adds two lines trusting the sandbox CA. The committed Dockerfile is
otherwise identical and needs no changes on Railway. A Railway deploy itself
has **not** been performed (no Railway account access from the sandbox).

## NOT YET VERIFIED LIVE

- **A real research run.** The development environment had no Anthropic API
  key, so the full stage (Claude planning, reading, synthesis, review) has
  only run against scripted fake providers. The real Tulip Mania dossier,
  its source/claim/verdict numbers and its real cost do not exist yet. One
  command produces them once keys are set: `pnpm research:run tulip-mania`
  (see DEPLOYMENT.md → Enabling real research).
- Railway deploy (as in milestone 1: Docker image built and run locally).

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
