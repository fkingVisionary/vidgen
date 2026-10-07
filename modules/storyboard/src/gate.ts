import type { ApprovalDecision, ApprovalInput, VisualCatalog } from '@docengine/core';
import type { Prisma, Project, Tx } from '@docengine/database';
import { ConflictError, EVENT, type GateHook } from '@docengine/pipeline';
import { approvedScript } from '@docengine/voice';
import { approvalBlockers, supersedeApproved } from './decisions.ts';
import { loadStoryboard } from './store.ts';

/**
 * The STORYBOARD gate (§2.13): the storyboard version under review (the
 * newest one in review, whatever its scope), decided by a person. Approval
 * needs, live: no blocking finding (staleness, the scope and the assembly
 * included: a preview of part of the script never passes), no shot
 * rejected, the whole script covered by a complete assembly, and that
 * assembly the narration the VOICE gate approved; the version named by the
 * reviewer must be the one under review. Request changes (FLAGGED) keeps
 * the gate open for an edit; Reject sends the project back to planning.
 * Earlier approved versions are superseded, kept. Approving enqueues
 * nothing: visual generation is the next milestone. With no approved script
 * (a placeholder pipeline) there is nothing of the storyboard's to check.
 */
export function storyboardGate(deps: { catalog: VisualCatalog }): GateHook {
  return async (tx: Tx, project: Project, decision: ApprovalDecision, actor: string, input: ApprovalInput) => {
    if (!(await approvedScript(tx, project.id))) return {};
    const head = await tx.storyboard.findFirst({ where: { projectId: project.id, status: { in: ['IN_REVIEW', 'CHANGES_REQUESTED'] } }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
    if (input.artifactId && input.artifactId !== head?.id) {
      const looked = await tx.storyboard.findFirst({ where: { id: input.artifactId, projectId: project.id }, select: { version: true } });
      throw new ConflictError(`STORYBOARD: the version you looked at (${looked ? `v${looked.version}` : input.artifactId}) is not the one under review${head ? ` (v${head.version})` : ''}: reload and review it`);
    }
    if (!head) {
      if (decision === 'APPROVED') throw new ConflictError('No storyboard version is under review: plan the storyboard of the approved narration first');
      return {};
    }
    const loaded = (await loadStoryboard(tx, head.id))!;
    const row = loaded.row;
    if (decision === 'APPROVED') {
      const { blockers, qa } = await approvalBlockers(tx, loaded, deps.catalog, { gate: true });
      if (qa.approval !== 'GATE_APPROVED') blockers.push(`its narration is not the one the VOICE gate approved: plan the storyboard of the approved narration`);
      if (blockers.length) throw new ConflictError(`Storyboard v${row.version} cannot pass the STORYBOARD gate: ${[...new Set(blockers)].join('; ')}`);
    }
    const status = decision === 'APPROVED' ? 'APPROVED' : decision === 'REJECTED' ? 'REJECTED' : 'CHANGES_REQUESTED';
    await tx.storyboard.update({ where: { id: row.id }, data: { status, decidedBy: actor, decidedAt: new Date() } });
    if (status === 'APPROVED') await supersedeApproved(tx, project.id, row, actor);
    return {
      storyboardId: row.id,
      languageVersionId: row.languageVersionId,
      onRecorded: async (t, approval) => {
        await t.storyboardDecision.create({ data: { projectId: project.id, storyboardId: row.id, shotId: null, decision: status, note: input.notes ?? null, decidedBy: actor, approvalId: approval.id } });
        await t.projectEvent.create({
          data: {
            projectId: project.id,
            type: EVENT.STORYBOARD_DECIDED,
            message: `Storyboard v${row.version} at the STORYBOARD gate: ${status === 'CHANGES_REQUESTED' ? 'changes requested' : status.toLowerCase()}`,
            data: { actor, storyboardId: row.id, version: row.version, decision: status, note: input.notes ?? null, gate: true, approvalId: approval.id } as Prisma.InputJsonValue,
          },
        });
      },
    };
  };
}
