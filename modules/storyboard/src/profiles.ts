import {
  CreateVisualProfileFamilyInput,
  DEFAULT_VISUAL_PRESET,
  DEFAULT_VISUAL_PROFILE_CONFIG,
  DuplicateVisualProfileInput,
  NewVisualProfileVersionInput,
  UpdateVisualProfileFamilyInput,
  VISUAL_PROFILE_PRESETS,
  VisualConfigOverrides,
  VisualProfileOrigin,
  VisualSelectionInput,
  VisualStyleProfileConfig,
  type ProductionMethod,
  type VisualCatalog,
  type VisualConfigProvenance,
  type VisualProfileSnapshot,
  type VisualSelectionMode,
} from '@docengine/core';
import type { Database, Prisma, Project, Tx, VisualProfile, VisualProfileFamily } from '@docengine/database';
import { EVENT, NotFoundError } from '@docengine/pipeline';

/**
 * Visual Style Profiles (§21): a family (a stable name) with immutable
 * versions, mirroring saved voice profiles. A version fixes the look a
 * storyboard is planned with — realism, camera language, lenses, colour,
 * light, grain, frame, motion, density, archival and graphics preferences,
 * generation limits, the approach, provider preferences and a cost ceiling —
 * and is never edited: an edit is a new version, so every storyboard keeps
 * the exact version it used. A project chooses a family (following its
 * current version, or pinned to one) or the library default, and may
 * override settings without changing the profile. The five presets are made
 * on the library's first use, once, whatever runs at the same time; the
 * first is the library default until the user chooses another. Provider and
 * model preferences are free strings checked against the visual catalog
 * (an unknown one is a notice, never an error).
 */

type Db = Database | Tx;

export type VisualProfileRow = VisualProfile & { family: VisualProfileFamily };

/** A refusal the editor can act on (409): a name taken, an archived profile, a stale revision or version, nothing changed. */
export class VisualProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualProfileError';
  }
}

const isClient = (db: Db): db is Database => '$transaction' in db;
/** In a transaction of its own, or in the caller's. */
const inTx = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => (isClient(db) ? db.$transaction(fn) : fn(db));

/** Prisma's unique-constraint error (a name or a selection saved at the same time). */
export const isUniqueViolation = (err: unknown): boolean => !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';

/** A version's settings as stored, read strictly: a configuration that does not parse is an error naming the version, never a default. */
export function profileConfig(p: Pick<VisualProfile, 'config' | 'name' | 'version'>): VisualStyleProfileConfig {
  const parsed = VisualStyleProfileConfig.safeParse(p.config);
  if (!parsed.success) throw new Error(`Visual profile ${p.name} v${p.version}: its settings cannot be read (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')})`);
  return parsed.data;
}

export const originOf = (p: Pick<VisualProfile, 'origin'>): VisualProfileOrigin => VisualProfileOrigin.parse(p.origin);

// ── Settings: overrides, provenance, differences ─────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Settings with overrides laid over them, nested objects key by key (a list
 * is replaced whole), and where each overridden setting came from, by path
 * ("density", "generation.rerolls.GENERATIVE_VIDEO"). The result is checked
 * whole.
 */
export function applyOverrides(base: VisualStyleProfileConfig, overrides: VisualConfigOverrides, source: 'PROJECT' | 'PROFILE' = 'PROJECT'): { effective: VisualStyleProfileConfig; provenance: VisualConfigProvenance } {
  const provenance: VisualConfigProvenance = {};
  const lay = (target: Record<string, unknown>, over: Record<string, unknown>, path: string[]) => {
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) continue;
      const at = [...path, key];
      if (isRecord(value) && isRecord(target[key])) lay(target[key] as Record<string, unknown>, value, at);
      else {
        target[key] = structuredClone(value);
        provenance[at.join('.')] = source;
      }
    }
  };
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  lay(merged, VisualConfigOverrides.parse(overrides) as Record<string, unknown>, []);
  const effective = VisualStyleProfileConfig.safeParse(merged);
  if (!effective.success) throw new VisualProfileError(`The settings do not fit together: ${effective.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { effective: effective.data, provenance };
}

/** Every setting as a path and a value (a list is one value). */
function leaves(value: unknown, path: string[] = [], out = new Map<string, unknown>()): Map<string, unknown> {
  if (isRecord(value)) for (const [k, v] of Object.entries(value)) leaves(v, [...path, k], out);
  else out.set(path.join('.'), value);
  return out;
}

const shown = (v: unknown) => (v === null || v === undefined ? 'none' : Array.isArray(v) ? (v.length ? v.map((x) => (isRecord(x) ? Object.values(x).join(' ') : String(x))).join(', ') : 'none') : String(v));

/** What differs between two configurations, one line per setting ("density: BALANCED → SPARSE"). */
export function configDifferences(a: VisualStyleProfileConfig, b: VisualStyleProfileConfig): string[] {
  const x = leaves(a);
  const y = leaves(b);
  const paths = [...new Set([...x.keys(), ...y.keys()])];
  return paths.filter((p) => JSON.stringify(x.get(p)) !== JSON.stringify(y.get(p))).map((p) => `${p}: ${shown(x.get(p))} → ${shown(y.get(p))}`);
}

/** Provider and model preferences the catalog does not know, or that cannot make their method (notices, never errors). */
export function unknownPreferences(config: Pick<VisualStyleProfileConfig, 'providerPreferences'>, catalog: VisualCatalog): string[] {
  const out: string[] = [];
  for (const [method, prefs] of Object.entries(config.providerPreferences) as [ProductionMethod, { provider: string; model?: string }[]][]) {
    for (const p of prefs ?? []) {
      const card = catalog.cards.find((c) => c.provider === p.provider);
      if (!card) out.push(`${method}: ${p.provider} is not in the visual catalog`);
      else if (p.model) {
        const model = card.models.find((m) => m.model === p.model);
        if (!model) out.push(`${method}: ${p.provider} ${p.model} is not a model the visual catalog knows (it is priced only by a rate for the whole provider)`);
        else if (!model.methods.includes(method)) out.push(`${method}: ${p.provider} ${p.model} does not make ${method.toLowerCase().replace(/_/g, ' ')}`);
      } else if (!card.models.some((m) => m.methods.includes(method))) out.push(`${method}: no model of ${p.provider} makes ${method.toLowerCase().replace(/_/g, ' ')}`);
    }
  }
  return out;
}

// ── The presets ──────────────────────────────────────────────────────────────

/** Serialises the presets' first use (any constant; it names nothing else). */
const PRESET_LOCK = 7_316_221_501;

/** A family name nobody has (ignoring case): the name, else "name (preset)", then numbered. */
async function freeName(tx: Tx, name: string): Promise<string> {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : n === 1 ? `${name} (preset)` : `${name} (preset ${n})`;
    const taken = await tx.visualProfileFamily.findFirst({ where: { name: { equals: candidate, mode: 'insensitive' } }, select: { id: true } });
    if (!taken) return candidate;
  }
}

/**
 * The five presets of §21 in the library, made once at its first use (a
 * preset is known by its version's origin, so a renamed or archived one is
 * not made again); the first is the library default when there is none.
 * Concurrent first uses wait for each other and make them once.
 */
export async function ensurePresets(db: Db, actor = 'system'): Promise<void> {
  const known = async (q: Db) => {
    const rows = await q.visualProfile.findMany({ where: { origin: { path: ['kind'], equals: 'PRESET' } }, select: { origin: true } });
    return new Set(rows.flatMap((r) => (isRecord(r.origin) && typeof r.origin.preset === 'string' ? [r.origin.preset] : [])));
  };
  const made = await known(db);
  if (VISUAL_PROFILE_PRESETS.every((p) => made.has(p.key))) return;
  await inTx(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRESET_LOCK}::bigint)`;
    const have = await known(tx);
    const hasDefault = !!(await tx.visualProfileFamily.findFirst({ where: { isDefault: true }, select: { id: true } }));
    for (const p of VISUAL_PROFILE_PRESETS) {
      if (have.has(p.key)) continue;
      const name = await freeName(tx, p.name);
      const family = await tx.visualProfileFamily.create({ data: { name, description: p.description, isDefault: !hasDefault && p.key === DEFAULT_VISUAL_PRESET, createdBy: actor } });
      await tx.visualProfile.create({
        data: {
          familyId: family.id,
          version: 1,
          name,
          config: p.config as unknown as Prisma.InputJsonValue,
          origin: { kind: 'PRESET', preset: p.key },
          notes: 'Seeded preset: provider-neutral settings, no provider or model preference',
          createdBy: actor,
        },
      });
    }
  });
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** A family's current version: its newest. */
export async function familyCurrent(db: Db, familyId: string): Promise<VisualProfileRow | null> {
  return db.visualProfile.findFirst({ where: { familyId }, orderBy: { version: 'desc' }, include: { family: true } });
}

/** The current version of the unarchived library default (the most recently updated when several are). */
async function libraryDefault(db: Db): Promise<VisualProfileRow | null> {
  const families = await db.visualProfileFamily.findMany({ where: { isDefault: true, archivedAt: null }, orderBy: { updatedAt: 'desc' } });
  for (const f of families) {
    const current = await familyCurrent(db, f.id);
    if (current) return current;
  }
  return null;
}

/** What a project's storyboards are planned with now. */
export interface VisualProduction {
  projectId: string;
  mode: VisualSelectionMode;
  /** Incremented by every change of the choice or overrides (0: none made yet). */
  revision: number;
  family: VisualProfileFamily | null;
  /** Null only before the presets exist (a read never makes them). */
  version: VisualProfileRow | null;
  /** Pinned while the family has a newer current version. */
  newer: VisualProfileRow | null;
  overrides: VisualConfigOverrides;
  effective: VisualStyleProfileConfig | null;
  provenance: VisualConfigProvenance;
  notices: string[];
  updatedBy: string | null;
  updatedAt: Date | null;
}

/**
 * A project's visual production profile: its choice (following a family's
 * current version, or pinned to one) or the library default, with its
 * overrides. `create` (plan time, the library's first use) makes the
 * presets when they do not exist yet; a read never writes.
 */
export async function resolveVisualProduction(db: Db, projectId: string, opts: { create?: boolean; actor?: string } = {}): Promise<VisualProduction> {
  const sel = await db.visualSelection.findUnique({ where: { projectId }, include: { family: true, pinnedVersion: { include: { family: true } } } });
  const notices: string[] = [];
  let mode: VisualSelectionMode;
  let family: VisualProfileFamily | null;
  let version: VisualProfileRow | null;
  let newer: VisualProfileRow | null = null;
  if (sel?.familyId && sel.family) {
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
    if (opts.create) await ensurePresets(db, opts.actor ?? 'system');
    version = await libraryDefault(db);
    family = version?.family ?? null;
    notices.push(version ? `No profile chosen for this project: the library default (${version.family.name}) is used` : `No profile chosen and the library is not set up yet: its presets are made at its first use, ${VISUAL_PROFILE_PRESETS[0]!.name} as the library default`);
  }
  const parsed = VisualConfigOverrides.safeParse(sel?.overrides ?? {});
  if (!parsed.success) throw new Error(`The project's visual profile overrides cannot be read (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')})`);
  const overrides = parsed.data;
  const resolved = version ? applyOverrides(profileConfig(version), overrides) : null;
  return {
    projectId,
    mode,
    revision: sel?.revision ?? 0,
    family,
    version,
    newer,
    overrides,
    effective: resolved?.effective ?? null,
    provenance: resolved?.provenance ?? {},
    notices,
    updatedBy: sel?.updatedBy ?? null,
    updatedAt: sel?.updatedAt ?? null,
  };
}

/** The profile a storyboard version is planned with, frozen. */
export function productionSnapshot(p: VisualProduction): VisualProfileSnapshot {
  if (!p.version || !p.effective) throw new VisualProfileError('No visual profile to plan with: the library has no default');
  return {
    mode: p.mode,
    revision: p.revision,
    familyId: p.version.familyId,
    familyName: p.version.family.name,
    profileId: p.version.id,
    name: p.version.name,
    version: p.version.version,
    overrides: p.overrides,
    effective: p.effective,
    provenance: p.provenance,
  };
}

// ── The library ──────────────────────────────────────────────────────────────

/** Why a name cannot be a profile's: another family has it (ignoring case). */
async function checkName(db: Db, name: string, family?: string): Promise<void> {
  const other = await db.visualProfileFamily.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(family ? { id: { not: family } } : {}) }, select: { name: true } });
  if (other) throw new VisualProfileError(`A visual profile is already named "${other.name}": choose another name`);
}

async function familyOrThrow(db: Db, familyId: string): Promise<VisualProfileFamily> {
  const family = await db.visualProfileFamily.findUnique({ where: { id: familyId } });
  if (!family) throw new NotFoundError('Visual profile', familyId);
  return family;
}

async function versionOf(db: Db, family: VisualProfileFamily, versionId: string | undefined): Promise<VisualProfileRow> {
  const v = versionId ? await db.visualProfile.findFirst({ where: { id: versionId, familyId: family.id }, include: { family: true } }) : await familyCurrent(db, family.id);
  if (!v) throw versionId ? new NotFoundError(`Version of visual profile ${family.name}`, versionId) : new VisualProfileError(`Profile ${family.name} has no version`);
  return v;
}

/** A new version of a family, named as the family is now, numbered after its last. */
async function createVersion(tx: Tx, family: VisualProfileFamily, config: VisualStyleProfileConfig, extra: { origin: VisualProfileOrigin; basedOnId: string | null; notes: string | null; actor: string }): Promise<VisualProfileRow> {
  const last = await tx.visualProfile.aggregate({ where: { familyId: family.id }, _max: { version: true } });
  return tx.visualProfile.create({
    data: {
      familyId: family.id,
      name: family.name,
      version: (last._max.version ?? 0) + 1,
      config: config as unknown as Prisma.InputJsonValue,
      origin: extra.origin as unknown as Prisma.InputJsonValue,
      basedOnId: extra.basedOnId,
      notes: extra.notes,
      createdBy: extra.actor,
    },
    include: { family: true },
  });
}

/** A new profile (v1): the default preset's settings with `config` over them. */
export async function createVisualProfileFamily(db: Database, raw: CreateVisualProfileFamilyInput, actor: string): Promise<VisualProfileRow> {
  const input = CreateVisualProfileFamilyInput.parse(raw);
  await checkName(db, input.name);
  const { effective } = applyOverrides(DEFAULT_VISUAL_PROFILE_CONFIG, input.config ?? {}, 'PROFILE');
  return db.$transaction(async (tx) => {
    const family = await tx.visualProfileFamily.create({ data: { name: input.name, description: input.description ?? null, createdBy: actor } });
    return createVersion(tx, family, effective, { origin: { kind: 'LIBRARY' }, basedOnId: null, notes: input.notes ?? null, actor });
  });
}

/**
 * An edit: a new version, based on the current one (or an older one, to go
 * back to it) with `config` laid over it. Refused for an archived family,
 * when the current version is no longer the one the editor saw, and when
 * nothing changes from the current version.
 */
export async function newVisualProfileVersion(db: Database, familyId: string, raw: NewVisualProfileVersionInput, actor: string): Promise<VisualProfileRow> {
  const input = NewVisualProfileVersionInput.parse(raw);
  const family = await familyOrThrow(db, familyId);
  if (family.archivedAt) throw new VisualProfileError(`Profile ${family.name} is archived: unarchive it to edit it`);
  const current = await versionOf(db, family, undefined);
  if (input.expectedCurrent && input.expectedCurrent !== current.id) throw new VisualProfileError(`Profile ${family.name} changed since you opened it (now v${current.version}): review it and save again`);
  const base = input.basedOn ? await versionOf(db, family, input.basedOn) : current;
  const { effective } = applyOverrides(profileConfig(base), input.config, 'PROFILE');
  if (!configDifferences(profileConfig(current), effective).length) throw new VisualProfileError(`Nothing changed: v${current.version} of ${family.name} already has these settings`);
  return db.$transaction(async (tx) => {
    // The newest version is read again in the transaction: two edits at once make v2 and refuse the other.
    const now = await familyCurrent(tx, family.id);
    if (now && now.id !== current.id) throw new VisualProfileError(`Profile ${family.name} changed since you opened it (now v${now.version}): review it and save again`);
    return createVersion(tx, family, effective, { origin: { kind: 'EDIT', basedOnVersion: base.version }, basedOnId: base.id, notes: input.notes ?? null, actor });
  });
}

/** A new profile (v1) from any version of another, with `config` over it. */
export async function duplicateVisualProfile(db: Database, familyId: string, raw: DuplicateVisualProfileInput, actor: string): Promise<VisualProfileRow> {
  const input = DuplicateVisualProfileInput.parse(raw);
  const family = await familyOrThrow(db, familyId);
  const from = await versionOf(db, family, input.fromVersionId);
  await checkName(db, input.name);
  const { effective } = applyOverrides(profileConfig(from), input.config ?? {}, 'PROFILE');
  return db.$transaction(async (tx) => {
    const copy = await tx.visualProfileFamily.create({ data: { name: input.name, description: input.description ?? null, createdBy: actor } });
    return createVersion(tx, copy, effective, { origin: { kind: 'DUPLICATE', fromFamily: family.name, fromVersion: from.version }, basedOnId: from.id, notes: null, actor });
  });
}

/** Rename, describe, archive or unarchive a family, or make it the library default (its versions are not touched). */
export async function updateVisualProfileFamily(db: Database, familyId: string, raw: UpdateVisualProfileFamilyInput): Promise<VisualProfileFamily> {
  const input = UpdateVisualProfileFamilyInput.parse(raw);
  return db.$transaction(async (tx) => {
    const family = await familyOrThrow(tx, familyId);
    const data: Prisma.VisualProfileFamilyUpdateInput = {};
    if (input.name !== undefined && input.name !== family.name) {
      await checkName(tx, input.name, family.id);
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.archived === true && !family.archivedAt) {
      if (family.isDefault) throw new VisualProfileError(`${family.name} is the library default: make another profile the library default first`);
      data.archivedAt = new Date();
    }
    if (input.archived === false) data.archivedAt = null;
    if (input.isDefault) {
      if (input.archived ?? !!family.archivedAt) throw new VisualProfileError(`${family.name} is archived: unarchive it before making it the library default`);
      await versionOf(tx, family, undefined);
      await tx.visualProfileFamily.updateMany({ where: { isDefault: true, id: { not: family.id } }, data: { isDefault: false } });
      data.isDefault = true;
    }
    return Object.keys(data).length ? tx.visualProfileFamily.update({ where: { id: family.id }, data }) : family;
  });
}

/** A project's choice saved. */
export interface SavedVisualSelection {
  revision: number;
  family: VisualProfileFamily | null;
  /** Null: the library default, looked up when it is used. */
  version: VisualProfileRow | null;
  pinned: boolean;
  overrides: VisualConfigOverrides;
}

/**
 * A project's choice of visual profile, and its overrides. Refused when it
 * changed since the editor saw it (the revision, checked atomically), for an
 * archived family it does not already use, a version of another family, and
 * overrides that do not fit the profile's settings.
 */
export async function setVisualSelection(db: Database, project: Pick<Project, 'id' | 'slug'>, raw: VisualSelectionInput, actor: string): Promise<SavedVisualSelection> {
  const input = VisualSelectionInput.parse(raw);
  const existing = await db.visualSelection.findUnique({ where: { projectId: project.id } });
  const changed = (now: number) => new VisualProfileError(`The project's visual profile changed in another tab (revision ${input.revision}, now ${now}): reload and choose again`);
  if ((existing?.revision ?? 0) !== input.revision) throw changed(existing?.revision ?? 0);
  let family: VisualProfileFamily | null = null;
  let version: VisualProfileRow | null = null;
  if (input.familyId) {
    family = await familyOrThrow(db, input.familyId);
    if (family.archivedAt && existing?.familyId !== family.id) throw new VisualProfileError(`Profile ${family.name} is archived: unarchive it to choose it`);
    version = input.versionId ? await db.visualProfile.findFirst({ where: { id: input.versionId, familyId: family.id }, include: { family: true } }) : await familyCurrent(db, family.id);
    if (!version) throw new VisualProfileError(input.versionId ? `Version ${input.versionId} is not a version of ${family.name}` : `Profile ${family.name} has no version`);
    applyOverrides(profileConfig(version), input.overrides);
  } else applyOverrides(DEFAULT_VISUAL_PROFILE_CONFIG, input.overrides);
  const data = { familyId: input.familyId, pinnedVersionId: input.versionId ?? null, overrides: input.overrides as Prisma.InputJsonValue, updatedBy: actor };
  return db.$transaction(async (tx) => {
    let revision: number;
    if (existing) {
      const r = await tx.visualSelection.updateMany({ where: { id: existing.id, revision: input.revision }, data: { ...data, revision: { increment: 1 } } });
      if (!r.count) throw changed((await tx.visualSelection.findUnique({ where: { id: existing.id } }))?.revision ?? input.revision);
      revision = input.revision + 1;
    } else {
      try {
        revision = (await tx.visualSelection.create({ data: { projectId: project.id, ...data } })).revision;
      } catch (err) {
        if (isUniqueViolation(err)) throw changed(1);
        throw err;
      }
    }
    const which = !family ? 'the library default' : `${family.name}, ${input.versionId ? `pinned to v${version!.version}` : `following its current version (v${version!.version})`}`;
    const set = Object.keys(input.overrides).length;
    await tx.projectEvent.create({
      data: {
        projectId: project.id,
        type: EVENT.VISUAL_PROFILE_SELECTED,
        message: `Visual profile: ${which}${set ? `; ${set} setting(s) overridden for this project` : ''}`,
        data: { actor, familyId: family?.id ?? null, versionId: version?.id ?? null, pinned: !!input.versionId, overrides: input.overrides, revision } as Prisma.InputJsonValue,
      },
    });
    return { revision, family, version, pinned: !!input.versionId, overrides: input.overrides };
  });
}
