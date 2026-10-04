import type {
  ApprovalDecision,
  ApprovalGate,
  ArtifactStatus,
  CandidatePriority,
  CandidateStatus,
  CitationBasis,
  CitationStance,
  ClaimImportance,
  ClaimType,
  ClaimVerdict,
  ConfidenceLevel,
  CostBasis,
  HistoricalStatus,
  JobStatus,
  JobType,
  LanguageVersionStatus,
  ProjectStatus,
  ProviderKind,
  RetrievalStatus,
  SourceType,
  StoryType,
} from './enums.ts';
import type { QualityReport, ResearchDossierContent } from './contracts/research.ts';
import type { MythThread, StoryArchitectureContent, StoryCharacter, StoryPackContent, StoryScores } from './contracts/story.ts';
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
  planningEstimateUsd: number | null;
  /** Recorded spend: vendor-reported amounts where available, otherwise estimated from usage × list prices. */
  totalUsd: number;
  vendorReportedUsd: number;
  estimatedUsd: number;
  /** True when any part of totalUsd is an estimate rather than a vendor-reported amount. */
  includesEstimates: boolean;
  /** Calls whose usage had no configured price (their cost is missing from the totals). */
  unpricedCalls: number;
  providerCalls: number;
  mockCalls: number;
  failedCalls: number;
  byProvider: { provider: string; calls: number; totalUsd: number; costBases: CostBasis[] }[];
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
  /** Latest research dossier, if any. */
  research: DossierSummaryView | null;
  /** Latest story pack and architecture, if any. */
  story: StorySummaryView;
}

export interface DossierSummaryView {
  id: string;
  version: number;
  status: ArtifactStatus;
  qualityPassed: boolean | null;
  claimCount: number;
  createdAt: string;
}

export interface CitationView {
  id: string;
  sourceId: string;
  stance: CitationStance;
  basis: CitationBasis;
  quote: string | null;
  locator: string | null;
  quoteVerified: boolean;
}

export interface ClaimView {
  id: string;
  key: string;
  statement: string;
  claimType: ClaimType;
  /** Research question id the claim answers. */
  category: string | null;
  importance: ClaimImportance;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  popularVersion: string | null;
  notes: string | null;
  needsVerification: boolean;
  citations: CitationView[];
}

export interface SourceView {
  id: string;
  title: string;
  url: string | null;
  domain: string | null;
  sourceType: SourceType;
  author: string | null;
  publisher: string | null;
  publishedDate: string | null;
  reliability: ConfidenceLevel | null;
  reliabilityNotes: string | null;
  summary: string | null;
  citation: string;
  retrievalStatus: RetrievalStatus;
  retrievalError: string | null;
  duplicateOfId: string | null;
  /** Citations to this source in the dossier being viewed. */
  citationCount: number;
}

export interface DossierView extends DossierSummaryView {
  summary: string | null;
  content: ResearchDossierContent;
  qualityReport: QualityReport | null;
  stats: Record<string, unknown>;
  claims: ClaimView[];
  /** Every source considered for the project: retrieved, failed and duplicates. */
  sources: SourceView[];
  /** Provider spend of the job that produced this version. */
  cost: ArtifactCostView;
}

export interface ResearchView {
  versions: DossierSummaryView[];
  dossier: DossierView | null;
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

/** Provider spend of the job that produced an artifact version. */
export interface ArtifactCostView {
  totalUsd: number;
  includesEstimates: boolean;
  calls: number;
}

export interface StoryPackSummaryView {
  id: string;
  version: number;
  status: ArtifactStatus;
  qualityPassed: boolean | null;
  candidateCount: number;
  selectedCount: number;
  createdAt: string;
}

export interface StoryArchitectureSummaryView {
  id: string;
  version: number;
  status: ArtifactStatus;
  qualityPassed: boolean | null;
  packVersion: number | null;
  sequenceCount: number;
  estimatedDurationSec: number | null;
  targetDurationSec: number | null;
  createdAt: string;
}

export interface StorySummaryView {
  pack: StoryPackSummaryView | null;
  architecture: StoryArchitectureSummaryView | null;
}

export interface StoryCandidateView {
  id: string;
  key: string;
  title: string;
  hook: string;
  storyType: StoryType;
  characters: StoryCharacter[];
  setting: string;
  timePeriod: string;
  desire: string;
  conflict: string;
  stakes: string;
  escalation: string;
  turningPoint: string;
  payoff: string;
  whyInteresting: string;
  viewerQuestion: string;
  mythThread: MythThread | null;
  /** Null only if stored scores fail validation. */
  scores: StoryScores | null;
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  rankScore: number;
  rank: number;
  notes: string | null;
  aiSelected: boolean;
  aiSelectionReason: string | null;
  status: CandidateStatus;
  selected: boolean;
  priority: CandidatePriority;
  editorNotes: string | null;
  claimKeys: string[];
  /** Retrieved sources cited by those claims. */
  sourceIds: string[];
  updatedAt: string;
}

/** Dossier evidence referenced by a story artifact: the claims it cites and their sources. */
export interface StoryEvidenceView {
  claims: ClaimView[];
  sources: StorySourceView[];
}

export interface StoryPackView extends StoryPackSummaryView {
  dossierId: string;
  dossierVersion: number;
  content: StoryPackContent;
  qualityReport: QualityReport | null;
  stats: Record<string, unknown>;
  notes: string | null;
  cost: ArtifactCostView;
  candidates: StoryCandidateView[];
  evidence: StoryEvidenceView;
}

export interface StoryArchitectureView extends StoryArchitectureSummaryView {
  packId: string | null;
  dossierVersion: number | null;
  /** Null only if the stored content fails validation. */
  content: StoryArchitectureContent | null;
  qualityReport: QualityReport | null;
  stats: Record<string, unknown>;
  notes: string | null;
  cost: ArtifactCostView;
  approvals: ApprovalView[];
  evidence: StoryEvidenceView;
}

/** A source as the story views show it. */
export interface StorySourceView {
  id: string;
  title: string;
  url: string | null;
  domain: string | null;
  sourceType: SourceType;
  author: string | null;
  publishedDate: string | null;
}

export interface StoryView {
  packs: StoryPackSummaryView[];
  pack: StoryPackView | null;
  architectures: StoryArchitectureSummaryView[];
  architecture: StoryArchitectureView | null;
  /** True while the editor can change candidates (project in STORY_SELECTION, viewing the current pack). */
  editable: boolean;
  /** The shown pack's current selection (selected and not rejected) against the 5–10 limit. */
  selection: { count: number; min: number; max: number; problem: string | null };
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
  /** Pipeline stages backed by real implementations; the rest are MOCK placeholders. */
  realStages: JobType[];
}
