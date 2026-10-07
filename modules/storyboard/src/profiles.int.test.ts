import { DEFAULT_VISUAL_PRESET, StoryboardContent, VISUAL_PROFILE_PRESETS } from '@docengine/core';
import { ConflictError, JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { createScriptStage } from '@docengine/script';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { VoiceService, createVoiceStage, voiceGate } from '@docengine/voice';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { storyboardGate } from './gate.ts';
import { VisualProfileError, ensurePresets, resolveVisualProduction, setVisualSelection } from './profiles.ts';
import { StoryboardService } from './service.ts';
import { createStoryboardStage } from './stage.ts';
import { FakeStoryboardAI, acmeCatalog } from './testing.ts';

/**
 * The visual profile library against a real database: the five presets
 * made once whatever runs at the same time, a project's choice resolved
 * (library default, following, pinned) with its overrides and where each
 * setting came from, stale revisions and edits refused, the library's
 * rules, and a storyboard freezing the profile it was planned with.
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

/** A project with an approved script and an opening audition narrated with the MOCK voice: VOICE_REVIEW. */
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

const familyByPreset = async (key: string) => {
  const v = await db.visualProfile.findFirstOrThrow({ where: { origin: { path: ['preset'], equals: key } }, include: { family: true } });
  return v.family;
};

describe('the visual profile library (real database)', () => {
  it('makes the five presets once, whatever asks at the same time: provider-neutral, the first the library default', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => ensurePresets(db, `editor ${i}`)));
    const families = await db.visualProfileFamily.findMany({ include: { versions: true }, orderBy: { createdAt: 'asc' } });
    expect(families.map((f) => f.name).sort()).toEqual(VISUAL_PROFILE_PRESETS.map((p) => p.name).sort());
    expect(families.every((f) => f.versions.length === 1 && f.versions[0]!.version === 1)).toBe(true);
    expect(families.filter((f) => f.isDefault).map((f) => f.name)).toEqual(['Cinematic History']);
    for (const f of families) {
      const v = f.versions[0]!;
      const preset = VISUAL_PROFILE_PRESETS.find((p) => p.name === f.name)!;
      expect(v.origin).toEqual({ kind: 'PRESET', preset: preset.key });
      expect(v.config).toEqual(preset.config);
      expect((v.config as { providerPreferences: object }).providerPreferences).toEqual({});
    }
    // A renamed or archived preset is still the preset: nothing is made again.
    const retro = await familyByPreset('retro-documentary');
    await db.visualProfileFamily.update({ where: { id: retro.id }, data: { name: 'Old broadcast look', archivedAt: new Date() } });
    await ensurePresets(db);
    expect(await db.visualProfileFamily.count()).toBe(5);
  });

  it('resolves a project\'s profile — the library default, a family followed, a version pinned — with its overrides and where each setting came from; a stale revision is refused', async () => {
    const s = setup();
    const project = await s.projects.createProject(tulipInput, 'test');
    // Before the library is used: nothing made by a read; the default named.
    const before = await resolveVisualProduction(db, project.id);
    expect(before).toMatchObject({ mode: 'DEFAULT', revision: 0, version: null });
    expect(before.notices.join(' ')).toMatch(/Cinematic History as the library default/);
    expect(await db.visualProfileFamily.count()).toBe(0);
    const view = await s.storyboards.production(project.id);
    expect(view).toMatchObject({ mode: 'DEFAULT', revision: 0, family: { name: 'Cinematic History', isDefault: true }, profile: { version: 1, current: true } });

    // Follow another family, with overrides: the effective settings and their provenance.
    const crime = await familyByPreset('dark-true-crime');
    // The first choice is made at revision 0; one at a revision the project never had is refused.
    await expect(s.storyboards.setSelection(project.id, { familyId: crime.id, overrides: {}, revision: 3 }, 'editor')).rejects.toThrow(/changed in another tab \(revision 3, now 0\)/);
    expect(await db.visualSelection.count({ where: { projectId: project.id } })).toBe(0);
    const set = await s.storyboards.setSelection(project.id, { familyId: crime.id, overrides: { density: 'DENSE', generation: { maxGeneratedVideoShare: 0.2 } }, revision: 0 }, 'editor');
    expect(set.revision).toBe(1);
    const follow = await resolveVisualProduction(db, project.id);
    expect(follow).toMatchObject({ mode: 'FOLLOW', revision: 1, family: { id: crime.id }, version: { version: 1 } });
    expect(follow.effective).toMatchObject({ density: 'DENSE', filmGrain: 'MEDIUM', generation: { maxGeneratedVideoShare: 0.2, preferStillMotion: false } });
    expect(follow.provenance).toEqual({ density: 'PROJECT', 'generation.maxGeneratedVideoShare': 'PROJECT' });
    expect((await db.projectEvent.findFirstOrThrow({ where: { projectId: project.id, type: 'VISUAL_PROFILE_SELECTED' } })).message).toMatch(/Dark True Crime, following its current version \(v1\); 2 setting\(s\) overridden/);

    // A new version of the family: followed at once; a project pinned to v1 keeps v1 and is told v2 exists.
    const v2 = await s.storyboards.newProfileVersion(crime.id, { config: { filmGrain: 'HEAVY' }, notes: 'Grainier (test).' }, 'editor');
    expect((await resolveVisualProduction(db, project.id)).version?.version).toBe(2);
    const v1 = await db.visualProfile.findFirstOrThrow({ where: { familyId: crime.id, version: 1 } });
    await s.storyboards.setSelection(project.id, { familyId: crime.id, versionId: v1.id, overrides: {}, revision: 1 }, 'editor');
    const pinned = await resolveVisualProduction(db, project.id);
    expect(pinned).toMatchObject({ mode: 'PIN', revision: 2, version: { id: v1.id }, newer: { id: v2.versionId } });
    expect(pinned.notices.join(' ')).toMatch(/Pinned to v1: v2 of Dark True Crime is its current version/);

    // Revisions: a choice made at an older revision is refused, and so is the loser of two made at once.
    await expect(s.storyboards.setSelection(project.id, { familyId: null, overrides: {}, revision: 1 }, 'editor')).rejects.toThrow(/changed in another tab \(revision 1, now 2\)/);
    const results = await Promise.allSettled([0, 1].map(() => setVisualSelection(db, project, { familyId: null, overrides: {}, revision: 2 }, 'editor')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(VisualProfileError);
    expect((await resolveVisualProduction(db, project.id)).revision).toBe(3);
  });

  it('keeps the library\'s rules: an edit on a version the editor did not see, an edit that changes nothing, a name taken, archiving the default, choosing an archived profile', async () => {
    const s = setup();
    const project = await s.projects.createProject(tulipInput, 'test');
    const library = await s.storyboards.library({ archived: false });
    expect(library.families.map((f) => [f.name, f.isDefault, f.preset])).toEqual([
      ['Cinematic History', true, DEFAULT_VISUAL_PRESET],
      ['Clean Business Explainer', false, 'clean-business-explainer'],
      ['Corporate Investigative', false, 'corporate-investigative'],
      ['Dark True Crime', false, 'dark-true-crime'],
      ['Retro Documentary', false, 'retro-documentary'],
    ]);
    const history = library.families[0]!;
    const current = history.current!;
    await s.storyboards.newProfileVersion(history.id, { config: { density: 'SPARSE' }, expectedCurrent: current.id }, 'editor');
    await expect(s.storyboards.newProfileVersion(history.id, { config: { density: 'DENSE' }, expectedCurrent: current.id }, 'editor')).rejects.toThrow(/changed since you opened it \(now v2\)/);
    await expect(s.storyboards.newProfileVersion(history.id, { config: { density: 'SPARSE' } }, 'editor')).rejects.toThrow(/Nothing changed: v2 of Cinematic History/);
    const h = await s.storyboards.profileHistory(history.id);
    expect(h.history.map((v) => [v.version, v.current, v.changes])).toEqual([
      [2, true, ['density: BALANCED → SPARSE']],
      [1, false, []],
    ]);

    // Names, duplicates, preferences the catalog does not know (a notice, never an error).
    await expect(s.storyboards.createProfile({ name: 'cinematic history' }, 'editor')).rejects.toThrow(/already named "Cinematic History"/);
    const made = await s.storyboards.createProfile({ name: 'Harbour noir', config: { realism: 'PAINTERLY', providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-motion-1' }, { provider: 'acme-nobody' }] } } }, 'editor');
    const dup = await s.storyboards.duplicateProfile(made.familyId, { name: 'Harbour noir, brighter', config: { lighting: 'Open daylight (test).' } }, 'editor');
    const noir = (await s.storyboards.library({ archived: false })).families.find((f) => f.id === made.familyId)!;
    expect(noir.current!.unknownPreferences).toEqual(['GENERATIVE_VIDEO: acme-nobody is not in the visual catalog']);
    expect((await s.storyboards.profileHistory(dup.familyId)).history[0]!.origin).toEqual({ kind: 'DUPLICATE', fromFamily: 'Harbour noir', fromVersion: 1 });

    // The default cannot be archived; another becomes the default, then it can; an archived profile is offered for no new choice.
    await expect(s.storyboards.updateProfileFamily(history.id, { archived: true })).rejects.toThrow(/is the library default/);
    await s.storyboards.updateProfileFamily(made.familyId, { isDefault: true });
    await s.storyboards.updateProfileFamily(history.id, { archived: true });
    expect((await db.visualProfileFamily.findMany({ where: { isDefault: true } })).map((f) => f.name)).toEqual(['Harbour noir']);
    await expect(s.storyboards.setSelection(project.id, { familyId: history.id, overrides: {}, revision: 0 }, 'editor')).rejects.toThrow(/is archived: unarchive it to choose it/);
    expect((await s.storyboards.library({ archived: false })).families.map((f) => f.name)).not.toContain('Cinematic History');
    expect((await s.storyboards.library({ archived: true })).families.map((f) => f.name)).toContain('Cinematic History');
  });

  it('a storyboard freezes the profile it was planned with; a later choice shows as STALE_PROFILE, and a request made at an old revision is refused', async () => {
    const s = setup();
    const { projectId, runId } = await narrated(s);
    await s.storyboards.production(projectId);
    const crime = await familyByPreset('dark-true-crime');
    await s.storyboards.setSelection(projectId, { familyId: crime.id, overrides: { approach: 'B' }, revision: 0 }, 'editor');
    await expect(s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 0, confirm: true }, 'editor')).rejects.toThrow(/changed since this was requested \(revision 0, now 1\)/);
    expect(await db.job.count({ where: { projectId, type: 'STORYBOARD_PREVIEW' } })).toBe(0);
    await s.storyboards.generate(projectId, { narration: { runId }, selectionRevision: 1, confirm: true }, 'editor');
    await s.runner.drain();
    const row = await db.storyboard.findFirstOrThrow({ where: { projectId } });
    const content = StoryboardContent.parse(row.content);
    expect(content.inputs.profile).toMatchObject({ mode: 'FOLLOW', revision: 1, familyName: 'Dark True Crime', version: 1, overrides: { approach: 'B' }, provenance: { approach: 'PROJECT' } });
    expect(content.approaches.chosen).toBe('B');
    expect(row.visualProfileId).toBe(content.inputs.profile.profileId);
    expect((await s.storyboards.view(projectId)).storyboard!.qa.live.filter((f) => f.kind === 'STALE_PROFILE')).toEqual([]);
    // Another choice: the version keeps its profile, and says it is no longer the project's.
    await s.storyboards.setSelection(projectId, { familyId: null, overrides: {}, revision: 1 }, 'editor');
    expect((await s.storyboards.view(projectId)).storyboard!.qa.live).toContainEqual(expect.objectContaining({ kind: 'STALE_PROFILE', severity: 'WARNING' }));
    expect(StoryboardContent.parse((await db.storyboard.findUniqueOrThrow({ where: { id: row.id } })).content).inputs.profile.familyName).toBe('Dark True Crime');
    // A profile used by a storyboard is never deleted under it.
    await expect(db.visualProfile.delete({ where: { id: row.visualProfileId! } })).rejects.toThrow();
    // setProfile re-snapshots the project's profile now (at the revision the editor saw), and re-costs; nothing else changes.
    const stale = s.storyboards.edit(row.id, { expectedVersion: 1, ops: [{ op: 'setProfile', selectionRevision: 1 }] }, 'editor');
    await expect(stale).rejects.toBeInstanceOf(ConflictError);
    const v2 = await s.storyboards.edit(row.id, { expectedVersion: 1, ops: [{ op: 'setProfile', selectionRevision: 2 }] }, 'editor');
    const c2 = StoryboardContent.parse((await db.storyboard.findUniqueOrThrow({ where: { id: v2.storyboardId } })).content);
    expect(c2.provenance.origin).toBe('PROFILE');
    expect(c2.inputs.profile).toMatchObject({ mode: 'DEFAULT', familyName: 'Cinematic History' });
    expect(c2.changes?.shots.changed.every((x) => !x.fields.includes('description'))).toBe(true);
  });
});
