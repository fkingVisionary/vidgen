import {
  AssetRequirement,
  ContinuitySpec,
  ShotEvidence,
  ShotSpec,
  ShotSubjectDetail,
  ShotTiming,
  StoryboardContent,
  StoryboardQaFinding,
  VisualBeatContent,
  VisualCostEstimate,
  type ProductionMethod,
  type ScriptBlockClass,
  type ShotClaimRole,
  type StoryboardInputs,
  type StoryboardProvenance,
  type StoryboardScope,
  type StoryboardStatus,
  type VersionChanges,
  type TimingRelation,
  type VisualTreatment,
} from '@docengine/core';
import type { Database, Prisma, StoryboardDecision, Tx } from '@docengine/database';
import { z } from 'zod';
import { shotSubjectKeys } from './continuity.ts';
import type { PlannedBeat, PlannedShot, PlannedStoryboard, PlannedSubject, SpanRow, StoryboardDraft } from './draft.ts';
import { draftOf } from './draft.ts';

/**
 * Storyboard versions in the database: one storyboards row per immutable
 * version, with its continuity subjects, visual beats and shots and their
 * links to script blocks, claims and subjects. Saving always creates a new
 * version and supersedes the unapproved ones before it; nothing here ever
 * changes a saved version's content. A version read back is the planned
 * storyboard it was saved from (times, classes, evidence, costs and QA as
 * saved), and the draft to edit, re-plan or re-time it. Stored JSON is read
 * strictly: what does not parse is an error naming the row.
 */

type Db = Database | Tx;

/** What a version pins, as columns. */
export interface StoryboardPins {
  scriptId: string;
  storyId: string | null;
  languageVersionId: string | null;
  voiceRunId: string | null;
  voiceAssemblyId: string | null;
  assemblyVersion: number | null;
  narrationFingerprint: string | null;
  visualProfileId: string | null;
}

export interface SaveVersionArgs {
  projectId: string;
  status: Extract<StoryboardStatus, 'IN_REVIEW' | 'DRAFT'>;
  scope: StoryboardScope;
  pins: StoryboardPins;
  revisionOfId: string | null;
  jobId: string | null;
  createdBy: string | null;
  planned: PlannedStoryboard;
  content: StoryboardContent;
  /** Supersede the project's unapproved versions (not for a version saved as DRAFT by a stale phase run: it displaces no review). */
  supersede: boolean;
}

export interface SavedVersion {
  id: string;
  version: number;
  /** Earlier unapproved versions this one superseded. */
  superseded: { id: string; version: number }[];
  /** Row ids by shot key. */
  shotIds: Map<string, string>;
}

/** The project row locked for this transaction: versions are numbered and superseded one save at a time. */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** A planned storyboard's content: what it was planned from (with the pricing it used), how it came about, and what code measured. */
export function contentOf(planned: PlannedStoryboard, a: { inputs: Omit<StoryboardInputs, 'pricing'>; provenance: StoryboardProvenance; changes: VersionChanges | null; notes?: string[] }): StoryboardContent {
  return {
    engineVersion: 1,
    inputs: { ...a.inputs, pricing: planned.pricing },
    provenance: a.provenance,
    scope: planned.scope,
    approaches: planned.approaches,
    alternatives: planned.alternatives,
    rhythm: planned.rhythm,
    costs: planned.costs,
    evidenceCoverage: planned.evidenceCoverage,
    changes: a.changes,
    normalization: planned.normalization,
    notes: a.notes ?? [],
  };
}

/** A value checked against its contract before it is stored: a mistake is an error naming the row, never a stored version that cannot be read. */
function checked<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Error(`${what} does not fit its contract: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
}

/**
 * A new version (its number after the project's last), with all its rows.
 * Earlier DRAFT, IN_REVIEW and CHANGES_REQUESTED versions are superseded
 * (kept); an APPROVED one stays approved until a newer one is approved.
 * Every shot and beat must be timed on the narration.
 */
export async function saveVersion(tx: Tx, a: SaveVersionArgs): Promise<SavedVersion> {
  const p = a.planned;
  const untimed = [...p.beats.filter((b) => b.startMs === null || b.endMs === null).map((b) => b.key), ...p.shots.filter((s) => s.startMs === null || s.endMs === null || !s.timing).map((s) => s.key)];
  if (untimed.length) throw new Error(`Not saved: ${untimed.join(', ')} ${untimed.length === 1 ? 'is' : 'are'} not timed on the narration`);
  const content = checked(StoryboardContent, a.content, 'The version content');
  const last = await tx.storyboard.findFirst({ where: { projectId: a.projectId }, orderBy: { version: 'desc' }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  const replaced = a.supersede ? await tx.storyboard.findMany({ where: { projectId: a.projectId, status: { in: ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED'] } }, select: { id: true, version: true } }) : [];
  if (replaced.length) await tx.storyboard.updateMany({ where: { id: { in: replaced.map((r) => r.id) } }, data: { status: 'SUPERSEDED' } });

  const row = await tx.storyboard.create({
    data: {
      projectId: a.projectId,
      scriptId: a.pins.scriptId,
      version,
      status: a.status,
      storyId: a.pins.storyId,
      languageVersionId: a.pins.languageVersionId,
      voiceRunId: a.pins.voiceRunId,
      voiceAssemblyId: a.pins.voiceAssemblyId,
      assemblyVersion: a.pins.assemblyVersion,
      narrationFingerprint: a.pins.narrationFingerprint,
      visualProfileId: a.pins.visualProfileId,
      engineVersion: content.engineVersion,
      scope: a.scope,
      revisionOfId: a.revisionOfId,
      jobId: a.jobId,
      content: json(content),
      qa: json(checked(z.array(StoryboardQaFinding), p.qa, 'The QA')),
      qaPassed: p.qaPassed,
      runtimeMs: p.runtimeMs,
      beatCount: p.beats.length,
      shotCount: p.shots.length,
      estimatedCostUsd: p.costs.totalUsd,
      costBasis: p.costs.basis,
      unpricedShotCount: p.costs.unpricedShots,
      createdBy: a.createdBy,
    },
  });

  const subjects = p.subjects.length
    ? await tx.continuitySubject.createManyAndReturn({
        data: p.subjects.map((s) => ({
          storyboardId: row.id,
          subjectKey: s.key,
          kind: s.spec.kind,
          castId: s.spec.castId,
          name: s.spec.name,
          infoClass: s.infoClass,
          spec: json(checked(ContinuitySpec, s.spec, `Subject ${s.key}`)),
          contentHash: s.contentHash,
        })),
        select: { id: true, subjectKey: true },
      })
    : [];
  const subjectIds = new Map(subjects.map((s) => [s.subjectKey, s.id]));

  const beats = await tx.visualBeat.createManyAndReturn({
    data: p.beats.map((b) => ({
      storyboardId: row.id,
      beatKey: b.key,
      sortOrder: b.sortOrder,
      sceneId: b.sceneId,
      sequenceNumber: b.sequenceNumber,
      archBeatIds: b.archBeatIds,
      startMs: b.startMs!,
      endMs: b.endMs!,
      treatment: b.treatment,
      infoClass: b.infoClass,
      content: json(checked(VisualBeatContent, b.stored, `Beat ${b.key}`)),
      contentHash: b.contentHash,
    })),
    select: { id: true, beatKey: true },
  });
  const beatIds = new Map(beats.map((b) => [b.beatKey, b.id]));
  const beatBlocks = p.beats.flatMap((b) => b.blocks.map((r) => ({ beatId: beatIds.get(b.key)!, ...spanData(r) })));
  if (beatBlocks.length) await tx.visualBeatBlock.createMany({ data: beatBlocks });
  const beatClaims = p.beats.flatMap((b) => [...new Set(b.claimRows.map((c) => c.claimId))].map((claimId) => ({ beatId: beatIds.get(b.key)!, claimId })));
  if (beatClaims.length) await tx.visualBeatClaim.createMany({ data: beatClaims });

  const shots = await tx.shot.createManyAndReturn({
    data: p.shots.map((s) => ({
      storyboardId: row.id,
      sceneId: s.sceneId,
      sortOrder: s.sortOrder,
      durationSec: (s.endMs! - s.startMs!) / 1000,
      narrationAnchor: s.narrationAnchor,
      shotType: s.direction.shotType,
      cameraMotion: s.direction.movement.motion,
      direction: json(checked(ShotSpec, s.direction, `Shot ${s.key}: its spec`)),
      status: 'PLANNED' as const,
      beatId: beatIds.get(s.beatKey) ?? null,
      shotKey: s.key,
      startMs: s.startMs,
      endMs: s.endMs,
      timingRelation: s.relation,
      timing: json(checked(ShotTiming, s.timing, `Shot ${s.key}: its timing`)),
      treatment: s.treatment,
      productionMethod: s.method,
      infoClass: s.infoClass,
      assetRequirement: s.asset ? json(checked(AssetRequirement, s.asset, `Shot ${s.key}: its asset requirement`)) : undefined,
      evidence: s.evidence ? json(checked(ShotEvidence, s.evidence, `Shot ${s.key}: its evidence`)) : undefined,
      costEstimate: s.cost ? json(checked(VisualCostEstimate, s.cost, `Shot ${s.key}: its cost estimate`)) : undefined,
      estimatedCostUsd: s.cost?.totalUsd ?? null,
      costBasis: s.cost?.basis ?? null,
      contentHash: s.contentHash,
    })),
    select: { id: true, shotKey: true },
  });
  const shotIds = new Map(shots.map((s) => [s.shotKey!, s.id]));
  const shotBlocks = p.shots.flatMap((s) => s.blocks.map((r) => ({ shotId: shotIds.get(s.key)!, ...spanData(r) })));
  if (shotBlocks.length) await tx.shotBlock.createMany({ data: shotBlocks });
  const shotClaims = p.shots.flatMap((s) => {
    const seen = new Set<string>();
    return s.claimRows.flatMap((c) => (seen.has(`${c.claimId} ${c.role}`) ? [] : (seen.add(`${c.claimId} ${c.role}`), [{ shotId: shotIds.get(s.key)!, claimId: c.claimId, role: c.role }])));
  });
  if (shotClaims.length) await tx.shotClaim.createMany({ data: shotClaims });
  const shotSubjects = p.shots.flatMap((s) =>
    s.subjects.flatMap((x) => (subjectIds.has(x.subjectKey) ? [{ shotId: shotIds.get(s.key)!, subjectId: subjectIds.get(x.subjectKey)!, detail: json(checked(ShotSubjectDetail, x.detail, `Shot ${s.key}: subject ${x.subjectKey}`)) }] : [])),
  );
  if (shotSubjects.length) await tx.shotSubject.createMany({ data: shotSubjects });
  return { id: row.id, version, superseded: replaced, shotIds };
}

const spanData = (r: SpanRow) => ({ scriptBlockId: r.scriptBlockId, startMs: r.startMs, endMs: r.endMs, firstWord: r.firstWord, lastWord: r.lastWord });

// ── Reading a version back ───────────────────────────────────────────────────

const SPAN_INCLUDE = { scriptBlock: { select: { blockKey: true } } } as const;

export const STORYBOARD_INCLUDE = {
  continuity: { orderBy: { subjectKey: 'asc' } },
  beats: { orderBy: { sortOrder: 'asc' }, include: { scene: { select: { sceneKey: true } }, blocks: { include: SPAN_INCLUDE }, claims: { include: { claim: { select: { claimKey: true } } } } } },
  shots: {
    orderBy: { sortOrder: 'asc' },
    include: {
      scene: { select: { sceneKey: true } },
      beat: { select: { beatKey: true } },
      blocks: { include: SPAN_INCLUDE },
      claims: { include: { claim: { select: { claimKey: true } } } },
      subjects: { include: { subject: { select: { subjectKey: true } } } },
    },
  },
} as const satisfies Prisma.StoryboardInclude;

export type StoryboardRow = Prisma.StoryboardGetPayload<{ include: typeof STORYBOARD_INCLUDE }>;

export interface LoadedStoryboard {
  row: StoryboardRow;
  content: StoryboardContent;
  /** The version as it was saved: times, classes, evidence, costs and QA. */
  planned: PlannedStoryboard;
  /** What a model or editor decided, to make the next version from. */
  draft: StoryboardDraft;
}

/** Stored JSON read strictly. */
function read<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Error(`${what} cannot be read (${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')})`);
}

const spanOf = (r: { scriptBlockId: string; startMs: number; endMs: number; firstWord: number; lastWord: number; scriptBlock: { blockKey: string } }): SpanRow => ({
  scriptBlockId: r.scriptBlockId,
  blockKey: r.scriptBlock.blockKey,
  startMs: r.startMs,
  endMs: r.endMs,
  firstWord: r.firstWord,
  lastWord: r.lastWord,
});

/** A saved version as the planned storyboard it was saved from, and its draft. */
export function toLoaded(row: StoryboardRow): LoadedStoryboard {
  const v = `Storyboard v${row.version}`;
  const content = read(StoryboardContent, row.content, `${v}: its content`);
  const subjectKeyOf = new Map(row.continuity.map((s) => [s.id, s.subjectKey]));
  const shots: PlannedShot[] = row.shots.map((s) => {
    const key = s.shotKey ?? `shot ${s.sortOrder + 1}`;
    const what = `${v}, ${key}`;
    const timing = read(ShotTiming, s.timing, `${what}: its timing`);
    const direction = read(ShotSpec, s.direction, `${what}: its spec`);
    const cost = s.costEstimate === null ? null : read(VisualCostEstimate, s.costEstimate, `${what}: its cost estimate`);
    const { depiction: _derived, ...spec } = direction;
    return {
      key,
      beatKey: s.beat?.beatKey ?? '',
      narration: timing.narration,
      silenceAt: timing.silenceAt,
      visualFrom: timing.visualFrom,
      visualTo: timing.visualTo,
      cutIn: timing.cutIn,
      cutOut: timing.cutOut,
      cutOffsetMs: timing.cutOffsetMs ?? 0,
      treatment: s.treatment as VisualTreatment | null,
      method: s.productionMethod as ProductionMethod | null,
      // The class kept is the derived one or a lower proposal: as a proposal it gives the same class again.
      proposedClass: s.infoClass as ScriptBlockClass | null,
      spec,
      subjects: s.subjects.map((x) => ({ subjectKey: subjectKeyOf.get(x.subjectId) ?? x.subject.subjectKey, detail: read(ShotSubjectDetail, x.detail, `${what}: subject ${x.subject.subjectKey}`) })),
      claims: s.claims.map((c) => ({ claimKey: c.claim.claimKey, role: c.role as ShotClaimRole })),
      recommendation: cost?.source === 'USER' && cost.provider && cost.model ? { provider: cost.provider, model: cost.model } : null,
      unplanned: s.treatment === null,
      sortOrder: s.sortOrder,
      sceneId: s.sceneId,
      sectionKey: s.scene.sceneKey,
      startMs: s.startMs,
      endMs: s.endMs,
      relation: s.timingRelation as TimingRelation | null,
      timing,
      narrationAnchor: s.narrationAnchor,
      infoClass: s.infoClass as ScriptBlockClass | null,
      direction,
      blocks: s.blocks.map(spanOf),
      claimRows: s.claims.map((c) => ({ claimId: c.claimId, claimKey: c.claim.claimKey, role: c.role as ShotClaimRole })),
      evidence: s.evidence === null ? null : read(ShotEvidence, s.evidence, `${what}: its evidence`),
      asset: s.assetRequirement === null ? null : read(AssetRequirement, s.assetRequirement, `${what}: its asset requirement`),
      cost,
      contentHash: s.contentHash ?? '',
    };
  });
  const beats: PlannedBeat[] = row.beats.map((b) => {
    const stored = read(VisualBeatContent, b.content, `${v}, ${b.beatKey}: its content`);
    const { functions: _functions, narration, approach: _approach, ...rest } = stored;
    return {
      key: b.beatKey,
      narration,
      content: rest,
      archBeatIds: b.archBeatIds,
      claimKeys: b.claims.map((c) => c.claim.claimKey),
      sortOrder: b.sortOrder,
      sceneId: b.sceneId,
      sectionKey: b.scene.sceneKey,
      sequenceNumber: b.sequenceNumber,
      startMs: b.startMs,
      endMs: b.endMs,
      treatment: b.treatment as VisualTreatment,
      infoClass: b.infoClass as ScriptBlockClass,
      stored,
      blocks: b.blocks.map(spanOf),
      claimRows: b.claims.map((c) => ({ claimId: c.claimId, claimKey: c.claim.claimKey })),
      shotKeys: shots.filter((s) => s.beatKey === b.beatKey).map((s) => s.key),
      contentHash: b.contentHash,
    };
  });
  const subjects: PlannedSubject[] = row.continuity.map((s) => ({
    key: s.subjectKey,
    spec: read(ContinuitySpec, s.spec, `${v}, ${s.subjectKey}: its spec`),
    infoClass: s.infoClass as ScriptBlockClass,
    appearances: shots.filter((x) => shotSubjectKeys(x).includes(s.subjectKey)).map((x) => x.key),
    contentHash: s.contentHash,
  }));
  const planned: PlannedStoryboard = {
    approach: content.approaches.chosen,
    beats,
    shots,
    subjects,
    scope: content.scope,
    runtimeMs: row.runtimeMs ?? content.scope.endMs,
    approaches: content.approaches,
    alternatives: content.alternatives,
    rhythm: content.rhythm,
    costs: content.costs,
    evidenceCoverage: content.evidenceCoverage,
    pricing: content.inputs.pricing,
    normalization: content.normalization,
    qa: read(z.array(StoryboardQaFinding), row.qa, `${v}: its QA`),
    qaPassed: row.qaPassed,
  };
  return { row, content, planned, draft: draftOf(planned) };
}

/** A saved version by id (null: none). */
export async function loadStoryboard(db: Db, id: string): Promise<LoadedStoryboard | null> {
  const row = await db.storyboard.findUnique({ where: { id }, include: STORYBOARD_INCLUDE });
  return row ? toLoaded(row) : null;
}

/** Every shot key the project's versions have used: a new shot never takes one. */
export async function usedShotKeys(db: Db, projectId: string): Promise<string[]> {
  const rows = await db.shot.findMany({ where: { storyboard: { projectId }, shotKey: { not: null } }, select: { shotKey: true }, distinct: ['shotKey'] });
  return rows.map((r) => r.shotKey!);
}

/** The latest decision on each shot of a version (append-only rows: the newest counts; null when none). */
export async function latestShotDecisions(db: Db, storyboardId: string): Promise<Map<string, StoryboardDecision>> {
  const rows = await db.storyboardDecision.findMany({ where: { storyboardId, shotId: { not: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const out = new Map<string, StoryboardDecision>();
  for (const r of rows) out.set(r.shotId!, r);
  return out;
}
