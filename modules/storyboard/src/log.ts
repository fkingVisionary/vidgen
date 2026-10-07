import { ContinuitySpec, StoryboardContent, StoryboardQaFinding } from '@docengine/core';
import type { Database, Tx } from '@docengine/database';
import { z } from 'zod';

/**
 * The storyboard summary log line (§2.18): one line per saved version with
 * the figures acceptance checks — read back from the database after the
 * save, never from memory, so what is logged is what was stored.
 */

type Db = Database | Tx;

const count = <T>(xs: readonly T[], key: (x: T) => string) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};
const braces = (r: Record<string, number>) => `{${Object.entries(r).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k}: ${n}`).join(', ')}}`;
const money = (usd: number | null) => (usd === null ? 'none priced' : `$${usd.toFixed(2)}`);

/**
 * "storyboard summary: v1 PARTIAL run 3 assembly v1 fp=… 0–109.8 s · beats
 * B · shots S · …", and the same figures as data. `jobId` adds the job's
 * planning calls and spend; `preview` says the project's status was left
 * as it is.
 */
export async function summaryLine(db: Db, storyboardId: string, o: { jobId?: string; preview?: boolean } = {}): Promise<{ line: string; data: Record<string, unknown> }> {
  const row = await db.storyboard.findUniqueOrThrow({
    where: { id: storyboardId },
    include: { shots: { select: { shotKey: true, treatment: true, timingRelation: true, startMs: true, endMs: true } }, continuity: { select: { subjectKey: true, spec: true } }, project: { select: { status: true } }, voiceRun: { select: { number: true } } },
  });
  const content = StoryboardContent.parse(row.content);
  const qa = z.array(StoryboardQaFinding).parse(row.qa);
  const blocking = qa.filter((f) => f.severity === 'BLOCKING');
  const warnings = qa.filter((f) => f.severity === 'WARNING');
  const durations = row.shots.map((s) => (s.endMs ?? 0) - (s.startMs ?? 0));
  const averageSec = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 100) / 10 : 0;
  const subjects = row.continuity.map((s) => ContinuitySpec.parse(s.spec));
  const references = subjects.filter((s) => s.referenceAsset.required).length;
  const takes = content.inputs.narration.takes;
  const live = await db.voiceGeneration.findMany({ where: { id: { in: takes.map((t) => t.id) } }, select: { status: true } });
  const approved = live.filter((t) => t.status === 'APPROVED').length;
  const calls = o.jobId ? await db.providerCall.findMany({ where: { jobId: o.jobId }, select: { estimatedCostUsd: true, actualCostUsd: true } }) : [];
  const spend = Math.round(calls.reduce((s, c) => s + Number(c.actualCostUsd ?? c.estimatedCostUsd ?? 0), 0) * 10_000) / 10_000;
  const costs = content.costs;
  const ev = content.evidenceCoverage;
  const data = {
    storyboardId: row.id,
    version: row.version,
    scope: row.scope,
    status: row.status,
    runNumber: row.voiceRun?.number ?? content.inputs.narration.runNumber,
    assemblyVersion: row.assemblyVersion,
    fingerprint: row.narrationFingerprint,
    runtimeMs: row.runtimeMs,
    beats: row.beatCount,
    shots: row.shotCount,
    averageShotSec: averageSec,
    treatments: count(row.shots, (s) => s.treatment ?? 'UNPLANNED'),
    relations: count(row.shots, (s) => s.timingRelation ?? 'UNTIMED'),
    estimatedCostUsd: costs.totalUsd,
    costBasis: costs.basis,
    unpricedShots: costs.unpricedShots,
    blocking: blocking.length,
    blockingKinds: count(blocking, (f) => f.kind),
    warnings: warnings.length,
    warningKinds: count(warnings, (f) => f.kind),
    normalizations: content.normalization.length,
    evidence: { traced: ev.traced, factualShots: ev.factualShots, untraced: ev.untraced },
    continuitySubjects: subjects.length,
    referencesRequired: references,
    takesApproved: approved,
    takes: takes.length,
    modelCalls: calls.length,
    planningSpendUsd: spend,
    projectStatus: row.project.status,
    notes: content.notes,
  };
  const line = [
    `storyboard summary: v${row.version} ${row.scope} run ${data.runNumber} assembly v${row.assemblyVersion ?? '?'} fp=${(row.narrationFingerprint ?? '').slice(0, 12)} ${content.scope.startMs / 1000}–${((row.runtimeMs ?? content.scope.endMs) / 1000).toFixed(1)} s`,
    `beats ${row.beatCount}`,
    `shots ${row.shotCount}`,
    `avg ${averageSec.toFixed(1)} s`,
    `treatments ${braces(data.treatments)}`,
    `relations ${braces(data.relations)}`,
    `cost ${money(costs.totalUsd)} (${costs.basis}, unpriced ${costs.unpricedShots})`,
    `QA blocking ${blocking.length} ${braces(data.blockingKinds)} / warnings ${warnings.length} ${braces(data.warningKinds)}`,
    `normalizations ${content.normalization.length}`,
    `evidence traced ${ev.traced}/${ev.factualShots}`,
    `continuity subjects ${subjects.length} (requires reference: ${references})`,
    `narration takes ${approved}/${takes.length} approved`,
    `model calls ${calls.length}, $${spend.toFixed(4)} planning spend`,
    `project status ${row.project.status}${o.preview ? ' (unchanged)' : ''}`,
    ...(content.notes.length ? [`notes: ${content.notes.join(' | ')}`] : []),
  ].join(' · ');
  return { line, data };
}
