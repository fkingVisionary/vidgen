import {
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

export function toJobView(j: Job): JobView {
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
  // Vendor-reported cost when available, otherwise our estimate from usage × rates.
  const [row] = await db.$queryRaw<{ spent: string | null; calls: bigint; mock_calls: bigint }[]>`
    SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd))::text AS spent,
           COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE is_mock) AS mock_calls
      FROM provider_calls WHERE project_id = ${project.id}::uuid`;
  return {
    estimatedUsd: project.estimatedCostUsd ? project.estimatedCostUsd.toNumber() : null,
    actualUsd: row?.spent ? Number(row.spent) : 0,
    providerCalls: Number(row?.calls ?? 0),
    mockCalls: Number(row?.mock_calls ?? 0),
  };
}

export async function loadProjectDetail(
  db: Database,
  projects: ProjectService,
  idOrSlug: string,
): Promise<ProjectDetailView | null> {
  const project = await findProject(db, idOrSlug);
  if (!project) return null;

  const [languageVersions, jobs, approvals, events, costs, phaseJobsComplete, rt] = await Promise.all([
    db.languageVersion.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }),
    db.job.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.approval.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.projectEvent.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    costSummary(db, project),
    projects.phaseJobsComplete(db, project),
    runtimes(db, [project.id]),
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
  };
}
