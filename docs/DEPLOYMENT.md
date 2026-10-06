# Deployment — Railway

The app is one Docker image containing the API, the built dashboard and the
job worker. It needs one PostgreSQL database. With only that, every stage runs
in MOCK mode. Real research additionally needs an Anthropic API key and Tavily
access (see [Enabling real research](#enabling-real-research)).

## Services

Two Railway services, plus a bucket once narration is real:

| Service | What | Required now |
|---|---|---|
| **app** (e.g. `vidgen`) | This whole repository as **one** service, built from the root `Dockerfile` | Yes |
| **Postgres** | Railway PostgreSQL (Database → PostgreSQL) | Yes |
| worker | Same image, start command `node apps/api/dist/worker.js` | No — only when generation load justifies it |
| **Bucket** | A Railway Storage Bucket (S3-compatible, private) for narration audio; production: `media` | Yes for real narration (ElevenLabs): paid audio is never kept in memory |

`apps/api`, `apps/web`, `modules/research` and `packages/*` are parts of the
one application, **not** separate services.

> **Do not add the app with "+ New → GitHub Repository".** Railway's automatic
> import detects the pnpm workspace and stages one service per package
> (`@docengine/api`, `@docengine/research`, `@docengine/web`), each with its
> own build and start commands. None of them works on its own. Railway
> documents this auto-import and no repository setting turns it off. Create an
> **Empty Service** and connect the repository to it instead (below).

> **`railway.json` is not read.** Railway has deprecated Config as Code:
> new services cannot use `railway.json` / `railway.toml`, and existing ones
> stop reading them on 2026-12-01. The file stays in the repository only as a
> record of the same values; the settings below must be set on the service.

## Service settings (app)

| Setting (Railway → service → Settings) | Value |
|---|---|
| Source | GitHub repository, branch to deploy; **Root Directory empty** (repository root) |
| Builder | Dockerfile, path `Dockerfile` (Railway also auto-detects it at the root) |
| Start command | leave empty: the Dockerfile's `CMD` is `node apps/api/dist/server.js` |
| **Pre-deploy command** | `sh scripts/release.sh` |
| Healthcheck path | `/api/health`, timeout `120` s |
| Restart policy | On failure, max `5` retries |
| Draining seconds | `30` |

**The pre-deploy command is required.** Without it no migrations run: the app
starts against an empty database and logs `relation "jobs" does not exist`
every second, while Railway still shows the deployment as SUCCESS (the health
check only proves the database is reachable).

## What happens on each deploy

1. **Build** the `Dockerfile` (multi-stage: install → `prisma generate` →
   build dashboard → bundle API → production-only dependencies).
2. **Pre-deploy:** `sh scripts/release.sh`
   - `prisma migrate deploy` — applies new migrations, never resets data;
   - `node apps/api/dist/seed.js` — creates the *Tulip Mania* demo project if
     it does not exist; never modifies it afterwards.
   If this fails, the deploy stops and the previous version keeps serving.
3. **Start:** `node apps/api/dist/server.js` (listens on Railway's `PORT`).
4. **Health check:** waits for `GET /api/health` → 200 (database reachable)
   before routing traffic. Timeout 120 s.
5. On the next deploy the old container gets SIGTERM; it stops taking
   requests, returns in-flight jobs to the queue and exits (up to 30 s).
   **A deploy, restart or variable change interrupts a running research
   job.** It resumes from its saved progress, but the step that was running
   (for example synthesis) starts over and is paid again, so avoid changes
   while research runs.

Every push to the connected branch deploys automatically.

## Step by step (first deploy)

1. **Create an empty project.** Railway dashboard → *New Project* → *Empty
   project*.
2. **Add PostgreSQL.** *+ New* → *Database* → *PostgreSQL*. A service named
   `Postgres` appears.
3. **Add the app as one service.** *+ New* → *Empty Service*; rename it (e.g.
   `vidgen`). Then *Settings* → *Source* → *Connect Repo* → this repository →
   choose the branch. Leave *Root Directory* empty.
4. **Service settings:** set everything in the table above (pre-deploy
   command, healthcheck, restart policy, draining).
5. **Variables** on the app service (*Variables* tab):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable — Railway's private network) |
   | `DASHBOARD_PASSWORD` | a strong secret, **≥ 12 characters** (the app refuses to start without it in production) |
   | `DASHBOARD_USER` | optional, default `admin` |

   `NODE_ENV=production` is already set in the image. Leave the `*_PROVIDER`
   variables unset (they default to `mock`) until you enable real research.
6. **Deploy:** Railway stages all of the above; press *Deploy* on the
   "Apply N changes" bar.
7. **Expose it.** App service → *Settings* → *Networking* → *Generate Domain*.
   Do not set `PORT`; Railway provides it.
8. **Verify.**
   - The deploy log shows `[release] applying database migrations` …
     `All migrations have been successfully applied.` … `[release] done`.
   - `https://<your-domain>/api/health` → `{"status":"ok","database":"ok","mockMode":true,…}`
   - `https://<your-domain>/` → browser asks for the dashboard user/password →
     project list shows **Tulip Mania** in status *Idea*.

## Enabling real research

1. **Anthropic:** create an API key in the Claude Console (console.anthropic.com
   → *API keys*). Make sure the organisation has credit or billing set up.
2. **Tavily:** create an API key at app.tavily.com. Note your plan's price per
   credit (pay-as-you-go: $0.008). Alternatively `TAVILY_ACCESS_MODE=keyless`
   uses Tavily's free, rate-limited access with no key (fine for trying it,
   not for production volumes).
3. **Set on the app service** (*Variables* tab — the keys stay server-side and
   never reach the dashboard):

   | Variable | Value |
   |---|---|
   | `AI_PROVIDER` | `anthropic` |
   | `ANTHROPIC_API_KEY` | your key |
   | `RESEARCH_PROVIDER` | `tavily` |
   | `TAVILY_API_KEY` | your key (or `TAVILY_ACCESS_MODE=keyless`) |
   | `TAVILY_USD_PER_CREDIT` | your plan's $/credit (for cost estimates) |
   | `RESEARCH_MAX_COST_USD` | optional, default `40` |
   | `STORY_MAX_COST_USD` | optional, default `15` (per story-mining, architecture, revision or angles job) |
   | `SCRIPT_MAX_COST_USD` | optional, default `15` (per script job: a draft, a section rewrite or a revision) |

4. **Verify:** `/api/health` → `"realStages":["RESEARCH","STORY_MINING","STORY_ARCHITECTURE","STORY_ANGLES","SCRIPT"]` and the providers
   list shows `anthropic` and `tavily` with `"mock":false`. The project page
   says which stages are real and which are MOCK placeholders.
5. **Run:** project page → *Run Research*, or from a Railway shell on the app
   service (`railway ssh`, or *Service → ⋯ → Shell*):
   `node apps/api/dist/research.js tulip-mania` — runs the job to completion
   and prints the evidence report (sources by type, verdict counts, example
   disputed and myth claims with their quotes, quality gate, cost).

A run reads about 45 documents with Claude. First live run (Tulip Mania,
2026-10-04): 265 candidate sources → 44 selected → 41 documents read → 79
claims; synthesis alone took about 15 minutes. Cost per clean run is still an
estimate ($10–20 with the default model, mostly the output tokens of reading,
plus ~130 Tavily credits): that first run included failed attempts, so its
total on the project's Cost card is higher than a clean run. The run is stopped
and marked FAILED if its recorded spend passes `RESEARCH_MAX_COST_USD`
(checked between steps and before every document read).

**Retries do not repeat paid work.** Each completed step (plan, searches,
triage, retrieval, synthesis, review) is saved with the job, and per-source
readings are cached with the stored documents. An automatic retry, or the
dashboard's *Retry* on a failed job, resumes after the last completed step;
the Activity panel marks reused steps "reused from an earlier attempt". Use
*Retry* on the most recent failed job: it holds the saved progress.

The job runs in the embedded worker. A deploy, restart or variable change
during a run returns the job to the queue; the next container resumes it, but
the step that was running starts over.

## Deploying Story Engine 2.0

No new environment variables or services. The pre-deploy command applies
migration `20261004120000_story_engine_2`, which is additive only: four new
enums, nullable columns on `story_candidates`, `engine_version` (default 1) on
`story_packs` and `story_architectures`, and two new tables
(`content_opportunities`, `content_opportunity_claims`). Existing packs and
architectures are not changed: they keep `engine_version = 1` and stay
readable on the Story page. Research tables are untouched.

A saved checkpoint from a story job started before the deploy is ignored (the
prompt version changed), so a Retry of such a job starts its model calls
again. An architecture costs four model calls instead of two (story editor and
content opportunities added).

## Deploying the editorial revision loop and alternative angles

No new environment variables or services. The pre-deploy command applies
migration `20261004150000_story_revisions`, which is additive only: a new job
type value (`STORY_ANGLES`), three nullable columns on `story_architectures`
(`revision_of_id`, `exploration_id`, `angle_key`) and a new table
`story_explorations`. Existing architectures are not changed (they read as
"built from the selection"); research tables are untouched.

The story prompt version changed (`story-2.1-2026-10-04.1`), so a Retry of a
story job started before the deploy starts its model calls again. A revision
costs the same four calls as an architecture; an angle exploration costs one.

## Deploying Script Engine 1.0

No new services. Two optional variables: `SCRIPT_MAX_COST_USD` (default 15)
and `SCRIPT_MODELS` (per-step model overrides; unset = `AI_MODEL` for every
step). The pre-deploy command applies migration
`20261005010000_script_engine`, which is additive only: two new enums
(`ScriptBlockClass`, `SectionReviewStatus`), nullable or defaulted columns on
the milestone-1 tables `scripts` (engine version, content, quality report and
flag, stats, target duration, word count, `revision_of_id`, `job_id`) and
`scenes` (sequence number, plan, the editor's review status, notes, reviewer
and time), and two new tables `script_blocks` and `script_block_claims`.
No existing row is changed; research and story tables are untouched.

With `AI_PROVIDER=anthropic`, `/api/health` lists `SCRIPT` among the real
stages. A project whose architecture is approved shows a **Script** page:
*Generate Script Draft* runs five model calls (planner, writer, script editor,
fact checker, performance) and stops in *Script review*. Nothing is voiced;
approving the script does not start anything.

## Deploying Writing Engine 2

No new services, no new required variables. The pre-deploy command applies
migration `20261005130000_writing_engine_2`, which is additive only: one new
enum (`WritingExampleStatus`) and one new table (`writing_examples`, the house
candidates from approved scripts). No existing row is changed; the Voice
Engine's tables and code are untouched.

The script prompt version changed (`script-2.0-2026-10-05.2`) and the script
job has a new step, `narrate`: a Retry of a script job started before the
deploy starts its model calls again. A draft now makes six model calls
(planner, writer, narration pass, script editor, fact checker, performance);
a refinement or a section rewrite five; the stand-alone **narration pass** on
a version (Script page → *Human Narration Pass on vN*) four. Set
`SCRIPT_NARRATION_MODES=none` to keep drafts and refinements at their earlier
cost and run the pass only on demand.

The corpus is part of the build (`modules/writing/corpus`, bundled): nothing to
upload. The **House style** page (`/writing`) shows it.

## Deploying the narrative refinement

No migration, no new variables. The script prompt version changed
(`script-1.2-2026-10-05.1`), so a Retry of a script job started before the
deploy starts its model calls again. The refinement's house style is built
in; the *Director's instructions* field is optional. The writer step's output budget is now
the model's full 128k tokens (a model with a smaller output limit set for the
`write` step through `SCRIPT_MODELS` would be refused by the provider). A
refinement makes four model calls.

## Deploying the Script Quality Rules

No migration, no new variables, no new model calls. The script prompt version
changed (`script-1.3-2026-10-05.1`): a Retry of a script job started before the
deploy starts its model calls again. Saved versions keep the quality report
they were made with; the new rules apply to new versions and to a version
re-checked by an edit — where one new rule blocks approval (a documented or
uncertain block naming a real person that cites no claim about them). A
script job's log now has a line *Script quality rules on vN* when it starts
from a version, and *Script quality rules, vN → vM* before *saved for
review*, with the full digest in the event's data.

## Deploying granular review and the performance budget

No migration, no new variables. The reviewer-change record, the report's
measurements and judgments and the job option are new optional fields in JSON
columns that already exist; older versions read as before. The script prompt
version changed (`script-1.4-2026-10-05.1`), and the reviewers' patch format
now carries a reason per change: a Retry of a script job started before the
deploy starts its model calls again. The generate, revise and refine panels
have an option, off by default, to let the performance pass run past the
runtime maximum.

## Deploying Voice Engine V1 (ElevenLabs v4)

No new services beyond the bucket. The pre-deploy command applies two
migrations, both additive only:

- `20261005070000_voice_engine`: the voice tables (`voice_profiles`,
  `voice_runs`, `voice_chunks`, `voice_generations`, `voice_assemblies`,
  `voice_pronunciations`), the `VOICE_REVIEW` status, the VOICE gate and
  `approvals.voice_assembly_id`;
- `20261006090000_voice_v4_production`: the enum values `IN_REVIEW` (a take
  awaiting review) and `EXPRESSIVE` (a performance strategy), and two
  nullable columns on `voice_generations`, `performance_text_hash` and
  `variant` (an A/B take's label). The new values are not used inside the
  migration itself, as PostgreSQL requires.

No existing row is changed: a current take stored as `GENERATED` reads as
*To review*, and an assembly made before audio assets were recorded in its
entries gets them from its takes. Both migrations are applied in
production. The real VOICE stage runs when the script stage is real
(`AI_PROVIDER=anthropic`); with `VOICE_PROVIDER=mock` every take is a
labelled MOCK beep. Real voice needs real storage: see [Enabling real
narration](#enabling-real-narration-elevenlabs--a-railway-bucket).

## Environment variables

`✓` = read by V1 code. Planned variables are documented now so the shape is
agreed, but they are not read yet.

| Variable | Default | V1 | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | ✓ | `production` on Railway |
| `PORT` | `3000` | ✓ | Injected by Railway |
| `HOST` | `0.0.0.0` | ✓ | |
| `LOG_LEVEL` | `info` | ✓ | `debug` also logs dashboard polling requests |
| `DATABASE_URL` | — | ✓ | **Required** |
| `DATABASE_POOL_SIZE` | `10` | ✓ | Connections per process |
| `DASHBOARD_USER` | `admin` | ✓ | |
| `DASHBOARD_PASSWORD` | — | ✓ | **Required in production**, ≥ 12 chars |
| `WORKER_ENABLED` | `true` | ✓ | Embedded worker in the web process |
| `WORKER_POLL_INTERVAL_MS` | `1000` | ✓ | |
| `WORKER_CONCURRENCY` | `1` | ✓ | Parallel jobs per process |
| `JOB_MAX_ATTEMPTS` | `3` | ✓ | |
| `JOB_LOCK_TIMEOUT_MS` | `900000` | ✓ | RUNNING job without heartbeat this long is recovered |
| `AI_PROVIDER` | `mock` | ✓ | `mock` or `anthropic` |
| `RESEARCH_PROVIDER` | `mock` | ✓ | `mock` or `tavily` |
| `VOICE_PROVIDER` | `mock` | ✓ | `mock` or `elevenlabs` |
| `STORAGE_PROVIDER` | `mock` | ✓ | `mock` (in memory, lost on restart) or `s3` |
| `VIDEO_PROVIDER`, `RENDER_PROVIDER`, `PUBLISHING_PROVIDER` | `mock` | ✓ | Only `mock` is implemented; other values fail at startup with a clear message |
| `ANTHROPIC_API_KEY` | — | ✓ | Required when `AI_PROVIDER=anthropic` |
| `AI_MODEL` | `claude-opus-5-5` | ✓ | Default model for every AI task (research, story, script); cost is estimated from the served model's published token prices |
| `TAVILY_API_KEY` | — | ✓ | Required when `RESEARCH_PROVIDER=tavily`, unless keyless |
| `TAVILY_ACCESS_MODE` | `api-key` | ✓ | `keyless` = Tavily's free, rate-limited access ($0) |
| `TAVILY_USD_PER_CREDIT` | `0.008` | ✓ | Your plan's price; Tavily reports credits, so dollar cost is an estimate |
| `RESEARCH_MAX_COST_USD` | `40` | ✓ | Per-run ceiling; the run stops (FAILED, not retried) once recorded spend passes it |
| `RESEARCH_MAX_SOURCES` | `45` | ✓ | Sources whose full text is retrieved and read per run |
| `STORY_MAX_COST_USD` | `15` | ✓ | Per-job ceiling for story mining, story architecture (and revisions) and angle explorations; the job stops (FAILED, not retried) once recorded spend passes it |
| `SCRIPT_MAX_COST_USD` | `15` | ✓ | Per-job ceiling for a script draft, section rewrite or revision; same behaviour |
| `SCRIPT_MODELS` | — | ✓ | Optional per-step models for the script, e.g. `perform=<model>,edit=<model>` (steps: plan, write, narrate, edit, factCheck, perform); unset steps use `AI_MODEL`. With the real AI provider, a malformed value stops the server at startup |
| `SCRIPT_NARRATION_MODES` | `all` | ✓ | Writing Engine 2: the script modes the Human Narration Pass runs in — `all`, `none` (only the stand-alone narration pass), or a list such as `DRAFT,REFINEMENT`. A malformed value stops the server at startup |
| `WEB_DIST_DIR` | `apps/web/dist` | ✓ | Override only for unusual layouts |
| `RAILWAY_GIT_COMMIT_SHA` | — | ✓ | Set by Railway; shown in `/api/health` |
| `TEST_DATABASE_URL` | — | tests | Integration tests only; DB name must contain `test` |
| `ELEVENLABS_API_KEY` | — | ✓ | Required when `VOICE_PROVIDER=elevenlabs`; server-side only |
| `ELEVENLABS_VOICE_ID` | — | ✓ | The voice of the first voice profile (profiles are versioned in the dashboard; nothing is hard-coded) |
| `ELEVENLABS_MODEL_ID` | `eleven_v4` | ✓ | Production default; no automatic fallback to another model |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | ✓ | `mp3_*`, `wav_*` or `pcm_*` (opus/µ-law cannot be measured or joined without transcoding). 192 kbps MP3 needs Creator+, 44.1 kHz PCM/WAV Pro+ |
| `ELEVENLABS_USD_PER_1K_CHARS` | — | ✓ | Your plan's price, used for every model; unset, the estimate uses the documented API list price per model (v4: $0.08). ElevenLabs reports characters, so dollar cost is an estimate |
| `VOICE_CONFIRM_CHARACTERS` | `3000` | ✓ | Above this a run or regeneration must be confirmed; the whole script, every comparison, every A/B and a regeneration of every chunk always are |
| `VOICE_MAX_CHARACTERS` | `40000` | ✓ | Ceiling on what one voice job may send: a plan above it is blocked, generating it is refused, a running job stops sending at it. Production: `12000` (the hard stop: the opening experiment fits, a full narration does not) |
| `VOICE_CONCURRENCY` | `2` | ✓ | Takes generated at once (1 when stitching) |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` | — | planned | Exact credential format confirmed when integrated |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | —, `auto`, — | ✓ | Required when `STORAGE_PROVIDER=s3`; reference a Railway bucket's `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` |
| `S3_FORCE_PATH_STYLE`, `S3_SIGNED_URL_TTL_SEC` | `false`, `3600` | ✓ | Path-style only for buckets whose Credentials tab says so (older Railway buckets, MinIO); production leaves path style unset (a virtual-hosted bucket). Narration streams through the API and uses no signed URLs |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | — | planned | |

## Enabling real narration (ElevenLabs + a Railway bucket)

Narration audio is paid for per character, so the app refuses real
narration while storage is in memory. Production (`vidgen`) is configured as
below; its health check reports storage and voice `ok` (2026-10-06). No real
narration has been generated yet.

1. **Bucket.** In the Railway project: *Create* → *Bucket*. Production uses
   the bucket **`media`**: S3-compatible and private, virtual-hosted-style
   URLs, endpoint `https://t3.storageapi.dev`, region `auto`. Do not create
   another one.
2. **Storage variables** on the app service, as variable references to the
   bucket (no secret is copied by hand):

   | Variable | Value |
   |---|---|
   | `STORAGE_PROVIDER` | `s3` |
   | `S3_ENDPOINT` | `${{media.ENDPOINT}}` |
   | `S3_REGION` | `${{media.REGION}}` |
   | `S3_BUCKET` | `${{media.BUCKET}}` |
   | `S3_ACCESS_KEY_ID` | `${{media.ACCESS_KEY_ID}}` |
   | `S3_SECRET_ACCESS_KEY` | `${{media.SECRET_ACCESS_KEY}}` |
   | `S3_FORCE_PATH_STYLE` | **unset** (`false`: virtual-hosted requests, which the bucket uses; `true` only for a bucket whose *Credentials* tab says path-style) |
   | `S3_SIGNED_URL_TTL_SEC` | unset (narration never uses signed URLs: the API streams the audio) |

   Do not use Railway's credential presets that inject `AWS_*` names: the app
   reads only the `S3_*` names above.
3. **Voice variables:** `VOICE_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`,
   `ELEVENLABS_VOICE_ID` (a voice that works with Eleven v4 — voice clones
   made before v4 may need retraining for it), `ELEVENLABS_MODEL_ID=eleven_v4`
   (the default; set explicitly in production). Optional:
   `ELEVENLABS_OUTPUT_FORMAT` (default `mp3_44100_128`). A key limited by
   scope needs text to speech, reading voices (the startup check also reads
   the model list) and writing pronunciation dictionaries (approved
   phonemes); a 401, 402, 403 or 404 stops a voice job.
4. **Cost estimates:** ElevenLabs reports characters, not dollars. Unless
   `ELEVENLABS_USD_PER_1K_CHARS` is set, every estimate uses the documented
   API list price (`eleven_v4`: $0.08 per 1,000 characters, checked
   2026-10-05; the pricing page then gave v4 a launch price of $0.022 until
   2026-10-12). Set it to the account's actual rate to make the estimates
   match the bill; it then prices every model. Estimates are labelled
   ESTIMATED; the provider's own character count is used where it reports
   one (`character-cost`), else the characters sent, noted as counted.
5. **Hard-stop guard:** `VOICE_MAX_CHARACTERS=12000` in production. One job
   (a run, an experiment, a regeneration) may not send more: a plan above
   it is shown as blocked, generating it is refused, and a running job stops
   sending at it. This allows the acceptance experiment (about 10,700
   characters for the seven variants of the opening) and refuses a full
   narration (about 13,500 characters). Raise it only when a full narration
   is wanted.
   `VOICE_CONFIRM_CHARACTERS` (default 3,000) and `VOICE_CONCURRENCY`
   (default 2; set 1 if ElevenLabs answers 429) stay at their defaults.
6. **Migrations:** the pre-deploy command applies them (see [Deploying Voice
   Engine V1](#deploying-voice-engine-v1-elevenlabs-v4)). Production has
   `20261006090000_voice_v4_production` applied.
7. **Verify:** after the deploy, `/api/health` shows

   ```
   "providers": [… {"kind":"VOICE","name":"elevenlabs","mock":false}, … {"kind":"STORAGE","name":"s3","mock":false} …],
   "realStages": [… "SCRIPT", "VOICE"],
   "storage": "ok", "storageDetail": "wrote, read back and deleted healthchecks/probe-….txt in 730 ms",
   "voice": "ok", "voiceDetail": "voice \"…\" found; model eleven_v4 listed"
   ```

   Both checks run once at startup, spend nothing, and are logged once
   (`connectivity check passed`, or a warning naming what failed). A check
   still running reads `"error"` with "Startup check still running" for up
   to 15 s after a start. `storage: "error"` or `voice: "error"` never makes
   the health check fail (only the database does): read the detail, fix the
   variable, and the redeploy checks again. After the first take, the
   bucket's *Files* tab shows `projects/<project id>/<language>/narration_audio/…`.

The browser never sees a key or a bucket URL: audio is streamed by the API
(with byte ranges) behind the dashboard's authentication. Bucket storage is
$0.015 per GB-month; a 15-minute narration in MP3 is about 15 MB plus its
takes.

**Do not deploy or change variables while a voice job runs.** A restart
hands the job back to the queue: untried takes stay pending; a take caught
mid-request is closed as FAILED (its request may have been billed — see the
ledger) and the next attempt makes a new take for that chunk instead of
sending the same one again.

### Operator runbook: the opening audition and the regeneration test

The acceptance run is triggered by the operator in the dashboard; the
engineers check it from the Railway logs (app service, filtered by the
job's `jobId`; every line also carries `jobType: VOICE`). Nothing below approves anything: every take waits for a
human decision.

**Before.** `/api/health` as in step 7. The project (Tulip Mania) has an
approved script version and is in *Script approved* or a *Voice* status. No
other voice job is queued or running.

**1. Plan the acceptance experiment** (nothing is generated, nothing is
paid). Project page → **Voice** → *Audition & generate* → the panel
*Acceptance experiment — eleven_v4* → **Plan the acceptance experiment
(nothing is generated)**. The first plan creates the ElevenLabs voice
profile ("House narrator") from the configured voice, model and output
format, with the house settings (restrained, 20–30 words, neighbouring
text); the *Voice profile* tab shows it. Check, for each of the seven
variants (A plain,
B restrained, C expressive, D over-directed, E no context, F 5–8 s chunks,
G 12–20 s chunks): the chunk count, the planned seconds per chunk (chunks
outside 5–20 s are counted), the characters and the estimated cost; open
*The N chunks* to read exactly what each chunk sends (C adds at most one
deliberate moment per chunk to B's directions; D has a bracket on every
sentence). The total should be about 10,700 characters. A red line instead
of the confirmation box says why it cannot be generated (for example over
`VOICE_MAX_CHARACTERS`): stop there.

Planning also fills the *Pronunciation* tab with the opening's names,
places and foreign words. Decide them there if wanted (terms still to check
do not block an audition, but they are reported in its QA and its log),
then come back and plan again, so the figures include the decisions.

**2. Generate it.** Tick *I confirm all 7 runs (each variant is generated in
full): … characters, … estimated* and press **Generate the acceptance
experiment (7 runs, one job)**. One VOICE job generates the seven runs one
after another, each chunk a separate request; the page shows "Generating
takes…" and fills in as chunks finish. The run picker lists the seven runs.

**3. Listen and read the results.** On any of the seven runs, the
*Comparison "Acceptance experiment" — 7 variants* panel shows each
variant's measured length, mean chunk, characters, cost and its assembled
audio to play whole; *Open run N to review its chunks* opens one. Each
chunk card plays its take and shows *what was sent*. Every take and every
assembly reads *To review*. In the logs, the job has a `voice chunk` line
per chunk, a `voice run summary` per variant and one `voice experiment
comparison` (ARCHITECTURE.md §16, *Acceptance logging*).

**4. Regenerate one chunk.** Open run **B restrained** (the house default).
Note its assembly (*Assembled narration v1 — m:ss*) and pick one chunk.
Press **Regenerate** on that chunk's card: one new take of one chunk (a few
hundred characters, below the confirmation threshold, so no confirmation
is asked). When the job finishes:

- the chunk shows take 2 as current, *To review*, and take 1 under
  *Compare 1 earlier take* (still playable; *Use this take* would make it
  current again);
- the assembly heading reads v2 with the new length, and *Earlier versions
  (1)* still plays v1;
- every other chunk still shows its take 1;
- the log has a `voice regeneration summary`: the chunk's previous take
  and the new one (generation, duration, alignment, ledger row and cost),
  the assembly version and total duration before → after, and the other
  chunks with `othersIntact: true`.

**5. Stop.** This milestone ends with the audition: no full narration.
`VOICE_MAX_CHARACTERS=12000` refuses *The whole script* at planning.

### Browser QA of the Voice page (MOCK, local)

`sh scripts/ui/voice-ui.sh` builds the dashboard, seeds a throwaway
database with a MOCK fixture (`scripts/ui/voice-fixture.ts`: a project with
an approved script, a direction comparison, an audition with a take still
generating and a newer one failed), serves it with the job worker, and
clicks through the Voice page with Playwright at 1280, 412 and 360 px
(`scripts/ui/voice-ui.mjs`): plan, generate an audition, play the assembled
audio, regenerate one chunk, approve, use the previous take, compare takes
and variants; at 1280 also directions, selected chunks, an A/B, the
acceptance experiment and a new profile version (which a confirmed plan is
not moved to); on every width no horizontal overflow, every button in a
chunk card at least 24 px tall, generation state visible and no console
errors. It prints `ok` / `FAIL` per check, ends with "every check passed",
and exits non-zero on any failure. MOCK voice and MOCK storage only: nothing
is paid and no key is read.

It needs PostgreSQL (`DATABASE_URL`, read from `.env` if present), `psql`,
and Playwright with Chromium. Options (environment variables):

| Variable | Default | What |
|---|---|---|
| `VOICE_UI_DB` | `docengine_voice_ui` | Database created next to `DATABASE_URL`'s, dropped first: its name must contain `ui` |
| `VOICE_UI_PORT` | `3102` | Port the fixture serves on |
| `VOICE_UI_OUT` | `$TMPDIR/voice-ui` (else `/tmp/voice-ui`) | Screenshots and the build, migration and server logs |
| `VOICE_UI_SKIP_BUILD` | — | `1` reuses `apps/web/dist` instead of building |
| `PLAYWRIGHT_MODULE` | — | Where to load Playwright from, if it is neither installed in the repository nor globally |

## Scaling the worker (later)

1. Add a service from the same repository; *Settings* → *Deploy* → custom
   start command `node apps/api/dist/worker.js`; same variables as the app
   (`DATABASE_URL`, `NODE_ENV`, provider settings). No domain, no health check
   path.
2. On the web service set `WORKER_ENABLED=false`.
3. Raise `WORKER_CONCURRENCY` or add replicas; `FOR UPDATE SKIP LOCKED`
   guarantees each job is claimed once.

## Operations

- **Logs:** JSON lines; filter in Railway by `jobId`, `projectId`,
  `provider`, `level`.
- **Database UI:** locally `pnpm db:studio` with `DATABASE_URL` pointed at the
  Railway Postgres public URL (Postgres service → *Connect*).
- **Migrations:** create locally with `pnpm db:migrate` (commits a new folder
  under `packages/database/prisma/migrations`); Railway applies it on the next
  deploy.
- **Rollback:** redeploy the previous deployment in Railway. Migrations are
  forward-only: write a new migration to undo a schema change.
- **Backups:** enable Railway's Postgres backups for the project (availability
  depends on plan).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Deploy fails at health check, log says `DASHBOARD_PASSWORD … is required in production` | Set `DASHBOARD_PASSWORD` (≥ 12 chars). |
| Startup fails with `VOICE_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY` / `STORAGE_PROVIDER=s3 needs S3_ENDPOINT, S3_BUCKET…` | Set the missing variables (see [Enabling real narration](#enabling-real-narration-elevenlabs--a-railway-bucket)). |
| Planning a voice run says `Real narration needs durable storage` | Real voice with in-memory storage is refused: set up the bucket and `STORAGE_PROVIDER=s3`. |
| A voice job stops with `HTTP 401` / `HTTP 402` / `HTTP 403` / `HTTP 404` | Rejected key, no credits, no access (a key without the permission), or a voice/model the account cannot use — decided by the status code. The takes not tried yet stay pending: fix the variable or the plan, then *Retry* the job. |
| A take fails with `HTTP 422` or `HTTP 400` | That chunk's request was refused (the error says why); the other takes went on. Regenerate the chunk. |
| A take is flagged `No timestamps came back` | The provider returned no alignment for it: it cannot be placed on the timeline. Regenerate it. |
| `/api/health` shows `"storage":"error"` | The startup probe could not write, read back or delete `healthchecks/probe-….txt`; `storageDetail` names the step and the bucket's answer. Check the `S3_*` references (and `S3_FORCE_PATH_STYLE`, unset for a virtual-hosted bucket); a variable change redeploys and checks again. |
| `/api/health` shows `"voice":"error"` | `voiceDetail` says whether the voice was not found (`ELEVENLABS_VOICE_ID`, or a key that cannot read voices) or the model is `NOT listed for this key` (`ELEVENLABS_MODEL_ID`). "Startup check still running" right after a start clears within 15 s. |
| A take fails with `Storage failed: …` (QA `STORAGE_FAILED`) | The audio came back (and was paid for) but the bucket did not take it after three tries; its ledger row is kept. Regenerate the chunk once storage works. A refusal (e.g. HTTP 403) stops the job before more audio is bought. |
| A take fails with `Interrupted mid-request …` | A deploy or restart caught it during its request: it may have been billed (see its ledger row) and is never sent again; the chunk's next take was generated in its place. |
| Planning or generating says the characters are `over the ceiling of …` (`VOICE_MAX_CHARACTERS`) | Intended: the per-job hard stop (production 12000 refuses a full narration). Plan a smaller scope, or raise the variable when a full narration is wanted. |
| `POST /api/projects/:id/jobs` with `type: VOICE` answers `Use POST /api/projects/:id/voice/runs` | Real narration starts from a planned run (Voice page, or the voice routes), never from a bare VOICE job. |
| Research job fails with `ANTHROPIC_API_KEY is not set` / `TAVILY_API_KEY is not set` | Set the key on the service (or `TAVILY_ACCESS_MODE=keyless`). |
| Research job fails with `Research stopped: estimated spend … exceeds the per-run ceiling` | Intended stop. Raise `RESEARCH_MAX_COST_USD` if the spend is justified, then *Retry* (stored documents and readings are reused). |
| Research job fails with `Research quality gate failed: …` | The dossier was saved as DRAFT; open it (Research dossier → Quality gate tab) to see which checks failed. Rewind and run again, possibly with a research brief. |
| `/api/health` shows `"realStages":[]` although keys are set | Both `AI_PROVIDER=anthropic` and `RESEARCH_PROVIDER=tavily` are needed for the real research stage. |
| *Generate Story Architecture* answers "Select at least 5 story units" | Intended check before any paid work: select 5–10 candidates on the Story page (rejected ones never count). |
| Story job fails with `Story mining quality gate failed` / `Story architecture quality gate failed` | The gate's report is on the Story page (*Quality gates*); the pack or architecture is kept as a DRAFT. *Retry* re-evaluates without new model calls; for different material, rewind to *Research complete* (mining) or *Story selection* (architecture) and run again, with a brief. |
| A revision fails with `Story architecture quality gate failed … Architecture vN is unchanged (…)` | The revision was saved as a DRAFT and the version it revised kept its status. *Retry*, revise again with another brief, or go back to the selection. |
| *Explore Alternative Angles* fails with `Fewer than two materially different angles survived the rules` | Only the side job failed; the project is unchanged. The exploration is saved (Angles tab) with the reasons each angle was removed. Retry, or explore again with a brief. |
| *Reconsider* or *Explore* answers `… is a MOCK stage here` | Revisions and angles need the real story engine (`AI_PROVIDER=anthropic`). |
| Pre-deploy fails with `P1001: Can't reach database server` | `DATABASE_URL` missing or not referencing the Postgres service. |
| Railway created services `@docengine/api`, `@docengine/research`, `@docengine/web` | The repository was added through "+ New → GitHub Repository" (monorepo auto-import). Discard those staged changes and use *Empty Service* → *Connect Repo* (step 3). |
| Deployment shows SUCCESS but the log repeats `relation "jobs" does not exist` | The pre-deploy command `sh scripts/release.sh` is not set, so migrations never ran. Set it and redeploy. |
| Research job fails with `invalid byte sequence for encoding "UTF8": 0x00` | Fixed in `cc69dd9` (extracted text is cleaned); deploy a newer commit and press Retry on the failed job. |
| `/api/health` returns 503 `database: "error"` | Database down or credentials rotated; check the Postgres service. |
| Browser keeps asking for a password | Wrong `DASHBOARD_USER`/`DASHBOARD_PASSWORD`. |
| Jobs stay QUEUED | `WORKER_ENABLED=false` on the only service, or no worker service running. |

## Image notes

The runtime image is ~0.9 GB uncompressed. Most of it is the Prisma CLI's own
dependency tree (Prisma Studio, embedded Postgres used by `prisma dev`, etc.),
present because the image runs `prisma migrate deploy` in the pre-deploy step.
It does not affect runtime performance. A later optimisation is a separate,
slim migration image — not worth the complexity in V1.
