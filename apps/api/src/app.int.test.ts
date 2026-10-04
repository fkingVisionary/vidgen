import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView, JobView, ProjectDetailView, ProjectSummaryView } from '@docengine/core';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { createContainer, type AppContainer } from './container.ts';
import { DEMO_PROJECT_SLUG, seedDemoProject } from './demo.ts';
import { parseEnv } from './env.ts';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { FAKE_CORPUS_GATE, FakeResearchAI, FakeResearchProvider } from '@docengine/research/testing';
import { FakeStoryAI, seedFakeDossier } from '@docengine/story/testing';
import type { ResearchView, StoryView } from '@docengine/core';

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

async function start(extraEnv: Record<string, string> = {}, opts: { fakeResearch?: boolean; fakeStory?: boolean } = {}) {
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_DIST_DIR: '/nonexistent', ...extraEnv });
  const c = createContainer(env, pino({ level: 'silent' }), {
    db,
    ...(opts.fakeResearch
      ? {
          providers: { ...createProviders(ALL_MOCK), ai: new FakeResearchAI(), research: new FakeResearchProvider() },
          researchConfig: { gate: FAKE_CORPUS_GATE },
        }
      : {}),
    ...(opts.fakeStory ? { providers: { ...createProviders(ALL_MOCK), ai: new FakeStoryAI() } } : {}),
  });
  const app = await buildApp(c);
  open.push({ app, c });
  return { app, c };
}

afterEach(async () => {
  for (const { app, c } of open) {
    await app.close();
    await c.close();
  }
  open = [];
});

describe('HTTP API', () => {
  it('reports health without authentication and flags mock mode', async () => {
    const { app } = await start({ DASHBOARD_PASSWORD: 'a-long-enough-secret' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthView>();
    expect(body).toMatchObject({ status: 'ok', database: 'ok', mockMode: true, worker: 'disabled' });
    expect(body.providers).toHaveLength(7);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('requires basic auth on everything else when a password is configured', async () => {
    const { app } = await start({ DASHBOARD_PASSWORD: 'a-long-enough-secret' });
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    const wrong = Buffer.from('admin:wrong-password').toString('base64');
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Basic ${wrong}` } })).statusCode).toBe(401);
    const right = Buffer.from('admin:a-long-enough-secret').toString('base64');
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Basic ${right}` } })).statusCode).toBe(200);
  });

  it('validates input and maps errors to 400 / 404 / 409', async () => {
    const { app } = await start();
    const bad = await app.inject({ method: 'POST', url: '/api/projects', payload: { title: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(bad.json().issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['title', 'topic']));

    expect((await app.inject({ method: 'GET', url: '/api/projects/does-not-exist' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/nothing-here' })).json()).toMatchObject({ error: 'NOT_FOUND' });

    const created = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    const conflict = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/jobs`, payload: { type: 'SCRIPT' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().message).toMatch(/SCRIPT jobs run in SCRIPT_DRAFT/);
  });

  it('creates a project, runs a MOCK job and records an approval through the API', async () => {
    const { app, c } = await start();
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput });
    expect(res.statusCode).toBe(201);
    const project = res.json<ProjectDetailView>();
    expect(project).toMatchObject({ slug: 'tulip-mania', status: 'IDEA', progress: 0 });
    expect(project.stages.map((s) => s.stage)).toEqual(['RESEARCH', 'STORY', 'SCRIPT', 'VOICE', 'STORYBOARD', 'ASSETS', 'TIMELINE', 'QA', 'FINAL']);
    expect(project.actions).toMatchObject({ runnableJobs: ['RESEARCH'], startsPhase: 'RESEARCHING', canApprove: false });
    expect(project.languageVersions).toEqual([expect.objectContaining({ language: 'en', isMaster: true })]);

    const enqueued = await app.inject({ method: 'POST', url: `/api/projects/${project.slug}/jobs`, payload: { type: 'RESEARCH' } });
    expect(enqueued.statusCode).toBe(202);
    expect(enqueued.json<JobView>()).toMatchObject({ type: 'RESEARCH', status: 'QUEUED' });

    await c.runner.drain();

    const afterJob = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json<ProjectDetailView>();
    expect(afterJob.status).toBe('RESEARCH_REVIEW');
    expect(afterJob.stages[0]).toEqual({ stage: 'RESEARCH', state: 'AWAITING_APPROVAL' });
    expect(afterJob.actions).toMatchObject({ canApprove: true, gate: { gate: 'RESEARCH' } });
    expect(afterJob.jobs[0]).toMatchObject({ status: 'SUCCEEDED', isMock: true, result: { mock: true, label: 'MOCK' } });
    expect(afterJob.costs).toMatchObject({ planningEstimateUsd: null, totalUsd: 0, includesEstimates: false, providerCalls: 1, mockCalls: 1, unpricedCalls: 0 });
    expect(afterJob.costs.byProvider).toEqual([{ provider: 'mock', calls: 1, totalUsd: 0, costBases: ['MOCK'] }]);
    expect(afterJob.research).toBeNull(); // the MOCK research placeholder writes no dossier
    expect(afterJob.events.map((e) => e.type)).toEqual(expect.arrayContaining(['PROJECT_CREATED', 'JOB_QUEUED', 'JOB_SUCCEEDED', 'STATUS_CHANGED']));

    const approved = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/approvals`,
      payload: { gate: 'RESEARCH', decision: 'APPROVED', notes: 'Mock only — fine for plumbing test' },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json<ProjectDetailView>()).toMatchObject({ status: 'RESEARCH_COMPLETE', approvals: [expect.objectContaining({ gate: 'RESEARCH', decision: 'APPROVED' })] });

    const retry = await app.inject({ method: 'POST', url: `/api/jobs/${afterJob.jobs[0]!.id}/retry` });
    expect(retry.statusCode).toBe(409);

    const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json<ProjectSummaryView[]>();
    expect(list).toHaveLength(1);
    expect(list[0]!.progress).toBeGreaterThan(0);
  });

  it('rewinds through the API', async () => {
    const { app } = await start();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'RESEARCH' } });
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/rewind`, payload: { to: 'IDEA', reason: 'Reframe the topic' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectDetailView>()).toMatchObject({ status: 'IDEA', jobs: [expect.objectContaining({ status: 'CANCELLED' })] });
  });

  it('serves the dashboard shell for client-side routes but JSON 404s for unknown API routes', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Documentary Engine</title>');
    const { app } = await start({ WEB_DIST_DIR: webDir });
    const page = await app.inject({ method: 'GET', url: '/projects/tulip-mania' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Documentary Engine');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await app.inject({ method: 'GET', url: '/api/unknown' })).statusCode).toBe(404);
  });
});

describe('research dossier API', () => {
  it('serves the dossier with claims, citations, sources, quality report and cost, and links the approval', async () => {
    const { app, c } = await start({}, { fakeResearch: true });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json<HealthView>().realStages).toEqual(['RESEARCH', 'STORY_MINING', 'STORY_ARCHITECTURE']);
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/research` })).json<ResearchView>()).toEqual({ versions: [], dossier: null });

    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'RESEARCH' } });
    await c.runner.drain();

    const view = (await app.inject({ method: 'GET', url: `/api/projects/${p.slug}/research` })).json<ResearchView>();
    expect(view.versions).toEqual([expect.objectContaining({ version: 1, status: 'IN_REVIEW', qualityPassed: true, claimCount: 14 })]);
    const d = view.dossier!;
    expect(d.qualityReport?.passed).toBe(true);
    expect(d.content.questions).toHaveLength(4);
    const myth = d.claims.find((x) => x.key === 'C003')!;
    expect(myth).toMatchObject({ verdict: 'MYTH', importance: 'KEY', popularVersion: expect.stringContaining('Mackay') });
    expect(myth.citations.map((x) => x.stance).sort()).toEqual(['CONTRADICTS', 'CONTRADICTS', 'SUPPORTS', 'SUPPORTS']);
    expect(myth.citations.every((x) => x.quoteVerified && x.basis === 'FULL_TEXT' && x.quote)).toBe(true);
    // All considered sources, with their outcome.
    expect(d.sources).toHaveLength(16);
    expect(d.sources.filter((x) => x.retrievalStatus === 'FAILED')).toHaveLength(2);
    // An unretrievable scholarly page points to the open-access copy used in its place.
    expect(d.sources.find((x) => x.domain === 'paywalled-journal.org')!.retrievalError).toMatch(/open-access copy retrieved instead: https:\/\/repository\.test-university\.edu\//);
    expect(d.sources.find((x) => x.domain === 'repository.test-university.edu')).toMatchObject({ retrievalStatus: 'RETRIEVED', sourceType: 'ACADEMIC', citationCount: 1 });
    expect(d.sources.filter((x) => x.duplicateOfId)).toHaveLength(1);
    expect(d.sources.find((x) => x.domain === 'jstor.org')).toMatchObject({ sourceType: 'ACADEMIC', citationCount: expect.any(Number) });
    expect(d.cost.calls).toBeGreaterThan(20);
    expect(d.cost.includesEstimates).toBe(true);

    const detail = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json<ProjectDetailView>();
    expect(detail.research).toMatchObject({ version: 1, status: 'IN_REVIEW', claimCount: 14 });
    expect(detail.costs.includesEstimates).toBe(true);
    expect(detail.costs.byProvider.map((x) => x.provider)).toEqual(['fake-ai', 'fake-search']);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/research?version=9` })).statusCode).toBe(404);

    const approved = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'RESEARCH', decision: 'APPROVED', notes: 'Checked the myths section' } });
    expect(approved.json<ProjectDetailView>()).toMatchObject({ status: 'RESEARCH_COMPLETE', research: { status: 'APPROVED' } });
  });
});

describe('story API', () => {
  async function researched(app: FastifyInstance) {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    return p;
  }
  const story = async (app: FastifyInstance, id: string) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/story` })).json<StoryView>();
  const patch = (app: FastifyInstance, id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/story-candidates/${id}`, payload });

  it('mines, lets the editor curate, checks the selection, builds and reviews the architecture', async () => {
    const { app, c } = await start({}, { fakeStory: true });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json<HealthView>().realStages).toEqual(['STORY_MINING', 'STORY_ARCHITECTURE']);
    const p = await researched(app);
    expect(await story(app, p.id)).toMatchObject({ packs: [], pack: null, architecture: null, editable: false, selection: { count: 0, problem: 'No story pack yet' } });

    // Run Story Mining.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} })).statusCode).toBe(202);
    await c.runner.drain();
    let view = await story(app, p.id);
    expect(view).toMatchObject({ editable: true, selection: { count: 7, min: 5, max: 10, problem: null } });
    const pack = view.pack!;
    expect(pack).toMatchObject({ version: 1, status: 'IN_REVIEW', qualityPassed: true, candidateCount: 15, selectedCount: 7, dossierVersion: 1 });
    expect(pack.cost).toMatchObject({ calls: 3, includesEstimates: true });
    expect(pack.qualityReport?.passed).toBe(true);
    for (const cand of pack.candidates) {
      expect(cand.claimKeys.length).toBeGreaterThan(0);
      expect(cand.sourceIds.length).toBeGreaterThan(0);
      expect(cand.scores).not.toBeNull();
    }
    const cited = new Set(pack.candidates.flatMap((x) => x.claimKeys));
    expect(pack.evidence.claims.map((x) => x.key).sort()).toEqual([...cited].sort());
    expect(pack.evidence.sources.length).toBeGreaterThan(0);

    // The editor approves, prioritises, rejects and deselects.
    const [first, second, , , fifth] = pack.candidates;
    let res = await patch(app, first!.id, { status: 'APPROVED', priority: 'HIGH', editorNotes: 'Open with this.' });
    expect(res.statusCode).toBe(200);
    expect(res.json<StoryView>().pack!.candidates[0]).toMatchObject({ status: 'APPROVED', priority: 'HIGH', editorNotes: 'Open with this.', selected: true });
    res = await patch(app, second!.id, { status: 'REJECTED' });
    expect(res.json<StoryView>().selection.count).toBe(6);
    expect((await patch(app, second!.id, { selected: true })).statusCode).toBe(409);
    expect((await patch(app, second!.id, { status: 'REJECTED', selected: true })).statusCode).toBe(400);
    expect((await patch(app, first!.id, {})).statusCode).toBe(400);
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'CANDIDATE_UPDATED' } })).toBe(2);

    // The selection is checked before any architecture work is paid for.
    for (const cand of pack.candidates.slice(2, 5)) await patch(app, cand.id, { selected: false });
    const refused = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe('Select at least 5 story units (3 selected)');
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'STORY_ARCHITECTURE' } })).statusCode).toBe(409);
    for (const cand of pack.candidates.slice(2, 4)) await patch(app, cand.id, { selected: true });
    expect((await story(app, p.id)).selection).toMatchObject({ count: 5, problem: null });

    // Generate Story Architecture.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: { notes: 'Lead with the contracts.' } })).statusCode).toBe(202);
    await c.runner.drain();
    view = await story(app, p.id);
    expect(view.editable).toBe(false);
    const arch = view.architecture!;
    expect(arch).toMatchObject({ version: 1, status: 'IN_REVIEW', qualityPassed: true, packVersion: 1, sequenceCount: 5, targetDurationSec: 750, notes: 'Lead with the contracts.' });
    expect(arch.content!.sequences.every((s) => s.sourceIds.length > 0 && s.claimKeys.length > 0)).toBe(true);
    expect(arch.evidence.claims.length).toBeGreaterThan(0);
    expect(arch.content!.sequences.map((s) => s.candidateKeys[0])).toEqual(['S01', 'S03', 'S04', 'S06', 'S07']); // S02 rejected, S05 deselected
    expect(fifth!.key).toBe('S05');
    expect((await patch(app, first!.id, { priority: 'LOW' })).json()).toMatchObject({ error: 'CONFLICT', message: expect.stringContaining('STORY_SELECTION') });

    // Reject → rework; nothing proceeds without a human.
    const rejected = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'STORY', decision: 'REJECTED', notes: 'Too slow to start.' } });
    expect(rejected.json<ProjectDetailView>()).toMatchObject({ status: 'STORY_SELECTION', story: { architecture: { version: 1, status: 'REJECTED' }, pack: { version: 1, selectedCount: 5 } } });
    expect((await story(app, p.id)).architecture!.approvals).toEqual([expect.objectContaining({ gate: 'STORY', decision: 'REJECTED', notes: 'Too slow to start.' })]);

    // Another mining pass with the editor's brief.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: { notes: 'More about the courts.' } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json<ProjectDetailView>().status).toBe('STORY_MINING');
    await c.runner.drain();
    view = await story(app, p.id);
    expect(view.packs.map((x) => [x.version, x.status])).toEqual([
      [2, 'IN_REVIEW'],
      [1, 'SUPERSEDED'],
    ]);
    expect(view.pack!.candidates.find((x) => x.title === first!.title)).toMatchObject({ status: 'APPROVED', priority: 'HIGH' });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/story?pack=1` })).json<StoryView>()).toMatchObject({ editable: false, pack: { version: 1 } });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/story?pack=7` })).statusCode).toBe(404);
  });
});

describe('demo seed', () => {
  it('creates Tulip Mania once and leaves it alone afterwards', async () => {
    const { c } = await start();
    const first = await seedDemoProject(db, c.projects);
    expect(first.created).toBe(true);
    await db.project.update({ where: { id: first.projectId }, data: { status: 'RESEARCHING' } });
    const second = await seedDemoProject(db, c.projects);
    expect(second).toEqual({ created: false, projectId: first.projectId });
    const p = await db.project.findUniqueOrThrow({ where: { slug: DEMO_PROJECT_SLUG } });
    expect(p).toMatchObject({ title: 'Tulip Mania', workingTitle: 'The Bubble That Became a Legend', category: 'Economic History', status: 'RESEARCHING' });
  });
});
