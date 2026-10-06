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
import { FakeScriptAI } from '@docengine/script/testing';
import { StoryArchitectureContent, type NarrationTimelineView, type ResearchView, type ScriptBlockView, type ScriptChangeReport, type ScriptCompareView, type ScriptEditorialView, type ScriptView, type StoryView, type VoiceMomentView, type VoicePlanView, type VoiceRenderPlan, type VoiceView, type WritingCorpusView, type WritingExampleView } from '@docengine/core';
import { Prisma } from '@docengine/database';

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

async function start(extraEnv: Record<string, string> = {}, opts: { fakeResearch?: boolean; fakeStory?: boolean; fakeScript?: boolean } = {}) {
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
    ...(opts.fakeScript ? { providers: { ...createProviders(ALL_MOCK), ai: new FakeScriptAI() } } : {}),
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
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json<HealthView>().realStages).toEqual(['RESEARCH', 'STORY_MINING', 'STORY_ARCHITECTURE', 'STORY_ANGLES', 'SCRIPT', 'VOICE']);
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
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json<HealthView>().realStages).toEqual(['STORY_MINING', 'STORY_ARCHITECTURE', 'STORY_ANGLES', 'SCRIPT', 'VOICE']);
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

    // Generate Story Architecture (the fake architect adds one labelled background claim from outside the selection).
    const selectedClaims = new Set((await story(app, p.id)).pack!.candidates.filter((x) => x.selected && x.status !== 'REJECTED').flatMap((x) => x.claimKeys));
    const background = ['C001', 'C002', 'C003', 'C005', 'C007', 'C013', 'C014', 'C016', 'C017', 'C020'].find((k) => !selectedClaims.has(k))!;
    (c.providers.ai as FakeStoryAI).architectOptions = { contextClaims: [{ claimKey: background, purpose: 'Background for the opening' }] };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: { notes: 'Lead with the contracts.' } })).statusCode).toBe(202);
    await c.runner.drain();
    view = await story(app, p.id);
    expect(view.editable).toBe(false);
    const arch = view.architecture!;
    expect(arch).toMatchObject({ version: 1, status: 'IN_REVIEW', qualityPassed: true, packVersion: 1, sequenceCount: 5, targetDurationSec: 750, notes: 'Lead with the contracts.' });
    expect(arch.content!.sequences.every((s) => s.sourceIds.length > 0 && s.claimKeys.length > 0)).toBe(true);
    expect(arch.content!.sequences[0]!.contextClaims).toEqual([{ claimKey: background, purpose: 'Background for the opening' }]);
    expect(arch.content!.sequences.flatMap((s) => s.claimKeys).every((k) => selectedClaims.has(k))).toBe(true);
    expect(arch.evidence.claims.map((x) => x.key)).toContain(background);
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

describe('Story Engine 2.0 API', () => {
  async function minedProject(app: FastifyInstance, c: AppContainer) {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} })).statusCode).toBe(202);
    await c.runner.drain();
    return p;
  }
  const story = async (app: FastifyInstance, id: string) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/story` })).json<StoryView>();
  const patch = (app: FastifyInstance, id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/story-candidates/${id}`, payload });
  const decide = (app: FastifyInstance, id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/content-opportunities/${id}`, payload });

  it('lets the editor retitle, re-angle and order the units, decide each opportunity, and request a content package', async () => {
    const { app, c } = await start({}, { fakeStory: true });
    const p = await minedProject(app, c);
    let view = await story(app, p.id);
    const pack = view.pack!;
    expect(pack.engineVersion).toBe(2);
    for (const cand of pack.candidates) {
      expect(cand).toMatchObject({ engineVersion: 2, scores: { version: 2 }, editorOverrides: {}, selectionOrder: null });
      expect(cand.storyValue).not.toBeNull();
      expect(cand.historicalValue).not.toBeNull();
      expect(cand.humanStakes).not.toBeNull();
      expect(cand.storyDesign?.coldOpen.basis).toBeDefined();
    }

    // The editor's title, mode, central question and POV are kept beside the AI's; null restores the AI's.
    const [first] = pack.candidates;
    let res = await patch(app, first!.id, { title: 'Paper flowers', narrativeMode: 'HEIST_OPERATION', centralQuestion: 'Who was left holding the contracts?', povStrategy: { type: 'INVESTIGATOR', description: 'Open the notary files.' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<StoryView>().pack!.candidates[0]).toMatchObject({
      title: 'Paper flowers',
      aiTitle: first!.title,
      narrativeMode: 'HEIST_OPERATION',
      aiNarrativeMode: first!.aiNarrativeMode,
      centralQuestion: 'Who was left holding the contracts?',
      povStrategy: { type: 'INVESTIGATOR', description: 'Open the notary files.' },
      editorOverrides: { title: 'Paper flowers', narrativeMode: 'HEIST_OPERATION', centralQuestion: 'Who was left holding the contracts?', povStrategy: { type: 'INVESTIGATOR', description: 'Open the notary files.' } },
    });
    res = await patch(app, first!.id, { title: null });
    expect(res.json<StoryView>().pack!.candidates[0]).toMatchObject({ title: first!.title, narrativeMode: 'HEIST_OPERATION' });
    expect(res.json<StoryView>().pack!.candidates[0]!.editorOverrides).not.toHaveProperty('title');
    expect((await patch(app, first!.id, { narrativeMode: 'NOT_A_MODE' })).statusCode).toBe(400);

    // The editor's order: exactly the current selection, or nothing changes.
    const selected = pack.candidates.filter((x) => x.selected).map((x) => x.id);
    const order = (candidateIds: string[]) => app.inject({ method: 'PUT', url: `/api/projects/${p.id}/story/selection-order`, payload: { candidateIds } });
    expect((await order(selected.slice(1))).statusCode).toBe(409);
    res = await order([...selected].reverse());
    expect(res.statusCode).toBe(200);
    view = res.json<StoryView>();
    expect(selected.map((id) => view.pack!.candidates.find((x) => x.id === id)!.selectionOrder)).toEqual(selected.map((_, i) => selected.length - i));
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'SELECTION_REORDERED' } })).toBe(1);

    // The architect works in the editor's order, with the editor's angle.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: { preferences: { centralQuestion: 'Why did a promise become a legend?' } } })).statusCode).toBe(202);
    await c.runner.drain();
    const prompt = (c.providers.ai as FakeStoryAI).prompts['story.architect']![0]!;
    const lastKey = pack.candidates.find((x) => x.id === selected.at(-1))!.key;
    expect(prompt).toMatch(new RegExp(`^## ${lastKey} · #1 in the editor's order`, 'm'));
    expect(prompt).toContain('- central question: Why did a promise become a legend?');
    expect(prompt).toContain('told as: HEIST_OPERATION; POV INVESTIGATOR (Open the notary files.)');

    view = await story(app, p.id);
    const arch = view.architecture!;
    expect(arch).toMatchObject({ engineVersion: 2, status: 'IN_REVIEW', opportunities: { shorts: 5, longForm: 1, approved: 0 }, content: { engineVersion: 2 } });
    expect(arch.opportunityList.map((o) => `${o.key} ${o.format} ${o.rank ?? '-'}`)).toEqual(['O01 SHORT 1', 'O02 BOTH 2', 'O03 SHORT 3', 'O04 SHORT 4', 'O05 SHORT 5', 'O06 LONG_FORM -']);
    for (const o of arch.opportunityList) {
      expect(o).toMatchObject({ status: 'PROPOSED', eligible: false, architectureVersion: 1 });
      expect(o.claimIds).toHaveLength(o.content!.claimKeys.length);
      expect(o.content!.claimKeys.every((k) => arch.evidence.claims.some((x) => x.key === k))).toBe(true);
    }
    expect(view.architectures[0]).toMatchObject({ engineVersion: 2, opportunities: { shorts: 5, longForm: 1, approved: 0 } });

    // Nothing is eligible before the architecture is approved.
    let pkg = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/content-package?shorts=3` })).json();
    expect(pkg).toMatchObject({ generated: false, documentary: { included: false, eligible: false }, shorts: { requested: 3, available: 0, returned: 0, items: [] }, architecture: { version: 1, status: 'IN_REVIEW' } });
    expect(pkg.notes).toContain('Story architecture v1 is IN_REVIEW: nothing is eligible until an architecture is approved.');

    // The editor decides each opportunity; the architecture decision is separate.
    const [o1, o2, o3, o4, , o6] = arch.opportunityList;
    for (const o of [o1!, o2!, o3!, o6!]) expect((await decide(app, o.id, { status: 'APPROVED' })).json()).toMatchObject({ status: 'APPROVED', decidedBy: 'dashboard', eligible: false });
    expect((await decide(app, o4!.id, { status: 'REJECTED', editorNotes: 'Too close to O03.' })).json()).toMatchObject({ status: 'REJECTED', editorNotes: 'Too close to O03.' });
    expect((await decide(app, o4!.id, { status: 'MAYBE' })).statusCode).toBe(400);
    expect((await decide(app, '0190a0a0-0000-7000-8000-000000000000', { status: 'APPROVED' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'STORY', decision: 'APPROVED' } })).statusCode).toBe(201);
    expect((await story(app, p.id)).architecture!.opportunities).toEqual({ shorts: 5, longForm: 1, approved: 4 });

    // The package: the approved documentary plus the top approved shorts by rank; nothing generated.
    pkg = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/content-package?documentary=true&shorts=2&languages=en,es,de` })).json();
    expect(pkg).toMatchObject({
      request: { documentary: true, shorts: 2, languages: ['en', 'es', 'de'] },
      architecture: { version: 1, status: 'APPROVED' },
      documentary: { included: true, eligible: true, reason: null },
      shorts: { requested: 2, available: 3, returned: 2 },
      generated: false,
      languages: { requested: ['en', 'es', 'de'] },
    });
    expect(pkg.shorts.items.map((o: { key: string; eligible: boolean }) => `${o.key} ${o.eligible}`)).toEqual(['O01 true', 'O02 true']);
    expect(pkg.longForm.map((o: { key: string }) => o.key)).toEqual(['O06']);
    expect(pkg.languages.note).toMatch(/^Localization is not built yet/);

    const post = (payload: unknown) => app.inject({ method: 'POST', url: `/api/projects/${p.id}/content-package`, payload: payload as Record<string, unknown> });
    pkg = (await post({ documentary: true, shorts: 6, languages: ['en', 'es', 'de'] })).json();
    expect(pkg.shorts).toMatchObject({ requested: 6, available: 3, returned: 3 });
    expect(pkg.notes).toContain('6 shorts requested; 3 approved short opportunities are available.');
    expect((await post({ shorts: 'all' })).json().shorts.returned).toBe(3);
    expect((await post({ documentary: false, shorts: 1 })).json()).toMatchObject({ documentary: { included: false, eligible: true }, shorts: { returned: 1 } });
    expect((await post({ shorts: 99 })).statusCode).toBe(400);
    expect((await post({ languages: ['english'] })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/content-package?shorts=abc` })).statusCode).toBe(400);
    // Reading the package changes nothing.
    expect(await db.contentOpportunity.count({ where: { projectId: p.id, status: 'APPROVED' } })).toBe(4);
  });

  it('keeps serving engine-1 packs and architectures beside engine-2 ones', async () => {
    const { app, c } = await start({}, { fakeStory: true });
    const p = await minedProject(app, c);
    // What an engine-1 pack looks like after the additive migration: engine_version 1, v1 scores, the new columns empty.
    const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id } });
    await db.storyPack.update({ where: { id: pack.id }, data: { engineVersion: 1 } });
    await db.storyCandidate.updateMany({
      where: { packId: pack.id },
      data: {
        scores: { intrigue: 7, humanDrama: 6, stakes: 7, surprise: 5, escalation: 6, visualPotential: 7, financialStakes: 8, emotionalWeight: 5, appeal: 6.6, rationale: 'Engine-1 scores (test).' },
        narrativeMode: null,
        centralQuestion: null,
        povStrategy: Prisma.DbNull,
        humanStakes: Prisma.DbNull,
        storyDesign: Prisma.DbNull,
        reconstructionLevel: null,
        storyValue: null,
        historicalValue: null,
      },
    });
    const candidates = await db.storyCandidate.findMany({ where: { packId: pack.id }, orderBy: { rank: 'asc' } });
    const v1 = StoryArchitectureContent.parse({
      premise: 'An engine-1 premise.',
      centralQuestion: 'Why did it end in court?',
      narrativeSpine: 'Spine.',
      resolution: 'Answer.',
      sequences: [
        { number: 1, title: 'The contracts', purpose: 'Opens.', candidateIds: [candidates[0]!.id], candidateKeys: [candidates[0]!.candidateKey], openingHook: 'Hook.', narrativeQuestion: 'Q?', keyEvents: [{ event: 'E', claimKeys: ['C001'] }], characters: [], conflict: '', escalation: '', reveal: '', endingBeat: '', claimKeys: ['C001'], sourceIds: [], caveats: [], historicalStatus: 'ESTABLISHED', historicalConfidence: 9, estimatedDurationSec: 120 },
      ],
      unusedCandidates: [],
    });
    await db.storyArchitecture.create({ data: { projectId: p.id, dossierId: pack.dossierId, packId: pack.id, version: 1, engineVersion: 1, status: 'APPROVED', content: v1, targetDurationSec: 750, estimatedDurationSec: 120, qualityPassed: true } });

    const view = await story(app, p.id);
    expect(view.pack).toMatchObject({ engineVersion: 1 });
    expect(view.pack!.candidates[0]).toMatchObject({ engineVersion: 1, scores: { intrigue: 7, appeal: 6.6 }, storyValue: null, humanStakes: null, storyDesign: null, narrativeMode: null, povStrategy: null });
    expect(view.architecture).toMatchObject({ engineVersion: 1, opportunities: { shorts: 0, longForm: 0, approved: 0 }, opportunityList: [], content: { premise: 'An engine-1 premise.' } });
    expect(view.architecture!.evidence.claims.map((x) => x.key)).toEqual(['C001']);
    const pkg = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/content-package` })).json();
    expect(pkg).toMatchObject({ documentary: { included: true, eligible: true }, shorts: { available: 0, returned: 0 }, architecture: { version: 1, logline: null, centralQuestion: 'Why did it end in court?' } });
    expect(pkg.notes).toContain('Architecture v1 was built by story engine 1, which does not identify content opportunities.');
  });
});

describe('editorial revision loop API', () => {
  const story = async (app: FastifyInstance, id: string, q = '') => (await app.inject({ method: 'GET', url: `/api/projects/${id}/story${q}` })).json<StoryView>();
  const BRIEF = 'The opening is too slow and the point of view is unclear: open on the collapse and follow an investigator.';

  it('explores angles before committing, builds on one, then reconsiders the architecture into a new version without overwriting anything', async () => {
    const { app, c } = await start({}, { fakeStory: true });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} });
    await c.runner.drain();
    let view = await story(app, p.id);
    expect(view.editorial).toMatchObject({ revise: { allowed: false, reason: 'No architecture of the current story pack to revise yet' }, angles: { allowed: true, reason: null } });
    expect(view.editorial.poolKeys).toHaveLength(7);

    // Explore alternative angles: a side job; the project stays in selection.
    let res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/angles`, payload: { count: 3, notes: 'Bolder openings.' } });
    expect(res.statusCode).toBe(202);
    expect(res.json<JobView>()).toMatchObject({ type: 'STORY_ANGLES', status: 'QUEUED' });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/angles`, payload: { count: 4 } })).statusCode).toBe(400);
    // Not through the generic job endpoint: the dedicated routes check and record the request.
    const viaJobs = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'STORY_ANGLES' } });
    expect(viaJobs.statusCode).toBe(409);
    expect(viaJobs.json().message).toMatch(/story\/angles/);
    await c.runner.drain();
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json<ProjectDetailView>().status).toBe('STORY_SELECTION');
    view = await story(app, p.id);
    expect(view.explorations).toEqual([expect.objectContaining({ version: 1, angleCount: 3, qualityPassed: true, basedOnVersion: null })]);
    expect(view.exploration).toMatchObject({ version: 1, notes: 'Bolder openings.', poolChanged: false, developed: [] });
    expect(view.exploration!.content!.angles.map((a) => a.key)).toEqual(['A1', 'A2', 'A3']);
    expect(view.exploration!.evidence.claims.length).toBeGreaterThan(0);

    // Build on angle A2.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: { angle: { exploration: 5, key: 'A1' } } })).statusCode).toBe(409);
    res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: { angle: { exploration: 1, key: 'A2' } } });
    expect(res.statusCode).toBe(202);
    await c.runner.drain();
    view = await story(app, p.id);
    expect(view.architecture).toMatchObject({ version: 1, origin: 'NEW', revisionOfVersion: null, angle: { explorationVersion: 1, key: 'A2', title: 'Follow the traders (test)' }, status: 'IN_REVIEW' });
    expect(view.exploration!.developed).toEqual([{ key: 'A2', architectureVersion: 1 }]);
    expect(view.editorial.revise).toEqual({ allowed: true, reason: null });

    // Reconsider it: explicit brief, a new version, the old one kept.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture/revise`, payload: { baseVersion: 1, brief: 'too short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture/revise`, payload: { baseVersion: 9, brief: BRIEF } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture/revise`, payload: { baseVersion: 1, brief: BRIEF, aspects: ['NOT_AN_ASPECT'] } })).statusCode).toBe(400);
    const generic = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'STORY_ARCHITECTURE', input: { notes: BRIEF, revise: { baseVersion: 1 } } } });
    expect(generic.statusCode).toBe(409);
    expect(generic.json().message).toMatch(/architecture\/revise/);
    res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture/revise`, payload: { baseVersion: 1, brief: BRIEF, aspects: ['OPENING', 'STRUCTURE'] } });
    expect(res.statusCode).toBe(202);
    expect(res.json<JobView>()).toMatchObject({ type: 'STORY_ARCHITECTURE' });
    await c.runner.drain();
    view = await story(app, p.id);
    expect(view.architectures.map((a) => `v${a.version} ${a.status} ${a.origin}${a.revisionOfVersion ? ` of v${a.revisionOfVersion}` : ''}`)).toEqual(['v2 IN_REVIEW REVISION of v1', 'v1 SUPERSEDED NEW']);
    const content = view.architecture!.content!;
    expect('engineVersion' in content && content.provenance).toMatchObject({ kind: 'REVISION', baseVersion: 1, brief: BRIEF, aspects: ['OPENING', 'STRUCTURE'], diff: { substantial: true } });
    expect(view.architecture!.notes).toBe(BRIEF);
    const old = await story(app, p.id, '?architecture=1');
    expect(old.architecture).toMatchObject({ version: 1, status: 'SUPERSEDED', angle: { key: 'A2' } });
    expect(old.architecture!.content!.sequences.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/story?exploration=9` })).statusCode).toBe(404);
  });

  it('refuses revisions and angles where the story engine is a MOCK', async () => {
    const { app } = await start();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'STORY_SELECTION' } });
    const angles = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/angles`, payload: {} });
    expect(angles.statusCode).toBe(409);
    expect(angles.json().message).toMatch(/real story engine/);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture/revise`, payload: { baseVersion: 1, brief: BRIEF } })).statusCode).toBe(409);
    expect((await story(app, p.id)).editorial).toMatchObject({ revise: { allowed: false }, angles: { allowed: false } });
  });
});

describe('script API', () => {
  const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];
  const BRIEF = 'Too slow: open on the court date and cut the background (test).';
  const script = async (app: FastifyInstance, id: string, q = '') => (await app.inject({ method: 'GET', url: `/api/projects/${id}/script${q}` })).json<ScriptView>();
  const line = (s: ScriptView['scripts'][number]) => `v${s.version} ${s.status} ${s.origin}${s.revisionOfVersion ? ` of v${s.revisionOfVersion}` : ''}`;

  /** A project whose Story Engine 2.0 architecture was approved at the STORY gate (synthetic dossier). */
  async function approvedArchitecture(app: FastifyInstance, c: AppContainer) {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 } })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} })).statusCode).toBe(202);
    await c.runner.drain();
    const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
    (c.providers.ai as FakeScriptAI).architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: {} })).statusCode).toBe(202);
    await c.runner.drain();
    const approved = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'STORY', decision: 'APPROVED' } });
    expect(approved.json<ProjectDetailView>().status).toBe('STORY_APPROVED');
    return p.id;
  }

  it('writes a draft from the approved architecture; the editor edits, reorders, decides and rewrites one section; versions are compared, restored and approved', async () => {
    const { app, c } = await start({}, { fakeScript: true });
    const id = await approvedArchitecture(app, c);
    let view = await script(app, id);
    expect(view).toMatchObject({ scripts: [], script: null, realStage: true, architecture: { version: 1, status: 'APPROVED', engineVersion: 2 } });
    expect(view.editorial).toMatchObject({ generate: { allowed: true }, revise: { allowed: false, reason: 'No script yet' }, edit: { allowed: false }, approve: { allowed: false } });

    // Generate Draft: a SCRIPT job; the project stops in SCRIPT_REVIEW for the editor.
    let res = await app.inject({ method: 'POST', url: `/api/projects/${id}/script`, payload: { notes: 'Keep the opening calm (test).' } });
    expect(res.statusCode).toBe(202);
    expect(res.json<JobView>()).toMatchObject({ type: 'SCRIPT', status: 'QUEUED' });
    await c.runner.drain();
    view = await script(app, id);
    const v1 = view.script!;
    const sequences = (await db.storyArchitecture.findFirstOrThrow({ where: { projectId: id, status: 'APPROVED' } })).content as { sequences: unknown[] };
    expect(v1).toMatchObject({ version: 1, status: 'IN_REVIEW', origin: 'DRAFT', architectureVersion: 1, qualityPassed: true, notes: 'Keep the opening calm (test).', blocking: [] });
    expect(v1.sections).toHaveLength(sequences.sequences.length);
    // Six model calls: the plan, the writing, the narration pass, both reviewers and the performance.
    expect(v1.cost).toMatchObject({ calls: 6, includesEstimates: true });
    expect(v1.timing).toMatchObject({ minSec: 120, maxSec: 240, targetSec: 180, words: v1.wordCount });
    expect(v1.evidence.claims.map((x) => x.key).sort()).toEqual([...new Set(v1.sections.flatMap((s) => s.blocks.flatMap((b) => b.claimKeys)))].sort());
    expect(v1.voice).toMatchObject({ provider: 'elevenlabs', pendingPronunciations: 2 });
    expect(view.editorial).toMatchObject({ edit: { allowed: true }, approve: { allowed: true }, revise: { allowed: true }, restore: { allowed: false, reason: 'This is the version under review' } });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json<ProjectDetailView>()).toMatchObject({ status: 'SCRIPT_REVIEW', script: { version: 1, status: 'IN_REVIEW', qualityPassed: true } });

    // Edit one block's text and delivery: the generated text is kept, the gate re-run at once.
    const second = v1.sections[1]!;
    const first = second.blocks[0]!;
    res = await app.inject({ method: 'PATCH', url: `/api/script-blocks/${first.id}`, payload: { text: `${first.text} The towns were watching (test).`, delivery: { pace: 'SLOW' } } });
    expect(res.statusCode).toBe(200);
    let edited = res.json<ScriptView>().script!;
    expect(edited.sections[1]!.blocks[0]).toMatchObject({ text: `${first.text} The towns were watching (test).`, generatedText: first.text, delivery: { pace: 'SLOW' }, editedBy: 'dashboard' });
    expect(edited.wordCount).toBeGreaterThan(v1.wordCount);
    expect(edited.qualityReport!.normalizations).toContain("Re-checked after the editor's change (rules only, no model calls)");
    expect((await app.inject({ method: 'PATCH', url: `/api/script-blocks/${first.id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/script-blocks/00000000-0000-4000-8000-000000000000', payload: { text: 'Nothing here.' } })).statusCode).toBe(404);

    // Reorder a section's blocks: exactly that section's blocks, once each.
    const ids = second.blocks.map((b) => b.id);
    expect(ids.length).toBeGreaterThan(1);
    expect((await app.inject({ method: 'PUT', url: `/api/script-sections/${second.id}/order`, payload: { blockIds: ids.slice(1) } })).statusCode).toBe(409);
    res = await app.inject({ method: 'PUT', url: `/api/script-sections/${second.id}/order`, payload: { blockIds: [...ids].reverse() } });
    expect(res.statusCode).toBe(200);
    edited = res.json<ScriptView>().script!;
    expect(edited.sections[1]!.blocks.map((b) => b.id)).toEqual([...ids].reverse());

    // Reject section 3 with a note: the whole script cannot be approved until it is dealt with.
    const third = v1.sections[2]!;
    res = await app.inject({ method: 'PATCH', url: `/api/script-sections/${third.id}`, payload: { reviewStatus: 'REJECTED', editorNotes: 'Too long: cut the background (test).' } });
    expect(res.json<ScriptView>().script!.sections[2]).toMatchObject({ reviewStatus: 'REJECTED', editorNotes: 'Too long: cut the background (test).', reviewedBy: 'dashboard' });
    expect(res.json<ScriptView>().editorial.approve).toEqual({ allowed: false, reason: 'Rejected section(s) 3: rewrite or approve them first' });
    let refused = await app.inject({ method: 'POST', url: `/api/projects/${id}/approvals`, payload: { gate: 'SCRIPT', decision: 'APPROVED' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/rejected section\(s\) 3/);
    expect(await db.projectEvent.count({ where: { projectId: id, type: { in: ['SCRIPT_EDITED', 'SCRIPT_SECTION_REVIEWED'] } } })).toBe(3);

    // Regenerate that section only: a new version; the other sections are copied with the editor's changes.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/revise`, payload: { baseVersion: 1, sections: [3], brief: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/revise`, payload: { baseVersion: 9, sections: [3], brief: BRIEF } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/revise`, payload: { baseVersion: 1, sections: [42], brief: BRIEF } })).statusCode).toBe(409);
    const generic = await app.inject({ method: 'POST', url: `/api/projects/${id}/jobs`, payload: { type: 'SCRIPT', input: { notes: BRIEF, revise: { baseVersion: 1 } } } });
    expect(generic.statusCode).toBe(409);
    expect(generic.json().message).toMatch(/script\/revise/);
    const calls = (c.providers.ai as FakeScriptAI).calls;
    const before = { ...calls };
    res = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/revise`, payload: { baseVersion: 1, sections: [3], brief: BRIEF } });
    expect(res.statusCode).toBe(202);
    await c.runner.drain();
    expect((calls['script.rewrite'] ?? 0) - (before['script.rewrite'] ?? 0)).toBe(1);
    expect((calls['script.plan'] ?? 0) - (before['script.plan'] ?? 0)).toBe(0);
    view = await script(app, id);
    expect(view.scripts.map(line)).toEqual(['v2 IN_REVIEW SECTIONS of v1', 'v1 SUPERSEDED DRAFT']);
    const v2 = view.script!;
    expect(v2).toMatchObject({ sectionsWritten: [3], notes: BRIEF });
    expect(v2.sections[2]).toMatchObject({ reviewStatus: 'PENDING', editorNotes: null });
    expect(v2.sections[1]!.blocks.map((b) => [b.text, b.editedBy])).toEqual(edited.sections[1]!.blocks.map((b) => [b.text, b.editedBy]));
    expect(v2.sections.filter((_, i) => i !== 2).map((s) => s.blocks.map((b) => b.text))).toEqual(edited.sections.filter((_, i) => i !== 2).map((s) => s.blocks.map((b) => b.text)));

    // Compare: only section 3 changed.
    const cmp = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=1&b=2` })).json<ScriptCompareView>();
    expect(cmp.sections.filter((s) => s.changed).map((s) => s.sequenceNumber)).toEqual([3]);
    expect(cmp.totals.sectionsChanged).toBe(1);
    expect(cmp.sections[2]!.diff.some((d) => d.op === 'added')).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=1&b=7` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=1` })).statusCode).toBe(400);

    // The voice plan: what the voice provider would be sent (no audio is generated).
    const plan = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/voice-plan` })).json<VoiceRenderPlan>();
    expect(plan.provider).toBe('elevenlabs');
    expect(plan.segments.flatMap((s) => s.blockKeys)).toEqual(v2.sections.flatMap((s) => s.blocks.map((b) => b.key)));
    expect(plan.segments.every((s) => !/[<>]/.test(s.text.replace(/<break time="\d+\.\ds" \/>/g, '')))).toBe(true);
    expect(plan.pendingPronunciations).toEqual(['Cornelis Proefman', 'Pieter Graanhout']);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/script/voice-plan?version=1` })).statusCode).toBe(200);

    // Restore v1 as v3: a copy with its edits and decisions, and no model calls.
    const jobs = await db.job.count({ where: { projectId: id } });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/restore`, payload: { version: 2 } })).statusCode).toBe(409);
    res = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/restore`, payload: { version: 1 } });
    expect(res.statusCode).toBe(200);
    const v3 = res.json<ScriptView>().script!;
    expect(v3).toMatchObject({ version: 3, status: 'IN_REVIEW', origin: 'RESTORE', revisionOfVersion: 1 });
    expect(v3.sections.map((s) => s.blocks.map((b) => b.text))).toEqual(edited.sections.map((s) => s.blocks.map((b) => b.text)));
    expect(v3.sections[2]!.reviewStatus).toBe('REJECTED');
    expect(await db.job.count({ where: { projectId: id } })).toBe(jobs);
    expect((await script(app, id)).scripts.map(line)).toEqual(['v3 IN_REVIEW RESTORE of v1', 'v2 SUPERSEDED SECTIONS of v1', 'v1 SUPERSEDED DRAFT']);

    // Approve section 3, then the whole script at the SCRIPT gate.
    res = await app.inject({ method: 'PATCH', url: `/api/script-sections/${v3.sections[2]!.id}`, payload: { reviewStatus: 'APPROVED' } });
    expect(res.json<ScriptView>().editorial.approve).toEqual({ allowed: true, reason: null });
    res = await app.inject({ method: 'POST', url: `/api/projects/${id}/approvals`, payload: { gate: 'SCRIPT', decision: 'APPROVED', notes: 'Ready for a voice preview (test).' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<ProjectDetailView>()).toMatchObject({ status: 'SCRIPT_APPROVED', script: { version: 3, status: 'APPROVED' } });
    view = await script(app, id);
    expect(view.script!.approvals).toEqual([expect.objectContaining({ gate: 'SCRIPT', decision: 'APPROVED', notes: 'Ready for a voice preview (test).' })]);
    expect(view.editorial).toMatchObject({ edit: { allowed: false }, approve: { allowed: false }, restore: { allowed: false } });
    // An approved version is never changed; earlier versions stay readable.
    expect((await app.inject({ method: 'PATCH', url: `/api/script-blocks/${view.script!.sections[0]!.blocks[0]!.id}`, payload: { text: 'Changed after approval.' } })).statusCode).toBe(409);
    expect((await script(app, id, '?version=1')).script).toMatchObject({ version: 1, status: 'SUPERSEDED' });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/script?version=9` })).statusCode).toBe(404);
  });

  it('refines the narration into a new version and compares it with the one it refined', async () => {
    const { app, c } = await start({}, { fakeScript: true });
    const id = await approvedArchitecture(app, c);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script`, payload: {} })).statusCode).toBe(202);
    await c.runner.drain();
    let view = await script(app, id);
    expect(view.editorial.refine).toEqual({ allowed: true, reason: null });

    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/refine`, payload: { baseVersion: 9 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/refine`, payload: { baseVersion: 'one' } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/refine`, payload: { baseVersion: 1, instructions: 'Keep the first line as it is (test).' } });
    expect(res.statusCode).toBe(202);
    expect(res.json<JobView>()).toMatchObject({ type: 'SCRIPT', status: 'QUEUED' });
    await c.runner.drain();
    view = await script(app, id);
    expect(view.scripts.map(line)).toEqual(['v2 IN_REVIEW REFINEMENT of v1', 'v1 SUPERSEDED DRAFT']);
    expect(view.script).toMatchObject({ version: 2, origin: 'REFINEMENT', qualityPassed: true, notes: 'Keep the first line as it is (test).', cost: { calls: 5 } });
    expect(view.script!.content!.editor!.assessment).toHaveLength(13);
    expect(view.script!.content!.provenance.changeLog!.kept).toHaveLength(1);

    const cmp = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=1&b=2` })).json<ScriptCompareView>();
    expect(cmp.totals).toMatchObject({ sectionsChanged: 6, wordsRemoved: 0 });
    expect(cmp.totals.wordsAdded).toBeGreaterThan(0);
    expect(cmp.facts.a).toMatchObject({ gate: { passed: true, failed: [] }, cost: { calls: 6 }, scores: { NARRATIVE_SCORE: 7 } });
    expect(cmp.facts.b).toMatchObject({ gate: { passed: true, failed: [] }, cost: { calls: 5 }, blocks: cmp.facts.a.blocks });
    expect(cmp.facts.b.classWords.DOCUMENTED).toBeGreaterThan(0);
    expect(cmp.evidence).toEqual({ claimsAdded: [], claimsRemoved: [], figuresAdded: [], figuresRemoved: [] });
    expect(cmp.assessment.map((x) => x.answer)).toEqual(new Array(13).fill('YES'));
    expect(cmp.changeLog).toMatchObject({ summary: expect.any(String), kept: [expect.any(String)] });
    expect(cmp.sections[0]).toMatchObject({ changed: true, words: { removed: 0 } });

    // No director's instructions at all: the house style alone.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/refine`, payload: { baseVersion: 2 } })).statusCode).toBe(202);
    await c.runner.drain();
    view = await script(app, id);
    expect(view.script).toMatchObject({ version: 3, origin: 'REFINEMENT', revisionOfVersion: 2, qualityPassed: true, notes: null, content: { provenance: { brief: null } } });
    expect(view.script!.content!.editor!.assessment).toHaveLength(13);
  });

  it('refuses to write a script where the script stage is a MOCK, or before an architecture is approved', async () => {
    const { app } = await start();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'STORY_APPROVED' } });
    const mock = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script`, payload: {} });
    expect(mock.statusCode).toBe(409);
    expect(mock.json().message).toMatch(/MOCK/);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script/revise`, payload: { baseVersion: 1, brief: BRIEF } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script/refine`, payload: { baseVersion: 1 } })).statusCode).toBe(409);
    expect(await script(app, p.id)).toMatchObject({ realStage: false, script: null, editorial: { generate: { allowed: false, reason: expect.stringMatching(/MOCK/) }, refine: { allowed: false } } });

    const { app: real } = await start({}, { fakeScript: true });
    const q = (await real.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    await db.project.update({ where: { id: q.id }, data: { status: 'STORY_APPROVED' } });
    const none = await real.inject({ method: 'POST', url: `/api/projects/${q.id}/script`, payload: {} });
    expect(none.statusCode).toBe(409);
    expect(none.json().message).toMatch(/No approved story architecture/);
    expect((await real.inject({ method: 'POST', url: `/api/projects/${q.id}/jobs`, payload: { type: 'SCRIPT' } })).statusCode).toBe(409);
    expect(await db.job.count({ where: { projectId: q.id } })).toBe(0);
  });
});

describe('writing engine API', () => {
  const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

  async function drafted(app: FastifyInstance, c: AppContainer, options: FakeScriptAI['architectOptions'] = {}) {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 } })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} });
    await c.runner.drain();
    const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
    (c.providers.ai as FakeScriptAI).architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' }, ...options };
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: {} });
    await c.runner.drain();
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'STORY', decision: 'APPROVED' } });
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script`, payload: {} });
    await c.runner.drain();
    return p.id;
  }

  it('runs the narration pass on a version, and shows the version through the writing engine: its record, its change report, its layers', async () => {
    const { app, c } = await start({}, { fakeScript: true });
    const id = await drafted(app, c);
    const before = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script` })).json<ScriptView>();
    expect(before.editorial.narrate).toEqual({ allowed: true, reason: null });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/narrate`, payload: { baseVersion: 9 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/narrate`, payload: { baseVersion: 'one' } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/narrate`, payload: { baseVersion: 1, instructions: 'Keep it spare (test).' } });
    expect(res.statusCode).toBe(202);
    await c.runner.drain();
    const view = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script` })).json<ScriptView>();
    expect(view.script).toMatchObject({ version: 2, origin: 'NARRATION', revisionOfVersion: 1, notes: 'Keep it spare (test).' });

    const editorial = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/versions/2/editorial` })).json<ScriptEditorialView>();
    expect(editorial).toMatchObject({ version: 2, origin: 'NARRATION', baseVersion: 1, record: { engine: 'writing-engine-2' }, report: { pairing: 'EXACT', base: { version: 1 }, revised: { version: 2 } } });
    expect(editorial.diagnostics.rubric).toHaveLength(10);
    expect(editorial.layers).toHaveLength(view.script!.sections.reduce((n, s) => n + s.blocks.length, 0));
    expect(editorial.layers.every((l) => l.leaks.length === 0 && typeof l.narration === 'string')).toBe(true);
    // A draft has no base: no report.
    const draft = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/versions/1/editorial` })).json<ScriptEditorialView>();
    expect(draft).toMatchObject({ version: 1, origin: 'DRAFT', baseVersion: null, report: null, record: { engine: 'writing-engine-2' } });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/script/versions/9/editorial` })).statusCode).toBe(404);
    // The comparison carries the block-by-block report.
    const cmp = (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=1&b=2` })).json<ScriptCompareView>();
    expect(cmp.changeReport).toMatchObject({ pairing: 'EXACT', totals: { blocksBefore: cmp.facts.a.blocks } });
  });

  it('credits a change to whoever made the wording: a reviewer of the run, or the editor who reworded it by hand since (also on a restored copy)', async () => {
    const { app, c } = await start({ SCRIPT_NARRATION_MODES: 'none' }, { fakeScript: true });
    // A draft written without the pass, with a fake dramatic beat at the end of two narrator lines (not the first of a section, which the performance pass marks) and a bare sum the evidence gives context to.
    const price = 'Records suggest that Cornelis Proefman refused to accept bulbs he had bought for 1,200 guilders.';
    (c.providers.ai as FakeScriptAI).writerTransform = (out) => {
      out.sections.flatMap((x) => x.blocks).find((b) => b.claimKeys.includes('C008') && b.infoClass === 'UNCERTAIN' && !b.speakerId)!.text = price;
      const plain = out.sections.flatMap((x) => x.blocks.slice(1)).filter((b) => b.infoClass === 'DOCUMENTED' && !b.speakerId);
      plain[0]!.text = `${plain[0]!.text} Everything was about to change.`;
      plain.at(-1)!.text = `${plain.at(-1)!.text} But this was only the beginning.`;
      return out;
    };
    const id = await drafted(app, c, { contextClaims: [{ claimKey: 'C018', purpose: 'what a skilled worker earned (test)' }] });
    const scriptOf = async (v: number) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/script?version=${v}` })).json<ScriptView>();
    const editorialOf = async (v: number) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/versions/${v}/editorial` })).json<ScriptEditorialView>();
    const changed = (r: ScriptChangeReport) => r.blocks.filter((x) => x.status !== 'UNCHANGED').map((x) => [x.ref, x.changedBy, x.reasons]);
    const byHand = async (v: number, key: string, change: (b: ScriptBlockView) => Record<string, unknown>) => {
      const b = (await scriptOf(v)).script!.sections.flatMap((x) => x.blocks).find((x) => x.key === key)!;
      expect((await app.inject({ method: 'PATCH', url: `/api/script-blocks/${b.id}`, payload: change(b) })).statusCode).toBe(200);
    };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/narrate`, payload: { baseVersion: 1 } })).statusCode).toBe(202);
    await c.runner.drain();
    const passed = await editorialOf(2);
    const sum = passed.report!.blocks.find((x) => x.original === price)!;
    expect(sum).toMatchObject({ status: 'REWRITTEN', revised: expect.stringContaining("years' pay"), moneyContext: [expect.stringMatching(/^M\d+$/)] });
    expect(passed.report!.totals.moneyContextAdded).toBe(1);
    const [k, j] = changed(passed.report!).flatMap(([ref]) => (ref === sum.ref ? [] : [ref as string]));
    expect(changed(passed.report!)).toHaveLength(3);
    expect(changed(passed.report!)).toEqual(changed(passed.report!).map(([ref]) => [ref, ['NARRATION'], [expect.stringMatching(/^N\d+: /)]]));

    // Reworded by hand after the pass (the sum without its context): the wording is the editor's; the pass, and the money context it gave, are credited only where its wording stands.
    await byHand(2, k!, (b) => ({ text: `${b.text} The clerks kept the tally (test).` }));
    await byHand(2, sum.ref!, () => ({ text: `${price} The clerks kept the tally (test).` }));
    const edited = await editorialOf(2);
    expect(changed(edited.report!)).toEqual(changed(passed.report!).map((x) => (x[0] === j ? x : [x[0], [], ['Edited by dashboard']])));
    expect(edited.report!.blocks.find((x) => x.ref === sum.ref)!.moneyContext).toEqual([]);
    expect(edited.report!.totals.moneyContextAdded).toBe(0);
    expect(edited.layers.find((l) => l.key === k)!.editorial).toEqual(['Edited by dashboard']);
    expect(edited.layers.find((l) => l.key === j)!.editorial).toEqual(passed.layers.find((l) => l.key === j)!.editorial);

    // v2 restored as v4: the copy carries v2's ledger, which is the pass's on v1 — nothing between v2 and v4 is the pass's, even where its wording stands.
    await app.inject({ method: 'POST', url: `/api/projects/${id}/script/restore`, payload: { version: 1 } });
    const restored = (await app.inject({ method: 'POST', url: `/api/projects/${id}/script/restore`, payload: { version: 2 } })).json<ScriptView>().script!;
    expect(restored).toMatchObject({ version: 4, origin: 'RESTORE', revisionOfVersion: 2 });
    expect(changed((await editorialOf(4)).report!)).toEqual([]);
    await byHand(4, j!, () => ({ infoClass: 'UNCERTAIN' }));
    expect(changed((await editorialOf(4)).report!)).toEqual([[j, [], ['Edited by dashboard']]]);
    expect(changed((await app.inject({ method: 'GET', url: `/api/projects/${id}/script/compare?a=2&b=4` })).json<ScriptCompareView>().changeReport!)).toEqual([[j, [], ['Edited by dashboard']]]);
    // …and its checklist keeps its name: the narration pass's, not a refinement's.
    expect(restored.content!.editor!.assessment!.length).toBeGreaterThan(0);
    expect(restored.qualityReport!.judgments!.find((x) => x.id === 'checklist')!.label).toMatch(/^Narration checklist/);
  });

  it('serves the house corpus, proposes house-style candidates from an approved script only, and puts one in retrieval only when a person approves it with a reason', async () => {
    const { app, c } = await start({}, { fakeScript: true });
    const corpus = (await app.inject({ method: 'GET', url: '/api/writing/corpus' })).json<WritingCorpusView>();
    expect(corpus.errors).toEqual([]);
    expect(corpus.examples.length).toBeGreaterThan(50);
    expect(corpus.examples.every((e) => e.origin === 'FILE' && e.copyrightSafe)).toBe(true);
    expect(corpus.rubric.dimensions).toHaveLength(10);
    expect(corpus.patterns.length).toBeGreaterThanOrEqual(18);
    expect(corpus.styleBible.sections.map((x) => x.title)).toContain('Money and numbers');

    const id = await drafted(app, c);
    const early = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/versions/1/house-candidates`, payload: {} });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/approved scripts only/);
    await app.inject({ method: 'POST', url: `/api/projects/${id}/approvals`, payload: { gate: 'SCRIPT', decision: 'APPROVED' } });
    // Two requests at once (two tabs, a client retry): each wording is saved once, and neither request fails.
    const both = await Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: `/api/projects/${id}/script/versions/1/house-candidates`, payload: {} })));
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    const [first, second] = both.map((r) => r.json<{ proposed: number; created: number }>());
    expect(first!.proposed).toBeGreaterThan(0);
    expect(second!.proposed).toBe(first!.proposed);
    expect(first!.created + second!.created).toBe(first!.proposed);
    // Proposing again creates nothing new: one candidate per wording.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/script/versions/1/house-candidates`, payload: {} })).json<{ created: number }>().created).toBe(0);
    const proposed = (await app.inject({ method: 'GET', url: '/api/writing/corpus' })).json<WritingCorpusView>();
    const candidates = proposed.house.filter((h) => h.status === 'CANDIDATE');
    expect(candidates).toHaveLength(first!.proposed);
    const one = candidates[0]!;
    // Candidates are not retrieved.
    expect(proposed.examples.some((e) => e.id === one.exampleId)).toBe(false);
    const noReason = await app.inject({ method: 'POST', url: `/api/writing/examples/${one.id}/decision`, payload: { decision: 'APPROVE' } });
    expect(noReason.statusCode).toBe(409);
    expect(noReason.json().message).toMatch(/why it works/);
    // A model to avoid says why it fails, or retrieval could not read it: refused, not approved and then left out.
    const bad = await app.inject({ method: 'POST', url: `/api/writing/examples/${one.id}/decision`, payload: { decision: 'APPROVE', quality: 'bad', whyItWorks: 'The sum is right (test).' } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().message).toMatch(/why it fails/);
    const ok = await app.inject({ method: 'POST', url: `/api/writing/examples/${one.id}/decision`, payload: { decision: 'APPROVE', whyItWorks: 'Plain, specific and in proportion (test).' } });
    expect(ok.json<WritingExampleView>()).toMatchObject({ status: 'APPROVED', whyItWorks: 'Plain, specific and in proportion (test).', reviewedBy: expect.any(String) });
    const after = (await app.inject({ method: 'GET', url: '/api/writing/corpus' })).json<WritingCorpusView>();
    expect(after.examples.find((e) => e.id === one.exampleId)).toMatchObject({ origin: 'HOUSE', approvedForRetrieval: true });
    expect(after.version).not.toBe(corpus.version);
    expect((await app.inject({ method: 'POST', url: `/api/writing/examples/${one.id}/decision`, payload: { decision: 'REJECT' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/writing/examples/${one.id}/decision`, payload: { decision: 'RETIRE' } })).json<WritingExampleView>().status).toBe('RETIRED');
    expect((await app.inject({ method: 'GET', url: '/api/writing/corpus' })).json<WritingCorpusView>().examples.some((e) => e.id === one.exampleId)).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/writing/examples/00000000-0000-7000-8000-000000000000/decision', payload: { decision: 'REJECT' } })).statusCode).toBe(404);
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

describe('voice API', () => {
  const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];
  const voice = async (app: FastifyInstance, id: string, q = '') => (await app.inject({ method: 'GET', url: `/api/projects/${id}/voice${q}` })).json<VoiceView>();

  /** A project with an approved script v1 (synthetic dossier, fake model). */
  async function approvedScript(app: FastifyInstance, c: AppContainer) {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 } })).json<ProjectDetailView>();
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/mine`, payload: {} });
    await c.runner.drain();
    const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
    (c.providers.ai as FakeScriptAI).architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/story/architecture`, payload: {} });
    await c.runner.drain();
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'STORY', decision: 'APPROVED' } });
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script`, payload: {} });
    await c.runner.drain();
    const approved = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/approvals`, payload: { gate: 'SCRIPT', decision: 'APPROVED' } });
    expect(approved.json<ProjectDetailView>().status).toBe('SCRIPT_APPROVED');
    return p.id;
  }

  it('plans and generates an audition, streams takes with byte ranges, answers "what is said at", takes decisions and keeps the gate shut for an audition', async () => {
    const { app, c } = await start({}, { fakeScript: true });
    const id = await approvedScript(app, c);
    let v = await voice(app, id);
    expect(v).toMatchObject({ script: { version: 1 }, provider: { name: 'mock', mock: true, durableStorage: false }, runs: [], run: null, editorial: { generate: { allowed: true } } });

    const plan = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice/plan`, payload: { scope: { kind: 'AUDITION', seconds: 60 } } });
    expect(plan.statusCode).toBe(200);
    const planned = plan.json<VoicePlanView>();
    expect(planned).toMatchObject({ blocked: null, estimate: { costBasis: 'MOCK' }, profile: { provider: 'mock', version: 1 } });
    expect(planned.chunks.length).toBeGreaterThan(1);

    const created = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice/runs`, payload: { scope: { kind: 'AUDITION', seconds: 60 } } });
    expect(created.statusCode).toBe(202);
    expect(created.json<{ job: JobView; run: number }>()).toMatchObject({ job: { type: 'VOICE', status: 'QUEUED' }, run: 1 });
    await c.runner.drain();
    v = await voice(app, id);
    expect(v.project.status).toBe('VOICE_REVIEW');
    const run = v.run!;
    expect(run).toMatchObject({ number: 1, kind: 'AUDITION', chunkCount: planned.chunks.length });

    // Audio: the whole file, then a byte range (players seek with ranges).
    const audioUrl = run.chunks[0]!.current!.audioUrl!;
    const full = await app.inject({ method: 'GET', url: audioUrl });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['x-audio-mock']).toBe('true');
    const part = await app.inject({ method: 'GET', url: audioUrl, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${full.rawPayload.length}`);
    expect(part.rawPayload.length).toBe(100);
    expect((await app.inject({ method: 'GET', url: audioUrl, headers: { range: `bytes=${full.rawPayload.length + 10}-` } })).statusCode).toBe(416);
    const assembled = await app.inject({ method: 'GET', url: run.assembly!.audioUrl });
    expect(assembled.statusCode).toBe(200);
    expect(assembled.rawPayload.length).toBeGreaterThan(full.rawPayload.length);

    // "What is being said at 00:01?" and the timeline contract.
    const moment = await app.inject({ method: 'GET', url: `/api/projects/${id}/voice/moment?run=1&at=00:01` });
    expect(moment.json<VoiceMomentView>()).toMatchObject({ run: 1, chunk: 1, between: false, part: { audioChunk: { index: 0, audioAssetId: run.chunks[0]!.current!.audioUrl!.split('/').pop() }, approved: false } });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/voice/moment?run=1&at=later` })).statusCode).toBe(409);
    const timelineOf = async () => (await app.inject({ method: 'GET', url: `/api/projects/${id}/voice/timeline?run=1` })).json<NarrationTimelineView>();
    let timeline = await timelineOf();
    expect(timeline).toMatchObject({ run: 1, scriptVersion: 1, assembly: 1, status: 'IN_REVIEW', complete: false });
    expect(timeline.entries).toHaveLength(run.chunkCount);
    // Section, block, chunk, the take's audio file, clock, words, performance and approval: what the storyboard reads.
    expect(timeline.timeline[0]).toMatchObject({ scriptBlock: { key: run.chunks[0]!.blockKeys[0], sectionKey: run.chunks[0]!.sectionKey }, audioChunk: { index: 0, generationId: run.chunks[0]!.current!.id }, approved: false });
    expect(timeline.timeline.every((t) => `/api/voice/audio/${t.audioChunk.audioAssetId}` === run.chunks[t.audioChunk.index]!.current!.audioUrl && t.words.length > 0 && t.performance && t.endMs > t.startMs)).toBe(true);
    expect(timeline.entries.map((e) => `/api/voice/audio/${e.audioAssetId}`)).toEqual(run.chunks.map((ch) => ch.current!.audioUrl));

    // Decisions: approve one take (the timeline says so at once), regenerate another (the first take is kept).
    const take = run.chunks[0]!.current!;
    expect((await app.inject({ method: 'POST', url: `/api/voice/generations/${take.id}/decision`, payload: { action: 'APPROVE' } })).statusCode).toBe(200);
    timeline = await timelineOf();
    expect(timeline.timeline.map((t) => t.approved)).toEqual(timeline.timeline.map((t) => t.audioChunk.index === 0));
    expect((await app.inject({ method: 'POST', url: `/api/voice/runs/${run.id}/regenerate`, payload: { chunkIds: [run.chunks[1]!.id] } })).statusCode).toBe(202);
    await c.runner.drain();
    v = await voice(app, id);
    expect(v.run!.chunks[0]!.current).toMatchObject({ status: 'APPROVED' });
    expect(v.run!.chunks[1]!.generations.map((g) => [g.generation, g.status])).toEqual([
      [2, 'IN_REVIEW'],
      [1, 'SUPERSEDED'],
    ]);
    expect(v.run!.assemblies.map((a) => a.version)).toEqual([2, 1]);
    expect((await timelineOf()).assembly).toBe(2);

    // Comparisons and A/B takes buy several narrations of the same words: always confirmed.
    const experiment = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice/experiments`, payload: { scope: { kind: 'AUDITION', seconds: 20 }, name: 'Tiny (test)', variants: [{ strategy: 'PLAIN' }, { strategy: 'RESTRAINED' }] } });
    expect(experiment.statusCode).toBe(409);
    expect(experiment.json<{ message: string }>().message).toMatch(/^Comparison: \d+ characters .* across 2 variants — confirm to go ahead$/);
    const ab = { chunkIds: [run.chunks[2]!.id], variants: [{ label: 'A neutral' }, { label: 'B expressive', strategy: 'EXPRESSIVE' }] };
    expect((await app.inject({ method: 'POST', url: `/api/voice/runs/${run.id}/regenerate`, payload: ab })).statusCode).toBe(409);
    const queued = await app.inject({ method: 'POST', url: `/api/voice/runs/${run.id}/regenerate`, payload: { ...ab, confirm: true } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json<{ takes: number }>().takes).toBe(2);
    await c.runner.drain();
    v = await voice(app, id);
    expect(v.run!.chunks[2]!.generations.map((g) => [g.variant, g.status, g.current])).toEqual([
      ['B expressive', 'GENERATED', false],
      ['A neutral', 'GENERATED', false],
      [null, 'IN_REVIEW', true],
    ]);

    // An audition is not the narration.
    const gate = await app.inject({ method: 'POST', url: `/api/projects/${id}/approvals`, payload: { gate: 'VOICE', decision: 'APPROVED' } });
    expect(gate.statusCode).toBe(409);
    expect(gate.json<{ message: string }>().message).toMatch(/No full narration of script v1/);

    // A new profile version becomes the active one; the old one is kept.
    const profile = await app.inject({ method: 'POST', url: `/api/projects/${id}/voice/profiles`, payload: { settings: { stability: 0.4 }, notes: 'A little more expressive (test).' } });
    expect(profile.statusCode).toBe(201);
    v = await voice(app, id);
    expect(v.profiles.map((p) => [p.version, p.active, p.config.settings.stability])).toEqual([
      [2, true, 0.4],
      [1, false, 0.5],
    ]);
    // Pronunciation decisions are validated.
    const term = v.pronunciations[0];
    if (term) {
      expect((await app.inject({ method: 'PATCH', url: `/api/voice/pronunciations/${term.id}`, payload: { method: 'IPA', status: 'APPROVED' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/api/voice/pronunciations/${term.id}`, payload: { method: 'DEFAULT', status: 'APPROVED' } })).statusCode).toBe(200);
    }
  });

  it('refuses to plan narration where there is no real script stage', async () => {
    const { app } = await start();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/voice/plan`, payload: { scope: { kind: 'AUDITION', seconds: 60 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/needs a real script stage/);
  });
});
