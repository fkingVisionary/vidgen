import { ShotDecisionInput, StoryboardDecisionInput, type ApprovalDecision, type StoryboardDecisionKind, type StoryboardScope, type VisualCatalog } from '@docengine/core';
import type { Database, Prisma, Tx } from '@docengine/database';
import { ConflictError, EVENT, NotFoundError, type ProjectService } from '@docengine/pipeline';
import type { PlannedStoryboard } from './draft.ts';
import { carriedDecisions, type DecidedShot } from './edits.ts';
import { latestShotDecisions, loadStoryboard, lockProject, type LoadedStoryboard, type SavedVersion } from './store.ts';
import { liveQa, type LiveQa } from './views.ts';

/**
 * People's decisions on storyboards (§2.13). Every decision is a new row,
 * never an update of an old one, and always a person's: nothing here
 * approves anything by itself. A shot decision never changes a version's
 * content; a version's status mirrors its latest version-level decision. A
 * preview (part of the script) is decided at version level; a whole-script
 * version under review goes through the project's STORYBOARD gate. Approving
 * a version needs no blocking finding now (staleness included), no shot
 * rejected, and every take it is timed against approved.
 */

type Db = Database | Tx;

/** The newest version is not the one the request was made against (changed elsewhere): 409, with the newest number. */
export class VersionConflictError extends ConflictError {
  constructor(
    readonly latestVersion: number,
    expected: number,
  ) {
    super(`The storyboard changed since you opened it: v${latestVersion} is the newest version (you were working from v${expected}). Reload it, or save your changes as v${latestVersion + 1} anyway`);
  }
}

/** The project's newest storyboard version number (0: none). */
export async function newestVersion(db: Db, projectId: string): Promise<number> {
  const last = await db.storyboard.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { version: true } });
  return last?.version ?? 0;
}

/** Refused unless `expected` is the project's newest version. */
export async function requireNewest(db: Db, projectId: string, expected: number): Promise<void> {
  const latest = await newestVersion(db, projectId);
  if (latest !== expected) throw new VersionConflictError(latest, expected);
}

/**
 * Decisions carried to a new version (§2.12): each shot whose key, content
 * hash and length (within 10% or 300 ms) match the base gets a copy of its
 * latest decision there, naming the one it was carried from. A copy of a
 * person's decision on identical content, never a new approval; a cleared
 * decision is not carried, and a version's own decision never is.
 */
export async function carryDecisions(tx: Tx, a: { projectId: string; base: LoadedStoryboard; saved: Pick<SavedVersion, 'id' | 'shotIds'>; planned: Pick<PlannedStoryboard, 'shots'> }): Promise<number> {
  const latest = await latestShotDecisions(tx, a.base.row.id);
  const base: DecidedShot[] = a.base.row.shots.flatMap((s) => {
    if (!s.shotKey) return [];
    const d = latest.get(s.id);
    return [{ shotKey: s.shotKey, contentHash: s.contentHash ?? '', durationMs: s.startMs !== null && s.endMs !== null ? s.endMs - s.startMs : null, latest: d ? { id: d.id, decision: d.decision as StoryboardDecisionKind } : null }];
  });
  const next = a.planned.shots.map((s) => ({ shotKey: s.key, contentHash: s.contentHash, durationMs: s.startMs !== null && s.endMs !== null ? s.endMs - s.startMs : null }));
  const carried = carriedDecisions(base, next);
  if (!carried.length) return 0;
  const byId = new Map([...latest.values()].map((d) => [d.id, d]));
  await tx.storyboardDecision.createMany({
    data: carried.map((c) => {
      const from = byId.get(c.fromDecisionId)!;
      return { projectId: a.projectId, storyboardId: a.saved.id, shotId: a.saved.shotIds.get(c.shotKey)!, decision: c.decision, note: from.note, decidedBy: from.decidedBy, carriedFromId: from.id };
    }),
  });
  return carried.length;
}

/** What a decision service needs. */
export interface DecisionDeps {
  db: Database;
  projects: ProjectService;
  catalog: VisualCatalog;
}

const REVIEWABLE = new Set(['IN_REVIEW', 'CHANGES_REQUESTED']);

/** A person's decision on one shot (APPROVED, REJECTED, or CLEARED to withdraw it): a new row; the version's content is untouched. */
export async function decideShot(deps: DecisionDeps, shotId: string, raw: ShotDecisionInput, actor: string): Promise<{ storyboardId: string; shotKey: string; decision: string }> {
  const input = ShotDecisionInput.parse(raw);
  const shot = await deps.db.shot.findUnique({ where: { id: shotId }, include: { storyboard: { select: { id: true, projectId: true, version: true } } } });
  if (!shot || !shot.shotKey) throw new NotFoundError('Storyboard shot', shotId);
  return deps.db.$transaction(async (tx) => {
    await lockProject(tx, shot.storyboard.projectId);
    const sb = await tx.storyboard.findUniqueOrThrow({ where: { id: shot.storyboardId }, select: { status: true, version: true } });
    if (!REVIEWABLE.has(sb.status)) throw new ConflictError(`Storyboard v${sb.version} is ${sb.status.toLowerCase().replace(/_/g, ' ')}: its shots are decided only while it is under review`);
    await tx.storyboardDecision.create({ data: { projectId: shot.storyboard.projectId, storyboardId: shot.storyboardId, shotId: shot.id, decision: input.decision, note: input.note ?? null, decidedBy: actor } });
    await tx.projectEvent.create({
      data: {
        projectId: shot.storyboard.projectId,
        type: EVENT.STORYBOARD_SHOT_DECIDED,
        message: `Storyboard v${sb.version}, ${shot.shotKey}: ${input.decision === 'CLEARED' ? 'decision withdrawn' : input.decision.toLowerCase()}`,
        data: { actor, storyboardId: shot.storyboardId, shotKey: shot.shotKey, decision: input.decision, note: input.note ?? null } as Prisma.InputJsonValue,
      },
    });
    return { storyboardId: shot.storyboardId, shotKey: shot.shotKey!, decision: input.decision };
  });
}

/** Why a version cannot be approved now (none: it can), with the live QA it was judged on. The gate adds its own conditions. */
export async function approvalBlockers(db: Db, loaded: LoadedStoryboard, catalog: VisualCatalog, o: { gate?: boolean } = {}): Promise<{ blockers: string[]; qa: LiveQa }> {
  const qa = await liveQa(db, loaded, catalog, o);
  const out: string[] = [];
  const blocking = qa.findings.filter((f) => f.severity === 'BLOCKING');
  if (blocking.length) out.push(`${blocking.length} blocking finding(s): ${blocking.slice(0, 5).map((f) => `${f.ref ? `${f.ref} ` : ''}${f.kind}: ${f.detail}`).join('; ')}${blocking.length > 5 ? '; …' : ''}`);
  const latest = await latestShotDecisions(db, loaded.row.id);
  const rejected = loaded.row.shots.filter((s) => latest.get(s.id)?.decision === 'REJECTED').map((s) => s.shotKey);
  if (rejected.length) out.push(`shot${rejected.length === 1 ? '' : 's'} ${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} rejected: edit ${rejected.length === 1 ? 'it' : 'them'}, or clear the decision`);
  if (qa.approval === 'UNREVIEWED') {
    const takes = loaded.content.inputs.narration.takes;
    out.push(`the narration it is timed against is not approved (takes ${qa.approvedTakes}/${takes.length} approved): approve the takes first`);
  }
  return { blockers: out, qa };
}

/**
 * A person's decision on a whole version. A whole-script version under
 * review at the STORYBOARD gate is decided there (Approve, Request changes
 * as FLAGGED, Reject); a preview is decided here. Approving a preview
 * supersedes earlier approved previews (kept), never the whole-script
 * storyboard the gate approved; REJECTED is final for the version.
 */
export async function decideVersion(deps: DecisionDeps, storyboardId: string, raw: StoryboardDecisionInput, actor: string): Promise<{ storyboardId: string; version: number; status: string; viaGate: boolean }> {
  const input = StoryboardDecisionInput.parse(raw);
  const head = await deps.db.storyboard.findUnique({ where: { id: storyboardId }, select: { id: true, projectId: true, version: true, scope: true, project: { select: { status: true } } } });
  if (!head) throw new NotFoundError('Storyboard', storyboardId);
  if (head.scope === 'FULL') {
    if (head.project.status !== 'STORYBOARD_REVIEW') throw new ConflictError(`Storyboard v${head.version} covers the whole script: it is decided at the STORYBOARD gate, which is open in STORYBOARD_REVIEW (the project is ${head.project.status})`);
    await requireNewest(deps.db, head.projectId, input.expectedVersion);
    const decision: ApprovalDecision = input.decision === 'CHANGES_REQUESTED' ? 'FLAGGED' : input.decision;
    await deps.projects.recordApproval(head.projectId, { gate: 'STORYBOARD', decision, ...(input.note ? { notes: input.note } : {}), artifactId: head.id }, actor);
    const after = await deps.db.storyboard.findUniqueOrThrow({ where: { id: head.id }, select: { status: true } });
    return { storyboardId: head.id, version: head.version, status: after.status, viaGate: true };
  }
  return deps.db.$transaction(async (tx) => {
    await lockProject(tx, head.projectId);
    await requireNewest(tx, head.projectId, input.expectedVersion);
    const loaded = (await loadStoryboard(tx, head.id))!;
    const row = loaded.row;
    if (!REVIEWABLE.has(row.status)) throw new ConflictError(`Storyboard v${row.version} is ${row.status.toLowerCase().replace(/_/g, ' ')}: only a version under review is decided`);
    if (input.decision === 'APPROVED') {
      const { blockers } = await approvalBlockers(tx, loaded, deps.catalog);
      if (blockers.length) throw new ConflictError(`Storyboard v${row.version} cannot be approved yet: ${blockers.join('; ')}`);
    }
    const now = new Date();
    await tx.storyboard.update({ where: { id: row.id }, data: { status: input.decision, decidedBy: actor, decidedAt: now } });
    await tx.storyboardDecision.create({ data: { projectId: row.projectId, storyboardId: row.id, shotId: null, decision: input.decision, note: input.note ?? null, decidedBy: actor } });
    await tx.projectEvent.create({
      data: {
        projectId: row.projectId,
        type: EVENT.STORYBOARD_DECIDED,
        message: `Storyboard v${row.version} (${row.scope.toLowerCase()}): ${input.decision === 'CHANGES_REQUESTED' ? 'changes requested' : input.decision.toLowerCase()}`,
        data: { actor, storyboardId: row.id, version: row.version, decision: input.decision, note: input.note ?? null, gate: false } as Prisma.InputJsonValue,
      },
    });
    if (input.decision === 'APPROVED') await supersedeApproved(tx, row.projectId, row, actor);
    return { storyboardId: row.id, version: row.version, status: input.decision, viaGate: false };
  }, { timeout: 60_000 });
}

/**
 * Earlier approved versions are superseded by approving a newer one (kept,
 * not changed). A preview's approval supersedes only earlier previews: the
 * whole-script storyboard approved at the STORYBOARD gate stays the one the
 * project's approval rests on until another passes the gate.
 */
export async function supersedeApproved(tx: Tx, projectId: string, approved: { id: string; version: number; scope: StoryboardScope }, actor: string): Promise<void> {
  const older = await tx.storyboard.findMany({ where: { projectId, status: 'APPROVED', id: { not: approved.id }, ...(approved.scope === 'PARTIAL' ? { scope: 'PARTIAL' as const } : {}) }, select: { id: true, version: true } });
  if (!older.length) return;
  await tx.storyboard.updateMany({ where: { id: { in: older.map((o) => o.id) } }, data: { status: 'SUPERSEDED' } });
  await tx.projectEvent.create({
    data: {
      projectId,
      type: EVENT.STORYBOARD_SUPERSEDED,
      message: `Approved storyboard ${older.map((o) => `v${o.version}`).join(', ')} superseded by approving v${approved.version} (kept, not changed)`,
      data: { actor, superseded: older.map((o) => o.version), by: approved.version } as Prisma.InputJsonValue,
    },
  });
}
