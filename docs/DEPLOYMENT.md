# Deployment — Railway

The app is one Docker image containing the API, the built dashboard and the
job worker. It needs one PostgreSQL database. With only that, every stage runs
in MOCK mode. Real research additionally needs an Anthropic API key and Tavily
access (see [Enabling real research](#enabling-real-research)).

## Services

Exactly two Railway services:

| Service | What | Required now |
|---|---|---|
| **app** (e.g. `vidgen`) | This whole repository as **one** service, built from the root `Dockerfile` | Yes |
| **Postgres** | Railway PostgreSQL (Database → PostgreSQL) | Yes |
| worker | Same image, start command `node apps/api/dist/worker.js` | No — only when generation load justifies it |
| Object storage | Cloudflare R2 (S3-compatible), outside Railway | No — arrives with real voice/visual providers |

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
   | `STORY_MAX_COST_USD` | optional, default `15` (per story-mining or architecture job) |

4. **Verify:** `/api/health` → `"realStages":["RESEARCH","STORY_MINING","STORY_ARCHITECTURE"]` and the providers
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
| `VOICE_PROVIDER` … `PUBLISHING_PROVIDER` (5) | `mock` | ✓ | Only `mock` is implemented; other values fail at startup with a clear message |
| `ANTHROPIC_API_KEY` | — | ✓ | Required when `AI_PROVIDER=anthropic` |
| `AI_MODEL` | `claude-opus-5-5` | ✓ | Model for every research task; cost is estimated from the served model's published token prices |
| `TAVILY_API_KEY` | — | ✓ | Required when `RESEARCH_PROVIDER=tavily`, unless keyless |
| `TAVILY_ACCESS_MODE` | `api-key` | ✓ | `keyless` = Tavily's free, rate-limited access ($0) |
| `TAVILY_USD_PER_CREDIT` | `0.008` | ✓ | Your plan's price; Tavily reports credits, so dollar cost is an estimate |
| `RESEARCH_MAX_COST_USD` | `40` | ✓ | Per-run ceiling; the run stops (FAILED, not retried) once recorded spend passes it |
| `RESEARCH_MAX_SOURCES` | `45` | ✓ | Sources whose full text is retrieved and read per run |
| `STORY_MAX_COST_USD` | `15` | ✓ | Per-job ceiling for story mining and story architecture; the job stops (FAILED, not retried) once recorded spend passes it |
| `WEB_DIST_DIR` | `apps/web/dist` | ✓ | Override only for unusual layouts |
| `RAILWAY_GIT_COMMIT_SHA` | — | ✓ | Set by Railway; shown in `/api/health` |
| `TEST_DATABASE_URL` | — | tests | Integration tests only; DB name must contain `test` |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_DEFAULT_VOICE_ID` | — | planned | Voice IDs are chosen per language version, not hard-coded |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` | — | planned | Exact credential format confirmed when integrated |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SIGNED_URL_TTL_SEC` | —, `auto`, …, `3600` | planned | Cloudflare R2 |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | — | planned | |

## Storage (planned): Cloudflare R2

When the S3 storage provider is implemented:

1. Cloudflare dashboard → R2 → create a bucket (e.g. `docengine-media`), keep
   it **private**.
2. R2 → *Manage API tokens* → create a token with *Object Read & Write* on that
   bucket. Note the access key id and secret.
3. Set on the Railway app service: `STORAGE_PROVIDER=s3`,
   `S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`,
   `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
4. The dashboard receives short-lived signed URLs only. If the dashboard must
   load media directly from R2, the CSP `media-src`/`img-src` will be widened
   to the R2 host at that point.

Railway volumes are not used for media: containers are replaced on every
deploy and media must survive that.

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
| Log says `VOICE_PROVIDER="elevenlabs" is planned but not implemented yet` | Remove the variable or set it to `mock`. |
| Research job fails with `ANTHROPIC_API_KEY is not set` / `TAVILY_API_KEY is not set` | Set the key on the service (or `TAVILY_ACCESS_MODE=keyless`). |
| Research job fails with `Research stopped: estimated spend … exceeds the per-run ceiling` | Intended stop. Raise `RESEARCH_MAX_COST_USD` if the spend is justified, then *Retry* (stored documents and readings are reused). |
| Research job fails with `Research quality gate failed: …` | The dossier was saved as DRAFT; open it (Research dossier → Quality gate tab) to see which checks failed. Rewind and run again, possibly with a research brief. |
| `/api/health` shows `"realStages":[]` although keys are set | Both `AI_PROVIDER=anthropic` and `RESEARCH_PROVIDER=tavily` are needed for the real research stage. |
| *Generate Story Architecture* answers "Select at least 5 story units" | Intended check before any paid work: select 5–10 candidates on the Story page (rejected ones never count). |
| Story job fails with `Story mining quality gate failed` / `Story architecture quality gate failed` | The gate's report is on the Story page (*Quality gates*); the pack or architecture is kept as a DRAFT. *Retry* re-evaluates without new model calls; for different material, rewind to *Research complete* (mining) or *Story selection* (architecture) and run again, with a brief. |
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
