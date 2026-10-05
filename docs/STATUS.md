# Status — what exists, honestly

Last updated: the editorial revision loop and alternative angles — built and
tested locally with a scripted fake AI, **not yet run with the real model**
(2026-10-05). Story Engine 2.0 is deployed to Railway (`a9f584f`) and the
editor reports a successful first acceptance run with the real model.

## IMPLEMENTED (real, tested)

| Area | What | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces, TypeScript 7 strict typecheck, shared tsconfig, pnpm catalog for shared versions | `pnpm typecheck` |
| Domain model | Status machine (24 statuses, 7 transition kinds), pipeline table, stage derivation, progress, available actions | `packages/core/src/*.test.ts` |
| Contracts | zod schemas: API inputs, story candidates and architecture (StoryCharacter, MythThread, StoryScores, StoryPackContent, StoryArchitectureContent), VoiceSettings, ShotDirection, QaFindings, InfographicSpec (mandatory source, finite numbers, approximate flags, reference checks) | `contracts.test.ts` |
| Cost math | Usage × rate card in micro-dollars, unpriced-usage reporting, exact sums | `cost.test.ts` |
| Database | Prisma 7 schema (28 tables, 33 enums), six migrations (initial; research engine; job checkpoint; story mining; story engine 2; story revisions — the last three additive only), timestamptz, UUIDv7, cascade rules, enum parity test vs core | `enum-parity.test.ts`, integration tests; the story migration was applied by the production image to a database in the current production shape |
| Project service | Create (with master language version), enqueue, retry, approve/reject/flag (artifact version linked: dossier, story architecture), rewind, restart a phase (rewind + enqueue), editor changes to story candidates, revise an architecture, explore angles (a side job that never moves the project); row-locked transactions; audit events; stale-job protection | `project-service.int.test.ts`, `runner.int.test.ts` |
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
| **Story mining** (M3) | Mines the approved dossier for 15–30 story units (not facts): characters, desire, conflict, stakes, escalation, turning point, payoff, viewer question, myth thread. Deterministic evidence rules (dossier claims only; named people and figures must be in the evidence — the claim they come from is linked, otherwise the candidate is removed; MYTH claims only as a myth investigation; duplicates and editor-rejected look-alikes removed); a critic checks support and scores 8 appeal components; historical status and confidence computed from the claims' verdicts; rank = appeal × evidence factor; top-up pass when too few survive; AI-proposed selection of 5–10; mining gate; versioned pack. Another pass carries over approved/flagged candidates and excludes rejected ones | `mining.test.ts`, `text.test.ts`, `story.test.ts`, `story.int.test.ts` (scripted fake AI, real Postgres: gate failure, retry without new model calls, resume after a transient error, carry-over) |
| **Story architecture** (M3) | Builds premise, central question, narrative spine, resolution and sequences (hook, question, key events with claims, characters, conflict, escalation, reveal, ending beat, caveats, duration) from the editor's selection. Story evidence is the selected units' own claims only; other dossier claims appear only as labelled background (purpose, own sources) and may not add a story, person, event, figure, date or beat; sources, historical status and confidence derived per sequence; a fact-checking reviewer may return a corrected version (kept only if it has no more evidence problems); architecture gate (traceability, framing of disputed/myth claims, invented people, figures, HIGH-priority units, runtime, story vs list of facts); rework uses the editor's rejection notes | `architecture.test.ts`, `story.int.test.ts` |
| **Story mining 2.0** (SE2) | Each candidate also carries its human stakes (protagonist, could gain, could lose, immediate problem), a reveal, a central question, a visual environment, a cold open labelled with its information class (a second-person opening is relabelled RECONSTRUCTION; a "documented" one on non-established claims is relabelled UNCERTAIN), a narrative mode (15), a POV strategy and a reconstruction level. The critic scores STORY VALUE (9 dimensions, one reason each; myth/investigation potential only where it applies) and HISTORICAL VALUE (computed evidence quality + significance, relevance, uniqueness) separately; STORY APPEAL ranks the pack. Approved and flagged candidates carried from an engine-1 pack are scored by the engine-2 critic (one extra call) and kept whatever it says, its concerns as notes. Mining gate adds labelled cold opens (FAIL), human stories (WARN) and carried candidates scored (WARN) | `mining.test.ts` (6 SE2 tests), `story.test.ts`, `story.int.test.ts` (incl. carrying engine-1 candidates into an SE2 pass) |
| **Story architecture 2.0** (SE2) | Logline, central question (Q0), central human stakes, narrative mode(s), POV strategy, cast (real and fictional, declared), thesis, spine, resolution; sequences of beats labelled DOCUMENTED / RECONSTRUCTION / UNCERTAIN / FICTION with function, claims, cast present and planned speech; setting with its basis, visual thinking (environment, objects, actions, emotion, metaphor, must show with claims, must avoid, shot ideas), continuity (carries in/out, questions opened/resolved, time jumps), presentation instructions; reconstruction shares and level. Deterministic rules (≈ 45 finding kinds; ARCHITECTURE.md §13) enforce the classes, presentation (PROBABLE worded as a hedge), the fiction boundary, verified quotations, names/places/figures/dates, continuity, the editor's priorities and order. Story editor then fact checker, each revision kept only if it adds no evidence problems; warnings (reconstruction budget, fiction count, interiority, continuity threads) never fail the gate | `architecture.test.ts` (32 tests), `story.int.test.ts` (12 architecture tests) |
| **Content opportunities** (SE2) | After a passed gate: LONG_FORM / SHORT / BOTH opportunities traced to beat ids, claims only from those beats or their sequences, no new figures/people/names/quotations, presentation copied from the architecture, ranked by short-form potential, at most 12, never padded; stored with claim links; approved or rejected one by one; `GET|POST /api/projects/:id/content-package` resolves the approved documentary + top N approved shorts (read only, `generated: false`, languages recorded only) | `opportunities.test.ts` (8 tests), `story.int.test.ts`, `app.int.test.ts` |
| **Story API + dashboard 2.0** (SE2) | `PATCH /api/story-candidates/:id` also takes title / narrative mode / central question / POV (null restores the AI's), `PUT …/story/selection-order`, `PATCH /api/content-opportunities/:id`, content package; architecture job takes preferences. Story page: story value / historical value bars with reasons and the appeal formula, "why it is compelling", human stakes, labelled cold open, angle editor, selection order ▲▼, generation preferences, v2 architecture (cast with FICTIONAL badges, colour-coded beats, invented lines marked as fiction, setting, visual, continuity, presentation, reconstruction meter, the story editor's quality bar), Opportunities tab (filters, top N, approve/reject, traceability, package preview). Engine-1 packs and architectures still render | `app.int.test.ts` (2 SE2 tests incl. engine-1 records); Playwright at 412 px on fake-AI data: angle edit, reorder, architecture, opportunity approval, package preview, engine-1 pages — no horizontal overflow, no console errors |
| **Editorial revision loop** (REV) | *Reconsider / Revise Architecture*: a checklist (angle, POV, emotional centre, opening, structure, pacing, narrative strategy, central question, human stakes) and a required brief; any version of the current pack can be revised from selection, review, after approval or after a failed run. The architect revises the base (task `story.revise`) from the story pack only — the selection plus units the editor approved but did not select — with explicit permission to restructure substantially and a required change log (what, why, what was kept); the story editor and the fact checker run again with the brief; the same rules and gate apply, plus two warnings (`revision_explained`, `revision_brief`). Code measures the change against the base (units added/removed, reordered, merged, split; opening, question, mode, POV, logline, stakes, cast, runtime, beats). A revision is always a new version linked to its base; the base is never modified; a failed revision leaves the base's status as it was; approving supersedes an earlier approved version (kept, recorded) | `revision.test.ts` (6), `story.int.test.ts` (4: versions preserved byte-for-byte, both reviewers re-run with the brief, failed revision keeps the base, evidence boundary incl. the provider ledger), `app.int.test.ts` |
| **Alternative angles** (REV) | `POST …/story/angles` (2 or 3, optional brief, optionally as alternatives to a version): a STORY_ANGLES side job, one model call; rules keep only the pack's units, label the opening's information class, derive claims, historical status and confidence, remove angles with outside figures, years, people, unknown names or unverified quotations, flag HIGH-priority units left out, and remove an angle that is not materially different from another (or from the base architecture). Stored as versioned explorations; fewer than two surviving angles fail only the side job. *Develop this angle* builds on it (selection) or revises toward it (review/approved); the architecture records the angle | `angles.test.ts` (5), `story.int.test.ts` (4), `app.int.test.ts` |
| **Revision & angles dashboard** (REV) | Story page: the Reconsider / Revise panel (checklist, brief, preferences, toward an explored angle), the revision record (brief, the architect's change log, the measured changes, the reviewers' re-run), the version history (every version, its origin and angle), an Angles tab (explore, compare, removed angles with reasons, gate report, develop), the approval box names the version under review | Playwright at 412 px and 1280 px on fake-AI data: explore → develop → v1; revise v2 → v3 with v1/v2 kept; failed revision; no horizontal overflow, no console errors |
| **Research boundary** (SE2) | Story code never writes research tables (static guard over the story stages and story API) and does not use the research module; a full mining → architecture → approval → opportunity decision run leaves the research tables byte-for-byte equal; `modules/research` unchanged | `boundaries.test.ts`, `story.int.test.ts` |
| **Story API + dashboard** (M3) | `GET /api/projects/:id/story`, `PATCH /api/story-candidates/:id`, `POST …/story/mine`, `POST …/story/architecture` (selection checked first); Story page: ranked candidates with scores and the ranking formula, arcs, myth threads, evidence (claims, quotes, sources), editor controls (approve/reject/flag, in-the-documentary, priority, notes), selection vs AI proposal, architecture with sequences and per-sequence evidence, both gate reports, cost; approval panel (Approve / Reject → Rework / Flag). Project pages are linked by an Overview · Research dossier · Story bar; the Research and Story stage boxes open their pages; new pages open at the top; pages fit a phone screen | `app.int.test.ts`; Playwright run on fake-AI data (editor actions, selection limits, rejection) with no console errors; Playwright at a 412 px phone viewport: every route into the Story page, no horizontal overflow |

Test counts at time of writing: **324 unit** (21 files) + **69 integration** (5 files), all passing.

## FIRST LIVE RUN (Railway, 2026-10-04)

Project *Tulip Mania*, real Claude (`claude-opus-5-5`) and Tavily (API key):

| | |
|---|---|
| Discovery | 12 questions, 48 searches → 265 candidate sources |
| Selection | 44 selected → 41 unique documents retrieved and read |
| Evidence | 666 quotes verified verbatim against the retrieved text, 16 rejected |
| Dossier v1 | 79 claims, 41 cited sources, quality gate **PASSED**, approved by the editor |
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
5. The Story page was hard to find on a phone: the only links were an inline
   link and a button below the jobs table, the "Story · In progress" stage box
   was not a link, and the dossier's "Story material" tab (research notes) did
   not point to it. Fixed: an Overview · Research dossier · Story bar on every
   project page, clickable stage boxes, a "Review story candidates" button,
   a pointer from the dossier's story material, pages that open at the top and
   fit a phone screen.
6. The first live story architecture (8 units, 9 sequences, ≈ $1.00 estimated
   for 2 model calls) failed its gate on one point: sequence 2 used a myth
   claim (C054) without a caveat. The reviewer removed it, but the rebuilt
   revision still had it: the evidence rules re-added it, most likely through
   a character, since naming one linked every claim that names them (the
   reviewer had found three unused claims in that sequence, C001, C054 and
   C066). Fixed: one firmest claim per character, none if the sequence already
   cites one of theirs; findings say what a linked claim was linked for. Retry
   reuses the two saved model calls and re-checks them with the fixed rules.
   The Story page now offers Retry and "Back to story selection" when a story
   job fails, and reloads the story when a run ends (it could show the
   superseded version).

Docker note: in the development sandbox, outbound TLS from inside Docker is
intercepted, so local image builds used a test-only copy of the Dockerfile
that trusts the sandbox CA. The committed Dockerfile is what Railway builds.

Story mining, live on the approved dossier v1 (2026-10-04): 24 candidates
proposed, none removed by the evidence rules or the critic (7 need a caveat),
8 proposed for the documentary, mining gate **PASSED**; 3 model calls,
≈ $1.87 estimated, 9 min 18 s. The first attempt failed on its first call,
before any work, because the Anthropic account's credit balance was too low;
a retry two minutes later succeeded.

## NOT YET VERIFIED LIVE

- **The editorial revision loop and alternative angles**: no run with the real
  model yet. Everything above was tested with a scripted fake AI and synthetic
  data; how well the real model restructures from a brief, and how different
  its angles are, is still to be seen. Their real cost is not measured.
- **Story Engine 2.0**: deployed; the editor reports a successful first
  acceptance run. Its figures (cost, timing, gate results) are not recorded
  here.
- A story architecture that passes its gate with the real model, recorded
  here (engine 1's first run failed on the rules bug above; the gate results
  of the SE2 acceptance run are not recorded here).
- The cost of a clean research run end to end (the first run included failed
  attempts).

## MOCKED (runs, clearly labelled MOCK, does no real work)

| Area | Mock behaviour |
|---|---|
| Voice, video, storage, render, publishing providers (and AI/research when set to `mock`) | See ARCHITECTURE.md §6. $0 cost, realistic usage, `MOCK` labels, `MOCK_FAIL` failure trigger |
| All stage handlers except RESEARCH, STORY_MINING and STORY_ARCHITECTURE (and those when their providers are `mock`) | Call their provider interface once through the ledger and return a `{ mock: true, … }` result. They create **no** story candidates or architectures (in mock mode), scripts, scenes, storyboards, shots, infographics, timelines, renders or QA reports. The dashboard says which stages are real and which are MOCK placeholders |
| Storage | In-memory; contents vanish on restart |

## PLANNED (designed — interface/schema exists — not implemented)

- Real providers: ElevenLabs, Higgsfield, S3/R2 storage, FFmpeg + Remotion rendering, YouTube publishing; alternative research providers (Exa, Claude web search)
- Writing creative artifacts: tables for script/scenes/narration, storyboard/shots, infographics, timelines, renders, QA reports exist but nothing writes them
- Standalone worker deployment (entry point exists, not deployed); BullMQ queue (interface designed)
- Per-shot child jobs for visual generation fan-out
- Language versions beyond the master (schema ready; no translation stage, no UI to add a language)

## NOT YET BUILT (no code, no schema beyond notes)

- Script engine, script QA scores (milestone 4 onward)
- Anything generated from content opportunities: short scripts, voice, video, captions, renders, platform exports (the content package endpoint only resolves what would be used)
- Narration generation, subtitles (SRT/VTT), audio mixing, sound design, music/SFX selection
- Visual director, continuity bibles (character/location/object/style), image/video generation
- Infographic renderer, editing/timeline engine, final render, automated QA
- Localization/translation, YouTube publishing
- Editing artifacts in the dashboard (the brief's EDIT control), "regenerate" shortcut, artifact viewers
- User accounts/roles (single shared Basic-auth credential for now)
- CI pipeline (tests run locally; no GitHub Actions workflow yet)
- Unit tests for timeline calculations and subtitle timing — those modules do not exist yet
