# Architecture — Documentary Engine V1

> Status: **milestone 2 (research engine)** on top of milestone 1
> (architecture & scaffold). What is real, mocked and
> planned is tracked in [STATUS.md](STATUS.md). Deployment is in
> [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Principles

1. **A modular monolith, not microservices.** One deployable (API + dashboard +
   embedded worker), one PostgreSQL database. Stages are isolated behind
   interfaces so any of them can later run as its own worker without a rewrite.
2. **The pipeline is data.** Every project status, which jobs run in it, which
   human gate guards it and where it goes next is declared once
   ([`packages/core/src/pipeline.ts`](../packages/core/src/pipeline.ts)).
   Transition rules, the dashboard stage view and the "what can I do next"
   actions are all *derived* from that table.
3. **Vendors are replaceable.** The app depends on seven provider interfaces,
   never on ElevenLabs/Higgsfield/etc. directly. A registry picks the
   implementation from environment variables.
4. **Mock mode is honest.** Everything runs without credentials, and every mock
   output is labelled `MOCK`. Mocks never claim success they did not have: a
   mock publish returns `published: false`, mock research returns URLs on the
   unresolvable `.invalid` domain, the mock LLM refuses to invent structured
   data.
5. **Humans approve.** Five review points (research, script, storyboard,
   generated visuals, final video) cannot be skipped by the state machine.
6. **Multilingual from day one.** A project has a master language and
   `LanguageVersion`s; the schema separates what is shared across languages
   from what is per language.

## 2. System overview

```mermaid
flowchart LR
  subgraph Browser
    UI[Dashboard<br/>React + Vite + Tailwind]
  end
  subgraph Railway["Railway service (one container)"]
    API[Fastify API<br/>+ static dashboard]
    W[Job runner<br/>embedded worker]
    PS[ProjectService<br/>state machine]
    REG[Provider registry]
  end
  DB[(PostgreSQL<br/>projects, jobs, ledger…)]
  subgraph Providers["Provider interfaces (V1: all MOCK)"]
    AI[AIProvider]
    RS[ResearchProvider]
    VO[VoiceProvider]
    VI[VideoProvider]
    ST[StorageProvider]
    RE[RenderProvider]
    PU[PublishingProvider]
  end
  UI -- "HTTPS + Basic auth<br/>/api/*" --> API
  API --> PS --> DB
  W -- "claim (SKIP LOCKED)" --> DB
  W --> PS
  W --> REG --> Providers
```

Request path: the dashboard calls the API; the API validates input (zod) and
calls `ProjectService`, which changes state inside a transaction that locks the
project row. Enqueued jobs are rows in `jobs`; the runner claims them, executes
the stage handler with a `StageContext`, records provider calls in the ledger
and reports success/failure back to `ProjectService`, which advances the
project when a phase completes.

## 3. Repository layout and dependency rules

```
apps/
  api/        Fastify server, composition root, worker & seed entry points, esbuild bundle
  web/        Dashboard shell (React 19, Vite 8, Tailwind 4, TanStack Query, React Router 7)
packages/
  core/       Domain: enums, pipeline/state machine, stage derivation, zod contracts, cost math. Browser-safe, no I/O.
  database/   Prisma 7 schema, migrations, client factory, test helpers
  providers/  Provider interfaces, MOCK implementations, registry, reusable contract test suites
  pipeline/   ProjectService (state changes), JobQueue, JobRunner, StageContext, stage handler contract, MOCK stage handlers
modules/      Real stage implementations: research (M2), story (M3: mining + architecture, revisions, angles), script (Script Engine 1.0), voice (Voice Engine V1), writing (Writing Engine 2, a library); later visual-director, infographics, editor, qa
docs/         Architecture, deployment, status
scripts/      release.sh (migrations + seed), test DB init, ui/ (browser QA of the Voice page, MOCK voice)
test/         Shared integration-test setup
```

Allowed dependencies (enforced by package.json declarations):

```
web ─────────────► core
api ──► pipeline ──► providers ──► core
          │  └─────► database  ──► core
          └────────► core
```

`core` imports nothing internal and nothing Node-specific, so the dashboard
shares the exact enums, labels, contracts and response types the API uses.
Only `apps/api/src/container.ts` chooses concrete implementations.

**Why a `pipeline` package rather than one package per stage now?** The stage
*logic* does not exist yet. Each real stage will become `modules/<stage>`
exporting a `StageHandler`, registered in `container.ts` in place of its mock.
Creating eight empty packages today would be ceremony without content.

## 4. Pipeline and state machine

The project `status` is the master pipeline phase (linear, as in the brief,
plus three added review statuses — see §18, D5–D6, D77). Dashboard stages are derived.

| Status | Dashboard stage | Jobs that run here | Leaves by |
|---|---|---|---|
| IDEA | Research (not started) | — | START → RESEARCHING (enqueue RESEARCH) |
| RESEARCHING | Research | RESEARCH | all jobs done → RESEARCH_REVIEW |
| RESEARCH_REVIEW | Research (awaiting approval) | — | **gate RESEARCH**: approve → RESEARCH_COMPLETE, reject → RESEARCHING |
| RESEARCH_COMPLETE | Research ✓ | — | START → STORY_MINING |
| STORY_MINING | Story | STORY_MINING | → STORY_SELECTION |
| STORY_SELECTION | Story (editor curates candidates) | — | START → STORY_ARCHITECTING (enqueue STORY_ARCHITECTURE; needs 5–10 selected units) |
| STORY_ARCHITECTING | Story | STORY_ARCHITECTURE | → STORY_REVIEW |
| STORY_REVIEW | Story (awaiting approval) | — | **gate STORY**: approve → STORY_APPROVED, reject → STORY_SELECTION |
| STORY_APPROVED | Story ✓ | — | START → SCRIPT_DRAFT (never automatic) |
| SCRIPT_DRAFT | Script | SCRIPT | → SCRIPT_REVIEW |
| SCRIPT_REVIEW | Script (awaiting approval) | — | **gate SCRIPT**: approve → SCRIPT_APPROVED, reject → SCRIPT_DRAFT |
| SCRIPT_APPROVED | Script ✓ | — | START → VOICE_GENERATING |
| VOICE_GENERATING | Voice | VOICE (a voice run, a comparison, or new takes) | → VOICE_REVIEW |
| VOICE_REVIEW | Voice (review takes; awaiting approval) | — | **gate VOICE** (a full run of the approved script, every current take approved, nothing blocking): approve → VOICE_COMPLETE, reject → VOICE_GENERATING. New takes re-enter VOICE_GENERATING by the reject path (no decision recorded). |
| VOICE_COMPLETE | Voice ✓ | — | START → VISUAL_PLANNING |
| VISUAL_PLANNING | Storyboard | VISUAL_PLAN | → STORYBOARD_REVIEW |
| STORYBOARD_REVIEW | Storyboard (awaiting approval) | — | **gate STORYBOARD**: approve → VISUAL_GENERATING, reject → VISUAL_PLANNING |
| VISUAL_GENERATING | Assets | VISUAL_GENERATION, INFOGRAPHIC (parallel) | both done → VISUAL_REVIEW |
| VISUAL_REVIEW | Assets (awaiting approval) | — | **gate VISUAL_ASSETS**: approve → EDITING, reject → VISUAL_GENERATING |
| EDITING | Timeline | EDIT | → RENDERING |
| RENDERING | QA | RENDER | → QA |
| QA | QA (awaiting approval once QA job succeeded) | QA | **gate FINAL_VIDEO** (needs QA job): approve → APPROVED, reject → EDITING |
| APPROVED | Final | PUBLISH | → PUBLISHED, **only with a real (non-mock) publishing provider** |
| PUBLISHED | Final ✓ | — | terminal |
| FAILED | stage where it failed | — | RECOVER (retry the failed job) or REWIND |

Transition kinds: `START`, `COMPLETE`, `APPROVE`, `REJECT`, `FAIL`, `RECOVER`,
`REWIND`. `getTransitionKind(from, to)` is the single authority; anything it
returns `null` for is illegal (e.g. `SCRIPT_REVIEW → VOICE_GENERATING`).

**Side jobs (`SIDE_JOBS`).** A side job belongs to no phase: it runs while the
project is in one of its listed statuses and never starts, completes or fails
a phase. Today there is one: STORY_ANGLES (alternative narrative angles) runs
in STORY_SELECTION, STORY_REVIEW and STORY_APPROVED (§14). Its failure shows on
the job only; a retry runs where it may run.

**Phase runs (`phase_seq`).** Each time a project enters a phase, its
`phase_seq` increments and queued jobs from the previous run are cancelled.
Jobs are stamped with the `phase_seq` they were enqueued under; only jobs of the
current run count towards completing a phase. This makes rewinds and
rejections safe: a job that finishes after the project moved on is recorded but
ignored (`JOB_IGNORED_STALE`). Failing and recovering do *not* start a new run,
so already-succeeded sibling jobs (e.g. INFOGRAPHIC when VISUAL_GENERATION
failed) are not thrown away.

## 5. Data model

37 tables. Fields that are filtered/joined/queried are typed columns; creative
payloads still evolving (story sequences, shot direction, infographic specs,
timeline tracks, QA findings) are JSONB validated by zod contracts in
`packages/core/src/contracts`. Primary keys are UUIDv7. Timestamps are
`timestamptz`. Money is `numeric(14,6)` USD.

```mermaid
erDiagram
  projects ||--|{ language_versions : "master + localizations"
  projects ||--o{ jobs : runs
  projects ||--o{ approvals : "human decisions"
  projects ||--o{ project_events : "audit log"
  projects ||--o{ provider_calls : "cost & observability ledger"
  projects ||--o{ media_assets : files
  projects ||--o{ sources : cites
  projects ||--o{ research_dossiers : versions
  research_dossiers ||--o{ research_claims : contains
  research_claims ||--o{ claim_citations : "supported / contradicted by"
  sources ||--o{ claim_citations : ""
  projects ||--o{ story_packs : "mining passes"
  story_packs ||--o{ story_candidates : ranks
  story_candidates ||--o{ story_candidate_claims : "built on"
  research_claims ||--o{ story_candidate_claims : ""
  story_packs ||--o{ story_architectures : "selection → blueprint"
  projects ||--o{ story_architectures : versions
  story_architectures ||--o{ content_opportunities : "shorts, long-form"
  content_opportunities ||--o{ content_opportunity_claims : "built on"
  research_claims ||--o{ content_opportunity_claims : ""
  projects ||--o{ scripts : versions
  scripts ||--o{ scenes : "language-neutral structure"
  scenes ||--o{ scene_narrations : "one per language"
  language_versions ||--o{ scene_narrations : ""
  scene_narrations ||--o{ script_blocks : "narration blocks"
  script_blocks ||--o{ script_block_claims : "cites"
  research_claims ||--o{ script_block_claims : ""
  story_architectures ||--o{ scripts : "told by"
  projects ||--o{ storyboards : versions
  storyboards ||--o{ shots : plans
  scenes ||--o{ shots : ""
  shots ||--o{ provider_calls : "generation attempts"
  projects ||--o{ infographics : "deterministic specs"
  language_versions ||--o{ timelines : "per-language edit"
  language_versions ||--o{ renders : outputs
  renders ||--o{ qa_reports : checked
```

### Core spine (used by milestone 1 and 2 code)

| Table | Purpose |
|---|---|
| `projects` | The episode. `status`, `failed_from_status`, `phase_seq`, target length, master language, planning cost estimate. |
| `language_versions` | One per language (`unique(project_id, language)`). Voice config, localized metadata, publishing state. The master is the one matching `projects.master_language`. |
| `jobs` | Units of work *and* the V1 queue: status, attempts/max, `run_after` (backoff), lock owner + heartbeat, `phase_seq`, `is_mock`, input/result/error. |
| `approvals` | Gate, decision (APPROVED/REJECTED/FLAGGED), notes, who, the status at the time, optional FK to the exact artifact version reviewed. |
| `project_events` | Append-only activity log (status changes with reasons, jobs, approvals). |
| `provider_calls` | Every external call: provider, operation, model, mock flag, status, vendor job id, request/response summaries, usage, estimated & actual cost, duration, output asset, shot. |
| `media_assets` | Any stored file (narration, images, clips, infographics, music, SFX, ambience, subtitles, renders). `language_version_id = null` ⇒ shared across languages. Licence/attribution go in `metadata`. |
| `sources` | Every source considered for a project, shared across dossier versions (`unique(project_id, normalized_url)`): URL, domain, type (PRIMARY … GENERAL_WEB), author/publisher/date and reliability (from reading the page), retrieval status/error, search snippet and score, `discovered_by` (job, questions, queries; or the failed source an open-access copy stands in for), `duplicate_of_id`. |
| `source_documents` | The retrieved full text of a source (one per source), its sha256, and the cached per-source reading (`analysis`, keyed by `analysis_version` = prompt version + topic/focus hash). |
| `research_dossiers` | Versioned (`unique(project_id, version)`), status DRAFT / IN_REVIEW / APPROVED / REJECTED / SUPERSEDED, `content` (questions, timeline, key figures, price evidence, myths, interpretations, bubble assessment, narrative history, open questions, missing evidence), `quality_report`, `quality_passed`, `stats`, `job_id`. |
| `research_claims`, `claim_citations` | A claim has a stable `claim_key` (C001…), `verdict` (ESTABLISHED / PROBABLE / DISPUTED / UNVERIFIED / **MYTH**), `confidence`, `importance` (KEY / SUPPORTING / BACKGROUND), `claim_type`, `category`, `needs_verification`, `popular_version` (what is commonly claimed) and notes. A citation links a claim to a source with a stance (SUPPORTS / CONTRADICTS / CONTEXT), the verbatim quote, a locator, its `basis` (FULL_TEXT or SNIPPET) and `quote_verified`. |
| `story_packs` | One mining pass over an approved dossier (`unique(project_id, version)`): status, `content` (the AI's proposed selection with premise and rationale, candidates removed and why, candidates carried over, the editor's brief), mining `quality_report`, `stats`, `job_id`. |
| `story_candidates` | A story unit (`candidate_key` S01… in rank order): title, hook, `story_type`, `characters` (JSON: name, kind NAMED_PERSON/GROUP/ROLE, role, claim keys), setting, period, desire, conflict, stakes, escalation, turning point, payoff, why interesting, viewer question, `myth_thread`, `scores` (8 components + appeal + critic rationale), `historical_status` and `historical_confidence` (computed from the claims), `rank_score`, `rank`, caveat notes, `ai_selected` + reason; the editor's `status` (PROPOSED/APPROVED/REJECTED/FLAGGED), `selected`, `priority` (HIGH/NORMAL/LOW), `editor_notes`. |
| `story_candidate_claims` | Candidate ↔ dossier claim (FK, so evidence links cannot dangle). Sources follow from the claims' citations. |
| Story Engine 2.0 columns | `story_packs.engine_version` and `story_architectures.engine_version` (1 = milestone 3, 2 = Story Engine 2.0; default 1). On `story_candidates` (null for engine 1): `narrative_mode`, `central_question`, `pov_strategy`, `human_stakes`, `story_design` (cold open with its information class, reveal, visual environment), `reconstruction_level`, `story_value`, `historical_value`, `editor_overrides` (the editor's title / mode / question / POV; the AI's values are kept), `selection_order`. Engine-2 `scores` hold story value and historical value dimensions with reasons. |
| `content_opportunities` | Shorts and long-form threads identified in an architecture (`unique(architecture_id, opportunity_key)`): format LONG_FORM / SHORT / BOTH, rank and short-form potential, title, hook, central question, target duration, independent / requires context, computed historical status and confidence, `content` (premise, angle, escalation, payoff, ending, visual concept, beat ids, sequence numbers, unit ids, claim keys, sources, cast ids, presentation copied from the architecture, scores, rules applied); the editor's `status` (PROPOSED / APPROVED / REJECTED), notes, `decided_by` / `decided_at`. |
| `content_opportunity_claims` | Opportunity ↔ dossier claim (FK), like the candidates' links. |
| `story_architectures` | Versioned blueprint (gate STORY): `content` = premise, central question, narrative spine, resolution, sequences (candidate ids/keys, hook, question, key events with claim keys, characters, conflict, escalation, reveal, ending beat, claim keys, derived source ids, caveats, historical status/confidence, duration), unused units with reasons; `pack_id`, `dossier_id`, target and estimated duration, `quality_report`, `stats`, `notes` (the editor's instructions), `job_id`. Approvals link the exact version (`approvals.story_id`). |

### The script (Script Engine 1.0, §15)

| Table | Notes |
|---|---|
| `scripts` | Versioned (`unique(project_id, version)`, gate SCRIPT): `story_id` (the approved architecture it tells), `engine_version` (1 = Script Engine 1.0), `content` (`ScriptContent`: narrator, central question with the blocks that pose and answer it, pronunciations, the script editor's and fact checker's reviews, provenance — origin, base version, sections written, brief, who asked, the writer's change log), `quality_report`, `quality_passed`, `stats` (models, prompt version, timing, classes, findings, resumed steps), `target_duration_sec`, `estimated_duration_sec`, `word_count`, `notes` (the brief), `revision_of_id`, `job_id`. Approvals link the exact version (`approvals.script_id`). |
| `scenes` | **The script is language-neutral structure; the words are per language.** One per architecture sequence: `scene_key` ("SC01"), `sequence_number`, title, `content` (the planner's section plan), the editor's `review_status` (PENDING / APPROVED / REJECTED), `editor_notes`, `reviewed_by` / `reviewed_at`. |
| `scene_narrations` | One per scene and language: the section's full text, word count and estimated duration. Narration audio and timestamps live in the Voice Engine's tables (§16), per take. |
| `script_blocks` | The narration blocks of a section, in `sort_order`: `block_key` ("3.4"), `text`, `generated_text` (what the model wrote; kept when the editor changes `text`), `info_class` (DOCUMENTED / RECONSTRUCTION / UNCERTAIN / FICTION / FRAMING), `beat_ids` (the architecture beats it tells), `speaker_id` + `speech_kind` (RECORDED_QUOTE / INVENTED), `fictional_device`, `delivery` (pace, energy, emotion, emphasis, pauses before and after with a reason), `visual` (intent, must show with claim keys, must avoid, priority, note), `presentation` (how uncertain claims must be worded), word count, estimated duration, `edited_by` / `edited_at`. |
| `script_block_claims` | Block ↔ dossier claim (FK), like the candidates' and opportunities' links. |

### Narration (Voice Engine V1, §16)

| Table | Notes |
|---|---|
| `voice_profile_families` | A saved voice profile (§16, *Saved voice profiles*): the stable identity, display name (unique, ignoring case), description, archived flag and library-default flag. Its settings live in its versions. Updated only in those four fields. |
| `voice_profiles` | The versions of saved profiles: provider, voice, model, language, output format and `config` (performance strategy, chunking, context, number style, the profile's pronunciation rules, performance rules, provider settings; versions made before saved profiles hold the earlier shape, `settings`). Never edited: an edit is a new version of its family (`family_id`, `version` per family, `based_on_id`, `origin`); the current version is the newest. `active` is read only to adopt a version written without a family. |
| `voice_selections` | A project's choice of profile per language version: the family (null: the library default), following its current version or pinned to one, the project's `overrides` of supported settings (never stored on the profile) and a `revision` incremented by every change. |
| `voice_runs` | One run ("Voice Run 3") of one approved script version with one profile version: scope (audition, section, blocks, range, full), strategy and chunk/context settings used, and `config`, what it was made with, frozen when it is created (version, the project's overrides, the run's options, the effective configuration with provenance, the provider settings as sent; null before saved profiles); `experiment` + `variant` group the runs of a comparison. |
| `voice_chunks` | The smallest generation unit: whole sentences of one section (spans into blocks), canonical `source_text`, its `text_hash`, each source block's hash (stale detection), why it ends where it does, the script's delivery, the current take. |
| `voice_generations` | Every take of a chunk (Generation 1, 2, 3…), never deleted: status PENDING → GENERATING → IN_REVIEW (the chunk's current take, awaiting a decision) → APPROVED / REJECTED / SUPERSEDED, or FAILED; GENERATED for stored audio that is not current (an A/B take, labelled in `variant`); canonical, spoken and performance text and the performance text's hash (`performance_text_hash`); the derived representation and its checks; seed; context sent; `config`, what the take was made with (the run's configuration or the production profile, any temporary override, how it differs from the run's; null before saved profiles); audio asset; measured duration; word and character timestamps; QA; ledger link. |
| `voice_assemblies` | A run's current takes in order on the measured clock (`entries`, each with its take's audio asset), the pauses between them, the narration `timeline` (the downstream contract), QA, the joined audio file once built. A new version whenever a current take changes, the one before superseded; DRAFT until every chunk has a take, then IN_REVIEW; the approved full assembly is what the VOICE gate approves (`approvals.voice_assembly_id`). |
| `voice_pronunciations` | The project's pronunciation review list: term, kind, method (the voice's own reading, alias, IPA, CMU), pronunciation, status (to check, approved, heard wrong), source and hint. |

### Writing (Writing Engine 2, §17)

| Table | Notes |
|---|---|
| `writing_examples` | House-style examples from the team's approved scripts, in the corpus's own shape (category, quality, traits, strengths, weaknesses, spoken rhythm, narrative function, why it works / fails, source, copyright-safe, approved for retrieval) with the script version and block they came from. CANDIDATE until a person approves (with a reason), rejects or retires it; one row per wording (`text_hash`). The seed corpus is files in the repository, not rows. A narration pass's record (corpus version, examples used, diagnostics before and after, money context, names, lineage) is part of `scripts.content` (`narration`, optional). |

### Creative artifacts (schema only — no code writes them yet)

| Table | Notes |
|---|---|
| `storyboards`, `shots` | Shot type, camera motion, visual type, duration, `direction` JSON (lens, composition, period, characters, props, lighting, colour, action, continuity), provider-neutral `generation_prompt` / `negative_prompt`, selected asset. Generation attempts are `provider_calls` rows with `shot_id`, so a failed shot is retried on its own. |
| `infographics` | Chart type + `spec` (the `InfographicSpec` contract: data, labels, annotations, mandatory source, animation, duration). Rendered deterministically. |
| `timelines`, `renders`, `qa_reports` | Per language. Timeline track contract is defined in the editing milestone. |

### Multilingual

```
MASTER STORY (research, story, script structure, storyboard, shots, maps, charts)  ── shared
      ├── en  narration · subtitles · timeline timing · render · metadata · publishing
      ├── es  …
      └── fr  …
```

Visual assets are stored under `projects/{id}/shared/…`; per-language assets
under `projects/{id}/{lang}/…` (`buildAssetKey`).

## 6. Provider abstractions

| Interface | Methods | Implementation |
|---|---|---|
| `AIProvider` | `generateText`, `generateObject(zodSchema)` | **Anthropic** (implemented): Claude, `claude-opus-5-5` by default, streaming, structured outputs (JSON schema from zod, re-validated), adaptive thinking with per-task effort, prompt caching of shared system prompts |
| `ResearchProvider` | `search`, `fetchDocuments(urls)` | **Tavily** (implemented): `/search` + `/extract` (full text as markdown, batches of 20). Planned alternatives: Exa, Claude server-side web search |
| `VoiceProvider` | `capabilities(model)`, `render(segments, model)` (pure: the model's own markup), `getVoices`, `generateNarration` (one small chunk; character timestamps, neighbouring text or request stitching for continuity, seed, phoneme dictionary), `getAudioMetadata`, optional `check()` (the configured voice and model, spending nothing) | **ElevenLabs** (implemented): `/v1/text-to-speech/{voice}/with-timestamps`, Eleven v4 by default (audio tags, no SSML), see §16 |
| `VideoProvider` | `createImage`, `createVideo`, `getGenerationStatus`, `downloadAsset` (+ `waitForGeneration` helper) | Higgsfield |
| `StorageProvider` | `put`, `get`, `head`, `delete`, `list`, `getSignedUrl` | **S3-compatible** (implemented): plain HTTPS with Signature V4 (verified against AWS's worked examples) — Railway Storage Buckets, Cloudflare R2, AWS S3, MinIO |
| `RenderProvider` | `renderTimeline`, `renderGraphic`, `getRenderStatus` | FFmpeg (assembly, mixing, loudness) + Remotion (infographics) |
| `PublishingProvider` | `uploadVideo` (privacy defaults to private; synthetic-media disclosure flag), `getPublishStatus` | YouTube Data API |

Every billable method returns `meta: CallMeta` (provider, model, mock flag,
usage items, vendor-reported cost). Stage code calls providers through
`ctx.callProvider(slot, operation, fn)`, which writes the `provider_calls` row,
times the call, prices usage with the provider's rate card and logs it.

**Adding a vendor** = one class implementing the interface + one entry in
`FACTORIES` in `packages/providers/src/registry.ts` + run the matching
`run…Contract()` suite from `packages/providers/src/contract` against it.
Configuring a planned-but-unbuilt provider (e.g. `VIDEO_PROVIDER=higgsfield`)
fails at startup with an explicit "planned but not implemented yet" error.

**Mock behaviour** (all labelled `MOCK`, all $0 but with realistic usage so
cost code is exercised):

- LLM: text is an explicit `[MOCK] … no language model was called` echo;
  structured output only from fixtures registered per task and validated
  against the schema.
- Research: results on `https://mock.invalid/...`.
- Voice: a real WAV (short beep + silence) whose length matches the words at
  150 wpm × speed, with character timestamps shaped like a tag-aware
  provider's (markup takes no time, pause tags leave silence) — the whole
  Voice Engine runs on it without credits, every take labelled MOCK.
- Video: async lifecycle simulated across polls; downloads a labelled SVG
  placeholder (`placeholder: true`); never video bytes.
- Storage: in-memory, lost on restart; signed URLs use `mock-storage://`.
- Render: writes a JSON manifest (`<key>.mock.json`) instead of media.
- Publishing: always `published: false`, no id, no URL.
- Any prompt/text containing `MOCK_FAIL` fails, to test retries.

## 7. Job architecture

```mermaid
stateDiagram-v2
  [*] --> QUEUED: enqueue (API) / retry
  QUEUED --> RUNNING: claim (FOR UPDATE SKIP LOCKED), attempts+1
  RUNNING --> SUCCEEDED: handler returned → maybe COMPLETE phase
  RUNNING --> QUEUED: retryable error & attempts < max (exponential backoff)
  RUNNING --> FAILED: non-retryable or attempts exhausted → project FAILED
  RUNNING --> QUEUED: worker shutdown (attempt not counted)
  RUNNING --> QUEUED: abandoned (no heartbeat within lock timeout)
  QUEUED --> CANCELLED: project moved to a new phase run
  FAILED --> [*]
  SUCCEEDED --> [*]
```

- **Queue (V1):** the `jobs` table. Workers poll with
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, so any number
  of workers can run without double-processing. All time comparisons use the
  database clock.
- **Runner:** `JobRunner` (N concurrent loops), heartbeat every 30 s while a
  job runs, abandoned-job recovery, exponential backoff (5 s → 5 min cap),
  non-retryable classification (`NonRetryableError`, non-retryable
  `ProviderError`, zod validation errors). On SIGTERM, in-flight jobs are
  returned to the queue without consuming an attempt.
- **Consistency:** job completion and the resulting project transition happen
  in one transaction; a worker that lost its lock cannot overwrite the job.
- **Stage handlers:** `StageHandler { type, mock, run(ctx) }`. Handlers get
  everything via `StageContext` (job, project, language version, db,
  providers, logger, abort signal, `callProvider`). They never construct
  infrastructure, so the same handler runs embedded, in a standalone worker, or
  under a future queue.

**Scaling path (not built, no code changes to stages):**

1. *Now:* worker embedded in the web service (`WORKER_ENABLED=true`).
2. *More throughput / isolation:* a second Railway service from the same image
   running `node apps/api/dist/worker.js`, `WORKER_ENABLED=false` on the web
   service, `WORKER_CONCURRENCY` > 1.
3. *If needed:* implement `JobQueue` with BullMQ/Redis (`notify` pushes the job
   id, `claim` pops ids and claims the row by id). The `jobs` table remains the
   source of truth; runner, handlers, API and dashboard are unchanged.
4. *Fan-out:* per-shot generation as child jobs (a `parent_job_id` column) when
   visual generation is real.

## 8. Observability

- **Structured JSON logs** (pino) with request, project, job, job type,
  attempt, provider, operation, duration, status and error fields. Secrets
  (authorization headers, `*.password|apiKey|secret|token`) are redacted.
  Pretty-printed only in a local terminal.
- **`provider_calls`**: per-call duration, status, error, usage and cost.
- **`project_events`**: the human-readable story of a project (shown in the
  dashboard "Activity" panel).
- **`/api/health`**: database reachability, worker state, version/commit,
  which providers are mocks, and whether real storage and the real voice
  provider answered the startup connectivity checks (`storage`, `voice`,
  with details; §16). Only the database decides the HTTP status.
- **Voice jobs** log a structured summary per chunk, per run, per
  regeneration and per experiment (§16, *Acceptance logging*).

## 9. Security

- Provider credentials are read server-side only (environment variables) and
  never sent to the browser; ledger request summaries never include them.
- HTTP Basic auth over the whole app when `DASHBOARD_PASSWORD` is set;
  **mandatory in production** (startup refuses otherwise) because the
  dashboard can trigger paid generation. Constant-time comparison.
  `/api/health` stays public for Railway's health check.
- All inputs validated with zod; unknown errors return a generic 500 with a
  request id (no stack traces leak).
- Security headers on every response (CSP `default-src 'self'`, `nosniff`,
  `DENY` framing, no referrer).
- Storage keys are validated against traversal; the browser will only ever get
  short-lived signed URLs.
- Runs as the unprivileged `node` user in the container.

## 10. Cost tracking

Providers report usage; `estimateCost(provider, model, usage, rates)` prices
it in integer micro-dollars (no float drift) and returns **unpriced** usage
separately instead of silently counting it as $0 (a warning is logged).
Per call: `estimated_cost_usd` and vendor-reported `actual_cost_usd`. Per
project: `projects.estimated_cost_usd` (planning estimate) and the actual sum
over the ledger (dashboard "Cost" card). Per language version: same ledger,
filtered by `language_version_id`.

Cost basis per ledger row (`provider_calls.cost_basis`):

| Basis | Meaning |
|---|---|
| `VENDOR_REPORTED` | The provider returned a dollar cost (`actual_cost_usd`). |
| `ESTIMATED` | Usage reported by the provider × configured price (`estimated_cost_usd`): Anthropic tokens × the served model's published per-token prices; Tavily credits × `TAVILY_USD_PER_CREDIT`; ElevenLabs characters sent × `ELEVENLABS_USD_PER_1K_CHARS` or the model's list price (its `character-cost` header is kept raw in `response.reported`, never priced). Labelled "estimated" in the dashboard. |
| `UNPRICED` | Usage without a configured price (counted in "unpriced calls", never as $0). |
| `MOCK` | Mock provider, $0. |

Failed calls keep the usage the provider reported (a refused or truncated
Claude response still costs tokens; an ElevenLabs response that arrived but
could not be used still costs its characters). When the provider says, a
row's `response` also records the HTTP attempts (retries included),
whether the usage was REPORTED by the vendor or COUNTED, and any figure the
vendor reported beside it (`reported`, raw, under its own name).

## 11. Research engine (milestone 2)

`modules/research` implements the RESEARCH stage. It talks only to the
`AIProvider` and `ResearchProvider` interfaces: Tavily discovers and
retrieves; Claude plans, judges sources, reads and synthesises; deterministic
code verifies.

```
plan ─▶ discover ─▶ triage ─▶ retrieve ─▶ read ─▶ synthesise ─▶ normalise ─▶ review ─▶ normalise ─▶ quality gate ─▶ persist vN
Claude   Tavily      Claude    Tavily      Claude   Claude        code          Claude    code          code             Postgres
```

1. **Plan** — up to 12 research questions (each with ≤ 4 search queries)
   from the topic, 12 generic focus areas (what happened, chronology, the
   traded thing and its rarity, context, participants, trading mechanisms,
   price evidence and where famous numbers come from, famous anecdotes,
   collapse, consequences, historians' disputes and whether "bubble" is
   deserved, the later narrative) and the project's research brief.
2. **Discover** — every query is searched (advanced depth, scholarly, book,
   archive and reputable-press domains *preferred*, social media and
   document-sharing sites *excluded*); results are deduplicated by
   normalised URL and given a domain-based type hint.
3. **Triage** — Claude selects up to 45 sources for full-text retrieval,
   favouring the source hierarchy (primary > academic > books > archives /
   museums / universities > reputable secondary > general web). Guardrails in
   code: at most 3 per domain; every question keeps ≥ 2 candidates.
4. **Retrieve** — full text via `fetchDocuments`. Pages under 600 characters
   (paywalls, stubs) count as failures. For high-tier works that failed
   (JSTOR, publisher sites usually refuse), one search looks for an
   **open-access copy**; a copy is accepted only if it is the same work
   (all words of a short title, ≥ 80% of a longer title, journal context for
   one- or two-word titles) and is retrievable; it becomes its own source,
   and the original stays FAILED with a pointer to it. Identical or
   near-identical texts (8-word-shingle Jaccard ≥ 0.85) are marked
   `duplicate_of` the stronger source and not read twice.
5. **Read** — Claude reads each document (long ones are cut to their
   most topic-relevant passages, never rewritten) and returns an assessment
   (real source type, author, date, reliability, whether it repeats popular
   myths) and evidence items, each with a **verbatim quote**. Code then
   checks every quote against the stored text (normalised for markdown,
   typographic quotes/dashes and whitespace; elided quotes must appear in
   order); unverifiable evidence is discarded and counted. Readings are cached
   per document.
6. **Synthesise** — from verified evidence only (grouped by focus area,
   with source types and reliability), Claude writes the claims and dossier
   sections. Verdict definitions are fixed in the prompt; MYTH requires
   contradicting evidence and a `popularVersion`; both sides of a conflict
   are cited.
7. **Normalise** (deterministic, applied before and after review; each change
   is recorded in the quality report): citations move off duplicates and off
   anything unverified or not retrieved; a MYTH without counter-evidence
   becomes UNVERIFIED; any claim left without citations becomes UNVERIFIED;
   ESTABLISHED/PROBABLE with only contradicting evidence becomes DISPUTED;
   ESTABLISHED contradicted by a tier-1/2 source becomes DISPUTED; ESTABLISHED
   needs two independent sources or one high-tier source, else PROBABLE;
   DISPUTED and UNVERIFIED are always flagged for verification.
8. **Review** — Claude checks the dossier for incoherence (verdicts not
   matching their evidence, contradictory claims, missing disputes). Fixes
   are limited to: set verdict, set confidence, flag for verification, remove
   claim; every issue and its resolution is stored.
9. **Quality gate** — pure function over the dossier
   (`computeQualityReport`): claim count, key claims, cited-source count,
   high-tier sources, source-type and domain diversity, general-web share,
   citations on every non-UNVERIFIED claim, no key claim resting on a
   snippet, all quotes verified, disputes and unverified claims flagged,
   myths with popular version and counter-evidence, valid retrieved URLs,
   duplicates merged, coherence, every question answered. FAIL on any check
   ⇒ the dossier is saved as DRAFT, the job fails without automatic retry
   and the project goes to FAILED (rewind to research again). PASS ⇒ the
   dossier is IN_REVIEW and the project waits at RESEARCH_REVIEW. **Nothing is
   ever auto-approved.**
10. **Persist** — one transaction: earlier DRAFT/IN_REVIEW versions become
    SUPERSEDED, the new version is written with its claims and citations.
    The approval decision is linked to the exact dossier it judged
    (`approvals.dossier_id`) and sets that dossier APPROVED/REJECTED.

Cost and safety: every provider call goes through the ledger; the run stops
(non-retryable) once its recorded spend passes `RESEARCH_MAX_COST_USD`,
checked between phases and before every uncached read. Progress messages
appear in the project activity log.

**Saved progress.** Each completed paid step (plan, discovered candidates,
triage selection, retrieval, synthesis, review) is written to
`jobs.checkpoint`. A retry (automatic, or a manual Retry, which copies the
failed job's checkpoint to the new job) replays the saved steps in order and
runs only what is missing; a step is reused only if every step before it was,
and saved model outputs are re-validated against their schemas. Readings need
no entry: they are cached per stored document. The checkpoint is cleared when
a dossier passes the gate. A new version (rewind and research again) starts a
fresh plan but still re-fetches only failed URLs and re-reads only new
documents.

**Text hygiene.** NUL and other control characters (common in text extracted
from PDFs; PostgreSQL rejects NUL) are removed at the provider boundary and
again before anything is stored or shown to a model. A document the database
still refuses fails only that source.

**Schema fallback.** Structured outputs compile the JSON schema into a
grammar, and the API refuses grammars over an unpublished size limit (the
synthesis schema hit it on the first live run). The Anthropic provider then
repeats the request with the schema in the system prompt and validates the
answer against the same zod schema.

## 12. Story engine (milestone 3, engine 1)

Section 13 describes what Story Engine 2.0 changes; the evidence rules below
still apply to both engines.

`modules/story` turns an **approved** research dossier into story units and
then into a documentary blueprint. It writes no script. Everything it says
traces to dossier claims, and every gate result is advisory: a human approves.

```
STORY_MINING:   mine (Claude) → evidence rules → critic (support + 8 scores)
                → [top-up mine + rules + critic if < 15 left] → rank
                → proposed selection (5–10) → mining gate → story pack vN
STORY_SELECTION (editor): approve / reject / flag, select, prioritise, notes,
                another mining pass with a brief
STORY_ARCHITECTURE: architect (Claude) → evidence rules → reviewer (may
                return a corrected version) → evidence rules → architecture
                gate → story architecture vN → STORY_REVIEW (human gate)
```

**Evidence rules** (`rules.ts`, `mining.ts`, `architecture.ts`; deterministic,
unit-tested). Claim keys must exist in the dossier. A named person must appear
in the evidence of the cited claims; if the dossier names them elsewhere, that
claim is linked (traceability), otherwise the candidate is removed (or, for a
side character, the character is dropped). Every figure (except years, which
need only appear in the dossier) must be in the cited evidence; a figure found
in another claim links that claim (one link, firmest verdict first, so a myth
or dispute is only pulled in when nothing firmer has the fact), a figure found
nowhere removes the candidate. A candidate using a MYTH claim must tell it as a
myth investigation (popular story → origin → who spread it → what happened →
why it survived). Candidates without a traceable source (a retrieved source with
a verified quote), without characters or an arc, duplicating another (claim-set
Jaccard, title overlap) or resembling one the editor rejected are removed —
each with its reason, kept in the pack for the editor to see.

**Historical status and confidence** are computed, never chosen by a model:
status from the weakest verdict (MYTH → myth investigation, DISPUTED →
contested, UNVERIFIED → uncertain, PROBABLE, ESTABLISHED); confidence 0–10 from
verdict strength × claim confidence, 60% mean / 40% weakest, discounted when
only one or two sources stand behind the story.

**Ranking** (`packages/core/src/story.ts`). The critic scores intrigue (0.20),
human drama (0.15), surprise (0.13), stakes (0.12), visual potential (0.12),
escalation (0.10), emotional weight (0.10) and economic significance (0.08),
0–10 each; appeal is the weighted sum. Rank score = appeal × (0.55 + 0.45 ×
confidence/10), so a sensational but weakly supported story does not
automatically beat a fascinating, well-supported one. The dashboard shows the
components, weights and the formula for every candidate.

**Story evidence vs background (architecture).** A sequence's story evidence
(`claimKeys`) is the selected units' own claims and nothing else: every key
event cites only those claims, every sequence tells at least one selected unit,
and every person, figure and date must come from the selected units' evidence
(a figure or person found in another selected unit's claim links that claim;
years count as figures here). Other claims of the approved dossier may appear
only as `contextClaims` — background with a stated purpose, their own derived
`contextSourceIds`, caveats when disputed — and cannot add a story, person,
event, figure, date or beat. The code checks this deterministically for
claims, events, figures and dates, for listed characters, and for the
dossier's key figures mentioned in the telling; whether prose smuggles in an
unnamed event is left to the reviewer and the editor. The architect sees the
units' claims as story evidence and the rest of the dossier only as a
one-line-per-claim background list.

**Links the rules add.** When a sequence uses a figure, a name or a character
that its cited claims do not cover, the rules link the single firmest claim of
the selected units that does (established before probable before disputed,
myth or unverified). A unit's character gets no link when the sequence already
cites one of their claims. (Linking every claim that names a character, as the
first version did, can pull a myth into a sequence that does not tell it, and
undo a reviewer's removal of it; this most likely failed the first live run.)
A linked claim that needs a caveat produces a finding that says what it was
linked for, so the reviewer can add the caveat or drop what needed it.

**Editorial control.** The AI's selection is a proposal (`ai_selected`); the
editor's `selected`, `status`, `priority` and notes are what the architect
gets. HIGH priority must be used (gate check); the architect must explain any
selected unit it leaves out. Candidates can only be changed in STORY_SELECTION
on the current pack. Another mining pass (from any later story status) rewinds
to STORY_MINING and enqueues the job in one transaction; approved and flagged
candidates are carried into the new pack, rejected ones are not proposed again.
Rejecting an architecture returns to STORY_SELECTION; the next version is
built with the rejection notes and the previous outline.

**Gates.** Mining: 15–30 candidates (fewer than 10 fails), evidence links,
traceable sources, named people and figures in the cited evidence, historical
status consistent with the verdicts, myth framing, no duplicates, complete
scores, story structure, variety, share of well-supported candidates, a 5–10
proposal. Architecture: central question, premise/spine, 3–12 sequences, every
sequence and key event cites claims, story evidence only from the selected
units' claims, every sequence tells a selected unit, other claims only as
labelled background (a warning if background outweighs story evidence),
sources derivable from the claims (story and background separately), HIGH
priority used, every disputed/unverified/myth claim used (story or background)
has a caveat (how the narration must present it), no invented or outside
people, figures and dates from the selected units' evidence, story rather than
a list of facts, runtime
within the project's range (±20% warns, beyond fails), sequence durations
consistent with their structure, no unresolved critical review issue. A failed
gate saves the artifact as DRAFT for inspection and fails the job without
retry; its saved progress is kept, so a retry re-evaluates without new model
calls.

**Cost control.** Each step's raw model output is saved in `jobs.checkpoint`
(`StepCheckpoint`); retries reuse completed steps. Every call goes through the
provider ledger (model, tokens, estimated cost, duration, failures); a job
stops once its recorded spend passes `STORY_MAX_COST_USD` (default $15). Typical
calls: mining 3–6 (mine, critic, selection; top-up only when needed),
architecture 2 (architect, reviewer).

## 13. Story Engine 2.0 (cinematic story layer, content opportunities)

Engine 1 finds story units; Story Engine 2.0 tells them as a story the viewer
experiences, inside the same evidence boundary. **Creative freedom applies to
presentation, never to historical truth.** The engine version is stored per
pack and architecture (`engine_version`: 1 = milestone 3, 2 = SE2); new jobs
write version 2, and engine-1 records stay readable through union contracts
(`AnyStoryScores`, `AnyStoryArchitectureContent`) — the dashboard and the API
render both.

```
STORY_MINING 2.0:  mine (human stakes, cold open labelled by information class, reveal,
                   central question, narrative mode, POV, reconstruction level)
                   → evidence rules → critic (9 story-value + 3 historical dimensions,
                   one reason each) → [top-up] → rank by STORY APPEAL
                   → proposed selection (+ central question, mode, POV) → mining gate
STORY_SELECTION:   + the editor's title / mode / central question / POV per unit,
                   and the editor's order of the selection
STORY_ARCHITECTURE 2.0: architect → rules → story editor (+ revision) → rules
                   → fact checker (+ revision) → rules → gate
                   → [content opportunities → rules] → architecture vN → STORY_REVIEW
```

**Information classes.** Every beat is DOCUMENTED (rests only on ESTABLISHED
claims), RECONSTRUCTION (a plausible scene built from documented
circumstances; cites its claims; never presented as a recorded event),
UNCERTAIN (probable, disputed, unverified or myth material, told with its
presentation) or FICTION (a declared device — the viewer's POV, a composite, an
invented line — that carries no facts). A MYTH claim may appear only in an
UNCERTAIN beat (myths are investigated). Every claim that is not ESTABLISHED
needs a presentation entry in each sequence using it: PROBABLE → HEDGE, and
the instruction must word the hedge ("records suggest", "contemporary accounts
indicate": `HEDGE_PATTERN`); DISPUTED → present as disputed; UNVERIFIED →
present as unconfirmed; MYTH → investigate as myth.

**Fiction boundary.** The cast declares everyone. Real people, groups and
roles must be grounded in the selected units' claims (an invented or outside
person is dropped and blocks the gate). Fictional devices: one viewer POV and
up to two composites before a warning. A composite needs claims showing people
like them existed, a justification, and a name nobody in the dossier has.
Fictional characters never take part in DOCUMENTED beats and never speak to,
touch or trade with real people (they may observe them); they never get a
recorded quotation, and real people never get invented lines. A
RECORDED_QUOTE must be a verified quotation of a claim the beat cites
(ellipses allowed); any words in quotation marks must be verified or a planned
invented line.

**Names, places, figures, dates.** The engine-1 rules, applied to everything a
viewer would see or hear — beats, speech, setting, visual notes, continuity,
and the framing (logline, thesis, cast descriptions): figures and years from
the selected units' evidence (a figure found in another selected unit's claim
links that claim, which then needs its presentation); no dossier person from
outside the selection; capitalised names that neither the dossier nor the
declared cast contains are flagged. A location or time of day presented as
DOCUMENTED must be in the sequence's evidence; otherwise it is a
RECONSTRUCTION.

**Continuity.** Q0 is the central question. Sequences open and resolve
questions (Q1…), carry objects and threads in and out, and mark time jumps
(flashback, parallel time). An unanswered Q0 fails the gate; unresolved or
unknown threads, things carried in that nothing carried out, unmarked jumps
back in time and missing transitions warn.

**Reconstruction budget — a warning only.** Reconstruction plus fiction above
40% of the beats, or fiction above 25%, warns; the level (none / low / medium
/ high) is shown. The editor decides.

**Dual scoring.** STORY VALUE (human stakes 0.16, conflict 0.12, mystery 0.12,
character potential 0.12, visual potential 0.12, escalation 0.10, emotional
potential 0.10, reveal potential 0.10, myth/investigation potential 0.06 —
only when the unit has myth or uncertain material; otherwise the others are
rescaled) and HISTORICAL VALUE (evidence quality = the computed historical
confidence 0.40, significance 0.25, relevance 0.20, uniqueness 0.15) are
scored and shown separately; STORY APPEAL = story value × (0.6 + 0.4 ×
historical value / 10) ranks the pack. A gripping story on weak evidence ranks
lower but is never hidden. Historical status and confidence are still
computed, never chosen by a model.

**Two reviewers.** The story editor asks whether it is a story (immersion,
human stakes, narrative drive, continuity, cinematic potential, clarity, and
the three quality-bar questions) and may revise for drama; the fact checker
then has the last word on the evidence and may revise. Each revision is kept
only if the rules find no more blocking problems in it than in the version it
revised. The story editor's verdict is recorded and never fails the gate; an
open CRITICAL fact issue does.

**Content opportunities.** Only for an architecture that passed its gate, a
third call identifies LONG_FORM, SHORT and BOTH opportunities (typically 4–8
strong shorts for a 10–15 minute film; never padded; at most 12). Each must
name existing beat ids; its claims must be claims of those beats or their
sequences (so only approved dossier claims, and only those in the
architecture); it may not add figures, years, people, names or quotations;
it copies the architecture's presentation for every claim that is not
ESTABLISHED. One that breaks a rule is removed with its reason (the job does
not fail). Shorts are ranked by SHORT-FORM POTENTIAL (hook 0.25, payoff 0.20,
standalone 0.20, visual 0.15, emotion 0.10, pace 0.10); durations are brought
within 15–180 s. All are stored PROPOSED with claim links; the editor approves
or rejects each one (on the latest architecture that passed its gate — a
failed revision's draft does not count — while it is in review or approved). `GET|POST /api/projects/:id/content-package` (`{"documentary": true,
"shorts": 6, "languages": ["en","es","de"]}`) resolves what a production
request would use — the latest approved architecture and its approved shorts
by rank — and generates nothing (`generated: false`; languages are only
recorded until localization exists).

**Editorial control.** Per unit the editor can override the title, narrative
mode, central question and POV (`editor_overrides`; the AI's values are kept;
`null` restores them) and order the selection (`selection_order`; the
architect works in that order and must explain a change in `orderNote`,
otherwise a warning). Generating the architecture accepts preferences
(narrative mode, POV, central question).

**Research boundary.** The story engine reads the approved dossier and never
writes to research tables; a static test guards the story code and the story
API, and an integration test compares the research tables before and after a
full story run. Production prompts use generic illustrations only, never facts
of a particular topic.

**Cost.** Mining makes the same 3–6 calls as engine 1 (larger outputs);
architecture makes four (architect, story editor, fact checker,
opportunities; the last only after the gate passes). `STORY_MAX_COST_USD`
still caps each job.

**Limits (heuristics, stated honestly).** Interaction and interiority are
detected by subject–verb–object patterns over the declared cast's name tokens:
prose that implies contact without such a pattern ("their hands meet over the
contract") is left to the fact checker and the editor, and interiority only
warns. Unknown names are detected by capitalisation against the dossier's
words and the cast: a capitalised common word the dossier lacks would be
flagged (a false positive that blocks until reworded) and a lower-case
invented place would not. An invented event in free prose cannot be detected
mechanically: the boundary rests on traceability (every beat and opportunity
cites claims; classes are checked) and on the reviewers and the editor.

## 14. Editorial revision loop and alternative angles

An architecture is a draft for an editor, not a verdict. Two capabilities let
the editor change how the story is told — never what the evidence says — and
both stay inside the same evidence boundary as §12–13: **the story pack's
units and their approved claims; no new research**. No research provider is
called (an integration test checks the provider ledger), and the research
tables are never written.

```
Reconsider / Revise:  POST /api/projects/:id/story/architecture/revise
                      { baseVersion, brief, aspects[], preferences?, angle? }
  → STORY_ARCHITECTURE job (input.revise)  → architect REVISES vN (task story.revise)
  → rules → story editor (+ the brief) → rules → fact checker (+ the brief) → rules
  → gate (+ revision checks) → [opportunities] → architecture vN+1 → STORY_REVIEW

Explore angles:       POST /api/projects/:id/story/angles { count: 2|3, notes?, basedOnVersion? }
  → STORY_ANGLES side job → one call (task story.angles) → angle rules
  → story_explorations vK (nothing committed; the project's status is unchanged)
  → the editor develops one: POST …/story/architecture { angle } (selection)
                         or …/story/architecture/revise { angle, … } (review / approved)
```

Both go through their own routes, which check the request (base version,
angle, pack, selection) and record it with the brief; the generic
`POST /api/projects/:id/jobs` refuses STORY_ANGLES and a revision input.

**The units a revision or an angle may use** are the latest pack's selection
(not rejected) plus units the editor *approved but did not select* — the
reserve, shown to the model as optional and marked in the prompt. A plain
new architecture still uses the selection only. Any other unit key the model
names is dropped with a note; claims outside those units are the existing
`CORE_OUTSIDE_SELECTION` / `BEAT_OUTSIDE_SELECTION` findings, and figures,
years, people, names and quotations follow the §12–13 rules.

**Revision.** The editor names what is not working on a checklist (angle,
POV, emotional centre, opening, structure, pacing, narrative strategy,
central question, human stakes) and writes a freeform brief (required, at
least a sentence). Any version of the current pack can be revised — under
review, approved, superseded, rejected, or a failed draft — from
STORY_SELECTION (START), STORY_REVIEW or STORY_APPROVED (REWIND), or after a
failed architecture run (RECOVER). The revision reuses the STORY_ARCHITECTURE
job type (`input.revise = { baseVersion, aspects }`, `input.notes` = the
brief). The architect receives the brief and checklist, the base version as
its own JSON, the base's gate findings, the story editor's verdict, the
editor's decisions and notes on it, the units and their claims. The prompt
explicitly permits substantial restructuring — reorder, merge or split,
remove, replace sequences with listed units (reserve units included), change
the narrative mode or POV where justified, strengthen the human stakes or
emotional centre, change the central question, rethink the opening — and
requires a change log: a summary, each change with its area, what and why,
and what was deliberately kept. Both reviewers then run again on the revision
and are told it is one, with the brief.

**What changed is measured, not taken on trust.** Code compares the final
revision with its base (`diffArchitectures`): units added, removed,
reordered, merged into one sequence or split apart; sequence count; opening;
central question; narrative mode; POV; logline; human stakes; cast; runtime;
beats; reconstruction level; and `substantial` (any structural change, new
opening, mode, POV or central question). Two checks are added to the gate,
both warnings: `revision_explained` (the architect gave a change log) and
`revision_brief` (an aspect the editor ticked shows no measurable change —
mapped heuristically, e.g. OPENING → the first sequence's units or opening
beat; PACING → structure, runtime or beat count). The editor sees the brief,
the architect's account and the measured changes side by side.

**Versions are never overwritten.** A revision is always a new version
(`revision_of_id` → the base; `content.provenance` = kind, base, brief,
aspects, angle, change log, diff, reserve keys). The base is never modified.
A revision that passes its gate supersedes the DRAFT / IN_REVIEW versions as
a new build does; one that fails is saved as a DRAFT, the project is FAILED,
and the base keeps its status (the error says so: "Architecture v1 is
unchanged (IN_REVIEW)"). An approved base stays APPROVED while its revision
is in review; approving the revision supersedes it (kept, with an
`ARCHITECTURE_SUPERSEDED` event). Events: `ARCHITECTURE_REVISION_REQUESTED`
(with the brief), `ARCHITECTURE_SUPERSEDED`.

**Alternative angles.** One call proposes 2–3 *materially different* treatments
of the same units (title, logline, central question, emotional centre, human
anchor, narrative mode, POV, opening with its information class, movements
over unit keys, resolution, units left out with reasons, strengths, risks).
The rules (`buildAngles`) then: keep only the pool's units (an angle telling
fewer than two is removed); label the opening honestly (second person →
RECONSTRUCTION; DOCUMENTED needs ESTABLISHED claims, otherwise UNCERTAIN);
derive the angle's claims from its units and compute its historical status
and confidence; remove an angle with a figure or year outside those claims,
a dossier person outside the units, an unknown name, or an unverified
quotation; flag a HIGH-priority unit left out. **Materially different** means
at least two core differences among narrative mode, POV, opening and human
anchor — or one, plus a different central question and structure; an angle
too close to one already kept (or to the architecture it is an alternative
to, `basedOnVersion`) is removed with the reason. At most `count` are kept,
keyed A1…; each pair's differences are recorded. Fewer than two surviving
angles fail the side job (the exploration is still saved for inspection; the
project is unaffected).

**Developing an angle.** During selection, `POST …/story/architecture
{ angle: { exploration, key } }` builds a new architecture on it (the pool
includes reserve units); in review or after approval the angle goes with a
revision. Either way the architecture records `exploration_id` / `angle_key`
and `provenance.angle`, and the exploration shows which versions developed
which angle. An exploration from an earlier pack can be read, not developed.

**Prompts and checkpoints.** `PROMPT_VERSION` is `story-2.1-2026-10-04.1`:
saved story checkpoints from earlier prompt versions are not reused. Prompts
still use generic illustrations only.

**Cost.** A revision makes the same four calls as an architecture (architect
→ revise, story editor, fact checker, opportunities); an exploration makes
one. `STORY_MAX_COST_USD` caps each job.

**Limits (heuristics, stated honestly).** "Materially different" compares
enum fields exactly and free text by word overlap (`titleSimilarity`); two
angles that differ in substance but share wording could be judged too close,
and two that differ only in labels pass — the editor compares them. The
brief-coverage check maps checklist aspects to measurable changes; an aspect
can be answered by a subtler change (tone within the same structure) that it
cannot see, which is why it only warns. A revision cannot add research: if
the brief needs facts the dossier does not have, the architect can only say
so (or leave it), and new evidence means a new research pass. After a failed
revision the project is FAILED; the way back is to retry, revise again, or go
back to the selection — there is no "return to reviewing vN" action yet.

## 15. Script Engine 1.0

`modules/script` turns the **approved** Story Engine 2.0 architecture into a
structured spoken script. It tells the architecture; it does not reinterpret
the research. Its evidence is exactly the architecture's: the claims its
sequences and beats cite (including labelled background claims), read from
the dossier the architecture was built on. It never writes to research or
story tables (a static test scans the stage, the API and the read models; the
integration tests compare those tables before and after) and calls no
research provider.

```
POST /api/projects/:id/script { notes? }            (STORY_APPROVED → SCRIPT_DRAFT, START;
                                                     or a fresh draft from SCRIPT_REVIEW / SCRIPT_APPROVED)
  → SCRIPT job:  planner → writer → rules → script editor (+ patch) → rules
                 → fact checker (+ patch) → rules → performance → gate
  → script vN (IN_REVIEW) → SCRIPT_REVIEW → the editor → gate SCRIPT → SCRIPT_APPROVED

POST /api/projects/:id/script/revise { baseVersion, sections: [3], brief }   one section (or several)
POST /api/projects/:id/script/revise { baseVersion, brief }                  the whole script
POST /api/projects/:id/script/refine { baseVersion, instructions? }          the narration refined, story unchanged
POST /api/projects/:id/script/restore { version }                            an earlier version, as a new one
PATCH /api/script-blocks/:id · PUT /api/script-sections/:id/order · PATCH /api/script-sections/:id
GET  /api/projects/:id/script[?version=N] · …/script/compare?a=&b= · …/script/voice-plan[?version=N]
```

The generic `POST /api/projects/:id/jobs` refuses a SCRIPT revision and, where
the stage is real, routes a SCRIPT job through the same service call (which
checks for an approved architecture first). Where the AI provider is a MOCK,
the script routes refuse to write (409): a script is never faked.

**The five steps** (each a structured-output call through the `AIProvider`
interface; tasks `script.plan`, `script.write` / `script.rewrite`,
`script.edit`, `script.factCheck`, `script.perform`):

1. **Planner** — the narrator (persona, tone, approach) and a plan per
   sequence: purpose, approach, what to show rather than say, the exposition
   it needs, tension, reveal, whether narration should be sparse, and a share
   of the target runtime.
2. **Writer** — the narration as blocks, each realising named beats, with its
   information class, the claim keys behind it, a speaker for quoted or
   invented lines, and visual intent. Code then derives the rest: block keys
   ("3.4"), word counts and durations, presentation instructions for
   uncertain claims (from the architecture), the fictional-device flag, and
   which blocks pose and answer the central question. Claim keys outside the
   architecture and beat ids it does not have are dropped with a note.
3. **Script editor** (craft) and 4. **fact checker** (the last word on
   facts) — each returns a verdict, issues (severity, kind, block, note) and a
   targeted patch: edits, removals and insertions by block reference. A patch
   is applied, the blocks renumbered, and the patch **kept only if the rules
   find no more blocking problems after it than before**; where blocks moved
   is tracked so every issue still points at the right block, and each issue
   records whether it was fixed. The editor's scores (narrative, audio flow,
   clarity, emotion, ending) are recorded and never block. A reviewer that
   cannot run (a permanent provider error) is reported on the gate, not fatal.
5. **Performance** — delivery only where it matters (pace SLOW / NORMAL /
   FAST, energy LOW / MEDIUM / HIGH, emotion NEUTRAL / TENSE / CURIOUS /
   SOMBER / EXCITED / REFLECTIVE), semantic pauses (MICRO / SHORT / MEDIUM /
   LONG, each with a reason: REVEAL, NUMBER, EMOTIONAL_TURN, TRANSITION,
   IMPACT, QUESTION, RHYTHM), emphasis on words that are in the block's text (others are
   dropped), and pronunciation notes (respelling, IPA when known, language,
   confidence). **Every model pronunciation is flagged for human review**;
   one an editor confirmed is never replaced by a model's.

**Information classes.** A block keeps the class of the beats it tells:
DOCUMENTED, RECONSTRUCTION, UNCERTAIN, FICTION — plus FRAMING for the
narrator's connective lines, which may carry no claim, figure or date. The
class is stored per block and shown in colour; fictional devices are flagged
and dashed.

**The rules** (`checkScript`, deterministic) run after every model step,
after every human edit and on the final version. *Blocking* findings:

| Area | Findings |
|---|---|
| Evidence | a claim the architecture does not cite; narration that realises no beat; documented / uncertain / reconstructed narration citing no claim; a figure or year in none of the block's claims (or the architecture's, which are then linked); a dossier person the architecture does not cite; a name nobody knows; documented or uncertain narration naming a real person that cites no claim about them (§15, Script Quality Rules) |
| Classes | a class that does not match the beats; DOCUMENTED resting on claims that are not ESTABLISHED; framing with facts; fiction where none was planned |
| Uncertainty | MYTH told as fact or outside uncertain narration; DISPUTED / UNVERIFIED without words saying so; PROBABLE without a hedge |
| Fiction | a fictional device in documented narration; fiction speaking to, touching or trading with a real person; fiction performing a documented or dated act (a year or calendar date in the same sentence); fiction carrying figures or dates |
| Speech | a speaker outside the cast; words given to a real person that are not a verified recorded quotation; a fictional character given a "recorded" quote; a recorded quote that is not verbatim in its claims' verified quotations; any quoted words that are not a verified quotation |
| Structure | a sequence with no narration; the central question never posed or not answered at the end; runtime more than 20% outside the target range; an open CRITICAL fact-checker issue on a block nobody has changed since |

*Warnings* (the editor decides): a beat told in another sequence; the question
posed late; runs of facts with nobody in them; exposition-heavy sections; low
human presence; the reconstruction budget (40% reconstruction + fiction, 25%
fiction); real people apparently given thoughts or feelings; written-for-the-
ear checks (long sentences or blocks, over 75 s without a pause or scene
change, repetitive openings, repeated phrases, stock AI phrases, rhetorical
questions, formulaic transitions, symbols a narrator cannot read); pause and
emphasis overuse; runtime near the edge; sections far from their planned
length; pronunciations to confirm or missing for a name; a visual detail to
show without its claims; and the Script Quality Rules below (retellings and
recaps, passenger facts, pacing, page syntax, meta-narration, introductions,
uncited assertions, where to cut). The wording, subject–verb and speech
patterns are heuristics and are documented as such: they catch the common
cases, the two reviewers and the editor the rest.

**The gate blocks approval, not review.** A script job that produces a script
always saves it IN_REVIEW and moves the project to SCRIPT_REVIEW, so the editor
can see and fix what failed. Approval at the SCRIPT gate is refused (409) while
the version has blocking findings or a REJECTED section. Approving supersedes
the earlier approved version (kept, `SCRIPT_SUPERSEDED`).

**Timing.** 150 spoken words a minute (years read as two words, "1,200" as
two, punctuation silent), divided by a pace factor (SLOW 0.88, NORMAL 1, FAST
1.12), plus pauses (MICRO 0.25 s, SHORT 0.6 s, MEDIUM 1.2 s, LONG 2 s). The
target is the project's runtime (`runtimeTarget`: the range and its
midpoint); the variance is shown, and the fit is WITHIN, NEAR (a warning) or
OFF (more than 20% outside the range: blocking). The prompts say not to pad to hit a number.

**Editing.** Only the version under review is changed, and only in
SCRIPT_REVIEW: a block's text, class, delivery (pace, energy, emotion,
pauses, emphasis) and visual intent; the order of a section's blocks; a
section's decision (approve / reject) and note. Each change re-runs the rules
at once (no model calls), keeps the generated text, and is logged with what it
was before (`SCRIPT_EDITED`, `SCRIPT_SECTION_REVIEWED`). A figure the editor
types that another claim of the architecture supports links that claim.

**Regeneration and versions.** "Regenerate section" makes a new version from
the base: only the chosen sections go to the writer (`script.rewrite`, with
the whole script for the joins, the editor's notes and brief, and the base
plan — no planner call); every other section is **copied unchanged** (text,
edits, order, decisions) with no model calls; the reviewers and the
performance pass see and may change only the rewritten sections. "Generate
revision" rewrites the whole script from a brief (planned again). "Restore"
copies an earlier version as a new one (rules re-run, no model calls). A new
version supersedes the DRAFT / IN_REVIEW ones; nothing is ever deleted or
changed after the fact. Each version records what changed and why (the
writer's change log), who asked, the brief, the architecture version, the
models that served each step, its cost (the job's ledger rows) and when;
`compare` shows two versions section by section (blocks same / removed /
added, words and durations). A revision must tell the currently approved
architecture: a script of an earlier architecture can be read and restored
only if that architecture is still the approved one, otherwise a new draft
is needed.

**Narrative refinement.** A script can be structurally right and still read
like an essay. "Refine the narration" makes a new version (origin
REFINEMENT) whose *telling* is rewritten for the ear while everything the
architecture decides stays: the story, angle, people, central question,
fictional companion, sequence order, every block's information class, beats
and claims, recorded quotations. It skips the planner (the base's plan and
narrator are kept) and calls `script.refine` with its own prompt — the voice
(one intelligent viewer, a confident, curious, restrained narrator), and the
craft: cut meta-narration that talks about the film, protect the strongest
lines word for word (returned as `keptLines`), information through story
(situation → curiosity → fact → consequence), no purple prose, trust the
viewer, rhythm, room for silence, facts with consequences, uncertainty said
naturally, the legend met first and overturned by the record, a fictional
companion as a lens, cuts only of what is weak, transitions through
consequence, sources as detective work, an earned turning point; the runtime
follows the story within the acceptable range, never padded — weak material
(retellings, recaps, passengers) is cut before anything is added, over the
maximum the ranked cuts come first, and slightly over is acceptable only when
what remains is strong (see Script Quality Rules). **This house style is built in**: a
refinement with no instructions gets all of it. The system prompt ranks what
the model follows — (1) evidence and safety, non-overridable; (2) the
refinement style, the defaults; (3) the architecture and the script's
constraints; (4) what the script editor, the fact checker and the rules said
about the base; (5) the director's instructions — and the user prompt is laid
out in that order, the director's optional instructions and section notes
last ("None. Apply the refinement style in full." when there are none).
**Director's instructions** (the optional field, `instructions`) may steer
style, emphasis, pacing and creative direction, adjusting the defaults and
the reviewers' craft notes; they never override factual integrity, the
architecture, information classes, quotation integrity or the boundaries of
fictional characters — the prompt says so, and the deterministic rules and
the gate enforce it whatever the model does (a test has the director ask for
an unhedged claim and a new number, the model comply, and the gate block
approval). The system prompt does not depend on the instructions. The
examples in it are generic, like every production prompt (a test checks for
topic terms). Then the usual chain: the
script editor — shown the base for comparison — answers a fixed 13-question
refinement checklist (`REFINEMENT_CHECKLIST`: curiosity in 30 seconds, the
companion useful, every section advancing, facts that matter, an earned
turning point, momentum, a person speaking, no needless explanation, strong
lines kept, the ending answering the question, legend versus record,
historically defensible, runtime in range — each YES / PARTLY / NO and
BETTER / SAME / WORSE than the base, with a note; recorded, never
blocking); the fact checker is told the version is a refinement (hedges,
numbers, quotations and fiction must not move); the performance pass marks
every block again; the gate decides as for any version. A section the
refinement returns empty is kept as it was (noted). Four model calls.

**Comparing versions** (`GET …/script/compare?a=&b=`): words and runtime;
blocks; each version's gate (FAIL and WARN checks), the cost of the job that
wrote it, the script editor's scores and the spoken words by information
class; sections changed; words removed and added (a longest-common-
subsequence diff over the words, per section); the evidence that moved —
claims cited and figures said that one version has and the other does not (a
refinement should show none); the newer version's change log and kept lines;
its refinement checklist; then the block diff per section. Choosing the
older version means restoring it (a new version; nothing is lost).

**Voice handoff (no audio).** The script is provider-neutral. A
`VoiceScriptAdapter` turns it into a read-only summary;
`ElevenLabsScriptAdapter` is now a legacy character estimate: the script's
text as written, one segment per run of blocks with the same pace in a
section, the neighbouring text, and a pronunciation dictionary of
**confirmed** entries only (the rest listed as pending). It writes no markup
(no `<break>`, no tags) and lists the pauses, emphasis, energy and emotion it
leaves out. The Script page shows it as "Voice estimate (legacy)", and `GET
…/script/voice-plan` still returns it. Narration itself is the Voice
Engine's (§16), which plans the real chunks, renders each model's own markup
(audio tags and no SSML for Eleven v4), and never changes the script.

**Visual handoff.** Each block carries visual intent (CINEMATIC_RECONSTRUCTION,
DOCUMENT, MAP, DATA, TIMELINE, ARCHIVAL, PORTRAIT, ENVIRONMENT,
ABSTRACT_METAPHOR, ON_SCREEN_TEXT, NONE), must-show details with the claim
keys behind them, must-avoid notes and a priority. Fiction's visuals are
marked fictional.

**Models, cost, checkpoints.** The model is the AI provider's default
(`AI_MODEL`) unless `SCRIPT_MODELS` names one per step
(`perform=…,edit=…`); per-step effort and token limits are in
`DEFAULT_SCRIPT_CONFIG` (the writer, which returns the whole script, has the
model's full 128k output budget: Tulip Mania's 15-minute draft used about
46k output tokens with thinking, and a truncated output fails the job). Every call is a `provider_calls` row with its
estimated cost; `SCRIPT_MAX_COST_USD` (default 15) stops a job (FAILED, not
retried) once its recorded spend passes it. Each step is checkpointed
(`PROMPT_VERSION` = `script-1.4-2026-10-05.1`): a retry resumes after the last
completed call. A section rewrite makes 4 calls (rewrite, editor, fact
checker, performance) over the chosen sections; a refinement 4 (refine,
editor, fact checker, performance) over the whole script; a draft or whole
revision 5.

**Uncertainty, said naturally.** The wording checks accept the ways a
narrator actually says a claim is uncertain — "it seems", "the accounts don't
agree", "the sources differ", "it's not clear", "there's no way to check",
"it comes from a single source", "we need to be careful here", "the famous
version", "you may have heard", "as it's usually told" — as well as the
formal ones; the hedge must still be in the block that tells the claim, and a
myth told plainly still fails.

**Script Quality Rules** (`craft.ts`; deterministic; any subject). The first
live refinement (Tulip Mania v1 → v2) read better, but it kept weaknesses no
rule measured: an ending that recapped earlier sections, facts along for the
ride, a fictional companion labelled clumsily, colon lists, a line about the
film itself, a runtime that grew past the maximum, and a change log that
misstated its own length. Rather than fix that film, the engine measures each
weakness for any documentary. The tests use synthetic films from five domains
(a start-up, a comet, a siege, a composer, a harbour fire), and one checks the
module names no documentary, person, place, date or claim.

| Area | Findings | What is measured |
|---|---|---|
| Said once | RETOLD_CONTENT, RECAP_SECTION, CLAIM_RETOLD | A block whose content words — the film's subject words (in 30% of blocks or more) aside — were mostly said by an earlier block (60%, or 45% over the same claims or beats; at least 4 shared words); a section spending a quarter of its time retelling earlier ones; one claim explained again in three or more sections |
| Deliberate repetition | REFRAIN_LOST; exempt from the rest | Repetition with a purpose. A refrain: a short line said again in a later section. A callback: a later passage that returns to an earlier section's material at a point that gives it meaning — the last section or the answer, a section's close, a turn, reveal or consequence, a bookend of the opening, or words that recall or reverse ("the same… that once… now") — either echoing a distinctive 3–8-word phrase or recalling the earlier idea in new words while mostly saying something new; its purpose is recorded (payoff, reversal, resolution, closure). Never a callback: uncertainty language ("historians disagree"), a recurring person, source, place or term (a phrase, or two content words of it, in three blocks or more), a repeat within one section, or blocks that otherwise retell each other or re-say a claim they share. An escalation: short sentences in a row opening the same way. Devices are kept out of the redundancy and repetition checks and never offered as cuts; a version that drops one, or says it once, is warned. A purposeful return that mostly says something new is good repetition, not a retelling; one that only says it again is not |
| Every fact earns its place | PASSENGER_FACT, SOURCE_CHATTER, NAME_LOAD | A passenger candidate is a factual block that gives the viewer nothing the story needs — no story beat (beyond orientation or transition), no key claim or central question, nobody, no cause and effect, no open question, no deliberate repetition, and nothing a later section builds on (its claim, two of its distinctive words, a name or a figure coming back later). Flagged for the writer and the editor with what it lacks, never cut automatically; a minor-looking fact a later section relies on is not disposable. Three or more authorities named once only to be cited; three or more new names in one block |
| Pacing | SECTION_OVER_BUDGET, ENDING_DRAG | Over the maximum: a section 15 s and 20% over its planned share of the maximum; an ending 1.5 times a typical section and 30% over its plan |
| For the ear | WRITTEN_SYNTAX, LIST_SENTENCE, NUMBER_DENSE, NOUN_HEAVY, MONOTONOUS_RHYTHM | Colons, semicolons, parentheses, written-register words; four or more items in one breath (a triple is rhetoric); three numbers in a sentence (the day of a date is part of it); essay nominalisations; a section of eight or more sentences of nearly one length |
| Meta-narration | META_NARRATION | The narrator talking about the film ("we're going to test", "as we'll see", "before we test it"); one framing line is allowed in the first section |
| Introductions | PERSON_UNINTRODUCED, DEVICE_UNINTRODUCED, DEVICE_RELABELLED, DEVICE_LABEL_STACKED | A real person first named without what they do; a fictional device not introduced as invented where it first appears (in the narration or an on-screen label), labelled again later, or labelled several ways at once |
| Assertion → evidence | **PERSON_WITHOUT_EVIDENCE** (blocking), PERSON_WITHOUT_EVIDENCE_SCENE, UNCITED_CLAIM_MATCH | Documented or uncertain narration naming a real person that cites no claim about them (in a reconstruction, a warning); a sentence that says most of what an uncited claim says |
| Runtime | RUNTIME_PLAN | Over the maximum: a ranked cut plan — retellings and passengers first, then meta-narration, name load, uncited assertions, page syntax, background-only blocks and blocks of sections over budget — covering one and a half times the excess; a block a later section builds on is ranked down ("compress, don't cut"); and what never to cut: the central question and its answer, the turn and the reveals, recorded quotations, each cast member's first appearance, refrains, callbacks and escalations, lines a refinement kept on purpose, the only telling of a KEY claim |

Names are runs of capitalised words ("Ada Brennan" is one name); at the start
of a sentence, a capital is a name only if the word is capitalised inside a
sentence elsewhere, the run has two words, or it "says" something ("Lindqvist
argues") and is never written in lower case.

*How the stage uses them.* The writer, a rewrite, the refinement and the script
editor carry the same STORY ECONOMY rules in their system prompts. Every
reviewer sees the findings — blocking ones first, then the story-level rules,
then the sentence-level warnings, a kind found in many places shown four times
and then listed — with the deliberate repetition to keep. The refiner sees them
for the base, with the base's cut plan when it runs long; the script editor
gets the cut plan when its version runs long (make the cuts the story can
afford, never a protected block); the fact checker starts with the evidence
rules; the performance pass is told the measured runtime and adds no pause the
story does not need when it already runs long. Models misjudge their own
length, so the writer no longer states it, and a change log that does — more
than a tenth off the measured whole-film words or runtime — is noted in the
report ("Length: …"). The job log records a digest of the rules (words,
runtime, findings by kind and where, the repetition kept, the cut plan) for
the version a run starts from, the versions it replaces and the one it makes —
"Script quality rules, v1 → v3: RETOLD_CONTENT 6 → 1, …" — so a version can be
judged against the one before it. A human edit is re-checked against the same
base and kept lines. In the gate the rules add the checks *what is said about a
person rests on a claim about them*, *said once*, *every fact earns its place*,
*the story, not the film about it*, *people and devices introduced once,
plainly* and *if it runs long: where to cut first*; a check fails only on a
blocking finding.

**Granular review: every reviewer change judged on its own.** The script
editor and the fact checker return patches of edits, removals and insertions,
each with its reason. Each change gets an identity (E1, E2… for the script
editor, F1… for the fact checker) and is tried on a copy of the script as it
stands, with the changes kept so far; the rules run, and the change is kept
only if it adds no blocking finding — compared by rule, block identity and
wording, so renumbering cannot hide a new problem — and drops no claim link.
A change that cannot apply (no such block, a block an earlier change removed,
a section the run may not change, no change at all) is skipped. One bad
change never costs the good ones; a final validation checks the kept changes
together. Every change is recorded with the version (`content.reviewChanges`:
id, reviewer, type, section, the block as seen and where it ended up, the
original and proposed text, the reason, ACCEPTED / REJECTED / SKIPPED, the
rules it resolved or broke, and why it was rejected or skipped) — "Violates
uncertainty presentation — Block 3.1: I3 is PROBABLE but the narration does
not hedge it [PROBABLE_UNHEDGED]". A reviewer's issue says whether its own
change fixed it or was rejected, and why.

*The invariants* no refinement, reviewer change or performance mark may
weaken, each guarded by blocking rules: evidence traceability, factual
defensibility, information-class integrity, claim relationships, fictional-
character and real-person boundaries, recorded-quote integrity, uncertainty
presentation, the architecture, the approved sequence, the central question —
and the runtime maximum for performance timing. The prompts say it plainly:
prefer slightly weaker prose with correct evidence over better prose that
blurs the evidence.

*Evidence beyond numbers* (blocking, `evidence.ts`): a sentence about a real
person that says what a claim about them carries — an action, a detail, by
word stem (bought / buy) — when the block does not cite that claim
(ASSERTION_UNCITED); a sentence kept from the version a run started from
(word for word, or 80% of its words) that no longer cites the claim behind it,
whose words are still in it and in no claim the block now cites
(CLAIM_LINK_LOST — also checked for every reviewer change against the script
just before it); probability wording ("probably", "most likely", "what
probably happened") for a myth, an unverified or disputed claim, a
reconstruction or a framing statement, with no PROBABLE claim behind it — a
truth status upgraded (UNCERTAINTY_UPGRADED; a question asks, it does not
assert).

*What the reviewers see.* The script editor and the fact checker see the
version the run started from, the writer's change log (its own account — the
measured figures are what count), the lines the writer removed on purpose (so
a deliberate cut is not taken for an accident), the lines a refinement kept,
and — for the fact checker — every change the script editor proposed and what
became of it: an accepted change is not to be undone unless it broke the
evidence, a rejected one not proposed again without fixing why.

**The performance budget.** Before the performance pass the stage measures the
narration with no performance timing in the sections it marks and gives the
pass its budget: "the narration runs 14:31, so your pauses and slower delivery
together may add at most 0:29". Whatever it marks is then held to the
maximum: if the full runtime passes it, the least valuable timing goes first
— rhythm, question and number pauses, then slower delivery, then transitions,
emotional turns, impact and, last, reveals — a pause reduced a step at a time
before it is removed; delivery is never sped up to make room. Each block whose
timing was reduced or removed is recorded as a performance change (P1, P2…).
Only the user lets a performance run past the maximum: the option on the
generate, revise and refine panels (`allowPerformanceOverMax`), off by
default. The runtime range is authoritative: the midpoint is a planning aid,
and a script anywhere inside the range is valid.

**Measured and judged.** The quality report keeps three things apart:
*checks* — the deterministic rules (the gate); *measurements* — computed from
the structured script, never estimated by a model: spoken words, the runtime
with and without performance timing, pauses, claims cited, words by
information class, assertions without the claim behind them, repeated
material, passenger candidates, lines about the film, reviewer changes kept /
rejected / skipped; and *judgments* — the script editor's verdict and scores,
its refinement checklist, the fact checker's verdict: opinions, recorded,
never presented as measurements and never failing the gate. The dashboard
labels them that way, and scores in the comparison are marked as model
judgments.

**Limits (stated honestly).** The rules see words, not meaning: a fictional
act phrased without one of the listed verbs, interiority without a listed
mental verb, or a hedge that is technically present but misleading will pass
them — the reviewers and the editor are the check. Pronunciations come from
the model and are never trusted until a person confirms them; confirming them
in the dashboard is not built yet (the voice plan lists them as pending).
Timing is an estimate from word counts, not a measurement of a voice; once
real narration exists, the audio timeline (§16) is authoritative. The
quality rules are heuristics over words and structure: a retelling in other
words, a passenger with a person in it, or meta-narration in a phrase they do
not list will pass them, and a deliberate echo they do not recognise can be
reported as a retelling — they point; the reviewers and the editor judge.
The fiction-act and interaction checks need the character's name next to the
verb ("Mira hands…"), so an appositive between them ("Mira, a dock worker,
hands…") passes them; assertion linking matches word stems, so a synonym
("purchased" for "bought") passes it; a recall callback needs words such as
"the same… that once… now"; a passenger is judged by its words, beats and
claims, not by what it means — the fact checker and the editor remain the
judges of meaning.

## 16. Voice Engine V1 (ElevenLabs v4)

Narration is the first temporal production layer: everything downstream is
timed against the audio it produces, not against a words-per-minute
estimate. A script is never sent to a voice as one request, nor a section as
one request: it is narrated in small chunks of natural speech, each
generated, stored, checked and reviewed on its own.

```
approved script version → sections → blocks → chunks (≈ 8–12 s of natural speech)
  → takes (generations): spoken forms → performance directions → provider markup → checks → TTS
  → stored audio + character timestamps → word timings → per-take QA → human review
  → assembly on the measured clock (+ scripted pauses) → narration timeline → VOICE gate
```

Module `modules/voice`; provider code in `packages/providers` (ElevenLabs,
S3 storage, MP3/WAV tools). Pages: the dashboard's Voice page and the Voice
profiles library (*Saved voice profiles*, below). Production uses Eleven v4
(`eleven_v4`) with the audio in a Railway bucket (DEPLOYMENT.md, *Enabling
real narration*).

### Chunks

`planChunks` cuts each section's sentences (exact character offsets; never
inside a sentence, never across a section, a change of speaker or blocks that
are not adjacent) by dynamic programming over every possible cut, so it is
deterministic and explained: each chunk records why it ends — section end,
change of speaker, change of information class (`PURPOSE`), scripted pause,
change of delivery, paragraph or sentence.

- **Size, in spoken words** (a figure counts as it is read: "1637" is two
  words). House default 20–30 words: `wordsForSeconds(8)`–`wordsForSeconds(12)`,
  about 8–12 s at the engine's 150 words a minute (`CHUNK_SECONDS.target`).
  A chunk may run from about 5 s to about 20 s (`CHUNK_SECONDS.natural`) when
  that keeps a thought whole: words under the minimum or over the maximum
  cost more the further out they are, and a fixed cost per chunk keeps a
  passage from shattering into tiny clips because the delivery shifts
  slightly. Ceiling: a chunk of several sentences never runs past 1.5 × the
  maximum, and never past about 20 s (50 spoken words) unless the maximum
  itself is larger — 45 words at the default, 50 for 30–50; a single
  sentence is never split, whatever its length. Natural boundaries come
  before duration.
- **Pauses that hold, pauses that cut.** A scripted pause whose reason is
  REVEAL, IMPACT, QUESTION or NUMBER holds the thought open (what follows
  completes it): it is not a cut, and cutting there costs as much as
  splitting a setup from its payoff. A TRANSITION, EMOTIONAL_TURN or RHYTHM
  pause, or one with no reason, is a preferred cut (long ≫ medium ≫ short).
  Each pause inside a chunk is recorded with its reason.
- **Information class.** A change of class between blocks is a cut: into or
  out of FICTION is a strong one (boundary `PURPOSE`, made even at the cost of
  short chunks); any other change of class only tips a close call.
- **Delivery.** A change in the script's delivery is a preferred cut — major
  (two steps in pace, energy or emotion, or one step in all three) far more
  than minor.
- **Kept together:** a question and its answer, a setup ("…", "—", ":") and
  its payoff, a very short sentence (usually a payoff) and the sentence
  before it, a sentence that continues the last ("And…", "But…",
  "Which…"); a cut inside a block costs more than one at its end.

A plan shows each chunk's estimated seconds (spoken words at the narration
rate and the chunk's pace, plus the pauses inside it) and flags chunks
outside 5–20 s; a take's measured duration replaces the estimate. Each chunk
keeps its spans (block, character range), canonical text, its SHA-256, and
each source block's whole-text hash, so the block → chunk(s) relation is
stored with every run.

### Spoken forms, performance, markup, checks

1. **Spoken forms** (`toSpoken`): years ("1637" → "sixteen thirty-seven"),
   decades, ranges (a season "1636/37" → "sixteen thirty-six to sixteen
   thirty-seven"), dates, ordinals, percentages, decimals, fractions ("1/3"
   → "one third", "2 1/2" → "two and a half": a slash is never sent for
   one), "c. 1610", amounts with currency signs ("ƒ5,500" → "five thousand
   five hundred guilders") and numbers, in UK or US style; approved
   pronunciation aliases are spoken in place of their terms. Every
   replacement is recorded against the canonical range; a guess (a
   four-digit number nothing marks as a year, a season, a bare fraction that
   could be a date) is MEDIUM confidence and flagged for a listen. Values
   are never changed and no currency is converted.
2. **Performance** (`performanceMarks`): provider-neutral intents (emotion,
   delivery, intensity, pacing, vocal action — open words, not a closed
   list) translated from the script's own delivery marks and pause reasons.
   Nothing is invented and the script is never changed. Strategies:
   - **PLAIN**: no directions.
   - **RESTRAINED** (the house default): a direction only where the script's
     delivery changes — at the start of a chunk whose first block is marked,
     or where a later block's delivery differs; at most two per chunk, six
     words or more apart; low intensity, one emotion and at most one
     delivery word; a short reset to the plain register (`matter-of-fact`)
     when a marked passage is followed by plain narration in the same chunk,
     because a direction carries forward; no vocal action unless the
     director asks for one. Narration the script marks as plain gets no
     direction: v4-class models infer delivery from good writing.
   - **EXPRESSIVE**: the house style plus at most one deliberate moment per
     chunk, only where the script turns — the sentence after a REVEAL,
     IMPACT or EMOTIONAL_TURN pause (in that order; also a chunk's first
     sentence when the chunk starts after one), else the first sentence of a
     block the script marks with a delivery. The moment is one bracket of at
     most two cues from the script (the feeling, then energy, then pace:
     `[curious, quiet]`, `[quiet, deliberate]`); where the script marks the
     turn but no delivery, the manner alone (`deliberate` after a reveal or
     an impact, `quiet` after an emotional turn). It is six words or more
     from the house directions, recorded with source STRATEGY, and colours
     its block: the next block goes back to the direction the house style
     has in force there. No moment is added where it would say what the
     house style already says.
   - **DIRECTED**: a direction on every sentence, high intensity, a vocal
     action at the start of a somber or reflective block, every sentence
     break a pause — the over-directed reference, kept to hear what to
     avoid, never a default.

   **The director overlay.** A director's directions for one chunk (by
   sentence number: `2: curious`, `3: quiet, deliberate`) are laid over the
   strategy's, never instead of them: the director's wins on its sentence,
   the strategy's other directions stay, and the next sentence goes back to
   the strategy's direction in force there (or to the plain register). Every
   mark keeps its source (SCRIPT, STRATEGY, DIRECTOR) and its reason.

   **Emphasis and intensity are reported, never silently dropped.** The
   script's stressed words, and any intensity above low, cannot be given to
   a tag model without changing the words (v4 stresses with capitals or a
   delivery tag), so each is listed per sentence as not expressed and the
   words are sent as written.
3. **Markup** (`VoiceProvider.render`, pure): **tag models** (Eleven v4, v4
   turbo, v3) get one bracket of plain words before the sentence
   (`[curious]`, `[quiet, deliberate]`; a vocal action is its own bracket),
   `[pause]` for a medium pause, `[long pause]` for a long one and a line
   break for a short one — **no SSML**: `<break>` is never written for them,
   and the ElevenLabs provider refuses to send a text that contains one.
   **SSML models** (Multilingual v2, Flash v2/v2.5) get `<break time="…"/>`
   (≤ 3 s) and no tags; a model the provider does not know gets line breaks
   only. Provider settings are sent only where the model takes them
   (`sentSettings`; v4: stability and similarity, no speed or style). What
   a model cannot express is reported, not sent.
4. **Checks** (`checkTake`, before anything is sent; a FAIL means not sent):
   the spoken text is the canonical text plus recorded forms only; the sent
   text has exactly the spoken words in order; every sentence is verbatim;
   directions only before a sentence and pauses only between sentences;
   never inside a quotation; directions are a few lower-case words (no
   dialogue, numbers or names); only markup the model takes (an SSML break
   for a tag model fails); density within the strategy (the house limits on
   what is translated from the script, plus one moment for EXPRESSIVE; the
   director's own directions only warn when there is more than one in ten
   words); a warning when the strategy adds an emotion to narration the
   script marks as plain. Warnings when they apply: a heightened direction
   in force on an UNCERTAIN, RECONSTRUCTION or FICTION sentence; a forward
   slash in the text sent to a tag model (v4 reads text between slashes as
   inline IPA); what the model cannot express.

The canonical text, the spoken text and the performance text (exactly what
was sent, marked derived, with its SHA-256 in `performance_text_hash`) are
all stored with the take, with the spoken forms, marks, pauses, context,
settings (every provider setting with the chunk's pace applied, and what the
model was sent of them), seed, dictionary rules and checks.

### Takes, context, alignment, statuses

The VOICE job generates a run's pending takes (`VOICE_CONCURRENCY` at a
time, two by default; one at a time when stitching), each through
`ctx.callProvider` (ledger row linked to the take). Context: the
neighbouring chunks' last/first whole sentences of the same section within
the run's character limits (200 before and 120 after by default), sent in
their spoken form as `previous_text` / `next_text` — heard by the model,
never generated — or, when stitching is chosen and the model supports it,
the previous chunk's request id (taken within two hours, same model). The
seed is derived from the text hash and the take number: a take is
reproducible, a regeneration differs. Audio goes to the `StorageProvider`
under a new key per take (a `media_assets` row per file); duration is
measured from the file (MP3 frames, WAV samples).

`alignTake` maps the provider's character timestamps back through the
markup and the spoken forms to the canonical words ("1637" gets the time of
"sixteen thirty-seven"). It is right whether or not the provider's
alignment contains the characters of the audio tags: markup is blanked on
both sides before matching — the pieces that were sent, and any bracketed
or angle-bracketed span the spoken text does not contain — so the letters
of a tag are never matched to a word. Words it cannot find are counted,
never invented; a take without timestamps has no alignment.

`takeQa`: no audio, no timestamps (blocking: the timeline needs them),
unmatched words (blocking over 10%), a speaking rate (spoken words) outside
70–260 words a minute (blocking) or 100–200 (warning), silence over 1.2 s
before the first word, 1.5 s after the last, 2.5 s between words, spoken
forms to hear, performance-check warnings, MOCK audio.

**Statuses.** A take goes PENDING → GENERATING → **IN_REVIEW** (its audio
stored and made its chunk's current take, awaiting a human decision) →
APPROVED or REJECTED; a newer current take SUPERSEDES it; FAILED when it was
not sent (a failed check, the job's character ceiling), failed at the
provider, or could not be kept. **GENERATED** is stored audio that is not
current: an A/B variant (below). A current take stored as GENERATED before
IN_REVIEW existed reads as IN_REVIEW. Nothing is approved automatically:
approving needs the chunk's current take and no blocking finding on it
(MOCK audio aside); *approve all* approves the current takes that have no
blocking finding and leaves the rest. Restoring an earlier take makes it
current again — APPROVED if it was ever approved, else IN_REVIEW — and
supersedes the one before. Takes are never deleted or overwritten.

### Integrity

- **Approved script only.** A voice job refuses (not retried) a run whose
  script version is no longer the approved one, and such a run cannot be
  regenerated: a new run is made for the new script. With the real voice
  stage, the generic job route refuses a VOICE job ("Use POST
  /api/projects/:id/voice/runs"): narration always starts from a planned,
  priced run.
- **Paid audio is bought once.** The ledger row and the provider's request
  id are linked to the take as soon as the audio comes back. Storing it is
  retried inside the job (three attempts, 1 s × the attempt apart) on a
  transient error. A store that still fails makes the take FAILED ("Storage
  failed: …") with a blocking `STORAGE_FAILED` finding and its ledger row
  kept; storage that refuses outright (e.g. HTTP 403) stops the job before
  more audio is bought that could not be kept. Any other fault after the
  audio came back closes the take as FAILED ("Not kept after the audio came
  back (paid for; …)") and stops the job, so no retry of the job buys it
  again.
- **Interrupted takes.** A take left GENERATING by an attempt that did not
  finish (a shutdown, a crash) may have reached the provider and been
  billed, so it is never sent again on the same row: the next attempt closes
  it as FAILED ("Interrupted mid-request … see the ledger") and generates
  the chunk's next generation, with the same strategy, directions, note and
  variant, in its place. On a shutdown, untried takes stay PENDING and the
  job returns to the queue.
- **Errors.** A take the provider refuses fails alone and the run goes on.
  An HTTP status no other take would get past (401 rejected key, 402 no
  credits, 403 no access, 404 unknown voice or model) — read from the
  status, never from the wording — stops the job, leaving untried takes
  pending for a retry. Once a job has sent `VOICE_MAX_CHARACTERS`, its
  remaining takes are marked FAILED unsent. A job in which every take
  failed fails.
- **The assembly is rebuilt in a `finally`.** Whatever happened, each run's
  assembly is rebuilt from its current takes (those made before a stop are
  kept) and the run is logged.
- **`ASSEMBLY_MISMATCH`.** Live run QA compares the latest assembly's
  entries with the chunks' current usable takes: a chunk heard with another
  take, or a usable take left out (or no assembly at all), is blocking.
  Building the joined audio file records a warning of the same kind when a
  clip starts more than 50 ms from where the timeline puts it.
- Real (non-mock) narration is refused while storage is in memory.

### Assembly, timeline, gate

`assemble` puts the current takes in chunk order on their measured
durations; the silence between two takes is what the script asks for there
(a breath between sentences, a paragraph, a scripted pause, a section
change) minus the silence already at the end of one clip and the start of
the next, never below zero. Duplicate chunks (also two chunks narrating the
same words of a block), missing chunks and a take used twice are blocking.
A new assembly version is made whenever a run's current takes have
changed (checked at the end of every voice job and when a take is
restored); the version before is superseded and stays playable. An
assembly is DRAFT until every chunk of the run has a take to hear, then
IN_REVIEW; `complete` says whether it narrates the whole script, which only
the gate needs. The joined audio file
is built on first request (MP3 frames with silent frames for the pauses,
each gap rounded against the running clock so no clip drifts more than half
a frame; or WAV samples) and stored.

**The contract for later stages.** Once real narration exists, the audio
timeline — not the script's estimated runtime — is the authoritative
narrative clock: the storyboard and every later stage are timed against it.
`GET /api/projects/:id/voice/timeline?run=N` returns the latest assembly of
run N: run, script version, assembly version and status, `complete`, total
duration, its entries (chunk, take, the take's audio asset, section,
blocks, start, end, gap after) and, for each part of a script block:
section, block, chunk, take and audio asset, start and end on the assembled
clock, the words with their times, the script's performance (pace, energy,
emotion), the visual hints (intent, priority, must show, fictional) and
whether its take is approved — read when asked, so a decision made after
assembly counts. `GET …/voice/moment?run=N&at=02:43` answers "what is being
said at this exact moment?": section, block, chunk, take, the word, the
text, whether the moment falls in a pause, and that part of the timeline in
full.

Run QA (live): failed, rejected or unreviewed current takes (IN_REVIEW is
unreviewed); missing audio; a take of other text than its chunk; the run's
script no longer the approved one ("Audio generated from Script v4 —
current script is v5"); a source block changed (by its hash); blocks of the
script without narration; unresolved pronunciations; `ASSEMBLY_MISMATCH`.
The **VOICE gate** approves only the latest assembly of a full run of the
approved script with every current take approved and nothing blocking;
earlier approved narrations are kept, superseded. An audition is never the
narration.

### Regeneration, A/B, experiments

Every cost-bearing request is one VOICE job (one per project at a time);
its characters are counted and priced before it is queued, and the
dashboard shows them wherever a confirmation is asked.

- **Regenerate** (`POST /api/voice/runs/:id/regenerate`): one chunk, the
  chunks selected, a section, chosen blocks, or every chunk — one new take
  per chunk, made current when it is ready; no other chunk changes and the
  assembly is rebuilt. Made with the run's own configuration (the
  default), the project's production profile as it is now, or either with a
  temporary override (*Saved voice profiles*, below); optionally a note kept
  with each take and, for exactly one chunk, a director's directions. The
  characters are counted as the stage will prepare them (spoken forms,
  aliases, markup); every chunk, or more than `VOICE_CONFIRM_CHARACTERS`,
  must be confirmed.
- **A/B** of chosen chunks: two or three variants (each its strategy and,
  for a single chunk, its directions; the request's override applies to
  every variant), one take per variant per chunk, kept
  beside the current take as GENERATED and never made current by itself;
  the editor compares and picks one with *Use this take*. Always confirmed.
- **Use a previous take**: any earlier take of the same text with audio can
  be made current again (above).
- **Experiments** (`POST /api/projects/:id/voice/experiments`): the same
  passage (never the whole script) narrated 2–8 ways in one job, each
  variant setting its own run options over the profile's (strategy,
  context, chunk size, number style, performance rules, the provider
  settings it lets be overridden) or narrating with another saved profile
  version (`profileId`, heard as saved), each its own run with its own
  assembly so it can be heard whole. Always confirmed, whatever the size; the total is held to
  `VOICE_MAX_CHARACTERS`. The Generate tab offers three: direction (A plain
  / B restrained / C expressive, and optionally D over-directed),
  continuity (no context / neighbouring text), chunk size (≈ 5–8 /
  8–12 / 12–20 s) and a comparison of 2–4 saved profiles.
- **The acceptance experiment** (`VOICE_ACCEPTANCE_EXPERIMENT`, its own
  panel on the Generate tab): the opening audition (whole blocks from the
  start until about 100 s of planned narration) narrated seven ways in one
  job behind one confirmation. Every variant spells out all three settings,
  so it does not depend on the profile; B is the house default the others
  are heard against. It narrates with the profile chosen on the Generate tab
  (the production profile unless another is chosen), so a new voice can be
  auditioned with the same seven variants and the winner saved from its
  variant card as a profile.

  | Variant | Strategy | Context | Chunk size | What it is there to hear |
  |---|---|---|---|---|
  | A plain | PLAIN | neighbouring text | 20–30 words | The voice with no direction |
  | B restrained | RESTRAINED | neighbouring text | 20–30 words | Whether the house style sounds like a documentary narrator |
  | C expressive | EXPRESSIVE | neighbouring text | 20–30 words | Whether the deliberate moments land, or over-act |
  | D over-directed | DIRECTED | neighbouring text | 20–30 words | What over-direction sounds like (the reference to avoid) |
  | E no context | RESTRAINED | none | 20–30 words | Whether neighbouring text helps continuity (B without it) |
  | F 5–8 s chunks | RESTRAINED | neighbouring text | 13–20 words | Whether smaller chunks are more natural, or choppy |
  | G 12–20 s chunks | RESTRAINED | neighbouring text | 30–50 words | Whether larger chunks stay natural, or flatten |

  Neighbouring text is 200 characters before and 120 after.

Plans are pinned to their profile version and to the project's selection
revision: the dashboard plans every variant on the version of the first
plan (or the variant's own) and generates on it with the revision it was
planned at. A profile version saved in the meantime (in another tab) cannot
change what was confirmed; a change of the project's profile choice or
overrides refuses it (409, "plan again"). A plan or a confirmation is
dropped as soon as the request it was made for changes.

### Saved voice profiles

A voice profile is everything that shapes a take beyond the script:
provider, voice, model, language, output format, performance strategy,
chunking, context, number style, the profile's own pronunciation rules,
performance rules and the provider's own settings. Profiles are a library
(`/voice-profiles` in the dashboard, global, not a project's); a project
chooses one, and may set some of its settings over it for itself.

**Families and versions.** A saved profile is a family
(`voice_profile_families`: stable id, display name, description, archived,
library default) with immutable versions (`voice_profiles`). An edit is
always a new version (the family's highest number plus one), based on the
current version or on any earlier one ("Edit from this version" is how to
go back); an edit that changes nothing is refused, and so is one made
against a version that is no longer current (`expectedCurrent`: "changed
since you opened it"; the dashboard keeps the edit, names the version saved
since, and saves over it only on purpose, "Save vN anyway"). The **current
version is the newest**; versions are not archived. Renaming or describing
a family makes no version: each version keeps the name it was made with. Provider and language are fixed per family: a voice for
another language is a duplicate (a new family with v1 from any version).
Each version records how it was made (`origin`: DEFAULTS, LIBRARY, EDIT,
DUPLICATE, or RUN with the run, project, experiment, variant and take;
LEGACY for versions from before), and the history shows what changed from
the version before it ("performance: restrained → expressive"). Names are
1–80 characters and unique among families ignoring case (a name still
carried by another family's versions is refused too). Every version is
checked: the configured provider, a voice id, an output format the engine
can measure and join (`mp3_*`, `wav_*`, `pcm_*`), provider settings the
provider accepts, and chunking, context, rules and pronunciation that parse.
Archiving a family hides it from choice lists and refuses new versions and
new selections of it; projects already using it keep it (with a notice);
the library default cannot be archived. Unarchiving restores it.

**Provider settings.** The profile schema is provider-neutral, plus one
open record, `providerSettings`, that only the provider understands. The
provider **describes** it (`VoiceProvider.settings`: per key a label, help,
kind NUMBER, BOOLEAN or CHOICE, default, range or choices, the models it is
sent to — `models`, or every model but those in `except` — whether a
project, a run or a take may override it, and `role: 'SPEED'` for the base
speaking rate), **checks and normalises** it (`normalizeSettings`: every
described key present with its default; unknown keys, wrong kinds and
out-of-range values are listed as problems, never clamped) and says **what
a model is sent** (`sentSettings`: a key is sent when `models ?
models.includes(model) : !except.includes(model)`, so a model the provider
does not know gets the keys sent to every model). ElevenLabs describes
stability (every model), similarity (every model but `eleven_v3`), style,
speaker boost and speed (Multilingual v2 and Flash; speed is the SPEED
role): Eleven v4 is sent stability and similarity only, as before. The mock
describes the same five for every model. The engine names no key: a
chunk's pace scales the SPEED-role setting where the model takes it, and
the dashboard builds its forms from the descriptors.

**Performance rules** are the house style's limits and words as a profile
sets them: directions per chunk, words between directions, the director's
words per direction before a warning, the word for each scripted feeling,
the four delivery words (also the manners of a turn), the reset word and
the pace speeds. A reset word that is also a delivery word is refused
(`performanceRulesProblems`: its directions would read as resets, exempt
from the spacing), for a version and for the rules a project's overrides,
a run's options or a take's override make with it. A new profile starts
from `DEFAULT_PERFORMANCE_RULES`.
`EARLIER_PERFORMANCE_RULES` (frozen, never edited) is what the engine
applied before saved profiles: versions in the earlier shape and runs made
before them are read with it, so tuning the default can never change what
an old run reads as. EXPRESSIVE's one moment of at most two cues is the
strategy's definition, not a rule. **Pronunciation**: a profile's own rules
(term, alias / IPA / CMU) cover the terms the project has not approved; the
project's approved list always applies and wins for a term it has decided.

**A project chooses per language version** (`voice_selections`, one row
per language version): a family, following its current version or pinned
to one, or the library default (no row, or no family); the project's
overrides; a revision. A run belongs to one language version, and so do
takes, assets and the timeline; a profile version has one language and one
voice, so a Spanish edition needs its own choice. The Voice page works on
the master language. **Resolution** (`resolveProduction`): FOLLOW gives the
family's current version, PIN the pinned one, DEFAULT the current version of
the unarchived library-default family for the configured provider and the
language (the most recently updated when several match). Problems that
stop a new run (another provider, another language, no voice id) and
notices (an archived profile, a newer version while pinned, no default yet)
are reported, not thrown. A read never writes. At plan or run time a
missing default is created from the configured defaults ("House narrator",
origin DEFAULTS: ELEVENLABS_VOICE_ID; ELEVENLABS_MODEL_ID, `eleven_v4`, with
no automatic fallback; ELEVENLABS_OUTPUT_FORMAT; the house default and the
provider's setting defaults), after any version written
without a family (by code from before this change, say after a rollback) has
been adopted into a family by the migration's rule. There is at most one
library default per provider and language: making a family the default
takes the flag from the other.

**Layers and provenance.** The effective configuration of a run is the
version, then the project's overrides (PROJECT), then the run's options
(RUN); a take may add a temporary override (TAKE). Strategy, chunking,
context and number style are replaced whole; performance rules and provider
settings are merged key by key. Provider settings may be overridden only
where the provider marks them overridable, and a take cannot change the
chunking (its chunk is the run's). Every path a layer sets is recorded with
its source, even at the profile's own value, so an override in force is
always visible. Overrides are checked when they are stored or used (a
problem is a 409); a read never throws. The PROJECT layer applies only to
versions of the **production family** — production's own version, or an
older version of that family a plan pinned before the profile was edited.
Another saved profile named for a run or a comparison variant is heard as
saved (mode EXPLICIT): an audition of a profile sounds like that profile.

**Snapshots: what was made is kept.** Every run stores what it was made
with (`voice_runs.config`: the version as `{family, version, name}`, how it
was chosen and at which selection revision, the project's overrides, the
run's options, the effective configuration, provenance, and the provider
settings as the model is sent them and those it does not take), and every
take stores its own (`voice_generations.config`: its base, any override,
the version, the effective configuration, provenance, and how it differs
from the run's). Both are written when the row is created and never after;
`voice_profiles` rows are never updated, and families only in name,
description, archived flag and default flag. A snapshot is **used
verbatim**: a take made with the run's configuration lays its override over
the stored effective configuration as it is, never re-read from the version
or re-normalised by today's descriptors. Only what the provider sends of
the settings follows its model table at the time (that follows the
vendor's API, not the profile). `voice_runs.strategy` and `settings` are
still written with the effective values, for code from before.
**Reconstruction.** Runs and takes made before saved profiles (no `config`)
are read back rebuilt and marked `reconstructed`: the run's version (voice,
model, output format, number style, provider settings), its strategy, its
chunking and context from `settings`, no profile pronunciation rules and
`EARLIER_PERFORMANCE_RULES` — exactly what the engine then did; `runOptions`
are where the run differs from its version. An old take is its run's with
its own strategy (an A/B variant), differing at most in that.

**Regeneration choices.** New takes are made with (a) the run's own
configuration (the default: its snapshot, stored or reconstructed), (b) the
**production profile** as it resolves now (its version with the project's
overrides), or either with (c) a **temporary override** of strategy,
context, number style, performance rules or overridable provider settings.
A PRODUCTION take is refused when production has a problem, when its output
format or language is not the run's (clips of one run share a format), or
when the project's selection changed since the request was made; another
voice or model is allowed, labelled, and gets a QA warning. A take's
chunking is always its run's: the chunk was cut by the run. Each take stores
its configuration and how it differs from the run's ("stability: 0.3 (run:
0.5)"), worked out once when it is made; live run QA adds the warning
`CONFIGURATION_DIFFERS` where a chunk's current take differs from its run in
voice identity (provider, voice, model, output format, provider settings,
number style, pronunciation rules). It reads only stored JSON, so the VOICE
gate (which has no providers) is unchanged, and a warning does not block.
Strategy, context and rule differences are labelled, not findings: they are
per-take performance choices (A/B, a director). An override is kept with its
take only; nothing reaches a profile unless it is saved.

**Save as a profile.** "Save this run's configuration as a voice profile"
(`POST /api/voice/runs/:id/save-profile`) saves the run's effective
configuration, or one take's (`generationId`, a temporary override that was
liked), as a new profile (`name`) or a new version of one (`familyId`, same
language). Its origin names the run, project, experiment, variant and take,
and whether the run was reconstructed; the notes default to "Saved from voice
run 3 of tulip-mania (Acceptance experiment — C expressive)". It never
becomes the library default. With `use`, the run's own language version
narrates with it from then on (FOLLOW) and **the project's overrides are
cleared**: where they applied to the run they are already in what was saved,
and a kept override (say a strategy) would make production differ from what
was heard. The cleared overrides are returned, written into the project
event and shown. Project events: `VOICE_PROFILE_CREATED` (a profile saved
from a run) and `VOICE_PROFILE_SELECTED` (every change of a selection or its
overrides). Library operations are global, write no project event, and are
logged by the API (actor, family, version).

**No global winner.** `DEFAULT_VOICE_PROFILE_CONFIG` (RESTRAINED, 20–30
words, 200/120 characters of context without stitching, UK numbers) is only
the starting point of a new profile. The acceptance result — Eleven v4, the
chosen voice, EXPRESSIVE, neighbouring context, 20–30 words, run 3 of Tulip
Mania — is Tulip's choice, made in the product ("Save this run's
configuration as a voice profile", a name, "Use for this project"). No code
default and no migration writes it, and another documentary keeps the
library default until it chooses.

### Pronunciation, cost

The pronunciation review list starts from the script's pronunciation notes
(an editor-confirmed note with IPA is approved; the rest are to check) and
adds foreign spellings, names with particles and abbreviations found in the
narration. Approved aliases are spoken by the engine; approved IPA/CMU
phonemes go to a provider pronunciation dictionary (ElevenLabs: phoneme
rules, IPA written between slashes, CMU as Arpabet), one per rule set, found
again by its name (a hash of the rules) or created once; a profile's own
phoneme rules reach the provider the same way. The whole narration is
generated only once every term is decided; auditions may run with terms
still to check (that is how they are heard).

Term detection keeps a sentence's ordinary first word out of a name: a run
of capitalised words that opens a sentence loses its first word when a
capitalised name follows ("Meet Thijs, a Haarlem craftsman." gives Thijs
and Haarlem), unless something says the word belongs to the name — a
foreign spelling ("Thijs Gaergoedt"), a particle after it ("Jan van
Goyen"), or the same word capitalised inside a sentence elsewhere in the
text. A detected entry nobody has decided or edited, which the detector no
longer finds while it finds a term the entry ends with, is **withdrawn**
("Meet Thijs", replaced by Thijs): it no longer blocks narration, the
Pronunciation tab lists it apart, and no row is rewritten or deleted; the
next plan adds the term that replaced it, to decide.

Cost: every request is a ledger row. ElevenLabs returns no dollars, so cost
is an ESTIMATE whose basis is the **characters sent** (spoken text and
markup: an upper bound), recorded as COUNTED, × ELEVENLABS_USD_PER_1K_CHARS
when it is set (one price for every model), else the documented list price
per model (v4: $0.08 per 1,000). What the provider reports about a call is
kept raw beside it, under its own name, and never priced: ElevenLabs'
`character-cost` header came back at about 0.11 of the characters sent in
the live acceptance run (run 3: 1,577 sent, 174 reported), and its unit
under v4 (characters, credits, a discount) is unverified. Views and logs
show both: "sent 1,577 characters; provider reported 174 (character-cost
header)". Ledger rows written before 2026-10-06 priced the reported figure
(REPORTED): voice views and logs re-estimate them from the characters sent
and say so (`reestimated`); the ledger itself is not rewritten. A model with
no price is UNPRICED; the mock is MOCK. A response that
arrived but could not be used (no audio, unreadable audio, invalid JSON)
keeps its usage, so a request that may have been billed is still costed. A
take's ledger row records:

- **request**: run (id and number), script id and version, section, block
  keys, chunk (id and number), take (id and generation), variant, model,
  voice id, characters sent, strategy, text hash, performance-text hash,
  the job attempt, the context sent (characters before and after, stitched
  or not), the profile (family and version) and the take's configuration
  (its base and any override);
- **response**: measured duration, MIME type, bytes, whether timestamps came
  back, the provider's request id, the pronunciation dictionary used, the
  HTTP attempts (retries included), how the characters were counted
  (COUNTED: the characters sent; REPORTED on rows before 2026-10-06) and
  the provider's reported figures (`reported`, raw);
- usage, cost basis and estimate, the provider's request id (`request-id`,
  else `x-trace-id`) and history item id (`history-item-id`) when returned.

Plans show characters and the estimate before generating. A run or a
regeneration above VOICE_CONFIRM_CHARACTERS (and the whole script) must be
confirmed, and so must every comparison, every A/B and a regeneration of
every chunk. VOICE_MAX_CHARACTERS caps one job: a plan over it is shown as
blocked, a run, comparison or regeneration over it is refused, and the
stage stops sending once a job reaches it.

### Connectivity checks and health

At startup, for providers that are not MOCK, the app checks once, in the
background, spending nothing: storage writes `healthchecks/probe-<uuid>.txt`,
checks that it is there, reads it back, compares it and deletes it
(`probeStorage`); the voice provider looks up the configured voice and the
model list (`VoiceProvider.check()`; for ElevenLabs `GET
/v1/voices/{voice_id}` and `GET /v1/models`, one attempt each). Each check has 15 s. The result is
logged once ("connectivity check passed", or a warning that a provider is
not reachable as configured), never with a secret, and cached. Startup is
never blocked and never fails on it.

`/api/health` reports `storage` and `voice` (`ok`, `error` or `mock`) with
`storageDetail` and `voiceDetail` (what was written, read back and deleted
and how long it took; whether the voice was found and the model listed — or
the step that failed and why). A check still running reads as `error`
("Startup check still running"). Voice is `ok` when the configured voice is
found and the model is not missing from the account's list. The HTTP status
stays tied to the database.

### Acceptance logging

Every VOICE job writes structured lines on its job logger, read back from
the database once its takes are committed, so an acceptance run can be
checked from the production logs alone and every figure is what is stored,
never what was meant:

- **`voice chunk`**, one per chunk of each run: run id and number, chunk
  number and id, section, block keys, boundary, spoken words, estimated
  seconds, characters sent, and the chunk's current take (else its newest):
  id, generation, status, current or not, variant, strategy, what it was
  made with (`configuration`: base, override, the profile version as
  "Tulip narrator v2", its source — run configuration, production profile
  or temporary override — and how it differs from the run), the exact
  performance text, measured duration, alignment (source, number of the
  provider's character timestamps, timed words, unmatched words), cost
  (ledger row id, status, basis, estimated and reported USD, characters
  sent, the provider's reported figures, whether it was re-estimated,
  REPORTED or COUNTED, HTTP attempts), the provider's request id, error.
- **`voice run summary`**, one per run: run id and number, kind,
  experiment and variant, script id and version, strategy, chunking,
  context, profile (family id and name now, version id, version, the
  version's own name), `configuration` (reconstructed or not, how the
  version was chosen and at which selection revision, the project's
  overrides, the run's options, provenance, and both in words: "performance
  expressive, stability 0.4"), `effective` (provider settings, what the
  model is sent of them and what it does not take, number style,
  performance rules, pronunciation rules), provider, model, voice id,
  language, output format; chunk count; takes by status; regenerations;
  this job's takes, characters and estimated USD; the characters sent by
  every ledgered request of the run, the provider's reported figures summed
  per name (`providerReported`: name, total, requests), `costText` ("sent
  1,577 characters; provider reported 174 (character-cost header)"),
  estimated and reported USD, whether any row was re-estimated, cost
  bases; the measured durations of the
  current takes (total, shortest, longest, mean, median) and how many have
  timestamps; the latest assembly (id, version, status, total duration,
  complete); QA findings by kind (blocking, warning); pronunciation terms
  unresolved and used; why the run stopped, if it did.
- **`voice regeneration summary`**, for a regeneration: per chunk
  regenerated, the previous current take (id, generation, duration) and
  the new takes (as in `voice chunk`, with their configuration, ledger row
  and alignment); the new takes by what they were made with
  (`configurations`: run, production, overridden) and the profile versions
  they used; the assembly before and after (id, version, total duration); the number
  of chunks regenerated, the other chunks, how many of those kept their
  current take, and `othersIntact` (true when they all did).
- **`voice experiment comparison`**, for an experiment: its name, the
  number of variants, and one row per variant (label, run, profile version,
  strategy, context, chunking, any other override, chunks, total measured
  duration, mean chunk duration, characters, estimated USD), also as text
  rows to read straight from the log ("C expressive | House narrator v1 |
  EXPRESSIVE | context previous 200 / next 120 chars | 20–30 words | …").

A failure to read the log back never fails a job whose takes are kept. The
job's result carries the same run lines.

### API

```
GET   /api/projects/:id/voice[?run=N]                 the Voice page's view
POST  /api/projects/:id/voice/plan                     plan (nothing is generated)
POST  /api/projects/:id/voice/runs · …/experiments     generate (202, one VOICE job)
GET   /api/projects/:id/voice/timeline?run=N · …/voice/moment?run=N&at=mm:ss
POST  /api/voice/runs/:id/regenerate · …/approve-all   (regenerate: configuration RUN | PRODUCTION, override)
POST  /api/voice/generations/:id/decision              APPROVE | REJECT | RESTORE
PATCH /api/voice/pronunciations/:id
GET   /api/voice/voices · /api/voice/audio/:id · /api/voice/assemblies/:id/audio (byte ranges)

GET   /api/voice/profiles[?archived=true]              the library, with the provider's settings and defaults
POST  /api/voice/profiles                              a new profile, v1 (201)
GET   /api/voice/profiles/:id                          a profile and every version
PATCH /api/voice/profiles/:id                          rename, describe, archive, unarchive, make library default
POST  /api/voice/profiles/:id/versions                 an edit: a new version (201)
POST  /api/voice/profiles/:id/duplicate                a new profile from any version (201)
POST  /api/voice/runs/:id/save-profile                 a run's or a take's configuration as a profile (201; with `use`, the cleared overrides)
GET   /api/projects/:id/voice/selection[?language=]    what a language version narrates with now
PUT   /api/projects/:id/voice/selection                choose, follow or pin, and the project's overrides
```

Invalid input is a 400; an unknown project, profile, version, run, take or
language a 404; a profile rule (name taken, archived, another provider, an
unknown or not overridable provider setting, an unmeasurable output format,
nothing changed, a pinned version that is not the chosen profile's) or a
stale revision (`expectedCurrent`, the selection's `revision`, a plan's
`selectionRevision`) a 409. The earlier `POST
/api/projects/:id/voice/profiles` is gone (404): profiles are a library with
versions, not a project's list.

### Limits (stated)

- No transcoding: MP3, WAV or raw PCM output only; clips of one run share a
  format. Encoder delay leaves a few tens of milliseconds between joined MP3
  clips.
- Directions are translated from the script's delivery marks and pause
  reasons; there is no model pass that proposes directions yet. A version
  without delivery marks or pause reasons narrates the same under PLAIN,
  RESTRAINED and EXPRESSIVE.
- The term list detects foreign spellings and particles, not every name an
  English voice may stress wrongly; the script's notes cover the rest.
- Request ids for stitching are only kept two hours by ElevenLabs; older
  takes fall back to text context.
- The live acceptance experiment (2026-10-06, seven runs, 78 takes) showed
  that v4's alignment includes the characters of the audio tags (the
  alignment works either way) and that the `character-cost` and
  `request-id` headers come back. Not yet verified: what `character-cost`
  counts (above), whether tags are billed (the characters sent include
  them), whether dictionary phonemes should be written between slashes (no
  dictionary was used), and emphasis (reported as not expressed until it is
  tested).
- The audio route reads the whole object before answering a byte range;
  two first plays of the same assembly at the same moment can store its
  joined file twice (one is kept in use).
- The unit of ElevenLabs' `character-cost` under v4 is unverified: it is
  recorded raw and never priced, and the estimate (from the characters
  sent) is an upper bound. The project-wide ledger total keeps the earlier,
  understated estimates of the seven acceptance runs; voice views and logs
  re-estimate them, and the ledger is not rewritten.
- A sentence-opening first name with no other evidence is dropped from the
  term ("Wouter Bartholomeusz sold…" alone gives Bartholomeusz).
- Profiles are created and chosen for the configured voice provider only.
  Profiles of another provider are kept and listed (not offered for choice)
  and are usable again when that provider is configured.
- A regeneration with the run's configuration re-uses its stored settings
  verbatim; what the provider sends of them follows its model table at the
  time (the vendor's API), not the profile.
- Code from before saved profiles, if rolled back to, reads versions in the
  new shape with the house voice settings; versions it writes have no family
  and are adopted when new code next plans.
- Voice names are not looked up on reads (`voiceName` is null; the dashboard
  maps names from `/api/voice/voices`).
- Cut for V1: archiving single versions (a revert is an edit from an older
  version), external provider pronunciation dictionaries (a profile's
  dictionary is its own rules), switching the project's approved list off
  per profile, per-profile moment counts (EXPRESSIVE's one moment of two
  cues is the strategy's), and the earlier per-project profile route.

## 17. Documentary Writing Engine 2

The script engine's writing becomes an editorial system. Research decides
what happened; the story architecture decides what matters; the corpus
teaches what excellent narration sounds like; the Human Narration Pass turns
information into natural prose; evidence QA protects the truth; the visual
layer shows what the narrator does not need to describe; the Voice Engine
turns the finished writing into performance.

```
RESEARCH → EVIDENCE / CLAIMS → STORY STRUCTURE → DRAFT NARRATION (writer / refiner)
  → DOCUMENTARY STYLE CORPUS (targeted retrieval) → HUMAN NARRATION PASS (narrate)
  → EDITORIAL QA (script editor → fact checker → rules) → DELIVERY MARKS (performance)
  → script vN → VOICE ENGINE (unchanged)
```

Four questions are kept apart: what is historically true (the research and
its verdicts — never the writing), what is useful to say (information
density, the rules' passenger and retelling checks), what sounds natural
aloud (the pass, the rhythm diagnostics) and what the audience can simply see
(the visual layer; narration describing the picture is a signal).

Library `modules/writing` (`@docengine/writing`: no model calls, no stage);
the stage step lives in `modules/script` (`narration.ts`, `editorial.ts`).

### The corpus

`modules/writing/corpus/`: `README.md`, `STYLE_BIBLE.md`, `RUBRIC.md`,
`examples/{positive,negative,borderline,house_style}/<category>.json`,
`annotations/PATTERNS.md`, `evaluations/`, `manifest.json`, `index.ts`.

- An example is a `WritingCorpusExample` (`packages/core/src/contracts/writing.ts`):
  id + version, text, category (hook, explanation, transition, character,
  economics, numbers, uncertainty, scene, dialogue_adjacent, payoff, ending,
  context, other), quality (excellent, good, borderline, bad), traits (a
  shared vocabulary that includes the AI-pattern ids), strengths, weaknesses,
  spoken rhythm, narrative function, why it works / fails, the house rewrite
  of a bad or borderline example, source (house, public domain, licensed,
  user-provided, generated comparison), copyright-safe, approved for
  retrieval. The schema refuses a retrievable example that is not
  copyright-safe, a model to follow without why it works, a bad one without
  why it fails.
- The seed corpus is original house writing across many subjects and eras —
  no transcripts of other documentaries, no subject of a project in
  production (a test keeps the files free of the regression case's terms).
- Files are JSON imported by `corpus/index.ts` (generated): the production
  image ships only the esbuild bundle, so the corpus is bundled, not read
  from disk. `STYLE_BIBLE.md`, `RUBRIC.md` and `PATTERNS.md` are generated
  from `bible.ts`, `rubric.ts` and `docs.ts` (`pnpm --filter
  @docengine/writing corpus:docs`); a test fails when a document and its
  source differ.
- Version: the manifest's semver plus a hash of the exact wording
  (`1.0.0+3f2a…`), plus `+h…` when approved house examples joined. A
  narration record keeps the version and every example id@version a prompt
  was given.

### Retrieval

`retrieve(examples, needs)` is deterministic and targeted. Needs come from
the blocks in front of the writer: the opening (hook, tension, restraint),
section openings (transition), the ending (payoff), a sum of money (money,
numbers, spoken clarity), a person met for the first time (character,
context, rhythm), uncertain history (uncertainty), and every pattern the
diagnostics flag (bad examples of that pattern, with the house rewrite;
borderline examples when the pattern is a judgment call). Limits: 8 models
to follow (2 per category), 5 habits to avoid, 3 judgment calls. Examples
reach the user message only — never a system prompt — under a heading that
says they carry no facts; the evidence rules reject any name or figure that
leaks from one.

### Diagnostics (warnings, telemetry)

- **AI-pattern fingerprint** (`fingerprints.ts`): 18 patterns. HARD ones are
  wrong wherever they appear (stock phrases, fake dramatic beats, hype
  adverbs, "Imagine…", trailer and generic mystery language, explained
  emotion, teasing block endings, narration describing the picture); DENSITY
  ones are fine once and warn only past a threshold for the whole script
  ("not X, but Y", a question answered by a fragment, runs of fragments,
  em-dashes, stacked figures of speech, rhetorical questions, repeated
  endings, same-length sentence runs, "The truth is…"). A 0–100 score weighs
  HARD three times DENSITY. A heuristic indicator, not a detector of authors.
- **Spoken rhythm** (`rhythm.ts`): sentence lengths and their spread,
  fragment share and runs, long sentences, clauses and punctuation per
  sentence, repeated openings, same-length runs, endings that repeat,
  tongue-twisters.
- **Read-aloud rubric** (`rubric.ts`): Humanity, Clarity, Spoken Rhythm,
  Historical Context, Narrative Restraint, Information Density, Narrative
  Progression, Visual/Narration Separation, AI-Fingerprint Risk,
  Pronunciation Friendliness — each 0–10 by code, with its reasons. Never a
  gate; the script editor's scores stay judgments.
- In the rules: `AI_PATTERN`, `VISUAL_IN_NARRATION`, `MONEY_WITHOUT_CONTEXT`
  (warnings, group "Sounds written by a person" / "Sums of money carry the
  context the evidence gives"); `DIRECTION_IN_NARRATION` is **blocking**: a
  bracket, tag, production label or claim key in the narration would be
  spoken, or taken by the voice as a performance tag.

### The Human Narration Pass

A checkpointed step `narrate` (task `script.narrate`) between the writer and
the script editor, in every mode by default (`SCRIPT_NARRATION_MODES`), and
a mode of its own, `NARRATION` (`POST /api/projects/:id/script/narrate`):
from a base version, no planner, no writer — the pass, then the script
editor (with the narration checklist), the fact checker, the performance
pass, the gate, a new version. The base is never changed.

- **What it sees**: the house style bible (system prompt, generic); per
  block, what the diagnostics found (only those blocks may change — every
  other block is *settled*); the lines to keep and the deliberate
  repetition; the money context the evidence supports; the names as the
  evidence spells them; the retrieved examples; the script, architecture and
  evidence; the director's instructions last.
- **What it returns**: edits to block texts only — with the reason, the
  fixes, the money context ids it used and the picture description it moved
  out (`visualNote`). Code keeps every block's claims, beats, class, speaker,
  visual direction and delivery; cited money context adds the claims it
  rests on; moved description is written into the block's visual note.
- **How each edit is judged** (`reviewPatch` with a guard, reviewer
  `NARRATION`, changes `N1…`): tried on a copy and kept only if it adds no
  blocking finding (the evidence invariants) and breaks none of the pass's
  own: every figure kept (digits and number words), new figures and money
  comparisons only from the cited money context, names spelled as before,
  every hedge kept, lines to keep and refrains kept, no new machine habit,
  no speaker's line touched, a polish not a rewrite (a block grows by a
  third at most, more only with money context). An edit to a settled block
  is skipped.
- **Idempotent**: a fixed block has no need left, so a second pass has
  nothing to do; a density judgment call (a deliberate contrast, a kept
  line) is not raised again on a block an earlier pass handled. Tested with
  a narrator that tries to edit every block: nothing changes.
- The script editor sees the pass's changes ("do not undo an accepted
  change"); the fact checker keeps the last word on facts; the performance
  pass marks the final text.

### Historical money context

`moneyContexts(evidence, claimSet)` reads the sums the cited claims state
(statements and verified quotations, and the dossier's price evidence) and
sets a price beside, in order of preference, a contemporary wage, an income,
a household expense, an asset — in the same currency, from the same era
(within 25 years when both are dated), never a total beside a wage. A wage
or income with a period gives a ratio a narrator can say ("about four
years' pay for a skilled craftsman"); anything else is given in the
evidence's own words. A modern estimate only when the evidence itself gives
one for that sum — always approximate, LOW confidence. Each context
(`HistoricalMoneyContext`) records the claims it rests on, takes the weaker
verdict (which decides its wording) and its confidence, and says its
method. No exchange rates, no conversions, no assumed working year: where
the evidence has nothing, the honest line is "The surviving records don't
give us a reliable equivalent." Sums said without the context the evidence
offers are a `MONEY_WITHOUT_CONTEXT` warning; sums with none are recorded as
gaps.

### Names

`nameLayer` gives every name four layers: the historical name (the
evidence's or the cast's spelling — never westernised), the display name
(what the narration writes; also subtitles, citations and on-screen text),
the spoken form (a respelling from a pronunciation note — never invented
here) and the note itself. A name is a pronunciation candidate when its
spelling is one English readers stumble over (or it has a particle) and no
confident note says how to say it; the voice engine's approved lexicon
stays the authority. A cast member's own lines count as uses of their name.
The narration pass may not respell a name.

### Semantic layers and delivery marks

A block keeps NARRATION (its text — the only thing spoken), VISUAL_DIRECTION
(`visual`), DELIVERY_DIRECTION (`delivery`), EVIDENCE (claims and their
presentation) and EDITORIAL_NOTE (the change ledger's reasons) apart; the
Editorial tab shows them side by side. Delivery marks — [curious], [quiet],
[measured], [urgent], [reflective] — are read from the delivery the
performance pass sets, sparingly; a writing problem is never fixed with a
direction.

### Lineage and the change report

A narration pass edits and never renumbers, so the version records its exact
lineage (each base block → its block in the new version, through the script
editor's and fact checker's renumbering). `changeReport(base, revised)`
(`modules/writing/src/report.ts`) pairs blocks by that lineage (or, between
any other two versions, by evidence and wording) and gives, block by block,
ORIGINAL → REVISED → WHY: the reviewers' reasons, evidence preserved,
uncertainty preserved, money context added, AI patterns removed or added,
visual duplication removed, pronunciation candidates — and the totals (blocks
changed and unchanged, sentences removed and rewritten, AI-pattern warnings
before and after). Claim coverage between the versions is flagged, never
silently lost. Served at `GET /api/projects/:id/script/versions/:v/editorial`
and in the comparison; the job's final log carries the totals and
representative examples.

### House-style evolution

`writing_examples` (migration `20261005130000_writing_engine_2`): an approved
script proposes candidates (signal-free narrator lines at the places where
the house style matters, one per wording) —
`POST …/script/versions/:v/house-candidates`; a person approves each with
why it works (it teaches the writer), rejects it, or later retires it —
`POST /api/writing/examples/:id/decision`. Only approved examples are
retrieved. A generated script never feeds the corpus on its own. The House
style page (`/writing`) shows the style bible, the rubric, the pattern
glossary, every example and the candidates.

### Boundaries

The Voice Engine is unchanged: it reads the same script shapes (every new
field is optional), speaks only `block.text`, and its tests are untouched.
No model call is made by the writing module; no live voice is generated.

## 18. Decisions

| # | Decision | Why | Alternative |
|---|---|---|---|
| D1 | Modular monolith, pnpm workspaces, TypeScript everywhere | One deploy, one language, shared types between API and UI | Separate services (rejected: premature) |
| D2 | Fastify 5 | Fast, typed, mature plugin ecosystem, good logging (pino) | Express (older, slower, weaker types) |
| D3 | Prisma 7 (pinned exactly to 7.10.0) | Readable schema doubles as documentation; first-class SQL migrations (`migrate deploy` as Railway pre-deploy); Prisma 7 has no Rust query engine, so Docker is simple | Drizzle (lighter, but schema is less readable for review). Note: the `prisma` npm `latest` tag currently points to an 8.0 **RC** — do not `pnpm add prisma` without a version. |
| D4 | Postgres as the V1 job queue | Zero extra infrastructure, transactional with state changes, scales to several workers | Redis/BullMQ now (unneeded) |
| D5 | Added `STORYBOARD_REVIEW` status | Storyboard approval must happen **before** paid visual generation; the brief's list only had VISUAL_REVIEW after generation | Approve after generation (wastes credits) |
| D6 | Added `RESEARCH_REVIEW` status | Research is a mandatory approval gate; RESEARCH_COMPLETE now means "approved" | Treat RESEARCH_COMPLETE as the review state |
| D7 | Order EDIT → RENDER → QA (status list order) | Final QA should inspect the rendered file; pre-render checks can be added to the EDIT stage | QA before RENDER (job list order in the brief) |
| D8 | Mock publish never sets PUBLISHED | "Do not fake successful external API calls" | — |
| D9 | Basic auth required in production | The dashboard can spend money once real providers exist | No auth (unsafe on a public Railway URL) |
| D10 | Script = language-neutral scenes; narration per language | Visual timeline, research and assets are reused across languages | One script copy per language |
| D11 | esbuild bundle of the API, npm deps external, build fails if an external import is unresolvable from `apps/api` | Fast startup, no TypeScript at runtime; the check prevents a class of "works locally, crashes on Railway" bugs (it caught one during development) | Running TypeScript with tsx in production |
| D12 | TypeScript 7.0 (native compiler) for type checking | Current stable major; used only for `tsc --noEmit`, runtime uses esbuild/Vite | TS 6.0 (fallback if a tool needs the JS compiler API) |
| D13 | Remotion for infographics, FFmpeg for assembly (planned) | Deterministic React-based graphics; FFmpeg is far faster for 10–15 min assembly and loudness normalisation. **Remotion requires a paid company licence for organisations above its free-use threshold — check before adopting.** | Remotion for the whole edit (slow to render long videos) |
| D14 | Tavily is the primary `ResearchProvider`; the stage depends only on the interface | Tavily returns full page text (`/extract`) as well as search results, which verbatim quote checking needs; Claude does all judgement | Claude server-side web search/fetch (planned alternative), Exa |
| D15 | Evidence = verbatim quote from retrieved full text, verified by code | A model can misquote; a quote that is not in the document is discarded, so every stored citation is checkable. Snippet-only evidence never reaches a claim | Trusting model-extracted facts |
| D16 | Deterministic verdict rules after the model's synthesis | The source hierarchy and "a myth needs counter-evidence" are policy, not model judgement; every change is recorded | Prompt-only rules |
| D17 | Quality-gate failure = non-retryable job failure, dossier kept as DRAFT, project FAILED | A failed gate needs a human decision (rewind, brief, thresholds), not a silent re-run that spends again | Automatic retries |
| D18 | Added source type `GENERAL_WEB`, distinct from `GENERAL_REFERENCE` | Encyclopedias and SEO pages are different evidence; the gate limits the general-web share | One "general" bucket |
| D19 | One model (`AI_MODEL`, default `claude-opus-5-5`) for every research task, with per-task effort (plan/synthesis/review high, triage/reading medium) | Reading decides which quotes exist at all; quality there matters most. A cheaper model for reading is a cost lever to evaluate with real runs | Haiku/Sonnet for reading |
| D20 | Anthropic server-side refusal fallback enabled (`fallbacks: "default"`) | A safety-classifier false positive on historical material would otherwise fail a read; the served model is recorded and priced | Fail the call |
| D21 | Costs from usage × configured prices, labelled ESTIMATED | Neither Anthropic nor Tavily returns dollars per call; inventing "actual" costs is not allowed | — |
| D22 | Open-access copy for unretrievable scholarly works, strict same-work matching | Without it JSTOR/publisher refusals push the dossier toward popular sources; a wrong "copy" would misattribute words, so matching is conservative and the reader is told to confirm | Use the abstract/snippet (not allowed for key claims) |
| D23 | Sources, retrieved texts and readings are shared across dossier versions | A retry or v2 re-fetches only failures and re-reads only new documents | Re-research from scratch each version |
| D24 | Retries resume from saved progress (`jobs.checkpoint`) | The first live run re-paid the plan, 48 searches and triage on each automatic retry after a deterministic failure; resuming makes a retry cost only the step that failed | Fewer automatic retries (still wastes the first repeat) |
| D25 | Schema-in-instructions fallback when structured outputs reject a schema as too complex | The compile limit is unpublished; a fallback with the same validation avoids guessing a schema shape that fits | Redesigning the synthesis schema blind; splitting synthesis into several calls (more input tokens) |
| D26 | Railway settings live on the service, not in `railway.json` | Railway deprecated Config as Code; new services cannot read it, and its GitHub import splits pnpm monorepos into per-package services | Railway IaC (`.railway/railway.ts`), applied with the Railway CLI — possible later |
| D27 | Story mining and architecture are two jobs with a human curation status (STORY_SELECTION) between them, and a human gate (STORY) after | The AI proposes; the editor decides what goes in before any architecture work is paid for, and approves the blueprint | One STORY job that picks the units itself |
| D28 | Historical status/confidence computed from the linked claims' verdicts; the critic scores appeal only | Trust must come from the evidence the research gate already judged, not from a model's impression; scoring appeal separately makes the ranking formula explicit | Model-assigned confidence |
| D29 | Evidence rules remove a candidate rather than letting it through with a warning; a top-up pass replaces removals | An invented person or figure must never reach the editor's shortlist; the removal reasons are shown and fed to the top-up prompt | Flag and keep |
| D30 | Candidate ↔ claim links are rows (`story_candidate_claims`); architecture sequences keep claim keys in JSON with sources derived and re-checked by the gate | FK links make candidate evidence impossible to dangle; sequences are a blueprint whose shape will change with the script stage, and the dossier version is fixed per architecture | A join table per sequence |
| D31 | A reviewer's corrected architecture is kept only if it has no more evidence problems than the draft | A revision can fix framing but can also introduce new unsupported material; the deterministic count decides | Always trust the revision |
| D32 | Architecture story evidence = the selected units' own claims; other dossier claims only as labelled background (`contextClaims` with a purpose), never adding a story, person, event, figure, date or beat | The editor's selection must define the film; background can explain but not extend it. Kept checkable: separate keys and sources, deterministic gate checks | Any approved-dossier claim as evidence (the first version) |
| D33 | Engine version per pack and architecture; v1 and v2 contracts as zod unions | Existing records stay readable without a data migration; new jobs always write version 2 | Rewriting engine-1 rows |
| D34 | Four information classes, checked per beat by code | "Creative freedom applies to presentation, not to historical truth" needs labels the code can verify, not prose guidance | Prompt-only rules |
| D35 | A PROBABLE claim needs a worded hedge (`HEDGE_PATTERN`), not only a label | Editor's decision: the wording must reflect PROBABLE status; a label alone lets "X happened" through | Treat PROBABLE as established |
| D36 | The reconstruction budget (40% / 25%) only warns | Editor's decision: how much reconstruction a film needs is an editorial judgement | Hard limit |
| D37 | One POV and up to two composites before a warning; fiction may observe real people, never interact with them or perform documented actions | Editor's decision; keeps fiction out of the record while allowing an immersive viewpoint | No composites |
| D38 | Two reviewers — story editor, then fact checker with the last word | Editor's decision (≈ $0.70 more per architecture); drama and truth are different jobs and the evidence must win | One reviewer |
| D39 | Story value and historical value scored and shown separately; appeal = story × (0.6 + 0.4 × history/10) | Narrative potential must be ranked separately from historical confidence; the floor keeps weakly evidenced stories visible | One blended score |
| D40 | Content opportunities only after the gate passes; rule-breakers removed, not failed | A failed draft is not worth packaging; opportunities are suggestions, the architecture is the deliverable | Fail the job |
| D41 | Opportunities name beat ids and store claim links (rows) | Short → beats → claims → sources stays traceable, and FK links cannot dangle | Free-text references |
| D42 | The content package endpoint is read-only and API-first | The production layer does not exist yet; fixing the request shape now lets production implement it later without UI work | Generate shorts now (out of scope) |
| D43 | Generic illustrations only in production prompts | Editor's decision: no topic facts may leak into other documentaries | Topic examples |
| D44 | Revisions reuse the STORY_ARCHITECTURE job and pipeline; the brief and checklist are its input | One code path for building and checking an architecture: the same rules, both reviewers and the gate apply to every version, so a revision cannot skip a check | A separate revision stage |
| D45 | A revision is always a new version linked to its base (`revision_of_id`, provenance); it supersedes only if it passes its gate | "Never silently overwrite the previous architecture"; a failed revision must not cost the editor the version they were reviewing | Edit in place, or supersede on start |
| D46 | Approving a version supersedes the earlier approved one (kept, event) | One approved architecture at a time keeps the content package and later stages unambiguous; nothing is deleted | Several approved versions |
| D47 | Revisions and angles may use units the editor approved but did not select ("reserve"); plain builds do not | Replacing a sequence needs somewhere to go inside the editor's own decisions; unapproved or rejected units stay out | Selection only (restructuring could only cut), or the whole pack |
| D48 | The architect's change log is shown next to a diff computed by code; unaddressed aspects warn, never fail | The model's account can overstate what changed; measuring it gives the editor a check, and a subtle change may still answer the brief | Trust the change log; fail on unaddressed aspects |
| D49 | Alternative angles are a side job with its own table (`story_explorations`), not a phase | Exploring must not move the project or invalidate the version under review; angles are treatments to compare, not architectures | A phase between selection and architecture |
| D50 | "Materially different" is a deterministic rule over mode, POV, opening, human anchor, question and structure | A model asked for three angles can return one film three times; a rule makes "different" checkable and the reasons visible | Trust the model |
| D51 | Opportunity decisions follow the latest architecture that passed its gate | A failed revision's draft must not lock the opportunities of the version still under review | The latest version, whatever its status |
| D52 | The script reuses the milestone-1 `scripts` / `scenes` / `scene_narrations` tables and adds `script_blocks` (+ claim links) | The language-neutral design (D10) already fits: a section is a scene, its words a narration; blocks give the structure (class, delivery, visual, evidence) as rows, so claim links cannot dangle | A JSON script blob |
| D53 | The SCRIPT gate blocks approval, not review | The editor must see and fix what failed (edit a block, rewrite a section); hiding a failed draft behind FAILED would cost a whole regeneration | FAILED on a blocking finding, as research does (D17) |
| D54 | A fifth information class, FRAMING, for connective narration | Transitions and questions are neither documented nor fiction; letting them carry no facts keeps the four classes honest | Force every line into one of the four |
| D55 | Section regeneration copies every other section unchanged into the new version, with no model calls | "Regenerate the relevant section, not the entire documentary": cheaper, and the editor's edits and decisions elsewhere survive | Regenerate the whole script with the section emphasised |
| D56 | Editor changes are in place on the version under review, with the generated text kept and every change logged | Making a version per keystroke would bury the real versions; the log and `generated_text` keep what changed and from what | A new version per edit |
| D57 | Reviewers return targeted patches (edit / remove / insert by block), kept only if they do not add blocking findings | Re-emitting a 2,000-word script to change three sentences costs tokens and risks silent drift; the rules decide whether a patch helped | Full rewrites by each reviewer |
| D58 | A provider-neutral voice adapter interface; ElevenLabs first, no audio | "Do not hard-code the Script Engine around one provider"; the plan can be inspected before any voice spend | Generate ElevenLabs markup in the script |
| D59 | Timing from words, pace and pauses (150 wpm) | Deterministic, explainable and good enough to steer; a real voice measurement replaces it at the voice stage | Per-voice calibration now |
| D60 | An open CRITICAL fact-checker issue blocks approval until its block is changed | The fact checker has the last word on facts; an issue its own patch could not fix must not slip through unread | Record it only |
| D61 | Model per step is configuration (`SCRIPT_MODELS`), never code | "Keep model configuration external"; a cheaper model for the performance pass is a decision to make with real runs | Hard-coded models |
| D62 | Narrative refinement is a mode of the SCRIPT job (no planner, the base's plan kept, its own prompt), not a new stage | It improves how the story is told, not what it is: keeping the plan and the architecture fixed, and running the same reviewers, rules and gate, means a refinement cannot skip a check or quietly restructure | A whole-script revision from a style brief (re-plans; may restructure) |
| D63 | The script editor answers a fixed 13-question checklist against the base, recorded with the version, never blocking | The brief's quality test, asked the same way every time, makes versions comparable; craft is a judgement for the human, the gate stays about evidence | A free-form verdict only |
| D64 | The wording checks accept natural uncertainty phrasing | "Don't make uncertainty sound like a database warning": the rules still require the signal in the same block, they just recognise how people say it | Formulaic hedges only |
| D66 | The refinement's house style is the system prompt's default; director's instructions rank last and steer style only | The intended behaviour must not depend on someone pasting a brief; a director still needs a way to steer tone, emphasis and pacing for one film — but never the evidence, which the rules enforce regardless | Behaviour from a pasted brief; no director control |
| D67 | The weaknesses one live run showed become generic, deterministic Script Quality Rules — not fixes to that film | A rule that measures a weakness improves every documentary and makes a refinement checkable against the version before it; tuning the prompts to one script would overfit it and hide the same weakness in the next | Refine Tulip Mania again with a more specific brief |
| D68 | Of the quality rules, only a named real person with no claim about them blocks | The evidence boundary forbids people the cited evidence does not name; redundancy, passengers, pacing and syntax are judgements — warnings that point, for the reviewers and the editor | Block on craft findings |
| D69 | Deliberate repetition is recognised and protected — refrains, callbacks, escalations — and a recap is not a callback | A redundancy rule that punished payoff lines would teach the writer to flatten them; an echo that re-says a shared claim, or a whole sentence, is a retelling | Treat all repetition alike |
| D70 | Over the maximum: a ranked cut plan with protected blocks, not a word target | "Quality beats arbitrary runtime": the cuts that cost the story nothing come first, and what carries the story is never offered | A hard word budget per section |
| D71 | Length is measured, never self-reported | The v2 refiner's change log claimed about 1,900 words for 2,319; the system measures and notes the difference | Trust the writer's account |
| D72 | Reviewer changes are judged one by one against the invariants, and every change is recorded with the version | In the v3 run the blocking findings some changes introduced (six for the script editor's patch, one for the fact checker's) cost all twelve of the script editor's changes and both of the fact checker's fixes — including the one that corrected a dramatised account told as "what probably happened"; a ledger makes the friction between the rules and the reviewers visible | Accept or reject a reviewer's patch as a whole |
| D73 | Three more evidence checks block: an assertion about a real person needs the claim it rests on; a kept sentence keeps its claim link; probability wording only for PROBABLE claims | A factual assertion need not contain a number to need a claim; a refinement must not drift a truth status or move a sentence away from its evidence | Rely on the fact checker alone |
| D74 | Performance timing has a budget, and the maximum holds unless the user explicitly allows otherwise | The v3 performance pass took a 14:51 narration to 15:15; the pass now knows what it may spend, and the engine gives up the least valuable timing first, never speeding delivery up | Let the pass add what it likes; or speed delivery up to compensate |
| D75 | A callback needs direction, purpose and distinctiveness; a passenger is judged by what it contributes and whether a later section builds on it, and is a candidate, never an automatic cut | In v3 repeated hedges and a recurring source name were protected as callbacks while the passenger rule found nothing; repetition is good when it pays off, bad when it only repeats | Phrase repetition as callbacks; deleting flagged passengers |
| D76 | The quality report separates measurements from model judgments | Model judgments must never look like objective measurements; the gate stays deterministic | Reviewer verdicts as PASS/WARN checks beside the rules |
| D65 | The writer step gets the model's full output budget | Measured: about 46k of 64k for a 15-minute draft, thinking included; a truncated script fails the job, an unused budget costs nothing | Keep 64k and risk a failed run |
| D77 | A VOICE gate (`VOICE_REVIEW`) between narration and visual planning | Narration is the clock everything downstream is timed against; an audition or an unreviewed take must not become it | Advance to VOICE_COMPLETE when a voice job succeeds |
| D78 | Small chunks of whole sentences, cut by a deterministic cost over every possible cut | One request per script (or per section) makes every fix a full regeneration and drifts in delivery; a cost function makes the cuts explainable and stable | Fixed word windows; one request per block |
| D79 | Canonical, spoken and performance text are stored side by side, and the derived text is checked word for word before sending | The script must never change, and nothing the voice says may differ from it except recorded spoken forms | Write numbers and tags into the script |
| D80 | Performance is provider-neutral words translated from the script's delivery marks; restrained by default | "Human documentary narrator, not AI trying to sound emotional": directions only where the script asks for a delivery, rendered by each provider in its own markup | Tags on every sentence; a closed emotion enum |
| D81 | Eleven v4 by default, never SSML for it, no automatic model fallback | V4 is the recommended expressive model and disables `<break>`; a silent fallback would change the voice of a film without anyone deciding it | Multilingual v2 with break tags |
| D82 | Takes are never deleted; a new take supersedes, an approval survives being superseded | Comparing and going back must be free; nothing paid for is thrown away | Overwrite the chunk's audio |
| D83 | The assembly's clock is the takes' measured durations; pauses between takes are inserted in assembly, less the silence the clips already hold | The script's 150 wpm is a planning estimate; exact silence at a chunk boundary is more reliable than asking a model for a pause | Trust the estimate; pauses only as markup |
| D84 | Audio is stored through the StorageProvider (S3-compatible: a Railway bucket), never in Postgres; paid narration refuses in-memory storage | Durable, cheap, private; the API streams it with byte ranges behind the dashboard's auth | Blobs in Postgres; a Railway volume |
| D85 | Stale audio is detected by block hashes and never reused | A take of other words than the approved script's must not reach the edit; regenerating a stale run is refused in favour of a new run | Re-use takes whose text happens to match |
| D86 | Writing Engine 2 is a library (`modules/writing`) beside the stage packages | Diagnostics, corpus, money context, names and the change report serve the script stage, the API and the dashboard; none of it is a pipeline stage or calls a model | Put it all inside `modules/script` |
| D87 | The Human Narration Pass is its own step between the writer and the script editor, editing texts only, judged change by change | Four problems (true, useful, natural aloud, visible) are not one prompt; the fact checker must see the final words and the performance pass must mark them; texts-only edits keep provenance and give exact lineage | A bigger writer prompt; a pass after the fact checker |
| D88 | The pass may only touch blocks the diagnostics flag | Convergence (a second pass changes nothing) is structural, not a hope; "it should not blindly rewrite every paragraph" | Let the model decide what to change |
| D89 | The corpus is versioned JSON in the repository, bundled into the build, original house writing only | Reviewed like code, retrievable without a database, copyright-safe by construction; the version and every example used are recorded | A database table only; scraped documentary transcripts |
| D90 | Corpus examples go into user messages, retrieved per need, never into system prompts | Topic-laden examples must not shape every documentary; targeted examples beat a dump of the corpus | The whole corpus in the system prompt |
| D91 | AI-pattern and rhythm findings are warnings and telemetry; directions in the narration block approval | The brief: signals, not failures, no hard cutoff; but a bracket in the text would be spoken or taken as a performance tag | Gate on a fingerprint score |
| D92 | Money context only from cited claims, deterministic, with the weaker verdict and a method | "Never invent context": a comparison is arithmetic on two documented figures or the evidence's own words, and it must be checkable | Let the model propose comparisons; hard-coded conversion tables |
| D93 | House examples from approved scripts enter retrieval only when a person approves them with a reason | The model must not learn its own mistakes; the reason is what teaches | Feed every approved script back automatically |
| D94 | Chunks of 20–30 spoken words (≈ 8–12 s), up to ≈ 5–20 s to keep a thought whole; reveal, impact, question and number pauses hold setup and payoff together; a change into or out of fiction is a cut | Long inputs come back faster and flatter; the chunk is the smallest natural unit to regenerate; a reveal cut from its payoff loses both, and fiction is told apart from documented narration | 25–80 words; a cut at every scripted pause |
| D95 | IN_REVIEW for a chunk's current take; GENERATED only for stored audio that is not current (an A/B take) | Nothing is approved automatically, and what awaits a decision must be visible; an A/B take must never displace the take under review by itself | One status for both |
| D96 | A director's directions are laid over the house style; EXPRESSIVE is the house style plus at most one moment per chunk where the script turns; DIRECTED stays as the over-directed reference | The house style is the default performance and a director adds to it, never replaces it; one earned moment is the most a documentary narrator needs | Director's marks replacing the strategy's; DIRECTED as the expressive arm |
| D97 | A take caught mid-request is never sent again on the same row; storage is retried inside the job; a fault after paid audio came back stops the job | The request may already have been billed: a job retry would buy the same audio again | Retry the job as for any other stage |
| D98 | Startup connectivity checks that spend nothing and never decide the HTTP status | The operator sees whether the bucket and the voice work before paying for audio; a slow vendor must not fail Railway's deploy health check | A test generation at startup; health tied to the vendors |
| D99 | Every voice job logs what it did, read back from the database | Acceptance runs are checked from the production logs (the engineers cannot call the authenticated API); a logged figure must be what was stored, not what was meant | Log as the job goes; rely on the dashboard |
| D100 | A saved voice profile is a family with immutable versions; the current version is the newest | Runs and takes must keep the exact configuration they were made with whatever happens to the profile later; a family gives the library a stable name to choose and rename | Edit profiles in place; archive single versions |
| D101 | Provider-specific settings are one open record the provider describes, checks and filters per model | The profile schema must not be one vendor's; a form, a check and what is sent all come from the provider's descriptors, so a new provider adds no column and no engine code | Columns per ElevenLabs setting; a closed settings type in the contract |
| D102 | A project chooses a profile per language version, with its own overrides stored on the choice, never on the profile | Runs, takes and the timeline are per language version and a voice has one language; an override is the project's, so it must not change what other projects hear | One profile per project; overrides saved as a new profile version |
| D103 | Every run and take stores its effective configuration as a snapshot, used verbatim; older rows are reconstructed with frozen earlier rules | What was heard must stay reproducible after a profile edit, an override change or a tuned default | Re-derive from the profile row at read time |
| D104 | The acceptance winner becomes the project's profile through the product ("Save as a voice profile", "Use for this project"), never a code default or a migration | The brief: the result is this documentary's default, not the engine's; another film keeps the library default until it chooses | Change DEFAULT_VOICE_PROFILE_CONFIG to the winner |
| D105 | Cost is estimated from the characters sent; the vendor's character-cost figure is recorded raw, never priced | Its unit under v4 is unverified (about 0.11 of the characters sent); an upper bound is honest, a discount guessed is not | Price the reported figure |
