import type {
  ApprovalDecision,
  ApprovalGate,
  JobStatus,
  JobType,
  LanguageVersionStatus,
  ProjectStatus,
  ProviderKind,
} from './enums.ts';
import type { AvailableActions } from './pipeline.ts';
import type { StageView } from './stages.ts';

/**
 * Response shapes of the HTTP API (JSON-serialised: dates are ISO strings,
 * money is a plain number of USD). Shared so the dashboard is typed against
 * exactly what the API returns.
 */

export interface ProjectSummaryView {
  id: string;
  slug: string;
  title: string;
  workingTitle: string | null;
  topic: string;
  category: string | null;
  status: ProjectStatus;
  progress: number;
  targetMinutesMin: number;
  targetMinutesMax: number;
  /** Runtime of the latest successful render, if any. */
  runtimeSec: number | null;
  masterLanguage: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobView {
  id: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  isMock: boolean;
  languageVersionId: string | null;
  error: string | null;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ApprovalView {
  id: string;
  gate: ApprovalGate;
  decision: ApprovalDecision;
  notes: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface ProjectEventView {
  id: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface LanguageVersionView {
  id: string;
  language: string;
  isMaster: boolean;
  status: LanguageVersionStatus;
}

export interface CostSummaryView {
  /** Planning estimate for the whole episode, if one has been made. */
  estimatedUsd: number | null;
  /** Sum of recorded provider-call costs. */
  actualUsd: number;
  providerCalls: number;
  mockCalls: number;
}

export interface ProjectDetailView extends ProjectSummaryView {
  description: string | null;
  style: string | null;
  failedFromStatus: ProjectStatus | null;
  stages: StageView[];
  phaseJobsComplete: boolean;
  actions: AvailableActions & { canApprove: boolean };
  languageVersions: LanguageVersionView[];
  jobs: JobView[];
  approvals: ApprovalView[];
  events: ProjectEventView[];
  costs: CostSummaryView;
}

export interface ProviderStatusView {
  kind: ProviderKind;
  name: string;
  mock: boolean;
}

export interface HealthView {
  status: 'ok' | 'degraded';
  version: string;
  /** Git commit of the running deploy, when the platform provides it. */
  commit: string | null;
  environment: string;
  database: 'ok' | 'error';
  worker: 'embedded' | 'disabled';
  mockMode: boolean;
  providers: ProviderStatusView[];
}
