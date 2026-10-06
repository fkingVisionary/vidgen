import { VOICE_ACCEPTANCE_EXPERIMENT, VoiceRunConfig, VoiceTakeConfig, type JobType } from '@docengine/core';
import { Prisma } from '@docengine/database';
import { ConflictError, JobRunner, NotFoundError, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, MockVoiceProvider, createProviders, type ProviderSet } from '@docengine/providers';
import { createScriptStage } from '@docengine/script';
import { FakeScriptAI } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { effectiveConfig, runConfig, takeConfig } from './config.ts';
import { voiceGate } from './gate.ts';
import { familyCurrent, libraryDefault, profileViews, resolveProduction } from './profiles.ts';
import { VoiceService } from './service.ts';
import { createVoiceStage } from './stage.ts';

/**
 * Saved voice profiles against a real database, with the MOCK voice: the
 * library (create, edit, duplicate, archive, default, names), a project's
 * choice and overrides (atomic revisions), adoption of versions written
 * without a family, saving a run's configuration as a profile, which
 * overrides apply to which version, and that none of it changes what an
 * earlier run or take was made with. No API key, no network.
 */

const db = useTestDatabase();
const voice = new MockVoiceProvider();

function setup() {
  const ai = new FakeScriptAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai, voice };
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
  return { ai, providers, projects, runner, service };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

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
  return p.id;
}

/** "House narrator" v1 as code from before saved profiles wrote it: no family, the earlier config shape, active. */
const EARLIER_HOUSE = {
  name: 'House narrator',
  version: 1,
  provider: 'mock',
  voiceId: 'mock-narrator-deep',
  modelId: 'mock',
  language: 'en',
  outputFormat: 'wav_22050',
  config: { settings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 }, strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false }, numberStyle: 'UK' },
  active: true,
  notes: 'Created from the configured defaults (mock)',
  createdBy: 'system',
};

const languageVersion = (projectId: string) => db.project.findUniqueOrThrow({ where: { id: projectId } }).then((p) => db.languageVersion.findUniqueOrThrow({ where: { projectId_language: { projectId, language: p.masterLanguage } } }));
const production = async (projectId: string, create = false) => resolveProduction(db, voice, await languageVersion(projectId), { create, actor: 'editor' });
/** Refused with a 409 that says why. */
async function refused(p: Promise<unknown>, message: RegExp): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictError);
  expect((err as Error).message).toMatch(message);
}

/** Every row of a table as JSON text, by id (raw: the database's own bytes, not Prisma's reading of them). */
async function rows(table: 'voice_profiles' | 'voice_runs' | 'voice_generations', column?: string): Promise<Map<string, string>> {
  const out = await db.$queryRawUnsafe<{ id: string; j: string }[]>(`SELECT id::text AS id, ${column ? `${column}::text` : 'row_to_json(t)::text'} AS j FROM ${table} t`);
  return new Map(out.map((r) => [r.id, r.j]));
}

describe('saved voice profiles (MOCK voice, real database)', () => {
  it('creates a profile, edits it into new versions, refuses an edit that changes nothing or was overtaken, duplicates, archives and makes it the default', async () => {
    const s = setup();
    const made = await s.service.createProfileFamily({ name: 'Tulip narrator', description: 'For the tulip documentary', fields: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.4 } } }, 'editor');
    const v1 = await db.voiceProfile.findUniqueOrThrow({ where: { id: made.versionId }, include: { family: true } });
    // v1: the configured defaults with the fields over them, stored whole (every setting the provider describes), never the old code's library default.
    expect(v1).toMatchObject({ familyId: made.familyId, name: 'Tulip narrator', version: 1, provider: 'mock', voiceId: 'mock-narrator-deep', modelId: 'mock', language: 'en', outputFormat: 'wav_22050', active: false, origin: { kind: 'LIBRARY' }, basedOnId: null, createdBy: 'editor' });
    expect(v1.config).toMatchObject({ strategy: 'EXPRESSIVE', chunking: { minWords: 20, maxWords: 30 }, numberStyle: 'UK', providerSettings: { stability: 0.4, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 }, pronunciation: { rules: [] } });
    expect(v1.family).toMatchObject({ name: 'Tulip narrator', description: 'For the tulip documentary', isDefault: false, archivedAt: null });

    // An edit is a new version based on the current one; the version before is never changed.
    const before = await rows('voice_profiles');
    const e2 = await s.service.newProfileVersion(made.familyId, { expectedCurrent: v1.id, fields: { strategy: 'RESTRAINED', pronunciation: { rules: [{ term: 'Thijs', method: 'ALIAS', pronunciation: 'Tice' }] } }, notes: 'Calmer' }, 'editor');
    expect(e2).toEqual({ familyId: made.familyId, versionId: expect.any(String), version: 2 });
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: e2.versionId } })).toMatchObject({ name: 'Tulip narrator', version: 2, active: false, origin: { kind: 'EDIT', basedOnVersion: 1 }, basedOnId: v1.id, notes: 'Calmer' });
    expect((await rows('voice_profiles')).get(v1.id)).toBe(before.get(v1.id));
    // Saving the same thing again makes no empty version; an edit made in another tab is refused.
    await refused(s.service.newProfileVersion(made.familyId, { fields: { strategy: 'RESTRAINED' } }, 'editor'), /^Nothing changed: v2 of Tulip narrator already has this configuration$/);
    await refused(s.service.newProfileVersion(made.familyId, { fields: {} }, 'editor'), /^Nothing changed/);
    await refused(s.service.newProfileVersion(made.familyId, { expectedCurrent: v1.id, fields: { numberStyle: 'US' } }, 'editor'), /^Profile Tulip narrator changed since you opened it \(now v2\): review it and save again$/);
    // An edit cannot change the language (a voice for another language is a duplicate); unknown settings are refused, not dropped.
    await expect(s.service.newProfileVersion(made.familyId, { fields: { language: 'es' } as never }, 'editor')).rejects.toThrow(/Unrecognized key/);
    await refused(s.service.newProfileVersion(made.familyId, { fields: { providerSettings: { warmth: 0.3 } } }, 'editor'), /^Provider settings: warmth: not a setting this provider has$/);
    await expect(s.service.newProfileVersion('0199b3a0-0000-7000-8000-00000000dead', { fields: { numberStyle: 'US' } }, 'editor')).rejects.toBeInstanceOf(NotFoundError);
    // Going back: an edit from v1 with nothing changed is v1's configuration as v3.
    const e3 = await s.service.newProfileVersion(made.familyId, { basedOn: v1.id, fields: {} }, 'editor');
    const versions = await db.voiceProfile.findMany({ where: { familyId: made.familyId }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2]!.config).toEqual(versions[0]!.config);
    const views = await profileViews(db, voice, versions);
    expect(views.map((v) => [v.version, v.current, v.origin.kind, v.changes])).toEqual([
      [1, false, 'LIBRARY', []],
      [2, false, 'EDIT', ['performance: expressive → restrained', 'pronunciation rules: none → Thijs (alias Tice)']],
      [3, true, 'EDIT', ['performance: restrained → expressive', 'pronunciation rules: Thijs (alias Tice) → none']],
    ]);
    expect((await familyCurrent(db, made.familyId))!.id).toBe(e3.versionId);

    // A duplicate is a new family (another language allowed), v1, from any version.
    const dup = await s.service.duplicateProfile(made.familyId, { fromVersionId: e2.versionId, name: 'Tulip narrator (Spanish)', fields: { language: 'es', voiceId: 'mock-narrator-bright' } }, 'editor');
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: dup.versionId } })).toMatchObject({ familyId: dup.familyId, name: 'Tulip narrator (Spanish)', version: 1, language: 'es', voiceId: 'mock-narrator-bright', origin: { kind: 'DUPLICATE', fromFamily: 'Tulip narrator', fromVersion: 2 }, basedOnId: e2.versionId });

    // Archive: kept, refused for edits, back on unarchive.
    await s.service.updateProfileFamily(dup.familyId, { archived: true }, 'editor');
    expect((await db.voiceProfileFamily.findUniqueOrThrow({ where: { id: dup.familyId } })).archivedAt).not.toBeNull();
    await refused(s.service.newProfileVersion(dup.familyId, { fields: { numberStyle: 'US' } }, 'editor'), /archived: unarchive it to edit it/);
    await refused(s.service.updateProfileFamily(dup.familyId, { isDefault: true }, 'editor'), /archived: unarchive it before making it the library default/);
    await s.service.updateProfileFamily(dup.familyId, { archived: false }, 'editor');
    expect((await db.voiceProfileFamily.findUniqueOrThrow({ where: { id: dup.familyId } })).archivedAt).toBeNull();

    // The library default: the house profile made from the configured defaults, then Tulip narrator instead (one per provider and language).
    const house = await libraryDefault(db, voice, 'en', { create: true, actor: 'system' });
    expect(house).toMatchObject({ name: 'House narrator', version: 1, active: false, origin: { kind: 'DEFAULTS' }, family: { name: 'House narrator', isDefault: true } });
    await s.service.updateProfileFamily(made.familyId, { isDefault: true }, 'editor');
    expect((await db.voiceProfileFamily.findMany({ where: { isDefault: true } })).map((f) => f.name)).toEqual(['Tulip narrator']);
    expect((await libraryDefault(db, voice, 'en', { create: false, actor: 'system' }))!.id).toBe(e3.versionId);
    // The Spanish duplicate becomes the default for es without touching en's.
    await s.service.updateProfileFamily(dup.familyId, { isDefault: true }, 'editor');
    expect((await db.voiceProfileFamily.findMany({ where: { isDefault: true }, orderBy: { name: 'asc' } })).map((f) => f.name)).toEqual(['Tulip narrator', 'Tulip narrator (Spanish)']);
    await refused(s.service.updateProfileFamily(made.familyId, { archived: true }, 'editor'), /is the library default: make another profile the library default first/);
    // No version was ever updated: only new ones were written.
    const after = await rows('voice_profiles');
    for (const [id, row] of before) expect(after.get(id)).toBe(row);
  });

  it('keeps names unique ignoring case, also against the names another profile’s versions carry', async () => {
    const s = setup();
    const a = await s.service.createProfileFamily({ name: 'Tulip narrator' }, 'editor');
    await refused(s.service.createProfileFamily({ name: 'tulip NARRATOR' }, 'editor'), /^A voice profile is already named "Tulip narrator": choose another name$/);
    await s.service.updateProfileFamily(a.familyId, { name: 'Classic narrator' }, 'editor');
    // Its v1 is still named as it was made: that name stays taken by it.
    await refused(s.service.createProfileFamily({ name: 'Tulip Narrator' }, 'editor'), /^"Tulip narrator" is the name of another profile's versions \(v1\): choose another name$/);
    const b = await s.service.duplicateProfile(a.familyId, { name: 'Second narrator' }, 'editor');
    await refused(s.service.updateProfileFamily(b.familyId, { name: 'CLASSIC narrator' }, 'editor'), /already named "Classic narrator"/);
    await refused(s.service.duplicateProfile(a.familyId, { name: 'tulip narrator' }, 'editor'), /name of another profile's versions/);
    // A family may take its own versions' name back.
    await s.service.updateProfileFamily(a.familyId, { name: 'Tulip narrator' }, 'editor');
    const v2 = await s.service.newProfileVersion(a.familyId, { fields: { numberStyle: 'US' } }, 'editor');
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: v2.versionId } })).toMatchObject({ name: 'Tulip narrator', version: 2 });
  });

  it('lets one of two edits saved at the same time become the next version and refuses the other', async () => {
    const s = setup();
    const a = await s.service.createProfileFamily({ name: 'Tulip narrator' }, 'editor');
    const results = await Promise.allSettled([
      s.service.newProfileVersion(a.familyId, { expectedCurrent: a.versionId, fields: { numberStyle: 'US' } }, 'one'),
      s.service.newProfileVersion(a.familyId, { expectedCurrent: a.versionId, fields: { strategy: 'PLAIN' } }, 'two'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [lost] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost!.reason).toBeInstanceOf(ConflictError);
    expect((await db.voiceProfile.findMany({ where: { familyId: a.familyId }, orderBy: { version: 'asc' } })).map((v) => v.version)).toEqual([1, 2]);
  });

  it('adopts versions written without a family (code from before saved profiles) when the library default is needed, and never on a read', async () => {
    const legacy = await db.voiceProfile.create({ data: EARLIER_HOUSE });
    const older = await db.voiceProfile.create({ data: { ...EARLIER_HOUSE, name: 'Old narrator', active: false } });
    const before = await rows('voice_profiles');
    const s = setup();
    const p = await s.projects.createProject(tulipInput, 'test');
    // A read finds no default, says so, and writes nothing.
    const read = await production(p.id);
    expect(read).toMatchObject({ mode: 'DEFAULT', revision: 0, version: null, problem: null, notices: ['No library default for mock (en) yet: the house profile is made at the first plan'] });
    expect(await db.voiceProfileFamily.count()).toBe(0);
    // At plan time: one family per name; the active version's is the default; nothing else of the versions changes.
    const resolved = await production(p.id, true);
    expect(resolved.version!.id).toBe(legacy.id);
    expect(resolved.family).toMatchObject({ name: 'House narrator', isDefault: true });
    const families = await db.voiceProfileFamily.findMany({ orderBy: { name: 'asc' }, include: { versions: true } });
    expect(families.map((f) => [f.name, f.isDefault, f.versions.map((v) => v.id)])).toEqual([
      ['House narrator', true, [legacy.id]],
      ['Old narrator', false, [older.id]],
    ]);
    // Only their empty family was filled in.
    const after = await rows('voice_profiles');
    for (const [id, row] of before) expect({ ...JSON.parse(after.get(id)!), family_id: null }).toEqual(JSON.parse(row));
    expect(new Set([...after.values()].map((j) => JSON.parse(j).family_id)).size).toBe(2);
    // No house profile was made: the adopted one is the default.
    expect(await db.voiceProfile.count()).toBe(2);
    // It narrates as it did: the earlier config read as then (restrained, the earlier rules, its five settings).
    const { effective } = effectiveConfig(resolved.version!, [], voice);
    expect(effective).toMatchObject({ strategy: 'RESTRAINED', numberStyle: 'UK', providerSettings: EARLIER_HOUSE.config.settings, pronunciation: { rules: [] } });
  });

  it('adopts versions written without a family while a library default exists (a rollback and roll forward), without changing production', async () => {
    const s = setup();
    const p = await s.projects.createProject(tulipInput, 'test');
    const house = (await production(p.id, true)).version!;
    expect(house).toMatchObject({ name: 'House narrator', version: 1, family: { isDefault: true } });
    // Code from before saved profiles, run during a rollback, made "House narrator" v2 the active version (no family).
    const orphan = await db.voiceProfile.create({ data: { ...EARLIER_HOUSE, version: 2 } });
    const before = await rows('voice_profiles');
    // A read writes nothing.
    expect(await production(p.id)).toMatchObject({ mode: 'DEFAULT', version: { id: house.id } });
    expect((await db.voiceProfile.findUniqueOrThrow({ where: { id: orphan.id } })).familyId).toBeNull();
    // Two plans at the same time: it is adopted once, into a family of its own (not the default: one exists), and production stays the default's.
    const both = await Promise.all([production(p.id, true), production(p.id, true)]);
    expect(both.map((r) => r.version!.id)).toEqual([house.id, house.id]);
    const families = await db.voiceProfileFamily.findMany({ orderBy: { name: 'asc' }, include: { versions: { select: { id: true } } } });
    expect(families.map((f) => [f.name, f.isDefault, f.versions.map((v) => v.id)])).toEqual([
      ['House narrator', true, [house.id]],
      ['House narrator (mock, en)', false, [orphan.id]],
    ]);
    // Only its empty family was filled in.
    const after = await rows('voice_profiles');
    expect({ ...JSON.parse(after.get(orphan.id)!), family_id: null }).toEqual(JSON.parse(before.get(orphan.id)!));
    expect(after.get(house.id)).toBe(before.get(house.id));
    // A project following a saved profile adopts them too when it plans.
    const tulip = await s.service.createProfileFamily({ name: 'Tulip narrator' }, 'editor');
    await s.service.setSelection(p.id, { familyId: tulip.familyId, revision: 0 }, 'editor');
    const another = await db.voiceProfile.create({ data: { ...EARLIER_HOUSE, name: 'Old narrator', active: false } });
    expect(await production(p.id, true)).toMatchObject({ mode: 'FOLLOW', version: { id: tulip.versionId } });
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: another.id }, include: { family: true } })).toMatchObject({ family: { name: 'Old narrator', isDefault: false } });
  });

  it('saves a project’s choice at the revision the editor saw, atomically', async () => {
    const s = setup();
    const p = await s.projects.createProject(tulipInput, 'test');
    const tulip = await s.service.createProfileFamily({ name: 'Tulip narrator' }, 'editor');
    const other = await s.service.createProfileFamily({ name: 'Other narrator' }, 'editor');
    expect(await s.service.setSelection(p.id, { familyId: tulip.familyId, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 }, 'editor')).toMatchObject({ revision: 1 });
    expect(await production(p.id)).toMatchObject({ mode: 'FOLLOW', revision: 1, family: { name: 'Tulip narrator' }, overrides: { providerSettings: { stability: 0.4 } }, problem: null });
    // The same revision again (another tab): refused.
    await refused(s.service.setSelection(p.id, { familyId: other.familyId, revision: 0 }, 'editor'), /^The voice profile for en changed in another tab \(revision 0, now 1\): reload and choose again$/);
    // Two saves at the same revision at the same time: one wins.
    const both = await Promise.allSettled([s.service.setSelection(p.id, { familyId: other.familyId, revision: 1 }, 'a'), s.service.setSelection(p.id, { familyId: tulip.familyId, versionId: tulip.versionId, revision: 1 }, 'b')]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect((await db.voiceSelection.findFirstOrThrow({ where: { projectId: p.id } })).revision).toBe(2);
    // Refused: a version of another family, overrides the provider does not take, an archived family it does not use.
    await refused(s.service.setSelection(p.id, { familyId: tulip.familyId, versionId: other.versionId, revision: 2 }, 'editor'), /is not a version of Tulip narrator/);
    await refused(s.service.setSelection(p.id, { familyId: tulip.familyId, overrides: { providerSettings: { warmth: 1 } }, revision: 2 }, 'editor'), /^Project overrides: warmth: not a setting this provider has$/);
    const archived = await s.service.createProfileFamily({ name: 'Archived narrator' }, 'editor');
    await s.service.updateProfileFamily(archived.familyId, { archived: true }, 'editor');
    await refused(s.service.setSelection(p.id, { familyId: archived.familyId, revision: 2 }, 'editor'), /archived: unarchive it to choose it/);
    // Pinned, then the library default with overrides: each saved, each an event.
    await s.service.setSelection(p.id, { familyId: tulip.familyId, versionId: tulip.versionId, revision: 2 }, 'editor');
    const v2 = await s.service.newProfileVersion(tulip.familyId, { fields: { numberStyle: 'US' } }, 'editor');
    expect(await production(p.id)).toMatchObject({ mode: 'PIN', revision: 3, version: { id: tulip.versionId }, newer: { id: v2.versionId }, notices: ['Pinned to v1: v2 of Tulip narrator is its current version'] });
    await s.service.setSelection(p.id, { familyId: null, overrides: { numberStyle: 'US' }, revision: 3 }, 'editor');
    expect(await production(p.id)).toMatchObject({ mode: 'DEFAULT', revision: 4, overrides: { numberStyle: 'US' } });
    const events = (await db.projectEvent.findMany({ where: { projectId: p.id, type: 'VOICE_PROFILE_SELECTED' } })).map((e) => e.message);
    expect(events).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        'Voice profile for en: Tulip narrator, follows the current version (v1); overrides: stability 0.4',
        expect.stringMatching(/^Voice profile for en: (Other narrator, follows the current version \(v1\)|Tulip narrator, pinned to v1); overrides: none$/),
        'Voice profile for en: Tulip narrator, pinned to v1; overrides: none',
        'Voice profile for en: the library default; overrides: number style US',
      ]),
    );
  });

  it('saves run 3 of the acceptance experiment (made before saved profiles) as the project’s profile: its overrides cleared, production is exactly run 3', async () => {
    const s = setup();
    // House narrator v1 as production has it.
    const house = await db.voiceProfile.create({ data: EARLIER_HOUSE });
    const projectId = await approvedScript(s);
    const { runs } = await s.service.createExperiment(projectId, { ...VOICE_ACCEPTANCE_EXPERIMENT, confirm: true }, 'editor');
    const run3 = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number: runs[2]! } } });
    expect(run3).toMatchObject({ variant: 'C expressive', profileId: house.id });
    // As production: the runs and their takes were made before saved profiles.
    await db.voiceRun.updateMany({ where: { projectId }, data: { config: Prisma.DbNull } });
    await db.voiceGeneration.updateMany({ where: { projectId }, data: { config: Prisma.DbNull } });
    const reconstructed = runConfig(await db.voiceRun.findUniqueOrThrow({ where: { id: run3.id }, include: { profile: { include: { family: true } } } }), voice);
    expect(reconstructed).toMatchObject({ reconstructed: true, runOptions: { strategy: 'EXPRESSIVE' } });
    expect(reconstructed.effective).toMatchObject({ strategy: 'EXPRESSIVE', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false }, numberStyle: 'UK', providerSettings: EARLIER_HOUSE.config.settings });
    // The project has an override in force.
    await s.service.setSelection(projectId, { familyId: null, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 }, 'editor');

    const saved = await s.service.saveRunAsProfile(run3.id, { name: 'Tulip narrator', use: true }, 'editor');
    expect(saved).toEqual({ familyId: expect.any(String), versionId: expect.any(String), version: 1, selected: true, clearedOverrides: { providerSettings: { stability: 0.4 } } });
    const slug = (await db.project.findUniqueOrThrow({ where: { id: projectId } })).slug;
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: saved.versionId }, include: { family: true } })).toMatchObject({
      name: 'Tulip narrator',
      version: 1,
      active: false,
      notes: `Saved from voice run ${run3.number} of ${slug} (Acceptance experiment — C expressive)`,
      origin: { kind: 'RUN', runId: run3.id, run: run3.number, projectId, project: slug, experiment: 'Acceptance experiment', variant: 'C expressive', takeId: null, reconstructed: true },
      // Never the library default: the accepted configuration is this documentary's.
      family: { name: 'Tulip narrator', isDefault: false },
    });
    expect((await db.voiceProfileFamily.findMany({ where: { isDefault: true } })).map((f) => f.name)).toEqual(['House narrator']);
    // Production follows it with no overrides, and is exactly what run 3 was made with.
    const prod = await production(projectId);
    expect(prod).toMatchObject({ mode: 'FOLLOW', revision: 2, overrides: {}, problem: null, version: { id: saved.versionId } });
    expect(effectiveConfig(prod.version!, [], voice).effective).toEqual(reconstructed.effective);
    const plan = await s.service.plan(projectId, { scope: VOICE_ACCEPTANCE_EXPERIMENT.scope });
    expect(plan.configuration).toMatchObject({ mode: 'FOLLOW', selectionRevision: 2, projectOverrides: {}, runOptions: {}, provenance: {} });
    expect(plan.configuration.effective).toEqual(reconstructed.effective);
    expect(plan.profile).toMatchObject({ id: saved.versionId, current: true, origin: { kind: 'RUN', variant: 'C expressive' } });
    const events = await db.projectEvent.findMany({ where: { projectId, type: { in: ['VOICE_PROFILE_CREATED', 'VOICE_PROFILE_SELECTED'] } } });
    expect(events.map((e) => [e.type, e.message])).toEqual(
      expect.arrayContaining([
        ['VOICE_PROFILE_CREATED', `Voice profile Tulip narrator v1 saved from voice run ${run3.number} (C expressive): mock mock`],
        ['VOICE_PROFILE_SELECTED', 'Voice profile for en: Tulip narrator, follows the current version (v1) (project overrides cleared: stability 0.4; they are part of the saved profile)'],
      ]),
    );
    expect(events.find((e) => e.type === 'VOICE_PROFILE_SELECTED' && e.message.includes('cleared'))!.data).toMatchObject({ mode: 'FOLLOW', revision: 2, clearedOverrides: { providerSettings: { stability: 0.4 } } });
    // Saving a take's configuration (a take of run 1, A plain) as a new version of the profile.
    const run1 = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number: runs[0]! } } });
    const take = await db.voiceGeneration.findFirstOrThrow({ where: { runId: run1.id } });
    const v2 = await s.service.saveRunAsProfile(take.runId, { familyId: saved.familyId, generationId: take.id }, 'editor');
    expect(v2).toMatchObject({ familyId: saved.familyId, version: 2, selected: false, clearedOverrides: null });
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: v2.versionId } })).toMatchObject({ config: { strategy: 'PLAIN' }, origin: { kind: 'RUN', variant: 'A plain', takeId: take.id } });
    await expect(s.service.saveRunAsProfile(take.runId, { name: 'Elsewhere', generationId: run3.id }, 'editor')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('applies the project’s overrides to its production profile only: another saved profile is heard as saved; a plan pinned to v1 keeps v1 and the overrides', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const tulip = await s.service.createProfileFamily({ name: 'Tulip narrator', fields: { strategy: 'EXPRESSIVE' } }, 'editor');
    const other = await s.service.createProfileFamily({ name: 'Other narrator', fields: { providerSettings: { stability: 0.7 } } }, 'editor');
    await s.service.setSelection(projectId, { familyId: tulip.familyId, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 }, 'editor');
    const scope = { kind: 'AUDITION', seconds: 30 } as const;
    const configOf = async (number: number) => VoiceRunConfig.parse((await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } })).config);

    // Another saved profile, named for an audition: as saved (EXPLICIT), none of this project's overrides.
    const audition = await s.service.createRun(projectId, { scope, profileId: other.versionId }, 'editor');
    await s.runner.drain();
    const explicit = await configOf(audition.run);
    expect(explicit).toMatchObject({ reconstructed: false, selection: { mode: 'EXPLICIT', revision: 1 }, projectOverrides: {}, runOptions: {}, provenance: {}, profile: { versionId: other.versionId, familyName: 'Other narrator' } });
    expect(explicit.effective.providerSettings.stability).toBe(0.7);

    // A plan of production pins v1; v2 is saved before it is generated: the run is v1, with the project's overrides it was planned with.
    const plan = await s.service.plan(projectId, { scope });
    expect(plan.profile.id).toBe(tulip.versionId);
    expect(plan.configuration).toMatchObject({ mode: 'FOLLOW', selectionRevision: 1, projectOverrides: { providerSettings: { stability: 0.4 } }, provenance: { 'providerSettings.stability': 'PROJECT' } });
    await s.service.newProfileVersion(tulip.familyId, { fields: { strategy: 'PLAIN' } }, 'editor');
    const pinned = await s.service.createRun(projectId, { scope, profileId: plan.profile.id, selectionRevision: plan.configuration.selectionRevision }, 'editor');
    await s.runner.drain();
    const snapshot = await configOf(pinned.run);
    expect(snapshot).toMatchObject({ selection: { mode: 'FOLLOW', revision: 1 }, profile: { versionId: tulip.versionId, version: 1 }, projectOverrides: { providerSettings: { stability: 0.4 } } });
    expect(snapshot.effective).toMatchObject({ strategy: 'EXPRESSIVE', providerSettings: { stability: 0.4 } });
    // The first takes carry the run's configuration.
    for (const t of await db.voiceGeneration.findMany({ where: { run: { projectId, number: pinned.run } } })) {
      expect(VoiceTakeConfig.parse(t.config)).toEqual({ reconstructed: false, base: 'RUN', override: null, profile: snapshot.profile, effective: snapshot.effective, provenance: snapshot.provenance, differs: [], identityDiffers: false });
      expect(t).toMatchObject({ profileId: tulip.versionId, strategy: 'EXPRESSIVE' });
    }
    // The overrides changed since the plan: generating it is refused.
    await s.service.setSelection(projectId, { familyId: tulip.familyId, overrides: {}, revision: 1 }, 'editor');
    await expect(s.service.createRun(projectId, { scope, selectionRevision: 1 }, 'editor')).rejects.toThrow(/^The project's voice profile or its overrides changed since this was planned \(revision 1, now 2\): plan again$/);
    await expect(s.service.createExperiment(projectId, { scope, name: 'Late (test)', variants: [{ strategy: 'PLAIN' }, { strategy: 'RESTRAINED' }], selectionRevision: 1, confirm: true }, 'editor')).rejects.toThrow(/plan again/);
    // An archived profile is not narrated with unless it is production's own.
    await s.service.updateProfileFamily(other.familyId, { archived: true }, 'editor');
    await refused(s.service.plan(projectId, { scope, profileId: other.versionId }), /^Profile Other narrator is archived: unarchive it to narrate with it$/);
    // A comparison of saved profiles: each variant its own version, the production one with the project's overrides.
    await s.service.updateProfileFamily(other.familyId, { archived: false }, 'editor');
    await s.service.setSelection(projectId, { familyId: tulip.familyId, overrides: { numberStyle: 'US' }, revision: 2 }, 'editor');
    const compared = await s.service.createExperiment(projectId, { scope, name: 'Profiles (test)', variants: [{ label: 'Tulip' }, { label: 'Other', profileId: other.versionId }], confirm: true }, 'editor');
    const [a, b] = await Promise.all(compared.runs.map(configOf));
    expect(a).toMatchObject({ selection: { mode: 'FOLLOW', revision: 3 }, profile: { version: 2, familyName: 'Tulip narrator' }, projectOverrides: { numberStyle: 'US' }, effective: { numberStyle: 'US', strategy: 'PLAIN' } });
    expect(b).toMatchObject({ selection: { mode: 'EXPLICIT', revision: 3 }, profile: { versionId: other.versionId }, projectOverrides: {}, effective: { numberStyle: 'UK' } });
  });

  it('changes no version, run snapshot or take configuration when profiles are edited, renamed, duplicated, archived, made default, or a project’s choice changes', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const tulip = await s.service.createProfileFamily({ name: 'Tulip narrator', fields: { strategy: 'EXPRESSIVE' } }, 'editor');
    await s.service.setSelection(projectId, { familyId: tulip.familyId, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 }, 'editor');
    const { run: number } = await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const runRow = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId, number } }, include: { profile: { include: { family: true } }, generations: { include: { profile: { include: { family: true } } } } } });
    await s.service.regenerate(runRow.id, { chunkIds: [runRow.generations[0]!.chunkId], override: { providerSettings: { similarity: 0.9 } } }, 'editor');
    await s.runner.drain();
    const profiles = await rows('voice_profiles');
    const runs = await rows('voice_runs', 'config');
    const takes = await rows('voice_generations', 'config');
    const read = () =>
      db.voiceRun.findUniqueOrThrow({ where: { id: runRow.id }, include: { profile: { include: { family: true } }, generations: { orderBy: { generation: 'asc' }, include: { profile: { include: { family: true } } } } } }).then((r) => {
        const c = runConfig(r, voice);
        return { run: c, takes: r.generations.map((g) => takeConfig(g, c)) };
      });
    const readBefore = await read();
    const callsBefore = (await db.providerCall.findMany({ where: { projectId }, orderBy: { startedAt: 'asc' } })).length;

    // Every library and selection operation.
    await s.service.newProfileVersion(tulip.familyId, { fields: { strategy: 'PLAIN', providerSettings: { stability: 0.2 } } }, 'editor');
    await s.service.updateProfileFamily(tulip.familyId, { name: 'Classic narrator', description: 'Renamed' }, 'editor');
    const dup = await s.service.duplicateProfile(tulip.familyId, { fromVersionId: tulip.versionId, name: 'Copy narrator' }, 'editor');
    await s.service.updateProfileFamily(dup.familyId, { archived: true }, 'editor');
    await s.service.updateProfileFamily(tulip.familyId, { isDefault: true }, 'editor');
    await s.service.setSelection(projectId, { familyId: tulip.familyId, versionId: tulip.versionId, overrides: { numberStyle: 'US' }, revision: 1 }, 'editor');
    await s.service.setSelection(projectId, { familyId: null, overrides: { providerSettings: { stability: 0.9 } }, revision: 2 }, 'editor');
    await s.service.saveRunAsProfile(runRow.id, { name: 'Saved narrator', use: true }, 'editor');

    const profilesAfter = await rows('voice_profiles');
    for (const [id, row] of profiles) expect(profilesAfter.get(id)).toBe(row);
    const runsAfter = await rows('voice_runs', 'config');
    for (const [id, config] of runs) expect(runsAfter.get(id)).toBe(config);
    const takesAfter = await rows('voice_generations', 'config');
    for (const [id, config] of takes) expect(takesAfter.get(id)).toBe(config);
    // Read back the same: the snapshot keeps the names the run was made with (the family is "Classic narrator" now).
    expect(await read()).toEqual(readBefore);
    expect(readBefore.run.profile).toMatchObject({ name: 'Tulip narrator', familyName: 'Tulip narrator' });
    // A RUN regeneration of the run still sends what it sent: its stored configuration.
    const calls = (n: number) => db.providerCall.findMany({ where: { projectId }, orderBy: { startedAt: 'asc' } }).then((c) => c.slice(n));
    await s.service.regenerate(runRow.id, { chunkIds: [runRow.generations[1]!.chunkId] }, 'editor');
    await s.runner.drain();
    const [regenerated] = await calls(callsBefore);
    expect(regenerated!.request).toMatchObject({ profile: { versionId: tulip.versionId, version: 1 }, configuration: { base: 'RUN', override: null } });
    const latest = await db.voiceGeneration.findFirstOrThrow({ where: { chunkId: runRow.generations[1]!.chunkId }, orderBy: { generation: 'desc' } });
    expect(VoiceTakeConfig.parse(latest.config).effective).toEqual(readBefore.run.effective);
  });
});
