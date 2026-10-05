import type {
  ApprovalInput,
  ContentOpportunityView,
  ContentPackageView,
  CreateProjectInput,
  EnqueueJobInput,
  ExploreAnglesInput,
  GenerateScriptInput,
  HealthView,
  JobView,
  ProjectDetailView,
  ProjectSummaryView,
  ResearchView,
  ReviseArchitectureInput,
  ReviewScriptSectionInput,
  ReviseScriptInput,
  RewindInput,
  ScriptCompareView,
  ScriptView,
  UpdateScriptBlockInput,
  VoiceRenderPlan,
  StoryJobInput,
  StoryView,
  UpdateContentOpportunityInput,
  UpdateStoryCandidateInput,
} from '@docengine/core';

/** Thin typed client for the same-origin API. Provider credentials never reach the browser. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const issues = data?.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ');
    throw new ApiError(res.status, issues ? `${data.message} — ${issues}` : (data?.message ?? `HTTP ${res.status}`));
  }
  return data as T;
}

export const api = {
  health: () => request<HealthView>('GET', '/api/health'),
  projects: () => request<ProjectSummaryView[]>('GET', '/api/projects'),
  project: (id: string) => request<ProjectDetailView>('GET', `/api/projects/${encodeURIComponent(id)}`),
  createProject: (input: CreateProjectInput) => request<ProjectDetailView>('POST', '/api/projects', input),
  enqueueJob: (id: string, input: EnqueueJobInput) => request<JobView>('POST', `/api/projects/${id}/jobs`, input),
  approve: (id: string, input: ApprovalInput) => request<ProjectDetailView>('POST', `/api/projects/${id}/approvals`, input),
  rewind: (id: string, input: RewindInput) => request<ProjectDetailView>('POST', `/api/projects/${id}/rewind`, input),
  retryJob: (jobId: string) => request<JobView>('POST', `/api/jobs/${jobId}/retry`),
  research: (id: string, version?: number) =>
    request<ResearchView>('GET', `/api/projects/${encodeURIComponent(id)}/research${version ? `?version=${version}` : ''}`),
  story: (id: string, v: { pack?: number; architecture?: number; exploration?: number } = {}) => {
    const q = new URLSearchParams();
    if (v.pack) q.set('pack', String(v.pack));
    if (v.architecture) q.set('architecture', String(v.architecture));
    if (v.exploration) q.set('exploration', String(v.exploration));
    return request<StoryView>('GET', `/api/projects/${encodeURIComponent(id)}/story${q.size ? `?${q}` : ''}`);
  },
  updateCandidate: (candidateId: string, input: UpdateStoryCandidateInput) => request<StoryView>('PATCH', `/api/story-candidates/${candidateId}`, input),
  mineStory: (id: string, notes?: string) => request<JobView>('POST', `/api/projects/${id}/story/mine`, notes ? { notes } : {}),
  buildArchitecture: (id: string, input: StoryJobInput = {}) => request<JobView>('POST', `/api/projects/${id}/story/architecture`, input),
  /** Reconsider an architecture version: a new version is built from the editor's brief; every version is kept. */
  reviseArchitecture: (id: string, input: Omit<ReviseArchitectureInput, 'aspects'> & { aspects?: ReviseArchitectureInput['aspects'] }) =>
    request<JobView>('POST', `/api/projects/${id}/story/architecture/revise`, input),
  /** Explore 2–3 alternative angles from the story pack (nothing is committed). */
  exploreAngles: (id: string, input: Partial<ExploreAnglesInput>) => request<JobView>('POST', `/api/projects/${id}/story/angles`, input),
  reorderSelection: (id: string, candidateIds: string[]) => request<StoryView>('PUT', `/api/projects/${id}/story/selection-order`, { candidateIds }),
  updateOpportunity: (opportunityId: string, input: UpdateContentOpportunityInput) => request<ContentOpportunityView>('PATCH', `/api/content-opportunities/${opportunityId}`, input),
  script: (id: string, version?: number) => request<ScriptView>('GET', `/api/projects/${encodeURIComponent(id)}/script${version ? `?version=${version}` : ''}`),
  /** Write a script draft from the approved architecture. */
  generateScript: (id: string, input: GenerateScriptInput = {}) => request<JobView>('POST', `/api/projects/${id}/script`, input),
  /** Rewrite chosen sections (or the whole script) of a version from a brief: a new version, every version kept. */
  reviseScript: (id: string, input: ReviseScriptInput) => request<JobView>('POST', `/api/projects/${id}/script/revise`, input),
  restoreScript: (id: string, version: number) => request<ScriptView>('POST', `/api/projects/${id}/script/restore`, { version }),
  compareScripts: (id: string, a: number, b: number) => request<ScriptCompareView>('GET', `/api/projects/${encodeURIComponent(id)}/script/compare?a=${a}&b=${b}`),
  voicePlan: (id: string, version?: number) => request<VoiceRenderPlan>('GET', `/api/projects/${encodeURIComponent(id)}/script/voice-plan${version ? `?version=${version}` : ''}`),
  updateScriptBlock: (blockId: string, input: UpdateScriptBlockInput) => request<ScriptView>('PATCH', `/api/script-blocks/${blockId}`, input),
  reorderScriptBlocks: (sectionId: string, blockIds: string[]) => request<ScriptView>('PUT', `/api/script-sections/${sectionId}/order`, { blockIds }),
  reviewScriptSection: (sectionId: string, input: ReviewScriptSectionInput) => request<ScriptView>('PATCH', `/api/script-sections/${sectionId}`, input),
  /** What a content package request would contain (read only; nothing is generated). */
  contentPackage: (id: string, input: { documentary?: boolean; shorts?: number | 'all'; languages?: string[] }) => request<ContentPackageView>('POST', `/api/projects/${id}/content-package`, input),
};
