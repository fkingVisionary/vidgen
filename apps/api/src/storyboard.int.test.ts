import { randomUUID } from 'node:crypto';
import type { HealthView, JobView, ProjectDetailView, StoryboardInputsView, StoryboardView, VisualCatalogView, VisualProductionView, VisualProfileHistoryView, VisualProfileLibraryView } from '@docengine/core';
import { ALL_MOCK, CATALOG_VERSION, createProviders, type ObjectGenerationRequest, type ObjectGenerationResult } from '@docengine/providers';
import { FakeStoryboardAI } from '@docengine/storyboard/testing';
import { seedFakeDossier } from '@docengine/story/testing';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { VISUAL_GENERATION_HELD, createContainer, type AppContainer } from './container.ts';
import { parseEnv } from './env.ts';

/**
 * The storyboard and visual profile routes on the production wiring, with
 * the scripted model and the MOCK voice: planning is confirmed by the
 * request and runs as a job, with the environment's step models, ceiling
 * and prices; edits, re-timing and restores make versions and race with
 * 409s; decisions on a whole-script version go through the STORYBOARD
 * gate (Reject means planning again); the generic job route sends
 * storyboards to their own routes; and visual generation stays held on
 * enqueue, on retry and in the worker while the storyboard is real (the
 * hard stop), whatever the status.
 */

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

afterEach(async () => {
  for (const { app, c } of open) {
    await app.close();
    await c.close();
  }
  open = [];
});

/** A logged line as JSON (loosely typed: it is checked field by field). */
type Line = Record<string, any>;

/** The production container with the scripted model (or every provider MOCK), and its log lines. */
async function start(o: { mock?: boolean; env?: Record<string, string>; ai?: FakeStoryboardAI } = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent', ...o.env });
  const ai = o.ai ?? new FakeStoryboardAI();
  const c = createContainer(env, logger, { db, ...(o.mock ? {} : { providers: { ...createProviders(ALL_MOCK), ai } }) });
  const app = await buildApp(c);
  open.push({ app, c });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { app, c, ai, lines, call };
}
type Started = Awaited<ReturnType<typeof start>>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project whose script is approved (synthetic dossier, scripted model). */
async function approvedScript(s: Started): Promise<string> {
  const { c, ai } = s;
  const p = await c.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, 'editor');
  await c.runner.drain();
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await c.projects.generateScript(p.id, {}, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  return p.id;
}

/** An opening audition narrated with the MOCK voice: the project is in VOICE_REVIEW. */
async function audition(s: Started, projectId: string) {
  const { run: number } = await s.c.voice.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
  await s.c.runner.drain();
  return db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
}

/** The narration's takes as a real provider would have made them (provider timings, stored audio that is not mock). */
async function realTakes(runId: string): Promise<void> {
  for (const g of await db.voiceGeneration.findMany({ where: { runId } })) {
    if (g.alignment) await db.voiceGeneration.update({ where: { id: g.id }, data: { alignment: { ...(g.alignment as object), source: 'PROVIDER' } } });
    if (g.audioAssetId) await db.mediaAsset.update({ where: { id: g.audioAssetId }, data: { isMock: false } });
  }
}

/** A preview planned through the API (v1), and the run it is timed on. */
async function preview(s: Started) {
  const projectId = await approvedScript(s);
  const run = await audition(s, projectId);
  const res = await s.call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 0, confirm: true });
  expect(res.statusCode).toBe(202);
  await s.c.runner.drain();
  const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId }, orderBy: { version: 'desc' } });
  return { projectId, run, v1 };
}

const shotsOf = (storyboardId: string) => db.shot.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' } });

/** The scripted model, recording the model each planning call asked for; `beatsOutputTokens` makes the beats call report that many output tokens. */
class AskingAI extends FakeStoryboardAI {
  asked: Record<string, string | null> = {};
  beatsOutputTokens: number | null = null;

  override async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    const r = await super.generateObject(req);
    if (!req.task.startsWith('storyboard.')) return r;
    this.asked[req.task] = req.model ?? null;
    if (this.beatsOutputTokens === null || req.task !== 'storyboard.beats') return r;
    return { ...r, meta: { ...r.meta, usage: r.meta.usage.map((u) => (u.unit === 'OUTPUT_TOKENS' ? { ...u, quantity: this.beatsOutputTokens! } : u)) } };
  }
}

describe('storyboard API (scripted model, MOCK voice)', () => {
  it('plans a preview of the narration once confirmed, as a job that leaves the project where it is; the generic job route points to it', async () => {
    const s = await start({ env: { STORYBOARD_MAX_COST_USD: '4' } });
    const { call, c } = s;
    expect((await call('GET', '/api/health')).json<HealthView>().realStages).toEqual(expect.arrayContaining(['VISUAL_PLAN', 'STORYBOARD_PREVIEW']));
    const projectId = await approvedScript(s);
    const run = await audition(s, projectId);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');

    // Nothing planned yet: the page, the project card and what a plan would use.
    const empty = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>();
    expect(empty).toMatchObject({ versions: [], storyboard: null, realStage: true, activeJob: null, editorial: { generate: { allowed: true } } });
    expect((await call('GET', `/api/projects/${projectId}`)).json<ProjectDetailView>().storyboard).toBeNull();
    const inputs = (await call('GET', `/api/projects/${projectId}/storyboard/inputs`)).json<StoryboardInputsView>();
    expect(inputs).toMatchObject({ kind: 'PREVIEW', blocked: null, planningCeilingUsd: 4, profile: { revision: 0, mode: 'DEFAULT' } });
    expect(inputs.runs.map((r) => r.id)).toEqual([run.id]);

    // A paid planning job needs the request's confirmation, valid ids and the selection revision the editor saw.
    const generate = (payload: unknown, project = projectId) => call('POST', `/api/projects/${project}/storyboard/generate`, payload);
    const missing = await generate({ narration: { runId: run.id }, selectionRevision: 0 });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'VALIDATION_ERROR', issues: [{ path: 'confirm', message: 'Planning a storyboard calls the model and is paid for: confirm it' }] });
    expect((await generate({ narration: { runId: run.id }, selectionRevision: 0, confirm: false })).statusCode).toBe(400);
    expect((await generate({ narration: { runId: 'run-3' }, selectionRevision: 0, confirm: true })).statusCode).toBe(400);
    expect((await generate({ narration: { runId: randomUUID() }, selectionRevision: 0, confirm: true })).statusCode).toBe(404);
    expect((await generate({ narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'no-such-project')).statusCode).toBe(404);
    const stale = await generate({ narration: { runId: run.id }, selectionRevision: 3, confirm: true });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toMatch(/visual profile or its overrides changed since this was requested \(revision 3, now 0\)/);

    // The generic job route sends a real storyboard to its route, and holds visual generation.
    for (const type of ['VISUAL_PLAN', 'STORYBOARD_PREVIEW']) {
      const res = await call('POST', `/api/projects/${projectId}/jobs`, { type });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CONFLICT', message: 'Use POST /api/projects/:id/storyboard/generate (the Storyboard page) to plan the storyboard' });
    }
    for (const type of ['VISUAL_GENERATION', 'INFOGRAPHIC']) expect((await call('POST', `/api/projects/${projectId}/jobs`, { type })).json()).toMatchObject({ error: 'CONFLICT', message: VISUAL_GENERATION_HELD });
    expect(await db.job.count({ where: { projectId, type: { in: ['VISUAL_PLAN', 'STORYBOARD_PREVIEW', 'VISUAL_GENERATION', 'INFOGRAPHIC'] } } })).toBe(0);

    // Confirmed: a preview (side job) on the run's latest assembly; a second request waits for it.
    const assets = await db.mediaAsset.count();
    const res = await generate({ narration: { runId: run.id }, selectionRevision: 0, confirm: true });
    expect(res.statusCode).toBe(202);
    const assembly = await db.voiceAssembly.findFirstOrThrow({ where: { runId: run.id }, orderBy: { version: 'desc' } });
    expect(res.json<{ job: JobView; kind: string; assemblyId: string }>()).toMatchObject({ job: { type: 'STORYBOARD_PREVIEW', status: 'QUEUED' }, kind: 'PREVIEW', assemblyId: assembly.id });
    const twice = await generate({ narration: { runId: run.id }, selectionRevision: 0, confirm: true });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().message).toMatch(/A storyboard job \(STORYBOARD_PREVIEW\) is already queued/);
    const queued = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>();
    expect(queued.activeJob).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED' });
    expect(queued.editorial.generate).toMatchObject({ allowed: false, reason: expect.stringMatching(/is running: wait for it to finish/) });
    await c.runner.drain();

    // v1: a preview in review; the project's status is unchanged; only the model was called, and nothing was stored.
    const view = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>();
    expect(view.versions).toEqual([expect.objectContaining({ version: 1, scope: 'PARTIAL', status: 'IN_REVIEW', origin: 'GENERATED' })]);
    expect(view.storyboard).toMatchObject({ version: 1, narration: { runId: run.id, assemblyId: assembly.id } });
    expect(view.storyboard!.shots.length).toBeGreaterThan(0);
    expect(view.activeJob).toBeNull();
    const detail = (await call('GET', `/api/projects/${projectId}`)).json<ProjectDetailView>();
    expect(detail.status).toBe('VOICE_REVIEW');
    expect(detail.storyboard).toMatchObject({ id: view.storyboard!.id, version: 1, scope: 'PARTIAL', status: 'IN_REVIEW', shotCount: view.storyboard!.shots.length });
    const job = await db.job.findFirstOrThrow({ where: { projectId, type: 'STORYBOARD_PREVIEW' } });
    expect(job.status).toBe('SUCCEEDED');
    expect(await db.providerCall.groupBy({ by: ['kind'], where: { jobId: job.id } })).toEqual([{ kind: 'AI' }]);
    expect(await db.mediaAsset.count()).toBe(assets);
    expect(s.lines.some((l) => l.jobId === job.id && typeof l.msg === 'string' && l.msg.startsWith('storyboard summary: v1 PARTIAL'))).toBe(true);

    // Versions by number; unknown ones and malformed queries.
    expect((await call('GET', `/api/projects/${projectId}/storyboard?v=1`)).json<StoryboardView>().storyboard!.version).toBe(1);
    expect((await call('GET', `/api/projects/${projectId}/storyboard?v=9`)).statusCode).toBe(404);
    expect((await call('GET', `/api/projects/${projectId}/storyboard?v=first`)).statusCode).toBe(400);
    expect((await call('GET', '/api/projects/no-such-project/storyboard')).statusCode).toBe(404);
    expect((await call('GET', '/api/projects/no-such-project/storyboard/inputs')).statusCode).toBe(404);
  });

  it('plans with the environment\'s settings: each step\'s model, the planning ceiling, and the prices the pages show frozen into the version', async () => {
    const ai = new AskingAI();
    const stock = JSON.stringify([{ provider: 'stock', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]);
    const s = await start({ ai, env: { STORYBOARD_MODELS: 'shots=acme-shots-model', STORYBOARD_MAX_COST_USD: '0.5', VISUAL_PRICE_OVERRIDES: stock } });
    const { call, c } = s;
    const projectId = await approvedScript(s);
    const run = await audition(s, projectId);
    const generate = () => call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 0, confirm: true });

    // A beats call reported at about $1 is within the default ceiling ($5) but not this one: the job stops before the shots are asked for, and nothing is saved.
    ai.beatsOutputTokens = 200_000;
    const stopped = (await generate()).json<{ job: JobView }>().job;
    await c.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: stopped.id } })).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/Storyboard planning stopped: estimated spend \$1\.\d\d exceeds the per-job ceiling of \$0\.5$/) });
    expect(ai.asked).toEqual({ 'storyboard.beats': null });
    expect(await db.storyboard.count({ where: { projectId } })).toBe(0);

    // Within it: the shots step asks for the model set for it, the beats step for the provider's default.
    ai.beatsOutputTokens = null;
    expect((await generate()).statusCode).toBe(202);
    await c.runner.drain();
    expect(ai.asked).toEqual({ 'storyboard.beats': null, 'storyboard.shots': 'acme-shots-model' });
    // The version's forecast is frozen from the catalog the pages price from (the environment's prices over the published ones): not stale at birth.
    const v1 = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>().storyboard!;
    expect(c.visualCatalog.version).not.toBe(CATALOG_VERSION);
    expect(v1.costs).toMatchObject({ catalogVersion: c.visualCatalog.version, pricingChanged: false });
    expect(v1.qa.live.map((f) => f.kind)).not.toContain('STALE_PRICING');
  });

  it('edits, decides, restores, re-times and re-plans through the API: each change a new version, races refused with the newest version number', async () => {
    const s = await start();
    const { call, c } = s;
    const { projectId, run, v1 } = await preview(s);
    const [a, b] = await shotsOf(v1.id);
    const calls = await db.providerCall.count({ where: { projectId } });

    // Shot decisions: the page of the shot's version comes back.
    const decided = await call('POST', `/api/shots/${a!.id}/decision`, { decision: 'APPROVED', note: 'Good (test).' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json<StoryboardView>().storyboard!.shots.find((x) => x.key === a!.shotKey)).toMatchObject({ review: 'APPROVED', decision: { decision: 'APPROVED', note: 'Good (test).' } });
    expect((await call('POST', `/api/shots/${b!.id}/decision`, { decision: 'MAYBE' })).statusCode).toBe(400);
    expect((await call('POST', `/api/shots/${randomUUID()}/decision`, { decision: 'APPROVED' })).statusCode).toBe(404);
    expect((await call('POST', '/api/shots/SH001/decision', { decision: 'APPROVED' })).statusCode).toBe(400);

    // An edit: v2, with the decision on the unchanged shot carried; v1 kept as it was.
    const edit = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/edits`, payload);
    const ops = [{ op: 'updateShot', shotKey: b!.shotKey, patch: { mood: 'Expectant (test).' } }];
    expect((await edit(v1.id, { expectedVersion: 1, ops: [] })).statusCode).toBe(400);
    expect((await edit(v1.id, { expectedVersion: 1, ops: [{ op: 'paint', shotKey: b!.shotKey }] })).statusCode).toBe(400);
    expect((await edit(randomUUID(), { expectedVersion: 1, ops })).statusCode).toBe(404);
    const unknownShot = await edit(v1.id, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: 'SH999', patch: { mood: 'Calm (test).' } }] });
    expect(unknownShot.statusCode).toBe(409);
    expect(unknownShot.json().message).toMatch(/There is no shot SH999 in this version/);
    const made = await edit(v1.id, { expectedVersion: 1, ops, note: 'Calmer (test).' });
    expect(made.statusCode).toBe(201);
    const v2 = made.json<StoryboardView>().storyboard!;
    expect(v2).toMatchObject({ version: 2, status: 'IN_REVIEW', origin: 'EDIT', baseVersion: 1 });
    expect(v2.shots.find((x) => x.key === a!.shotKey)!.decision).toMatchObject({ decision: 'APPROVED', carriedFromVersion: 1 });
    expect(v2.shots.find((x) => x.key === b!.shotKey)!.review).toBe('PENDING');
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('SUPERSEDED');

    // The same edit from v1 again: the newest version is named so the page can offer to save over it.
    const race = await edit(v1.id, { expectedVersion: 1, ops });
    expect(race.statusCode).toBe(409);
    expect(race.json()).toMatchObject({ error: 'CONFLICT', latestVersion: 2, message: expect.stringMatching(/v2 is the newest version \(you were working from v1\)/) });

    // Version decisions: approval needs approved, real narration; Request changes is recorded; a stale page is refused.
    const decide = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/decision`, payload);
    const refused = await decide(v2.id, { decision: 'APPROVED', expectedVersion: 2 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/Storyboard v2 cannot be approved yet: .*the narration it is timed against is not approved/);
    expect((await decide(v2.id, { decision: 'MAYBE', expectedVersion: 2 })).statusCode).toBe(400);
    expect((await decide(v2.id, { decision: 'CHANGES_REQUESTED', expectedVersion: 1 })).json()).toMatchObject({ error: 'CONFLICT', latestVersion: 2 });
    expect((await decide(randomUUID(), { decision: 'CHANGES_REQUESTED', expectedVersion: 2 })).statusCode).toBe(404);
    const changes = await decide(v2.id, { decision: 'CHANGES_REQUESTED', note: 'Calmer still (test).', expectedVersion: 2 });
    expect(changes.statusCode).toBe(200);
    expect(changes.json<StoryboardView>().storyboard).toMatchObject({ version: 2, status: 'CHANGES_REQUESTED', decisions: [expect.objectContaining({ decision: 'CHANGES_REQUESTED', note: 'Calmer still (test).' })] });

    // A restore copies v1 back as v3; the newest version cannot be restored onto itself.
    const restore = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/restore`, payload);
    expect((await restore(v1.id, {})).statusCode).toBe(400);
    expect((await restore(randomUUID(), { expectedVersion: 2 })).statusCode).toBe(404);
    expect((await restore(v1.id, { expectedVersion: 1 })).json()).toMatchObject({ latestVersion: 2 });
    const restored = await restore(v1.id, { expectedVersion: 2 });
    expect(restored.statusCode).toBe(201);
    const v3 = restored.json<StoryboardView>().storyboard!;
    expect(v3).toMatchObject({ version: 3, origin: 'RESTORE', baseVersion: 1, status: 'IN_REVIEW' });
    expect((await restore(v3.id, { expectedVersion: 3 })).json().message).toMatch(/v3 is already the newest version/);

    // Re-timing: onto the same assembly is refused; onto an unknown one, not found.
    const retime = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/retime`, payload);
    const assembly = await db.voiceAssembly.findFirstOrThrow({ where: { runId: run.id }, orderBy: { version: 'desc' } });
    expect((await retime(v3.id, { assemblyId: 'v1', expectedVersion: 3 })).statusCode).toBe(400);
    expect((await retime(v3.id, { assemblyId: randomUUID(), expectedVersion: 3 })).statusCode).toBe(404);
    expect((await retime(v3.id, { assemblyId: assembly.id, expectedVersion: 3 })).json()).toMatchObject({ error: 'CONFLICT', message: 'v3 is already timed on assembly v1' });
    // None of this called the model.
    expect(await db.providerCall.count({ where: { projectId } })).toBe(calls);

    // Re-plans are paid jobs: confirmed, from the newest version, of beats it has.
    const beat = v3.beats[0]!.key;
    const beats = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/regenerate-beats`, payload);
    expect((await beats(v3.id, { beatKeys: [beat], expectedVersion: 3 })).statusCode).toBe(400);
    expect((await beats(v3.id, { beatKeys: ['beat one'], expectedVersion: 3, confirm: true })).statusCode).toBe(400);
    expect((await beats(v3.id, { beatKeys: ['VB99'], expectedVersion: 3, confirm: true })).json().message).toBe('Storyboard v3 has no beat VB99');
    expect((await beats(randomUUID(), { beatKeys: [beat], expectedVersion: 3, confirm: true })).statusCode).toBe(404);
    expect((await beats(v3.id, { beatKeys: [beat], expectedVersion: 2, confirm: true })).json()).toMatchObject({ error: 'CONFLICT', latestVersion: 3 });
    const replan = await beats(v3.id, { beatKeys: [beat], instructions: 'Open on the empty quay (test).', expectedVersion: 3, confirm: true });
    expect(replan.statusCode).toBe(202);
    expect(replan.json<{ job: JobView }>().job).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED' });
    // While it runs, the storyboard is not changed by hand.
    const busy = await edit(v3.id, { expectedVersion: 3, ops: [{ op: 'clearRecommendation', shotKey: a!.shotKey }] });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().message).toMatch(/A storyboard job \(STORYBOARD_PREVIEW\) is queued: wait for it to finish/);
    await c.runner.drain();
    const v4 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 4 } });
    expect(v4).toMatchObject({ scope: 'PARTIAL', status: 'IN_REVIEW' });

    const approach = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/approach`, payload);
    expect((await approach(v4.id, { approach: 'D', expectedVersion: 4, confirm: true })).statusCode).toBe(400);
    expect((await approach(v4.id, { approach: 'B', expectedVersion: 4 })).statusCode).toBe(400);
    expect((await approach(v3.id, { approach: 'B', expectedVersion: 3, confirm: true })).json()).toMatchObject({ error: 'CONFLICT', latestVersion: 4 });
    expect((await approach(randomUUID(), { approach: 'B', expectedVersion: 4, confirm: true })).statusCode).toBe(404);
    const switched = await approach(v4.id, { approach: 'B', expectedVersion: 4, confirm: true });
    expect(switched.statusCode).toBe(202);
    expect(switched.json<{ job: JobView }>().job).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED' });
    await c.runner.drain();
    expect((await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>().versions.map((v) => [v.version, v.origin])).toEqual([
      [5, 'APPROACH'],
      [4, 'BEATS'],
      [3, 'RESTORE'],
      [2, 'EDIT'],
      [1, 'GENERATED'],
    ]);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');

    // A shot of a version no longer under review is not decided.
    const old = await call('POST', `/api/shots/${b!.id}/decision`, { decision: 'REJECTED' });
    expect(old.statusCode).toBe(409);
    expect(old.json().message).toMatch(/Storyboard v1 is superseded: its shots are decided only while it is under review/);

    // A take regenerated: the run's assembly v2. Re-timing the newest version onto it is a new version, with no model call.
    const chunk = await db.voiceChunk.findFirstOrThrow({ where: { runId: run.id }, orderBy: { chunkIndex: 'asc' } });
    await c.voice.regenerate(run.id, { chunkIds: [chunk.id] }, 'editor');
    await c.runner.drain();
    const assembly2 = await db.voiceAssembly.findFirstOrThrow({ where: { runId: run.id }, orderBy: { version: 'desc' } });
    expect(assembly2.version).toBe(2);
    const v5 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 5 } });
    const before = await db.providerCall.count({ where: { projectId, kind: 'AI' } });
    const retimed = await retime(v5.id, { assemblyId: assembly2.id, expectedVersion: 5 });
    expect(retimed.statusCode).toBe(201);
    expect(retimed.json<StoryboardView>().storyboard).toMatchObject({ version: 6, origin: 'RETIME', baseVersion: 5, narration: { assemblyId: assembly2.id, assemblyVersion: 2 } });
    expect(await db.providerCall.count({ where: { projectId, kind: 'AI' } })).toBe(before);
  });

  it('decides a whole-script version at the STORYBOARD gate, which enqueues nothing; visual generation stays held on enqueue, on retry and in the worker', async () => {
    const s = await start();
    const { call, c } = s;
    const projectId = await approvedScript(s);
    await c.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await c.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await c.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await c.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await c.voice.approveAll(run.id, 'editor');
    await c.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');

    // The narration the VOICE gate approved: the phase job.
    expect((await call('GET', `/api/projects/${projectId}/storyboard/inputs`)).json<StoryboardInputsView>().kind).toBe('PHASE');
    const res = await call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 0, confirm: true });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ job: { type: 'VISUAL_PLAN' }, kind: 'PHASE' });
    await c.runner.drain();
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    expect(v1).toMatchObject({ scope: 'FULL', status: 'IN_REVIEW' });
    await realTakes(run.id);

    // At the gate the reviewer names the version under review; the version's own decision route goes through the gate.
    const wrong = await call('POST', `/api/projects/${projectId}/approvals`, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: run.id });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().message).toMatch(/is not the one under review \(v1\)/);
    expect((await call('POST', `/api/projects/${projectId}/approvals`, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: 'v1' })).statusCode).toBe(400);
    const jobs = await db.job.count({ where: { projectId } });
    const approved = await call('POST', `/api/storyboards/${v1.id}/decision`, { decision: 'APPROVED', note: 'Reads well (test).', expectedVersion: 1 });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<StoryboardView>()).toMatchObject({ project: { status: 'STORYBOARD_APPROVED' }, storyboard: { version: 1, status: 'APPROVED' } });
    expect(await db.approval.findFirstOrThrow({ where: { projectId, gate: 'STORYBOARD' } })).toMatchObject({ decision: 'APPROVED', storyboardId: v1.id, languageVersionId: v1.languageVersionId, notes: 'Reads well (test).' });
    expect(await db.job.count({ where: { projectId } })).toBe(jobs);
    const detail = (await call('GET', `/api/projects/${projectId}`)).json<ProjectDetailView>();
    expect(detail).toMatchObject({ status: 'STORYBOARD_APPROVED', storyboard: { version: 1, scope: 'FULL', status: 'APPROVED' } });

    // The hard stop: from the milestone, the next phase is never entered — not by enqueue, not by a retry, not in the worker.
    for (const type of ['VISUAL_GENERATION', 'INFOGRAPHIC']) {
      const held = await call('POST', `/api/projects/${projectId}/jobs`, { type });
      expect(held.statusCode).toBe(409);
      expect(held.json()).toMatchObject({ error: 'CONFLICT', message: 'Visual generation is the next milestone; it starts only after the storyboard is reviewed and accepted' });
    }
    expect((await call('POST', `/api/projects/${projectId}/jobs`, { type: 'VISUAL_PLAN' })).json().message).toMatch(/storyboard\/generate/);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const lv = await db.languageVersion.findFirstOrThrow({ where: { projectId } });
    // Jobs left from before this release (as production may hold): failed or cancelled ones are not retried…
    const oldJob = (type: 'VISUAL_GENERATION' | 'INFOGRAPHIC', status: 'FAILED' | 'CANCELLED' | 'QUEUED') =>
      db.job.create({ data: { projectId, languageVersionId: lv.id, type, status, phaseSeq: project.phaseSeq - 1, input: {}, maxAttempts: 3 } });
    for (const old of [await oldJob('VISUAL_GENERATION', 'FAILED'), await oldJob('INFOGRAPHIC', 'CANCELLED')]) {
      const retry = await call('POST', `/api/jobs/${old.id}/retry`);
      expect(retry.statusCode).toBe(409);
      expect(retry.json().message).toBe(VISUAL_GENERATION_HELD);
      expect(await db.job.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: old.status, attempts: 0 });
    }
    expect((await call('POST', `/api/jobs/${randomUUID()}/retry`)).statusCode).toBe(404);
    // …and a queued one fails in the worker without calling a provider or storing anything.
    const calls = await db.providerCall.count();
    const assets = await db.mediaAsset.count();
    const queued = [await oldJob('VISUAL_GENERATION', 'QUEUED'), await oldJob('INFOGRAPHIC', 'QUEUED')];
    await c.runner.drain();
    for (const q of queued) expect(await db.job.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'FAILED', attempts: 1, error: `NonRetryableError: ${VISUAL_GENERATION_HELD}` });
    expect(await db.providerCall.count()).toBe(calls);
    expect(await db.mediaAsset.count()).toBe(assets);
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: 'STORYBOARD_APPROVED' });

    // An edit of the approved storyboard re-opens the gate (v1 stays approved until v2 is).
    const first = (await shotsOf(v1.id))[0]!;
    const edited = await call('POST', `/api/storyboards/${v1.id}/edits`, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: first.shotKey, patch: { lighting: 'Grey morning light (test).' } }] });
    expect(edited.statusCode).toBe(201);
    expect(edited.json<StoryboardView>()).toMatchObject({ project: { status: 'STORYBOARD_REVIEW' }, storyboard: { version: 2, status: 'IN_REVIEW' } });
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('APPROVED');
    // Request changes at the gate keeps it open for the next edit.
    const v2 = edited.json<StoryboardView>().storyboard!;
    const flagged = await call('POST', `/api/storyboards/${v2.id}/decision`, { decision: 'CHANGES_REQUESTED', note: 'Warmer (test).', expectedVersion: 2 });
    expect(flagged.json<StoryboardView>()).toMatchObject({ project: { status: 'STORYBOARD_REVIEW' }, storyboard: { version: 2, status: 'CHANGES_REQUESTED' } });
    expect(await db.approval.findFirstOrThrow({ where: { projectId, gate: 'STORYBOARD' }, orderBy: { createdAt: 'desc' } })).toMatchObject({ decision: 'FLAGGED', storyboardId: v2.id });

    // Reject at the gate means re-plan: the project goes back to planning with nothing queued, and the editor asks for the plan again (the phase job).
    const before = await db.job.count({ where: { projectId } });
    const rejected = await call('POST', `/api/storyboards/${v2.id}/decision`, { decision: 'REJECTED', note: 'Plan it again (test).', expectedVersion: 2 });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<StoryboardView>()).toMatchObject({ project: { status: 'VISUAL_PLANNING' }, storyboard: { version: 2, status: 'REJECTED' } });
    expect(await db.approval.findFirstOrThrow({ where: { projectId, gate: 'STORYBOARD' }, orderBy: { createdAt: 'desc' } })).toMatchObject({ decision: 'REJECTED', storyboardId: v2.id, languageVersionId: v1.languageVersionId });
    expect(await db.job.count({ where: { projectId } })).toBe(before);
    expect((await call('POST', `/api/projects/${projectId}/jobs`, { type: 'VISUAL_PLAN' })).statusCode).toBe(409);
    const replanned = await call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 0, confirm: true });
    expect(replanned.json()).toMatchObject({ job: { type: 'VISUAL_PLAN', status: 'QUEUED' }, kind: 'PHASE' });
    await c.runner.drain();
    expect((await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>()).toMatchObject({ project: { status: 'STORYBOARD_REVIEW' }, storyboard: { version: 3, scope: 'FULL', status: 'IN_REVIEW' } });
  });

  it('holds visual generation in every status once the storyboard is real; with the model MOCK, the placeholder pipeline walks through generation and planning says it cannot', async () => {
    const real = await start();
    const p = (await real.call('POST', '/api/projects', tulipInput)).json<ProjectDetailView>();
    expect(p.status).toBe('IDEA');
    for (const type of ['VISUAL_GENERATION', 'INFOGRAPHIC']) expect((await real.call('POST', `/api/projects/${p.id}/jobs`, { type })).json()).toMatchObject({ error: 'CONFLICT', message: VISUAL_GENERATION_HELD });

    const mock = await start({ mock: true });
    expect(mock.c.realStages).toEqual([]);
    const m = (await mock.call('POST', '/api/projects', { ...tulipInput, title: 'Mock walk', workingTitle: 'Mock walk' })).json<ProjectDetailView>();
    // The STORYBOARD gate hook has nothing of the storyboard's to check without a script: the placeholder walk reaches the milestone.
    for (let step = 0; step < 30; step++) {
      const d = (await mock.call('GET', `/api/projects/${m.id}`)).json<ProjectDetailView>();
      if (d.status === 'STORYBOARD_APPROVED') break;
      if (d.actions.canApprove) {
        expect((await mock.call('POST', `/api/projects/${m.id}/approvals`, { gate: d.actions.gate!.gate, decision: 'APPROVED' })).statusCode).toBe(201);
        continue;
      }
      const type = d.actions.runnableJobs.find((t) => t !== 'STORY_ANGLES' && t !== 'STORYBOARD_PREVIEW')!;
      expect((await mock.call('POST', `/api/projects/${m.id}/jobs`, { type })).statusCode).toBe(202);
      await mock.c.runner.drain();
    }
    expect((await mock.call('GET', `/api/projects/${m.id}`)).json<ProjectDetailView>()).toMatchObject({ status: 'STORYBOARD_APPROVED', storyboard: null });
    const generating = await mock.call('POST', `/api/projects/${m.id}/jobs`, { type: 'VISUAL_GENERATION' });
    expect(generating.statusCode).toBe(202);
    await mock.c.runner.drain();
    expect((await mock.call('GET', `/api/projects/${m.id}`)).json<ProjectDetailView>().jobs[0]).toMatchObject({ type: 'VISUAL_GENERATION', status: 'SUCCEEDED', isMock: true });

    // Planning needs the model: the request is refused, and the page says why.
    const run = await mock.call('POST', `/api/projects/${m.id}/storyboard/generate`, { narration: { runId: randomUUID() }, selectionRevision: 0, confirm: true });
    expect(run.statusCode).toBe(409);
    expect(run.json().message).toMatch(/planned by the model, which is not configured here \(MOCK\)/);
    expect((await mock.call('GET', `/api/projects/${m.id}/storyboard`)).json<StoryboardView>()).toMatchObject({ realStage: false, editorial: { generate: { allowed: false } } });
  });
});

describe('visual profile and catalog API', () => {
  it('serves the library with its presets, saves profiles as versions, and records a project\'s choice with a revision', async () => {
    const s = await start();
    const { call } = s;
    const library = (await call('GET', '/api/visual/profiles')).json<VisualProfileLibraryView>();
    expect(library.families.map((f) => f.name).sort()).toEqual(['Cinematic History', 'Clean Business Explainer', 'Corporate Investigative', 'Dark True Crime', 'Retro Documentary']);
    expect(library.families.filter((f) => f.isDefault).map((f) => f.preset)).toEqual(['cinematic-history']);
    expect(library.families.every((f) => Object.keys(f.current!.config.providerPreferences).length === 0)).toBe(true);
    expect((await call('GET', '/api/visual/profiles?archived=maybe')).statusCode).toBe(400);

    // A new profile and its versions.
    expect((await call('POST', '/api/visual/profiles', { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/api/visual/profiles', { name: 'House look', config: { density: 'NOISY' } })).statusCode).toBe(400);
    const created = await call('POST', '/api/visual/profiles', { name: 'House look', config: { density: 'SPARSE' }, notes: 'First cut (test).' });
    expect(created.statusCode).toBe(201);
    const house = created.json<VisualProfileHistoryView>();
    expect(house).toMatchObject({ name: 'House look', versions: 1, current: { version: 1, config: { density: 'SPARSE' } } });
    expect((await call('POST', '/api/visual/profiles', { name: 'house LOOK' })).statusCode).toBe(409);
    expect((await call('GET', `/api/visual/profiles/${house.id}`)).json<VisualProfileHistoryView>().history).toHaveLength(1);
    expect((await call('GET', `/api/visual/profiles/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/visual/profiles/house-look')).statusCode).toBe(400);

    const v2 = await call('POST', `/api/visual/profiles/${house.id}/versions`, { expectedCurrent: house.current!.id, config: { density: 'DENSE' } });
    expect(v2.statusCode).toBe(201);
    expect(v2.json<VisualProfileHistoryView>()).toMatchObject({ versions: 2, current: { version: 2, changes: [expect.stringMatching(/density/i)] } });
    expect((await call('POST', `/api/visual/profiles/${house.id}/versions`, { expectedCurrent: house.current!.id, config: { density: 'SPARSE' } })).statusCode).toBe(409);

    const renamed = await call('PATCH', `/api/visual/profiles/${house.id}`, { name: 'House look (2026)' });
    expect(renamed.json<VisualProfileHistoryView>()).toMatchObject({ name: 'House look (2026)', versions: 2 });
    expect((await call('PATCH', `/api/visual/profiles/${house.id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', `/api/visual/profiles/${randomUUID()}`, { name: 'Nobody' })).statusCode).toBe(404);
    expect((await call('POST', `/api/visual/profiles/${house.id}/versions`, { config: { lenses: 'wide' } })).statusCode).toBe(400);
    expect((await call('POST', `/api/visual/profiles/${randomUUID()}/versions`, { config: { density: 'SPARSE' } })).statusCode).toBe(404);
    expect((await call('POST', `/api/visual/profiles/${randomUUID()}/duplicate`, { name: 'Orphan' })).statusCode).toBe(404);
    const copy = await call('POST', `/api/visual/profiles/${house.id}/duplicate`, { name: 'Night look', fromVersionId: house.current!.id });
    expect(copy.statusCode).toBe(201);
    expect(copy.json<VisualProfileHistoryView>()).toMatchObject({ name: 'Night look', versions: 1, current: { config: { density: 'SPARSE' } } });

    // A project's choice: revision 0 until chosen; a choice made elsewhere since is refused.
    const p = (await call('POST', '/api/projects', tulipInput)).json<ProjectDetailView>();
    expect((await call('GET', `/api/projects/${p.slug}/visual/selection`)).json<VisualProductionView>()).toMatchObject({ revision: 0, mode: 'DEFAULT', family: { name: 'Cinematic History' } });
    const chosen = await call('PUT', `/api/projects/${p.id}/visual/selection`, { familyId: house.id, overrides: { approach: 'B' }, revision: 0 });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json<VisualProductionView>()).toMatchObject({ revision: 1, mode: 'FOLLOW', family: { id: house.id }, profile: { version: 2 }, overrides: { approach: 'B' }, effective: { approach: 'B', density: 'DENSE' } });
    const again = await call('PUT', `/api/projects/${p.id}/visual/selection`, { familyId: null, revision: 0 });
    expect(again.statusCode).toBe(409);
    expect((await call('PUT', `/api/projects/${p.id}/visual/selection`, { familyId: null, versionId: house.current!.id, revision: 1 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/projects/no-such-project/visual/selection', { familyId: null, revision: 0 })).statusCode).toBe(404);
    expect((await call('GET', '/api/projects/no-such-project/visual/selection')).statusCode).toBe(404);
    expect((await call('PUT', `/api/projects/${p.id}/visual/selection`, { familyId: randomUUID(), revision: 1 })).statusCode).toBe(404);
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'VISUAL_PROFILE_SELECTED' } })).toBe(1);

    // Library operations write no project event: they are logged.
    expect(s.lines.filter((l) => /^visual profile /.test(l.msg)).map((l) => l.msg)).toEqual(['visual profile created', 'visual profile version saved', 'visual profile updated', 'visual profile duplicated', 'visual profile selected']);
  });

  it('serves the forecast catalog, with the user\'s prices from the environment over the published ones', async () => {
    const plain = (await (await start()).call('GET', '/api/visual/catalog')).json<VisualCatalogView>();
    expect(plain.version).toBe(CATALOG_VERSION);
    expect(plain.bases).not.toContain('VENDOR_REPORTED');
    expect(plain.cards.find((c) => c.provider === 'stock')).toMatchObject({ rates: [] });

    const env = {
      VISUAL_PRICE_OVERRIDES: JSON.stringify([{ provider: 'stock', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]),
      ARCHIVAL_USD_PER_ITEM: '25@2026-10-07',
    };
    const s = await start({ env });
    const catalog = (await s.call('GET', '/api/visual/catalog')).json<VisualCatalogView>();
    expect(catalog.version).toMatch(new RegExp(`^${CATALOG_VERSION.replace(/\./g, '\\.')}\\+[0-9a-f]{8}$`));
    expect(catalog.cards.find((c) => c.provider === 'stock')).toMatchObject({ pricing: { confidence: 'PLAN_PRICE', checkedAt: '2026-10-07' }, rates: [{ unit: 'REQUESTS', usdPerUnit: 12, source: expect.stringContaining('VISUAL_PRICE_OVERRIDES') }] });
    const archival = catalog.cards.find((c) => c.provider === 'archival')!;
    expect(archival.pricing).toMatchObject({ confidence: 'ASSUMPTION', checkedAt: '2026-10-07' });
    expect(archival.rates.length).toBeGreaterThan(0);
    expect(archival.rates.every((r) => r.usdPerUnit === 25 && r.source.startsWith('ARCHIVAL_USD_PER_ITEM'))).toBe(true);
    // The same catalog prices the planning stage, the gate and the pages.
    expect(s.c.visualCatalog.version).toBe(catalog.version);
  });
});
