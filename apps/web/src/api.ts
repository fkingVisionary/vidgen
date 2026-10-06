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
  RefineScriptInput,
  NarrateScriptInput,
  ScriptEditorialView,
  WritingCorpusView,
  WritingExampleDecisionInput,
  WritingExampleView,
  ReviseScriptInput,
  RewindInput,
  ScriptCompareView,
  ScriptView,
  UpdateScriptBlockInput,
  VoiceRenderPlan,
  CreateVoiceProfileFamilyInput,
  CreateVoiceRunInput,
  DecideVoiceGenerationInput,
  DuplicateVoiceProfileInput,
  NewVoiceProfileVersionInput,
  PlanVoiceRunInput,
  RegenerateVoiceInput,
  SaveRunAsProfileInput,
  UpdatePronunciationInput,
  UpdateVoiceProfileFamilyInput,
  VoiceConfigOverrides,
  VoiceExperimentInput,
  VoiceMomentView,
  VoicePlanView,
  VoiceProductionView,
  VoiceProfileHistoryView,
  VoiceProfileLibraryView,
  VoiceSelectionInput,
  VoiceView,
  StoryJobInput,
  StoryView,
  UpdateContentOpportunityInput,
  UpdateStoryCandidateInput,
} from '@docengine/core';

/** Thin typed client for the same-origin API. Provider credentials never reach the browser. */

/** A voice the configured provider offers. */
export interface VoiceOption {
  id: string;
  name: string;
  language?: string;
  description?: string;
}

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
  refineScript: (id: string, input: RefineScriptInput) => request<JobView>('POST', `/api/projects/${id}/script/refine`, input),
  /** The Human Narration Pass on a version (Writing Engine 2): a new version, the base kept. */
  narrateScript: (id: string, input: NarrateScriptInput) => request<JobView>('POST', `/api/projects/${id}/script/narrate`, input),
  /** A version through the writing engine: its narration pass, diagnostics, change report against its base, semantic layers. */
  scriptEditorial: (id: string, version: number) => request<ScriptEditorialView>('GET', `/api/projects/${encodeURIComponent(id)}/script/versions/${version}/editorial`),
  /** The house-style corpus: style bible, rubric, AI-pattern glossary, examples, house candidates. */
  writingCorpus: () => request<WritingCorpusView>('GET', '/api/writing/corpus'),
  proposeHouseCandidates: (id: string, version: number) => request<{ proposed: number; created: number; corpus: WritingCorpusView }>('POST', `/api/projects/${id}/script/versions/${version}/house-candidates`, {}),
  decideWritingExample: (exampleId: string, input: WritingExampleDecisionInput) => request<WritingExampleView>('POST', `/api/writing/examples/${exampleId}/decision`, input),
  restoreScript: (id: string, version: number) => request<ScriptView>('POST', `/api/projects/${id}/script/restore`, { version }),
  compareScripts: (id: string, a: number, b: number) => request<ScriptCompareView>('GET', `/api/projects/${encodeURIComponent(id)}/script/compare?a=${a}&b=${b}`),
  voicePlan: (id: string, version?: number) => request<VoiceRenderPlan>('GET', `/api/projects/${encodeURIComponent(id)}/script/voice-plan${version ? `?version=${version}` : ''}`),
  updateScriptBlock: (blockId: string, input: UpdateScriptBlockInput) => request<ScriptView>('PATCH', `/api/script-blocks/${blockId}`, input),
  reorderScriptBlocks: (sectionId: string, blockIds: string[]) => request<ScriptView>('PUT', `/api/script-sections/${sectionId}/order`, { blockIds }),
  reviewScriptSection: (sectionId: string, input: ReviewScriptSectionInput) => request<ScriptView>('PATCH', `/api/script-sections/${sectionId}`, input),
  /** Narration: the Voice page's read model (?run=N selects a run). */
  voice: (id: string, run?: number) => request<VoiceView>('GET', `/api/projects/${encodeURIComponent(id)}/voice${run ? `?run=${run}` : ''}`),
  /** What a voice run would generate and cost (nothing is generated). */
  voiceRunPlan: (id: string, input: PlanVoiceRunInput) => request<VoicePlanView>('POST', `/api/projects/${id}/voice/plan`, input),
  createVoiceRun: (id: string, input: CreateVoiceRunInput) => request<{ job: JobView; run: number }>('POST', `/api/projects/${id}/voice/runs`, input),
  createVoiceExperiment: (id: string, input: VoiceExperimentInput) => request<{ job: JobView; runs: number[] }>('POST', `/api/projects/${id}/voice/experiments`, input),
  regenerateVoice: (runId: string, input: RegenerateVoiceInput) => request<{ job: JobView; takes: number }>('POST', `/api/voice/runs/${runId}/regenerate`, input),
  approveAllTakes: (runId: string) => request<{ approved: number; skipped: number }>('POST', `/api/voice/runs/${runId}/approve-all`),
  decideTake: (generationId: string, input: DecideVoiceGenerationInput) => request<{ runId: string }>('POST', `/api/voice/generations/${generationId}/decision`, input),
  updatePronunciation: (id: string, input: UpdatePronunciationInput) => request<{ ok: true }>('PATCH', `/api/voice/pronunciations/${id}`, input),
  /** The voices the configured provider offers (for a profile's voice). */
  voices: () => request<VoiceOption[]>('GET', '/api/voice/voices'),
  /** The saved voice profile library (global), with the configured provider's settings for forms; archived profiles too when asked. */
  voiceProfiles: (archived = false) => request<VoiceProfileLibraryView>('GET', `/api/voice/profiles${archived ? '?archived=true' : ''}`),
  /** A saved profile and every version, newest first. */
  voiceProfile: (familyId: string) => request<VoiceProfileHistoryView>('GET', `/api/voice/profiles/${familyId}`),
  /** A new saved profile (its v1). */
  createVoiceProfileFamily: (input: CreateVoiceProfileFamilyInput) => request<VoiceProfileHistoryView>('POST', '/api/voice/profiles', input),
  /** Rename, describe, archive or unarchive a profile, or make it the library default (its versions are not touched). */
  updateVoiceProfileFamily: (familyId: string, input: UpdateVoiceProfileFamilyInput) => request<VoiceProfileHistoryView>('PATCH', `/api/voice/profiles/${familyId}`, input),
  /** An edit: always a new version (runs and takes keep the version they used). */
  newVoiceProfileVersion: (familyId: string, input: NewVoiceProfileVersionInput) => request<VoiceProfileHistoryView>('POST', `/api/voice/profiles/${familyId}/versions`, input),
  duplicateVoiceProfile: (familyId: string, input: DuplicateVoiceProfileInput) => request<VoiceProfileHistoryView>('POST', `/api/voice/profiles/${familyId}/duplicate`, input),
  /** A run's configuration (or one of its takes') saved as a profile. */
  saveRunAsProfile: (runId: string, input: SaveRunAsProfileInput) =>
    request<{ profile: VoiceProfileHistoryView; production: VoiceProductionView | null; clearedOverrides: VoiceConfigOverrides | null }>('POST', `/api/voice/runs/${runId}/save-profile`, input),
  /** What a project's language version narrates with now (the master language by default). */
  voiceSelection: (id: string, language?: string) => request<VoiceProductionView>('GET', `/api/projects/${encodeURIComponent(id)}/voice/selection${language ? `?language=${encodeURIComponent(language)}` : ''}`),
  /** Choose the production profile and the project's overrides, at the revision shown (another revision is refused with 409). */
  setVoiceSelection: (id: string, input: VoiceSelectionInput) => request<VoiceProductionView>('PUT', `/api/projects/${id}/voice/selection`, input),
  voiceMoment: (id: string, run: number, at: string) => request<VoiceMomentView>('GET', `/api/projects/${encodeURIComponent(id)}/voice/moment?run=${run}&at=${encodeURIComponent(at)}`),
  /** What a content package request would contain (read only; nothing is generated). */
  contentPackage: (id: string, input: { documentary?: boolean; shorts?: number | 'all'; languages?: string[] }) => request<ContentPackageView>('POST', `/api/projects/${id}/content-package`, input),
};
