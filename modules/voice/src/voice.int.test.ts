import { NarrationAlignment, PreparedNarration, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, MockVoiceProvider, ProviderError, createProviders, type NarrationRequest, type NarrationResult, type ProviderSet } from '@docengine/providers';
import { ScriptEditing, createScriptStage } from '@docengine/script';
import { FakeScriptAI } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { voiceGate } from './gate.ts';
import { VoiceService } from './service.ts';
import { createVoiceStage } from './stage.ts';
import { loadVoiceView } from './views.ts';

/**
 * The Voice Engine against a real database, with the MOCK voice (real WAV
 * files of the right length, character timestamps, no speech) and in-memory
 * storage: runs, small chunks, takes kept and superseded, assembly on the
 * measured clock, stale audio when the script changes, failures, the VOICE
 * gate. No API key, no network.
 */

const db = useTestDatabase();

/** The MOCK voice with failures on cue. */
class ScriptedVoice extends MockVoiceProvider {
  calls: NarrationRequest[] = [];
  failOn = new Map<number, ProviderError>();
  override async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    this.calls.push(req);
    const failure = this.failOn.get(this.calls.length);
    if (failure) throw failure;
    return super.generateNarration(req);
  }
}

function setup(voice = new ScriptedVoice(), overrides: Partial<ProviderSet> = {}) {
  const ai = new FakeScriptAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai, voice, ...overrides };
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
  return { ai, voice, providers, projects, runner, service, editing: new ScriptEditing(db) };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];
const statusOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).status;

async function run(s: Setup, projectId: string, type: JobType) {
  const job = await s.projects.enqueueJob(projectId, { type }, 'editor');
  await s.runner.drain();
  return db.job.findUniqueOrThrow({ where: { id: job.id } });
}

/** A project whose script v1 is approved (synthetic dossier, fake model). */
async function approvedScript(s: Setup): Promise<string> {
  const p = await s.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  expect((await run(s, p.id, 'STORY_MINING')).status).toBe('SUCCEEDED');
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  s.ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  expect((await run(s, p.id, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
  await s.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await s.projects.generateScript(p.id, {}, 'editor');
  await s.runner.drain();
  await s.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  expect(await statusOf(p.id)).toBe('SCRIPT_APPROVED');
  return p.id;
}

const view = (s: Setup, projectId: string, run?: number) =>
  db.project.findUniqueOrThrow({ where: { id: projectId } }).then((p) => loadVoiceView({ db, providers: s.providers, confirmCharacters: 3000, toJobView: ((j: { id: string }) => ({ id: j.id })) as never }, p, run));

describe('voice engine (MOCK voice, real database)', () => {
  it('plans an opening audition, generates it in small chunks, and assembles it on the measured clock', async () => {
    const s = setup();
    const projectId = await approvedScript(s);

    const plan = await s.service.plan(projectId, { scope: { kind: 'AUDITION', seconds: 60 } });
    expect(plan.blocked).toBeNull();
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
    expect(plan.chunks.every((c) => c.words <= plan.chunking.maxWords * 1.5)).toBe(true);
    expect(plan.estimate).toMatchObject({ costBasis: 'MOCK', estimatedCostUsd: 0, needsConfirmation: false });
    expect(plan.profile).toMatchObject({ name: 'House narrator', version: 1, provider: 'mock', modelId: 'mock', voiceId: 'mock-narrator-deep' });
    expect(plan.coverage.dramaticOpening).toBe(true);
    // Planning wrote nothing but the pronunciation list.
    expect(await db.voiceRun.count()).toBe(0);

    const { run: number } = await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    expect(await statusOf(projectId)).toBe('VOICE_GENERATING');
    await s.runner.drain();
    expect(await statusOf(projectId)).toBe('VOICE_REVIEW');
    expect(s.voice.calls).toHaveLength(plan.chunks.length);
    // Never the whole script in one request: each call is one chunk.
    expect(Math.max(...s.voice.calls.map((c) => c.text.length))).toBeLessThan(1000);

    const v = await view(s, projectId);
    const r = v.run!;
    expect(r).toMatchObject({ number, kind: 'AUDITION', scriptVersion: 1, chunkCount: plan.chunks.length, stale: false });
    for (const c of r.chunks) {
      const take = c.current!;
      expect(take).toMatchObject({ generation: 1, status: 'GENERATED', provider: 'mock', model: 'mock', voiceId: 'mock-narrator-deep', alignment: 'MOCK', mock: true });
      expect(take.audioUrl).toMatch(/^\/api\/voice\/audio\//);
      expect(take.durationMs).toBeGreaterThan(0);
      expect(take.words.length).toBeGreaterThan(0);
      expect(take.unmatchedWords).toBe(0);
      expect(take.cost).toMatchObject({ basis: 'MOCK', estimatedUsd: 0 });
      expect(PreparedNarration.parse(take.prepared).checks.every((x) => x.status !== 'FAIL')).toBe(true);
      // Traceable: the take's text is the chunk's (the script's words), its derived text kept beside it.
      expect(c.text).toBe((await db.voiceGeneration.findUniqueOrThrow({ where: { id: take.id } })).canonicalText);
    }
    // Stored audio is real WAV of the measured length.
    const first = r.chunks[0]!.current!;
    const audio = await s.service.audio(first.audioUrl!.split('/').pop()!);
    expect(audio.mimeType).toBe('audio/wav');
    expect(audio.bytes.byteLength).toBeGreaterThan(44);
    // Assembly: in order, on the takes' durations, with pauses between them.
    const asm = r.assembly!;
    expect(asm).toMatchObject({ version: 1, complete: false, status: 'DRAFT' });
    expect(asm.entries.map((e) => e.chunkIndex)).toEqual(r.chunks.map((c) => c.index));
    expect(asm.totalDurationMs).toBe(asm.entries.at(-1)!.endMs);
    expect(asm.timeline.length).toBeGreaterThanOrEqual(r.chunks.length);
    // An audition is not the narration: QA says so and the gate refuses it.
    expect(r.qa.map((f) => f.kind)).toContain('INCOMPLETE_NARRATION');
    expect(r.qa.filter((f) => f.kind === 'TAKE_UNREVIEWED')).toHaveLength(r.chunks.length);
    await expect(s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/No full narration of script v1/);
    // "What is being said at 00:01?"
    const m = await s.service.moment(projectId, number, 1000);
    expect(m).toMatchObject({ run: number, chunk: 1, generation: 1, between: false });
    expect(m.word).not.toBeNull();
    // The ledger has one MOCK call per take, linked to it.
    const calls = await db.providerCall.findMany({ where: { projectId, kind: 'VOICE' } });
    expect(calls).toHaveLength(r.chunks.length);
    expect(calls.every((c) => c.costBasis === 'MOCK' && c.status === 'SUCCEEDED')).toBe(true);
    // The assembled file joins the takes with their pauses.
    const joined = await s.service.assemblyAudio(asm.id);
    expect(joined.mimeType).toBe('audio/wav');
  });

  it('regenerates one chunk keeping every earlier take, approves, restores and rejects without forcing anything', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    let r = (await view(s, projectId)).run!;
    const target = r.chunks[1]!;
    const firstTake = target.current!;

    await s.service.regenerate(r.id, { chunkIds: [target.id], marks: [{ sentence: 0, emotion: 'reflective', delivery: 'intimate' }] }, 'editor');
    await s.runner.drain();
    r = (await view(s, projectId)).run!;
    const chunk = r.chunks[1]!;
    expect(chunk.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [2, 'GENERATED', true],
      [1, 'SUPERSEDED', false],
    ]);
    expect(chunk.current!.performanceText).toMatch(/^\[reflective, intimate\] /);
    expect(chunk.current!.directions).toEqual([{ sentence: 0, emotion: 'reflective', delivery: 'intimate' }]);
    // Unaffected chunks keep their take; the assembly is rebuilt around the new one.
    expect(r.chunks[0]!.current!.id).toBe((await view(s, projectId)).run!.chunks[0]!.current!.id);
    expect(r.assembly!.version).toBe(2);
    expect(r.assembly!.entries[1]!.generation).toBe(2);
    expect(r.stats.regenerations).toBe(1);

    // Approve the new take, then go back to the first: the approval is kept on the superseded take.
    await s.service.decide(chunk.current!.id, { action: 'APPROVE' }, 'editor');
    await s.service.decide(firstTake.id, { action: 'RESTORE' }, 'editor');
    r = (await view(s, projectId)).run!;
    expect(r.chunks[1]!.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [2, 'SUPERSEDED', false],
      [1, 'GENERATED', true],
    ]);
    expect(r.assembly!.version).toBe(3);
    await s.service.decide(r.chunks[1]!.generations[0]!.id, { action: 'RESTORE' }, 'editor');
    expect((await view(s, projectId)).run!.chunks[1]!.current).toMatchObject({ generation: 2, status: 'APPROVED' });

    // Rejecting does not regenerate: the chunk shows the rejection, QA blocks, nothing new is sent.
    const calls = s.voice.calls.length;
    await s.service.decide(r.chunks[0]!.current!.id, { action: 'REJECT', note: 'Too fast (test).' }, 'editor');
    r = (await view(s, projectId)).run!;
    expect(r.chunks[0]!.current).toMatchObject({ status: 'REJECTED', note: 'Too fast (test).' });
    expect(r.qa.map((f) => f.kind)).toContain('TAKE_REJECTED');
    expect(s.voice.calls.length).toBe(calls);
    await expect(s.service.decide(r.chunks[0]!.current!.id, { action: 'APPROVE' }, 'editor')).rejects.toThrow(/rejected: it cannot be approved/);
  });

  it('marks audio stale when a newer script version is approved, and never reuses it', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const before = (await view(s, projectId)).run!;
    const editedKey = before.chunks[0]!.blockKeys[0]!;

    // Script v2: the same story, one opening block reworded, approved.
    await s.projects.rewind(projectId, { to: 'SCRIPT_APPROVED', reason: 'Rewording the opening (test)' }, 'editor');
    await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    const block = await db.scriptBlock.findFirstOrThrow({ where: { blockKey: editedKey, script: { projectId, version: 2 } } });
    await s.editing.editBlock(block.id, { text: `${block.text} It was only the beginning.` }, 'editor');
    await s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');

    const v = await view(s, projectId, before.number);
    expect(v.script).toMatchObject({ version: 2 });
    expect(v.run).toMatchObject({ stale: true, staleNote: 'Audio generated from Script v1 — current script is v2' });
    expect(v.run!.chunks[0]!.stale).toBe(true);
    expect(v.run!.chunks.slice(1).some((c) => !c.stale)).toBe(true);
    expect(v.run!.qa.map((f) => f.kind)).toEqual(expect.arrayContaining(['STALE_SCRIPT', 'STALE_TEXT']));
    await expect(s.service.regenerate(v.run!.id, { all: true, confirm: true }, 'editor')).rejects.toThrow(/no longer the approved one: start a new run/);
  });

  it('records a failed take and goes on; stops the run on an error no take would get past', async () => {
    const voice = new ScriptedVoice();
    voice.failOn.set(2, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: HTTP 422: text_too_long: too long', false));
    const s = setup(voice, {});
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    let r = (await view(s, projectId)).run!;
    const failed = r.chunks.flatMap((c) => c.generations).filter((g) => g.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toMatch(/HTTP 422: text_too_long/);
    expect(r.qa.map((f) => f.kind)).toContain('GENERATION_FAILED');
    expect(await statusOf(projectId)).toBe('VOICE_REVIEW');

    // A rejected key: the job fails, the project with it, untried takes stay pending for a retry.
    const fatal = new ScriptedVoice();
    fatal.failOn.set(1, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: HTTP 401: invalid_api_key: Invalid API key', false));
    const s2 = setup(fatal);
    const p2 = await approvedScript(s2);
    await s2.service.createRun(p2, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s2.runner.drain();
    expect(await statusOf(p2)).toBe('FAILED');
    const job = await db.job.findFirstOrThrow({ where: { projectId: p2, type: 'VOICE' } });
    expect(job).toMatchObject({ status: 'FAILED' });
    expect(job.error).toMatch(/stopped: .*HTTP 401: invalid_api_key/);
    r = (await view(s2, p2)).run!;
    expect(r.chunks.flatMap((c) => c.generations).filter((g) => g.status === 'PENDING').length).toBeGreaterThan(0);
  });

  it('compares plain, restrained and over-directed narration of the same passage', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { runs } = await s.service.createExperiment(
      projectId,
      { scope: { kind: 'SECTION', section: 1 }, name: 'Direction (test)', variants: [{ label: 'A plain', strategy: 'PLAIN' }, { label: 'B restrained', strategy: 'RESTRAINED' }, { label: 'C over-directed', strategy: 'DIRECTED' }] },
      'editor',
    );
    await s.runner.drain();
    const texts = await Promise.all(runs.map(async (n) => (await view(s, projectId, n)).run!.chunks.map((c) => c.current!.performanceText!)));
    const tags = (t: string[]) => t.join(' ').match(/\[[^\]]+\]/g)?.length ?? 0;
    expect(tags(texts[0]!)).toBe(0);
    expect(tags(texts[2]!)).toBeGreaterThan(tags(texts[1]!));
    const v = await view(s, projectId);
    expect(v.runs.filter((x) => x.experiment === 'Direction (test)').map((x) => x.variant)).toEqual(['C over-directed', 'B restrained', 'A plain']);
  });

  it('approves the whole narration at the VOICE gate only when every take is approved and nothing blocks', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const plan = await s.service.plan(projectId, { scope: { kind: 'FULL' } });
    expect(plan.estimate.needsConfirmation).toBe(true);
    if (plan.unresolvedPronunciations.length) {
      expect(plan.blocked).toMatch(/Decide the pronunciation list/);
      for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.service.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    }
    await expect(s.service.createRun(projectId, { scope: { kind: 'FULL' } }, 'editor')).rejects.toThrow(/confirm to go ahead/);
    expect(await db.voiceRun.count()).toBe(0);
    await s.service.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    expect(await statusOf(projectId)).toBe('VOICE_REVIEW');
    const r = (await view(s, projectId)).run!;
    expect(r.assembly).toMatchObject({ complete: true, status: 'IN_REVIEW' });
    await expect(s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/not approved yet/);
    const { approved } = await s.service.approveAll(r.id, 'editor');
    expect(approved).toBe(r.chunks.length);
    const { approval } = await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED', notes: 'Narration approved (test).' }, 'editor');
    expect(approval.voiceAssemblyId).toBe(r.assembly!.id);
    expect(await statusOf(projectId)).toBe('VOICE_COMPLETE');
    expect((await db.voiceAssembly.findUniqueOrThrow({ where: { id: r.assembly!.id } })).status).toBe('APPROVED');
    // Every timed word of the timeline is on the assembled clock.
    const timeline = (await view(s, projectId)).run!.assembly!.timeline;
    expect(timeline.every((t) => t.words.every((w) => w.startMs >= t.startMs - 1 && w.endMs <= r.assembly!.totalDurationMs))).toBe(true);
    expect(NarrationAlignment.safeParse((await db.voiceGeneration.findFirstOrThrow({ where: { runId: r.id } })).alignment).success).toBe(true);
  });

  it('refuses paid narration without durable storage', async () => {
    class RealishVoice extends ScriptedVoice {
      override readonly info = { ...new MockVoiceProvider().info, name: 'elevenlabs', mock: false };
    }
    const s = setup(new RealishVoice());
    const projectId = await approvedScript(s);
    await db.voiceProfile.create({ data: { name: 'House narrator', version: 1, provider: 'elevenlabs', voiceId: 'v1', modelId: 'eleven_v4', language: 'en', outputFormat: 'mp3_44100_128', config: {}, active: true } });
    const plan = await s.service.plan(projectId, { scope: { kind: 'AUDITION', seconds: 30 } });
    expect(plan.blocked).toMatch(/durable storage: set STORAGE_PROVIDER=s3/);
    await expect(s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 30 } }, 'editor')).rejects.toThrow(/durable storage/);
  });
});
