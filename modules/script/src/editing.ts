import {
  ReorderScriptBlocksInput,
  RestoreScriptInput,
  ReviewScriptSectionInput,
  StoryArchitectureContentV2,
  UpdateScriptBlockInput,
  runtimeTarget,
  scriptTiming,
  type ScriptContent,
} from '@docengine/core';
import type { Database, Prisma, Project, Tx } from '@docengine/database';
import { ConflictError, EVENT, NotFoundError } from '@docengine/pipeline';
import { EvidenceBase, checkFigures } from '@docengine/story/shared';
import { allBlocks, derive, sectionDurationSec, sectionWords, type DraftBlock } from './draft.ts';
import { computeScriptReport } from './quality.ts';
import { checkScript } from './rules.ts';
import { buildScope, type ScriptScope } from './scope.ts';
import { blockData, loadById, saveVersion, toDraft, SCRIPT_INCLUDE } from './store.ts';

/**
 * The editor's hand on the script under review: edit a block (text, class,
 * delivery, visual intent), reorder a section's blocks, approve or reject a
 * section with notes, or make an earlier version current again. Every change
 * is recorded on the activity log with what it was before; the text the
 * model generated is kept on each block; the gate is re-run at once (rules
 * only, no model calls). Approved and superseded versions are never changed.
 */

type Actor = string;

const scopes = new Map<string, Promise<ScriptScope>>();

/** The architecture and evidence a script tells (cached: an architecture's content never changes). */
export function scopeFor(db: Database | Tx, architectureId: string): Promise<ScriptScope> {
  let p = scopes.get(architectureId);
  if (!p) {
    p = (async () => {
      const a = await db.storyArchitecture.findUniqueOrThrow({ where: { id: architectureId } });
      const content = StoryArchitectureContentV2.parse(a.content);
      if (!a.dossierId) throw new ConflictError(`Architecture v${a.version} has no research dossier`);
      const evidence = await EvidenceBase.load(db as Database, a.dossierId);
      return buildScope({ architectureId: a.id, architectureVersion: a.version, architecture: content, evidence });
    })();
    p.catch(() => scopes.delete(architectureId));
    scopes.set(architectureId, p);
    if (scopes.size > 16) scopes.delete(scopes.keys().next().value!);
  }
  return p;
}

async function lockProject(tx: Tx, projectId: string): Promise<Project> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('Project', projectId);
  return tx.project.findUniqueOrThrow({ where: { id: projectId } });
}

async function event(tx: Tx, projectId: string, type: string, message: string, data: Record<string, unknown>): Promise<void> {
  await tx.projectEvent.create({ data: { projectId, type, message, data: data as Prisma.InputJsonValue } });
}

/** The version under review, which is the only one the editor may change. */
async function editable(tx: Tx, scriptId: string): Promise<{ project: Project; script: { id: string; version: number; storyId: string | null; projectId: string } }> {
  const script = await tx.script.findUnique({ where: { id: scriptId }, select: { id: true, version: true, status: true, storyId: true, projectId: true } });
  if (!script) throw new NotFoundError('Script', scriptId);
  const project = await lockProject(tx, script.projectId);
  if (project.status !== 'SCRIPT_REVIEW') throw new ConflictError(`The script can be edited while the project is in SCRIPT_REVIEW (it is ${project.status})`);
  const fresh = await tx.script.findUniqueOrThrow({ where: { id: scriptId }, select: { status: true } });
  if (fresh.status !== 'IN_REVIEW') throw new ConflictError(`Script v${script.version} is ${fresh.status}; only the version under review can be changed`);
  if (!script.storyId) throw new ConflictError(`Script v${script.version} has no architecture`);
  return { project, script };
}

/** Re-run the gate on a version as it now stands, and store the result with its totals. */
export async function recheck(tx: Tx, scriptId: string, project: Project, scope: ScriptScope): Promise<{ passed: boolean }> {
  const row = await tx.script.findUniqueOrThrow({ where: { id: scriptId }, include: SCRIPT_INCLUDE });
  const { draft, content } = toDraft(row);
  const target = runtimeTarget(project);
  // The same comparison the job made: the version it came from (its refrains must survive) and the lines kept on purpose.
  const baseId = content?.provenance.baseId ?? null;
  const previous = baseId && baseId !== scriptId ? ((await loadById(tx, baseId))?.draft ?? null) : null;
  const findings = checkScript(draft, scope, { target, factIssues: content?.factCheck?.issues, previous, kept: content?.provenance.changeLog?.kept ?? [] });
  const blocks = allBlocks(draft);
  const timing = scriptTiming(blocks, target);
  const notes = ['Re-checked after the editor\'s change (rules only, no model calls)'];
  const report = computeScriptReport({ findings, timing, content: content ?? { editor: null, factCheck: null }, notes, draft });
  await tx.script.update({
    where: { id: scriptId },
    data: { qualityReport: report as unknown as Prisma.InputJsonValue, qualityPassed: report.passed, wordCount: timing.words, estimatedDurationSec: Math.round(timing.totalSec) },
  });
  for (const scene of row.scenes) {
    const s = draft.sections.find((x) => x.key === scene.sceneKey);
    for (const n of scene.narrations) {
      if (!s) continue;
      await tx.sceneNarration.update({ where: { id: n.id }, data: { text: s.blocks.map((b) => b.text).join('\n\n'), wordCount: sectionWords(s), estimatedDurationSec: sectionDurationSec(s) } });
    }
  }
  return { passed: report.passed };
}

export class ScriptEditing {
  constructor(private readonly db: Database) {}

  /** Change one block of the version under review. Returns the project id. */
  async editBlock(blockId: string, raw: UpdateScriptBlockInput, actor: Actor): Promise<string> {
    const input = UpdateScriptBlockInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const row = await tx.scriptBlock.findUnique({ where: { id: blockId }, include: { claims: { include: { claim: { select: { claimKey: true, sortOrder: true } } } } } });
      if (!row) throw new NotFoundError('Script block', blockId);
      const { project, script } = await editable(tx, row.scriptId);
      const scope = await scopeFor(tx, script.storyId!);
      const loaded = toDraft(await tx.script.findUniqueOrThrow({ where: { id: script.id }, include: SCRIPT_INCLUDE }));
      const before = allBlocks(loaded.draft).find((b) => b.key === row.blockKey && b.text === row.text) ?? allBlocks(loaded.draft).find((b) => b.key === row.blockKey)!;
      let next: DraftBlock = {
        ...before,
        text: input.text ?? before.text,
        infoClass: input.infoClass ?? before.infoClass,
        delivery: { ...before.delivery, ...(input.delivery ?? {}) },
        visual: { ...before.visual, ...(input.visual ?? {}) },
        editedBy: actor,
        editedAt: new Date().toISOString(),
      };
      // A figure the new text takes from another claim of the architecture links that claim.
      if (input.text && next.infoClass !== 'FRAMING' && next.infoClass !== 'FICTION') {
        const fig = checkFigures([next.text], next.claimKeys, scope.evidence, { linkFrom: scope.claims, strictYears: true });
        const added = fig.links.flatMap((l) => l.claimKeys).filter((k) => !next.claimKeys.includes(k));
        if (added.length) next = { ...next, claimKeys: [...next.claimKeys, ...added] };
      }
      next = derive(next, scope);
      const data = blockData(row.scriptId, row.narrationId, next, row.sortOrder);
      await tx.scriptBlock.update({ where: { id: blockId }, data: { ...data, generatedText: row.generatedText } });
      const claimIds = next.claimKeys.flatMap((k) => (scope.evidence.claim(k) ? [scope.evidence.claim(k)!.id] : []));
      await tx.scriptBlockClaim.deleteMany({ where: { blockId } });
      if (claimIds.length) await tx.scriptBlockClaim.createMany({ data: claimIds.map((claimId) => ({ blockId, claimId })) });
      const { passed } = await recheck(tx, script.id, project, scope);
      const changed = Object.keys(input).join(', ');
      await event(tx, project.id, EVENT.SCRIPT_EDITED, `Script v${script.version}, block ${row.blockKey}: ${changed} changed${passed ? '' : ' (gate: blocking findings remain)'}`, {
        actor,
        scriptId: script.id,
        blockKey: row.blockKey,
        before: { text: before.text, infoClass: before.infoClass, delivery: before.delivery, visual: before.visual },
        after: { text: next.text, infoClass: next.infoClass, delivery: next.delivery, visual: next.visual },
      });
      return project.id;
    });
  }

  /** The editor's order of one section's blocks (exactly that section's blocks). */
  async reorderBlocks(sectionId: string, raw: ReorderScriptBlocksInput, actor: Actor): Promise<string> {
    const input = ReorderScriptBlocksInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const scene = await tx.scene.findUnique({ where: { id: sectionId }, include: { narrations: { include: { blocks: { select: { id: true, blockKey: true, sortOrder: true } } } } } });
      if (!scene) throw new NotFoundError('Script section', sectionId);
      const { project, script } = await editable(tx, scene.scriptId);
      const blocks = scene.narrations.flatMap((n) => n.blocks);
      const ids = new Set(blocks.map((b) => b.id));
      if (input.blockIds.length !== ids.size || input.blockIds.some((id) => !ids.has(id)) || new Set(input.blockIds).size !== input.blockIds.length) {
        throw new ConflictError('The order must list exactly the blocks of the section, once each');
      }
      const before = [...blocks].sort((a, b) => a.sortOrder - b.sortOrder).map((b) => b.blockKey);
      for (const [i, id] of input.blockIds.entries()) await tx.scriptBlock.update({ where: { id }, data: { sortOrder: i } });
      const after = input.blockIds.map((id) => blocks.find((b) => b.id === id)!.blockKey);
      await recheck(tx, script.id, project, await scopeFor(tx, script.storyId!));
      await event(tx, project.id, EVENT.SCRIPT_EDITED, `Script v${script.version}, section ${scene.sequenceNumber ?? scene.sceneKey}: blocks reordered`, { actor, scriptId: script.id, section: scene.sceneKey, before, after });
      return project.id;
    });
  }

  /** Approve or reject a section of the version under review, or note what to change. */
  async reviewSection(sectionId: string, raw: ReviewScriptSectionInput, actor: Actor): Promise<string> {
    const input = ReviewScriptSectionInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const scene = await tx.scene.findUnique({ where: { id: sectionId } });
      if (!scene) throw new NotFoundError('Script section', sectionId);
      const { project, script } = await editable(tx, scene.scriptId);
      const status = input.reviewStatus ?? scene.reviewStatus;
      const notes = input.editorNotes === undefined ? scene.editorNotes : input.editorNotes || null;
      const decided = status !== scene.reviewStatus;
      await tx.scene.update({ where: { id: sectionId }, data: { reviewStatus: status, editorNotes: notes, ...(decided ? { reviewedBy: actor, reviewedAt: new Date() } : {}) } });
      const what = [decided ? `${scene.reviewStatus} → ${status}` : null, notes !== scene.editorNotes ? 'notes updated' : null].filter(Boolean).join(', ');
      if (what) await event(tx, project.id, EVENT.SCRIPT_SECTION_REVIEWED, `Script v${script.version}, section ${scene.sequenceNumber ?? scene.sceneKey} "${scene.title ?? ''}": ${what}`, { actor, scriptId: script.id, section: scene.sceneKey, status, notes });
      return project.id;
    });
  }

  /**
   * Make an earlier version current again: a new version that copies it
   * (text, edits, decisions), reviewed by the rules again. No model calls.
   * Allowed while a version is under review; it must tell the approved architecture.
   */
  async restore(projectId: string, raw: RestoreScriptInput, actor: Actor): Promise<{ version: number }> {
    const input = RestoreScriptInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, projectId);
      if (project.status !== 'SCRIPT_REVIEW') throw new ConflictError(`An earlier script version can be restored while a version is under review (the project is ${project.status})`);
      const old = await tx.script.findUnique({ where: { projectId_version: { projectId, version: input.version } }, select: { id: true, status: true, storyId: true } });
      if (!old) throw new NotFoundError('Script', `v${input.version}`);
      if (old.status === 'IN_REVIEW') throw new ConflictError(`Script v${input.version} is already the version under review`);
      const approved = await tx.storyArchitecture.findFirst({ where: { projectId, status: 'APPROVED' }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
      if (!approved || old.storyId !== approved.id) throw new ConflictError(`Script v${input.version} tells an architecture that is no longer the approved one`);
      const loaded = (await loadById(tx, old.id))!;
      const scope = await scopeFor(tx, approved.id);
      // A copy of an earlier version: the record of the narration pass that made it belongs to that run, not to this copy; the lines kept on purpose stay kept.
      const { narration: _run, ...earlier } = loaded.content ?? emptyContent(approved);
      const kept = earlier.provenance.changeLog?.kept ?? [];
      const content: ScriptContent = {
        ...earlier,
        provenance: { origin: 'RESTORE', baseVersion: input.version, baseId: old.id, sections: [], brief: null, requestedBy: actor, changeLog: kept.length ? { summary: `Restored from v${input.version}`, changes: [], kept } : null },
      };
      const languageVersionId = loaded.row.scenes[0]?.narrations[0]?.languageVersionId ?? (await tx.languageVersion.findFirstOrThrow({ where: { projectId, isMaster: true }, select: { id: true } })).id;
      const target = runtimeTarget(project);
      const findings = checkScript(loaded.draft, scope, { target, factIssues: content.factCheck?.issues });
      const report = computeScriptReport({ findings, timing: scriptTiming(allBlocks(loaded.draft), target), content, notes: [`Restored from v${input.version} (no model calls)`], draft: loaded.draft });
      const saved = await saveVersion(tx, {
        projectId,
        languageVersionId,
        architectureId: approved.id,
        dossierClaimIds: new Map(scope.claims.map((k) => [k, scope.evidence.claim(k)!.id])),
        jobId: null,
        revisionOfId: old.id,
        notes: `Restored from v${input.version}`,
        draft: loaded.draft,
        content,
        report,
        stats: { ...(loaded.row.stats as Record<string, unknown>), mode: 'RESTORE', restoredFrom: input.version },
        targetDurationSec: target.targetSec,
        status: 'IN_REVIEW',
      });
      await event(tx, projectId, EVENT.SCRIPT_RESTORED, `Script v${input.version} restored as v${saved.version} (v${saved.superseded.join(', v') || '—'} superseded, kept)`, { actor, from: input.version, version: saved.version, superseded: saved.superseded });
      return { version: saved.version };
    });
  }
}

function emptyContent(a: { id: string; version: number }): ScriptContent {
  return {
    engineVersion: 1,
    architecture: { id: a.id, version: a.version },
    narrator: { persona: '', tone: '', approach: '' },
    centralQuestion: { text: '', posedIn: null, answeredIn: null },
    pronunciations: [],
    performanceNotes: [],
    editor: null,
    factCheck: null,
    provenance: { origin: 'RESTORE', baseVersion: null, baseId: null, sections: [], brief: null, requestedBy: null, changeLog: null },
  };
}
