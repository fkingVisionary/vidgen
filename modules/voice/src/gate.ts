import type { ApprovalDecision } from '@docengine/core';
import type { Project, Tx } from '@docengine/database';
import { ConflictError, EVENT, type GateHook } from '@docengine/pipeline';
import { liveRunQa } from './service.ts';
import { approvedScript } from './script.ts';

/**
 * The VOICE gate: the assembled narration of the whole approved script.
 * Approval needs a full run of the approved script version, every chunk's
 * current take approved, nothing blocking in voice QA (missing audio or
 * timestamps, failed or rejected takes, stale text, duplicate or missing
 * chunks, unresolved pronunciations), and the run's latest assembly. An
 * audition is never the narration. Earlier approved narrations are kept,
 * superseded.
 */
export function voiceGate(): GateHook {
  return async (tx: Tx, project: Project, decision: ApprovalDecision, actor: string) => {
    const script = await approvedScript(tx, project.id);
    // No script rows (placeholder pipeline): nothing of the voice engine's to check.
    if (!script) return {};
    const run = await tx.voiceRun.findFirst({
      where: { projectId: project.id, scriptId: script.id, kind: 'FULL' },
      orderBy: { number: 'desc' },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } }, profile: true, script: { select: { version: true } } },
    });
    const assembly = run ? await tx.voiceAssembly.findFirst({ where: { runId: run.id }, orderBy: { version: 'desc' } }) : null;
    if (decision !== 'APPROVED') return { voiceAssemblyId: assembly?.id ?? null };
    if (!run) throw new ConflictError(`No full narration of script v${script.version}: generate the whole script (a full voice run) before approving — an audition is not the narration`);
    if (!assembly) throw new ConflictError(`Voice run ${run.number} has no assembled narration yet`);
    const blocking = (await liveRunQa(tx, run)).filter((f) => f.severity === 'BLOCKING');
    if (blocking.length) {
      const shown = blocking.slice(0, 6).map((f) => `${f.ref ? `${f.ref} ` : ''}${f.detail}`);
      throw new ConflictError(`Voice run ${run.number} cannot be approved yet (${blocking.length} blocking finding(s)): ${shown.join('; ')}${blocking.length > 6 ? '; …' : ''}`);
    }
    if (!assembly.complete) throw new ConflictError(`Assembly v${assembly.version} of voice run ${run.number} does not cover the whole script`);
    await tx.voiceAssembly.update({ where: { id: assembly.id }, data: { status: 'APPROVED' } });
    const older = await tx.voiceAssembly.findMany({ where: { projectId: project.id, status: 'APPROVED', id: { not: assembly.id } }, select: { id: true } });
    if (older.length) {
      await tx.voiceAssembly.updateMany({ where: { id: { in: older.map((o) => o.id) } }, data: { status: 'SUPERSEDED' } });
      await tx.projectEvent.create({ data: { projectId: project.id, type: EVENT.VOICE_ASSEMBLY_SUPERSEDED, message: `${older.length} earlier approved narration(s) superseded by voice run ${run.number} (kept, not changed)`, data: { actor } } });
    }
    return { voiceAssemblyId: assembly.id };
  };
}
