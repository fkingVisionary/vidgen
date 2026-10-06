import {
  CreateVoiceProfileFamilyInput,
  DEFAULT_MASTER_LANGUAGE,
  DEFAULT_VOICE_PROFILE_CONFIG,
  DuplicateVoiceProfileInput,
  NewVoiceProfileVersionInput,
  SaveRunAsProfileInput,
  UpdateVoiceProfileFamilyInput,
  VoiceConfigOverrides,
  VoiceProfileConfig,
  VoiceProfileOrigin,
  VoiceSelectionInput,
  performanceRulesProblems,
  readProfileConfig,
  type EffectiveVoiceConfig,
  type VoiceProfileFieldsInput,
  type VoiceProfileView,
} from '@docengine/core';
import type { Database, Prisma, Project, Tx, VoiceProfile, VoiceProfileFamily, VoiceRun } from '@docengine/database';
import { NotFoundError } from '@docengine/pipeline';
import type { VoiceProvider } from '@docengine/providers';
import { checkOverrides, configDifferences, effectiveConfig, isEmptyOverride, runConfig, takeConfig, versionConfig, versionFields, type ConfigProvider, type ProfileRow } from './config.ts';

/**
 * Saved voice profiles: a family (a stable name) with immutable versions.
 * A version fixes everything that shapes a take — provider, voice, model,
 * language, output format, performance strategy, chunking, context, number
 * style, pronunciation rules, performance rules and the provider's own
 * settings. An edit is always a new version, so a run and a take point at
 * the exact configuration that made them; a family's current version is its
 * newest. A project chooses a profile per language version (or narrates
 * with the library default) and may override supported settings without
 * changing it. Version rows are never updated (a version written without
 * a family by code from before saved profiles only has it filled in, once):
 * a family is renamed, described, archived or made the library default,
 * nothing else.
 */

type Db = Database | Tx;

export type { ProfileRow } from './config.ts';

export const HOUSE_PROFILE = 'House narrator';

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** Output formats the engine can measure and join without transcoding: MP3 (rate and bitrate), WAV or PCM (rate). */
export const OUTPUT_FORMAT = /^(mp3_\d+_\d+|wav_\d+|pcm_\d+)$/;

const isClient = (db: Db): db is Database => '$transaction' in db;
/** In a transaction of its own, or in the caller's. */
const inTx = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => (isClient(db) ? db.$transaction(fn) : fn(db));

/** Prisma's unique-constraint error (a name, a version number or a selection saved at the same time). */
export const isUniqueViolation = (err: unknown): boolean => !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';

/** A version's config as stored, in either shape (the provider's settings as they were saved, not normalised). */
const profileConfig = (p: Pick<VoiceProfile, 'config'>): VoiceProfileConfig => readProfileConfig(p.config).config;

const originOf = (v: Pick<VoiceProfile, 'origin'>): VoiceProfileView['origin'] => {
  const o = VoiceProfileOrigin.safeParse(v.origin);
  return o.success ? o.data : { kind: 'LEGACY' };
};

/** A version on its own (as current, with no changes worked out): `profileViews` completes it. */
function toProfileView(p: VoiceProfile, runs: number, voiceName: string | null = null): VoiceProfileView {
  return {
    id: p.id,
    familyId: p.familyId,
    name: p.name,
    version: p.version,
    provider: p.provider,
    voiceId: p.voiceId,
    voiceName,
    modelId: p.modelId,
    language: p.language,
    outputFormat: p.outputFormat,
    config: profileConfig(p),
    current: true,
    origin: originOf(p),
    changes: [],
    notes: p.notes,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    runs,
  };
}

/** Views of versions with `current`, `origin` and what changed from the version before each (one query per call, not per version). */
export async function profileViews(db: Db, provider: ConfigProvider, versions: readonly VoiceProfile[]): Promise<VoiceProfileView[]> {
  const familyIds = [...new Set(versions.map((v) => v.familyId).filter((id): id is string => !!id))];
  const siblings = familyIds.length ? await db.voiceProfile.findMany({ where: { familyId: { in: familyIds } }, orderBy: { version: 'asc' } }) : [];
  const ids = versions.map((v) => v.id);
  const runs = ids.length ? await db.voiceRun.groupBy({ by: ['profileId'], where: { profileId: { in: ids } }, _count: { _all: true } }) : [];
  return versions.map((v) => {
    const family = siblings.filter((s) => s.familyId === v.familyId);
    const previous = v.familyId ? family.filter((s) => s.version < v.version).at(-1) : undefined;
    return {
      ...toProfileView(v, runs.find((r) => r.profileId === v.id)?._count._all ?? 0),
      config: versionConfig(v, provider).config,
      current: !v.familyId || family.at(-1)?.id === v.id,
      changes: previous ? configDifferences(versionFields(previous, provider), versionFields(v, provider), 'ARROW') : [],
    };
  });
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** A family's current version: its newest. */
export async function familyCurrent(db: Db, familyId: string): Promise<ProfileRow | null> {
  return db.voiceProfile.findFirst({ where: { familyId }, orderBy: { version: 'desc' }, include: { family: true } });
}

/** The current version of the unarchived default family for a provider and language (the most recently updated when several are). */
async function findDefault(db: Db, provider: string, language: string): Promise<ProfileRow | null> {
  const families = await db.voiceProfileFamily.findMany({ where: { isDefault: true, archivedAt: null }, orderBy: { updatedAt: 'desc' } });
  for (const f of families) {
    const current = await familyCurrent(db, f.id);
    if (current && current.provider === provider && current.language === language) return current;
  }
  return null;
}

/** Why a name cannot be a profile's: another family has it, or another family's versions carry it (ignoring case). */
async function nameProblem(db: Db, name: string, family?: string): Promise<string | null> {
  const insensitive = { equals: name, mode: 'insensitive' as const };
  const other = await db.voiceProfileFamily.findFirst({ where: { name: insensitive, ...(family ? { id: { not: family } } : {}) }, select: { name: true } });
  if (other) return `A voice profile is already named "${other.name}"`;
  const carried = await db.voiceProfile.findFirst({ where: { name: insensitive, ...(family ? { OR: [{ familyId: null }, { familyId: { not: family } }] } : {}) }, select: { name: true, version: true } });
  if (carried) return `"${carried.name}" is the name of another profile's versions (v${carried.version})`;
  return null;
}

async function checkName(db: Db, name: string, family?: string): Promise<void> {
  const problem = await nameProblem(db, name, family);
  if (problem) throw new ProfileError(`${problem}: choose another name`);
}

/** A family name for a provider and language that no family or other family's version has: the name, else "name (provider, language)", then numbered. */
async function freeName(db: Db, name: string, provider: string, language: string, carriedBy: readonly string[] = []): Promise<string> {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : n === 1 ? `${name} (${provider}, ${language})` : `${name} (${provider}, ${language}) ${n}`;
    const family = await db.voiceProfileFamily.findFirst({ where: { name: { equals: candidate, mode: 'insensitive' } }, select: { id: true } });
    const carried = await db.voiceProfile.findFirst({ where: { name: { equals: candidate, mode: 'insensitive' }, ...(carriedBy.length ? { id: { notIn: [...carriedBy] } } : {}) }, select: { id: true } });
    if (!family && !carried) return candidate;
  }
}

/** Versions without a family were adopted by another request at the same time: theirs stands. */
class AdoptedElsewhere extends Error {}

/**
 * Versions with no family for a provider and language (written by code from
 * before saved profiles, e.g. during a rollback) get one, by the migration's
 * rule: one family per name, and the family of the newest active one is the
 * default when none exists (an existing default stays). Only their empty
 * family is filled in; a request adopting them at the same time leaves no
 * empty family behind.
 */
async function adopt(db: Db, provider: string, language: string, actor: string): Promise<void> {
  const rows = await db.voiceProfile.findMany({ where: { familyId: null, provider, language }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!rows.length) return;
  const newestActive = rows.filter((r) => r.active).at(-1);
  const hasDefault = !!(await findDefault(db, provider, language));
  try {
    await inTx(db, async (tx) => {
      for (const name of [...new Set(rows.map((r) => r.name))]) {
        const versions = rows.filter((r) => r.name === name);
        const family = await tx.voiceProfileFamily.create({
          data: { name: await freeName(tx, name, provider, language, versions.map((v) => v.id)), isDefault: !hasDefault && newestActive?.name === name, createdBy: versions[0]!.createdBy ?? actor, createdAt: versions[0]!.createdAt },
        });
        const moved = await tx.voiceProfile.updateMany({ where: { id: { in: versions.map((v) => v.id) }, familyId: null }, data: { familyId: family.id } });
        if (moved.count !== versions.length) throw new AdoptedElsewhere();
      }
    });
  } catch (err) {
    // In a transaction of its own only: the caller's would be aborted by the failed write.
    if (!isClient(db) || !(err instanceof AdoptedElsewhere || isUniqueViolation(err))) throw err;
  }
}

/** The house profile for a provider and language, made from the configured defaults: the library default. */
async function createHouse(db: Db, provider: VoiceProvider, language: string, actor: string): Promise<ProfileRow> {
  const voiceId = provider.defaults.voiceId;
  if (!voiceId) throw new ProfileError(`No voice chosen for ${provider.info.name}: configure its default voice, or create a voice profile with a voice id`);
  return inTx(db, async (tx) => {
    const name = await freeName(tx, HOUSE_PROFILE, provider.info.name, language);
    const family = await tx.voiceProfileFamily.create({ data: { name, isDefault: true, createdBy: actor } });
    const config: VoiceProfileConfig = { ...structuredClone(DEFAULT_VOICE_PROFILE_CONFIG), providerSettings: provider.normalizeSettings({}).settings };
    return tx.voiceProfile.create({
      data: {
        familyId: family.id,
        name,
        version: 1,
        provider: provider.info.name,
        voiceId,
        modelId: provider.defaults.model,
        language,
        outputFormat: provider.defaults.outputFormat,
        config: config as unknown as Prisma.InputJsonValue,
        active: false,
        origin: { kind: 'DEFAULTS' },
        notes: `Created from the configured defaults (${provider.info.name})`,
        createdBy: actor,
      },
      include: { family: true },
    });
  });
}

/**
 * The library default's current version for a provider and language. With
 * `create` (at plan, run or regeneration time) versions without a family
 * are adopted first, and the house profile is made from the configured
 * defaults when there is still none; a read never writes.
 */
export async function libraryDefault(db: Db, provider: VoiceProvider, language: string, opts: { create: boolean; actor: string }): Promise<ProfileRow | null> {
  if (!opts.create) return findDefault(db, provider.info.name, language);
  try {
    await adopt(db, provider.info.name, language, opts.actor);
    return (await findDefault(db, provider.info.name, language)) ?? (await createHouse(db, provider, language, opts.actor));
  } catch (err) {
    // Made at the same time by another request: use that one.
    if (!isUniqueViolation(err)) throw err;
    const again = await findDefault(db, provider.info.name, language);
    if (again) return again;
    throw err;
  }
}

/** What a language version narrates with now: what a new run would use. */
export interface Production {
  languageVersionId: string;
  language: string;
  mode: 'FOLLOW' | 'PIN' | 'DEFAULT';
  /** Incremented by every change of the choice or overrides (0: none made yet). */
  revision: number;
  family: VoiceProfileFamily | null;
  /** Null only with a problem, or no library default yet and nothing to be made. */
  version: ProfileRow | null;
  /** Pinned while the family has a newer current version. */
  newer: ProfileRow | null;
  overrides: VoiceConfigOverrides;
  problem: string | null;
  notices: string[];
  updatedBy: string | null;
  updatedAt: Date | null;
}

const sameProvider = (v: Pick<VoiceProfile, 'name' | 'version' | 'provider' | 'language' | 'voiceId'>, provider: string, language: string): string | null => {
  if (v.provider !== provider) return `Profile ${v.name} v${v.version} is for ${v.provider}; the configured voice provider is ${provider}`;
  if (v.language !== language) return `Profile ${v.name} v${v.version} is for ${v.language}; this narration is ${language}`;
  if (!v.voiceId) return `Profile ${v.name} v${v.version} has no voice id`;
  return null;
};

/**
 * A language version's production profile: its project's choice (following
 * a family's current version, or pinned to one) or the library default,
 * and the project's overrides. `create` (plan, run and regeneration time)
 * may adopt or make the library default; a read never writes.
 */
export async function resolveProduction(db: Db, provider: VoiceProvider, lv: { id: string; language: string; projectId: string }, opts: { create?: boolean; actor?: string } = {}): Promise<Production> {
  const sel = await db.voiceSelection.findUnique({ where: { languageVersionId: lv.id }, include: { family: true, pinnedVersion: { include: { family: true } } } });
  const notices: string[] = [];
  let mode: Production['mode'];
  let family: VoiceProfileFamily | null;
  let version: ProfileRow | null;
  let newer: ProfileRow | null = null;
  if (sel?.familyId && sel.family) {
    // Versions written without a family join the library here too (the library default adopts them otherwise).
    if (opts.create) await adopt(db, provider.info.name, lv.language, opts.actor ?? 'system');
    family = sel.family;
    if (sel.pinnedVersion) {
      mode = 'PIN';
      version = sel.pinnedVersion;
      const current = await familyCurrent(db, family.id);
      if (current && current.id !== version.id) {
        newer = current;
        notices.push(`Pinned to v${version.version}: v${current.version} of ${family.name} is its current version`);
      }
    } else {
      mode = 'FOLLOW';
      version = await familyCurrent(db, family.id);
    }
    if (family.archivedAt) notices.push(`${family.name} is archived: this project keeps it, but it is offered for no new choice`);
  } else {
    mode = 'DEFAULT';
    version = await libraryDefault(db, provider, lv.language, { create: !!opts.create, actor: opts.actor ?? 'system' });
    family = version?.family ?? null;
    if (!version) notices.push(`No library default for ${provider.info.name} (${lv.language}) yet: the house profile is made at the first plan`);
  }
  const problem = version ? sameProvider(version, provider.info.name, lv.language) : family ? `Profile ${family.name} has no version` : null;
  return {
    languageVersionId: lv.id,
    language: lv.language,
    mode,
    revision: sel?.revision ?? 0,
    family,
    version,
    newer,
    overrides: VoiceConfigOverrides.catch({}).parse(sel?.overrides ?? {}),
    problem,
    notices,
    updatedBy: sel?.updatedBy ?? null,
    updatedAt: sel?.updatedAt ?? null,
  };
}

// ── The library ──────────────────────────────────────────────────────────────

/** A version's fields with `fields` laid over them (performance rules and provider settings key by key). */
function layFields(base: EffectiveVoiceConfig, f: VoiceProfileFieldsInput | undefined): EffectiveVoiceConfig {
  if (!f) return structuredClone(base);
  return {
    ...structuredClone(base),
    ...(f.voiceId !== undefined ? { voiceId: f.voiceId } : {}),
    ...(f.modelId !== undefined ? { model: f.modelId } : {}),
    ...(f.language !== undefined ? { language: f.language } : {}),
    ...(f.outputFormat !== undefined ? { outputFormat: f.outputFormat } : {}),
    ...(f.strategy !== undefined ? { strategy: f.strategy } : {}),
    ...(f.chunking !== undefined ? { chunking: f.chunking } : {}),
    ...(f.context !== undefined ? { context: f.context } : {}),
    ...(f.numberStyle !== undefined ? { numberStyle: f.numberStyle } : {}),
    ...(f.pronunciation !== undefined ? { pronunciation: f.pronunciation } : {}),
    performanceRules: { ...base.performanceRules, ...f.performanceRules },
    providerSettings: { ...base.providerSettings, ...f.providerSettings },
  };
}

/** A version to be written, checked: the configured provider, a measurable output format, a voice, settings the provider takes, a configuration that parses whole. */
function checked(provider: ConfigProvider, f: EffectiveVoiceConfig): EffectiveVoiceConfig {
  if (f.provider !== provider.info.name) throw new ProfileError(`Profiles are made for the configured voice provider (${provider.info.name}); this configuration is for ${f.provider}`);
  if (!OUTPUT_FORMAT.test(f.outputFormat)) throw new ProfileError(`Output format "${f.outputFormat}" cannot be measured or joined here: use an mp3_*, wav_* or pcm_* format (e.g. mp3_44100_128)`);
  if (!f.voiceId.trim()) throw new ProfileError('A voice id is needed');
  const settings = provider.normalizeSettings(f.providerSettings);
  if (settings.problems.length) throw new ProfileError(`Provider settings: ${settings.problems.join('; ')}`);
  const config = VoiceProfileConfig.safeParse({ ...configOf(f), providerSettings: settings.settings });
  if (!config.success) throw new ProfileError(`The configuration does not fit: ${config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const rules = performanceRulesProblems(config.data.performanceRules);
  if (rules.length) throw new ProfileError(`Performance rules: ${rules.join('; ')}`);
  return { ...f, ...config.data };
}

const configOf = (f: EffectiveVoiceConfig): VoiceProfileConfig => ({
  strategy: f.strategy,
  chunking: f.chunking,
  context: f.context,
  numberStyle: f.numberStyle,
  pronunciation: f.pronunciation,
  performanceRules: f.performanceRules,
  providerSettings: f.providerSettings,
});

/** A new version of a family, named as the family is now: its number is past every version of the family and every version of that name (a name the migration shared between providers or languages). */
async function createVersion(tx: Tx, family: VoiceProfileFamily, f: EffectiveVoiceConfig, extra: { origin: VoiceProfileOrigin; basedOnId: string | null; notes: string | null; actor: string }): Promise<ProfileRow> {
  const last = await tx.voiceProfile.aggregate({ where: { OR: [{ familyId: family.id }, { name: family.name }] }, _max: { version: true } });
  return tx.voiceProfile.create({
    data: {
      familyId: family.id,
      name: family.name,
      version: (last._max.version ?? 0) + 1,
      provider: f.provider,
      voiceId: f.voiceId,
      modelId: f.model,
      language: f.language,
      outputFormat: f.outputFormat,
      config: configOf(f) as unknown as Prisma.InputJsonValue,
      // Read only by code from before saved profiles (its library default): a new version never becomes that.
      active: false,
      origin: extra.origin as unknown as Prisma.InputJsonValue,
      basedOnId: extra.basedOnId,
      notes: extra.notes,
      createdBy: extra.actor,
    },
    include: { family: true },
  });
}

async function familyOrThrow(db: Db, familyId: string): Promise<VoiceProfileFamily> {
  const family = await db.voiceProfileFamily.findUnique({ where: { id: familyId } });
  if (!family) throw new NotFoundError('Voice profile', familyId);
  return family;
}

async function versionOf(db: Db, family: VoiceProfileFamily, versionId: string | undefined): Promise<ProfileRow> {
  const v = versionId ? await db.voiceProfile.findFirst({ where: { id: versionId, familyId: family.id }, include: { family: true } }) : await familyCurrent(db, family.id);
  if (!v) throw versionId ? new NotFoundError(`Version of voice profile ${family.name}`, versionId) : new ProfileError(`Profile ${family.name} has no version`);
  return v;
}

/** A new saved profile (v1): the configured provider's defaults and the house default, with `fields` over them. */
export async function createProfileFamily(db: Database, provider: VoiceProvider, raw: CreateVoiceProfileFamilyInput, actor: string): Promise<ProfileRow> {
  const input = CreateVoiceProfileFamilyInput.parse(raw);
  await checkName(db, input.name);
  const base: EffectiveVoiceConfig = {
    ...structuredClone(DEFAULT_VOICE_PROFILE_CONFIG),
    providerSettings: provider.normalizeSettings({}).settings,
    provider: provider.info.name,
    voiceId: provider.defaults.voiceId ?? '',
    model: provider.defaults.model,
    language: DEFAULT_MASTER_LANGUAGE,
    outputFormat: provider.defaults.outputFormat,
  };
  const f = checked(provider, layFields(base, input.fields));
  return db.$transaction(async (tx) => {
    const family = await tx.voiceProfileFamily.create({ data: { name: input.name, description: input.description ?? null, createdBy: actor } });
    return createVersion(tx, family, f, { origin: { kind: 'LIBRARY' }, basedOnId: null, notes: input.notes ?? null, actor });
  });
}

/**
 * An edit: a new version, based on the current one (or an older one, to go
 * back to it) with `fields` laid over it. Refused for an archived family,
 * when the current version is no longer the one the editor saw, and when
 * the result is the current version's configuration (nothing changed).
 */
export async function newProfileVersion(db: Database, provider: VoiceProvider, familyId: string, raw: NewVoiceProfileVersionInput, actor: string): Promise<ProfileRow> {
  const input = NewVoiceProfileVersionInput.parse(raw);
  const family = await familyOrThrow(db, familyId);
  if (family.archivedAt) throw new ProfileError(`Profile ${family.name} is archived: unarchive it to edit it`);
  const current = await versionOf(db, family, undefined);
  if (input.expectedCurrent && input.expectedCurrent !== current.id) throw new ProfileError(`Profile ${family.name} changed since you opened it (now v${current.version}): review it and save again`);
  const base = input.basedOn ? await versionOf(db, family, input.basedOn) : current;
  const f = checked(provider, layFields(versionFields(base, provider), input.fields));
  if (!configDifferences(versionFields(current, provider), f).length) throw new ProfileError(`Nothing changed: v${current.version} of ${family.name} already has this configuration`);
  return db.$transaction((tx) => createVersion(tx, family, f, { origin: { kind: 'EDIT', basedOnVersion: base.version }, basedOnId: base.id, notes: input.notes ?? null, actor }));
}

/** A new saved profile (v1) from any version of another, with `fields` over it (another language allowed). */
export async function duplicateProfile(db: Database, provider: VoiceProvider, familyId: string, raw: DuplicateVoiceProfileInput, actor: string): Promise<ProfileRow> {
  const input = DuplicateVoiceProfileInput.parse(raw);
  const family = await familyOrThrow(db, familyId);
  const from = await versionOf(db, family, input.fromVersionId);
  await checkName(db, input.name);
  const f = checked(provider, layFields(versionFields(from, provider), input.fields));
  return db.$transaction(async (tx) => {
    const copy = await tx.voiceProfileFamily.create({ data: { name: input.name, description: input.description ?? null, createdBy: actor } });
    return createVersion(tx, copy, f, { origin: { kind: 'DUPLICATE', fromFamily: family.name, fromVersion: from.version }, basedOnId: from.id, notes: null, actor });
  });
}

/** Rename, describe, archive or unarchive a family, or make it the library default for its provider and language (its versions are not touched). */
export async function updateProfileFamily(db: Database, familyId: string, raw: UpdateVoiceProfileFamilyInput): Promise<VoiceProfileFamily> {
  const input = UpdateVoiceProfileFamilyInput.parse(raw);
  return db.$transaction(async (tx) => {
    const family = await familyOrThrow(tx, familyId);
    const data: Prisma.VoiceProfileFamilyUpdateInput = {};
    if (input.name !== undefined && input.name !== family.name) {
      await checkName(tx, input.name, family.id);
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.archived === true && !family.archivedAt) {
      if (family.isDefault) throw new ProfileError(`${family.name} is the library default: make another profile the library default first`);
      data.archivedAt = new Date();
    }
    if (input.archived === false) data.archivedAt = null;
    if (input.isDefault) {
      if (input.archived ?? !!family.archivedAt) throw new ProfileError(`${family.name} is archived: unarchive it before making it the library default`);
      const current = await versionOf(tx, family, undefined);
      for (const other of await tx.voiceProfileFamily.findMany({ where: { isDefault: true, id: { not: family.id } } })) {
        const theirs = await familyCurrent(tx, other.id);
        if (theirs && theirs.provider === current.provider && theirs.language === current.language) await tx.voiceProfileFamily.update({ where: { id: other.id }, data: { isDefault: false } });
      }
      data.isDefault = true;
    }
    return Object.keys(data).length ? tx.voiceProfileFamily.update({ where: { id: family.id }, data }) : family;
  });
}

/** What saving a run's configuration made, and whether the run's language version now uses it. */
export interface SavedRun {
  version: ProfileRow;
  run: VoiceRun & { project: Project };
  /** The run's language version now follows the profile. */
  selected: boolean;
  /** The project's overrides that "use" cleared (they are in the saved configuration where they applied to the run); null when there were none or it was not used. */
  clearedOverrides: VoiceConfigOverrides | null;
  /** The selection's revision after "use". */
  revision: number | null;
}

/**
 * A run's configuration (or one of its takes') saved as a profile: a new
 * one by name, or a new version of one. It never becomes the library
 * default; `use` makes the run's own language version follow it, with the
 * project's overrides cleared.
 */
export async function saveRunAsProfile(db: Database, provider: VoiceProvider, runId: string, raw: SaveRunAsProfileInput, actor: string): Promise<SavedRun> {
  const input = SaveRunAsProfileInput.parse(raw);
  const run = await db.voiceRun.findUnique({ where: { id: runId }, include: { profile: { include: { family: true } }, project: true } });
  if (!run) throw new NotFoundError('Voice run', runId);
  const config = runConfig(run, provider);
  let effective = config.effective;
  let reconstructed = config.reconstructed;
  let made = '';
  if (input.generationId) {
    const take = await db.voiceGeneration.findFirst({ where: { id: input.generationId, runId }, include: { profile: { include: { family: true } }, chunk: { select: { chunkIndex: true } } } });
    if (!take) throw new NotFoundError(`Take of voice run ${run.number}`, input.generationId);
    const tc = takeConfig(take, config);
    ({ effective, reconstructed } = tc);
    made = `take ${take.generation} (chunk ${take.chunk.chunkIndex + 1}) of `;
  }
  const f = checked(provider, effective);
  const origin: VoiceProfileOrigin = { kind: 'RUN', runId: run.id, run: run.number, projectId: run.projectId, project: run.project.slug, experiment: run.experiment, variant: run.variant, takeId: input.generationId ?? null, reconstructed };
  const notes = input.notes ?? `Saved from ${made}voice run ${run.number} of ${run.project.slug}${run.experiment ? ` (${run.experiment}${run.variant ? ` — ${run.variant}` : ''})` : ''}`;
  if (input.name) await checkName(db, input.name);
  return db.$transaction(async (tx) => {
    let family: VoiceProfileFamily;
    if (input.name) family = await tx.voiceProfileFamily.create({ data: { name: input.name, description: input.description ?? null, createdBy: actor } });
    else {
      family = await familyOrThrow(tx, input.familyId!);
      if (family.archivedAt) throw new ProfileError(`Profile ${family.name} is archived: unarchive it to add a version`);
      const current = await familyCurrent(tx, family.id);
      if (current && (current.provider !== f.provider || current.language !== f.language)) throw new ProfileError(`Profile ${family.name} is for ${current.provider} (${current.language}); voice run ${run.number} is ${f.provider} (${f.language}): save it as a new profile`);
    }
    const version = await createVersion(tx, family, f, { origin, basedOnId: null, notes, actor });
    if (!input.use) return { version, run, selected: false, clearedOverrides: null, revision: null };
    const sel = await tx.voiceSelection.findUnique({ where: { languageVersionId: run.languageVersionId } });
    const before = VoiceConfigOverrides.catch({}).parse(sel?.overrides ?? {});
    const after = sel
      ? await tx.voiceSelection.update({ where: { id: sel.id }, data: { familyId: family.id, pinnedVersionId: null, overrides: {}, revision: { increment: 1 }, updatedBy: actor } })
      : await tx.voiceSelection.create({ data: { projectId: run.projectId, languageVersionId: run.languageVersionId, familyId: family.id, overrides: {}, updatedBy: actor } });
    return { version, run, selected: true, clearedOverrides: isEmptyOverride(before) ? null : before, revision: after.revision };
  });
}

/** A project's choice saved: its family (or the library default), followed or pinned, and its overrides. */
export interface SavedSelection {
  languageVersionId: string;
  language: string;
  revision: number;
  family: VoiceProfileFamily | null;
  /** Null: the library default, looked up when it is used. */
  version: ProfileRow | null;
  pinned: boolean;
  overrides: VoiceConfigOverrides;
}

/**
 * A project's choice of profile for one language version (the master
 * language by default), and its overrides. Refused when it changed since
 * the editor saw it (the revision, checked atomically), for an archived
 * family it does not already use, a version of another family, provider
 * or language, and overrides the provider does not take.
 */
export async function setSelection(db: Database, provider: VoiceProvider, project: Project, raw: VoiceSelectionInput, actor: string): Promise<SavedSelection> {
  const input = VoiceSelectionInput.parse(raw);
  const language = input.language ?? project.masterLanguage;
  const lv = await db.languageVersion.findUnique({ where: { projectId_language: { projectId: project.id, language } } });
  if (!lv) throw new NotFoundError('Language version', `${project.slug} (${language})`);
  const existing = await db.voiceSelection.findUnique({ where: { languageVersionId: lv.id } });
  const changed = (now: number) => new ProfileError(`The voice profile for ${language} changed in another tab (revision ${input.revision}, now ${now}): reload and choose again`);
  if ((existing?.revision ?? 0) !== input.revision) throw changed(existing?.revision ?? 0);
  let family: VoiceProfileFamily | null = null;
  let version: ProfileRow | null = null;
  if (input.familyId) {
    family = await familyOrThrow(db, input.familyId);
    if (family.archivedAt && existing?.familyId !== family.id) throw new ProfileError(`Profile ${family.name} is archived: unarchive it to choose it`);
    version = input.versionId ? await db.voiceProfile.findFirst({ where: { id: input.versionId, familyId: family.id }, include: { family: true } }) : await familyCurrent(db, family.id);
    if (!version) throw new ProfileError(input.versionId ? `Version ${input.versionId} is not a version of ${family.name}` : `Profile ${family.name} has no version`);
    const problem = sameProvider(version, provider.info.name, language);
    if (problem) throw new ProfileError(problem);
  }
  const problems = checkOverrides(input.overrides, provider, 'PROJECT');
  if (problems.length) throw new ProfileError(`Project overrides: ${problems.join('; ')}`);
  if (version && input.overrides.performanceRules) {
    const rules = performanceRulesProblems(effectiveConfig(version, [{ source: 'PROJECT', overrides: input.overrides }], provider).effective.performanceRules);
    if (rules.length) throw new ProfileError(`Project overrides: ${rules.join('; ')}`);
  }
  const data = { familyId: input.familyId, pinnedVersionId: input.versionId ?? null, overrides: input.overrides as Prisma.InputJsonValue, updatedBy: actor };
  let revision: number;
  if (existing) {
    const r = await db.voiceSelection.updateMany({ where: { id: existing.id, revision: input.revision }, data: { ...data, revision: { increment: 1 } } });
    if (!r.count) throw changed((await db.voiceSelection.findUnique({ where: { id: existing.id } }))?.revision ?? input.revision);
    revision = input.revision + 1;
  } else revision = (await db.voiceSelection.create({ data: { projectId: project.id, languageVersionId: lv.id, ...data } })).revision;
  return { languageVersionId: lv.id, language, revision, family, version, pinned: !!input.versionId, overrides: input.overrides };
}
