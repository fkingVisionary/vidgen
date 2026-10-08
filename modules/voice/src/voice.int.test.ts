import { NarrationAlignment, PreparedNarration, VOICE_ACCEPTANCE_EXPERIMENT, VoiceRunConfig, VoiceTakeConfig, type JobType } from '@docengine/core';
import { Prisma } from '@docengine/database';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, MockVoiceProvider, ProviderError, createProviders, type NarrationRequest, type NarrationResult, type ProviderSet } from '@docengine/providers';
import { ScriptEditing, createScriptStage } from '@docengine/script';
import { FakeScriptAI } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { voiceGate } from './gate.ts';
import { rebuildAssembly } from './runs.ts';
import { loadScriptForVoice } from './script.ts';
import { VoiceService } from './service.ts';
import { createVoiceStage } from './stage.ts';
import { loadNarrationSummary, loadVoiceView } from './views.ts';

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
    // The run keeps what it was made with: the house profile (the library default, made at the first plan), frozen; its first takes say they are the run's.
    const row = await db.voiceRun.findUniqueOrThrow({ where: { id: r.id }, include: { generations: true } });
    const snapshot = VoiceRunConfig.parse(row.config);
    expect(snapshot).toMatchObject({ reconstructed: false, selection: { mode: 'DEFAULT', revision: 0 }, profile: { versionId: plan.profile.id, version: 1, name: 'House narrator', familyName: 'House narrator' }, projectOverrides: {}, runOptions: {}, provenance: {} });
    expect(snapshot.effective).toEqual(plan.configuration.effective);
    expect(snapshot.effective).toMatchObject({ provider: 'mock', model: 'mock', voiceId: 'mock-narrator-deep', outputFormat: 'wav_22050', strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false } });
    expect(row).toMatchObject({ strategy: 'RESTRAINED', settings: { chunking: snapshot.effective.chunking, context: snapshot.effective.context } });
    for (const g of row.generations) expect(VoiceTakeConfig.parse(g.config)).toEqual({ reconstructed: false, base: 'RUN', override: null, profile: snapshot.profile, effective: snapshot.effective, provenance: {}, differs: [], identityDiffers: false });
    // What was sent is what the snapshot says: every setting with the chunk's pace, the model sent what it takes.
    expect(s.voice.calls.every((c) => c.settings.voiceId === 'mock-narrator-deep' && c.settings.model === 'mock' && c.settings.provider?.stability === 0.5)).toBe(true);
    for (const c of r.chunks) {
      const take = c.current!;
      expect(take).toMatchObject({ generation: 1, status: 'IN_REVIEW', variant: null, provider: 'mock', model: 'mock', voiceId: 'mock-narrator-deep', alignment: 'MOCK', mock: true });
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
    // Assembly: in order, on the takes' durations, with pauses between them; every chunk has a take, so it is to review (an audition is never complete).
    const asm = r.assembly!;
    expect(asm).toMatchObject({ version: 1, complete: false, status: 'IN_REVIEW' });
    expect(r.assemblies).toEqual([expect.objectContaining({ id: asm.id, version: 1, status: 'IN_REVIEW', audioUrl: asm.audioUrl })]);
    expect(asm.entries.map((e) => e.chunkIndex)).toEqual(r.chunks.map((c) => c.index));
    expect(asm.totalDurationMs).toBe(asm.entries.at(-1)!.endMs);
    expect(asm.timeline.length).toBeGreaterThanOrEqual(r.chunks.length);
    // An audition is not the narration: QA says so and the gate refuses it.
    expect(r.qa.map((f) => f.kind)).toContain('INCOMPLETE_NARRATION');
    expect(r.qa.filter((f) => f.kind === 'TAKE_UNREVIEWED')).toHaveLength(r.chunks.length);
    expect(r.qa.map((f) => f.kind)).not.toContain('ASSEMBLY_MISMATCH');
    await expect(s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/No full narration of script v1/);
    // "What is being said at 00:01?"
    const m = await s.service.moment(projectId, number, 1000);
    expect(m).toMatchObject({ run: number, chunk: 1, generation: 1, between: false });
    expect(m.word).not.toBeNull();
    // With the timeline's part for that moment: the take's audio file, the word on the assembled clock, the performance, and approval.
    expect(m.part).toMatchObject({ scriptBlock: { key: m.block, sectionKey: m.section }, audioChunk: { index: 0, generationId: first.id, audioAssetId: first.audioUrl!.split('/').pop() }, startMs: m.startMs, endMs: m.endMs, approved: false });
    expect(m.part.words).toContainEqual(expect.objectContaining({ word: m.word }));
    expect(m.part.performance).toMatchObject({ pace: expect.any(String), energy: expect.any(String), emotion: expect.any(String) });
    // The timeline contract: section, block, chunk, take and its audio file, clock, words, performance, and approval read now.
    const assetOf = (url: string | null) => url!.split('/').pop()!;
    let t = await s.service.timeline(projectId, number);
    expect(t).toMatchObject({ run: number, scriptVersion: 1, assembly: 1, status: 'IN_REVIEW', complete: false, totalDurationMs: asm.totalDurationMs });
    expect(t.entries.map((e) => e.audioAssetId)).toEqual(r.chunks.map((c) => assetOf(c.current!.audioUrl)));
    expect(t.timeline.every((e) => e.audioChunk.audioAssetId === assetOf(r.chunks[e.audioChunk.index]!.current!.audioUrl) && !e.approved && e.words.length > 0)).toBe(true);
    await s.service.decide(first.id, { action: 'APPROVE' }, 'editor');
    t = await s.service.timeline(projectId, number);
    expect(t.assembly).toBe(1);
    expect(t.timeline.map((e) => e.approved)).toEqual(t.timeline.map((e) => e.audioChunk.index === 0));
    expect((await s.service.moment(projectId, number, 1000)).part.approved).toBe(true);
    // The ledger has one MOCK call per take, linked to it.
    const calls = await db.providerCall.findMany({ where: { projectId, kind: 'VOICE' } });
    expect(calls).toHaveLength(r.chunks.length);
    expect(calls.every((c) => c.costBasis === 'MOCK' && c.status === 'SUCCEEDED')).toBe(true);
    // The assembled file joins the takes with their pauses, each clip where the timeline puts it.
    const joined = await s.service.assemblyAudio(asm.id);
    expect(joined.mimeType).toBe('audio/wav');
    expect((await view(s, projectId)).run!.qa.map((f) => f.kind)).not.toContain('ASSEMBLY_MISMATCH');
    // A joined file whose clips land away from the timeline's clock is reported.
    const shifted = asm.entries.map((e, i) => (i === 1 ? { ...e, startMs: e.startMs + 200, endMs: e.endMs + 200 } : e));
    await db.voiceAssembly.update({ where: { id: asm.id }, data: { entries: shifted, audioAssetId: null } });
    await s.service.assemblyAudio(asm.id);
    expect((await view(s, projectId)).run!.qa).toContainEqual(expect.objectContaining({ kind: 'ASSEMBLY_MISMATCH', severity: 'WARNING', ref: '#2' }));
  });

  it('regenerates one chunk: one new request, every other chunk untouched, the assembly rebuilt around the new take; every take kept and restorable', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const before = (await view(s, projectId)).run!;
    const target = before.chunks[1]!;
    const firstTake = target.current!;
    const callsBefore = s.voice.calls.length;
    const ledgerBefore = await db.providerCall.count({ where: { projectId, kind: 'VOICE' } });

    // Regenerating everything asks for confirmation with what would be sent (spoken forms and markup), not the script's text.
    const sent = before.chunks.reduce((n, c) => n + c.current!.characters!, 0);
    expect(sent).not.toBe(before.chunks.reduce((n, c) => n + c.text.length, 0));
    const n = before.chunks.length;
    await expect(s.service.regenerate(before.id, { all: true }, 'editor')).rejects.toThrow(`Regenerating ${n} chunk(s): ${n} take(s), ${sent} characters (no cost: MOCK voice) — confirm to go ahead`);
    // Over the job's ceiling it is refused up front, confirmed or not; over the threshold even one chunk is confirmed. Nothing is queued.
    const configured = (config: { confirmCharacters: number; maxCharacters: number }) => new VoiceService({ db, projects: s.projects, providers: s.providers, config });
    await expect(configured({ confirmCharacters: 3000, maxCharacters: sent - 1 }).regenerate(before.id, { all: true, confirm: true }, 'editor')).rejects.toThrow(`${n} new take(s) would send ${sent} characters, over the ceiling of ${sent - 1} per job (VOICE_MAX_CHARACTERS)`);
    const one = firstTake.characters!;
    await expect(configured({ confirmCharacters: one - 1, maxCharacters: 40_000 }).regenerate(before.id, { chunkIds: [target.id] }, 'editor')).rejects.toThrow(`Regenerating 1 chunk(s): 1 take(s), ${one} characters (no cost: MOCK voice) — confirm to go ahead`);
    expect(await db.voiceGeneration.count({ where: { runId: before.id } })).toBe(n);
    expect(await db.job.count({ where: { projectId, type: 'VOICE' } })).toBe(1);

    await s.service.regenerate(before.id, { chunkIds: [target.id], marks: [{ sentence: 0, emotion: 'reflective', delivery: 'intimate' }] }, 'editor');
    await s.runner.drain();
    let r = (await view(s, projectId)).run!;
    // Exactly one new request, for that chunk, with its own ledger row.
    expect(s.voice.calls.length).toBe(callsBefore + 1);
    expect(await db.providerCall.count({ where: { projectId, kind: 'VOICE' } })).toBe(ledgerBefore + 1);
    const chunk = r.chunks[1]!;
    expect(chunk.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [2, 'IN_REVIEW', true],
      [1, 'SUPERSEDED', false],
    ]);
    const second = chunk.current!;
    expect(second.performanceText).toMatch(/^\[reflective, intimate\] /);
    expect(s.voice.calls.at(-1)!.text).toBe(second.performanceText);
    expect(second.directions).toEqual([{ sentence: 0, emotion: 'reflective', delivery: 'intimate' }]);
    // The new take has its own audio, measured duration and word timings, and its own ledger row.
    expect(second.audioUrl).not.toBe(firstTake.audioUrl);
    expect(second.durationMs).toBeGreaterThan(0);
    expect(second.words.length).toBeGreaterThan(0);
    expect(second.unmatchedWords).toBe(0);
    const rows = await db.voiceGeneration.findMany({ where: { id: { in: [firstTake.id, second.id] } }, include: { providerCall: true } });
    const ledger = rows.map((g) => g.providerCall);
    expect(ledger.every((c) => c?.status === 'SUCCEEDED' && c.costBasis === 'MOCK')).toBe(true);
    expect(new Set(ledger.map((c) => c!.id)).size).toBe(2);
    expect(second.cost).toMatchObject({ basis: 'MOCK', estimatedUsd: 0 });
    // Every other chunk keeps its current take.
    const others = (x: typeof r) => x.chunks.filter((c) => c.id !== target.id).map((c) => c.current!.id);
    expect(others(r)).toEqual(others(before));
    // The assembly is rebuilt: one version more, holding the current takes, its length the sum of its clips and pauses.
    expect(r.assembly!.version).toBe(before.assembly!.version + 1);
    expect(r.assembly!.entries.map((e) => e.generationId)).toEqual(r.chunks.map((c) => c.current!.id));
    expect(r.assembly!.totalDurationMs).toBe(r.assembly!.entries.reduce((sum, e) => sum + (e.endMs - e.startMs) + e.gapAfterMs, 0));
    expect(r.assembly!.totalDurationMs - before.assembly!.totalDurationMs).toBe(second.durationMs! - firstTake.durationMs! + (r.assembly!.entries[0]!.gapAfterMs - before.assembly!.entries[0]!.gapAfterMs) + (r.assembly!.entries[1]!.gapAfterMs - before.assembly!.entries[1]!.gapAfterMs));
    expect(r.assemblies.map((a) => [a.version, a.status])).toEqual([
      [2, 'IN_REVIEW'],
      [1, 'SUPERSEDED'],
    ]);
    expect(r.qa.map((f) => f.kind)).not.toContain('ASSEMBLY_MISMATCH');
    expect(r.stats.regenerations).toBe(1);

    // Approve the new take, then go back to the first: the approval is kept on the superseded take.
    await s.service.decide(second.id, { action: 'APPROVE' }, 'editor');
    await s.service.decide(firstTake.id, { action: 'RESTORE' }, 'editor');
    r = (await view(s, projectId)).run!;
    expect(r.chunks[1]!.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [2, 'SUPERSEDED', false],
      [1, 'IN_REVIEW', true],
    ]);
    expect(r.assembly!.version).toBe(3);
    expect(r.assembly!.entries[1]!.generationId).toBe(firstTake.id);
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
    voice.failOn.set(2, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: HTTP 422: text_too_long: too long', false, { status: 422 }));
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
    // Fatal by the provider's HTTP status, never by its wording.
    fatal.failOn.set(1, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: HTTP 401: invalid_api_key: Invalid API key', false, { status: 401 }));
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
      { scope: { kind: 'SECTION', section: 1 }, name: 'Direction (test)', variants: [{ label: 'A plain', strategy: 'PLAIN' }, { label: 'B restrained', strategy: 'RESTRAINED' }, { label: 'C over-directed', strategy: 'DIRECTED' }], confirm: true },
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
    let r = (await view(s, projectId)).run!;
    expect(r.assembly).toMatchObject({ complete: true, status: 'IN_REVIEW' });
    await expect(s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/not approved yet/);
    // One chunk retaken with a temporary override: kept with the take only, the profile unchanged, a warning (not a block) in QA.
    const profilesBefore = await db.voiceProfile.findMany({ orderBy: { id: 'asc' } });
    await s.service.regenerate(r.id, { chunkIds: [r.chunks[1]!.id], override: { providerSettings: { stability: 0.3 } } }, 'editor');
    await s.runner.drain();
    expect(await db.voiceProfile.findMany({ orderBy: { id: 'asc' } })).toEqual(profilesBefore);
    const retake = await db.voiceGeneration.findFirstOrThrow({ where: { chunkId: r.chunks[1]!.id, generation: 2 } });
    expect(VoiceTakeConfig.parse(retake.config)).toMatchObject({ base: 'RUN', override: { providerSettings: { stability: 0.3 } }, differs: ['stability: 0.3 (run: 0.5)'], identityDiffers: true, provenance: { 'providerSettings.stability': 'TAKE' } });
    expect(s.voice.calls.at(-1)!.settings.provider).toMatchObject({ stability: 0.3 });
    r = (await view(s, projectId)).run!;
    expect(r.qa.filter((f) => f.kind === 'CONFIGURATION_DIFFERS')).toEqual([{ kind: 'CONFIGURATION_DIFFERS', severity: 'WARNING', ref: '#2', detail: "Chunk 2's take 2 was made with a temporary override: stability: 0.3 (run: 0.5)" }]);
    const n = r.chunks.length;
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect((await loadNarrationSummary({ db, providers: s.providers }, project)).chosen).toMatchObject({ id: r.id, reason: 'NEWEST', kind: 'FULL', takes: { approved: 0, total: n } });
    // Approve all says what it did: every take approved, then (again) every take already approved.
    expect(await s.service.approveAll(r.id, 'editor')).toEqual({ approved: n, skipped: 0, alreadyApproved: 0, total: n, blocked: [], waiting: [] });
    expect(await s.service.approveAll(r.id, 'editor')).toEqual({ approved: 0, skipped: 0, alreadyApproved: n, total: n, blocked: [], waiting: [] });
    const narration = await loadNarrationSummary({ db, providers: s.providers }, project);
    expect(narration).toMatchObject({ runs: 1, chosen: { id: r.id, number: r.number, reason: 'APPROVED', takes: { approved: n, total: n }, durationMs: r.assembly!.totalDurationMs, stale: false }, full: { id: r.id, takes: { approved: n, total: n } } });
    // The VOICE gate (no providers: it reads what the takes stored) approves it.
    const { approval } = await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED', notes: 'Narration approved (test).' }, 'editor');
    expect(approval.voiceAssemblyId).toBe(r.assembly!.id);
    expect(await statusOf(projectId)).toBe('VOICE_COMPLETE');
    expect((await db.voiceAssembly.findUniqueOrThrow({ where: { id: r.assembly!.id } })).status).toBe('APPROVED');
    // The approved narration's timeline: the assembly the gate approved, every part's take approved and its audio file named.
    const approvedTimeline = await s.service.timeline(projectId, r.number);
    expect(approvedTimeline).toMatchObject({ assembly: r.assembly!.version, status: 'APPROVED', complete: true });
    expect(approvedTimeline.timeline.every((p) => p.approved && !!p.audioChunk.audioAssetId)).toBe(true);
    // Every timed word of the timeline is on the assembled clock.
    const timeline = (await view(s, projectId)).run!.assembly!.timeline;
    expect(timeline.every((t) => t.words.every((w) => w.startMs >= t.startMs - 1 && w.endMs <= r.assembly!.totalDurationMs))).toBe(true);
    expect(NarrationAlignment.safeParse((await db.voiceGeneration.findFirstOrThrow({ where: { runId: r.id } })).alignment).success).toBe(true);
  });

  it('counts a full narration complete only when every chunk has a take, also where a block is split over chunks', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    // The pronunciation list is decided before a full run.
    await s.service.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.service.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    await s.service.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const r = (await view(s, projectId)).run!;
    expect(r.assembly).toMatchObject({ version: 1, complete: true, status: 'IN_REVIEW' });
    // A block split over two chunks (the second also narrates the first's block), and the first loses its take: the block is half heard.
    const [first, second] = r.chunks;
    await db.voiceChunk.update({ where: { id: second!.id }, data: { blockKeys: [...first!.blockKeys, ...second!.blockKeys] } });
    await db.voiceChunk.update({ where: { id: first!.id }, data: { currentGenerationId: null } });
    const script = (await loadScriptForVoice(db, (await db.voiceRun.findUniqueOrThrow({ where: { id: r.id } })).scriptId))!;
    expect(await rebuildAssembly(db, r.id, script, 'editor')).toMatchObject({ version: 2, changed: true });
    expect((await view(s, projectId)).run!.assembly).toMatchObject({ version: 2, complete: false, status: 'DRAFT' });
  });

  it('A/B: one confirmed job makes a take per variant beside the current take, and the editor restores the one to keep', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const before = (await view(s, projectId)).run!;
    const target = before.chunks[0]!;
    const calls = s.voice.calls.length;

    // It buys a take per variant: always confirmed, however small.
    await expect(s.service.regenerate(before.id, { chunkIds: [target.id], variants: [{ strategy: 'RESTRAINED' }, { strategy: 'EXPRESSIVE' }] }, 'editor')).rejects.toThrow(/^A\/B \(A \/ B\) of 1 chunk\(s\): 2 take\(s\), \d+ characters \(no cost: MOCK voice\) — confirm to go ahead$/);
    const { takes } = await s.service.regenerate(before.id, { chunkIds: [target.id], variants: [{ label: 'A neutral', strategy: 'RESTRAINED' }, { label: 'B reflective', marks: [{ sentence: 0, emotion: 'reflective' }] }], note: 'A/B (test)', confirm: true }, 'editor');
    expect(takes).toBe(2);
    expect(await db.job.count({ where: { projectId, type: 'VOICE' } })).toBe(2);
    await s.runner.drain();
    expect(s.voice.calls.length).toBe(calls + 2);
    let r = (await view(s, projectId)).run!;
    let chunk = r.chunks[0]!;
    // Neither variant became current: the chunk keeps its take, the assembly is unchanged.
    expect(chunk.generations.map((g) => [g.generation, g.variant, g.status, g.current])).toEqual([
      [3, 'B reflective', 'GENERATED', false],
      [2, 'A neutral', 'GENERATED', false],
      [1, null, 'IN_REVIEW', true],
    ]);
    expect(chunk.generations[0]!.performanceText).toMatch(/^\[reflective\] /);
    expect(chunk.generations.slice(0, 2).every((g) => g.audioUrl && g.durationMs && g.words.length && g.note === 'A/B (test)')).toBe(true);
    // Each variant records what it was made with: the run's configuration, its strategy as a TAKE override.
    const made = await db.voiceGeneration.findMany({ where: { chunkId: chunk.id, generation: { in: [2, 3] } }, orderBy: { generation: 'asc' } });
    expect(made.map((g) => VoiceTakeConfig.parse(g.config)).map((c) => [c.base, c.override, c.differs, c.identityDiffers])).toEqual([
      ['RUN', { strategy: 'RESTRAINED' }, [], false],
      ['RUN', null, [], false],
    ]);
    expect(r.assembly!.version).toBe(before.assembly!.version);
    expect(r.chunks.slice(1).map((c) => c.current!.id)).toEqual(before.chunks.slice(1).map((c) => c.current!.id));

    // A take made current with no new assembly is a mismatch, and blocks.
    await db.voiceChunk.update({ where: { id: chunk.id }, data: { currentGenerationId: chunk.generations[1]!.id } });
    expect((await view(s, projectId)).run!.qa).toContainEqual(expect.objectContaining({ kind: 'ASSEMBLY_MISMATCH', severity: 'BLOCKING', ref: '#1' }));
    await db.voiceChunk.update({ where: { id: chunk.id }, data: { currentGenerationId: target.current!.id } });

    // The editor keeps B: it becomes the chunk's take, to review; the first is superseded; the assembly is rebuilt.
    await s.service.decide(chunk.generations[0]!.id, { action: 'RESTORE' }, 'editor');
    r = (await view(s, projectId)).run!;
    chunk = r.chunks[0]!;
    expect(chunk.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [3, 'IN_REVIEW', true],
      [2, 'GENERATED', false],
      [1, 'SUPERSEDED', false],
    ]);
    expect(r.assembly!.version).toBe(before.assembly!.version + 1);
    expect(r.assembly!.entries[0]!.generationId).toBe(chunk.current!.id);
    expect(r.qa.map((f) => f.kind)).not.toContain('ASSEMBLY_MISMATCH');
    // The variant not kept can be rejected; neither can be approved before it is current.
    await expect(s.service.decide(chunk.generations[1]!.id, { action: 'APPROVE' }, 'editor')).rejects.toThrow(/Only the current take/);
    await s.service.decide(chunk.generations[1]!.id, { action: 'REJECT' }, 'editor');
    expect((await view(s, projectId)).run!.chunks[0]!.generations[1]).toMatchObject({ status: 'REJECTED', current: false });
  });

  it('runs the acceptance experiment as one confirmed job: a run and an assembly per variant, each with its own strategy, context and chunking', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    // A comparison is always confirmed, however small.
    await expect(s.service.createExperiment(projectId, { scope: { kind: 'AUDITION', seconds: 20 }, name: 'Tiny (test)', variants: [{ strategy: 'PLAIN' }, { strategy: 'RESTRAINED' }] }, 'editor')).rejects.toThrow(
      /^Comparison: \d+ characters \(no cost: MOCK voice\) across 2 variants — confirm to go ahead$/,
    );
    expect(await db.voiceRun.count({ where: { projectId } })).toBe(0);

    const { runs } = await s.service.createExperiment(projectId, { ...VOICE_ACCEPTANCE_EXPERIMENT, confirm: true }, 'editor');
    expect(runs).toHaveLength(VOICE_ACCEPTANCE_EXPERIMENT.variants.length);
    expect(await db.job.count({ where: { projectId, type: 'VOICE' } })).toBe(1);
    await s.runner.drain();
    expect(await statusOf(projectId)).toBe('VOICE_REVIEW');
    const views = await Promise.all(runs.map(async (n) => (await view(s, projectId, n)).run!));
    const byLabel = new Map(views.map((r) => [r.variant, r]));
    for (const v of VOICE_ACCEPTANCE_EXPERIMENT.variants) {
      const r = byLabel.get(v.label)!;
      expect(r).toMatchObject({ experiment: 'Acceptance experiment', strategy: v.strategy, settings: { chunking: v.chunking, context: v.context } });
      // Each variant is heard whole: its own assembly of every chunk, to review.
      expect(r.assembly).toMatchObject({ version: 1, status: 'IN_REVIEW' });
      expect(r.assembly!.entries).toHaveLength(r.chunkCount);
      expect(r.chunks.every((c) => c.current?.status === 'IN_REVIEW')).toBe(true);
    }
    const run = (label: string) => byLabel.get(label)!;
    // The same passage every time.
    const words = (r: (typeof views)[number]) => r.chunks.map((c) => c.text).join(' ').split(/\s+/);
    expect(new Set(views.map((r) => words(r).join(' '))).size).toBe(1);
    // Direction: no tags plain, more over-directed than restrained.
    const tags = (r: (typeof views)[number]) => r.chunks.map((c) => c.current!.performanceText!).join(' ').match(/\[[^\]]+\]/g)?.length ?? 0;
    expect(tags(run('A plain'))).toBe(0);
    expect(tags(run('D over-directed'))).toBeGreaterThan(tags(run('B restrained')));
    // Neighbouring context: E sends none, B does.
    const context = (r: (typeof views)[number]) => r.chunks.filter((c) => c.current!.prepared!.context.previousText).length;
    expect(context(run('E no context'))).toBe(0);
    expect(context(run('B restrained'))).toBeGreaterThan(0);
    // Chunk size: smaller chunks make more of them, larger ones fewer.
    expect(run('F 5–8 s chunks').chunkCount).toBeGreaterThan(run('B restrained').chunkCount);
    expect(run('G 12–20 s chunks').chunkCount).toBeLessThan(run('B restrained').chunkCount);
  });

  it('refuses a profile whose audio format cannot be measured or joined, made or edited', async () => {
    // Pinned behaviour moved on purpose: the per-project profile route (createProfile) is gone; profiles are a library of families and versions, with the same refusal.
    const s = setup();
    await expect(s.service.createProfileFamily({ name: 'Opus narrator', fields: { outputFormat: 'opus_48000_64' } }, 'editor')).rejects.toThrow(/Output format "opus_48000_64" cannot be measured or joined here/);
    expect(await db.voiceProfile.count({ where: { outputFormat: 'opus_48000_64' } })).toBe(0);
    expect(await db.voiceProfileFamily.count()).toBe(0);
    const made = await s.service.createProfileFamily({ name: 'Tulip narrator', fields: { outputFormat: 'wav_44100' } }, 'editor');
    await expect(s.service.newProfileVersion(made.familyId, { fields: { outputFormat: 'opus_48000_64' } }, 'editor')).rejects.toThrow(/Output format "opus_48000_64" cannot be measured or joined here/);
    await expect(s.service.newProfileVersion(made.familyId, { fields: { outputFormat: 'mp3_44100_128' } }, 'editor')).resolves.toMatchObject({ familyId: made.familyId, version: 2 });
    expect((await db.voiceProfile.findMany({ where: { familyId: made.familyId }, orderBy: { version: 'asc' } })).map((v) => [v.version, v.outputFormat, v.active])).toEqual([
      [1, 'wav_44100', false],
      [2, 'mp3_44100_128', false],
    ]);
  });

  it('regenerates a run made before saved profiles with its own configuration: the same text and settings it sent', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    // House narrator v1 as code from before saved profiles wrote it (no family, the earlier config shape): adopted at the first plan.
    await db.voiceProfile.create({
      data: { name: 'House narrator', version: 1, provider: 'mock', voiceId: 'mock-narrator-deep', modelId: 'mock', language: 'en', outputFormat: 'wav_22050', active: true, config: { settings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 }, strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false }, numberStyle: 'UK' } },
    });
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 }, options: { strategy: 'EXPRESSIVE' } }, 'editor');
    await s.runner.drain();
    const r = (await view(s, projectId)).run!;
    // As a run of production: no configuration stored on it or its takes.
    await db.voiceRun.update({ where: { id: r.id }, data: { config: Prisma.DbNull } });
    await db.voiceGeneration.updateMany({ where: { runId: r.id }, data: { config: Prisma.DbNull } });
    const first = await db.voiceGeneration.findMany({ where: { runId: r.id }, orderBy: { chunk: { chunkIndex: 'asc' } } });
    const sentBefore = s.voice.calls.slice();
    await s.service.regenerate(r.id, { all: true, confirm: true }, 'editor');
    await s.runner.drain();
    const again = await db.voiceGeneration.findMany({ where: { runId: r.id, generation: 2 }, orderBy: { chunk: { chunkIndex: 'asc' } } });
    expect(again).toHaveLength(first.length);
    for (const [i, g] of again.entries()) {
      expect(g.performanceText).toBe(first[i]!.performanceText);
      expect(PreparedNarration.parse(g.prepared).settings).toEqual(PreparedNarration.parse(first[i]!.prepared).settings);
      expect(PreparedNarration.parse(g.prepared).context).toEqual(PreparedNarration.parse(first[i]!.prepared).context);
      expect(g).toMatchObject({ strategy: 'EXPRESSIVE', profileId: first[i]!.profileId, model: 'mock', voiceId: 'mock-narrator-deep' });
      // Recorded now: the run's configuration as reconstructed.
      expect(VoiceTakeConfig.parse(g.config)).toMatchObject({ reconstructed: false, base: 'RUN', override: null, differs: [], identityDiffers: false, effective: { strategy: 'EXPRESSIVE', numberStyle: 'UK' } });
    }
    // Every request as it was sent (two workers: compared whatever their order).
    const requests = (calls: typeof sentBefore) => calls.map((c) => JSON.stringify([c.text, c.settings, c.previousText ?? null, c.nextText ?? null, c.outputFormat, c.language])).sort();
    expect(requests(s.voice.calls.slice(sentBefore.length))).toEqual(requests(sentBefore));
  });

  it('regenerates with the production profile now (labelled, the run’s chunk kept), refused when its format, language or revision does not fit', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const r = (await view(s, projectId)).run!;
    const tulip = await s.service.createProfileFamily({ name: 'Tulip narrator', fields: { strategy: 'EXPRESSIVE', chunking: { minWords: 30, maxWords: 50 } } }, 'editor');
    await s.service.setSelection(projectId, { familyId: tulip.familyId, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 }, 'editor');
    // Edited after it was chosen: production is v2 now.
    const v2 = await s.service.newProfileVersion(tulip.familyId, { fields: { voiceId: 'mock-narrator-bright' } }, 'editor');
    const target = r.chunks[0]!;
    await s.service.regenerate(r.id, { chunkIds: [target.id], configuration: 'PRODUCTION', selectionRevision: 1 }, 'editor');
    await s.runner.drain();
    const take = await db.voiceGeneration.findFirstOrThrow({ where: { chunkId: target.id, generation: 2 } });
    const made = VoiceTakeConfig.parse(take.config);
    expect(take).toMatchObject({ status: 'IN_REVIEW', profileId: v2.versionId, voiceId: 'mock-narrator-bright', strategy: 'EXPRESSIVE' });
    expect(made).toMatchObject({ base: 'PRODUCTION', override: null, profile: { versionId: v2.versionId, version: 2, familyName: 'Tulip narrator' }, identityDiffers: true, provenance: { 'providerSettings.stability': 'PROJECT' } });
    // The chunk is the run's: its chunk size, not production's.
    expect(made.effective.chunking).toEqual({ minWords: 20, maxWords: 30 });
    expect(made.differs).toEqual(['voice: mock-narrator-bright (run: mock-narrator-deep)', 'performance: expressive (run: restrained)', 'stability: 0.4 (run: 0.5)']);
    expect(s.voice.calls.at(-1)!.settings).toMatchObject({ voiceId: 'mock-narrator-bright', provider: { stability: 0.4 } });
    const qa = (await view(s, projectId)).run!.qa.filter((f) => f.kind === 'CONFIGURATION_DIFFERS');
    expect(qa).toEqual([expect.objectContaining({ severity: 'WARNING', ref: '#1', detail: expect.stringMatching(/^Chunk 1's take 2 was made with the production profile Tulip narrator v2: voice: mock-narrator-bright/) })]);
    // Refused: a plan made at another revision, another output format, another language.
    await expect(s.service.regenerate(r.id, { chunkIds: [target.id], configuration: 'PRODUCTION', selectionRevision: 0 }, 'editor')).rejects.toThrow(/^The project's voice profile or its overrides changed since this was planned \(revision 0, now 1\): plan again$/);
    await s.service.newProfileVersion(tulip.familyId, { fields: { outputFormat: 'wav_44100' } }, 'editor');
    await expect(s.service.regenerate(r.id, { chunkIds: [target.id], configuration: 'PRODUCTION' }, 'editor')).rejects.toThrow(/^The production profile Tulip narrator v3 makes wav_44100 and voice run \d+ is wav_22050: clips of one run share a format — start a new run with the production profile$/);
    const spanish = await s.service.duplicateProfile(tulip.familyId, { fromVersionId: v2.versionId, name: 'Tulip narrator (Spanish)', fields: { language: 'es' } }, 'editor');
    // A choice for another language cannot be saved for en; one left behind (written directly) is refused when it is used.
    await expect(s.service.setSelection(projectId, { familyId: spanish.familyId, revision: 1 }, 'editor')).rejects.toThrow(/is for es; this narration is en/);
    await db.voiceSelection.updateMany({ where: { projectId }, data: { familyId: spanish.familyId } });
    await expect(s.service.regenerate(r.id, { chunkIds: [target.id], configuration: 'PRODUCTION' }, 'editor')).rejects.toThrow(/^The production profile cannot be used: Profile Tulip narrator \(Spanish\) v1 is for es; this narration is en$/);
    // A temporary override the provider does not take, or a chunk size for one take: refused before anything is queued.
    await expect(s.service.regenerate(r.id, { chunkIds: [target.id], override: { providerSettings: { warmth: 1 } } }, 'editor')).rejects.toThrow(/^Temporary override: warmth: not a setting this provider has$/);
    expect(await db.job.count({ where: { projectId, type: 'VOICE' } })).toBe(2);
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
