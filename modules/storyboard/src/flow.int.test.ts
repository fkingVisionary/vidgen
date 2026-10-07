import { ShotTiming, StoryboardContent } from '@docengine/core';
import { ConflictError, JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { createScriptStage } from '@docengine/script';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { VoiceService, createVoiceStage, voiceGate } from '@docengine/voice';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { VersionConflictError } from './decisions.ts';
import { storyboardGate } from './gate.ts';
import { StoryboardService } from './service.ts';
import { createStoryboardStage } from './stage.ts';
import { FakeStoryboardAI, acmeCatalog, fakeShot } from './testing.ts';

/**
 * Storyboard versions after they are planned, against a real database with
 * the scripted AI and the MOCK voice: edits make new versions and leave the
 * old ones exactly as they were; decisions carry only to unchanged shots;
 * restores and re-timing make versions with no model call; a preview is
 * approved only on approved, real narration; the whole-script path runs
 * through the STORYBOARD gate, which enqueues nothing, and an edit of an
 * approved storyboard re-opens it.
 */

const db = useTestDatabase();

function setup() {
  const ai = new FakeStoryboardAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai };
  const catalog = acmeCatalog();
  const projects = new ProjectService({ db, gateHooks: { VOICE: voiceGate(), STORYBOARD: storyboardGate({ catalog }) } });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    handlers: {
      ...createMockStageHandlers(),
      STORY_MINING: createStoryMiningStage(),
      STORY_ARCHITECTURE: createStoryArchitectureStage(),
      SCRIPT: createScriptStage(),
      VOICE: createVoiceStage({ concurrency: 2 }),
      VISUAL_PLAN: createStoryboardStage('VISUAL_PLAN', { catalog }),
      STORYBOARD_PREVIEW: createStoryboardStage('STORYBOARD_PREVIEW', { catalog }),
    },
    retryBaseDelayMs: 0,
  });
  const voice = new VoiceService({ db, projects, providers, config: { confirmCharacters: 3000, maxCharacters: 40_000 } });
  const storyboards = new StoryboardService({ db, projects, catalog, realStage: true, planningCeilingUsd: 5, toJobView: (j) => j });
  return { ai, projects, runner, voice, storyboards };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project with an approved script (synthetic dossier, scripted model). */
async function approvedScript(s: Setup): Promise<string> {
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
  return p.id;
}

/** An opening audition narrated with the MOCK voice and a preview storyboard of it (v1): VOICE_REVIEW. */
async function preview(s: Setup): Promise<{ projectId: string; runId: string; storyboardId: string }> {
  const projectId = await approvedScript(s);
  const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
  await s.runner.drain();
  const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
  await s.runner.drain();
  const board = await db.storyboard.findFirstOrThrow({ where: { projectId }, orderBy: { version: 'desc' } });
  return { projectId, runId: run.id, storyboardId: board.id };
}

/** The narration's takes as a real provider would have made them (provider timings, stored audio that is not mock): the test's stand-in for paid audio. */
async function realTakes(runId: string): Promise<void> {
  for (const g of await db.voiceGeneration.findMany({ where: { runId } })) {
    if (g.alignment) await db.voiceGeneration.update({ where: { id: g.id }, data: { alignment: { ...(g.alignment as object), source: 'PROVIDER' } } });
    if (g.audioAssetId) await db.mediaAsset.update({ where: { id: g.audioAssetId }, data: { isMock: false } });
  }
}

/** Everything a version's rows hold, but the status columns that a later decision may change. */
async function snapshot(storyboardId: string) {
  const { status: _s, updatedAt: _u, decidedBy: _b, decidedAt: _a, ...row } = await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } });
  const shots = await db.shot.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' }, include: { blocks: { orderBy: { scriptBlockId: 'asc' } }, claims: { orderBy: [{ claimId: 'asc' }, { role: 'asc' }] }, subjects: { orderBy: { subjectId: 'asc' } } } });
  const beats = await db.visualBeat.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' }, include: { blocks: { orderBy: { scriptBlockId: 'asc' } }, claims: { orderBy: { claimId: 'asc' } } } });
  const subjects = await db.continuitySubject.findMany({ where: { storyboardId }, orderBy: { subjectKey: 'asc' } });
  return JSON.stringify({ row, shots: shots.map(({ updatedAt: _x, ...rest }) => rest), beats, subjects });
}

const shotsOf = (storyboardId: string) => db.shot.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' } });
const decisionsOf = (storyboardId: string) => db.storyboardDecision.findMany({ where: { storyboardId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { shot: { select: { shotKey: true } } } });

describe('storyboard versions and decisions (scripted model, MOCK voice, real database)', () => {
  it('an edit makes a new version and leaves the old one exactly as it was; only unchanged shots carry their decisions; a restore copies a version back', async () => {
    const s = setup();
    const { projectId, storyboardId } = await preview(s);
    const [a, b, c] = await shotsOf(storyboardId);
    await s.storyboards.decideShot(a!.id, { decision: 'APPROVED', note: 'Good (test).' }, 'reviewer');
    await s.storyboards.decideShot(b!.id, { decision: 'REJECTED' }, 'reviewer');
    await s.storyboards.decideShot(c!.id, { decision: 'APPROVED' }, 'reviewer');
    await s.storyboards.decide(storyboardId, { decision: 'CHANGES_REQUESTED', note: 'Calmer (test).', expectedVersion: 1 }, 'reviewer');
    const before = await snapshot(storyboardId);
    const calls = await db.providerCall.count({ where: { projectId } });

    const v2 = await s.storyboards.edit(storyboardId, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: c!.shotKey!, patch: { description: 'The harbour at first light, empty quays (test).' } }], note: 'Calmer opening (test).' }, 'editor');
    expect(v2).toMatchObject({ version: 2, carried: 2 });
    expect(await snapshot(storyboardId)).toBe(before);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })).status).toBe('SUPERSEDED');
    // Its page says what was decided on it and what superseded it: changes were requested, it was never approved.
    expect((await s.storyboards.view(projectId, 1)).storyboard!.statusNote).toMatch(/^Changes requested by reviewer on \d{4}-\d\d-\d\d, superseded by v2 on \d{4}-\d\d-\d\d$/);
    const row2 = await db.storyboard.findUniqueOrThrow({ where: { id: v2.storyboardId } });
    expect(row2).toMatchObject({ status: 'IN_REVIEW', revisionOfId: storyboardId, scope: 'PARTIAL', createdBy: 'editor' });
    const content2 = StoryboardContent.parse(row2.content);
    expect(content2.provenance).toMatchObject({ origin: 'EDIT', baseVersion: 1, baseId: storyboardId, note: 'Calmer opening (test).', jobId: null });
    expect(content2.changes?.shots.changed).toEqual([{ shotKey: c!.shotKey, fields: ['description'] }]);
    // No model call was made.
    expect(await db.providerCall.count({ where: { projectId } })).toBe(calls);

    // Unchanged shots carry their latest decision (labelled with where it came from); the edited one is pending.
    const carried = await decisionsOf(v2.storyboardId);
    expect(carried.map((d) => [d.shot?.shotKey, d.decision, d.decidedBy, !!d.carriedFromId])).toEqual([
      [a!.shotKey, 'APPROVED', 'reviewer', true],
      [b!.shotKey, 'REJECTED', 'reviewer', true],
    ]);
    const view = await s.storyboards.view(projectId);
    expect(view.storyboard!.version).toBe(2);
    expect(view.storyboard!.shots.find((x) => x.key === a!.shotKey)!.decision).toMatchObject({ decision: 'APPROVED', carriedFromVersion: 1 });
    expect(view.storyboard!.shots.find((x) => x.key === c!.shotKey)!.review).toBe('PENDING');
    expect(view.versions.map((v) => [v.version, v.status, v.origin])).toEqual([
      [2, 'IN_REVIEW', 'EDIT'],
      [1, 'SUPERSEDED', 'GENERATED'],
    ]);

    // An edit from a version that is no longer the newest is refused with the newest number; nothing is saved.
    const stale = s.storyboards.edit(storyboardId, { expectedVersion: 1, ops: [{ op: 'clearRecommendation', shotKey: a!.shotKey! }] }, 'editor');
    await expect(stale).rejects.toBeInstanceOf(VersionConflictError);
    await expect(stale).rejects.toMatchObject({ httpStatus: 409, latestVersion: 2 });
    // Unknown versions and shots are not found.
    const nobody = '00000000-0000-7000-8000-000000000000';
    for (const call of [
      () => s.storyboards.edit(nobody, { expectedVersion: 2, ops: [{ op: 'clearRecommendation', shotKey: a!.shotKey! }] }, 'editor'),
      () => s.storyboards.restore(nobody, { expectedVersion: 2 }, 'editor'),
      () => s.storyboards.decide(nobody, { decision: 'REJECTED', expectedVersion: 2 }, 'reviewer'),
      () => s.storyboards.decideShot(nobody, { decision: 'APPROVED' }, 'reviewer'),
      () => s.storyboards.regenerateBeats(nobody, { beatKeys: ['VB01'], expectedVersion: 2, confirm: true }, 'editor'),
      () => s.storyboards.switchApproach(nobody, { approach: 'B', expectedVersion: 2, confirm: true }, 'editor'),
      () => s.storyboards.view(projectId, 99),
    ]) await expect(call()).rejects.toMatchObject({ httpStatus: 404 });
    // An edit that names what does not exist is refused, nothing saved.
    await expect(s.storyboards.edit(v2.storyboardId, { expectedVersion: 2, ops: [{ op: 'updateShot', shotKey: 'SH999', patch: { mood: 'Tense (test).' } }] }, 'editor')).rejects.toThrow(/There is no shot SH999 in this version/);
    expect(await db.storyboard.count({ where: { projectId } })).toBe(2);

    // Restore v1 as v3: a copy of its rows; v1's shot decisions carry; v2 is superseded, kept.
    const v3 = await s.storyboards.restore(storyboardId, { expectedVersion: 2 }, 'editor');
    expect(v3).toMatchObject({ version: 3, carried: 3 });
    const row3 = await db.storyboard.findUniqueOrThrow({ where: { id: v3.storyboardId } });
    const content3 = StoryboardContent.parse(row3.content);
    expect(content3.provenance).toMatchObject({ origin: 'RESTORE', baseVersion: 1 });
    expect(content3.changes?.baseVersion).toBe(2);
    expect((await shotsOf(v3.storyboardId)).map((x) => [x.shotKey, x.contentHash, x.startMs, x.endMs])).toEqual((await shotsOf(storyboardId)).map((x) => [x.shotKey, x.contentHash, x.startMs, x.endMs]));
    expect(await snapshot(storyboardId)).toBe(before);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v2.storyboardId } })).status).toBe('SUPERSEDED');
    expect((await db.projectEvent.findMany({ where: { projectId, type: { in: ['STORYBOARD_EDITED', 'STORYBOARD_RESTORED'] } }, orderBy: { createdAt: 'asc' } })).map((e) => e.type)).toEqual(['STORYBOARD_EDITED', 'STORYBOARD_RESTORED']);
  });

  it('approves a preview at version level only on real, approved narration with no blocking finding; a newer approval supersedes it', async () => {
    const s = setup();
    const { projectId, runId, storyboardId } = await preview(s);
    const decide = (id: string, expectedVersion: number) => s.storyboards.decide(id, { decision: 'APPROVED', expectedVersion }, 'reviewer');
    await expect(decide(storyboardId, 1)).rejects.toThrow(/cannot be approved yet: .*MOCK_NARRATION.*takes 0\/\d+ approved/);
    await realTakes(runId);
    await expect(decide(storyboardId, 1)).rejects.toThrow(/the narration it is timed against is not approved \(takes 0\/\d+ approved\)/);
    expect(await db.storyboardDecision.count({ where: { storyboardId, shotId: null } })).toBe(0);
    const takes = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { include: { current: true } } } });
    await s.voice.approveAll(runId, 'editor');
    // A rejected shot blocks approval until it is edited or the decision cleared.
    const first = (await shotsOf(storyboardId))[0]!;
    await s.storyboards.decideShot(first.id, { decision: 'REJECTED' }, 'reviewer');
    await expect(decide(storyboardId, 1)).rejects.toThrow(new RegExp(`${first.shotKey} is rejected`));
    await s.storyboards.decideShot(first.id, { decision: 'CLEARED' }, 'reviewer');
    expect(await decide(storyboardId, 1)).toMatchObject({ version: 1, status: 'APPROVED', viaGate: false });
    const v1 = await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } });
    expect(v1).toMatchObject({ status: 'APPROVED', decidedBy: 'reviewer' });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
    expect(takes.chunks.length).toBeGreaterThan(0);

    // An edit makes v2 to review; v1 stays approved, and its page says the approval applies to it while v2 differs.
    const v2 = await s.storyboards.edit(storyboardId, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: first.shotKey!, patch: { mood: 'Expectant (test).' } }] }, 'editor');
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })).status).toBe('APPROVED');
    const old = await s.storyboards.view(projectId, 1);
    expect(old.storyboard!.newer).toEqual({ version: 2, status: 'IN_REVIEW', changedShots: 1 });
    expect(old.storyboard!.statusNote).toMatch(/^Approved by reviewer on .*; the approval applies to v1: v2 differs in 1 shot\(s\)$/);
    expect(old.editorial.decide.allowed).toBe(false);
    // Another edit supersedes v2, never approved; approving v3 supersedes v1. Each page says what superseded it.
    const v3 = await s.storyboards.edit(v2.storyboardId, { expectedVersion: 2, ops: [{ op: 'updateShot', shotKey: first.shotKey!, patch: { mood: 'Hushed (test).' } }] }, 'editor');
    await decide(v3.storyboardId, 3);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })).status).toBe('SUPERSEDED');
    expect((await db.projectEvent.findMany({ where: { projectId, type: 'STORYBOARD_SUPERSEDED' } })).some((e) => /Approved storyboard v1 superseded by approving v3/.test(e.message))).toBe(true);
    expect((await s.storyboards.view(projectId, 1)).storyboard!.statusNote).toMatch(/^Approved by reviewer on \d{4}-\d\d-\d\d, superseded by v3 on \d{4}-\d\d-\d\d$/);
    expect((await s.storyboards.view(projectId, 2)).storyboard!.statusNote).toMatch(/^Superseded by v3 on \d{4}-\d\d-\d\d$/);
    // Version decisions are append-only rows, never carried.
    expect((await db.storyboardDecision.findMany({ where: { projectId, shotId: null } })).map((d) => d.decision)).toEqual(['APPROVED', 'APPROVED']);
  });

  it('re-times a version onto another assembly of its run with no model call: same anchors, the narration\'s new clock; staleness shows until then', async () => {
    const s = setup();
    const { projectId, runId, storyboardId } = await preview(s);
    const run = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' } } } });
    const original = (await db.voiceChunk.findUniqueOrThrow({ where: { id: run.chunks[0]!.id } })).currentGenerationId!;
    // A take regenerated: assembly v2, so v1's narration is stale.
    await s.voice.regenerate(runId, { chunkIds: [run.chunks[0]!.id] }, 'editor');
    await s.runner.drain();
    const live = await s.storyboards.view(projectId);
    expect(live.storyboard!.qa.live).toContainEqual(expect.objectContaining({ kind: 'STALE_NARRATION', severity: 'BLOCKING' }));
    expect(live.storyboard!.stale).toBe(true);
    expect(live.editorial.retime.allowed).toBe(true);
    const assembly2 = await db.voiceAssembly.findFirstOrThrow({ where: { runId }, orderBy: { version: 'desc' } });
    expect(assembly2.version).toBe(2);
    const calls = await db.providerCall.count({ where: { projectId, kind: 'AI' } });
    const v2 = await s.storyboards.retime(storyboardId, { assemblyId: assembly2.id, expectedVersion: 1 }, 'editor');
    expect(await db.providerCall.count({ where: { projectId, kind: 'AI' } })).toBe(calls);
    const row2 = await db.storyboard.findUniqueOrThrow({ where: { id: v2.storyboardId } });
    expect(row2).toMatchObject({ voiceAssemblyId: assembly2.id, assemblyVersion: 2 });
    expect(StoryboardContent.parse(row2.content).provenance.origin).toBe('RETIME');
    const anchors = async (id: string) => (await shotsOf(id)).map((x) => [x.shotKey, ShotTiming.parse(x.timing).narration]);
    expect(await anchors(v2.storyboardId)).toEqual(await anchors(storyboardId));
    expect((await s.storyboards.view(projectId)).storyboard!.qa.live.filter((f) => f.kind === 'STALE_NARRATION')).toEqual([]);

    // The original take restored: assembly v3 has v1's clips again, so re-timing onto it gives v1's clock back.
    const take = await db.voiceGeneration.findUniqueOrThrow({ where: { id: original } });
    await s.voice.decide(take.id, { action: 'RESTORE' }, 'editor');
    const assembly3 = await db.voiceAssembly.findFirstOrThrow({ where: { runId }, orderBy: { version: 'desc' } });
    expect(assembly3.version).toBe(3);
    expect((await s.storyboards.view(projectId)).storyboard!.stale).toBe(true);
    await expect(s.storyboards.retime(v2.storyboardId, { assemblyId: assembly2.id, expectedVersion: 2 }, 'editor')).rejects.toThrow(/already timed on assembly v2/);
    const v3 = await s.storyboards.retime(v2.storyboardId, { assemblyId: assembly3.id, expectedVersion: 2 }, 'editor');
    const row3 = await db.storyboard.findUniqueOrThrow({ where: { id: v3.storyboardId } });
    expect(row3.narrationFingerprint).toBe((await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })).narrationFingerprint);
    expect((await shotsOf(v3.storyboardId)).map((x) => [x.shotKey, x.startMs, x.endMs])).toEqual((await shotsOf(storyboardId)).map((x) => [x.shotKey, x.startMs, x.endMs]));
    // Another run's assembly is refused.
    const { run: other } = await s.voice.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 30 } }, 'editor');
    await s.runner.drain();
    const foreign = await db.voiceAssembly.findFirstOrThrow({ where: { run: { projectId, number: other } } });
    await expect(s.storyboards.retime(v3.storyboardId, { assemblyId: foreign.id, expectedVersion: 3 }, 'editor')).rejects.toBeInstanceOf(ConflictError);
  });

  it('the whole-script path: planned after the VOICE gate, refused at the STORYBOARD gate while it blocks, approved without enqueueing anything, and re-opened by an edit', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await s.voice.approveAll(run.id, 'editor');
    await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_COMPLETE');

    // The narration the VOICE gate approved: the phase job.
    const inputs = await s.storyboards.inputs(projectId);
    expect(inputs.kind).toBe('PHASE');
    expect(inputs.runs.find((r) => r.id === run.id)!.assemblies[0]).toMatchObject({ gateApproved: true, approval: 'GATE_APPROVED', complete: true });
    const { kind } = await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    expect(kind).toBe('PHASE');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VISUAL_PLANNING');
    await s.runner.drain();
    expect((await db.job.findFirstOrThrow({ where: { projectId, type: 'VISUAL_PLAN' } })).status).toBe('SUCCEEDED');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    expect(v1).toMatchObject({ scope: 'FULL', status: 'IN_REVIEW' });

    // Mock narration blocks the gate; a version-level decision is refused for a whole-script version outside it.
    await expect(s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: v1.id }, 'reviewer')).rejects.toThrow(/cannot pass the STORYBOARD gate: .*MOCK_NARRATION/);
    await realTakes(run.id);
    // The reviewer must name the version under review.
    await expect(s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: run.id }, 'reviewer')).rejects.toThrow(/is not the one under review \(v1\)/);
    const jobs = await db.job.count({ where: { projectId } });
    const { approval, project } = await s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED', notes: 'Reads well (test).', artifactId: v1.id }, 'reviewer');
    expect(project.status).toBe('STORYBOARD_APPROVED');
    expect(approval).toMatchObject({ storyboardId: v1.id, languageVersionId: v1.languageVersionId });
    expect(await db.job.count({ where: { projectId } })).toBe(jobs);
    expect(await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ status: 'APPROVED', decidedBy: 'reviewer' });
    expect(await db.storyboardDecision.findFirstOrThrow({ where: { storyboardId: v1.id, shotId: null } })).toMatchObject({ decision: 'APPROVED', approvalId: approval.id, note: 'Reads well (test).' });

    // An edit of the approved storyboard: v2 to review at the gate again; v1 stays approved until v2 is.
    const first = (await shotsOf(v1.id))[0]!;
    const v2 = await s.storyboards.edit(v1.id, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: first.shotKey!, patch: { lighting: 'Grey morning light (test).' } }] }, 'editor');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('APPROVED');
    await expect(s.storyboards.decide(v1.id, { decision: 'APPROVED', expectedVersion: 2 }, 'reviewer')).rejects.toThrow(/is not the one under review \(v2\)/);
    expect(await s.storyboards.decide(v2.storyboardId, { decision: 'APPROVED', expectedVersion: 2 }, 'reviewer')).toMatchObject({ status: 'APPROVED', viaGate: true });
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('SUPERSEDED');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_APPROVED');
    expect(await db.job.count({ where: { projectId } })).toBe(jobs);
  });

  it('a phase job overtaken by a rewind saves a draft that displaces no review', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await s.voice.approveAll(run.id, 'editor');
    await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    // Planned again; while it plans, the project moves on to another phase run (a rewind elsewhere).
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    const answer = s.ai.generateObject.bind(s.ai);
    s.ai.generateObject = async (req) => {
      if (req.task === 'storyboard.shots') await db.project.update({ where: { id: projectId }, data: { phaseSeq: { increment: 5 } } });
      return answer(req);
    };
    await s.runner.drain();
    const v2 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 2 } });
    expect(v2.status).toBe('DRAFT');
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('IN_REVIEW');
  });

  it('a preview in review is still decided when an overtaken phase job saved a newer draft', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 1 } });
    expect(v1).toMatchObject({ scope: 'PARTIAL', status: 'IN_REVIEW' });
    await s.voice.approveAll(run.id, 'editor');
    await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    const answer = s.ai.generateObject.bind(s.ai);
    s.ai.generateObject = async (req) => {
      if (req.task === 'storyboard.shots') await db.project.update({ where: { id: projectId }, data: { phaseSeq: { increment: 5 } } });
      return answer(req);
    };
    await s.runner.drain();
    expect(await db.storyboard.findFirstOrThrow({ where: { projectId, version: 2 } })).toMatchObject({ scope: 'FULL', status: 'DRAFT' });
    // The draft displaces no review: v1 is still the version in review, and the page and the service agree that it is decided.
    const page = await s.storyboards.view(projectId, 1);
    expect(page.editorial.decide).toEqual({ allowed: true, reason: null });
    expect(await s.storyboards.decide(v1.id, { decision: 'CHANGES_REQUESTED', note: 'Closer (test).', expectedVersion: 2 }, 'reviewer')).toMatchObject({ version: 1, status: 'CHANGES_REQUESTED', viaGate: false });
  });

  it('a preview never passes the STORYBOARD gate: one restored under review there is refused for its scope', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await realTakes(run.id);
    // Previewed while the narration is reviewed: a preview, whatever it covers.
    expect((await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor')).kind).toBe('PREVIEW');
    await s.runner.drain();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 1 } });
    expect(v1.scope).toBe('PARTIAL');
    await s.voice.approveAll(run.id, 'editor');
    await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    // The preview restored: the version under review at the gate is a preview, and the gate says why it cannot pass.
    const v3 = await s.storyboards.restore(v1.id, { expectedVersion: 2 }, 'editor');
    expect(await db.storyboard.findUniqueOrThrow({ where: { id: v3.storyboardId } })).toMatchObject({ scope: 'PARTIAL', status: 'IN_REVIEW' });
    await expect(s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: v3.storyboardId }, 'reviewer')).rejects.toThrow(/Storyboard v3 cannot pass the STORYBOARD gate: .*SCOPE_INCOMPLETE: A preview of part of the script cannot pass the storyboard gate/);
    await expect(s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED' }, 'reviewer')).rejects.toThrow(/SCOPE_INCOMPLETE/);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    // Request changes at the gate is a decision on that version.
    const { approval } = await s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'FLAGGED', artifactId: v3.storyboardId }, 'reviewer');
    expect(approval.storyboardId).toBe(v3.storyboardId);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: v3.storyboardId } })).status).toBe('CHANGES_REQUESTED');
  });

  it('approving a preview supersedes earlier previews, never the whole-script storyboard the gate approved', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.voice.plan(projectId, { scope: { kind: 'FULL' } });
    for (const p of await db.voicePronunciation.findMany({ where: { projectId } })) await s.voice.updatePronunciation(p.id, { method: 'DEFAULT', status: 'APPROVED' }, 'editor');
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'FULL' }, confirm: true }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    await realTakes(run.id);
    await s.voice.approveAll(run.id, 'editor');
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 1 } });
    expect(await s.storyboards.decide(v1.id, { decision: 'APPROVED', expectedVersion: 1 }, 'reviewer')).toMatchObject({ status: 'APPROVED', viaGate: false });
    await s.projects.recordApproval(projectId, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    const v2 = await db.storyboard.findFirstOrThrow({ where: { projectId, version: 2 } });
    const { approval } = await s.projects.recordApproval(projectId, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: v2.id }, 'reviewer');
    const status = async (id: string) => (await db.storyboard.findUniqueOrThrow({ where: { id } })).status;
    // The whole-script approval supersedes the approved preview.
    expect([await status(v1.id), await status(v2.id)]).toEqual(['SUPERSEDED', 'APPROVED']);

    // A preview restored and approved afterwards: the project's approved storyboard stays the one the gate approved.
    const v3 = await s.storyboards.restore(v1.id, { expectedVersion: 2 }, 'editor');
    expect(await s.storyboards.decide(v3.storyboardId, { decision: 'APPROVED', expectedVersion: 3 }, 'reviewer')).toMatchObject({ status: 'APPROVED', viaGate: false });
    expect([await status(v2.id), await status(v3.storyboardId)]).toEqual(['APPROVED', 'APPROVED']);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_APPROVED');
    expect(approval.storyboardId).toBe(v2.id);
    // A later approved preview supersedes the earlier one only.
    const v4 = await s.storyboards.restore(v1.id, { expectedVersion: 3 }, 'editor');
    await s.storyboards.decide(v4.storyboardId, { decision: 'APPROVED', expectedVersion: 4 }, 'reviewer');
    expect([await status(v2.id), await status(v3.storyboardId), await status(v4.storyboardId)]).toEqual(['APPROVED', 'SUPERSEDED', 'APPROVED']);
    // The next whole-script version through the gate supersedes them all.
    const first = (await shotsOf(v2.id))[0]!;
    const v5 = await s.storyboards.edit(v2.id, { expectedVersion: 4, ops: [{ op: 'updateShot', shotKey: first.shotKey!, patch: { mood: 'Still (test).' } }] }, 'editor');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('STORYBOARD_REVIEW');
    expect(await s.storyboards.decide(v5.storyboardId, { decision: 'APPROVED', expectedVersion: 5 }, 'reviewer')).toMatchObject({ status: 'APPROVED', viaGate: true });
    expect([await status(v2.id), await status(v4.storyboardId)]).toEqual(['SUPERSEDED', 'SUPERSEDED']);
  });

  it('an approval goes stale with what it rests on — a verdict, a take, the approved script — and is never re-approved or withdrawn by itself', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { run: number } = await s.voice.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
    // The first beat whose block cites an established claim with a traceable source: its shot depicts that claim.
    let depicted: { beatKey: string; claimKey: string } | null = null;
    s.ai.shots = (prompt) => {
      const ranges = [...prompt.matchAll(/- (VB\d+) "[^"]*" (\S+) → (\S+):/g)].map((m) => ({ key: m[1]!, from: m[2]!, to: m[3]! }));
      for (const r of ranges) {
        if (depicted) break;
        const block = /^(.+):end$/.exec(r.to)?.[1];
        const brief = block ? prompt.split(`### Block ${block} · `)[1]?.split('\n### ')[0] : undefined;
        const claim = brief ? /^- (\S+) \(ESTABLISHED, [^;]*; (?!no traceable)/m.exec(brief.split('Words (')[0]!)?.[1] : undefined;
        if (claim) depicted = { beatKey: r.key, claimKey: claim };
      }
      return { shots: ranges.map((r) => fakeShot(r.key, { from: r.from, to: r.to }, r.key === depicted?.beatKey ? { claims: [{ claimKey: depicted.claimKey, role: 'DEPICTS' }] } : {})), beats: [] };
    };
    await s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor');
    await s.runner.drain();
    expect(depicted).not.toBeNull();
    const v1 = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    const shot = (await db.shot.findMany({ where: { storyboardId: v1.id }, include: { beat: true, claims: { include: { claim: true } } } })).find((x) => x.beat?.beatKey === depicted!.beatKey)!;
    const claim = shot.claims.find((c) => c.role === 'DEPICTS')!.claim;
    expect(claim).toMatchObject({ claimKey: depicted!.claimKey, verdict: 'ESTABLISHED' });
    await realTakes(run.id);
    await s.voice.approveAll(run.id, 'editor');
    expect(await s.storyboards.decide(v1.id, { decision: 'APPROVED', expectedVersion: 1 }, 'reviewer')).toMatchObject({ status: 'APPROVED' });
    // v1 as the page shows it now.
    const summary = async () => (await s.storyboards.view(projectId)).versions.find((v) => v.version === 1)!;
    const live = async () => (await s.storyboards.view(projectId, 1)).storyboard!.qa.live;
    expect(await summary()).toMatchObject({ status: 'APPROVED', stale: false, narration: { approval: 'TAKES_APPROVED' } });

    // The depicted claim is now disputed: the approval no longer stands, and the page says so; the version stays as it was approved.
    await db.researchClaim.update({ where: { id: claim.id }, data: { verdict: 'DISPUTED' } });
    expect(await live()).toContainEqual(expect.objectContaining({ kind: 'STALE_VERDICT', severity: 'BLOCKING', ref: shot.shotKey, detail: expect.stringMatching(new RegExp(`^${claim.claimKey} is now DISPUTED \\(was ESTABLISHED\\): it must be presented as PRESENT_AS_DISPUTED`)) }));
    expect(await summary()).toMatchObject({ status: 'APPROVED', stale: true });
    // An edit made now cannot be approved while the shot shows the disputed claim as it was.
    const v2 = await s.storyboards.edit(v1.id, { expectedVersion: 1, ops: [{ op: 'updateBeat', beatKey: depicted!.beatKey, patch: { title: 'Retitled (test).' } }] }, 'editor');
    await expect(s.storyboards.decide(v2.storyboardId, { decision: 'APPROVED', expectedVersion: 2 }, 'reviewer')).rejects.toThrow(/cannot be approved yet: \d+ blocking finding/);
    await db.researchClaim.update({ where: { id: claim.id }, data: { verdict: 'ESTABLISHED' } });
    expect((await live()).filter((f) => f.kind === 'STALE_VERDICT')).toEqual([]);
    // v2 was planned while the claim was disputed: its own snapshot is what is stale now.
    expect((await s.storyboards.view(projectId, 2)).storyboard!.qa.live).toContainEqual(expect.objectContaining({ kind: 'STALE_VERDICT', ref: shot.shotKey, detail: expect.stringMatching(/is now ESTABLISHED \(was DISPUTED\)/) }));

    // A newer script approved: every version planned on the old one is stale, and no new plan is made of the old narration.
    await s.projects.restartPhase(projectId, 'SCRIPT', {}, 'editor', 'A new draft (test)');
    await s.runner.drain();
    await s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
    expect(await live()).toContainEqual(expect.objectContaining({ kind: 'STALE_SCRIPT', severity: 'BLOCKING', detail: 'Another script version is now the approved one' }));
    expect((await s.storyboards.view(projectId, 1)).storyboard).toMatchObject({ status: 'APPROVED', stale: true });
    await expect(s.storyboards.decide(v2.storyboardId, { decision: 'APPROVED', expectedVersion: 2 }, 'reviewer')).rejects.toThrow(/STALE_SCRIPT/);
    await expect(s.storyboards.generate(projectId, { narration: { runId: run.id }, selectionRevision: 0, confirm: true }, 'editor')).rejects.toThrow(/narrates another script than the approved one/);

    // A take it is timed against rejected: its narration is stale too.
    const take = StoryboardContent.parse(v1.content).inputs.narration.takes[0]!;
    await s.voice.decide(take.id, { action: 'REJECT' }, 'editor');
    expect(await live()).toContainEqual(expect.objectContaining({ kind: 'STALE_NARRATION', severity: 'BLOCKING', detail: expect.stringMatching(/1 take it is timed against is now rejected/) }));
    expect(await summary()).toMatchObject({ status: 'APPROVED', stale: true, narration: { approval: 'UNREVIEWED' } });
    // Nothing was decided by itself: the one version decision is the reviewer's.
    expect(await db.storyboardDecision.count({ where: { projectId, shotId: null } })).toBe(1);
  });
});
