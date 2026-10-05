import type {
  ApprovalDecision,
  CastKind,
  ScriptBlockClass,
  ScriptOrigin,
  ScriptScore,
  SectionReviewStatus,
  ApprovalGate,
  ArchitectureOrigin,
  ArtifactStatus,
  CandidatePriority,
  CandidateStatus,
  CitationBasis,
  CitationStance,
  ClaimImportance,
  ClaimType,
  ClaimVerdict,
  ConfidenceLevel,
  ContentFormat,
  CostBasis,
  HistoricalStatus,
  NarrativeMode,
  OpportunityStatus,
  ReconstructionLevel,
  StoryEngineVersion,
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
import type {
  AnyStoryArchitectureContent,
  AnyStoryScores,
  CandidateOverrides,
  ContentOpportunityContent,
  HumanStakes,
  MythThread,
  PovChoice,
  StoryCharacter,
  StoryDesign,
  StoryExplorationContent,
  StoryPackContent,
} from './contracts/story.ts';
import type { ScriptAssessmentItem, ScriptBlockContent, ScriptChangeLog, ScriptContent, ScriptSectionPlan } from './contracts/script.ts';
import type { AvailableActions } from './pipeline.ts';
import type { ScriptTiming } from './script.ts';
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
  /** Latest script version, if any. */
  script: ScriptSummaryView | null;
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
  engineVersion: StoryEngineVersion;
  status: ArtifactStatus;
  qualityPassed: boolean | null;
  candidateCount: number;
  selectedCount: number;
  createdAt: string;
}

export interface StoryArchitectureSummaryView {
  id: string;
  version: number;
  engineVersion: StoryEngineVersion;
  /** Built from the selection, or a revision of an earlier version (which is kept). */
  origin: ArchitectureOrigin;
  revisionOfVersion: number | null;
  /** The explored angle it was built on or revised toward. */
  angle: { explorationVersion: number; key: string; title: string } | null;
  /** Content opportunities identified in this architecture (engine 2). */
  opportunities: { shorts: number; longForm: number; approved: number };
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

/** A content opportunity found in an architecture: a structured brief, never a script or a video. */
export interface ContentOpportunityView {
  id: string;
  key: string;
  architectureId: string;
  architectureVersion: number;
  format: ContentFormat;
  status: OpportunityStatus;
  /** Rank among SHORT and BOTH opportunities by short-form potential (1 = best); null for LONG_FORM. */
  rank: number | null;
  /** SHORT-FORM POTENTIAL, 0–10. */
  shortScore: number | null;
  title: string;
  hook: string;
  centralQuestion: string;
  targetDurationSec: number | null;
  independent: boolean;
  requiresContext: boolean;
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  content: ContentOpportunityContent | null;
  /** Ids of the approved dossier's claims it rests on (research_claims.id). */
  claimIds: string[];
  editorNotes: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Approved by the editor and built on an approved architecture: usable by a future production request. */
  eligible: boolean;
  createdAt: string;
}

/**
 * What a content package request would contain today: the approved long-form
 * documentary and the top approved short opportunities. Nothing is generated.
 */
export interface ContentPackageView {
  projectId: string;
  request: { documentary: boolean; shorts: number | 'all'; languages: string[] };
  architecture: { id: string; version: number; status: ArtifactStatus; logline: string | null; centralQuestion: string | null; estimatedDurationSec: number | null } | null;
  documentary: { included: boolean; eligible: boolean; reason: string | null };
  shorts: { requested: number | 'all'; available: number; returned: number; items: ContentOpportunityView[] };
  longForm: ContentOpportunityView[];
  languages: { requested: string[]; note: string };
  /** Always false: production (scripts, voice, video, captions, renders, exports) is not built. */
  generated: false;
  notes: string[];
}

export interface StoryCandidateView {
  id: string;
  key: string;
  /** Engine of the pack the candidate belongs to. */
  engineVersion: StoryEngineVersion;
  /** The editor's title if set, otherwise the AI's. */
  title: string;
  aiTitle: string;
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
  /** Null only if stored scores fail validation. Engine 1: 8 appeal components; engine 2: story and historical value. */
  scores: AnyStoryScores | null;
  /** Engine 2: STORY VALUE and HISTORICAL VALUE (0–10); rankScore is then STORY APPEAL. */
  storyValue: number | null;
  historicalValue: number | null;
  /** Engine 2 fields: effective values (the editor's override, else the AI's) and the AI's originals. */
  narrativeMode: NarrativeMode | null;
  aiNarrativeMode: NarrativeMode | null;
  centralQuestion: string | null;
  aiCentralQuestion: string | null;
  povStrategy: PovChoice | null;
  aiPovStrategy: PovChoice | null;
  humanStakes: HumanStakes | null;
  storyDesign: StoryDesign | null;
  reconstructionLevel: ReconstructionLevel | null;
  editorOverrides: CandidateOverrides;
  /** Position in the editor's order of the selection, if set. */
  selectionOrder: number | null;
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
  /** Null only if the stored content fails validation. Engine 2 content has engineVersion 2. */
  content: AnyStoryArchitectureContent | null;
  /** Content opportunities identified in this architecture, ranked (shorts first). */
  opportunityList: ContentOpportunityView[];
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

/** One exploration of alternative angles (a STORY_ANGLES job). */
export interface StoryExplorationSummaryView {
  id: string;
  version: number;
  packVersion: number;
  /** Explored as alternatives to this architecture version. */
  basedOnVersion: number | null;
  angleCount: number;
  qualityPassed: boolean;
  createdAt: string;
}

export interface StoryExplorationView extends StoryExplorationSummaryView {
  content: StoryExplorationContent | null;
  qualityReport: QualityReport | null;
  notes: string | null;
  stats: Record<string, unknown>;
  cost: ArtifactCostView;
  /** The units the angles could use differ from what a new architecture would use now (the selection changed). */
  poolChanged: boolean;
  /** Architecture versions built on (or revised toward) an angle of this exploration. */
  developed: { key: string; architectureVersion: number }[];
  evidence: StoryEvidenceView;
}

/** What the editor can do with the architecture now, and why not. */
export interface StoryEditorialActions {
  revise: { allowed: boolean; reason: string | null };
  angles: { allowed: boolean; reason: string | null };
  /** Units a revision or an angle may use: the selection, then units the editor approved but did not select. */
  poolKeys: string[];
  reserveKeys: string[];
}

export interface StoryView {
  packs: StoryPackSummaryView[];
  pack: StoryPackView | null;
  architectures: StoryArchitectureSummaryView[];
  architecture: StoryArchitectureView | null;
  explorations: StoryExplorationSummaryView[];
  exploration: StoryExplorationView | null;
  editorial: StoryEditorialActions;
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

// ---------------------------------------------------------------------------
// Script Engine
// ---------------------------------------------------------------------------

export interface ScriptSummaryView {
  id: string;
  version: number;
  status: ArtifactStatus;
  origin: ScriptOrigin;
  revisionOfVersion: number | null;
  /** Sections written for this version (the rest copied unchanged from the base). */
  sectionsWritten: number[];
  architectureVersion: number | null;
  qualityPassed: boolean;
  wordCount: number;
  estimatedDurationSec: number;
  targetDurationSec: number | null;
  createdAt: string;
}

export interface ScriptBlockView extends ScriptBlockContent {
  id: string;
  /** The text as generated for this version (kept when the editor changes it). */
  generatedText: string;
  editedBy: string | null;
  editedAt: string | null;
}

export interface ScriptSectionView {
  id: string;
  key: string;
  sequenceNumber: number | null;
  title: string;
  plan: ScriptSectionPlan | null;
  reviewStatus: SectionReviewStatus;
  editorNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** The architecture's estimate for the sequence. */
  targetDurationSec: number | null;
  estimatedDurationSec: number;
  wordCount: number;
  blocks: ScriptBlockView[];
}

export interface ScriptVersionView extends ScriptSummaryView {
  content: ScriptContent | null;
  sections: ScriptSectionView[];
  timing: ScriptTiming;
  qualityReport: QualityReport | null;
  /** Blocking findings that stop approval (FAIL checks), as the gate last computed them. */
  blocking: string[];
  stats: Record<string, unknown>;
  notes: string | null;
  cost: ArtifactCostView;
  approvals: ApprovalView[];
  evidence: StoryEvidenceView;
  /** Cast of the architecture (names and kinds), for speakers and fiction labels. */
  cast: { id: string; name: string; kind: CastKind }[];
  voice: { provider: string; characters: number; segments: number; pendingPronunciations: number };
}

/** What the editor can do with the script now, and why not. */
export interface ScriptEditorialActions {
  generate: { allowed: boolean; reason: string | null };
  revise: { allowed: boolean; reason: string | null };
  /** Refine the shown version's narration (the whole script, story and evidence unchanged). */
  refine: { allowed: boolean; reason: string | null };
  /** Edit blocks and review sections of the shown version. */
  edit: { allowed: boolean; reason: string | null };
  approve: { allowed: boolean; reason: string | null };
  restore: { allowed: boolean; reason: string | null };
}

export interface ScriptView {
  scripts: ScriptSummaryView[];
  script: ScriptVersionView | null;
  /** The approved architecture a new draft would tell. */
  architecture: { id: string; version: number; status: ArtifactStatus; engineVersion: StoryEngineVersion; logline: string | null; centralQuestion: string | null; estimatedDurationSec: number | null } | null;
  editorial: ScriptEditorialActions;
  /** False when SCRIPT is a MOCK stage here (no AI configured). */
  realStage: boolean;
}

/** What a version is like, for comparing it with another. */
export interface ScriptVersionFacts {
  /** The gate as last computed: passed, and the ids of its FAIL and WARN checks. */
  gate: { passed: boolean; failed: string[]; warned: string[] };
  /** The job that wrote it (none for a restored copy). */
  cost: ArtifactCostView;
  /** The script editor's scores (0–10). */
  scores: Partial<Record<ScriptScore, number>>;
  /** Spoken words by information class. */
  classWords: Partial<Record<ScriptBlockClass, number>>;
  blocks: number;
}

export interface ScriptCompareView {
  a: ScriptSummaryView;
  b: ScriptSummaryView;
  facts: { a: ScriptVersionFacts; b: ScriptVersionFacts };
  sections: {
    sequenceNumber: number | null;
    title: string;
    changed: boolean;
    durationSec: { a: number; b: number };
    /** Spoken words in each version, and how many were removed from a and added in b (word-level diff). */
    words: { a: number; b: number; removed: number; added: number };
    /** Block texts compared in order: unchanged, removed (only in a) or added (only in b). */
    diff: { op: 'same' | 'removed' | 'added'; text: string; infoClass: ScriptBlockClass }[];
  }[];
  totals: { wordsA: number; wordsB: number; durationA: number; durationB: number; sectionsChanged: number; wordsRemoved: number; wordsAdded: number };
  /** What b changed and why (its writer's change log, with the lines a refinement kept). */
  changeLog: ScriptChangeLog | null;
  /** b's refinement checklist, answered by its script editor against the version it refined. */
  assessment: ScriptAssessmentItem[];
  /** Evidence from a to b: claims cited and figures said, added or dropped (a refinement should change neither). */
  evidence: { claimsAdded: string[]; claimsRemoved: string[]; figuresAdded: string[]; figuresRemoved: string[] };
}
