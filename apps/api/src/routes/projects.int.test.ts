import type { ProjectDetailView } from '@docengine/core';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { FakeScriptAI } from '@docengine/script/testing';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../../test/helpers.ts';
import { buildApp } from '../app.ts';
import { createContainer } from '../container.ts';
import { parseEnv } from '../env.ts';

/** The generic job route and the stages that start through their own routes. */

const db = useTestDatabase();

async function start(real: boolean) {
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_DIST_DIR: '/nonexistent' });
  const c = createContainer(env, pino({ level: 'silent' }), { db, ...(real ? { providers: { ...createProviders(ALL_MOCK), ai: new FakeScriptAI() } } : {}) });
  return { c, app: await buildApp(c) };
}

describe('POST /api/projects/:id/jobs', () => {
  it('refuses a bare VOICE job when narration is real, pointing to the voice routes', async () => {
    const { c, app } = await start(true);
    try {
      expect(c.realStages).toContain('VOICE');
      const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
      const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'VOICE' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CONFLICT', message: 'Use POST /api/projects/:id/voice/runs to generate narration' });
      expect(await db.job.count({ where: { projectId: p.id } })).toBe(0);
    } finally {
      await app.close();
      await c.close();
    }
  });

  it('leaves the placeholder VOICE stage to the pipeline when narration is MOCK', async () => {
    const { c, app } = await start(false);
    try {
      expect(c.realStages).not.toContain('VOICE');
      const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: tulipInput })).json<ProjectDetailView>();
      const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/jobs`, payload: { type: 'VOICE' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).not.toMatch(/voice\/runs/);
    } finally {
      await app.close();
      await c.close();
    }
  });
});
