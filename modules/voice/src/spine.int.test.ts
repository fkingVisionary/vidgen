import { randomUUID } from 'node:crypto';
import { NarrationAlignment, NarrationSpine, NarrationTimelineEntry, VoiceQaFinding } from '@docengine/core';
import { Prisma } from '@docengine/database';
import { ConflictError, JobRunner, NotFoundError, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { createScriptStage } from '@docengine/script';
import { FakeScriptAI } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { voiceGate } from './gate.ts';
import { readEntries } from './runs.ts';
import { VoiceService } from './service.ts';
import { SpineError, narrationFingerprint, narrationSpine } from './spine.ts';
import { createVoiceStage } from './stage.ts';

/**
 * The voice engine's read API for the storyboard, against a real database
 * with the MOCK voice: the spine of one assembly version (entries, chunks'
 * spans and text, the takes the entries name), its fingerprint across
 * regeneration and restore, the timeline of an older version by id, and
 * strict reading of stored JSON. Nothing here writes narration but the
 * voice engine itself.
 */

const db = useTestDatabase();

function setup() {
  const ai = new FakeScriptAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai };
  const projects = new ProjectService({ db, gateHooks: { VOICE: voiceGate() } });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    handlers: { ...createMockStageHandlers(), STORY_MINING: createStoryMiningStage(), STORY_ARCHITECTURE: createStoryArchitectureStage(), SCRIPT: createScriptStage(), VOICE: createVoiceStage({ concurrency: 2 }) },
    retryBaseDelayMs: 0,
  });
  const service = new VoiceService({ db, projects, providers, config: { confirmCharacters: 3000, maxCharacters: 40_000 } });
  return { ai, projects, runner, service };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project with an approved script v1 and an opening audition narrated with the MOCK voice (synthetic dossier, fake model). */
async function narrated(s: Setup): Promise<{ projectId: string; runId: string; number: number }> {
  const p = await s.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  await s.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, 'editor');
  await s.runner.drain();
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  s.ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await s.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, 'editor');
  await s.runner.drain();
  await s.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await s.projects.generateScript(p.id, {}, 'editor');
  await s.runner.drain();
  await s.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  const { run: number } = await s.service.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
  await s.runner.drain();
  const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId: p.id, number } } });
  return { projectId: p.id, runId: run.id, number };
}

const versions = (runId: string) => db.voiceAssembly.findMany({ where: { runId }, orderBy: { version: 'asc' } });

describe('narration spine (MOCK voice, real database)', () => {
  it('reads an assembly by id: its clips, the chunks\' spans and text, the takes it names, strictly', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    const run = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } } } });
    const [assembly] = await versions(runId);
    const spine = (await narrationSpine(db, assembly!.id))!;
    expect(NarrationSpine.parse(spine)).toEqual(spine);

    const entries = readEntries(assembly!.entries);
    expect(spine.assembly).toEqual({
      id: assembly!.id,
      runId,
      version: 1,
      status: 'IN_REVIEW',
      complete: false,
      totalDurationMs: assembly!.totalDurationMs,
      fingerprint: narrationFingerprint(entries),
      profileId: run.profileId,
      scriptId: run.scriptId,
      languageVersionId: run.languageVersionId,
    });
    expect(spine.run).toEqual({ id: runId, number: run.number, kind: 'AUDITION', scopeBlockKeys: (run.scope as { blockKeys: string[] }).blockKeys });
    expect(spine.run.scopeBlockKeys).toEqual([...new Set(run.chunks.flatMap((c) => c.blockKeys))]);
    expect(spine.entries).toEqual(entries);
    expect(spine.timeline).toEqual(z.array(NarrationTimelineEntry).parse(assembly!.timeline));
    expect(spine.chunks).toEqual(run.chunks.map((c) => ({ id: c.id, index: c.chunkIndex, sectionKey: c.sectionKey, spans: c.spans, sourceText: c.sourceText })));

    // One take per clip, the one the entry names, with its word timings, audio file and status; MOCK audio says so.
    expect(spine.takes.map((t) => t.id)).toEqual(entries.map((e) => e.generationId));
    for (const t of spine.takes) {
      const row = run.chunks.find((c) => c.id === t.chunkId)!.current!;
      expect(t).toEqual({
        id: row.id,
        chunkId: row.chunkId,
        status: 'IN_REVIEW',
        durationMs: row.durationMs,
        alignment: NarrationAlignment.parse(row.alignment),
        audioAssetId: row.audioAssetId,
        mock: true,
        qaBlocking: z.array(VoiceQaFinding).parse(row.qa).some((f) => f.severity === 'BLOCKING'),
      });
      // Word offsets are in the chunk's canonical text.
      const text = spine.chunks.find((c) => c.id === t.chunkId)!.sourceText;
      expect(t.alignment!.words.length).toBeGreaterThan(0);
      expect(t.alignment!.words.every((w) => text.slice(w.start, w.end) === w.word)).toBe(true);
    }
    // The takes' word times on the assembled clock are the stored timeline's.
    const clock = spine.entries.flatMap((e) => spine.takes.find((t) => t.id === e.generationId)!.alignment!.words.map((w) => [w.word, e.startMs + w.startMs]));
    expect(clock).toEqual(spine.timeline.flatMap((p) => p.words.map((w) => [w.word, w.startMs])));

    // An unknown assembly is none; stored JSON that does not parse is refused, never read as empty.
    expect(await narrationSpine(db, randomUUID())).toBeNull();
    await expect(s.service.timelineOf(randomUUID())).rejects.toThrow(NotFoundError);
    await db.voiceAssembly.update({ where: { id: assembly!.id }, data: { timeline: [{ startMs: 0 }] } });
    await expect(narrationSpine(db, assembly!.id)).rejects.toThrow(SpineError);
    await expect(narrationSpine(db, assembly!.id)).rejects.toThrow(/^Assembly v1 of voice run 1: its timeline cannot be read \(0\.scriptBlock: /);
    await expect(s.service.timelineOf(assembly!.id)).rejects.toThrow(ConflictError);
    await expect(s.service.timeline(projectId, run.number)).rejects.toThrow(/^Assembly v1 of voice run 1: its timeline cannot be read/);
    await db.voiceAssembly.update({ where: { id: assembly!.id }, data: { timeline: assembly!.timeline as Prisma.InputJsonValue } });
    const take = run.chunks[1]!.current!;
    await db.voiceGeneration.update({ where: { id: take.id }, data: { alignment: { source: 'MOCK', words: 'none' } } });
    await expect(narrationSpine(db, assembly!.id)).rejects.toThrow(/^Assembly v1 of voice run 1, chunk 2: the word timings of take 1 cannot be read/);
    // Clips that do not tile the assembly's length are refused too: no gap and no overlap on the clock.
    await db.voiceGeneration.update({ where: { id: take.id }, data: { alignment: take.alignment as Prisma.InputJsonValue } });
    expect(await narrationSpine(db, assembly!.id)).toEqual(spine);
    await db.voiceAssembly.update({ where: { id: assembly!.id }, data: { totalDurationMs: assembly!.totalDurationMs + 1 } });
    await expect(narrationSpine(db, assembly!.id)).rejects.toThrow(`Assembly v1 of voice run 1: it lasts ${assembly!.totalDurationMs + 1} ms, its clips and pauses ${assembly!.totalDurationMs} ms`);
  });

  it('pins each version to its own takes: after a regeneration and a restore each version reads its own, identical clips share a fingerprint, and an older version\'s timeline is read by id', async () => {
    const s = setup();
    const { projectId, runId, number } = await narrated(s);
    const run = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' } } } });
    const target = run.chunks[1]!;
    const firstTake = target.currentGenerationId!;
    await s.service.regenerate(runId, { chunkIds: [target.id] }, 'editor');
    await s.runner.drain();
    const secondTake = (await db.voiceChunk.findUniqueOrThrow({ where: { id: target.id } })).currentGenerationId!;
    expect(secondTake).not.toBe(firstTake);
    const [v1, v2] = await versions(runId);
    expect([v1!.status, v2!.status]).toEqual(['SUPERSEDED', 'IN_REVIEW']);

    // v1 still reads the take it was assembled with, now superseded, not the chunk's current take.
    const one = (await narrationSpine(db, v1!.id))!;
    const two = (await narrationSpine(db, v2!.id))!;
    const takeOf = (sp: NarrationSpine, chunkId: string) => sp.takes.find((t) => t.chunkId === chunkId)!;
    expect(takeOf(one, target.id)).toMatchObject({ id: firstTake, status: 'SUPERSEDED' });
    expect(takeOf(two, target.id)).toMatchObject({ id: secondTake, status: 'IN_REVIEW' });
    expect(one.assembly).toMatchObject({ version: 1, status: 'SUPERSEDED' });
    expect(two.assembly.fingerprint).not.toBe(one.assembly.fingerprint);

    // The older version's timeline by id, with the rows behind it; the run's timeline is the latest, with the same ids.
    const older = await s.service.timelineOf(v1!.id);
    expect(older).toMatchObject({
      run: number,
      scriptVersion: 1,
      assembly: 1,
      assemblyId: v1!.id,
      runId,
      scriptId: run.scriptId,
      profileId: run.profileId,
      runKind: 'AUDITION',
      scopeBlockKeys: one.run.scopeBlockKeys,
      languageVersionId: run.languageVersionId,
      status: 'SUPERSEDED',
      totalDurationMs: v1!.totalDurationMs,
    });
    expect(older.entries.map((e) => e.generationId)).toEqual(one.entries.map((e) => e.generationId));
    expect(older.timeline.filter((p) => p.audioChunk.id === target.id).every((p) => p.audioChunk.generationId === firstTake && !p.approved)).toBe(true);
    const latest = await s.service.timeline(projectId, number);
    expect(latest).toMatchObject({ assembly: 2, assemblyId: v2!.id, runId, runKind: 'AUDITION', languageVersionId: run.languageVersionId, status: 'IN_REVIEW' });
    expect(latest.entries.map((e) => e.generationId)).toEqual(two.entries.map((e) => e.generationId));

    // Restoring the first take rebuilds the clips of v1 as v3: the same fingerprint (the narration heard is the same).
    await s.service.decide(firstTake, { action: 'RESTORE' }, 'editor');
    const v3 = (await versions(runId))[2]!;
    const three = (await narrationSpine(db, v3.id))!;
    expect(three.assembly.version).toBe(3);
    expect(three.entries).toEqual(one.entries);
    expect(three.assembly.fingerprint).toBe(one.assembly.fingerprint);
    // Approving a take changes no clip: the same assembly, the same fingerprint, the take read as approved.
    await s.service.decide(firstTake, { action: 'APPROVE' }, 'editor');
    const approved = (await narrationSpine(db, v3.id))!;
    expect(await versions(runId)).toHaveLength(3);
    expect(approved.assembly.fingerprint).toBe(three.assembly.fingerprint);
    expect(takeOf(approved, target.id)).toMatchObject({ id: firstTake, status: 'APPROVED' });
    expect((await s.service.timelineOf(v3.id)).timeline.filter((p) => p.audioChunk.id === target.id).every((p) => p.approved)).toBe(true);
  });
});
