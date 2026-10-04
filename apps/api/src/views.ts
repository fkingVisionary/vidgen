import {
  sumUsd,
  type CostBasis,
  computeProgress,
  deriveStages,
  getAvailableActions,
  type ApprovalView,
  type CostSummaryView,
  type JobView,
  type ProjectDetailView,
  type ProjectEventView,
  type ProjectSummaryView,
} from '@docengine/core';
import type { Approval, Database, Job, Project, ProjectEvent } from '@docengine/database';
import type { ProjectService } from '@docengine/pipeline';

/** Maps database rows to the JSON shapes in @docengine/core/views. */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findProject(db: Database, idOrSlug: string): Promise<Project | null> {
  return UUID.test(idOrSlug)
    ? db.project.findUnique({ where: { id: idOrSlug } })
    : db.project.findUnique({ where: { slug: idOrSlug } });
}

/** Job columns the API reads; `checkpoint` (a running job's saved progress, up to ~1 MB) is never sent or needed. */
export const JOB_VIEW_OMIT = { checkpoint: true } as const;

export function toJobView(j: Omit<Job, 'checkpoint'>): JobView {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    isMock: j.isMock,
    languageVersionId: j.languageVersionId,
    error: j.error,
    result: j.result,
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    completedAt: iso(j.completedAt),
  };
}

const toApprovalView = (a: Approval): ApprovalView => ({
  id: a.id,
  gate: a.gate,
  decision: a.decision,
  notes: a.notes,
  decidedBy: a.decidedBy,
  createdAt: a.createdAt.toISOString(),
});

const toEventView = (e: ProjectEvent): ProjectEventView => ({
  id: e.id,
  type: e.type,
  message: e.message,
  createdAt: e.createdAt.toISOString(),
});

function toSummary(p: Project, runtimeSec: number | null, phaseJobsComplete = false): ProjectSummaryView {
  const stages = deriveStages(p.status, { failedFrom: p.failedFromStatus, phaseJobsComplete });
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    workingTitle: p.workingTitle,
    topic: p.topic,
    category: p.category,
    status: p.status,
    progress: computeProgress(stages),
    targetMinutesMin: p.targetMinutesMin,
    targetMinutesMax: p.targetMinutesMax,
    runtimeSec,
    masterLanguage: p.masterLanguage,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function runtimes(db: Database, projectIds: string[]): Promise<Map<string, number>> {
  const renders = await db.render.findMany({
    where: { projectId: { in: projectIds }, status: 'SUCCEEDED', durationMs: { not: null } },
    orderBy: { completedAt: 'desc' },
    select: { projectId: true, durationMs: true },
  });
  const out = new Map<string, number>();
  for (const r of renders) if (!out.has(r.projectId)) out.set(r.projectId, Math.round(r.durationMs! / 1000));
  return out;
}

export async function listProjects(db: Database): Promise<ProjectSummaryView[]> {
  const projects = await db.project.findMany({ orderBy: { updatedAt: 'desc' } });
  const rt = await runtimes(db, projects.map((p) => p.id));
  return projects.map((p) => toSummary(p, rt.get(p.id) ?? null));
}

async function costSummary(db: Database, project: Project): Promise<CostSummaryView> {
  const rows = await db.$queryRaw<
    { provider: string; calls: bigint; failed: bigint; mock: bigint; unpriced: bigint; reported: string | null; estimated: string | null; bases: (string | null)[] }[]
  >`
    SELECT provider,
           COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
           COUNT(*) FILTER (WHERE is_mock) AS mock,
           COUNT(*) FILTER (WHERE cost_basis = 'UNPRICED') AS unpriced,
           SUM(actual_cost_usd)::text AS reported,
           SUM(estimated_cost_usd) FILTER (WHERE actual_cost_usd IS NULL)::text AS estimated,
           ARRAY_AGG(DISTINCT cost_basis::text) AS bases
      FROM provider_calls WHERE project_id = ${project.id}::uuid
     GROUP BY provider ORDER BY provider`;
  const num = (v: string | null) => (v ? Number(v) : 0);
  const byProvider = rows.map((r) => ({
    provider: r.provider,
    calls: Number(r.calls),
    totalUsd: sumUsd([num(r.reported), num(r.estimated)]),
    costBases: r.bases.filter((b): b is CostBasis => b !== null),
  }));
  const vendorReportedUsd = sumUsd(rows.map((r) => num(r.reported)));
  const estimatedUsd = sumUsd(rows.map((r) => num(r.estimated)));
  return {
    planningEstimateUsd: project.estimatedCostUsd ? project.estimatedCostUsd.toNumber() : null,
    totalUsd: sumUsd([vendorReportedUsd, estimatedUsd]),
    vendorReportedUsd,
    estimatedUsd,
    includesEstimates: rows.some((r) => r.bases.includes('ESTIMATED')),
    unpricedCalls: rows.reduce((n, r) => n + Number(r.unpriced), 0),
    providerCalls: rows.reduce((n, r) => n + Number(r.calls), 0),
    mockCalls: rows.reduce((n, r) => n + Number(r.mock), 0),
    failedCalls: rows.reduce((n, r) => n + Number(r.failed), 0),
    byProvider,
  };
}

export async function loadProjectDetail(
  db: Database,
  projects: ProjectService,
  idOrSlug: string,
): Promise<ProjectDetailView | null> {
  const project = await findProject(db, idOrSlug);
  if (!project) return null;

  const [languageVersions, jobs, approvals, events, costs, phaseJobsComplete, rt, latestDossier] = await Promise.all([
    db.languageVersion.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }),
    db.job.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50, omit: JOB_VIEW_OMIT }),
    db.approval.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.projectEvent.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    costSummary(db, project),
    projects.phaseJobsComplete(db, project),
    runtimes(db, [project.id]),
    db.researchDossier.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: { _count: { select: { claims: true } } } }),
  ]);

  const actions = getAvailableActions(project.status, { failedFrom: project.failedFromStatus });
  return {
    ...toSummary(project, rt.get(project.id) ?? null, phaseJobsComplete),
    description: project.description,
    style: project.style,
    failedFromStatus: project.failedFromStatus,
    stages: deriveStages(project.status, { failedFrom: project.failedFromStatus, phaseJobsComplete }),
    phaseJobsComplete,
    actions: { ...actions, canApprove: actions.gate !== null && phaseJobsComplete },
    languageVersions: languageVersions.map((lv) => ({
      id: lv.id,
      language: lv.language,
      isMaster: lv.language === project.masterLanguage,
      status: lv.status,
    })),
    jobs: jobs.map(toJobView),
    approvals: approvals.map(toApprovalView),
    events: events.map(toEventView),
    costs,
    research: latestDossier
      ? {
          id: latestDossier.id,
          version: latestDossier.version,
          status: latestDossier.status,
          qualityPassed: latestDossier.qualityPassed,
          claimCount: latestDossier._count.claims,
          createdAt: latestDossier.createdAt.toISOString(),
        }
      : null,
  };
}
