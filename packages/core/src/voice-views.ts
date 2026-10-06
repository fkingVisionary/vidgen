import type { ArtifactStatus, ChunkBoundary, CostBasis, PerformanceStrategy, PronunciationMethod, PronunciationStatus, PronunciationTermKind, VoiceGenerationStatus, VoiceRunKind } from './enums.ts';
import type {
  AssemblyEntry,
  ChunkPerformance,
  ChunkSpan,
  ContextSettings,
  ChunkingSettings,
  DirectorMark,
  NarrationTimelineEntry,
  PreparedNarration,
  TimedWord,
  VoiceProfileConfig,
  VoiceQaFinding,
  VoiceScope,
} from './contracts/voice.ts';
import type { JobView } from './views.ts';

/** Read models of the Voice Engine, as the API returns them. */

export interface VoiceProfileView {
  id: string;
  name: string;
  version: number;
  provider: string;
  voiceId: string;
  /** The voice's name at the provider, when known. */
  voiceName: string | null;
  modelId: string;
  language: string;
  outputFormat: string;
  config: VoiceProfileConfig;
  active: boolean;
  notes: string | null;
  createdAt: string;
  /** Runs that used this version (a used version is never changed). */
  runs: number;
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
  profile: { id: string; name: string; version: number };
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
  cost: { estimatedUsd: number | null; actualUsd: number | null; basis: CostBasis | null; note: string | null } | null;
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
  profile: { id: string; name: string; version: number; modelId: string; voiceId: string };
  chunkCount: number;
  /** Current takes by status. */
  takes: Partial<Record<VoiceGenerationStatus, number>>;
  durationMs: number | null;
  characters: number;
  cost: { totalUsd: number; basis: CostBasis | 'MIXED' | null };
  /** Generated from an older script version than the approved one. */
  stale: boolean;
  createdAt: string;
}

export interface VoiceRunView extends VoiceRunSummaryView {
  scope: VoiceScope;
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
}

export interface VoiceView {
  project: { id: string; slug: string; title: string; status: string };
  /** The approved script version narration is made from (null until one is approved). */
  script: { id: string; version: number } | null;
  provider: { name: string; mock: boolean; defaultModel: string; defaultVoiceId: string | null; storage: string; durableStorage: boolean };
  profiles: VoiceProfileView[];
  activeProfileId: string | null;
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
