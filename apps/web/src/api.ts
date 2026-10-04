import type {
  ApprovalInput,
  CreateProjectInput,
  EnqueueJobInput,
  HealthView,
  JobView,
  ProjectDetailView,
  ProjectSummaryView,
  RewindInput,
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
};
