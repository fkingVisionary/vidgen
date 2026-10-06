import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERFORMANCE_RULES,
  DEFAULT_VOICE_PROFILE_CONFIG,
  EARLIER_PERFORMANCE_RULES,
  type VoicePlanView,
  type VoiceProductionView,
  type VoiceProfileHistoryView,
  type VoiceProfileLibraryView,
  type VoiceView,
} from '@docengine/core';
import { Prisma } from '@docengine/database';
import { ALL_MOCK, MockVoiceProvider, createProviders, type NarrationRequest, type NarrationResult, type ProviderSet } from '@docengine/providers';
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
 * Saved voice profiles through the API (MOCK voice): the library — list,
 * create, history, edit, duplicate, rename, archive, default — a project's
 * choice of profile and its overrides, plans pinned to the selection's
 * revision, a run's (and a take's) configuration saved as a profile and
 * used, regeneration with the production profile and with a temporary
 * override, and a run made before saved profiles read back reconstructed.
 * Status codes: 400 invalid input, 404 unknown ids, 409 profile rules and
 * stale revisions.
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

/** A logged line as JSON (loosely typed: it is checked field by field). */
type Line = Record<string, any>;

/** The app on MOCK providers (or these in their place) and the fake script model, with its JSON log lines kept. */
async function start(providers: Partial<ProviderSet> = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent' });
  const c = createContainer(env, logger, { db, providers: { ...createProviders(ALL_MOCK), ai: new FakeScriptAI(), ...providers } });
  const app = await buildApp(c);
  open.push({ app, c });
  const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();
  const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) => app.inject({ method, url, payload: payload as object });
  const of = (msg: string): Line[] => lines.filter((l) => l.msg === msg);
  return { app, c, get, send, of, lines };
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

/** The mock's five settings at their defaults. */
const MOCK_DEFAULTS = { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 };

const message = (res: { json: <T>() => T }) => res.json<{ message: string }>().message;

/** The mock voice reporting a figure of its own beside the characters sent, as ElevenLabs' character-cost header does (about 0.11 of them under v4). */
class ReportingMockVoice extends MockVoiceProvider {
  override async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    const out = await super.generateNarration(req);
    return { ...out, meta: { ...out.meta, reportedUsage: [{ name: 'character-cost', quantity: Math.round(req.text.length * 0.11) }] } };
  }
}

describe('saved voice profiles through the API', () => {
  it('the library: list (archived on request, another provider as it is), create from the provider defaults, history with changes, edits (stale or empty refused), duplicate to another language, rename, default, archive and unarchive; the earlier route is gone', async () => {
    const { get, send, of, app } = await start();
    let library = await get<VoiceProfileLibraryView>('/api/voice/profiles');
    expect(library).toMatchObject({ provider: { name: 'mock', mock: true, defaultModel: 'mock', defaultOutputFormat: 'wav_22050' }, families: [] });
    expect(library.settings.map((d) => d.key)).toEqual(['stability', 'similarity', 'style', 'speakerBoost', 'speed']);
    expect(library.defaults).toEqual({ ...DEFAULT_VOICE_PROFILE_CONFIG, providerSettings: MOCK_DEFAULTS });

    // A profile of another provider (kept from when it was configured): listed as it is, its settings raw.
    const other = await db.voiceProfileFamily.create({ data: { name: 'Eleven narrator' } });
    await db.voiceProfile.create({
      data: { familyId: other.id, name: 'Eleven narrator', version: 1, provider: 'elevenlabs', voiceId: 'another-voice', modelId: 'eleven_v4', language: 'en', outputFormat: 'mp3_44100_128', config: { ...DEFAULT_VOICE_PROFILE_CONFIG, providerSettings: { stability: 0.45, similarity: 0.8 } } as unknown as Prisma.InputJsonValue, active: false },
    });

    // Create: the house default and the provider's setting defaults, with the fields given over them.
    const created = await send('POST', '/api/voice/profiles', { name: 'Tulip narrator', description: 'For the tulip film', fields: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.4 } }, notes: 'First cut (test).' });
    expect(created.statusCode).toBe(201);
    const tulip = created.json<VoiceProfileHistoryView>();
    expect(tulip).toMatchObject({ name: 'Tulip narrator', description: 'For the tulip film', isDefault: false, archived: false, provider: 'mock', language: 'en', versions: 1, usedBy: [], runs: 0 });
    expect(tulip.current).toMatchObject({ version: 1, current: true, origin: { kind: 'LIBRARY' }, changes: [], notes: 'First cut (test).', voiceId: 'mock-narrator-deep', voiceName: null, modelId: 'mock', outputFormat: 'wav_22050' });
    expect(tulip.current!.config).toEqual({ ...DEFAULT_VOICE_PROFILE_CONFIG, strategy: 'EXPRESSIVE', providerSettings: { ...MOCK_DEFAULTS, stability: 0.4 } });
    expect(tulip.history.map((h) => h.id)).toEqual([tulip.current!.id]);
    const v1 = tulip.current!;

    // Refused: a name taken (ignoring case), settings the provider does not describe, an unmeasurable format (409); invalid input (400).
    expect(message(await send('POST', '/api/voice/profiles', { name: 'tulip NARRATOR' }))).toMatch(/already named "Tulip narrator"/);
    expect((await send('POST', '/api/voice/profiles', { name: 'Odd', fields: { providerSettings: { warmth: 1 } } })).statusCode).toBe(409);
    expect((await send('POST', '/api/voice/profiles', { name: 'Odd', fields: { providerSettings: { stability: 3 } } })).statusCode).toBe(409);
    expect(message(await send('POST', '/api/voice/profiles', { name: 'Odd', fields: { outputFormat: 'ogg_44100' } }))).toMatch(/cannot be measured or joined/);
    expect((await send('POST', '/api/voice/profiles', { name: '' })).statusCode).toBe(400);
    expect((await send('POST', '/api/voice/profiles', { name: 'Odd', fields: { model: 'mock' } })).statusCode).toBe(400);

    // An edit is a new version; the history says what changed; the version before is kept.
    const base = `/api/voice/profiles/${tulip.id}`;
    const edited = await send('POST', `${base}/versions`, { expectedCurrent: v1.id, fields: { strategy: 'RESTRAINED' }, notes: 'Calmer (test).' });
    expect(edited.statusCode).toBe(201);
    let history = edited.json<VoiceProfileHistoryView>();
    expect(history.history.map((h) => [h.version, h.current, h.origin, h.changes])).toEqual([
      [2, true, { kind: 'EDIT', basedOnVersion: 1 }, ['performance: expressive → restrained']],
      [1, false, { kind: 'LIBRARY' }, []],
    ]);
    const v2 = history.current!;
    // Made in another tab against v1, or changing nothing: refused, nothing saved; the language is the family's (400).
    expect(message(await send('POST', `${base}/versions`, { expectedCurrent: v1.id, fields: { numberStyle: 'US' } }))).toMatch(/changed since you opened it \(now v2\)/);
    expect(message(await send('POST', `${base}/versions`, { expectedCurrent: v2.id, fields: { strategy: 'RESTRAINED' } }))).toMatch(/^Nothing changed/);
    expect((await send('POST', `${base}/versions`, { fields: { language: 'es' } })).statusCode).toBe(400);
    expect((await get<VoiceProfileHistoryView>(base)).versions).toBe(2);
    // Going back is an edit from an earlier version.
    const back = await send('POST', `${base}/versions`, { expectedCurrent: v2.id, basedOn: v1.id, fields: {} });
    expect(back.json<VoiceProfileHistoryView>().current).toMatchObject({ version: 3, origin: { kind: 'EDIT', basedOnVersion: 1 }, changes: ['performance: restrained → expressive'] });

    // Duplicate any version, into another language.
    const dup = await send('POST', `${base}/duplicate`, { fromVersionId: v1.id, name: 'Tulip narrator (es)', fields: { language: 'es' } });
    expect(dup.statusCode).toBe(201);
    const spanish = dup.json<VoiceProfileHistoryView>();
    expect(spanish).toMatchObject({ name: 'Tulip narrator (es)', language: 'es', versions: 1, current: { version: 1, language: 'es', origin: { kind: 'DUPLICATE', fromFamily: 'Tulip narrator', fromVersion: 1 }, config: { strategy: 'EXPRESSIVE' } } });

    // Rename and describe (versions keep the name they were made with), make default, archive, unarchive.
    const renamed = await send('PATCH', base, { name: 'Tulip narrator (en)', description: 'Renamed (test).' });
    expect(renamed.json<VoiceProfileHistoryView>()).toMatchObject({ name: 'Tulip narrator (en)', description: 'Renamed (test).' });
    expect(renamed.json<VoiceProfileHistoryView>().history.map((h) => h.name)).toEqual(['Tulip narrator', 'Tulip narrator', 'Tulip narrator']);
    expect((await send('PATCH', base, { isDefault: true })).json<VoiceProfileHistoryView>()).toMatchObject({ isDefault: true });
    expect(message(await send('PATCH', base, { archived: true }))).toMatch(/library default: make another profile the library default first/);
    const spanishUrl = `/api/voice/profiles/${spanish.id}`;
    expect((await send('PATCH', spanishUrl, { archived: true })).json<VoiceProfileHistoryView>()).toMatchObject({ archived: true });
    expect(message(await send('POST', `${spanishUrl}/versions`, { fields: { strategy: 'PLAIN' } }))).toMatch(/archived: unarchive it to edit it/);
    library = await get<VoiceProfileLibraryView>('/api/voice/profiles');
    expect(library.families.map((f) => [f.name, f.isDefault, f.archived, f.provider])).toEqual([
      ['Tulip narrator (en)', true, false, 'mock'],
      ['Eleven narrator', false, false, 'elevenlabs'],
    ]);
    expect(library.families[1]!.current!.config.providerSettings).toEqual({ stability: 0.45, similarity: 0.8 });
    expect((await get<VoiceProfileLibraryView>('/api/voice/profiles?archived=true')).families.map((f) => [f.name, f.archived])).toEqual([
      ['Tulip narrator (en)', false],
      ['Eleven narrator', false],
      ['Tulip narrator (es)', true],
    ]);
    expect((await send('PATCH', spanishUrl, { archived: false })).json<VoiceProfileHistoryView>()).toMatchObject({ archived: false });
    expect((await send('PATCH', spanishUrl, {})).statusCode).toBe(400);

    // Unknown profiles are 404, malformed ids 400; the earlier per-project route and the version archive are gone.
    const unknown = `/api/voice/profiles/${randomUUID()}`;
    expect((await app.inject({ method: 'GET', url: unknown })).statusCode).toBe(404);
    expect((await send('PATCH', unknown, { name: 'Nobody' })).statusCode).toBe(404);
    expect((await send('POST', `${unknown}/versions`, { fields: { strategy: 'PLAIN' } })).statusCode).toBe(404);
    expect((await send('POST', `${unknown}/duplicate`, { name: 'Nobody' })).statusCode).toBe(404);
    expect((await send('POST', `${base}/versions`, { basedOn: randomUUID(), fields: { strategy: 'PLAIN' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/voice/profiles/not-an-id' })).statusCode).toBe(400);
    expect((await send('POST', '/api/projects/tulip-mania/voice/profiles', { settings: { stability: 0.4 } })).statusCode).toBe(404);
    expect((await send('POST', `/api/voice/profile-versions/${v1.id}/archive`, {})).statusCode).toBe(404);

    // Library operations write no project event: the API logs them, with who, which profile and which version.
    expect(of('voice profile created')).toEqual([expect.objectContaining({ actor: 'dashboard', familyId: tulip.id, versionId: v1.id, version: 1 })]);
    expect(of('voice profile version saved').map((l) => [l.familyId, l.version])).toEqual([
      [tulip.id, 2],
      [tulip.id, 3],
    ]);
    expect(of('voice profile duplicated')).toEqual([expect.objectContaining({ actor: 'dashboard', familyId: spanish.id, versionId: spanish.current!.id, version: 1, from: tulip.id })]);
    expect(of('voice profile updated').map((l) => [l.familyId, l.version, l.change])).toEqual([
      [tulip.id, 3, { name: 'Tulip narrator (en)', description: 'Renamed (test).' }],
      [tulip.id, 3, { isDefault: true }],
      [spanish.id, 1, { archived: true }],
      [spanish.id, 1, { archived: false }],
    ]);
    expect(await db.projectEvent.count({ where: { type: { startsWith: 'VOICE_PROFILE' } } })).toBe(0);
  });

  it("a project's choice: the library default until one is chosen, overrides that never touch the profile, revisions checked, a plan refused when the choice changed since", async () => {
    const { app, c, get, send, of } = await start();
    const id = await approvedScript(c);
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    const selection = `/api/projects/${id}/voice/selection`;

    // A read never writes: no library default yet, and none is made until the first plan.
    expect(await get<VoiceProductionView>(selection)).toMatchObject({ language: 'en', mode: 'DEFAULT', revision: 0, family: null, profile: null, effective: null, problem: null });
    expect((await get<VoiceProductionView>(selection)).notices).toEqual([expect.stringMatching(/the house profile is made at the first plan/)]);
    expect(await db.voiceProfileFamily.count()).toBe(0);

    // An entry the term detector has since replaced ("Meet Thijs": a sentence's first word glued onto the name) reads as
    // withdrawn, against the approved script's text; one an editor has touched does not; no row is changed.
    const block = await db.scriptBlock.findFirstOrThrow({ where: { script: { projectId: id } }, orderBy: { sortOrder: 'desc' } });
    await db.scriptBlock.update({ where: { id: block.id }, data: { text: `${block.text} Meet Thijs, a Haarlem craftsman.` } });
    await db.voicePronunciation.createMany({
      data: [
        { projectId: id, language: 'en', term: 'Meet Thijs', kind: 'NAME', status: 'PENDING', source: 'DETECTED' },
        { projectId: id, language: 'en', term: 'Visit Thijs', kind: 'NAME', status: 'PENDING', source: 'DETECTED', updatedBy: 'editor' },
      ],
    });
    const terms = (await get<VoiceView>(`/api/projects/${id}/voice`)).pronunciations;
    expect(terms.map((t) => [t.term, t.status, t.withdrawn])).toEqual([
      ['Meet Thijs', 'PENDING', 'Thijs'],
      ['Visit Thijs', 'PENDING', null],
    ]);
    const audition = { scope: { kind: 'AUDITION', seconds: 60 } };
    const first = (await send('POST', `/api/projects/${id}/voice/plan`, audition)).json<VoicePlanView>();
    expect(first.configuration).toMatchObject({ mode: 'DEFAULT', selectionRevision: 0, projectOverrides: {}, runOptions: {} });
    let production = await get<VoiceProductionView>(selection);
    expect(production).toMatchObject({ mode: 'DEFAULT', revision: 0, family: { name: 'House narrator', isDefault: true, archived: false }, profile: { version: 1, origin: { kind: 'DEFAULTS' } }, effective: { provider: 'mock', strategy: 'RESTRAINED', providerSettings: MOCK_DEFAULTS }, provenance: {}, problem: null });

    const tulip = (await send('POST', '/api/voice/profiles', { name: 'Tulip narrator', fields: { strategy: 'EXPRESSIVE' } })).json<VoiceProfileHistoryView>();
    const house = production.family!;
    // A profile of another provider is kept in the library but cannot be chosen while this one is configured.
    const other = await db.voiceProfileFamily.create({ data: { name: 'Eleven narrator' } });
    await db.voiceProfile.create({
      data: { familyId: other.id, name: 'Eleven narrator', version: 1, provider: 'elevenlabs', voiceId: 'another-voice', modelId: 'eleven_v4', language: 'en', outputFormat: 'mp3_44100_128', config: { ...DEFAULT_VOICE_PROFILE_CONFIG, providerSettings: { stability: 0.5 } } as unknown as Prisma.InputJsonValue, active: false },
    });
    expect(message(await send('PUT', selection, { familyId: other.id, revision: 0 }))).toBe('Profile Eleven narrator v1 is for elevenlabs; the configured voice provider is mock');

    // Refused: another revision than the one stored (changed in another tab), a setting the provider does not describe, a language the project does not have.
    expect(message(await send('PUT', selection, { familyId: tulip.id, revision: 1 }))).toMatch(/changed in another tab \(revision 1, now 0\)/);
    expect(message(await send('PUT', selection, { familyId: tulip.id, overrides: { providerSettings: { warmth: 1 } }, revision: 0 }))).toMatch(/^Project overrides: .*warmth/);
    expect((await send('PUT', selection, { language: 'es', familyId: null, revision: 0 })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${selection}?language=es` })).statusCode).toBe(404);
    expect(message(await send('PUT', selection, { familyId: tulip.id, versionId: production.profile!.id, revision: 0 }))).toMatch(/is not a version of Tulip narrator/);
    expect((await send('PUT', selection, { familyId: null, versionId: tulip.current!.id, revision: 0 })).statusCode).toBe(400);
    expect((await send('PUT', selection, { familyId: tulip.id, overrides: { chunking: { minWords: 30, maxWords: 20 } }, revision: 0 })).statusCode).toBe(400);
    expect((await send('PUT', `/api/projects/${randomUUID()}/voice/selection`, { familyId: null, revision: 0 })).statusCode).toBe(404);

    // Chosen, following its current version, with the project's own overrides; the saved profile is unchanged.
    const chosen = await send('PUT', selection, { familyId: tulip.id, overrides: { strategy: 'PLAIN', providerSettings: { stability: 0.3 } }, revision: 0 });
    expect(chosen.statusCode).toBe(200);
    production = chosen.json<VoiceProductionView>();
    expect(production).toMatchObject({ mode: 'FOLLOW', revision: 1, family: { id: tulip.id, name: 'Tulip narrator' }, profile: { id: tulip.current!.id, version: 1 }, newer: null, overrides: { strategy: 'PLAIN', providerSettings: { stability: 0.3 } }, updatedBy: 'dashboard' });
    expect(production.effective).toMatchObject({ strategy: 'PLAIN', providerSettings: { ...MOCK_DEFAULTS, stability: 0.3 } });
    expect(production.provenance).toEqual({ strategy: 'PROJECT', 'providerSettings.stability': 'PROJECT' });
    expect(production.sent).toMatchObject({ stability: 0.3 });
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulip.id}`)).current!.config).toMatchObject({ strategy: 'EXPRESSIVE', providerSettings: { stability: 0.5 } });
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulip.id}`)).usedBy).toEqual([{ projectId: id, slug: project.slug, title: 'Tulip Mania', language: 'en', mode: 'FOLLOW', pinnedVersion: null }]);
    expect(of('voice profile selected')).toEqual([expect.objectContaining({ actor: 'dashboard', projectId: id, familyId: tulip.id, versionId: null, revision: 1 })]);
    expect(await db.projectEvent.findFirst({ where: { projectId: id, type: 'VOICE_PROFILE_SELECTED' } })).toMatchObject({ message: expect.stringMatching(/^Voice profile for en: Tulip narrator/) });

    // The Voice page shows production and the profiles it can choose (this provider and language only).
    const view = await get<VoiceView>(`/api/projects/${id}/voice`);
    expect(view.production).toEqual(production);
    expect(view.library.map((f) => f.name).sort()).toEqual(['House narrator', 'Tulip narrator']);
    expect((await get<VoiceProfileLibraryView>('/api/voice/profiles')).families.map((f) => f.name).sort()).toEqual(['Eleven narrator', 'House narrator', 'Tulip narrator']);
    expect(view.provider).toMatchObject({ name: 'mock', models: expect.any(Array) });
    expect(view.provider.settings.map((d) => d.key)).toEqual(['stability', 'similarity', 'style', 'speakerBoost', 'speed']);

    // A plan carries the revision it was made at; generating it after the overrides changed is refused (plan again).
    const planned = (await send('POST', `/api/projects/${id}/voice/plan`, audition)).json<VoicePlanView>();
    expect(planned.configuration).toMatchObject({ mode: 'FOLLOW', selectionRevision: 1, projectOverrides: { strategy: 'PLAIN' }, effective: { strategy: 'PLAIN' } });
    expect(planned.profile).toMatchObject({ id: tulip.current!.id, familyId: tulip.id });
    expect((await send('PUT', selection, { familyId: tulip.id, overrides: {}, revision: 1 })).json<VoiceProductionView>()).toMatchObject({ revision: 2, overrides: {}, provenance: {} });
    expect(message(await send('POST', `/api/projects/${id}/voice/plan`, { ...audition, selectionRevision: 1 }))).toMatch(/changed since this was planned \(revision 1, now 2\)/);
    expect(message(await send('POST', `/api/projects/${id}/voice/runs`, { ...audition, profileId: planned.profile.id, selectionRevision: 1 }))).toMatch(/plan again/);
    expect(await db.voiceRun.count()).toBe(0);

    // Pinned to v1 while v2 is current; then back to the library default.
    await send('POST', `/api/voice/profiles/${tulip.id}/versions`, { fields: { strategy: 'RESTRAINED' } });
    production = (await send('PUT', selection, { familyId: tulip.id, versionId: tulip.current!.id, revision: 2 })).json<VoiceProductionView>();
    expect(production).toMatchObject({ mode: 'PIN', revision: 3, profile: { version: 1, current: false }, newer: { version: 2 }, effective: { strategy: 'EXPRESSIVE' } });
    expect(production.notices).toEqual([expect.stringMatching(/^Pinned to v1: v2 of Tulip narrator is its current version/)]);
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulip.id}`)).usedBy).toEqual([expect.objectContaining({ mode: 'PIN', pinnedVersion: 1 })]);
    expect((await send('PUT', selection, { familyId: null, revision: 3 })).json<VoiceProductionView>()).toMatchObject({ mode: 'DEFAULT', revision: 4, family: { id: house.id } });
  });

  it("a run's configuration saved as a profile and used (overrides cleared), a take's saved as a version, regeneration with the production profile and with a temporary override, and a run from before saved profiles read back reconstructed", async () => {
    const { c, get, send, of } = await start();
    const id = await approvedScript(c);
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    const selection = `/api/projects/${id}/voice/selection`;
    const audition = { scope: { kind: 'AUDITION', seconds: 60 } };

    // The library default with a project override, and a run with an option of its own.
    await send('POST', `/api/projects/${id}/voice/plan`, audition);
    expect((await send('PUT', selection, { familyId: null, overrides: { providerSettings: { stability: 0.4 } }, revision: 0 })).statusCode).toBe(200);
    const queued = await send('POST', `/api/projects/${id}/voice/runs`, { ...audition, options: { strategy: 'EXPRESSIVE' } });
    expect(queued.statusCode).toBe(202);
    await c.runner.drain();
    let run = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!;
    expect(run.configuration).toMatchObject({ reconstructed: false, profile: { familyName: 'House narrator', version: 1 }, selection: { mode: 'DEFAULT', revision: 1 }, projectOverrides: { providerSettings: { stability: 0.4 } }, runOptions: { strategy: 'EXPRESSIVE' }, effective: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.4 } } });
    expect(run.configuration.provenance).toEqual({ 'providerSettings.stability': 'PROJECT', strategy: 'RUN' });
    expect(run.profile).toMatchObject({ name: 'House narrator', version: 1, familyName: 'House narrator' });
    expect(run.chunks.every((ch) => ch.current!.configuration.base === 'RUN' && ch.current!.configuration.override === null && ch.current!.configuration.differs.length === 0)).toBe(true);
    expect(run.chunks[0]!.current!.cost).toMatchObject({ basis: 'MOCK', estimatedUsd: 0, characters: run.chunks[0]!.current!.characters, reported: [], reestimated: false });
    const houseId = run.configuration.profile.familyId!;
    expect((await get<VoiceProfileLibraryView>('/api/voice/profiles')).families.find((f) => f.id === houseId)).toMatchObject({ name: 'House narrator', versions: 1, runs: 1, current: { version: 1, runs: 1 } });

    // Save it as a new profile and use it: production follows it, the project's override is cleared (it is in what was saved) and returned.
    const saved = await send('POST', `/api/voice/runs/${run.id}/save-profile`, { name: 'Tulip narrator', description: 'The accepted take on the opening', use: true });
    expect(saved.statusCode).toBe(201);
    const body = saved.json<{ profile: VoiceProfileHistoryView; production: VoiceProductionView; clearedOverrides: object | null }>();
    expect(body.clearedOverrides).toEqual({ providerSettings: { stability: 0.4 } });
    expect(body.profile).toMatchObject({ name: 'Tulip narrator', description: 'The accepted take on the opening', isDefault: false, versions: 1 });
    expect(body.profile.current).toMatchObject({ version: 1, notes: `Saved from voice run 1 of ${project.slug}`, origin: { kind: 'RUN', runId: run.id, run: 1, projectId: id, project: project.slug, experiment: null, variant: null, takeId: null, reconstructed: false } });
    expect(body.production).toMatchObject({ mode: 'FOLLOW', revision: 2, family: { id: body.profile.id }, profile: { id: body.profile.current!.id }, overrides: {}, provenance: {} });
    expect(body.production.effective).toEqual(run.configuration.effective);
    expect(await get<VoiceProductionView>(selection)).toEqual(body.production);
    expect(of('voice profile saved from a run')).toEqual([expect.objectContaining({ actor: 'dashboard', familyId: body.profile.id, versionId: body.profile.current!.id, version: 1, runId: run.id, generationId: null, selected: true })]);
    const events = await db.projectEvent.findMany({ where: { projectId: id, type: { in: ['VOICE_PROFILE_CREATED', 'VOICE_PROFILE_SELECTED'] } } });
    expect(events.map((e) => e.type).sort()).toEqual(['VOICE_PROFILE_CREATED', 'VOICE_PROFILE_SELECTED', 'VOICE_PROFILE_SELECTED']);
    expect(events.find((e) => e.type === 'VOICE_PROFILE_SELECTED' && (e.data as { clearedOverrides?: unknown }).clearedOverrides)).toMatchObject({
      message: 'Voice profile for en: Tulip narrator, follows the current version (v1) (project overrides cleared: stability 0.4; they are part of the saved profile)',
    });
    const tulipId = body.profile.id;

    // The profile changes (v2); the run keeps what it was made with.
    await send('POST', `/api/voice/profiles/${tulipId}/versions`, { fields: { providerSettings: { stability: 0.6 } } });
    const before = run.configuration;

    // Regenerate one chunk with the production profile now, another with a temporary override: each take says what it was made with.
    const [first, second, third] = run.chunks;
    expect((await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [first!.id], configuration: 'PRODUCTION', selectionRevision: 2 })).statusCode).toBe(202);
    await c.runner.drain();
    expect((await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [second!.id], override: { strategy: 'PLAIN', providerSettings: { stability: 0.3 } } })).statusCode).toBe(202);
    await c.runner.drain();
    run = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!;
    expect(run.configuration).toEqual(before);
    const production = run.chunks[0]!.current!;
    expect(production).toMatchObject({ generation: 2, profile: { familyId: tulipId, familyName: 'Tulip narrator', name: 'Tulip narrator', version: 2 } });
    expect(production.configuration).toMatchObject({ base: 'PRODUCTION', override: null, reconstructed: false, profile: { familyId: tulipId, version: 2 }, differs: ['stability: 0.6 (run: 0.4)'], identityDiffers: true });
    const overridden = run.chunks[1]!.current!;
    expect(overridden).toMatchObject({ generation: 2, strategy: 'PLAIN', profile: { name: 'House narrator', version: 1 } });
    expect(overridden.configuration).toMatchObject({ base: 'RUN', override: { strategy: 'PLAIN', providerSettings: { stability: 0.3 } }, differs: ['performance: plain (run: expressive)', 'stability: 0.3 (run: 0.4)'], identityDiffers: true });
    expect(run.chunks[2]!.current!.configuration).toMatchObject({ base: 'RUN', override: null, differs: [] });
    expect(run.qa.filter((f) => f.kind === 'CONFIGURATION_DIFFERS').map((f) => f.severity)).toEqual(['WARNING', 'WARNING']);
    // The override was kept with its take only.
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulipId}`)).current).toMatchObject({ version: 2, config: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.6 } } });

    // Refused: chunking for a take (400: its chunk is the run's), a setting the provider does not describe (409), a stale revision (409), an unknown run (404).
    expect((await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [third!.id], override: { chunking: { minWords: 13, maxWords: 20 } } })).statusCode).toBe(400);
    expect(message(await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [third!.id], override: { providerSettings: { warmth: 1 } } }))).toMatch(/^Temporary override: .*warmth/);
    expect(message(await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [third!.id], configuration: 'PRODUCTION', selectionRevision: 1 }))).toMatch(/plan again/);
    expect((await send('POST', `/api/voice/runs/${randomUUID()}/regenerate`, { chunkIds: [third!.id] })).statusCode).toBe(404);

    // A take's configuration (the temporary override that was liked) saved as a new version of the profile; not used.
    const fromTake = await send('POST', `/api/voice/runs/${run.id}/save-profile`, { familyId: tulipId, generationId: overridden.id });
    expect(fromTake.statusCode).toBe(201);
    const takeBody = fromTake.json<{ profile: VoiceProfileHistoryView; production: VoiceProductionView | null; clearedOverrides: object | null }>();
    expect(takeBody).toMatchObject({ production: null, clearedOverrides: null, profile: { versions: 3, current: { version: 3, origin: { kind: 'RUN', takeId: overridden.id }, config: { strategy: 'PLAIN', providerSettings: { stability: 0.3 } } } } });
    expect(takeBody.profile.current!.notes).toBe(`Saved from take 2 (chunk 2) of voice run 1 of ${project.slug}`);
    expect(takeBody.profile.current!.changes).toEqual(['performance: expressive → plain', 'stability: 0.6 → 0.3']);

    // Invalid input (400) and unknown ids (404).
    expect((await send('POST', `/api/voice/runs/${run.id}/save-profile`, { name: 'Both', familyId: tulipId })).statusCode).toBe(400);
    expect((await send('POST', `/api/voice/runs/${run.id}/save-profile`, {})).statusCode).toBe(400);
    expect((await send('POST', `/api/voice/runs/${randomUUID()}/save-profile`, { name: 'Nobody' })).statusCode).toBe(404);
    expect((await send('POST', `/api/voice/runs/${run.id}/save-profile`, { name: 'Nobody', generationId: randomUUID() })).statusCode).toBe(404);
    expect((await send('POST', `/api/voice/runs/${run.id}/save-profile`, { familyId: randomUUID() })).statusCode).toBe(404);
    expect(message(await send('POST', `/api/voice/runs/${run.id}/save-profile`, { name: 'tulip narrator' }))).toMatch(/already named/);

    // The profile renamed: the run and its takes keep the version's own name and give the profile's name now; the
    // run's snapshot keeps the name it was made with.
    expect((await send('PATCH', `/api/voice/profiles/${houseId}`, { name: 'Classic narrator' })).statusCode).toBe(200);
    const renamed = await get<VoiceView>(`/api/projects/${id}/voice?run=1`);
    expect(renamed.runs[0]!.profile).toMatchObject({ name: 'House narrator', version: 1, familyId: houseId, familyName: 'Classic narrator' });
    expect(renamed.run!.chunks[2]!.current!.profile).toMatchObject({ name: 'House narrator', version: 1, familyName: 'Classic narrator' });
    expect(renamed.run!.configuration).toEqual(before);
    expect(renamed.run!.configuration.profile).toMatchObject({ name: 'House narrator', familyName: 'House narrator' });

    // A run made before saved profiles (no snapshot on it or its takes) reads back reconstructed from its version, strategy and settings.
    await db.voiceRun.update({ where: { id: run.id }, data: { config: Prisma.DbNull } });
    await db.voiceGeneration.updateMany({ where: { runId: run.id }, data: { config: Prisma.DbNull } });
    const old = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!;
    expect(old.configuration).toMatchObject({ reconstructed: true, selection: null, projectOverrides: {}, runOptions: { strategy: 'EXPRESSIVE' }, profile: { name: 'House narrator', familyName: 'Classic narrator', version: 1 }, effective: { strategy: 'EXPRESSIVE', chunking: run.settings.chunking, context: run.settings.context, pronunciation: { rules: [] }, providerSettings: MOCK_DEFAULTS } });
    expect(old.configuration.effective.performanceRules).toEqual(EARLIER_PERFORMANCE_RULES);
    expect(old.settings).toEqual(run.settings);
    expect(old.chunks.every((ch) => ch.generations.every((g) => g.configuration.reconstructed && g.configuration.base === 'RUN' && !g.configuration.identityDiffers))).toBe(true);
    expect(old.chunks[1]!.current!.configuration).toMatchObject({ override: { strategy: 'PLAIN' }, differs: ['performance: plain (run: expressive)'] });
    expect(old.qa.some((f) => f.kind === 'CONFIGURATION_DIFFERS')).toBe(false);
    const fromOld = (await send('POST', `/api/voice/runs/${run.id}/save-profile`, { name: 'From the old run' })).json<{ profile: VoiceProfileHistoryView }>();
    expect(fromOld.profile.current).toMatchObject({ origin: { kind: 'RUN', reconstructed: true }, config: { strategy: 'EXPRESSIVE', providerSettings: MOCK_DEFAULTS } });
  });

  it('every field a profile keeps, through the API; the House narrator as the migration leaves it reads as v1 of its family and edits into v2 with only what changed; a new library default takes the flag from it', async () => {
    const { get, send } = await start();

    // Production's House narrator after the migration: the earlier config (`settings`), no origin, active, in a family of its own that is the library default.
    const houseFamily = await db.voiceProfileFamily.create({ data: { name: 'House narrator', isDefault: true } });
    const earlier = { settings: MOCK_DEFAULTS, strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false }, numberStyle: 'UK' };
    const houseV1 = await db.voiceProfile.create({ data: { familyId: houseFamily.id, name: 'House narrator', version: 1, provider: 'mock', voiceId: 'mock-narrator-deep', modelId: 'mock', language: 'en', outputFormat: 'wav_22050', config: earlier, active: true } });
    const houseUrl = `/api/voice/profiles/${houseFamily.id}`;
    const house = await get<VoiceProfileHistoryView>(houseUrl);
    expect(house).toMatchObject({ isDefault: true, archived: false, provider: 'mock', language: 'en', versions: 1, runs: 0, current: { id: houseV1.id, version: 1, current: true, origin: { kind: 'LEGACY' }, changes: [], notes: null } });
    expect(house.current!.config).toEqual({ ...DEFAULT_VOICE_PROFILE_CONFIG, performanceRules: EARLIER_PERFORMANCE_RULES, providerSettings: MOCK_DEFAULTS });
    // Its edit is v2 in the current shape, differing in what was changed only; v1's row is not touched.
    const edited = (await send('POST', `${houseUrl}/versions`, { expectedCurrent: houseV1.id, fields: { providerSettings: { stability: 0.4 } } })).json<VoiceProfileHistoryView>();
    expect(edited.history.map((h) => [h.version, h.current, h.origin.kind, h.changes])).toEqual([
      [2, true, 'EDIT', ['stability: 0.5 → 0.4']],
      [1, false, 'LEGACY', []],
    ]);
    expect(edited.history[0]!.config).toEqual({ ...house.current!.config, providerSettings: { ...MOCK_DEFAULTS, stability: 0.4 } });
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: houseV1.id } })).toEqual(houseV1);

    // Every field: voice, model, output format, performance, chunk size, context, number style, the profile's own
    // pronunciation rules, performance rules and the provider's settings (the house default and the provider's defaults under the rest).
    const fields = {
      voiceId: 'mock-narrator-warm',
      modelId: 'mock',
      outputFormat: 'wav_44100',
      strategy: 'PLAIN',
      chunking: { minWords: 13, maxWords: 20 },
      context: { previousChars: 0, nextChars: 0, stitch: false },
      numberStyle: 'US',
      pronunciation: { rules: [{ term: 'Thijs', method: 'ALIAS', pronunciation: 'Tice' }, { term: 'Haarlem', method: 'IPA', pronunciation: 'ˈɦaːrlɛm' }] },
      performanceRules: { maxMarksPerChunk: 1, resetWord: 'plain spoken' },
      providerSettings: { similarity: 0.6, speakerBoost: false, speed: 1.05 },
    };
    const every = await send('POST', '/api/voice/profiles', { name: 'Every field', fields });
    expect(every.statusCode).toBe(201);
    const v1 = every.json<VoiceProfileHistoryView>().current!;
    expect(v1).toMatchObject({ provider: 'mock', voiceId: 'mock-narrator-warm', modelId: 'mock', language: 'en', outputFormat: 'wav_44100', origin: { kind: 'LIBRARY' } });
    const config = {
      strategy: 'PLAIN',
      chunking: fields.chunking,
      context: fields.context,
      numberStyle: 'US',
      pronunciation: fields.pronunciation,
      performanceRules: { ...DEFAULT_PERFORMANCE_RULES, maxMarksPerChunk: 1, resetWord: 'plain spoken' },
      providerSettings: { ...MOCK_DEFAULTS, similarity: 0.6, speakerBoost: false, speed: 1.05 },
    };
    expect(v1.config).toEqual(config);
    // Rules that cannot work together are refused: a reset word that is also a delivery word would make its directions read as resets.
    expect(message(await send('POST', '/api/voice/profiles', { name: 'Clash', fields: { performanceRules: { resetWord: 'quiet' } } }))).toBe('Performance rules: resetWord: "quiet" is also the word for low energy; a direction in it would be read as a reset');
    expect(message(await send('POST', `/api/voice/profiles/${v1.familyId}/versions`, { fields: { performanceRules: { deliveryWords: { ...DEFAULT_PERFORMANCE_RULES.deliveryWords, fastPace: 'plain spoken' } } } }))).toMatch(/^Performance rules: resetWord: "plain spoken" is also the word for fast pace/);
    // An edit merges performance rules and provider settings key by key; v1 keeps what it had.
    const v2 = (await send('POST', `/api/voice/profiles/${v1.familyId}/versions`, { expectedCurrent: v1.id, fields: { performanceRules: { minWordsBetweenMarks: 8 }, providerSettings: { style: 0.2 } } })).json<VoiceProfileHistoryView>();
    expect(v2.current!.changes).toEqual(['words between directions: 6 → 8', 'style: 0 → 0.2']);
    const config2 = { ...config, performanceRules: { ...config.performanceRules, minWordsBetweenMarks: 8 }, providerSettings: { ...config.providerSettings, style: 0.2 } };
    expect(v2.current!.config).toEqual(config2);
    expect(v2.history[1]!.config).toEqual(config);
    // A duplicate copies every field of the version it is made from.
    const copy = (await send('POST', `/api/voice/profiles/${v1.familyId}/duplicate`, { name: 'Every field copy' })).json<VoiceProfileHistoryView>();
    expect(copy.current).toMatchObject({ version: 1, voiceId: 'mock-narrator-warm', modelId: 'mock', language: 'en', outputFormat: 'wav_44100', origin: { kind: 'DUPLICATE', fromFamily: 'Every field', fromVersion: 2 } });
    expect(copy.current!.config).toEqual(config2);

    // One library default per provider and language: making another the default takes the flag from House narrator.
    expect((await send('PATCH', `/api/voice/profiles/${v1.familyId}`, { isDefault: true })).statusCode).toBe(200);
    const library = await get<VoiceProfileLibraryView>('/api/voice/profiles');
    expect(library.families.map((f) => [f.name, f.isDefault])).toEqual([
      ['Every field', true],
      ['Every field copy', false],
      ['House narrator', false],
    ]);
    expect(library.families[2]!.current).toMatchObject({ version: 2, current: true });
  });

  it("the user's path end to end: a run made with House narrator v1 as the migration leaves it reads as it was made; its configuration saved as a profile, chosen with a project override and auditioned; the profile edited, the audition kept and regenerated as it was by default, with the production profile, or with a temporary override, each take saying which; duplicate and archive; costs as characters sent beside the provider's own figure; no sentence's first word glued onto a name", async () => {
    const { c, get, send, of } = await start({ voice: new ReportingMockVoice() });
    const id = await approvedScript(c);
    const selection = `/api/projects/${id}/voice/selection`;
    const audition = { scope: { kind: 'AUDITION', seconds: 60 } };

    // Production as the migration leaves it: House narrator v1 in the earlier shape, active, the library default's only
    // version; the old detector's entry glued a sentence's first word onto a name ("Meet Thijs").
    const houseFamily = await db.voiceProfileFamily.create({ data: { name: 'House narrator', isDefault: true, createdBy: 'system' } });
    const earlier = { settings: MOCK_DEFAULTS, strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false }, numberStyle: 'UK' };
    const houseV1 = await db.voiceProfile.create({ data: { familyId: houseFamily.id, name: 'House narrator', version: 1, provider: 'mock', voiceId: 'mock-narrator-deep', modelId: 'mock', language: 'en', outputFormat: 'wav_22050', config: earlier, active: true, notes: 'Created from the configured defaults (mock)', createdBy: 'system' } });
    const opening = await db.scriptBlock.findFirstOrThrow({ where: { script: { projectId: id } }, orderBy: { sortOrder: 'asc' } });
    await db.scriptBlock.update({ where: { id: opening.id }, data: { text: `Meet Thijs, a Haarlem craftsman. ${opening.text}` } });
    await db.voicePronunciation.create({ data: { projectId: id, language: 'en', term: 'Meet Thijs', kind: 'NAME', status: 'PENDING', source: 'DETECTED' } });

    // Run 1 as the acceptance experiment's C was made: House narrator v1, expressive.
    const plan1 = (await send('POST', `/api/projects/${id}/voice/plan`, { ...audition, options: { strategy: 'EXPRESSIVE' } })).json<VoicePlanView>();
    expect(plan1.profile).toMatchObject({ id: houseV1.id, familyId: houseFamily.id, version: 1 });
    expect((await send('POST', `/api/projects/${id}/voice/runs`, { ...audition, options: { strategy: 'EXPRESSIVE' }, profileId: plan1.profile.id, selectionRevision: plan1.configuration.selectionRevision })).statusCode).toBe(202);
    await c.runner.drain();
    const made = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!;
    expect(made.configuration).toMatchObject({ reconstructed: false, profile: { versionId: houseV1.id, familyName: 'House narrator', version: 1 }, runOptions: { strategy: 'EXPRESSIVE' }, effective: { strategy: 'EXPRESSIVE', providerSettings: MOCK_DEFAULTS, pronunciation: { rules: [] } } });
    expect(made.configuration.effective.performanceRules).toEqual(EARLIER_PERFORMANCE_RULES);

    // The sentence's first word is not part of the name: Thijs and Haarlem are terms, the old entry reads as withdrawn, no row changed.
    const terms = (await get<VoiceView>(`/api/projects/${id}/voice`)).pronunciations;
    expect(terms.filter((t) => /^Meet\b/.test(t.term)).map((t) => [t.term, t.withdrawn])).toEqual([['Meet Thijs', 'Thijs']]);
    expect(terms.map((t) => t.term)).toEqual(expect.arrayContaining(['Thijs', 'Haarlem']));
    expect(await db.voicePronunciation.findFirstOrThrow({ where: { projectId: id, term: 'Meet Thijs' } })).toMatchObject({ status: 'PENDING', source: 'DETECTED', updatedBy: null });
    expect(made.chunks[0]!.text).toMatch(/^Meet Thijs, a Haarlem craftsman\./);

    // Made before saved profiles (production's seven runs: no configuration on the run or its takes), it reads as it was made.
    await db.voiceRun.update({ where: { id: made.id }, data: { config: Prisma.DbNull } });
    await db.voiceGeneration.updateMany({ where: { runId: made.id }, data: { config: Prisma.DbNull } });
    const old = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!;
    expect(old.configuration).toMatchObject({ reconstructed: true, selection: null, projectOverrides: {}, runOptions: { strategy: 'EXPRESSIVE' } });
    for (const k of ['profile', 'effective', 'provenance', 'sent', 'ignored'] as const) expect(old.configuration[k]).toEqual(made.configuration[k]);
    expect([old.settings, old.strategy]).toEqual([made.settings, made.strategy]);
    expect(old.chunks.every((ch) => ch.current!.configuration.reconstructed && ch.current!.configuration.base === 'RUN' && ch.current!.configuration.differs.length === 0)).toBe(true);
    // Regenerated by default, a chunk of it is made exactly as its first take was.
    expect((await send('POST', `/api/voice/runs/${old.id}/regenerate`, { chunkIds: [old.chunks[0]!.id] })).statusCode).toBe(202);
    await c.runner.drain();
    const remade = (await get<VoiceView>(`/api/projects/${id}/voice?run=1`)).run!.chunks[0]!;
    expect(remade.current).toMatchObject({ generation: 2, profile: { name: 'House narrator', version: 1 }, configuration: { base: 'RUN', override: null, differs: [], identityDiffers: false } });
    expect([remade.current!.performanceText, remade.current!.prepared!.settings]).toEqual([old.chunks[0]!.current!.performanceText, old.chunks[0]!.current!.prepared!.settings]);

    // Its configuration saved as a new profile, by name; the library default is untouched.
    const saved = (await send('POST', `/api/voice/runs/${old.id}/save-profile`, { name: 'Tulip narrator' })).json<{ profile: VoiceProfileHistoryView; production: VoiceProductionView | null }>();
    const tulip = saved.profile;
    expect(saved.production).toBeNull();
    expect(tulip).toMatchObject({ name: 'Tulip narrator', isDefault: false, versions: 1, current: { version: 1, origin: { kind: 'RUN', run: 1, reconstructed: true }, voiceId: 'mock-narrator-deep', modelId: 'mock', outputFormat: 'wav_22050' } });
    const { provider: _p, voiceId: _v, model: _m, language: _l, outputFormat: _o, ...configOfRun } = made.configuration.effective;
    expect(tulip.current!.config).toEqual(configOfRun);
    expect(await db.voiceProfile.findUniqueOrThrow({ where: { id: houseV1.id } })).toEqual(houseV1);

    // Chosen for the project with an override of the project's own; the saved profile keeps its value.
    const chosen = await send('PUT', selection, { familyId: tulip.id, overrides: { providerSettings: { stability: 0.35 } }, revision: 0 });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json<VoiceProductionView>()).toMatchObject({ mode: 'FOLLOW', revision: 1, profile: { id: tulip.current!.id }, effective: { strategy: 'EXPRESSIVE', providerSettings: { ...MOCK_DEFAULTS, stability: 0.35 } }, provenance: { 'providerSettings.stability': 'PROJECT' } });
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulip.id}`)).current!.config.providerSettings).toEqual(MOCK_DEFAULTS);
    // Overrides whose rules cannot work with the profile's are refused (the project's, a run's): a reset word that is also a delivery word.
    expect(message(await send('PUT', selection, { familyId: tulip.id, overrides: { performanceRules: { resetWord: 'quiet' } }, revision: 1 }))).toMatch(/^Project overrides: resetWord: "quiet" is also the word for low energy/);
    expect(message(await send('POST', `/api/projects/${id}/voice/plan`, { ...audition, options: { performanceRules: { resetWord: 'brisk' } } }))).toMatch(/^Performance rules .*resetWord: "brisk" is also the word for fast pace/);

    // An audition with the project's profile: planned and generated with the profile and the project's override.
    const plan2 = (await send('POST', `/api/projects/${id}/voice/plan`, audition)).json<VoicePlanView>();
    expect(plan2.profile).toMatchObject({ id: tulip.current!.id, familyId: tulip.id });
    expect(plan2.configuration).toMatchObject({ mode: 'FOLLOW', selectionRevision: 1, projectOverrides: { providerSettings: { stability: 0.35 } }, runOptions: {} });
    expect((await send('POST', `/api/projects/${id}/voice/runs`, { ...audition, profileId: plan2.profile.id, selectionRevision: 1 })).statusCode).toBe(202);
    await c.runner.drain();
    const run = (await get<VoiceView>(`/api/projects/${id}/voice?run=2`)).run!;
    expect(run.configuration).toMatchObject({ reconstructed: false, profile: { familyId: tulip.id, familyName: 'Tulip narrator', version: 1 }, selection: { mode: 'FOLLOW', revision: 1 }, projectOverrides: { providerSettings: { stability: 0.35 } }, runOptions: {}, effective: { strategy: 'EXPRESSIVE', providerSettings: { ...MOCK_DEFAULTS, stability: 0.35 } } });
    expect(run.configuration.provenance).toEqual({ 'providerSettings.stability': 'PROJECT' });
    expect(run.chunks.length).toBeGreaterThanOrEqual(4);
    expect(run.chunks.every((ch) => ch.current!.prepared!.settings.stability === 0.35 && ch.current!.configuration.base === 'RUN')).toBe(true);

    // The profile edited: a new version, production follows it; the audition and its takes keep what they were made with.
    const takesBefore = run.chunks.map((ch) => ch.generations.map((g) => g.configuration));
    const edited = await send('POST', `/api/voice/profiles/${tulip.id}/versions`, { expectedCurrent: tulip.current!.id, fields: { strategy: 'RESTRAINED', providerSettings: { similarity: 0.6 } } });
    expect(edited.json<VoiceProfileHistoryView>().current).toMatchObject({ version: 2, changes: ['performance: expressive → restrained', 'similarity: 0.75 → 0.6'] });
    expect(await get<VoiceProductionView>(selection)).toMatchObject({ revision: 1, profile: { version: 2 }, effective: { strategy: 'RESTRAINED', providerSettings: { stability: 0.35, similarity: 0.6 } } });
    const kept = (await get<VoiceView>(`/api/projects/${id}/voice?run=2`)).run!;
    expect(kept.configuration).toEqual(run.configuration);
    expect(kept.chunks.map((ch) => ch.generations.map((g) => g.configuration))).toEqual(takesBefore);

    // Regenerated: by default and with the run's configuration (as it was made), with the production profile now (v2 and
    // the project's override; the chunk is the run's), and with a temporary override. Each take and each log says which.
    const asks = [
      { chunkIds: [run.chunks[0]!.id] },
      { chunkIds: [run.chunks[1]!.id], configuration: 'RUN' },
      { chunkIds: [run.chunks[2]!.id], configuration: 'PRODUCTION', selectionRevision: 1 },
      { chunkIds: [run.chunks[3]!.id], override: { providerSettings: { stability: 0.2 } } },
    ];
    expect(message(await send('POST', `/api/voice/runs/${run.id}/regenerate`, { chunkIds: [run.chunks[3]!.id], override: { performanceRules: { resetWord: 'urgent' } } }))).toMatch(/^Performance rules .*resetWord: "urgent" is also the word for high energy/);
    const jobs: string[] = [];
    for (const ask of asks) {
      const res = await send('POST', `/api/voice/runs/${run.id}/regenerate`, ask);
      expect(res.statusCode).toBe(202);
      jobs.push(res.json<{ job: { id: string } }>().job.id);
      await c.runner.drain();
    }
    const after = (await get<VoiceView>(`/api/projects/${id}/voice?run=2`)).run!;
    expect(after.configuration).toEqual(run.configuration);
    const [byDefault, asRun, asProduction, overridden] = after.chunks.map((ch) => ch.current!);
    for (const [take, i] of [[byDefault!, 0], [asRun!, 1]] as const) {
      expect(take).toMatchObject({ generation: 2, profile: { familyName: 'Tulip narrator', version: 1 }, configuration: { base: 'RUN', override: null, profile: { version: 1 }, differs: [], identityDiffers: false } });
      expect([take.performanceText, take.prepared!.settings]).toEqual([run.chunks[i]!.current!.performanceText, run.chunks[i]!.current!.prepared!.settings]);
    }
    expect(asProduction).toMatchObject({ generation: 2, profile: { familyName: 'Tulip narrator', version: 2 }, configuration: { base: 'PRODUCTION', override: null, profile: { version: 2 }, differs: ['performance: restrained (run: expressive)', 'similarity: 0.6 (run: 0.75)'], identityDiffers: true } });
    expect(asProduction!.prepared!.settings).toMatchObject({ stability: 0.35, similarity: 0.6 });
    expect(after.chunks.map((ch) => ch.text)).toEqual(run.chunks.map((ch) => ch.text));
    expect(overridden).toMatchObject({ generation: 2, profile: { version: 1 }, configuration: { base: 'RUN', override: { providerSettings: { stability: 0.2 } }, differs: ['stability: 0.2 (run: 0.35)'], identityDiffers: true } });
    expect(overridden!.prepared!.settings).toMatchObject({ stability: 0.2, similarity: 0.75 });
    expect(after.qa.filter((f) => f.kind === 'CONFIGURATION_DIFFERS').map((f) => f.severity)).toEqual(['WARNING', 'WARNING']);
    expect((await get<VoiceProfileHistoryView>(`/api/voice/profiles/${tulip.id}`)).current!.config.providerSettings).toEqual({ ...MOCK_DEFAULTS, similarity: 0.6 });
    const sources = jobs.map((job) => {
      const regen = of('voice regeneration summary').find((l) => l.jobId === job)!;
      return [regen.configurations, regen.chunks[0].takes[0].configuration.source, regen.chunks[0].takes[0].configuration.profile];
    });
    expect(sources).toEqual([
      [{ run: 1, production: 0, overridden: 0 }, 'run configuration', 'Tulip narrator v1'],
      [{ run: 1, production: 0, overridden: 0 }, 'run configuration', 'Tulip narrator v1'],
      [{ run: 0, production: 1, overridden: 0 }, 'production profile', 'Tulip narrator v2'],
      [{ run: 1, production: 0, overridden: 1 }, 'temporary override', 'Tulip narrator v1'],
    ]);

    // Costs: the characters sent are the estimate's basis; the provider's own figure is kept raw beside them, never priced.
    const cost = byDefault!.cost!;
    expect(cost).toMatchObject({ characters: byDefault!.characters, reported: [{ name: 'character-cost', quantity: Math.round(byDefault!.characters! * 0.11) }], reestimated: false });
    // The last job's run summary covers every take of the run.
    const summary = of('voice run summary').find((l) => l.jobId === jobs.at(-1))!;
    const takes = after.chunks.flatMap((ch) => ch.generations);
    const reported = takes.reduce((n, g) => n + Math.round(g.characters! * 0.11), 0);
    expect(summary).toMatchObject({ runId: run.id, characters: takes.reduce((n, g) => n + g.characters!, 0), providerReported: [{ name: 'character-cost', total: reported, requests: takes.length }] });
    expect(summary.costText).toBe(`sent ${summary.characters.toLocaleString('en-US')} characters; provider reported ${reported.toLocaleString('en-US')} (character-cost header)`);
    const [regenCost] = of('voice regeneration summary').filter((l) => l.jobId === jobs[0]).map((l) => l.chunks[0].takes[0].cost);
    expect(regenCost).toMatchObject({ characters: byDefault!.characters, reported: [{ name: 'character-cost', quantity: cost.reported[0]!.quantity }] });

    // Duplicate (every field of the current version, none of the project's overrides) and archive the copy; production is untouched.
    const copy = (await send('POST', `/api/voice/profiles/${tulip.id}/duplicate`, { name: 'Tulip narrator (spare)' })).json<VoiceProfileHistoryView>();
    expect(copy.current).toMatchObject({ version: 1, origin: { kind: 'DUPLICATE', fromFamily: 'Tulip narrator', fromVersion: 2 }, config: { strategy: 'RESTRAINED', providerSettings: { ...MOCK_DEFAULTS, similarity: 0.6 } } });
    expect((await send('PATCH', `/api/voice/profiles/${copy.id}`, { archived: true })).statusCode).toBe(200);
    expect((await get<VoiceProfileLibraryView>('/api/voice/profiles')).families.map((f) => f.name)).toEqual(['House narrator', 'Tulip narrator']);
    expect((await get<VoiceProfileLibraryView>('/api/voice/profiles?archived=true')).families.map((f) => [f.name, f.archived])).toEqual([
      ['House narrator', false],
      ['Tulip narrator', false],
      ['Tulip narrator (spare)', true],
    ]);
    expect(await get<VoiceProductionView>(selection)).toMatchObject({ mode: 'FOLLOW', revision: 1, family: { id: tulip.id }, profile: { version: 2 }, problem: null });
  });
});
