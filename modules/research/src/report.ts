import { CLAIM_VERDICTS, SOURCE_TYPES, SOURCE_TYPE_LABELS, type QualityReport } from '@docengine/core';
import type { Database } from '@docengine/database';

/**
 * Plain-text evidence report for a dossier: the numbers and examples a
 * producer needs to judge it, straight from the database (not from the model).
 */
export async function buildDossierReport(db: Database, dossierId: string): Promise<string> {
  const d = await db.researchDossier.findUniqueOrThrow({
    where: { id: dossierId },
    include: { claims: { orderBy: { sortOrder: 'asc' }, include: { citations: { include: { source: true } } } } },
  });
  const sources = await db.source.findMany({ where: { projectId: d.projectId } });
  const citedIds = new Set(d.claims.flatMap((c) => c.citations.map((x) => x.sourceId)));
  const cited = sources.filter((s) => citedIds.has(s.id));
  const report = d.qualityReport as QualityReport | null;
  const costs = d.jobId
    ? await db.$queryRaw<{ provider: string; calls: bigint; estimated: string | null; reported: string | null; unpriced: bigint }[]>`
        SELECT provider, COUNT(*) AS calls,
               SUM(estimated_cost_usd) FILTER (WHERE actual_cost_usd IS NULL)::text AS estimated,
               SUM(actual_cost_usd)::text AS reported,
               COUNT(*) FILTER (WHERE cost_basis = 'UNPRICED') AS unpriced
          FROM provider_calls WHERE job_id = ${d.jobId}::uuid GROUP BY provider ORDER BY provider`
    : [];

  const lines: string[] = [];
  const h = (t: string) => lines.push('', t, '─'.repeat(t.length));
  lines.push(`Research dossier v${d.version} — status ${d.status} — quality gate ${d.qualityPassed ? 'PASSED' : 'FAILED'}`);

  h('Sources');
  lines.push(`Considered: ${sources.length} · retrieved: ${sources.filter((s) => s.retrievalStatus === 'RETRIEVED').length} · failed: ${sources.filter((s) => s.retrievalStatus === 'FAILED').length} · duplicates: ${sources.filter((s) => s.duplicateOfId).length} · cited: ${cited.length}`);
  for (const t of SOURCE_TYPES) {
    const n = cited.filter((s) => s.sourceType === t).length;
    if (n) lines.push(`  ${SOURCE_TYPE_LABELS[t].padEnd(32)} ${String(n).padStart(3)}   e.g. ${cited.find((s) => s.sourceType === t)!.title.slice(0, 70)}`);
  }

  h('Claims');
  lines.push(`Total ${d.claims.length} (key ${d.claims.filter((c) => c.importance === 'KEY').length}); citations ${d.claims.reduce((n, c) => n + c.citations.length, 0)}`);
  for (const v of CLAIM_VERDICTS) lines.push(`  ${v.padEnd(12)} ${d.claims.filter((c) => c.verdict === v).length}`);

  for (const verdict of ['DISPUTED', 'MYTH'] as const) {
    const examples = d.claims.filter((c) => c.verdict === verdict).slice(0, 4);
    if (!examples.length) continue;
    h(`Example ${verdict.toLowerCase()} claims`);
    for (const c of examples) {
      lines.push(`[${c.claimKey}] ${c.statement}`);
      if (c.popularVersion) lines.push(`    commonly claimed: ${c.popularVersion}`);
      if (c.notes) lines.push(`    notes: ${c.notes}`);
      for (const x of c.citations.filter((x) => x.stance !== 'CONTEXT')) {
        lines.push(`    ${x.stance === 'SUPPORTS' ? '+' : '−'} ${x.source.sourceType} · ${x.source.title.slice(0, 60)}: "${(x.quote ?? '').slice(0, 160)}"`);
      }
    }
  }

  if (report) {
    h('Quality gate');
    for (const c of report.checks) lines.push(`  ${c.status.padEnd(4)} ${c.label} — ${c.detail}`);
  }

  h('Cost of this run');
  for (const c of costs) {
    const est = Number(c.estimated ?? 0);
    const rep = Number(c.reported ?? 0);
    lines.push(`  ${c.provider.padEnd(12)} ${String(c.calls).padStart(4)} calls   $${(est + rep).toFixed(4)}  (${rep ? `$${rep.toFixed(4)} vendor-reported, ` : ''}$${est.toFixed(4)} estimated${Number(c.unpriced) ? `, ${c.unpriced} unpriced call(s) not included` : ''})`);
  }
  return lines.join('\n');
}
