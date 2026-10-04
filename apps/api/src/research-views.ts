import {
  QualityReport,
  ResearchDossierContent,
  type ArtifactCostView,
  type ClaimView,
  type DossierSummaryView,
  type DossierView,
  type ResearchView,
} from '@docengine/core';
import type { Database } from '@docengine/database';
import { sumUsd } from '@docengine/core';

/** Read model for the research dossier viewer. */
export async function loadResearchView(db: Database, projectId: string, version?: number): Promise<ResearchView | null> {
  const dossiers = await db.researchDossier.findMany({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: { _count: { select: { claims: true } } },
  });
  const versions: DossierSummaryView[] = dossiers.map((d) => ({
    id: d.id,
    version: d.version,
    status: d.status,
    qualityPassed: d.qualityPassed,
    claimCount: d._count.claims,
    createdAt: d.createdAt.toISOString(),
  }));
  const chosen = version === undefined ? dossiers[0] : dossiers.find((d) => d.version === version);
  if (version !== undefined && !chosen) return null;
  if (!chosen) return { versions, dossier: null };

  const [claims, sources, cost] = await Promise.all([
    db.researchClaim.findMany({ where: { dossierId: chosen.id }, orderBy: { sortOrder: 'asc' }, include: { citations: true } }),
    db.source.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    jobCost(db, chosen.jobId),
  ]);

  const citationCount = new Map<string, number>();
  for (const c of claims) for (const cit of c.citations) citationCount.set(cit.sourceId, (citationCount.get(cit.sourceId) ?? 0) + 1);
  const content = ResearchDossierContent.safeParse(chosen.content);
  const report = QualityReport.safeParse(chosen.qualityReport);

  const dossier: DossierView = {
    ...versions.find((v) => v.id === chosen.id)!,
    summary: chosen.summary,
    content: content.success ? content.data : emptyContent(),
    qualityReport: report.success ? report.data : null,
    stats: (chosen.stats ?? {}) as Record<string, unknown>,
    claims: claims.map(toClaimView),
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      domain: s.domain,
      sourceType: s.sourceType,
      author: s.author,
      publisher: s.publisher,
      publishedDate: s.publishedDate,
      reliability: s.reliability,
      reliabilityNotes: s.reliabilityNotes,
      summary: s.notes,
      citation: s.citation,
      retrievalStatus: s.retrievalStatus,
      retrievalError: s.retrievalError,
      duplicateOfId: s.duplicateOfId,
      citationCount: citationCount.get(s.id) ?? 0,
    })),
    cost,
  };
  return { versions, dossier };
}

type ClaimRow = Awaited<ReturnType<Database['researchClaim']['findMany']>>[number] & {
  citations: Awaited<ReturnType<Database['claimCitation']['findMany']>>;
};

export function toClaimView(c: ClaimRow): ClaimView {
  return {
    id: c.id,
    key: c.claimKey,
    statement: c.statement,
    claimType: c.claimType,
    category: c.category,
    importance: c.importance,
    verdict: c.verdict,
    confidence: c.confidence,
    popularVersion: c.popularVersion,
    notes: c.notes,
    needsVerification: c.needsVerification,
    citations: c.citations.map((x) => ({
      id: x.id,
      sourceId: x.sourceId,
      stance: x.stance,
      basis: x.basis,
      quote: x.quote,
      locator: x.locator,
      quoteVerified: x.quoteVerified,
    })),
  };
}

/** Provider spend of the job that produced an artifact version. */
export async function jobCost(db: Database, jobId: string | null): Promise<ArtifactCostView> {
  if (!jobId) return { totalUsd: 0, includesEstimates: false, calls: 0 };
  const [row] = await db.$queryRaw<{ total: string | null; estimated: bigint; calls: bigint }[]>`
    SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd))::text AS total,
           COUNT(*) FILTER (WHERE cost_basis = 'ESTIMATED') AS estimated,
           COUNT(*) AS calls
      FROM provider_calls WHERE job_id = ${jobId}::uuid`;
  return {
    totalUsd: sumUsd([row?.total ? Number(row.total) : 0]),
    includesEstimates: Number(row?.estimated ?? 0) > 0,
    calls: Number(row?.calls ?? 0),
  };
}

function emptyContent(): ResearchDossierContent {
  return {
    questions: [],
    timeline: [],
    keyFigures: [],
    priceEvidence: [],
    myths: [],
    interpretations: [],
    bubbleAssessment: { summary: '', argumentsFor: [], argumentsAgainst: [], claimKeys: [] },
    narrativeHistory: { summary: '', milestones: [], claimKeys: [] },
    openQuestions: [],
    missingEvidence: [],
  };
}
