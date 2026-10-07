import { randomUUID } from 'node:crypto';
import type { NarrationTimelineView } from '@docengine/core';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { FakeScriptAI } from '@docengine/script/testing';
import { seedFakeDossier } from '@docengine/story/testing';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { createContainer, type AppContainer } from './container.ts';
import { parseEnv } from './env.ts';

/**
 * The narration timeline of one assembly version by id, through the API
 * (MOCK voice): an older version after a newer one exists, with the run,
 * script, profile and language version behind it. 400 for an id that is not
 * one, 404 for an unknown assembly, 409 for one whose stored JSON does not
 * parse.
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

async function start() {
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent' });
  const c = createContainer(env, pino({ level: 'silent' }), { db, providers: { ...createProviders(ALL_MOCK), ai: new FakeScriptAI() } });
  const app = await buildApp(c);
  open.push({ app, c });
  return { app, c };
}

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project whose script is approved (synthetic dossier, fake model). */
async function approvedScript(c: AppContainer): Promise<string> {
  const p = await c.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, 'editor');
  await c.runner.drain();
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  (c.providers.ai as FakeScriptAI).architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await c.projects.generateScript(p.id, {}, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  return p.id;
}

describe('assembly timeline through the API', () => {
  it('GET /api/voice/assemblies/:id/timeline: an older version by id with the rows behind it; 400, 404 and 409', async () => {
    const { app, c } = await start();
    const id = await approvedScript(c);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/voice/runs`, payload: { scope: { kind: 'AUDITION', seconds: 60 } } })).statusCode).toBe(202);
    await c.runner.drain();
    const run = await db.voiceRun.findFirstOrThrow({ where: { projectId: id }, include: { chunks: { orderBy: { chunkIndex: 'asc' } } } });
    expect((await app.inject({ method: 'POST', url: `/api/voice/runs/${run.id}/regenerate`, payload: { chunkIds: [run.chunks[1]!.id] } })).statusCode).toBe(202);
    await c.runner.drain();
    const [v1, v2] = await db.voiceAssembly.findMany({ where: { runId: run.id }, orderBy: { version: 'asc' } });

    const res = await app.inject({ method: 'GET', url: `/api/voice/assemblies/${v1!.id}/timeline` });
    expect(res.statusCode).toBe(200);
    const older = res.json<NarrationTimelineView>();
    expect(older).toMatchObject({
      run: 1,
      scriptVersion: 1,
      assembly: 1,
      assemblyId: v1!.id,
      runId: run.id,
      scriptId: run.scriptId,
      profileId: run.profileId,
      runKind: 'AUDITION',
      scopeBlockKeys: (run.scope as { blockKeys: string[] }).blockKeys,
      languageVersionId: run.languageVersionId,
      status: 'SUPERSEDED',
      complete: false,
      totalDurationMs: v1!.totalDurationMs,
    });
    // The take v1 was assembled with, not the chunk's current one.
    expect(older.entries[1]!.generationId).not.toBe((await db.voiceChunk.findUniqueOrThrow({ where: { id: run.chunks[1]!.id } })).currentGenerationId);
    expect(older.timeline.length).toBeGreaterThanOrEqual(older.entries.length);
    // The run's timeline is the latest version, with the same ids.
    const latest = (await app.inject({ method: 'GET', url: `/api/projects/${id}/voice/timeline?run=1` })).json<NarrationTimelineView>();
    expect(latest).toMatchObject({ assembly: 2, assemblyId: v2!.id, runId: run.id, runKind: 'AUDITION', status: 'IN_REVIEW' });

    expect((await app.inject({ method: 'GET', url: '/api/voice/assemblies/not-an-id/timeline' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: `/api/voice/assemblies/${randomUUID()}/timeline` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: string }>().error).toBe('NOT_FOUND');

    // A version whose stored JSON does not parse is refused with what it is (409), never shown empty; the other versions still read.
    await db.voiceAssembly.update({ where: { id: v1!.id }, data: { timeline: [{ startMs: 0 }] } });
    const unreadable = await app.inject({ method: 'GET', url: `/api/voice/assemblies/${v1!.id}/timeline` });
    expect(unreadable.statusCode).toBe(409);
    expect(unreadable.json<{ error: string; message: string }>()).toMatchObject({ error: 'CONFLICT', message: expect.stringMatching(/^Assembly v1 of voice run 1: its timeline cannot be read \(0\.scriptBlock: /) });
    expect((await app.inject({ method: 'GET', url: `/api/voice/assemblies/${v2!.id}/timeline` })).statusCode).toBe(200);
  });
});
