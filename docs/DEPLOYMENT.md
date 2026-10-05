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
| **Bucket** | A Railway Storage Bucket (S3-compatible, private) for narration audio | Yes for real narration (ElevenLabs): paid audio is never kept in memory |

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
| `SCRIPT_MODELS` | — | ✓ | Optional per-step models for the script, e.g. `perform=<model>,edit=<model>` (steps: plan, write, edit, factCheck, perform); unset steps use `AI_MODEL`. With the real AI provider, a malformed value stops the server at startup |
| `WEB_DIST_DIR` | `apps/web/dist` | ✓ | Override only for unusual layouts |
| `RAILWAY_GIT_COMMIT_SHA` | — | ✓ | Set by Railway; shown in `/api/health` |
| `TEST_DATABASE_URL` | — | tests | Integration tests only; DB name must contain `test` |
| `ELEVENLABS_API_KEY` | — | ✓ | Required when `VOICE_PROVIDER=elevenlabs`; server-side only |
| `ELEVENLABS_VOICE_ID` | — | ✓ | The voice of the first voice profile (profiles are versioned in the dashboard; nothing is hard-coded) |
| `ELEVENLABS_MODEL_ID` | `eleven_v4` | ✓ | Production default; no automatic fallback to another model |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | ✓ | `mp3_*`, `wav_*` or `pcm_*` (opus/µ-law cannot be measured or joined without transcoding). 192 kbps MP3 needs Creator+, 44.1 kHz PCM/WAV Pro+ |
| `ELEVENLABS_USD_PER_1K_CHARS` | — | ✓ | Your plan's price; default is the documented API list price per model (v4: $0.08). ElevenLabs reports characters, so dollar cost is an estimate |
| `VOICE_CONFIRM_CHARACTERS` | `3000` | ✓ | Above this (and for the whole script, and every comparison) a generation must be confirmed |
| `VOICE_MAX_CHARACTERS` | `40000` | ✓ | Ceiling on what one voice job may send |
| `VOICE_CONCURRENCY` | `2` | ✓ | Takes generated at once (1 when stitching) |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` | — | planned | Exact credential format confirmed when integrated |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | —, `auto`, — | ✓ | Required when `STORAGE_PROVIDER=s3`; reference a Railway bucket's `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` |
| `S3_FORCE_PATH_STYLE`, `S3_SIGNED_URL_TTL_SEC` | `false`, `3600` | ✓ | Path-style only for buckets whose Credentials tab says so (older Railway buckets, MinIO) |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | — | planned | |

## Enabling real narration (ElevenLabs + a Railway bucket)

Narration audio is paid for per character, so the app refuses real
narration while storage is in memory.

1. **Bucket.** In the Railway project: *Create* → *Bucket* (pick a region,
   any name). It is private; its *Credentials* tab lists the S3 endpoint and
   keys.
2. **Storage variables** on the app service, as variable references to the
   bucket (no secret is copied by hand):
   `STORAGE_PROVIDER=s3`, `S3_ENDPOINT=${{<bucket>.ENDPOINT}}`,
   `S3_REGION=${{<bucket>.REGION}}`, `S3_BUCKET=${{<bucket>.BUCKET}}`,
   `S3_ACCESS_KEY_ID=${{<bucket>.ACCESS_KEY_ID}}`,
   `S3_SECRET_ACCESS_KEY=${{<bucket>.SECRET_ACCESS_KEY}}`. Set
   `S3_FORCE_PATH_STYLE=true` only if the Credentials tab says the bucket
   uses path-style URLs.
3. **Voice variables:** `VOICE_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`,
   `ELEVENLABS_VOICE_ID` (a voice that works with Eleven v4 — voice clones
   made before v4 may need retraining for it). Optional:
   `ELEVENLABS_MODEL_ID` (default `eleven_v4`), `ELEVENLABS_OUTPUT_FORMAT`
   (default `mp3_44100_128`), `ELEVENLABS_USD_PER_1K_CHARS` (your plan's
   price).
4. Deploy, then check `/api/health`: `providers` lists `VOICE elevenlabs` and
   `STORAGE s3` with `mock: false`.
5. In the dashboard: approve a script version, open **Voice**, plan an
   audition of the opening (nothing is generated by planning: it shows the
   chunks, the exact text each would send, characters and estimated cost),
   then generate it.

The browser never sees a key or a bucket URL: audio is streamed by the API
(with byte ranges) behind the dashboard's authentication. Bucket storage is
$0.015 per GB-month; a 15-minute narration in MP3 is about 15 MB plus its
takes.

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
| A voice job stops with `HTTP 401` / `HTTP 402` / `HTTP 404` | Rejected key, no credits, or a voice/model the account cannot use. The takes not tried yet stay pending: fix the variable or the plan, then *Retry* the job. |
| A take fails with `HTTP 422` or `HTTP 400` | That chunk's request was refused (the error says why); the other takes went on. Regenerate the chunk. |
| A take is flagged `No timestamps came back` | The provider returned no alignment for it: it cannot be placed on the timeline. Regenerate it. |
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
