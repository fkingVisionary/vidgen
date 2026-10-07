import type { ArtifactStatus, ChunkBoundary, CostBasis, PerformanceStrategy, PronunciationMethod, PronunciationStatus, PronunciationTermKind, VoiceGenerationStatus, VoiceRunKind } from './enums.ts';
import type {
  AssemblyEntry,
  ChunkPerformance,
  ChunkSpan,
  ConfigProvenance,
  ContextSettings,
  ChunkingSettings,
  DirectorMark,
  EffectiveVoiceConfig,
  NarrationTimelineEntry,
  PreparedNarration,
  ProviderSettingValues,
  SelectionMode,
  TimedWord,
  VoiceConfigOverrides,
  VoiceProfileConfig,
  VoiceProfileOrigin,
  VoiceProfileRef,
  VoiceQaFinding,
  VoiceRunConfig,
  VoiceScope,
  VoiceSettingDescriptor,
  VoiceTakeOverride,
} from './contracts/voice.ts';
import type { JobView } from './views.ts';

/** Read models of the Voice Engine, as the API returns them. */

/** One version of a saved profile. */
export interface VoiceProfileView {
  id: string;
  /** Null: made before saved profiles and not yet given a family. */
  familyId: string | null;
  /** The family's name when this version was made. */
  name: string;
  version: number;
  provider: string;
  voiceId: string;
  /** The voice's name at the provider, when known. */
  voiceName: string | null;
  modelId: string;
  language: string;
  outputFormat: string;
  /** Normalised by the provider: every setting it describes, defaults filled in. */
  config: VoiceProfileConfig;
  /** The family's current version (its newest). */
  current: boolean;
  /** How it was made (LEGACY: before saved profiles). */
  origin: VoiceProfileOrigin | { kind: 'LEGACY' };
  /** What changed from the version before it in its family ("performance: restrained → expressive"); empty for v1. */
  changes: string[];
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Runs that used this version (a used version is never changed). */
  runs: number;
}

/** A language version whose narration uses a saved profile. */
export interface VoiceProfileUseView {
  projectId: string;
  slug: string;
  title: string;
  language: string;
  mode: 'FOLLOW' | 'PIN';
  pinnedVersion: number | null;
}

/** A saved profile: its identity and current version. */
export interface VoiceProfileFamilyView {
  id: string;
  name: string;
  description: string | null;
  /** The library default for its provider and language. */
  isDefault: boolean;
  archived: boolean;
  /** Its current version's (null: no version yet). */
  provider: string | null;
  language: string | null;
  current: VoiceProfileView | null;
  versions: number;
  /** Language versions whose narration uses it, following its current version or pinned to one. */
  usedBy: VoiceProfileUseView[];
  /** Runs made with any of its versions. */
  runs: number;
  createdAt: string;
  updatedAt: string;
}

/** A saved profile with every version. */
export interface VoiceProfileHistoryView extends VoiceProfileFamilyView {
  /** Newest first. */
  history: VoiceProfileView[];
}

/** The profile library, with what a form needs to edit a profile for the configured provider. */
export interface VoiceProfileLibraryView {
  provider: { name: string; mock: boolean; defaultModel: string; defaultVoiceId: string | null; defaultOutputFormat: string; models: string[] };
  /** The configured provider's settings, for forms. */
  settings: VoiceSettingDescriptor[];
  /** A new profile's starting point: the house default with the provider's setting defaults. */
  defaults: VoiceProfileConfig;
  families: VoiceProfileFamilyView[];
}

/** What a language version narrates with now (what a new run would use). */
export interface VoiceProductionView {
  language: string;
  mode: 'FOLLOW' | 'PIN' | 'DEFAULT';
  /** Incremented by every change of the project's choice or overrides (0: no choice made yet). */
  revision: number;
  family: { id: string; name: string; archived: boolean; isDefault: boolean } | null;
  profile: VoiceProfileView | null;
  /** Pinned while the family has a newer current version. */
  newer: { id: string; version: number } | null;
  overrides: VoiceConfigOverrides;
  effective: EffectiveVoiceConfig | null;
  provenance: ConfigProvenance;
  /** Provider settings as the model is sent them, and those it does not take. */
  sent: ProviderSettingValues;
  ignored: string[];
  /** Why a new run cannot use it (another provider or language, no voice), or null. */
  problem: string | null;
  /** Worth knowing, not blocking (an archived profile; a newer version while pinned; the house profile is made at the first plan). */
  notices: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** What a take was made with, for its label. */
export interface VoiceTakeConfigView {
  base: 'RUN' | 'PRODUCTION';
  override: VoiceTakeOverride | null;
  profile: VoiceProfileRef;
  reconstructed: boolean;
  /** How it differs from the run's configuration ("performance: expressive (run: restrained)", "stability: 0.3 (run: 0.5)"): stored on the take, or the strategy difference of a take made before saved profiles. */
  differs: string[];
  /** The difference is in what the voice sounds like (voice, model, provider settings…), not only its performance. */
  identityDiffers: boolean;
}

/** What a take's request cost, estimated from the characters sent. */
export interface VoiceCostView {
  estimatedUsd: number | null;
  actualUsd: number | null;
  basis: CostBasis | null;
  note: string | null;
  /** Characters sent: the estimate's basis (an upper bound). */
  characters: number | null;
  /** Figures the provider reported, kept raw under their own name (never priced). */
  reported: { name: string; quantity: number }[];
  /** Re-estimated here from the characters sent: the ledger row was estimated from the provider's figure (before 2026-10-06). */
  reestimated: boolean;
}

/** What the run's chunks would cost and cover, before anything is generated. */
export interface VoiceEstimateView {
  chunks: number;
  words: number;
  /** Characters that would be sent (spoken text plus performance markup). */
  characters: number;
  /** Planning estimate at the script's words-per-minute (the real duration comes from the audio). */
  plannedSec: number;
  estimatedCostUsd: number | null;
  costBasis: CostBasis;
  costNote: string;
  /** Above the confirmation threshold (or the whole script): the request must be confirmed. */
  needsConfirmation: boolean;
}

/** What an audition covers (to test a voice properly, not just prove the API works). */
export interface AuditionCoverageView {
  dramaticOpening: boolean;
  explanatory: boolean;
  rhetoricalQuestion: boolean;
  number: boolean;
  nameOrPlace: boolean;
  performanceMoment: boolean;
}

export interface VoicePlanChunkView {
  index: number;
  sectionKey: string;
  blockKeys: string[];
  text: string;
  words: number;
  boundary: ChunkBoundary;
  performance: ChunkPerformance;
  /** Planned seconds: spoken words at the narration rate and the chunk's pace, plus its inside pauses (outside CHUNK_SECONDS.natural is worth a look). */
  estimatedSec: number;
  /** What would be sent, and the checks it would pass. */
  performanceText: string;
  characters: number;
  checksPassed: boolean;
}

export interface VoicePlanView {
  scope: VoiceScope;
  description: string;
  profile: VoiceProfileView;
  strategy: PerformanceStrategy;
  chunking: ChunkingSettings;
  context: ContextSettings;
  chunks: VoicePlanChunkView[];
  estimate: VoiceEstimateView;
  coverage: AuditionCoverageView;
  unresolvedPronunciations: string[];
  /** Why generating this plan is refused, if it is. */
  blocked: string | null;
  /** The configuration the run would be made with, and the project's selection revision it was planned at (generating it at another revision is refused). */
  configuration: {
    effective: EffectiveVoiceConfig;
    provenance: ConfigProvenance;
    selectionRevision: number;
    mode: SelectionMode;
    projectOverrides: VoiceConfigOverrides;
    runOptions: VoiceConfigOverrides;
    sent: ProviderSettingValues;
    ignored: string[];
  };
}

/** One take of a chunk. */
export interface VoiceGenerationView {
  id: string;
  generation: number;
  status: VoiceGenerationStatus;
  current: boolean;
  provider: string;
  model: string;
  voiceId: string;
  /** The version's own name as it was made; `familyName` is the family's name now ("House narrator v1 (now Classic narrator)" after a rename). */
  profile: { id: string; name: string; version: number; familyId: string | null; familyName: string | null };
  /** What the take was made with: the run's configuration or the production profile, and any temporary override. */
  configuration: VoiceTakeConfigView;
  strategy: PerformanceStrategy;
  /** The A/B variant this take was made as (never made current by itself), or null. */
  variant: string | null;
  /** The text sent (derived; never the script). */
  performanceText: string | null;
  spokenText: string | null;
  prepared: PreparedNarration | null;
  directions: DirectorMark[] | null;
  audioUrl: string | null;
  mimeType: string | null;
  durationMs: number | null;
  words: TimedWord[];
  alignment: 'PROVIDER' | 'MOCK' | null;
  unmatchedWords: number;
  qa: VoiceQaFinding[];
  characters: number | null;
  cost: VoiceCostView | null;
  providerRequestId: string | null;
  error: string | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  mock: boolean;
}

export interface VoiceChunkView {
  id: string;
  index: number;
  sectionKey: string;
  sectionTitle: string | null;
  blockKeys: string[];
  spans: ChunkSpan[];
  text: string;
  words: number;
  boundary: ChunkBoundary;
  performance: ChunkPerformance;
  /** The script's text for these spans has changed since (a later script version). */
  stale: boolean;
  current: VoiceGenerationView | null;
  /** Every take, newest first (none is ever deleted). */
  generations: VoiceGenerationView[];
}

export interface VoiceAssemblyView {
  id: string;
  version: number;
  status: ArtifactStatus;
  totalDurationMs: number;
  complete: boolean;
  entries: AssemblyEntry[];
  timeline: NarrationTimelineEntry[];
  qa: VoiceQaFinding[];
  audioUrl: string;
  createdAt: string;
}

/** One assembly version of a run (a new one whenever a current take changes); every version stays playable. */
export interface VoiceAssemblyVersionView {
  id: string;
  version: number;
  status: ArtifactStatus;
  totalDurationMs: number;
  complete: boolean;
  audioUrl: string;
  createdAt: string;
}

export interface VoiceRunSummaryView {
  id: string;
  number: number;
  kind: VoiceRunKind;
  label: string;
  experiment: string | null;
  variant: string | null;
  scriptVersion: number;
  strategy: PerformanceStrategy;
  profile: { id: string; name: string; version: number; modelId: string; voiceId: string; familyId: string | null; familyName: string | null };
  chunkCount: number;
  /** Current takes by status. */
  takes: Partial<Record<VoiceGenerationStatus, number>>;
  durationMs: number | null;
  /** Characters sent. */
  characters: number;
  /** Estimated from the characters sent; `reported` sums the provider's own figures per name (never priced); `reestimated` when a ledger row was estimated from the provider's figure. */
  cost: { totalUsd: number; basis: CostBasis | 'MIXED' | null; reported: { name: string; quantity: number }[]; reestimated: boolean };
  /** Generated from an older script version than the approved one. */
  stale: boolean;
  createdAt: string;
}

export interface VoiceRunView extends VoiceRunSummaryView {
  scope: VoiceScope;
  /** What the run was made with (reconstructed for a run made before saved profiles). */
  configuration: VoiceRunConfig;
  /** Chunking and context used (from `configuration`). */
  settings: { chunking: ChunkingSettings; context: ContextSettings };
  notes: string | null;
  chunks: VoiceChunkView[];
  /** The latest assembly. */
  assembly: VoiceAssemblyView | null;
  /** Every assembly version, newest first. */
  assemblies: VoiceAssemblyVersionView[];
  qa: VoiceQaFinding[];
  /** "Audio generated from Script v4 — current script is v5." */
  staleNote: string | null;
  stats: { averageChunkMs: number | null; longestChunkMs: number | null; shortestChunkMs: number | null; regenerations: number; failures: number; withAlignment: number };
}

export interface VoicePronunciationView {
  id: string;
  term: string;
  kind: PronunciationTermKind;
  method: PronunciationMethod;
  pronunciation: string | null;
  status: PronunciationStatus;
  source: string;
  hint: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string;
  /** The term that replaced it ("Thijs"), when the detector no longer finds this one (an entry never decided; it no longer blocks narration). */
  withdrawn: string | null;
}

export interface VoiceView {
  project: { id: string; slug: string; title: string; status: string };
  /** The approved script version narration is made from (null until one is approved). */
  script: { id: string; version: number } | null;
  provider: {
    name: string;
    mock: boolean;
    defaultModel: string;
    defaultVoiceId: string | null;
    storage: string;
    durableStorage: boolean;
    /** The provider's settings, for forms. */
    settings: VoiceSettingDescriptor[];
    /** Known model ids. */
    models: string[];
  };
  /** What the master language narrates with now. */
  production: VoiceProductionView;
  /** Saved profiles that can be chosen: unarchived, the configured provider and the master language. */
  library: VoiceProfileFamilyView[];
  runs: VoiceRunSummaryView[];
  run: VoiceRunView | null;
  pronunciations: VoicePronunciationView[];
  editorial: {
    generate: { allowed: boolean; reason: string | null };
    approve: { allowed: boolean; reason: string | null };
  };
  confirmCharacters: number;
  activeJob: JobView | null;
}

/**
 * The narration timeline of a run's latest assembly, as the storyboard reads
 * it: once real narration exists, this clock is authoritative, not the
 * script's estimated runtime.
 */
export interface NarrationTimelineView {
  run: number;
  scriptVersion: number;
  assembly: number;
  /** The rows behind the numbers, so a reader links by id (absent where a reader does not fill them in). */
  assemblyId?: string;
  runId?: string;
  scriptId?: string;
  /** The voice profile version the run narrated with. */
  profileId?: string;
  runKind?: VoiceRunKind;
  /** The block keys the run's scope resolved to. */
  scopeBlockKeys?: string[];
  languageVersionId?: string;
  status: ArtifactStatus;
  complete: boolean;
  totalDurationMs: number;
  entries: AssemblyEntry[];
  /** Each block part, with whether its take is approved now (read when asked, not when assembled). */
  timeline: (NarrationTimelineEntry & { approved: boolean })[];
}

/** "What is being said at 02:43?" */
export interface VoiceMomentView {
  atMs: number;
  run: number;
  section: string;
  block: string;
  chunk: number;
  generation: number;
  word: string | null;
  text: string;
  between: boolean;
  startMs: number;
  endMs: number;
  /** The block part heard, as the timeline gives it: the take's audio file, timed words, performance, visual hints and approval. */
  part: NarrationTimelineView['timeline'][number];
}
