# Status — what exists, honestly

Last updated: Documentary Writing Engine 2 — a versioned house-style corpus,
targeted retrieval, AI-pattern and rhythm diagnostics, the read-aloud rubric,
the Human Narration Pass (idempotent, judged change by change), money context
from the evidence, name layers, the v(N) → v(N+1) change report (2026-10-05),
before its first real run on the Tulip script. Earlier: Voice Engine 1.0 — narration in small chunks with ElevenLabs
Eleven v4, S3 (Railway bucket) storage, takes, assembly on the measured clock,
the VOICE gate (2026-10-05), before its first real audition. Earlier: granular
review, the evidence invariants and the performance budget (the acceptance
run from script v1 produced v4 at about 15:05, inside the agreed 10–15
minutes but for a small tolerance; voice timing, not a words-per-minute
estimate, now decides the real length).

## IMPLEMENTED (real, tested)

| Area | What | Evidence |
|---|---|---|
| Monorepo | pnpm workspaces, TypeScript 7 strict typecheck, shared tsconfig, pnpm catalog for shared versions | `pnpm typecheck` |
| Domain model | Status machine (25 statuses incl. VOICE_REVIEW, 7 transition kinds), pipeline table, stage derivation, progress, available actions | `packages/core/src/*.test.ts` |
| Contracts | zod schemas: API inputs, story candidates and architecture (StoryCharacter, MythThread, StoryScores, StoryPackContent, StoryArchitectureContent), VoiceSettings, ShotDirection, QaFindings, InfographicSpec (mandatory source, finite numbers, approximate flags, reference checks) | `contracts.test.ts` |
| Cost math | Usage × rate card in micro-dollars, unpriced-usage reporting, exact sums | `cost.test.ts` |
| Database | Prisma 7 schema (37 tables, 41 enums), nine migrations (initial; research engine; job checkpoint; story mining; story engine 2; story revisions; script engine; voice engine; writing engine 2 — the last six additive only), timestamptz, UUIDv7, cascade rules, enum parity test vs core | `enum-parity.test.ts`, integration tests; the story migration was applied by the production image to a database in the current production shape |
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
| **Script Engine 1.0** (SCR) | Turns the approved Story Engine 2.0 architecture into a structured spoken script (ARCHITECTURE.md §15): planner (narrator, a plan and runtime share per sequence) → writer (sections of narration blocks: beats realised, information class incl. FRAMING, claim keys, speaker, visual intent) → rules → script editor (craft scores, issues, a targeted patch) → rules → fact checker (last word on facts, a patch) → rules → performance (pace, energy, emotion, semantic pauses with reasons, emphasis on words in the text, pronunciations — all flagged for review) → gate → a new version IN_REVIEW. A patch is kept only if it adds no blocking findings; issues follow blocks as they move. Timing from spoken words (150 wpm), pace and pauses against the project's target, with the variance. Checkpointed steps (a retry resumes), cost ceiling, per-step models from configuration | `script.int.test.ts` (8 tests: draft traced/timed/performed, research and story tables unchanged, five calls in the ledger; resume after a transient failure; an unavailable reviewer; a reviewer patch kept only when it helps; blocking findings reach review but stop approval), `draft.test.ts` (5), `script.test.ts` (4) |
| **Script rules and gate** (SCR) | ≈ 50 deterministic finding kinds: evidence (claims and beats outside the architecture, unsupported figures and years, people and names), classes (mismatch, DOCUMENTED on non-established claims, framing with facts, unplanned fiction), uncertainty wording (MYTH / DISPUTED / UNVERIFIED / PROBABLE), the fiction boundary (fiction in documented narration, interacting with real people, performing documented or dated acts, carrying facts), speech (real people only in verified recorded quotations, fabricated quotes), structure (missing sequences, the central question posed and answered, runtime), open critical fact issues; warnings for story shape, reconstruction budget, interiority, writing for the ear, pause/emphasis overuse, section balance, pronunciation, visual evidence. Blocking findings stop approval, not review | `rules.test.ts` (17, incl. the brief's safety cases: a fictional companion's fictional action passes; a fictional companion in a documented event fails; invented dialogue for a real person fails; an unsupported number fails; a myth stated as fact fails; a disputed claim worded as disputed passes) |
| **Script editing and versions** (SCR) | In SCRIPT_REVIEW, on the version under review only: edit a block (text, class, delivery, pauses, emphasis, visual intent; the generated text kept), reorder a section, approve / reject a section with notes — each change re-runs the rules (no model calls) and is logged with the before state. Regenerate chosen sections (others copied unchanged, no model calls for them), revise the whole script from a brief, restore an earlier version as a new one (no model calls); every version kept with its origin, base, brief, requester, change log, architecture version, models, cost; compare versions section by section. Approval at the SCRIPT gate refused while blocking findings or rejected sections remain; approving supersedes the earlier approved version | `script.int.test.ts`, `app.int.test.ts` (2: the full editor flow through the HTTP API; MOCK and no-architecture refusals) |
| **Voice rendering adapter** (SCR) | Provider-neutral `VoiceScriptAdapter` for SSML-era models (Multilingual v2): requests per run of the same pace, break tags, neighbouring text, confirmed pronunciations. `GET …/script/voice-plan` still returns it as a read-only summary; narration itself is the Voice Engine's (below) | `voice-render.test.ts` (2), `app.int.test.ts` |
| **Writing Engine 2** (WE2) | `modules/writing`: a versioned corpus of original house writing (positive, negative with the house rewrite, borderline, house voice; 13 categories; copyright-safe; bundled into the build; version = manifest semver + hash of the wording), the style bible, the rubric and the AI-pattern glossary generated from code; targeted, deterministic retrieval (8 models, 5 habits to avoid, 3 judgment calls at most, per need); AI-pattern fingerprint (18 patterns, HARD vs DENSITY with thresholds, 0–100 score), spoken-rhythm profile, ten-dimension read-aloud rubric (telemetry); historical money context from cited claims only (wage → income → household expense → asset → modern estimate only when the evidence gives one; weaker verdict; method recorded; "the surviving records don't give us a reliable equivalent" when there is none); name layers (historical, display, spoken, pronunciation; candidates flagged, no phonemes guessed); semantic layers and delivery marks; the change report (exact lineage for a narration pass, matched pairing otherwise). In the script stage: the `narrate` step between the writer and the script editor in every mode (`SCRIPT_NARRATION_MODES`), and the stand-alone narration pass on a version (`NARRATION` origin); edits to texts only, judged one by one against the evidence invariants and the pass's own (figures, names, hedges, kept lines, money only from the evidence, no new machine habit, a polish not a rewrite); settled blocks never touched (convergence); new rule kinds (`AI_PATTERN`, `VISUAL_IN_NARRATION`, `MONEY_WITHOUT_CONTEXT` warnings; `DIRECTION_IN_NARRATION` blocking). House-style candidates from approved scripts (`writing_examples`), in retrieval only once a person approves them with a reason. API: narrate, editorial view, corpus, candidates, decisions. Dashboard: Editorial tab (ORIGINAL → REVISED → WHY), narration-pass action, House style page | unit tests in `modules/writing` and `modules/script` (see counts below); `script.int.test.ts` (narration pass from a base, convergence against a narrator that edits every block, draft mode, failure); `tulip-opening.int.test.ts` (the Tulip opening end to end through the MOCK Voice Engine); `app.int.test.ts` (writing engine API); Playwright at 412 px and 1280 px (68 checks) |
| **Voice Engine 1.0** (VOICE) | Narration of an approved script version in voice runs (opening audition, a section, chosen blocks, a range, the whole script; comparisons of 2–4 variants): deterministic chunking into whole sentences of one section (cost over every cut: paragraphs, scripted pauses and delivery changes preferred; question→answer, setup→payoff, short payoffs and continuations kept together; size range configurable), spoken forms for years, dates, amounts and numbers (recorded against the canonical text), provider-neutral performance directions translated from the script's delivery marks (plain / restrained house style / over-directed for comparison), provider markup rendered by the provider, nine deterministic checks before sending (words unchanged, forms recorded, directions only at sentence starts, never in quotations, plain words, density), takes stored with canonical, spoken and performance text, seed, context, settings and checks; audio through the StorageProvider; timestamps mapped back to the script's words; per-take QA (missing audio/timestamps, unmatched words, speaking rate, silences, spoken forms to hear); takes never deleted (regenerate one chunk, a section, blocks or all; approve, reject, restore an earlier take; approvals survive being superseded); assemblies on the measured clock with scripted pauses less the clips' own silence; the narration timeline (block, chunk, take, times, words, delivery, visual hints) and "what is said at mm:ss"; stale detection by block hashes (a stale run is never regenerated); versioned voice profiles; a pronunciation review list (aliases spoken by the engine, IPA/CMU sent as a provider dictionary; the whole narration needs every term decided); cost per request in the ledger (ESTIMATED from reported characters, UNPRICED, MOCK) with plans, confirmation thresholds and a per-job ceiling; the VOICE gate approves only a complete, fully approved, unblocked assembly of the approved script | `chunking.test.ts` (9), `spoken.test.ts` (5), `takes.test.ts` (10), `assembly.test.ts` (6), `voice.int.test.ts` (7: audition end to end with stored audio, ledger and assembly; regeneration keeping takes, approve/restore/reject; v1 audio stale after v2; a failed take vs a stopping error; plain/restrained/over-directed comparison; full narration through the VOICE gate; real voice refused without durable storage), `app.int.test.ts` (2: the voice API with byte-range audio, timeline and "what is said at"), `runner.int.test.ts`; Playwright at 412 px and 1280 px (66 checks, audio loads in the browser) |
| **ElevenLabs voice provider** (VOICE) | `/v1/text-to-speech/{voice}/with-timestamps`; Eleven v4 by default (audio tags, `[pause]`, no SSML; stability and similarity only), model capability table (v4, v4 turbo, v3, Multilingual v2, Flash v2/v2.5; an unknown model gets plain text, no fallback); previous/next text or request stitching; seed; language code where supported; pronunciation dictionaries from approved phoneme rules (created once per rule set); MP3/WAV/PCM output measured from the file; character cost from the `character-cost` header (else counted, and said so); retries for 429/5xx/timeouts (Retry-After honoured), errors with ElevenLabs' code and message | `elevenlabs.test.ts` (13, fake endpoint: request shape, cost, missing alignment, stitching, dictionaries, v2 vs v4 vs unknown models, 401/429/503/timeout/malformed responses, refusals before calling); **not yet run against the live API** |
| **S3-compatible storage** (VOICE) | Put/get/head/delete/list/presign over HTTPS with Signature V4 (virtual-hosted or path style): Railway Storage Buckets, Cloudflare R2, AWS S3, MinIO. Audio is streamed by the API with byte ranges behind the dashboard's auth | `s3.test.ts` (6: the four AWS worked signature examples reproduced exactly; a fake endpoint round trip); **not yet run against a live bucket** |
| **Audio tools** (VOICE) | MP3 frame parsing (ID3, Xing/Info skipped) for durations; joining MP3 clips frame by frame with silent frames for pauses; WAV joining sample by sample; raw PCM wrapped as WAV — no transcoding | `audio.test.ts` (4) |
| **Script API + dashboard** (SCR) | `GET/POST /api/projects/:id/script`, `…/script/revise`, `…/script/restore`, `…/script/compare`, `…/script/voice-plan`, `PATCH /api/script-blocks/:id`, `PUT /api/script-sections/:id/order`, `PATCH /api/script-sections/:id`; approval through the SCRIPT gate. Script page: header (version, architecture version, runtime vs target with variance, words, status, gate, cost), sections with blocks coloured by class, claims, pause marks, emphasis, delivery chips, duration, visual intent, edit/reorder/approve/reject/note/regenerate controls; Quality gate, Pronunciation & voice, Versions (compare, restore) and Runs & cost tabs; linked from the overview, the Story page and the nav bar | `app.int.test.ts`; Playwright at 412 px and 1280 px on fake-AI data (see below) |
| **Narrative refinement** (REF) | *Refine the narration*: a new version (origin REFINEMENT) whose telling is rewritten for the ear — no planner, the base's plan and narrator kept; the house style built into the system prompt (voice, meta-narration, strong lines kept as `keptLines`, information through story, no purple prose, rhythm, silence, facts with consequences, an earned turning point, natural uncertainty, legend as discovery, the companion as a lens, cuts only of what is weak, transitions, sources as detective work, runtime following the story) ranked under non-overridable evidence and safety rules, above the architecture's constraints, the base's reviewer and rule feedback, and optional *director's instructions* (which may steer style only; the user prompt follows the same order, the director last); then the script editor (shown the base) answers a 13-question checklist, the fact checker is told it is a refinement, the performance is marked again, the gate decides. A skipped section is kept as it was. Comparison of any two versions: words, runtime, blocks, gate, cost, scores, words by class, sections changed, words removed and added, claims and figures added or dropped, change log, kept lines, checklist, block diff. The wording checks accept natural uncertainty phrasing | `script.int.test.ts` (3: refinement v1 → v2 with v1 unchanged byte for byte, four calls and no planner, same beats/claims/classes, checklist recorded, comparison in the job report; an empty director field gets the complete house style — the system prompt identical with or without instructions, which come last; a director asking for an unhedged claim and a new figure, with the model complying, is still stopped at the gate, a skipped section kept), `app.int.test.ts` (refine route with and without instructions, comparison), `prompts.test.ts` (4: the hierarchy and parts in rank order, no topic terms in any production prompt), `rules.test.ts`, `draft.test.ts`; Playwright at 412 px and 1280 px |
| **Script Quality Rules** (SQR) | Generic, deterministic checks of the craft of a told story, for any subject (ARCHITECTURE.md §15): retellings, recap sections and claims explained again; passenger facts, one-off authorities, name load; sections over their share and an ending that drags when the film runs long; page syntax, lists, strings of numbers, essay prose, monotonous rhythm; meta-narration (one framing line allowed in the opening); people introduced without their role, fictional devices unintroduced, relabelled or labelled several ways; a named real person with no claim about them (blocking) and sentences that say what an uncited claim says; refrains, callbacks and escalations recognised, protected and warned about when a refinement drops them; a ranked cut plan with protected blocks when a version runs over its maximum; a change log that misstates the length noted. The writer, rewrite, refinement and editor prompts carry the same rules (`script-1.3`); the refiner and the reviewers see the findings, the repetition to keep and, when long, the cut plan; the job log records a digest of the rules for the base, the versions replaced and the new version | `craft.test.ts` (18, synthetic films from business, science, military, biography and history, and a guard that the module names no documentary, person, place, date or claim), `script.int.test.ts` (the rules reach the refiner, the editor — with the cut plan — and the performance pass; digests v1 → v2 and v1 → v3 with v2 replaced; a misstated length noted), `prompts.test.ts` |
| **Granular review and the invariants** (GQF) | Each change the script editor and the fact checker propose (edit, removal, insertion — each with its reason) is judged on its own: tried on the script as it stands, kept if it adds no blocking finding and drops no claim link, rejected with the invariant and rule that refused it, skipped if it cannot apply; a final validation; the record of every change saved with the version and shown on the Quality tab. Blocking evidence checks for assertions without the claim behind them (a real person's action resting on an uncited claim), claim links lost by a kept sentence, and probability wording upgrading a myth, an unverified or disputed claim, a reconstruction or a framing line. Callbacks need an earlier section, a purpose and distinctive words (hedges, recurring names and terms excluded; recalls in new words recognised); passengers are judged by contribution and later dependency, as candidates. The performance pass gets a runtime budget and is held to the maximum (least valuable timing given up first, never sped up) unless the user allows otherwise. Reviewers see the version before, the change log, the lines removed on purpose and the changes already judged. The quality report keeps measurements apart from model judgments | `review.test.ts` (4: an investigation, a biography with a recorded quotation, a history with a fictional companion — each bad change rejected with its invariant, the good ones kept, unappliable ones skipped), `evidence.test.ts` (5: history, science, business), `craft.test.ts` (23, incl. the brief's three callback cases and passenger dependency), `performance.test.ts` (5: 14:40 + 35 s trimmed inside 15:00 with reveals kept; 14:10 + 20 s untouched; the user's permission), `prompts.test.ts` (6), `script.int.test.ts` (13: granular review through a job, the fact checker told what became of the editor's changes, performance timing given up over the maximum and recorded); Playwright at 412 px and 1280 px |
| **Script boundary** (SCR) | Script code never writes research or story tables (static guard over the stage, the API and the read models) and does not use the research module; a draft leaves the research and story records unchanged | `boundaries.test.ts` (script), `script.int.test.ts` |
| **Story API + dashboard** (M3) | `GET /api/projects/:id/story`, `PATCH /api/story-candidates/:id`, `POST …/story/mine`, `POST …/story/architecture` (selection checked first); Story page: ranked candidates with scores and the ranking formula, arcs, myth threads, evidence (claims, quotes, sources), editor controls (approve/reject/flag, in-the-documentary, priority, notes), selection vs AI proposal, architecture with sequences and per-sequence evidence, both gate reports, cost; approval panel (Approve / Reject → Rework / Flag). Project pages are linked by an Overview · Research dossier · Story bar; the Research and Story stage boxes open their pages; new pages open at the top; pages fit a phone screen | `app.int.test.ts`; Playwright run on fake-AI data (editor actions, selection limits, rejection) with no console errors; Playwright at a 412 px phone viewport: every route into the Story page, no horizontal overflow |

Test counts at time of writing: **910 unit** (48 files) + **106 integration** (8 files), all passing.

## GQF ACCEPTANCE RUN (Railway, 2026-10-05): refinement from script v1 → v4

From the job log (no manual edit): v4 saved for review, **quality gate
PASSED**, 2,262 words, **15:05** (the 10–15 minute range plus 5 s; a warning,
not blocking), $1.82 estimated. Rules v1 → v4: uncited assertions 1 → 0,
retellings 1 → 0, name load 1 → 0, meta-narration 3 → 0, people
unintroduced 1 → 0, page syntax 7 → 0; sections over budget 2 → 2 and the
ending drag 1 → 1 remain. The script editor's changes: 11 kept, 1 rejected
(an unhedged PROBABLE claim). **The fact checker and the performance pass did
not run** — the Anthropic API refused them for a low credit balance — so v4
has no fact check of the refinement and no performance marks (0 pauses, no
delivery). The deterministic evidence rules did run and pass. Consequence for
voice: the restrained performance strategy translates the script's delivery
marks, so on v4 it sends the same text as plain until marks are added (by
editing blocks) or a director's directions are given per chunk.

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

- **Writing Engine 2** has not yet run with the real model. Tulip v5 is made
  by the *Human Narration Pass on v4* on the Script page (four model calls:
  the pass, the script editor with the narration checklist, the fact checker,
  the performance pass; v4 kept). The v4 run itself could not fact-check or
  mark performance because the Anthropic credit balance was too low: the
  credit must be topped up first. The job's final log entry carries the change
  report (totals and up to twelve before/after examples with the reasons);
  the Editorial tab shows every block. All tests use the fake model; no
  ElevenLabs audio was generated.
- **Writing Engine 2 limits** (deterministic heuristics, each erring towards
  refusing an edit or saying nothing rather than inventing): the narration
  guard counts hedges per kind, not per claim (a hedge moved from one claim
  to another with the count unchanged passes); a cited money comparison is
  accepted only in the evidence's own words (a paraphrase is refused); a
  dropped ordinal word ("at first") is refused as a lost figure; money
  reading gives no comparison where whose pay it is, or its period, cannot
  be told; the leak check reads bracketed and parenthesised directions in
  the narrator's words only (quotations and cast lines are the record's).
  An adversarial review (six lenses, each finding reproduced by a skeptic)
  and a second fix-and-review round preceded this deploy.
- **Script Quality Rules** acceptance rerun (Tulip Mania, 2026-10-05, v1 → v3
  with the same empty director's field as v2, `1297c10`): four calls ≈ $2.40
  estimated, 11.6 minutes; v2 superseded (kept). The refinement step returned
  2,227 words, 14:51 — inside the 15:00 maximum — and the performance marks
  took the saved v3 to 15:15 (v1 15:26, v2 15:59); 319 words removed and 294
  added, all 7 sections changed; claim C028 (background) and the figures 31
  and 438 dropped as passenger detail, nothing added; quality gate passed.
  The rules on v1 / v2 / v3: page syntax 7 / 16 / 0; meta-narration 3 / 1 / 0
  (one framing line allowed in the opening); a fictional device labelled two
  ways 0 / 1 / 0; three new names in one block 1 / 1 / 0; a person named
  without their role 1 / 0 / 0; one claim explained in four sections
  0 / 1 / 0; three numbers in a sentence 0 / 1 / 0; retellings 1 / 2 / 1 (the
  ending still re-explains the opening's legend, 7.6 → 1.1); section 7
  3:13 / 3:21 / 3:05 against a 2:24 share. Passenger facts: the rule flagged
  none in any version — the refiner cut them from the prompt's rules. Script
  editor 8 / 7 / 8 / 7 / 7; checklist 7 yes, 6 partly, no no; it found 2.6
  calling a dramatised telling "what probably happened" and some of v1's
  strong lines dropped. Both reviewers' patches were refused whole — the
  editor's 12 changes added 6 blocking findings, the fact checker's 2 added
  1 — so the fact checker's two MINOR issues (2.6; 4.9, a person named
  without the claim behind the deal) stay open for the editor. Not yet
  verified by these rules: passenger detection on real text; callbacks (the
  detector also took repeated hedges and a recurring source name for
  callbacks).
- **Narrative refinement** first live run (Tulip Mania, 2026-10-05, v1 → v2,
  no director's instructions, `69f21bc`): four calls ≈ $2.15 estimated, 9.8
  minutes. v2: 81 blocks, 2,319 words, 15:59 (v1: 75 blocks, 2,259 words,
  15:26); 167 words removed and 227 added, all 7 sections changed; no claims
  or figures added or dropped; quality gate passed (warnings: runtime near,
  beats told in other sections, 3 stretches of 76–78 s without a pause — v1
  had 6 of 79–91 s — section 7 long, 26 pronunciations to confirm, 5 visual
  details without claims — v1 had 16). Script editor 8 / 7 / 8 / 7 / 8
  (narrative, flow, clarity, emotion, ending; v1 7.5 / 6.5 / 7 / 6 / 7);
  checklist 6 yes, 6 partly, 1 no (runtime). The fact checker caught and
  fixed one unhedged PROBABLE statement the refinement introduced. The
  refiner's own change log misstated the length (about 1,900 words, 12:40):
  the measured figures above are what count.
- **Script Engine 1.0** first live run (Tulip Mania, 2026-10-05, architecture
  v3): script v1, 7 sections, 75 blocks, 2,259 words, 15:26 against a 12:30
  midpoint (10:00–15:00), quality gate passed (warnings: runtime near,
  beats told in other sections, stretches of 79–91 s without a pause, section
  7 long, 24 pronunciations to confirm, visual details without claims), five
  calls ≈ $2.42 estimated, 12.5 minutes.
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
| Voice (when `VOICE_PROVIDER=mock`), video, storage (when `STORAGE_PROVIDER=mock`), render, publishing providers (and AI/research when set to `mock`) | See ARCHITECTURE.md §6. $0 cost, realistic usage, `MOCK` labels, `MOCK_FAIL` failure trigger. With the mock voice the whole Voice Engine runs and every take is labelled MOCK (a beep and silence) |
| All stage handlers except RESEARCH, STORY_MINING, STORY_ARCHITECTURE, STORY_ANGLES, SCRIPT and VOICE (and those when their providers are `mock`; VOICE needs the real script stage) | Call their provider interface once through the ledger and return a `{ mock: true, … }` result. They create **no** story candidates, architectures or scripts (in mock mode; the script routes refuse to write one), storyboards, shots, infographics, timelines, renders or QA reports. The dashboard says which stages are real and which are MOCK placeholders |
| Storage (`STORAGE_PROVIDER=mock`) | In-memory; contents vanish on restart. Real narration refuses it |

## PLANNED (designed — interface/schema exists — not implemented)

- Real providers: Higgsfield, FFmpeg + Remotion rendering, YouTube publishing; alternative research providers (Exa, Claude web search)
- Writing creative artifacts: tables for storyboard/shots, infographics, timelines, renders, QA reports exist but nothing writes them (the script tables are written by Script Engine 1.0)
- Standalone worker deployment (entry point exists, not deployed); BullMQ queue (interface designed)
- Per-shot child jobs for visual generation fan-out
- Language versions beyond the master (schema ready; no translation stage, no UI to add a language)

## NOT YET BUILT (no code, no schema beyond notes)

- A model pass that proposes performance directions (directions are translated from the script's delivery marks); chunk sizes that adapt to the narrative structure; automatic reuse of unchanged takes in a new run for a new script version
- Anything generated from content opportunities: short scripts, voice, video, captions, renders, platform exports (the content package endpoint only resolves what would be used)
- Subtitles (SRT/VTT), audio mixing and mastering, sound design, music/SFX selection, multilingual dubbing
- Visual director, continuity bibles (character/location/object/style), image/video generation
- Infographic renderer, editing/timeline engine, final render, automated QA
- Localization/translation, YouTube publishing
- Editing artifacts in the dashboard (the brief's EDIT control), "regenerate" shortcut, artifact viewers
- User accounts/roles (single shared Basic-auth credential for now)
- CI pipeline (tests run locally; no GitHub Actions workflow yet)
- Unit tests for timeline calculations and subtitle timing — those modules do not exist yet
