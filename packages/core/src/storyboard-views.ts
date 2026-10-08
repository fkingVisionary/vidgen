import type {
  ArtifactStatus,
  BeatFunction,
  CastKind,
  ClaimVerdict,
  ConfidenceLevel,
  ContinuityKind,
  CutPointKind,
  InformationClass,
  NarrationApproval,
  Presentation,
  ProductionMethod,
  ScriptBlockClass,
  ShotClaimRole,
  ShotReviewState,
  StoryboardDecisionKind,
  StoryboardOrigin,
  StoryboardScope,
  StoryboardStatus,
  TimingRelation,
  VisualApproach,
  VisualCostBasis,
  VisualTreatment,
  VoiceGenerationStatus,
  VoiceRunKind,
} from './enums.ts';
import type {
  ApproachSummary,
  AssetRequirement,
  ContinuitySpec,
  CostAlternative,
  CostRollup,
  RhythmStats,
  ShotEvidence,
  ShotSpec,
  ShotSubjectDetail,
  ShotTiming,
  StoryboardInputs,
  StoryboardQaFinding,
  StoryboardScopeInfo,
  VersionChanges,
  VisualBeatContent,
  VisualCostEstimate,
} from './contracts/storyboard.ts';
import type { VisualPricing } from './contracts/visual-catalog.ts';
import type { VisualConfigOverrides, VisualConfigProvenance, VisualProfileOrigin, VisualSelectionMode, VisualStyleProfileConfig } from './contracts/visual-profile.ts';
import type { JobView } from './views.ts';

/** Read models of the Storyboard Engine, as the API returns them. Every cost here is a forecast, never spend. */

/** "Allowed, or why not", for an action on the page. */
export interface EditorialAction {
  allowed: boolean;
  reason: string | null;
}

/** A version in a list (and the project page's storyboard card). */
export interface StoryboardSummaryView {
  id: string;
  version: number;
  status: StoryboardStatus;
  scope: StoryboardScope;
  origin: StoryboardOrigin;
  baseVersion: number | null;
  approach: VisualApproach;
  /** The narration clock it covers (the assembly's real duration). */
  runtimeMs: number | null;
  beatCount: number;
  shotCount: number;
  /** The priced part of the forecast; always read with unpricedShotCount. */
  estimatedCostUsd: number | null;
  costBasis: VisualCostBasis | 'MIXED' | null;
  unpricedShotCount: number;
  /** QA as saved (the live QA is on the version view). */
  qaPassed: boolean;
  blocking: number;
  warnings: number;
  narration: { runId: string; runNumber: number; runKind: VoiceRunKind; assemblyId: string; assemblyVersion: number; approval: NarrationApproval };
  /** A STALE_* finding applies now (derived on read, never stored). */
  stale: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A cut point of the pinned narration: where a cut may fall, for "Move cut" and the timeline. */
export interface CutPointView {
  id: string;
  kind: CutPointKind;
  blockKey: string | null;
  /** The default cut time (the middle of its silence). */
  atMs: number;
  silence: { startMs: number; endMs: number };
  /** Inside a sentence: a cut here needs a reason. */
  midSentence: boolean;
}

/** The narration lane of the timeline: blocks, silences and the takes heard. */
export interface NarrationLaneView {
  totalDurationMs: number;
  blocks: { id: string; key: string; sectionKey: string; infoClass: ScriptBlockClass; startMs: number; endMs: number; text: string }[];
  silences: { startMs: number; endMs: number }[];
  takes: { generationId: string; chunkIndex: number; status: VoiceGenerationStatus; startMs: number; endMs: number; audioUrl: string | null }[];
}

/** A claim as a storyboard shows it, with its verdict now and when the version was saved. */
export interface StoryboardClaimView {
  claimId: string;
  key: string;
  statement: string;
  role: ShotClaimRole | null;
  verdict: ClaimVerdict;
  /** The verdict when the version was saved, where it differs (STALE_VERDICT). */
  savedVerdict: ClaimVerdict | null;
  confidence: ConfidenceLevel;
  presentation: Presentation | null;
  /** Retrieved sources with a verified quote. */
  sourceIds: string[];
}

/** "Why is this visual here?": shot → visual beat → narration → script block → architecture → claims → sources. */
export interface WhyChainView {
  /** Treatment null: a placeholder shot (SHOT_UNPLANNED). */
  shot: { key: string; purpose: string; treatment: VisualTreatment | null; depiction: ShotSpec['depiction']; infoClass: ScriptBlockClass | null };
  beat: { key: string; title: string; purpose: string; concept: string };
  narration: { text: string; startMs: number | null; endMs: number | null };
  blocks: { id: string; key: string; infoClass: ScriptBlockClass; text: string; beatIds: string[] }[];
  architecture: {
    beats: { id: string; function: BeatFunction; basis: InformationClass; description: string }[];
    sequence: {
      number: number;
      title: string;
      setting: { location: { value: string; basis: string }; date: { value: string; basis: string }; timeOfDay: { value: string; basis: string } };
    } | null;
  };
  claims: StoryboardClaimView[];
  sources: { id: string; title: string; url: string | null; quote: string | null }[];
}

/** A person's decision on a version or a shot. */
export interface StoryboardDecisionView {
  id: string;
  shotKey: string | null;
  decision: StoryboardDecisionKind;
  note: string | null;
  decidedBy: string | null;
  /** A copy of a decision on identical content in an earlier version ("carried from vN"), never a new approval. */
  carriedFromVersion: number | null;
  /** The gate approval it was recorded with, if any. */
  approvalId: string | null;
  createdAt: string;
}

export interface ShotView {
  id: string;
  key: string;
  beatKey: string;
  sortOrder: number;
  /** The section (scene) where it starts. */
  sectionKey: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  relation: TimingRelation;
  timing: ShotTiming;
  /** Readable anchor ("1.3:4–1.4:end"). */
  narrationAnchor: string | null;
  /** The words the shot supports. */
  narration: { text: string; blocks: { blockId: string; blockKey: string; startMs: number; endMs: number; firstWord: number; lastWord: number }[] };
  /**
   * A placeholder for a beat whose plan could not be made valid (SHOT_UNPLANNED): it covers the beat's words
   * with no content, so its treatment, method, class, evidence, asset requirement and cost are null.
   */
  unplanned: boolean;
  treatment: VisualTreatment | null;
  method: ProductionMethod | null;
  infoClass: ScriptBlockClass | null;
  spec: ShotSpec;
  subjects: { subjectKey: string; name: string; kind: ContinuityKind; castKind: CastKind | null; detail: ShotSubjectDetail }[];
  claims: StoryboardClaimView[];
  evidence: ShotEvidence | null;
  assetRequirement: AssetRequirement | null;
  cost: VisualCostEstimate | null;
  /** The latest decision on this shot in this version (null: none). */
  decision: StoryboardDecisionView | null;
  review: ShotReviewState;
  why: WhyChainView;
  /** Live findings with this shot's key as their ref. */
  findings: StoryboardQaFinding[];
  contentHash: string;
}

export interface VisualBeatView {
  id: string;
  key: string;
  sortOrder: number;
  sectionKey: string;
  sequenceNumber: number | null;
  archBeatIds: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
  treatment: VisualTreatment;
  infoClass: ScriptBlockClass;
  content: VisualBeatContent;
  blocks: { blockId: string; blockKey: string; startMs: number; endMs: number; firstWord: number; lastWord: number }[];
  claims: StoryboardClaimView[];
  shotKeys: string[];
}

/** A recurring subject and where it appears. */
export interface ContinuitySubjectView {
  id: string;
  key: string;
  kind: ContinuityKind;
  castId: string | null;
  name: string;
  infoClass: ScriptBlockClass;
  spec: ContinuitySpec;
  appearances: string[];
  /** "Requires ⟨name⟩ continuity asset" when a reference asset is required (none exists yet). */
  requirement: string | null;
}

/** The version's forecast, with the catalog it was frozen at. */
export interface CostRollupView extends CostRollup {
  catalogVersion: string;
  /** The catalog has changed since (the frozen figures stay; STALE_PRICING). */
  pricingChanged: boolean;
  /** No asset exists in V1, so nothing has been spent on visuals. */
  actualCostUsd: null;
}

export interface ApproachSummaryView extends ApproachSummary {
  label: string;
  chosen: boolean;
}

export interface CostAlternativeView extends CostAlternative {
  /** Whether applying it now would make a valid version, and why not. */
  apply: EditorialAction;
}

/** One version in full. */
export interface StoryboardVersionView extends StoryboardSummaryView {
  inputs: StoryboardInputs;
  scopeInfo: StoryboardScopeInfo;
  narrationLane: NarrationLaneView;
  cutPoints: CutPointView[];
  beats: VisualBeatView[];
  shots: ShotView[];
  continuity: ContinuitySubjectView[];
  costs: CostRollupView;
  approaches: ApproachSummaryView[];
  alternatives: CostAlternativeView[];
  rhythm: RhythmStats;
  evidenceCoverage: { factualShots: number; traced: number; untraced: string[] };
  qa: { saved: StoryboardQaFinding[]; live: StoryboardQaFinding[] };
  /** What code changed in the model's output. */
  normalization: string[];
  changes: VersionChanges | null;
  /** Version-level decisions, newest first. */
  decisions: StoryboardDecisionView[];
  /** A newer version exists: an approval of this one still applies to this one ("v2 differs in k shots"). */
  newer: { version: number; status: StoryboardStatus; changedShots: number } | null;
  /** The status and the decision explained ("approved by X on D, superseded by vN on D'"). */
  statusNote: string | null;
}

/** A voice assembly a storyboard could be timed against. */
export interface StoryboardAssemblyOptionView {
  id: string;
  version: number;
  status: ArtifactStatus;
  complete: boolean;
  totalDurationMs: number;
  fingerprint: string;
  takes: { approved: number; total: number };
  mock: boolean;
  approval: NarrationApproval;
  /** Named by the newest VOICE gate approval. */
  gateApproved: boolean;
}

/** What a new storyboard would be planned from, and whether it can be. */
export interface StoryboardInputsView {
  script: { id: string; version: number; status: ArtifactStatus } | null;
  architecture: { id: string; version: number; status: ArtifactStatus } | null;
  runs: {
    id: string;
    number: number;
    kind: VoiceRunKind;
    label: string;
    /** The comparison variant it was made as ("C expressive"), or null. */
    variant: string | null;
    scopeBlockKeys: string[];
    /** The run narrates the approved script. */
    current: boolean;
    assemblies: StoryboardAssemblyOptionView[];
  }[];
  profile: VisualProductionView;
  /** The planning job's ceiling for model calls, in USD. */
  planningCeilingUsd: number;
  /** A preview (side job) or the phase job, as the project stands. */
  kind: 'PREVIEW' | 'PHASE' | null;
  /** Why nothing can be planned now, if so. */
  blocked: string | null;
}

/** What the editor can do on the storyboard page now, and why not. */
export interface StoryboardEditorialActions {
  generate: EditorialAction;
  regenerateBeats: EditorialAction;
  approach: EditorialAction;
  edit: EditorialAction;
  retime: EditorialAction;
  restore: EditorialAction;
  /** A version-level decision (or the gate, for a whole-script version under review). */
  decide: EditorialAction;
  decideShots: EditorialAction;
}

export interface StoryboardView {
  project: { id: string; slug: string; title: string; status: string };
  versions: StoryboardSummaryView[];
  storyboard: StoryboardVersionView | null;
  editorial: StoryboardEditorialActions;
  /** False when the storyboard stages are MOCK here (no AI configured). */
  realStage: boolean;
  activeJob: JobView | null;
}

// ── Visual profiles ──────────────────────────────────────────────────────────

/** One version of a visual profile. */
export interface VisualProfileView {
  id: string;
  familyId: string;
  /** The family's name when this version was made. */
  name: string;
  version: number;
  config: VisualStyleProfileConfig;
  /** The family's current version (its newest). */
  current: boolean;
  origin: VisualProfileOrigin;
  /** What changed from the version before it ("density: balanced → sparse"); empty for v1. */
  changes: string[];
  /** Provider or model preferences the catalog does not know (warnings). */
  unknownPreferences: string[];
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Storyboard versions planned with it (a used version is never changed). */
  storyboards: number;
}

/** A project that uses a visual profile. */
export interface VisualProfileUseView {
  projectId: string;
  slug: string;
  title: string;
  mode: 'FOLLOW' | 'PIN';
  pinnedVersion: number | null;
}

export interface VisualProfileFamilyView {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  archived: boolean;
  /** The preset it was seeded from, if any. */
  preset: string | null;
  current: VisualProfileView | null;
  versions: number;
  usedBy: VisualProfileUseView[];
  storyboards: number;
  createdAt: string;
  updatedAt: string;
}

export interface VisualProfileHistoryView extends VisualProfileFamilyView {
  /** Newest first. */
  history: VisualProfileView[];
}

/** The visual profile library. */
export interface VisualProfileLibraryView {
  /** A new profile's starting point. */
  defaults: VisualStyleProfileConfig;
  families: VisualProfileFamilyView[];
}

/** What a project's storyboards are planned with now. */
export interface VisualProductionView {
  mode: VisualSelectionMode;
  /** Incremented by every change of the project's choice or overrides (0: no choice made yet). */
  revision: number;
  family: { id: string; name: string; archived: boolean; isDefault: boolean } | null;
  profile: VisualProfileView | null;
  /** Pinned while the family has a newer current version. */
  newer: { id: string; version: number } | null;
  overrides: VisualConfigOverrides;
  effective: VisualStyleProfileConfig | null;
  provenance: VisualConfigProvenance;
  /** Worth knowing, not blocking (the library default is used; a newer version while pinned; an unknown provider preference). */
  notices: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

// ── Visual catalog ───────────────────────────────────────────────────────────

/** The visual catalog as the API shows it: no client, no credentials, only what costs a shot. */
export interface VisualCatalogView {
  version: string;
  methods: { method: ProductionMethod; treatments: VisualTreatment[]; candidates: number }[];
  cards: {
    provider: string;
    label: string;
    implemented: boolean;
    pricing: VisualPricing;
    models: { model: string; label: string; methods: ProductionMethod[]; aspectRatios: string[]; resolutions: string[]; clip: { minSec: number; maxSec: number; billableSec: number[] } | null; known: boolean }[];
    rates: { model: string | null; unit: string; usdPerUnit: number; source: string }[];
  }[];
  /** The basis a forecast can have (never VENDOR_REPORTED). */
  bases: VisualCostBasis[];
}
