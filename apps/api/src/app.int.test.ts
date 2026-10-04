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

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

async function start(extraEnv: Record<string, string> = {}) {
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_DIST_DIR: '/nonexistent', ...extraEnv });
  const c = createContainer(env, pino({ level: 'silent' }), { db });
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
    expect(afterJob.costs).toEqual({ estimatedUsd: null, actualUsd: 0, providerCalls: 1, mockCalls: 1 });
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
