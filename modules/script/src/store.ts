import {
  BlockPresentation,
  DEFAULT_DELIVERY,
  ScriptContent,
  ScriptDelivery,
  ScriptSectionPlan,
  ScriptVisual,
  type ArtifactStatus,
  type Pronunciation,
  type QualityReport,
  type ScriptBlockClass,
  type SectionReviewStatus,
} from '@docengine/core';
import type { Database, Prisma, Script, Tx } from '@docengine/database';
import { z } from 'zod';
import { allBlocks, sectionDurationSec, sectionWords, type DraftBlock, type DraftSection, type ScriptDraft } from './draft.ts';

/**
 * Script versions in the database: one scripts row, one scene per section,
 * the master-language narration of each scene, its blocks and the claims
 * each block rests on. Saving always creates a new version; a saved version
 * is changed only by the editor's own edits while it is under review.
 */

const parse = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
  const r = schema.safeParse(value);
  return r.success ? r.data : fallback;
};
const DEFAULT_VISUAL: ScriptVisual = { intent: 'NONE', mustShow: [], mustAvoid: [], priority: 'NORMAL', fictional: false, note: '' };

export interface SaveVersionArgs {
  projectId: string;
  languageVersionId: string;
  architectureId: string;
  dossierClaimIds: ReadonlyMap<string, string>;
  jobId: string | null;
  revisionOfId: string | null;
  notes: string | null;
  draft: ScriptDraft;
  content: ScriptContent;
  report: QualityReport;
  stats: Record<string, unknown>;
  targetDurationSec: number;
  status: ArtifactStatus;
}

/** Save a new version; DRAFT and IN_REVIEW versions it replaces are superseded (kept). Returns its id, version and what it superseded. */
export async function saveVersion(tx: Tx, a: SaveVersionArgs): Promise<{ id: string; version: number; superseded: number[] }> {
  const last = await tx.script.findFirst({ where: { projectId: a.projectId }, orderBy: { version: 'desc' }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  const replaced = await tx.script.findMany({ where: { projectId: a.projectId, status: { in: ['DRAFT', 'IN_REVIEW'] } }, select: { id: true, version: true } });
  if (replaced.length) await tx.script.updateMany({ where: { id: { in: replaced.map((r) => r.id) } }, data: { status: 'SUPERSEDED' } });
  const blocks = allBlocks(a.draft);
  const script = await tx.script.create({
    data: {
      projectId: a.projectId,
      storyId: a.architectureId,
      version,
      status: a.status,
      engineVersion: a.content.engineVersion,
      content: a.content as unknown as Prisma.InputJsonValue,
      qualityReport: a.report as unknown as Prisma.InputJsonValue,
      qualityPassed: a.report.passed,
      stats: a.stats as Prisma.InputJsonValue,
      notes: a.notes,
      targetDurationSec: a.targetDurationSec,
      wordCount: blocks.reduce((n, b) => n + b.wordCount, 0),
      estimatedDurationSec: Math.round(blocks.reduce((n, b) => n + b.estimatedDurationSec, 0)),
      scores: (a.content.editor ? Object.fromEntries(Object.entries(a.content.editor.scores).map(([k, v]) => [k, v!.score])) : undefined) as Prisma.InputJsonValue | undefined,
      revisionOfId: a.revisionOfId,
      jobId: a.jobId,
    },
  });
  for (const [i, s] of a.draft.sections.entries()) await saveSection(tx, script.id, a, s, i);
  return { id: script.id, version, superseded: replaced.map((r) => r.version) };
}

async function saveSection(tx: Tx, scriptId: string, a: SaveVersionArgs, s: DraftSection, index: number): Promise<void> {
  const scene = await tx.scene.create({
    data: {
      scriptId,
      sceneKey: s.key,
      sortOrder: index,
      title: s.title,
      sequenceNumber: s.sequence,
      content: (s.plan ?? undefined) as Prisma.InputJsonValue | undefined,
      targetDurationSec: s.targetDurationSec,
      reviewStatus: s.reviewStatus,
      editorNotes: s.editorNotes,
      reviewedBy: s.reviewedBy,
      reviewedAt: s.reviewedAt ? new Date(s.reviewedAt) : null,
      emotionalTone: dominantEmotion(s),
      visualIntent: dominantIntent(s),
    },
  });
  const narration = await tx.sceneNarration.create({
    data: {
      sceneId: scene.id,
      languageVersionId: a.languageVersionId,
      text: s.blocks.map((b) => b.text).join('\n\n'),
      wordCount: sectionWords(s),
      estimatedDurationSec: sectionDurationSec(s),
    },
  });
  for (const [i, b] of s.blocks.entries()) {
    const row = await tx.scriptBlock.create({ data: blockData(scriptId, narration.id, b, i) });
    const claimIds = b.claimKeys.flatMap((k) => (a.dossierClaimIds.has(k) ? [a.dossierClaimIds.get(k)!] : []));
    if (claimIds.length) await tx.scriptBlockClaim.createMany({ data: claimIds.map((claimId) => ({ blockId: row.id, claimId })) });
  }
}

export function blockData(scriptId: string, narrationId: string, b: DraftBlock, sortOrder: number): Prisma.ScriptBlockUncheckedCreateInput {
  return {
    scriptId,
    narrationId,
    blockKey: b.key,
    sortOrder,
    text: b.text,
    generatedText: b.generatedText,
    infoClass: b.infoClass,
    beatIds: b.beatIds,
    speakerId: b.speakerId,
    speechKind: b.speechKind,
    fictionalDevice: b.fictionalDevice,
    delivery: b.delivery as unknown as Prisma.InputJsonValue,
    visual: b.visual as unknown as Prisma.InputJsonValue,
    presentation: b.presentation as unknown as Prisma.InputJsonValue,
    wordCount: b.wordCount,
    estimatedDurationSec: b.estimatedDurationSec,
    editedBy: b.editedBy,
    editedAt: b.editedAt ? new Date(b.editedAt) : null,
  };
}

function dominantEmotion(s: DraftSection): string | null {
  const counts = new Map<string, number>();
  for (const b of s.blocks) if (b.delivery.emotion !== 'NEUTRAL') counts.set(b.delivery.emotion, (counts.get(b.delivery.emotion) ?? 0) + b.wordCount);
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

function dominantIntent(s: DraftSection): string | null {
  const counts = new Map<string, number>();
  for (const b of s.blocks) if (b.visual.intent !== 'NONE') counts.set(b.visual.intent, (counts.get(b.visual.intent) ?? 0) + b.wordCount);
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

// ── Loading ──────────────────────────────────────────────────────────────────

export const SCRIPT_INCLUDE = {
  scenes: {
    orderBy: { sortOrder: 'asc' },
    include: {
      narrations: {
        include: { blocks: { orderBy: { sortOrder: 'asc' }, include: { claims: { include: { claim: { select: { claimKey: true, sortOrder: true } } } } } } },
      },
    },
  },
} as const satisfies Prisma.ScriptInclude;

export type ScriptRow = Prisma.ScriptGetPayload<{ include: typeof SCRIPT_INCLUDE }>;

export interface LoadedScript {
  row: ScriptRow;
  content: ScriptContent | null;
  draft: ScriptDraft;
}

/** A saved version as a draft (the master-language narration). */
export function toDraft(row: ScriptRow, languageVersionId: string | null = null): LoadedScript {
  const content = parse(ScriptContent.nullable(), row.content, null);
  const posed = content?.centralQuestion.posedIn ?? null;
  const answered = content?.centralQuestion.answeredIn ?? null;
  const sections: DraftSection[] = row.scenes.map((scene) => {
    const narration = scene.narrations.find((n) => !languageVersionId || n.languageVersionId === languageVersionId) ?? scene.narrations[0];
    const blocks: DraftBlock[] = (narration?.blocks ?? []).map((b) => ({
      rowId: b.id,
      key: b.blockKey,
      text: b.text,
      generatedText: b.generatedText,
      infoClass: b.infoClass as ScriptBlockClass,
      beatIds: b.beatIds,
      claimKeys: [...b.claims].sort((x, y) => x.claim.sortOrder - y.claim.sortOrder).map((c) => c.claim.claimKey),
      speakerId: b.speakerId,
      speechKind: b.speechKind === 'RECORDED_QUOTE' || b.speechKind === 'INVENTED' ? b.speechKind : null,
      fictionalDevice: b.fictionalDevice,
      delivery: parse(ScriptDelivery, b.delivery, DEFAULT_DELIVERY),
      visual: parse(ScriptVisual, b.visual, DEFAULT_VISUAL),
      presentation: parse(z.array(BlockPresentation), b.presentation, []),
      wordCount: b.wordCount,
      estimatedDurationSec: b.estimatedDurationSec,
      editedBy: b.editedBy,
      editedAt: b.editedAt?.toISOString() ?? null,
      centralQuestion: b.blockKey === posed ? 'POSED' : b.blockKey === answered ? 'ANSWERED' : null,
    }));
    return {
      rowId: scene.id,
      sequence: scene.sequenceNumber ?? scene.sortOrder + 1,
      key: scene.sceneKey,
      title: scene.title ?? '',
      plan: parse(ScriptSectionPlan.nullable(), scene.content ?? null, null),
      reviewStatus: scene.reviewStatus as SectionReviewStatus,
      editorNotes: scene.editorNotes,
      reviewedBy: scene.reviewedBy,
      reviewedAt: scene.reviewedAt?.toISOString() ?? null,
      targetDurationSec: scene.targetDurationSec,
      blocks,
      written: false,
    };
  });
  return { row, content, draft: { sections, pronunciations: content?.pronunciations ?? [] } };
}

export async function loadVersion(db: Database | Tx, projectId: string, version: number): Promise<LoadedScript | null> {
  const row = await db.script.findUnique({ where: { projectId_version: { projectId, version } }, include: SCRIPT_INCLUDE });
  return row ? toDraft(row) : null;
}

export async function loadById(db: Database | Tx, id: string): Promise<LoadedScript | null> {
  const row = await db.script.findUnique({ where: { id }, include: SCRIPT_INCLUDE });
  return row ? toDraft(row) : null;
}

export type { Script, Pronunciation };
