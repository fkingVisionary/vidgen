# Documentary Engine

AI-assisted production system for premium historical & economic documentaries
(10–15 minutes, YouTube). Research → story → script → narration → storyboard →
visuals & infographics → edit → QA → render → publish, with a human approving
every important step.

**Current state: V1, milestone 3 + Story Engine 2.0 + the editorial revision
loop and alternative angles (deployed) + Script Engine 1.0 (built and tested;
acceptance run pending).** The
pipeline, database, job system, provider abstractions and dashboard are real
and tested (milestone 1). The **Research** stage is real when Anthropic
(Claude) and Tavily are configured: it builds a versioned dossier of claims
with verdicts and verbatim-verified citations, and stops for human review
(milestone 2). **Story mining** turns the approved dossier into a ranked pool
of evidence-backed story units, which the editor curates; **story
architecture** turns the editor's selection into a documentary blueprint
(premise, central question, spine, sequences), which a human approves
(milestone 3; real when Claude is configured). **Story Engine 2.0** makes that
blueprint cinematic inside the same evidence boundary — human stakes, narrative
modes, a point of view, beats labelled documented / reconstruction / uncertain
/ fiction, setting, visual thinking, continuity — and identifies content
opportunities (shorts and long-form threads) for the editor to approve one by
one; nothing is generated from them yet. The editor can **reconsider** an
architecture — say what is not working and the architect revises it into a new
version, every earlier version kept — and **explore alternative angles** (2–3
materially different approaches to the same units) before committing to one,
always from the same story pack and approved evidence. The **Script Engine**
turns the approved architecture into a structured spoken script — sections of
narration blocks, each with its information class, the claims behind it,
delivery, semantic pauses, emphasis, pronunciation notes and visual intent —
reviewed by a script editor and a fact checker and checked by deterministic
rules — including generic Script Quality Rules for the craft of a told story
(said once, facts that earn their place, pacing, speech rather than page,
no meta-narration, people and devices introduced plainly, what is said about
a person resting on a claim about them, deliberate repetition kept, where to
cut when it runs long); the editor edits, approves or rejects sections,
regenerates single sections, refines the narration and approves the whole
script; then narrates the approved script — in small chunks of natural
speech with ElevenLabs Eleven v4 (audio tags, never SSML), an opening
audition first, every take kept and reviewed on its own, numbers and names
given a checked spoken form, performance directions translated from the
script (restrained by default), timestamps mapped back to the script's words,
the takes assembled on the clock of the audio itself, and a human approval of
the whole narration. Every later stage (visuals, edit, publish) is still a
clearly labelled **MOCK**. First test episode: *Tulip Mania — The Bubble That
Became a Legend*.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, data model, providers, jobs, decisions
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Railway, environment variables, operations
- [docs/STATUS.md](docs/STATUS.md) — implemented vs mocked vs planned vs not built

## Stack

TypeScript (Node 22) · Fastify 5 · PostgreSQL 16 + Prisma 7 · React 19 + Vite 8
+ Tailwind 4 · zod · pino · Vitest · Docker · Railway · Anthropic (Claude) ·
Tavily (search + extraction) · ElevenLabs (voice, Eleven v4) · S3-compatible
storage (a Railway bucket). Planned: Higgsfield (video), FFmpeg + Remotion
(rendering), YouTube Data API.

## Repository

```
apps/api           Fastify API + dashboard host + embedded job worker (bundled with esbuild)
apps/web           Dashboard shell
packages/core      Domain: statuses, pipeline/state machine, contracts, cost math (browser-safe)
packages/database  Prisma schema, migrations, client
packages/providers Provider interfaces, MOCK implementations, registry, contract tests
packages/pipeline  Project state service, job queue & runner, stage handler contract
modules/research   The RESEARCH stage: plan → search → retrieve → read → synthesise → quality gate
modules/story      STORY_MINING (mine → evidence rules → critic → rank → proposed selection → gate)
                   and STORY_ARCHITECTURE (architect → evidence rules → reviewer → gate)
modules/script     SCRIPT (planner → writer → rules → script editor → fact checker → performance → gate)
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

## Story mining and architecture

With `AI_PROVIDER=anthropic`, once a research dossier is approved:

1. Project page or Story page → **Run Story Mining**. The pack lists 15–30
   ranked candidates with their human stakes, cold open (labelled by
   information class), story value and historical value (shown separately,
   with reasons), story appeal, historical status and evidence, plus
   candidates the evidence rules removed and why.
2. On the **Story** page, approve, reject or flag candidates, choose 5–10 for
   the documentary (the AI's proposal is preselected), set priorities, add
   notes, change a unit's title, narrative mode, central question or POV (the
   AI's values are kept), order the selection (▲▼ on the Selection tab) — or
   request another mining pass with a brief.
3. **Generate Story Architecture** (refused until 5–10 units are selected),
   optionally with preferences for the narrative mode, POV and central
   question.
4. Review it: logline, central question, cast (fictional devices are
   labelled), beats colour-coded by information class, presentation of
   uncertain material, setting, visual notes, continuity, the reconstruction
   level and the story editor's quality bar. **Approve Story Architecture**,
   **Reject → Rework** (back to the selection; the next version uses your
   notes) or **Flag**. Nothing moves on to the script automatically.
5. Not working yet? **Reconsider / Revise Architecture** (on the Story page,
   for the version shown): tick what is not working — angle, POV, emotional
   centre, opening, structure, pacing, narrative strategy, central question,
   human stakes — and write a brief. The architect may restructure
   substantially (reorder, merge, remove or replace sequences with units you
   approved, change the mode, POV, central question or opening) using only
   the story pack and the approved dossier, and must say what it changed and
   why. The Story Editor and the Fact Checker review the revision again. It
   becomes a new version; the one it revised is never changed. The
   Architecture tab shows every version, the brief, the architect's change
   log and the changes measured by code.
6. **Angles** tab → **Explore Alternative Angles** (during selection, review
   or after approval; the project's status does not change): 2–3 materially
   different approaches to the same units, each with its mode, POV, opening,
   human anchor, central question, movements, evidence, strengths and risks,
   and how they differ. **Develop this angle** builds an architecture on it
   (during selection) or revises the current version toward it.
7. On the **Opportunities** tab, approve or reject each short or long-form
   opportunity. `GET|POST /api/projects/:id/content-package` (e.g.
   `{"documentary": true, "shorts": 6, "languages": ["en","es","de"]}`)
   returns what a production request would use; it generates nothing.

`STORY_MAX_COST_USD=15` stops a mining, architecture, revision or angles job
whose recorded spend passes it. Like research, retries reuse completed model calls.

## Script

Once the story architecture is approved (Story Engine 2.0), the project's
**Script** page:

1. **Generate Script Draft** (optional instructions for the writer). Five
   model calls — planner, writer, script editor, fact checker, performance —
   then the deterministic quality gate, and the project stops in *Script
   review*. The script never reinterprets the research: every fact traces to
   a claim the approved architecture cites.
2. Read it as it will be heard: sections of narration blocks coloured by
   information class (documented, reconstruction, uncertain, fiction,
   framing), with the claims behind each block, pauses (‖), emphasis
   (underlined), pace / energy / emotion where they matter, duration and
   visual intent. The header shows the version, the architecture version,
   the runtime against the target with its variance, the word count, the
   gate and the cost.
3. **Edit** a block (text, class, delivery, pauses, emphasis, visual
   intent), reorder blocks (▲▼), **Approve section**, **Reject**, **Add
   note**. Each change re-runs the rules at once; the generated text is kept.
4. **Refine the narration…**: a new version whose writing is rewritten for
   the ear — meta-narration cut, strong lines kept, facts arriving through
   the story, uncertainty said naturally — with the story, structure,
   information classes and evidence unchanged. The house style is built in:
   nothing needs to be written. **Director's instructions** (optional) can
   steer tone, emphasis, pacing and creative direction for the film, never
   the facts, quotations or the line between fiction and history. The script
   editor answers a 13-question checklist against the version refined.
   **Regenerate section…** with a brief: a new version where only that
   section is rewritten (and reviewed); the others are copied unchanged, with
   no model calls. **Generate Revision** rewrites the whole script from a
   brief. **Versions** tab: every version, **compare** two (words, runtime,
   gate, cost, scores, words removed and added, evidence that moved, what
   changed and why, the checklist, the text), or make an earlier one current
   again.
5. **Approve Entire Script** — refused while the gate has blocking findings
   (fiction presented as documented fact, invented words for a real person,
   an unsupported figure, a myth told as fact, a missing sequence…) or a
   section is rejected. Nothing is voiced on the Script page: the
   **Pronunciation & voice** tab shows the pronunciation notes (every model
   pronunciation is flagged for a person to check).
6. **Voice** (once a version is approved; needs `VOICE_PROVIDER=elevenlabs`
   and a bucket for real audio — see DEPLOYMENT.md, otherwise every take is a
   labelled MOCK beep): **Plan** an opening audition (the chunks, the exact
   text each would send, characters, estimated cost, what it covers), then
   generate it. Each chunk: play, approve, reject, regenerate (optionally with
   your own directions), compare and restore earlier takes, see what was
   sent. Compare plain / restrained / over-directed, or three chunk sizes, on
   the same passage. Decide the pronunciation list, version the voice
   profile, ask "what is said at 02:43". The whole narration (a full run,
   every take approved, nothing blocking) is approved at the VOICE gate.

`SCRIPT_MAX_COST_USD=15` stops a script job whose recorded spend passes it;
`SCRIPT_MODELS` (optional) sets a model per step.

`GET /api/health` lists the stages that are real (`realStages`). Progress
appears in the project's Activity panel. (A full run with real Claude has not
been timed yet; expect tens of minutes — about 45 documents are read.) The
dossier opens at **Research dossier** on the project page: claims with
verdicts (ESTABLISHED / PROBABLE / DISPUTED / UNVERIFIED / MYTH), supporting
and contradicting citations with verified quotes, sources by type, open
questions, the quality gate and the run's cost. Approve, reject or flag it
there; nothing proceeds without a human decision.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Short version: a Railway
project with **two** services, PostgreSQL and **one** *Empty Service*
connected to this repository (not "+ New → GitHub Repository", which splits
the monorepo into one broken service per package). On the app service set the
pre-deploy command `sh scripts/release.sh`, healthcheck `/api/health`,
`DATABASE_URL=${{Postgres.DATABASE_URL}}` and `DASHBOARD_PASSWORD`; generate a
domain. Railway no longer reads `railway.json` for new services.
