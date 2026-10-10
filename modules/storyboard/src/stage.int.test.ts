import { NarrationSpine, ShotTiming, StoryboardContent, VisualBeatContent, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers, type Logger } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { createScriptStage } from '@docengine/script';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { VoiceService, createVoiceStage, narrationSpine, voiceGate } from '@docengine/voice';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import type { StoryboardConfig } from './config.ts';
import { storyboardGate } from './gate.ts';
import { StoryboardService } from './service.ts';
import { createStoryboardStage } from './stage.ts';
import { loadStoryboard } from './store.ts';
import { FakeStoryboardAI, acmeCatalog, fakeShot } from './testing.ts';

/**
 * The storyboard job against a real database, with the scripted AI and the
 * MOCK voice: a preview planned on a Tulip-shaped audition narration (its
 * rows, its timing on the real clock, the project's status left alone, the
 * only paid calls its own planning calls), a retry resuming from the
 * checkpoint, the planning ceiling, and a model's mistakes kept out of the
 * version. No API key, no network, nothing generated.
 */

const db = useTestDatabase();

/** Every line logged. */
class CaptureLogger implements Logger {
  constructor(readonly lines: { msg: string; obj: Record<string, unknown> }[] = []) {}
  debug() {}
  info(obj: object, msg?: string) {
    this.lines.push({ msg: msg ?? '', obj: obj as Record<string, unknown> });
  }
  warn(obj: object, msg?: string) {
    this.info(obj, msg);
  }
  error(obj: object, msg?: string) {
    this.info(obj, msg);
  }
  child(): Logger {
    return this;
  }
}

function setup(o: { stage?: Partial<StoryboardConfig> } = {}) {
  const ai = new FakeStoryboardAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai };
  const catalog = acmeCatalog();
  const projects = new ProjectService({ db, gateHooks: { VOICE: voiceGate(), STORYBOARD: storyboardGate({ catalog }) } });
  const log = new CaptureLogger();
  const stage = { catalog, ...o.stage };
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    logger: log,
    handlers: {
      ...createMockStageHandlers(),
      STORY_MINING: createStoryMiningStage(),
      STORY_ARCHITECTURE: createStoryArchitectureStage(),
      SCRIPT: createScriptStage(),
      VOICE: createVoiceStage({ concurrency: 2 }),
      VISUAL_PLAN: createStoryboardStage('VISUAL_PLAN', stage),
      STORYBOARD_PREVIEW: createStoryboardStage('STORYBOARD_PREVIEW', stage),
    },
    retryBaseDelayMs: 0,
  });
  const voice = new VoiceService({ db, projects, providers, config: { confirmCharacters: 3000, maxCharacters: 40_000 } });
  const storyboards = new StoryboardService({ db, projects, catalog, realStage: true, planningCeilingUsd: 5, toJobView: (j) => j });
  return { ai, projects, runner, voice, storyboards, log, catalog };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project with an approved script and an opening audition narrated with the MOCK voice (synthetic dossier, scripted model): VOICE_REVIEW. */
async function narrated(s: Setup): Promise<{ projectId: string; runId: string }> {
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
  const { run: number } = await s.voice.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
  await s.runner.drain();
  const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId: p.id, number } } });
  return { projectId: p.id, runId: run.id };
}

const jobOf = (projectId: string, type: JobType) => db.job.findFirstOrThrow({ where: { projectId, type }, orderBy: { createdAt: 'desc' } });

describe('the storyboard job (scripted model, MOCK voice, real database)', () => {
  it('plans a preview of the audition in VOICE_REVIEW: timed on the real clock, every word in one shot, the status unchanged, nothing but planning calls', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
    const calls = await db.providerCall.count({ where: { projectId } });

    const { job: queued, kind, assemblyId } = await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    expect(kind).toBe('PREVIEW');
    await s.runner.drain();
    const job = await db.job.findUniqueOrThrow({ where: { id: queued.id } });
    expect(job).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'SUCCEEDED' });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');

    const row = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    expect(row).toMatchObject({ version: 1, status: 'IN_REVIEW', scope: 'PARTIAL', voiceRunId: runId, voiceAssemblyId: assemblyId, assemblyVersion: 1, jobId: job.id, createdBy: 'editor' });
    const spine = NarrationSpine.parse(await narrationSpine(db, assemblyId));
    expect(row.narrationFingerprint).toBe(spine.assembly.fingerprint);
    expect(row.runtimeMs).toBe(spine.assembly.totalDurationMs);
    expect(row.visualProfileId).not.toBeNull();

    // The shots tile the narration clock from 0 to its end; each narrated word is supported by exactly one shot.
    const shots = await db.shot.findMany({ where: { storyboardId: row.id }, orderBy: { sortOrder: 'asc' }, include: { blocks: { include: { scriptBlock: true } } } });
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]!.startMs).toBe(0);
    expect(shots.at(-1)!.endMs).toBe(spine.assembly.totalDurationMs);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startMs).toBe(shots[i - 1]!.endMs);
    for (const sh of shots) {
      expect(ShotTiming.safeParse(sh.timing).success).toBe(true);
      expect(sh).toMatchObject({ status: 'PLANNED', generationPrompt: null, negativePrompt: null, visualType: null, selectedAssetId: null });
      expect(sh.durationSec).toBeCloseTo((sh.endMs! - sh.startMs!) / 1000, 3);
    }
    const words = new Map<string, number>();
    for (const sh of shots) for (const b of sh.blocks) for (let w = b.firstWord; w <= b.lastWord; w++) words.set(`${b.scriptBlock.blockKey}:${w}`, (words.get(`${b.scriptBlock.blockKey}:${w}`) ?? 0) + 1);
    expect([...words.values()].every((n) => n === 1)).toBe(true);
    const narratedKeys = new Set(spine.run.scopeBlockKeys);
    expect(new Set(shots.flatMap((sh) => sh.blocks.map((b) => b.scriptBlock.blockKey)))).toEqual(narratedKeys);

    // Beats tile it too, and the version records what it was planned from.
    const beats = await db.visualBeat.findMany({ where: { storyboardId: row.id }, orderBy: { sortOrder: 'asc' } });
    expect(beats[0]!.startMs).toBe(0);
    expect(beats.at(-1)!.endMs).toBe(spine.assembly.totalDurationMs);
    const content = StoryboardContent.parse(row.content);
    expect(content.provenance).toMatchObject({ origin: 'GENERATED', baseVersion: null, requestedBy: 'editor', jobId: job.id, models: { beats: 'fake-model' } });
    expect(content.inputs.narration).toMatchObject({ runId, assemblyId, runKind: 'AUDITION', approval: 'UNREVIEWED' });
    expect(content.inputs.profile.familyName).toBe('Cinematic History');
    expect(content.scope).toMatchObject({ kind: 'PARTIAL', startMs: 0, endMs: spine.assembly.totalDurationMs });
    expect(content.scope.outOfScopeBlocks).toBeGreaterThan(0);

    // QA as saved: the mock narration blocks approval; the timing is provisional (takes not approved).
    const qa = row.qa as { kind: string; severity: string }[];
    expect(qa).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'MOCK_NARRATION', severity: 'BLOCKING' }), expect.objectContaining({ kind: 'PROVISIONAL_TIMING' }), expect.objectContaining({ kind: 'SCOPE_PARTIAL' })]));
    expect(row.qaPassed).toBe(false);

    // The only new paid calls are the planning calls through the AI provider; the job's log carries the summary line.
    const newCalls = await db.providerCall.findMany({ where: { projectId, jobId: job.id } });
    expect(newCalls.length).toBe(s.ai.calls['storyboard.beats']! + s.ai.calls['storyboard.shots']! + (s.ai.calls['storyboard.repair'] ?? 0));
    expect(newCalls.every((c) => c.kind === 'AI' && c.shotId === null)).toBe(true);
    expect(await db.providerCall.count({ where: { projectId } })).toBe(calls + newCalls.length);
    expect(await db.mediaAsset.count({ where: { projectId, kind: { not: 'NARRATION_AUDIO' } } })).toBe(0);
    const summary = s.log.lines.find((l) => l.msg.startsWith('storyboard summary: v1 PARTIAL'));
    expect(summary?.msg).toMatch(/run \d+ assembly v1 fp=[0-9a-f]{12} 0–\d+\.\d s · beats \d+ · shots \d+ · .* · project status VOICE_REVIEW \(unchanged\)$/);
    expect(summary?.obj).toMatchObject({ version: 1, scope: 'PARTIAL', beats: beats.length, shots: shots.length, modelCalls: newCalls.length, projectStatus: 'VOICE_REVIEW' });
    const events = await db.projectEvent.findMany({ where: { projectId, type: { in: ['STORYBOARD_REQUESTED', 'STORYBOARD_SAVED'] } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['STORYBOARD_REQUESTED', 'STORYBOARD_SAVED']);
    // Each step is reported as it goes (the page's running banner shows the latest).
    const progress = (await db.projectEvent.findMany({ where: { projectId, jobId: job.id, type: 'JOB_PROGRESS' } })).map((e) => e.message);
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Storyboard plan on voice run \d+, assembly v1/),
        'Planning the visual beats (a model call)',
        expect.stringMatching(new RegExp(`^Visual beats: ${beats.length} over \\d+\\.\\d s, \\d+ continuity subject\\(s\\)`)),
        expect.stringMatching(/^Planning the shots of section \d+ \(VB01[,)]/),
        expect.stringMatching(/^Section \d+: \d+ shot\(s\) over \d+ beat\(s\)$/),
        expect.stringMatching(/^storyboard summary: v1 PARTIAL/),
      ]),
    );

    // Read back, the version is the plan it was saved from.
    const loaded = (await loadStoryboard(db, row.id))!;
    expect(loaded.planned.shots.map((x) => x.key)).toEqual(shots.map((x) => x.shotKey));
    expect(loaded.planned.shots.map((x) => x.contentHash)).toEqual(shots.map((x) => x.contentHash));
  });

  it('resumes from the checkpoint on retry: a completed model call is never paid for twice', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    s.ai.failNextTask = 'storyboard.shots';
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const job = await jobOf(projectId, 'STORYBOARD_PREVIEW');
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(s.ai.calls['storyboard.beats']).toBe(1);
    expect(await db.storyboard.count({ where: { projectId } })).toBe(1);
    const content = StoryboardContent.parse((await db.storyboard.findFirstOrThrow({ where: { projectId } })).content);
    // The beats call's model is recorded though it was answered in the first attempt; the reuse is reported.
    expect(content.provenance.models.beats).toBe('fake-model');
    expect(await db.projectEvent.count({ where: { jobId: job.id, type: 'JOB_PROGRESS', message: 'Planning the visual beats: the saved answer of an earlier attempt is reused (no model call)' } })).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).checkpoint).toBeNull();
  });

  it('stops at the planning ceiling: the job fails, nothing is saved, the status is unchanged', async () => {
    const s = setup({ stage: { maxCostUsd: 0.000001 } });
    const { projectId, runId } = await narrated(s);
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const job = await jobOf(projectId, 'STORYBOARD_PREVIEW');
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/Storyboard planning stopped: estimated spend \$[\d.]+ exceeds the per-job ceiling/);
    expect(s.ai.calls['storyboard.beats']).toBe(1);
    expect(s.ai.calls['storyboard.shots']).toBeUndefined();
    expect(await db.storyboard.count({ where: { projectId } })).toBe(0);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
  });

  it('re-checks its pins before it saves: a script no longer approved when the plan is done fails the job once, saving nothing', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    const answer = s.ai.generateObject.bind(s.ai);
    s.ai.generateObject = async (req) => {
      if (req.task === 'storyboard.shots') await db.script.updateMany({ where: { projectId, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
      return answer(req);
    };
    await s.runner.drain();
    const job = await jobOf(projectId, 'STORYBOARD_PREVIEW');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(job.error).toMatch(/Not saved: script v\d+ is no longer the approved script/);
    expect(await db.storyboard.count({ where: { projectId } })).toBe(0);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
  });

  it('re-plans part of a version: BEATS only the named beats, APPROACH only the beats whose treatment changes; the rest keeps its keys, hashes and decisions', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    // Approach B keeps the first beat's treatment and changes the others'.
    const plain = s.ai.beats;
    s.ai.beats = (prompt) => {
      const out = plain(prompt);
      return { ...out, beats: out.beats.map((b, i) => (i === 0 ? { ...b, options: { ...b.options, B: { treatment: 'ENVIRONMENT', concept: 'The place (test).' } } } : b)) };
    };
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId }, include: { shots: { orderBy: { sortOrder: 'asc' }, include: { beat: true } } } });
    const byBeat = (shots: typeof v1.shots, beat: string) => shots.filter((x) => x.beat?.beatKey === beat);
    for (const sh of [...byBeat(v1.shots, 'VB01'), ...byBeat(v1.shots, 'VB02')]) await s.storyboards.decideShot(sh.id, { decision: 'APPROVED' }, 'reviewer');
    const beatsCalls = s.ai.calls['storyboard.beats'];
    const shotsCalls = s.ai.calls['storyboard.shots']!;

    // BEATS: VB02 re-planned with the editor's instructions; everything else copied.
    await expect(s.storyboards.regenerateBeats(v1.id, { beatKeys: ['VB99'], expectedVersion: 1, confirm: true }, 'editor')).rejects.toThrow(/no beat VB99/);
    await s.storyboards.regenerateBeats(v1.id, { beatKeys: ['VB02'], instructions: 'Closer on the hands (test).', expectedVersion: 1, confirm: true }, 'editor');
    await s.runner.drain();
    expect(s.ai.calls['storyboard.beats']).toBe(beatsCalls);
    expect(s.ai.calls['storyboard.shots']).toBe(shotsCalls + 1);
    const prompt = s.ai.prompts['storyboard.shots']!.at(-1)!;
    expect(prompt).toMatch(/## The editor's instructions\nCloser on the hands \(test\)\./);
    expect([...new Set([...prompt.matchAll(/\bVB\d+\b/g)].map((m) => m[0]))]).toEqual(['VB02']);
    const v2 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 2 }, include: { shots: { orderBy: { sortOrder: 'asc' }, include: { beat: true } } } });
    expect(StoryboardContent.parse(v2.content).provenance).toMatchObject({ origin: 'BEATS', baseVersion: 1, beatKeys: ['VB02'], note: 'Closer on the hands (test).' });
    const kept = (a: typeof v1.shots, b: typeof v1.shots) => a.map((x) => [x.shotKey, x.contentHash, x.startMs, x.endMs]).toString() === b.map((x) => [x.shotKey, x.contentHash, x.startMs, x.endMs]).toString();
    expect(kept(v2.shots.filter((x) => x.beat?.beatKey !== 'VB02'), v1.shots.filter((x) => x.beat?.beatKey !== 'VB02'))).toBe(true);
    const old = new Set(v1.shots.map((x) => x.shotKey));
    expect(byBeat(v2.shots, 'VB02').every((x) => !old.has(x.shotKey))).toBe(true);
    const carried = await db.storyboardDecision.findMany({ where: { storyboardId: v2.id }, include: { shot: { include: { beat: true } } } });
    expect(carried.map((d) => d.shot!.beat!.beatKey)).toEqual(byBeat(v1.shots, 'VB01').map(() => 'VB01'));
    expect(carried.every((d) => d.decision === 'APPROVED' && d.carriedFromId)).toBe(true);

    // APPROACH B: only the beats whose treatment B changes are re-planned; VB01 is copied as it is.
    await s.storyboards.switchApproach(v2.id, { approach: 'B', expectedVersion: 2, confirm: true }, 'editor');
    await s.runner.drain();
    const v3 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 3 }, include: { shots: { orderBy: { sortOrder: 'asc' }, include: { beat: true } }, beats: { orderBy: { sortOrder: 'asc' } } } });
    const content3 = StoryboardContent.parse(v3.content);
    expect(content3.provenance.origin).toBe('APPROACH');
    expect(content3.approaches.chosen).toBe('B');
    expect(content3.provenance.beatKeys).toEqual(v3.beats.filter((b) => b.beatKey !== 'VB01').map((b) => b.beatKey));
    expect(kept(byBeat(v3.shots, 'VB01'), byBeat(v2.shots, 'VB01'))).toBe(true);
    expect(v3.beats.map((b) => b.treatment)).toEqual(v3.beats.map((b) => (b.beatKey === 'VB01' ? 'ENVIRONMENT' : 'MOTION_GRAPHIC')));
    expect(v3.shots.filter((x) => x.beat?.beatKey !== 'VB01').every((x) => !v2.shots.some((y) => y.shotKey === x.shotKey))).toBe(true);
    expect(s.ai.calls['storyboard.beats']).toBe(beatsCalls);
  });

  it('keeps a model\'s mistakes out of the version: references dropped and noted, a repair kept beat by beat only when it removes blocking findings', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    const arch = await db.storyArchitecture.findFirstOrThrow({ where: { projectId, status: 'APPROVED' } });
    const cast = (arch.content as { cast: { id: string; name: string; kind: string }[] }).cast;
    const real = cast.find((c) => c.kind === 'REAL_PERSON')!;
    expect(real).toBeDefined();
    // The beats answer adds a subject for a real person and an unknown cast id.
    const plain = s.ai.beats;
    s.ai.beats = (prompt) => {
      const out = plain(prompt);
      const subject = (key: string, castId: string, name: string) => ({ key, kind: 'CHARACTER' as const, castId, anonymous: false, name, description: `${name} (test).`, era: null, location: null, approximateAge: null, clothing: null, physicalDescription: null, visualIdentity: { palette: [], silhouette: null, props: [] }, designDetails: [], rules: [], claimKeys: [] });
      return { ...out, subjects: [subject('CS01', real.id, real.name), subject('CS02', 'Z9', 'Nobody Known')] };
    };
    // The shots answer gives the first beat's shot a generated likeness of that real person, an unknown cut point to another, and a claim that does not exist.
    s.ai.shots = (prompt) => {
      const keys = [...new Set([...prompt.matchAll(/\bVB\d{2,4}\b/g)].map((m) => m[0]))];
      const ranges = [...prompt.matchAll(/- (VB\d+) "[^"]*" (\S+) → (\S+):/g)].map((m) => ({ key: m[1]!, from: m[2]!, to: m[3]! }));
      return {
        // VB03 gets no shot at all.
        shots: keys.flatMap((k) => {
          const { from, to } = ranges.find((x) => x.key === k)!;
          const r = { from, to };
          if (k === 'VB01') return [fakeShot(k, r, { treatment: 'CHARACTER_VISUAL', subjects: [{ subjectKey: 'CS01', role: 'PRIMARY', action: 'stands in the doorway', interactions: [], likeness: 'GENERATED_LIKENESS', speaks: null }] })];
          if (k === 'VB02') return [fakeShot(k, r, { visualFrom: '9.9:3', claims: [{ claimKey: 'ZZ99', role: 'CONTEXT' }] })];
          if (k === 'VB03') return [];
          return [fakeShot(k, r)];
        }),
        beats: [],
      };
    };
    // The repair fixes the likeness of VB01; for VB03 it gives a generated likeness, which adds a blocking finding.
    s.ai.repair = (prompt) => {
      const r = [...prompt.matchAll(/^## (VB\d+) "[^"]*" (\S+) → (\S+) /gm)].map((m) => ({ key: m[1]!, from: m[2]!, to: m[3]! }));
      const likeness = (k: string) => (k === 'VB01' ? 'SILHOUETTE' : 'GENERATED_LIKENESS') as 'SILHOUETTE';
      return { beats: r.map((b) => ({ beatKey: b.key, shots: [fakeShot(b.key, { from: b.from, to: b.to }, { treatment: 'CHARACTER_VISUAL', subjects: [{ subjectKey: 'CS01', role: 'PRIMARY', action: 'stands in the doorway', interactions: [], likeness: likeness(b.key), speaks: null }] })] })) };
    };
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    expect(await jobOf(projectId, 'STORYBOARD_PREVIEW')).toMatchObject({ status: 'SUCCEEDED', error: null });
    expect(s.ai.calls['storyboard.repair']).toBe(1);
    expect(s.ai.prompts['storyboard.repair']![0]).toMatch(/REAL_LIKENESS/);
    // The log says why each beat went to the repair (VB01: a blocking finding of the judged version, which the section pass does not report; VB03: its shots), and which beats took the replacement.
    const job = await jobOf(projectId, 'STORYBOARD_PREVIEW');
    const progress = (await db.projectEvent.findMany({ where: { projectId, jobId: job.id, type: 'JOB_PROGRESS' } })).map((e) => e.message);
    expect(progress).toContainEqual(expect.stringMatching(/^Sent to the repair: VB01 \((?:[A-Z_]+(?: ×\d+)?, )*REAL_LIKENESS(?: ×\d+)?(?:, [A-Z_]+(?: ×\d+)?)*\), VB03 \(not tiled by the model's shots\)$/));
    expect(progress).toContain('Repair of VB01, VB03: replacement shots kept for VB01; no replacement kept for VB03 (a replacement is kept only when it removes blocking findings and adds none)');
    const row = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    const content = StoryboardContent.parse(row.content);
    const notes = content.normalization.join('\n');
    expect(notes).toMatch(/CS02: dropped/);
    expect(notes).toMatch(/dropped the lead-in from 9\.9:3 — the cut point is not in the narration/);
    expect(notes).toMatch(/dropped claim ZZ99 — it is not in the approved evidence/);
    expect(notes).toMatch(/VB01: re-planned by the repair \(1 blocking finding\(s\) removed\)/);
    // VB03: no shot, a repair that adds a blocking finding (not kept), so one placeholder covers it.
    expect(notes).toMatch(/VB03: no shot could be placed over its words/);
    expect(notes).toMatch(/VB03: the repair was not kept — it adds \d+ blocking finding\(s\)/);
    expect(notes).toMatch(/VB03: no valid plan; one placeholder shot \(SH\d+\) covers it/);
    const qa = row.qa as { kind: string; severity: string; ref: string | null }[];
    expect(qa.filter((f) => f.kind === 'REAL_LIKENESS')).toEqual([]);
    expect(qa.some((f) => f.kind === 'MODEL_REFERENCE_DROPPED' && f.severity === 'WARNING')).toBe(true);
    const shots = await db.shot.findMany({ where: { storyboardId: row.id }, orderBy: { sortOrder: 'asc' }, include: { subjects: true, beat: true } });
    expect(shots[0]!.subjects[0]!.detail).toMatchObject({ likeness: 'SILHOUETTE' });
    const placeholder = shots.filter((x) => x.beat?.beatKey === 'VB03');
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]).toMatchObject({ treatment: null, productionMethod: null, infoClass: null, assetRequirement: null, costEstimate: null });
    expect(qa).toContainEqual(expect.objectContaining({ kind: 'SHOT_UNPLANNED', severity: 'BLOCKING', ref: placeholder[0]!.shotKey }));
    // The version still tiles the clock.
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startMs).toBe(shots[i - 1]!.endMs);
    expect(shots.at(-1)!.endMs).toBe(row.runtimeMs);
    // The page shows the placeholder as one.
    const view = await s.storyboards.view(projectId);
    expect(view.storyboard!.shots.find((x) => x.key === placeholder[0]!.shotKey)).toMatchObject({ unplanned: true, treatment: null, cost: null });
  });

  it('a re-plan repairs only the beats it plans, and no new shot takes a key another version used', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    const arch = await db.storyArchitecture.findFirstOrThrow({ where: { projectId, status: 'APPROVED' } });
    const real = (arch.content as { cast: { id: string; name: string; kind: string }[] }).cast.find((c) => c.kind === 'REAL_PERSON')!;
    const plain = s.ai.beats;
    s.ai.beats = (prompt) => ({
      ...plain(prompt),
      subjects: [{ key: 'CS01', kind: 'CHARACTER', castId: real.id, anonymous: false, name: real.name, description: `${real.name} (test).`, era: null, location: null, approximateAge: null, clothing: null, physicalDescription: null, visualIdentity: { palette: [], silhouette: null, props: [] }, designDetails: [], rules: [], claimKeys: [] }],
    });
    const person = (likeness: 'GENERATED_LIKENESS' | 'SILHOUETTE') => ({ treatment: 'CHARACTER_VISUAL' as const, subjects: [{ subjectKey: 'CS01', role: 'PRIMARY' as const, action: 'stands at the counter', interactions: [], likeness, speaks: null }] });
    // Each plan of VB01 gives the real person a generated likeness, and each of VB02 animates a document nobody sourced: both blocking and repairable. The first repair fixes nothing.
    const fault = (k: string) => (k === 'VB01' ? person('GENERATED_LIKENESS') : k === 'VB02' ? { treatment: 'DOCUMENT_ANIMATION' as const } : {});
    s.ai.shots = (prompt) => ({ shots: [...prompt.matchAll(/- (VB\d+) "[^"]*" (\S+) → (\S+):/g)].map((m) => fakeShot(m[1]!, { from: m[2]!, to: m[3]! }, fault(m[1]!))), beats: [] });
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const shotsOf = (storyboardId: string) => db.shot.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' }, include: { beat: true } });
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 1 } });
    const vb01 = (await shotsOf(v1.id)).filter((x) => x.beat?.beatKey === 'VB01');
    expect((v1.qa as { kind: string; ref: string | null }[]).filter((f) => f.kind === 'REAL_LIKENESS').map((f) => f.ref)).toEqual(vb01.map((x) => x.shotKey));
    expect(s.ai.calls['storyboard.repair']).toBe(1);

    // A re-plan of VB02, which has the same fault again: the repair is asked about VB02 alone, and its answer for VB01 too is dropped.
    // VB01 is copied as it was, finding and all, for the editor to deal with.
    const range01 = VisualBeatContent.parse((await db.visualBeat.findFirstOrThrow({ where: { storyboardId: v1.id, beatKey: 'VB01' } })).content).narration;
    const fixed = (k: string, r: { from: string; to: string }) => fakeShot(k, r, k === 'VB01' ? person('SILHOUETTE') : {});
    s.ai.repair = (prompt) => ({
      beats: [
        ...[...prompt.matchAll(/^## (VB\d+) "[^"]*" (\S+) → (\S+) /gm)].map((m) => ({ beatKey: m[1]!, shots: [fixed(m[1]!, { from: m[2]!, to: m[3]! })] })),
        ...(/^## VB01 /m.test(prompt) ? [] : [{ beatKey: 'VB01', shots: [fixed('VB01', range01)] }]),
      ],
    });
    await s.storyboards.regenerateBeats(v1.id, { beatKeys: ['VB02'], expectedVersion: 1, confirm: true }, 'editor');
    await s.runner.drain();
    expect(s.ai.calls['storyboard.repair']).toBe(2);
    expect([...s.ai.prompts['storyboard.repair']![1]!.matchAll(/^## (VB\d+) /gm)].map((m) => m[1])).toEqual(['VB02']);
    const v2 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 2 } });
    const same = (x: { shotKey: string | null; contentHash: string | null; startMs: number | null; endMs: number | null }) => [x.shotKey, x.contentHash, x.startMs, x.endMs];
    expect((await shotsOf(v2.id)).filter((x) => x.beat?.beatKey === 'VB01').map(same)).toEqual(vb01.map(same));
    expect((v2.qa as { kind: string; ref: string | null }[]).filter((f) => f.kind === 'REAL_LIKENESS').map((f) => f.ref)).toEqual(vb01.map((x) => x.shotKey));
    const notes2 = StoryboardContent.parse(v2.content).normalization;
    expect(notes2).toContainEqual(expect.stringMatching(/^VB02: re-planned by the repair/));
    expect(notes2).toContain('repair of VB01: dropped the replacement — the repair was not asked to re-plan this beat');

    // A new plan from scratch: every shot, repaired ones included, takes a key no earlier version used.
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    expect(s.ai.calls['storyboard.repair']).toBe(3);
    const v3 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 3 } });
    const earlier = new Set([...(await shotsOf(v1.id)), ...(await shotsOf(v2.id))].map((x) => x.shotKey));
    const keys = (await shotsOf(v3.id)).map((x) => x.shotKey!);
    expect(keys.filter((k) => earlier.has(k))).toEqual([]);
    expect(StoryboardContent.parse(v3.content).normalization).toContainEqual(expect.stringMatching(/^VB01: re-planned by the repair/));
  });

  it('a re-planned beat never takes a retired shot key, whether the repair re-plans it or a placeholder covers it', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const shotsOf = (version: number) => db.shot.findMany({ where: { storyboard: { projectId, version } }, orderBy: { sortOrder: 'asc' }, include: { beat: true } });
    const v1 = await shotsOf(1);
    const last = v1.at(-1)!;
    // The last beat holds the highest key; its re-plan answers a shot over no cut point of the narration, so the repair is asked for it.
    s.ai.shots = (prompt) => ({ shots: [...prompt.matchAll(/- (VB\d+) "[^"]*" /g)].map((m) => fakeShot(m[1]!, { from: '9.9:1', to: '9.9:end' })), beats: [] });
    s.ai.repair = (prompt) => ({ beats: [...prompt.matchAll(/^## (VB\d+) "[^"]*" (\S+) → (\S+) /gm)].map((m) => ({ beatKey: m[1]!, shots: [fakeShot(m[1]!, { from: m[2]!, to: m[3]! })] })) });
    const replan = async (version: number) => {
      const row = await db.storyboard.findFirstOrThrow({ where: { projectId, version } });
      await s.storyboards.regenerateBeats(row.id, { beatKeys: [last.beat!.beatKey], expectedVersion: version, confirm: true }, 'editor');
      await s.runner.drain();
    };
    await replan(1);
    const v2 = await shotsOf(2);
    const repaired = v2.filter((x) => x.beat?.beatKey === last.beat!.beatKey);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.treatment).not.toBeNull();
    expect(new Set(v1.map((x) => x.shotKey)).has(repaired[0]!.shotKey)).toBe(false);
    // Again, and the repair answers nothing: a placeholder covers the beat, under a key no version used.
    s.ai.repair = () => ({ beats: [] });
    await replan(2);
    const v3 = await shotsOf(3);
    const placeholder = v3.filter((x) => x.beat?.beatKey === last.beat!.beatKey);
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]!.treatment).toBeNull();
    expect(new Set([...v1, ...v2].map((x) => x.shotKey)).has(placeholder[0]!.shotKey)).toBe(false);
  });

  it('saves a plan whose narration or profile choice changed while it was planned, as pinned, and says so; re-timing recovers the narration with no model call', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    const run = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' } } } });
    const original = run.chunks[0]!.currentGenerationId!;
    await s.voice.regenerate(runId, { chunkIds: [run.chunks[0]!.id] }, 'editor');
    await s.runner.drain();
    const assembly2 = await db.voiceAssembly.findFirstOrThrow({ where: { runId }, orderBy: { version: 'desc' } });
    expect(assembly2.version).toBe(2);
    const { job: queued } = await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor');
    // While it plans, the original take is restored (assembly v3) and the project's profile is chosen.
    const answer = s.ai.generateObject.bind(s.ai);
    let meanwhile = false;
    s.ai.generateObject = async (req) => {
      if (req.task === 'storyboard.shots' && !meanwhile) {
        meanwhile = true;
        await s.voice.decide(original, { action: 'RESTORE' }, 'editor');
        await s.storyboards.setSelection(projectId, { familyId: null, overrides: { density: 'SPARSE' }, revision: 0 }, 'editor');
      }
      return answer(req);
    };
    await s.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    const row = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    expect(row).toMatchObject({ status: 'IN_REVIEW', voiceAssemblyId: assembly2.id, assemblyVersion: 2 });
    const content = StoryboardContent.parse(row.content);
    expect(content.notes).toEqual([
      "The narration it is timed on (assembly v2) is not its voice run's newest when it is saved (v3): it shows as stale until it is re-timed (no model call)",
      "The project's visual profile choice changed after it was requested (revision 0, now 1): it is planned with the profile it was asked with",
    ]);
    expect(content.inputs.profile).toMatchObject({ revision: 0, overrides: {} });
    expect((await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'STORYBOARD_SAVED' } })).data).toMatchObject({ changedWhilePlanned: content.notes });
    expect(s.log.lines.find((l) => l.msg.startsWith('storyboard summary: v1'))?.msg).toMatch(/ · notes: The narration it is timed on \(assembly v2\) .* \| The project's visual profile choice changed /);
    const live = (await s.storyboards.view(projectId)).storyboard!.qa.live;
    expect(live).toContainEqual(expect.objectContaining({ kind: 'STALE_NARRATION', severity: 'BLOCKING' }));
    expect(live).toContainEqual(expect.objectContaining({ kind: 'STALE_PROFILE', severity: 'WARNING' }));

    // Re-timed onto the newest assembly: no model call, and the narration is current again.
    const assembly3 = await db.voiceAssembly.findFirstOrThrow({ where: { runId }, orderBy: { version: 'desc' } });
    const calls = await db.providerCall.count({ where: { projectId, kind: 'AI' } });
    const v2 = await s.storyboards.retime(row.id, { assemblyId: assembly3.id, expectedVersion: 1 }, 'editor');
    expect(await db.providerCall.count({ where: { projectId, kind: 'AI' } })).toBe(calls);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v2.storyboardId } })).voiceAssemblyId).toBe(assembly3.id);
    expect((await s.storyboards.view(projectId)).storyboard!.qa.live.filter((f) => f.kind === 'STALE_NARRATION')).toEqual([]);
  });
});
