import type { HistoricalValueKey, OpportunityScoreKey, StoryScoreKey, StoryValueKey } from './contracts/story.ts';
import type { StoryboardFindingKind, TreatmentCondition } from './contracts/storyboard.ts';
import type { VisualConfigSource, VisualProfileOrigin, VisualSelectionMode } from './contracts/visual-profile.ts';
import type { ConfigSource, PerformanceRules, SelectionMode, VoiceProfileOrigin, VoiceTakeConfig } from './contracts/voice.ts';
import type {
  ApprovalGate,
  ArchitectureOrigin,
  BeatFunction,
  ChangeArea,
  CandidatePriority,
  CandidateStatus,
  CastKind,
  ClaimVerdict,
  ContentFormat,
  HistoricalStatus,
  InformationClass,
  JobType,
  NarrativeMode,
  OpportunityStatus,
  PovStrategy,
  Presentation,
  ProjectStatus,
  ReconstructionLevel,
  RevisionAspect,
  DeliveryEmotion,
  DeliveryEnergy,
  DeliveryPace,
  PauseLength,
  PauseReason,
  ScriptBlockClass,
  ScriptOrigin,
  ScriptScore,
  SectionReviewStatus,
  VisualIntent,
  SourceType,
  SpeechKind,
  Stage,
  StageState,
  StoryType,
  TimeJump,
  ChunkBoundary,
  PerformanceStrategy,
  PronunciationMethod,
  PronunciationStatus,
  PronunciationTermKind,
  VoiceGenerationStatus,
  VoiceRunKind,
  AiPattern,
  BlockChangeStatus,
  MoneyComparisonType,
  RubricDimension,
  WritingCategory,
  WritingExampleStatus,
  WritingQuality,
  WritingSourceType,
  ArchivalPreference,
  AssetSourcing,
  BeatImportance,
  CameraStyle,
  ContinuityKind,
  CutPointKind,
  CutReason,
  Depiction,
  DetailBasis,
  EvidenceRelation,
  FilmGrain,
  GenerationComplexity,
  GraphicsPreference,
  LicensingStatus,
  LikenessMode,
  MotionIntensity,
  NarrationApproval,
  OverlayKind,
  PriceConfidence,
  ProductionMethod,
  ReuseCategory,
  ShotClaimRole,
  ShotReviewState,
  ShotTransition,
  SpecificKind,
  StoryboardDecisionKind,
  StoryboardMode,
  StoryboardOrigin,
  StoryboardScope,
  StoryboardStatus,
  SubjectInteraction,
  SubjectRole,
  TimingRelation,
  UncertaintyDevice,
  VisualApproach,
  VisualAssetType,
  VisualCostBasis,
  VisualDensity,
  VisualRealism,
  VisualTreatment,
} from './enums.ts';

/** Human-readable labels for the dashboard. Kept out of the enums so copy can change freely. */

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  IDEA: 'Idea',
  RESEARCHING: 'Researching',
  RESEARCH_REVIEW: 'Research review',
  RESEARCH_COMPLETE: 'Research complete',
  STORY_MINING: 'Story mining',
  STORY_SELECTION: 'Story selection',
  STORY_ARCHITECTING: 'Story architecture',
  STORY_REVIEW: 'Story review',
  STORY_APPROVED: 'Story approved',
  SCRIPT_DRAFT: 'Script draft',
  SCRIPT_REVIEW: 'Script review',
  SCRIPT_APPROVED: 'Script approved',
  VOICE_GENERATING: 'Voice generating',
  VOICE_REVIEW: 'Voice review',
  VOICE_COMPLETE: 'Voice complete',
  VISUAL_PLANNING: 'Visual planning',
  STORYBOARD_REVIEW: 'Storyboard review',
  STORYBOARD_APPROVED: 'Storyboard approved',
  VISUAL_GENERATING: 'Visual generating',
  VISUAL_REVIEW: 'Visual review',
  EDITING: 'Editing',
  RENDERING: 'Rendering',
  QA: 'QA / final review',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
};

export const STAGE_LABELS: Record<Stage, string> = {
  RESEARCH: 'Research',
  STORY: 'Story',
  SCRIPT: 'Script',
  VOICE: 'Voice',
  STORYBOARD: 'Storyboard',
  ASSETS: 'Assets',
  TIMELINE: 'Timeline',
  QA: 'QA',
  FINAL: 'Final',
};

export const STAGE_STATE_LABELS: Record<StageState, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  AWAITING_APPROVAL: 'Awaiting approval',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  RESEARCH: 'Research',
  STORY_MINING: 'Story Mining',
  STORY_ARCHITECTURE: 'Story Architecture',
  STORY_ANGLES: 'Story angles',
  SCRIPT: 'Script',
  VOICE: 'Voice / narration',
  VISUAL_PLAN: 'Visual plan (storyboard)',
  STORYBOARD_PREVIEW: 'Storyboard preview',
  VISUAL_GENERATION: 'Visual generation',
  INFOGRAPHIC: 'Infographics',
  EDIT: 'Edit (timeline)',
  RENDER: 'Render',
  QA: 'Automated QA',
  PUBLISH: 'Publish',
};

export const GATE_LABELS: Record<ApprovalGate, string> = {
  RESEARCH: 'Research dossier',
  STORY: 'Story architecture',
  SCRIPT: 'Script',
  VOICE: 'Narration (voice)',
  STORYBOARD: 'Storyboard',
  VISUAL_ASSETS: 'Generated visual assets',
  FINAL_VIDEO: 'Final video',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  PRIMARY: 'Primary source',
  ACADEMIC: 'Academic / scholarly',
  BOOK: 'Book / historical work',
  ARCHIVE: 'Archive / museum / university',
  REPUTABLE_SECONDARY: 'Reputable secondary',
  GENERAL_REFERENCE: 'General reference',
  GENERAL_WEB: 'General web',
};

export const CLAIM_VERDICT_LABELS: Record<ClaimVerdict, string> = {
  ESTABLISHED: 'Established',
  PROBABLE: 'Probable',
  DISPUTED: 'Disputed',
  UNVERIFIED: 'Unverified',
  MYTH: 'Myth',
};

export const STORY_TYPE_LABELS: Record<StoryType, string> = {
  CHARACTER: 'Character',
  DEAL: 'Deal',
  MARKET_EVENT: 'Market event',
  FORTUNE: 'Fortune',
  SCAM: 'Scam',
  CONFLICT: 'Conflict',
  REVERSAL: 'Reversal',
  MYSTERY: 'Mystery',
  MYTH_ORIGIN: 'Myth origin',
  DISCOVERY: 'Discovery',
  DISASTER: 'Disaster',
  SOCIAL_PHENOMENON: 'Social phenomenon',
};

export const HISTORICAL_STATUS_LABELS: Record<HistoricalStatus, string> = {
  ESTABLISHED: 'Established',
  PROBABLE: 'Probable',
  CONTESTED: 'Contested',
  UNCERTAIN: 'Uncertain',
  MYTH_INVESTIGATION: 'Myth investigation',
};

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  PROPOSED: 'Proposed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  FLAGGED: 'Flagged',
};

export const CANDIDATE_PRIORITY_LABELS: Record<CandidatePriority, string> = {
  HIGH: 'High priority',
  NORMAL: 'Normal priority',
  LOW: 'Low priority',
};

export const STORY_SCORE_LABELS: Record<StoryScoreKey, string> = {
  intrigue: 'Intrigue',
  humanDrama: 'Human drama',
  stakes: 'Stakes',
  surprise: 'Surprise',
  escalation: 'Escalation',
  visualPotential: 'Visual potential',
  financialStakes: 'Economic significance',
  emotionalWeight: 'Emotional weight',
};

// ---------------------------------------------------------------------------
// Story Engine 2.0
// ---------------------------------------------------------------------------

export const NARRATIVE_MODE_LABELS: Record<NarrativeMode, string> = {
  IMMERSIVE_RECONSTRUCTION: 'Immersive reconstruction',
  CHARACTER_FOLLOW: 'Character follow',
  HISTORICAL_MYSTERY: 'Historical mystery',
  INVESTIGATION: 'Investigation',
  COUNTDOWN: 'Countdown',
  SURVIVAL: 'Survival',
  CONFLICT: 'Conflict',
  RISE_AND_FALL: 'Rise and fall',
  HEIST_OPERATION: 'Heist / operation',
  JOURNEY: 'Journey',
  COURTROOM_DISPUTE: 'Courtroom / dispute',
  DISCOVERY: 'Discovery',
  MYTH_VS_RECORD: 'Myth vs record',
  PARALLEL_TIMELINE: 'Parallel timeline',
  CAUSE_AND_EFFECT: 'Cause and effect',
};

export const INFORMATION_CLASS_LABELS: Record<InformationClass, string> = {
  DOCUMENTED: 'Documented fact',
  RECONSTRUCTION: 'Reconstruction',
  UNCERTAIN: 'Uncertain history',
  FICTION: 'Fictional device',
};

/** What each information class allows, for the dashboard legend. */
export const INFORMATION_CLASS_HELP: Record<InformationClass, string> = {
  DOCUMENTED: 'Stated directly. Rests only on ESTABLISHED claims.',
  RECONSTRUCTION: 'A plausible scene built from documented circumstances. Never presented as a recorded event.',
  UNCERTAIN: 'Probable, disputed, unverified or myth material, told with its presentation instruction.',
  FICTION: 'A declared narrative device (POV, composite, invented dialogue). Carries no facts of its own.',
};

export const BEAT_FUNCTION_LABELS: Record<BeatFunction, string> = {
  COLD_OPEN: 'Cold open',
  ORIENTATION: 'Orientation',
  STAKES: 'Stakes',
  CONFLICT: 'Conflict',
  ESCALATION: 'Escalation',
  TURN: 'Turn',
  REVEAL: 'Reveal',
  CONSEQUENCE: 'Consequence',
  INVESTIGATION: 'Investigation',
  TRANSITION: 'Transition',
};

export const CAST_KIND_LABELS: Record<CastKind, string> = {
  POV_PROXY: 'Fictional POV (the viewer)',
  FICTIONAL_COMPOSITE: 'Fictional composite',
  REAL_PERSON: 'Real person',
  REAL_GROUP: 'Real group',
  REAL_ROLE: 'Real role',
};

export const POV_STRATEGY_LABELS: Record<PovStrategy, string> = {
  VIEWER_POV: 'Viewer POV ("you")',
  COMPANION: 'Fictional companion',
  CHARACTER_FOLLOW: 'Follow a real character',
  INVESTIGATOR: 'Investigator',
  NARRATOR: 'Narrator (no POV device)',
};

export const PRESENTATION_LABELS: Record<Presentation, string> = {
  STATE: 'State as fact',
  HEDGE: 'Hedge (probable)',
  PRESENT_AS_DISPUTED: 'Present as disputed',
  PRESENT_AS_UNCONFIRMED: 'Present as unconfirmed',
  INVESTIGATE_AS_MYTH: 'Investigate as myth',
};

export const SPEECH_KIND_LABELS: Record<SpeechKind, string> = {
  RECORDED_QUOTE: 'Recorded quote',
  INVENTED: 'Invented line',
};

export const TIME_JUMP_LABELS: Record<TimeJump, string> = {
  NONE: 'Continues',
  FORWARD: 'Jumps forward',
  FLASHBACK: 'Flashback',
  PARALLEL: 'Parallel time',
};

export const RECONSTRUCTION_LEVEL_LABELS: Record<ReconstructionLevel, string> = {
  NONE: 'None',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

export const STORY_VALUE_LABELS: Record<StoryValueKey, string> = {
  humanStakes: 'Human stakes',
  conflict: 'Conflict',
  mystery: 'Mystery / question',
  escalation: 'Escalation',
  characterPotential: 'Character potential',
  visualPotential: 'Visual potential',
  emotionalPotential: 'Emotional potential',
  revealPotential: 'Reveal potential',
  mythInvestigation: 'Myth / investigation potential',
};

export const HISTORICAL_VALUE_LABELS: Record<HistoricalValueKey, string> = {
  evidenceQuality: 'Evidence quality',
  significance: 'Historical significance',
  relevance: 'Relevance',
  uniqueness: 'Uniqueness',
};

export const CONTENT_FORMAT_LABELS: Record<ContentFormat, string> = {
  LONG_FORM: 'Long-form',
  SHORT: 'Short',
  BOTH: 'Short + long-form',
};

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  PROPOSED: 'Proposed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const OPPORTUNITY_SCORE_LABELS: Record<OpportunityScoreKey, string> = {
  hook: 'Hook',
  payoff: 'Payoff',
  standalone: 'Standalone',
  visual: 'Visual punch',
  emotion: 'Emotional pull',
  pace: 'Fits the short format',
};

// ---------------------------------------------------------------------------
// Editorial revision loop and alternative angles
// ---------------------------------------------------------------------------

export const REVISION_ASPECT_LABELS: Record<RevisionAspect, string> = {
  ANGLE: 'Angle',
  POV: 'Point of view',
  EMOTIONAL_CENTRE: 'Emotional centre',
  OPENING: 'Opening',
  STRUCTURE: 'Structure',
  PACING: 'Pacing',
  NARRATIVE_STRATEGY: 'Narrative strategy',
  CENTRAL_QUESTION: 'Central question',
  HUMAN_STAKES: 'Human stakes',
};

export const CHANGE_AREA_LABELS: Record<ChangeArea, string> = {
  ...REVISION_ASPECT_LABELS,
  UNITS: 'Story units',
  EVIDENCE: 'Evidence and presentation',
  OTHER: 'Other',
};

export const ARCHITECTURE_ORIGIN_LABELS: Record<ArchitectureOrigin, string> = {
  NEW: 'Built from the selection',
  REVISION: 'Revision',
};

// ---------------------------------------------------------------------------
// Script Engine
// ---------------------------------------------------------------------------

export const SCRIPT_BLOCK_CLASS_LABELS: Record<ScriptBlockClass, string> = {
  ...INFORMATION_CLASS_LABELS,
  FRAMING: 'Narrator framing',
};

export const SCRIPT_BLOCK_CLASS_HELP: Record<ScriptBlockClass, string> = {
  ...INFORMATION_CLASS_HELP,
  FRAMING: "The narrator's own connective line — a question, a turn, a signpost. Carries no facts, figures or claims.",
};

export const DELIVERY_PACE_LABELS: Record<DeliveryPace, string> = { SLOW: 'Slow', NORMAL: 'Normal pace', FAST: 'Fast' };
export const DELIVERY_ENERGY_LABELS: Record<DeliveryEnergy, string> = { LOW: 'Low energy', MEDIUM: 'Medium energy', HIGH: 'High energy' };
export const DELIVERY_EMOTION_LABELS: Record<DeliveryEmotion, string> = {
  NEUTRAL: 'Neutral',
  TENSE: 'Tense',
  CURIOUS: 'Curious',
  SOMBER: 'Somber',
  EXCITED: 'Excited',
  REFLECTIVE: 'Reflective',
};
export const PAUSE_LENGTH_LABELS: Record<PauseLength, string> = { NONE: 'No pause', MICRO: 'Micro', SHORT: 'Short', MEDIUM: 'Medium', LONG: 'Long' };
export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  REVEAL: 'reveal',
  NUMBER: 'number',
  EMOTIONAL_TURN: 'emotional turn',
  TRANSITION: 'transition',
  IMPACT: 'impact',
  QUESTION: 'open question',
  RHYTHM: 'rhythm',
};

export const VISUAL_INTENT_LABELS: Record<VisualIntent, string> = {
  CINEMATIC_RECONSTRUCTION: 'Cinematic reconstruction',
  DOCUMENT: 'Document',
  MAP: 'Map',
  DATA: 'Data',
  TIMELINE: 'Timeline',
  ARCHIVAL: 'Archival',
  PORTRAIT: 'Portrait',
  ENVIRONMENT: 'Environment',
  ABSTRACT_METAPHOR: 'Abstract metaphor',
  ON_SCREEN_TEXT: 'On-screen text',
  NONE: 'No specific visual',
};

export const SECTION_REVIEW_STATUS_LABELS: Record<SectionReviewStatus, string> = { PENDING: 'Not reviewed', APPROVED: 'Approved', REJECTED: 'Rejected' };

export const SCRIPT_ORIGIN_LABELS: Record<ScriptOrigin, string> = {
  DRAFT: 'Draft from the architecture',
  SECTIONS: 'Sections rewritten',
  REVISION: 'Revision',
  RESTORE: 'Restored',
  REFINEMENT: 'Narrative refinement',
  NARRATION: 'Narration pass (Writing Engine 2)',
};

export const SCRIPT_SCORE_LABELS: Record<ScriptScore, string> = {
  NARRATIVE_SCORE: 'Story and momentum',
  AUDIO_FLOW_SCORE: 'Spoken flow',
  CLARITY_SCORE: 'Clarity',
  EMOTIONAL_SCORE: 'Emotional pull',
  ENDING_SCORE: 'Ending and payoff',
};

// ── Voice ────────────────────────────────────────────────────────────────────

export const VOICE_RUN_KIND_LABELS: Record<VoiceRunKind, string> = { AUDITION: 'Audition', SECTION: 'Section', BLOCKS: 'Blocks', RANGE: 'Range', FULL: 'Full narration' };
export const VOICE_GENERATION_STATUS_LABELS: Record<VoiceGenerationStatus, string> = {
  PENDING: 'Pending',
  GENERATING: 'Generating',
  GENERATED: 'Generated',
  IN_REVIEW: 'To review',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  SUPERSEDED: 'Superseded',
};
export const PERFORMANCE_STRATEGY_LABELS: Record<PerformanceStrategy, string> = {
  PLAIN: 'Plain text',
  RESTRAINED: 'Restrained (house style)',
  EXPRESSIVE: 'Expressive moments',
  DIRECTED: 'Over-directed (comparison only)',
};
export const PERFORMANCE_STRATEGY_HELP: Record<PerformanceStrategy, string> = {
  PLAIN: 'No performance directions: the voice reads the words as written.',
  RESTRAINED: "A few directions, only where the script's delivery changes — a documentary narrator, not an audiobook character.",
  EXPRESSIVE: 'The house style plus at most one deliberate moment per chunk, only where the script turns (a reveal, an impact, an emotional turn).',
  DIRECTED: 'A direction on every sentence — kept to hear what over-direction sounds like, never the default.',
};
export const CHUNK_BOUNDARY_LABELS: Record<ChunkBoundary, string> = {
  SECTION_END: 'section end',
  SPEAKER: 'change of speaker',
  PURPOSE: 'change of information class',
  PAUSE: 'scripted pause',
  PERFORMANCE: 'change of delivery',
  PARAGRAPH: 'paragraph end',
  SENTENCE: 'sentence end',
};
export const PRONUNCIATION_STATUS_LABELS: Record<PronunciationStatus, string> = { PENDING: 'To check', APPROVED: 'Approved', FLAGGED: 'Heard wrong' };
export const PRONUNCIATION_METHOD_LABELS: Record<PronunciationMethod, string> = { DEFAULT: "The voice's own reading", ALIAS: 'Say it as (alias)', IPA: 'Phonemes (IPA)', CMU: 'Phonemes (CMU Arpabet)' };
export const PRONUNCIATION_TERM_KIND_LABELS: Record<PronunciationTermKind, string> = { NAME: 'Name', PLACE: 'Place', ORGANISATION: 'Organisation', FOREIGN: 'Foreign word', TERM: 'Term', ABBREVIATION: 'Abbreviation' };
/** Where a setting came from (chips beside an effective value). */
export const CONFIG_SOURCE_LABELS: Record<ConfigSource, string> = { PROFILE: 'profile', PROJECT: 'project', RUN: 'run', TAKE: 'take' };
/** How a run's or a language version's profile version was chosen. */
export const SELECTION_MODE_LABELS: Record<SelectionMode, string> = {
  FOLLOW: 'follows the current version',
  PIN: 'pinned to a version',
  DEFAULT: 'library default',
  EXPLICIT: 'chosen for the run',
};
/** What a take was made with. */
export const TAKE_CONFIG_BASE_LABELS: Record<VoiceTakeConfig['base'], string> = { RUN: "the run's configuration", PRODUCTION: 'the production profile' };
export const PERFORMANCE_RULE_LABELS: Record<keyof PerformanceRules, string> = {
  maxMarksPerChunk: 'Directions per chunk (at most)',
  minWordsBetweenMarks: 'Words between directions (at least)',
  directorWordsPerMark: "Director's directions: warn above one per this many words",
  emotionWords: 'Word for each scripted feeling',
  deliveryWords: 'Word for each scripted manner',
  resetWord: 'Word for back to the plain register',
  paceSpeed: 'Speed of slow and fast passages',
};
/** How a profile version was made. */
export const VOICE_PROFILE_ORIGIN_LABELS: Record<VoiceProfileOrigin['kind'] | 'LEGACY', string> = {
  DEFAULTS: 'made from the configured defaults',
  LIBRARY: 'made in the library',
  EDIT: 'an edit',
  DUPLICATE: 'a duplicate',
  RUN: "saved from a voice run's configuration",
  LEGACY: 'made before saved profiles',
};

// ── Writing Engine 2 ─────────────────────────────────────────────────────────

export const WRITING_CATEGORY_LABELS: Record<WritingCategory, string> = {
  hook: 'Hook',
  explanation: 'Historical explanation',
  transition: 'Transition',
  character: 'Character',
  economics: 'Money and economics',
  numbers: 'Numbers',
  uncertainty: 'Uncertainty',
  scene: 'Scene',
  dialogue_adjacent: 'Around a quotation',
  payoff: 'Payoff',
  ending: 'Ending',
  context: 'Context',
  other: 'Other',
};
export const WRITING_QUALITY_LABELS: Record<WritingQuality, string> = { excellent: 'Excellent', good: 'Good', borderline: 'Borderline', bad: 'Bad (to avoid)' };
export const WRITING_SOURCE_TYPE_LABELS: Record<WritingSourceType, string> = {
  house: 'House writing',
  public_domain: 'Public domain',
  licensed: 'Licensed',
  user_provided: 'Provided by the editor',
  generated_comparison: 'Written as a contrast',
};
export const WRITING_EXAMPLE_STATUS_LABELS: Record<WritingExampleStatus, string> = { CANDIDATE: 'Candidate', APPROVED: 'In the house corpus', REJECTED: 'Rejected', RETIRED: 'Retired' };
export const AI_PATTERN_LABELS: Record<AiPattern, string> = {
  stock_phrase: 'Stock phrase',
  dramatic_transition: 'Fake dramatic beat',
  hype_adverb: 'Hype adverb',
  imagine_opener: '"Imagine…" opener',
  trailer_language: 'Trailer language',
  mystery_language: 'Generic mystery language',
  emotion_explained: 'Emotion explained',
  truth_reveal: '"The truth is…"',
  micro_hook: 'Micro-hook ending',
  contrast_formula: '"Not X, but Y" formula',
  qa_pair: 'Question answered by a fragment',
  fragment_run: 'Run of fragments',
  em_dash: 'Em-dashes',
  metaphor_stack: 'Stacked metaphors',
  rhetorical_question: 'Rhetorical questions',
  repeated_ending: 'Repeated endings',
  length_repetition: 'Same-length sentences',
  visual_description: 'Describes the picture',
};
export const RUBRIC_DIMENSION_LABELS: Record<RubricDimension, string> = {
  HUMANITY: 'Humanity',
  CLARITY: 'Clarity',
  SPOKEN_RHYTHM: 'Spoken rhythm',
  HISTORICAL_CONTEXT: 'Historical context',
  NARRATIVE_RESTRAINT: 'Narrative restraint',
  INFORMATION_DENSITY: 'Information density',
  NARRATIVE_PROGRESSION: 'Narrative progression',
  VISUAL_SEPARATION: 'Narration and pictures kept apart',
  AI_FINGERPRINT_RISK: 'AI-fingerprint risk (10 = none)',
  PRONUNCIATION_FRIENDLINESS: 'Pronunciation friendliness',
};
export const MONEY_COMPARISON_TYPE_LABELS: Record<MoneyComparisonType, string> = {
  CONTEMPORARY_WAGE: 'A contemporary wage',
  INCOME: 'An income',
  HOUSEHOLD_EXPENSE: 'A household expense',
  ASSET: 'An asset',
  MODERN_ESTIMATE: 'A modern estimate (approximate)',
};
export const BLOCK_CHANGE_STATUS_LABELS: Record<BlockChangeStatus, string> = { UNCHANGED: 'Unchanged', REWRITTEN: 'Rewritten', REMOVED: 'Removed', ADDED: 'Added' };

// ── Storyboard Engine ────────────────────────────────────────────────────────

/**
 * What a label's colour means, for the dashboard to map onto its palette:
 * nothing in particular, information, work in progress or waiting, done and
 * good, worth a look, or blocking.
 */
export type LabelTone = 'NEUTRAL' | 'INFO' | 'PENDING' | 'SUCCESS' | 'WARNING' | 'DANGER';

export const STORYBOARD_STATUS_LABELS: Record<StoryboardStatus, string> = {
  DRAFT: 'Draft (not reviewable)',
  IN_REVIEW: 'In review',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SUPERSEDED: 'Superseded',
};
export const STORYBOARD_STATUS_TONES: Record<StoryboardStatus, LabelTone> = {
  DRAFT: 'NEUTRAL',
  IN_REVIEW: 'PENDING',
  CHANGES_REQUESTED: 'WARNING',
  APPROVED: 'SUCCESS',
  REJECTED: 'DANGER',
  SUPERSEDED: 'NEUTRAL',
};

export const VISUAL_TREATMENT_LABELS: Record<VisualTreatment, string> = {
  CINEMATIC_RECONSTRUCTION: 'Cinematic reconstruction',
  GENERATED_STILL: 'Generated still',
  ARCHIVAL_IMAGE: 'Archival image',
  ARCHIVAL_VIDEO: 'Archival video',
  DOCUMENT_ANIMATION: 'Document animation',
  MAP_ANIMATION: 'Map animation',
  DATA_VISUALIZATION: 'Data visualisation',
  TIMELINE: 'Timeline',
  DIAGRAM: 'Diagram',
  INFOGRAPHIC: 'Infographic',
  PORTRAIT: 'Portrait',
  CHARACTER_VISUAL: 'Character visual',
  ENVIRONMENT: 'Environment',
  PRODUCT_OBJECT: 'Product or object',
  SCREEN_CAPTURE: 'Screen capture',
  NEWS_FOOTAGE: 'News footage',
  ABSTRACT_METAPHOR: 'Abstract metaphor',
  TEXT_ON_SCREEN: 'Text on screen',
  TRANSITION: 'Transition',
  MOTION_GRAPHIC: 'Motion graphic',
};

/** One line per treatment: what it is, for the dashboard and the planning prompt. */
export const VISUAL_TREATMENT_HELP: Record<VisualTreatment, string> = {
  CINEMATIC_RECONSTRUCTION: 'A generated moving scene that reconstructs an event or a place within the bounds of the evidence.',
  GENERATED_STILL: 'A single generated image, held or moved in the edit.',
  ARCHIVAL_IMAGE: 'A sourced historical image: a painting, print, photograph or object from a collection.',
  ARCHIVAL_VIDEO: 'Sourced historical film footage.',
  DOCUMENT_ANIMATION: 'A sourced document (letter, ledger, contract, report) shown and animated, with the relevant passage brought forward.',
  MAP_ANIMATION: 'A map drawn from named places: routes, regions, spread over time.',
  DATA_VISUALIZATION: 'A chart drawn from figures in the claims (prices, counts, changes).',
  TIMELINE: 'Dated events in order, drawn from the claims.',
  DIAGRAM: 'How something works or who is connected to whom, drawn as a structure.',
  INFOGRAPHIC: 'Figures and facts laid out together as a designed graphic.',
  PORTRAIT: 'A person: a documented likeness for a real person, a generated one only for a fictional device.',
  CHARACTER_VISUAL: 'A person in a scene, framed so that a real person is never given an invented face.',
  ENVIRONMENT: 'A place, its atmosphere and its period, without a specific event.',
  PRODUCT_OBJECT: 'An object, a product or a material shown on its own.',
  SCREEN_CAPTURE: 'A recording of a real screen, site or interface.',
  NEWS_FOOTAGE: 'Sourced news or broadcast footage.',
  ABSTRACT_METAPHOR: 'An image that stands for an idea rather than showing an event.',
  TEXT_ON_SCREEN: 'Words on screen: a quotation, a figure, a date, a question.',
  TRANSITION: 'A short visual bridge between sections or ideas.',
  MOTION_GRAPHIC: 'Designed motion (shapes, type, icons) that carries an idea.',
};

/** Treatments grouped by what kind of picture they make (for the timeline's treatment lane). */
export const VISUAL_TREATMENT_TONES: Record<VisualTreatment, LabelTone> = {
  CINEMATIC_RECONSTRUCTION: 'PENDING',
  GENERATED_STILL: 'PENDING',
  CHARACTER_VISUAL: 'PENDING',
  PORTRAIT: 'PENDING',
  ENVIRONMENT: 'PENDING',
  PRODUCT_OBJECT: 'PENDING',
  ARCHIVAL_IMAGE: 'WARNING',
  ARCHIVAL_VIDEO: 'WARNING',
  NEWS_FOOTAGE: 'WARNING',
  DOCUMENT_ANIMATION: 'WARNING',
  SCREEN_CAPTURE: 'WARNING',
  MAP_ANIMATION: 'SUCCESS',
  DATA_VISUALIZATION: 'SUCCESS',
  TIMELINE: 'SUCCESS',
  DIAGRAM: 'SUCCESS',
  INFOGRAPHIC: 'SUCCESS',
  ABSTRACT_METAPHOR: 'INFO',
  TEXT_ON_SCREEN: 'NEUTRAL',
  TRANSITION: 'NEUTRAL',
  MOTION_GRAPHIC: 'INFO',
};

export const PRODUCTION_METHOD_LABELS: Record<ProductionMethod, string> = {
  GENERATIVE_VIDEO: 'Generated video',
  IMAGE_TO_VIDEO: 'Generated still, animated',
  GENERATIVE_IMAGE: 'Generated image',
  STILL_MOTION: 'Generated still, moved in the edit',
  DETERMINISTIC_GRAPHIC: 'Graphic drawn from data',
  MAP_RENDER: 'Map render',
  DOCUMENT_MOTION: 'Sourced document, animated',
  ARCHIVAL_SOURCING: 'Archival sourcing',
  STOCK_SOURCING: 'Stock sourcing',
  SCREEN_RECORDING: 'Screen recording',
  MOTION_DESIGN: 'Motion design',
  EDIT_TIME: 'Made in the edit',
};

export const TIMING_RELATION_LABELS: Record<TimingRelation, string> = {
  TIMED_TO_NARRATION: 'Timed to the narration',
  LEAD_IN: 'Leads in',
  TAIL_OUT: 'Tails out',
  BRIDGE: 'Bridges',
};
export const TIMING_RELATION_HELP: Record<TimingRelation, string> = {
  TIMED_TO_NARRATION: 'Seen while its words are heard.',
  LEAD_IN: "Arrives under the previous shot's last words.",
  TAIL_OUT: "Holds over the next shot's first words.",
  BRIDGE: 'Crosses a block, beat or section boundary, or fills a silence.',
};

export const CONTINUITY_KIND_LABELS: Record<ContinuityKind, string> = {
  CHARACTER: 'Character',
  ENVIRONMENT: 'Environment',
  LOCATION: 'Location',
  BUILDING: 'Building',
  VEHICLE: 'Vehicle',
  OBJECT: 'Object',
  PRODUCT: 'Product',
  DOCUMENT: 'Document',
  MAP: 'Map',
  OTHER: 'Other',
};

export const STORYBOARD_SCOPE_LABELS: Record<StoryboardScope, string> = { FULL: 'Whole script', PARTIAL: 'Preview (part of the script)' };

export const STORYBOARD_DECISION_LABELS: Record<StoryboardDecisionKind, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CHANGES_REQUESTED: 'Changes requested',
  CLEARED: 'Decision cleared',
};
export const STORYBOARD_DECISION_TONES: Record<StoryboardDecisionKind, LabelTone> = { APPROVED: 'SUCCESS', REJECTED: 'DANGER', CHANGES_REQUESTED: 'WARNING', CLEARED: 'NEUTRAL' };

export const SHOT_REVIEW_STATE_LABELS: Record<ShotReviewState, string> = { PENDING: 'Not reviewed', APPROVED: 'Approved', REJECTED: 'Rejected' };
export const SHOT_REVIEW_STATE_TONES: Record<ShotReviewState, LabelTone> = { PENDING: 'NEUTRAL', APPROVED: 'SUCCESS', REJECTED: 'DANGER' };

export const SHOT_CLAIM_ROLE_LABELS: Record<ShotClaimRole, string> = {
  DEPICTS: 'Depicts',
  SHOWS_SOURCE: 'Shows the source',
  DATA: 'Data',
  CONTEXT: 'Context',
  PERIOD_BASIS: 'Period basis',
};

export const VISUAL_APPROACH_LABELS: Record<VisualApproach, string> = { A: 'Cinematic reconstruction', B: 'Evidence-led', C: 'Hybrid' };
export const VISUAL_APPROACH_HELP: Record<VisualApproach, string> = {
  A: 'Heavy reconstruction: the story told mostly in generated scenes.',
  B: 'Documents, maps, archival material and graphics carry the story.',
  C: 'Cinematic hero moments, with evidence and graphics between them.',
};

export const CUT_REASON_LABELS: Record<CutReason, string> = {
  SENTENCE_END: 'end of a sentence',
  CLAUSE: 'clause',
  BLOCK_END: 'end of a block',
  BEAT_CHANGE: 'new beat',
  SECTION_CHANGE: 'new section',
  CONCEPT_CHANGE: 'new visual idea',
  INFORMATION_CHANGE: 'new information',
  REVEAL: 'reveal',
  PAUSE: 'pause',
  TRANSITION: 'transition',
  SCOPE_EDGE: 'start or end',
};

export const CUT_POINT_KIND_LABELS: Record<CutPointKind, string> = {
  SENTENCE: 'Sentence',
  CLAUSE: 'Clause',
  BLOCK: 'Block',
  SECTION: 'Section',
  PAUSE: 'Pause',
  SCOPE_EDGE: 'Start or end',
};

export const OVERLAY_KIND_LABELS: Record<OverlayKind, string> = {
  FICTION_LABEL: 'Fiction label',
  RECONSTRUCTION_LABEL: 'Reconstruction label',
  CAPTION: 'Caption',
  QUOTE: 'Quotation',
  SOURCE_CREDIT: 'Source credit',
  DATE_STAMP: 'Date',
  LOCATION_STAMP: 'Place',
  LOWER_THIRD: 'Lower third',
};

export const UNCERTAINTY_DEVICE_LABELS: Record<UncertaintyDevice, string> = {
  NONE: 'None',
  NARRATOR_LED: 'Narrator-led',
  SOURCE_SHOWN: 'Source shown',
  COMPETING_VERSIONS: 'Competing versions',
  LABELLED_LEGEND: 'Labelled as legend',
  STYLISED_UNREAL: 'Stylised, plainly not footage',
  ABSENCE: 'The act is not shown',
};
export const UNCERTAINTY_DEVICE_HELP: Record<UncertaintyDevice, string> = {
  NONE: 'No device: for established material only.',
  NARRATOR_LED: 'The narration carries the doubt while the picture shows no disputed act.',
  SOURCE_SHOWN: 'The record itself is shown, with a traceable source.',
  COMPETING_VERSIONS: 'Two accounts side by side.',
  LABELLED_LEGEND: 'A visible label says this is the story told, not the record.',
  STYLISED_UNREAL: 'A painterly, illustrated or graphic look that never reads as footage.',
  ABSENCE: 'The scene is shown without anyone performing the disputed act.',
};

export const SUBJECT_INTERACTION_LABELS: Record<SubjectInteraction, string> = {
  NONE: 'No interaction',
  OBSERVES: 'Observes',
  NEAR: 'Near',
  SPEAKS_TO: 'Speaks to',
  TOUCHES: 'Touches',
  TRADES_WITH: 'Trades with',
  PHYSICAL_OTHER: 'Other physical interaction',
};

export const LIKENESS_MODE_LABELS: Record<LikenessMode, string> = {
  NONE: 'No face shown',
  SILHOUETTE: 'Silhouette',
  PERIOD_GENERIC: 'Unnamed period figure',
  DOCUMENTED_LIKENESS: 'Documented likeness (sourced)',
  GENERATED_LIKENESS: 'Generated likeness',
};

export const DETAIL_BASIS_LABELS: Record<DetailBasis, string> = { CLAIM: 'From a claim', PERIOD_GENERIC: 'Generic for the period', INVENTED: 'Invented' };
export const DETAIL_BASIS_TONES: Record<DetailBasis, LabelTone> = { CLAIM: 'SUCCESS', PERIOD_GENERIC: 'INFO', INVENTED: 'WARNING' };

export const EVIDENCE_RELATION_LABELS: Record<EvidenceRelation, string> = {
  DEPICTS_EVIDENCE: 'Depicts what the evidence says',
  SHOWS_SOURCE: 'Shows the source',
  VISUALISES_DATA: 'Visualises data',
  ILLUSTRATES_CONTEXT: 'Illustrates the context',
  INTERPRETS: 'Interprets',
  FICTIONAL_DEVICE: 'Fictional device',
  NONE: 'No evidence relationship',
};

export const DEPICTION_LABELS: Record<Depiction, string> = {
  RECORD: 'A record',
  RECONSTRUCTED: 'A reconstruction',
  DATA: 'Drawn from data',
  ILLUSTRATIVE: 'Illustrative',
  FICTIONAL: 'Fictional device',
};
export const DEPICTION_TONES: Record<Depiction, LabelTone> = { RECORD: 'SUCCESS', RECONSTRUCTED: 'PENDING', DATA: 'SUCCESS', ILLUSTRATIVE: 'NEUTRAL', FICTIONAL: 'WARNING' };

export const STORYBOARD_ORIGIN_LABELS: Record<StoryboardOrigin, string> = {
  GENERATED: 'Planned from the narration',
  APPROACH: 'Another approach',
  BEATS: 'Beats re-planned',
  EDIT: 'Edited',
  RETIME: 'Re-timed to new narration',
  RESTORE: 'Restored',
  PROFILE: 'Re-costed for another visual profile',
};

export const STORYBOARD_MODE_LABELS: Record<StoryboardMode, string> = { GENERATE: 'Plan the storyboard', APPROACH: 'Switch approach', BEATS: 'Re-plan beats' };

export const NARRATION_APPROVAL_LABELS: Record<NarrationApproval, string> = {
  GATE_APPROVED: 'Narration approved at the voice gate',
  TAKES_APPROVED: 'Every take approved',
  UNREVIEWED: 'Takes not all approved (provisional timing)',
};
export const NARRATION_APPROVAL_TONES: Record<NarrationApproval, LabelTone> = { GATE_APPROVED: 'SUCCESS', TAKES_APPROVED: 'SUCCESS', UNREVIEWED: 'WARNING' };

export const SPECIFIC_KIND_LABELS: Record<SpecificKind, string> = {
  CLOTHING: 'Clothing',
  UNIFORM: 'Uniform',
  ARCHITECTURE: 'Architecture',
  DOCUMENT: 'Document',
  TECHNOLOGY: 'Technology',
  OBJECT: 'Object',
  DATE: 'Date',
  PLACE: 'Place',
  PERSON: 'Person',
  OTHER: 'Other',
};

export const SHOT_TRANSITION_LABELS: Record<ShotTransition, string> = { CUT: 'Cut', DISSOLVE: 'Dissolve', FADE: 'Fade', MATCH_CUT: 'Match cut', WIPE: 'Wipe' };
export const MOTION_INTENSITY_LABELS: Record<MotionIntensity, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };
export const SUBJECT_ROLE_LABELS: Record<SubjectRole, string> = { PRIMARY: 'Primary', SECONDARY: 'Secondary', BACKGROUND: 'Background' };
export const BEAT_IMPORTANCE_LABELS: Record<BeatImportance, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', HERO: 'Hero moment' };
export const GENERATION_COMPLEXITY_LABELS: Record<GenerationComplexity, string> = { LOW: 'Simple', MEDIUM: 'Moderate', HIGH: 'Complex' };
export const VISUAL_ASSET_TYPE_LABELS: Record<VisualAssetType, string> = {
  VIDEO_CLIP: 'Video clip',
  IMAGE: 'Image',
  GRAPHIC: 'Graphic',
  DOCUMENT: 'Document',
  MAP: 'Map',
  TEXT: 'Text',
  NONE: 'No asset',
};
export const ASSET_SOURCING_LABELS: Record<AssetSourcing, string> = { GENERATE: 'Generate', SOURCE: 'Source', RENDER: 'Render', EDIT: 'Make in the edit' };
export const LICENSING_STATUS_LABELS: Record<LicensingStatus, string> = { NOT_APPLICABLE: 'No licence needed', REQUIRED: 'Licence required', UNKNOWN: 'Licence unknown' };
export const REUSE_CATEGORY_LABELS: Record<ReuseCategory, string> = {
  ENVIRONMENT: 'Environment',
  CHARACTER: 'Character',
  LOCATION: 'Location',
  DOCUMENT: 'Document',
  MAP: 'Map',
  ESTABLISHING: 'Establishing shot',
  TRANSITION: 'Transition',
  OTHER: 'Other',
};
export const PRICE_CONFIDENCE_LABELS: Record<PriceConfidence, string> = {
  LIST_PRICE: 'Published list price',
  PLAN_PRICE: 'Your plan price',
  ASSUMPTION: 'Assumption',
};
export const VISUAL_COST_BASIS_LABELS: Record<VisualCostBasis | 'MIXED', string> = {
  ESTIMATED: 'Estimate',
  UNPRICED: 'Unpriced (no verified price)',
  MOCK: 'Mock',
  MIXED: 'Estimate, part unpriced',
};

export const TREATMENT_CONDITION_LABELS: Record<TreatmentCondition, string> = {
  GROUNDED_SPECIFICS: 'every specific detail rests on a claim or is generic for the period',
  VISIBLE_DEVICE: 'a visible uncertainty device is realised in the shot',
  NO_DEPICTS: 'mood or structure only: it depicts no claim',
  SOURCED: 'a sourced record, never generated',
  UNCERTAINTY_MARKED: 'uncertain areas or items are marked',
  HEDGED_DATA: 'established or probable data, with a hedged label',
  RANGES_CAPTIONED: 'ranges or competing series, with a caption',
  DOCUMENTED_LIKENESS: 'a documented, sourced likeness',
  NON_IDENTIFYING: 'no identifiable likeness of a real person',
  VERIFIED_QUOTE: 'a quotation is a verified recorded quote',
  PRESENTATION_WORDING: "the wording follows the claim's presentation",
};

export const STORYBOARD_FINDING_LABELS: Record<StoryboardFindingKind, string> = {
  NARRATION_UNMAPPED: 'Narration not covered exactly once',
  TIMING_MISSING: 'Timing missing',
  SHOT_OVERLAP: 'Shots overlap',
  TIMELINE_GAP: 'Gap in the picture',
  DURATION_IMPOSSIBLE: 'Impossible duration',
  TREATMENT_MISSING: 'Treatment missing',
  ASSET_REQUIREMENT_MISSING: 'Asset requirement missing',
  INFO_CLASS_MISSING: 'Information class missing',
  SHOT_UNPLANNED: 'Beat could not be planned',
  EVIDENCE_MISSING: 'Factual visual without traceable evidence',
  CLAIM_INVALID: 'Claim not valid here',
  UNCERTAIN_AS_FACT: 'Uncertain material shown as fact',
  GENERATED_RECORD: 'Generated "record"',
  FICTION_IN_DOCUMENTED: 'Fictional character in a documented event',
  FICTION_REAL_INTERACTION: 'Fictional character interacting with a real person',
  FICTION_WITH_FACTS: 'Fiction carrying facts',
  INVENTED_CHARACTER: 'Invented named character',
  REAL_LIKENESS: 'Generated likeness of a real person',
  INVENTED_DETAIL_DOCUMENTED: 'Invented detail in a documented shot',
  OVERLAY_UNSUPPORTED: 'Overlay not supported by the evidence',
  FICTION_LABEL_MISSING: 'Fiction label missing',
  DEVICE_UNREALIZED: 'Uncertainty device declared but not shown',
  CONTINUITY_INVALID: 'Continuity subject not in the architecture',
  MOCK_NARRATION: 'Timed against mock narration',
  STALE_SCRIPT: 'Script no longer the approved one',
  STALE_ARCHITECTURE: 'Architecture no longer approved',
  STALE_NARRATION: 'Narration changed',
  STALE_VERDICT: 'A claim verdict changed',
  SCOPE_INCOMPLETE: 'Not the whole script',
  TREATMENT_REPETITION: 'Same treatment many times in a row',
  TREATMENT_DOMINANT: 'One treatment dominates',
  GENERATED_VIDEO_SHARE: 'Much generated video',
  DENSITY_HIGH: 'Cuts too fast for the profile',
  DENSITY_LOW: 'Cuts too slow for the profile',
  SHOT_COUNT_HIGH: 'Many shots',
  SHOT_COUNT_LOW: 'Few shots',
  RAPID_CUTS: 'Rapid cuts without a reason',
  STATIC_LONG: 'Long static shot',
  NO_VISUAL_CHANGE: 'Long narration with no visual change',
  GENERIC_BROLL: 'Long generic footage',
  UNIFORM_DURATIONS: 'Shots all the same length',
  MID_SENTENCE_CUT: 'Cut inside a sentence',
  ENVIRONMENT_REPEATED: 'Same environment again and again',
  COST_HIGH: 'Above the cost ceiling',
  COST_UNPRICED: 'Some shots unpriced',
  CONTINUITY_RISK: 'Continuity risk',
  VISUAL_IMPLICATION: 'Visual claim to check',
  ANACHRONISM_RISK: 'Possible anachronism',
  MUST_SHOW_DROPPED: 'Must-show detail dropped',
  FRAMING_FACTUAL_VISUAL: 'Factual visual over framing narration',
  PROVISIONAL_TIMING: 'Provisional timing (takes not all approved)',
  UNALIGNED_TAKE: 'Take without word timings',
  MODEL_REFERENCE_DROPPED: 'Model output corrected',
  STALE_PROFILE: 'Visual profile changed',
  STALE_PRICING: 'Prices changed',
  SCOPE_PARTIAL: 'Preview of part of the script',
};

export const VISUAL_REALISM_LABELS: Record<VisualRealism, string> = { PHOTOREAL: 'Photoreal', CINEMATIC: 'Cinematic', PAINTERLY: 'Painterly', ILLUSTRATED: 'Illustrated', GRAPHIC: 'Graphic' };
export const CAMERA_STYLE_LABELS: Record<CameraStyle, string> = { OBSERVATIONAL: 'Observational', CLASSICAL: 'Classical', HANDHELD: 'Handheld', STYLISED: 'Stylised', MINIMAL: 'Minimal' };
export const FILM_GRAIN_LABELS: Record<FilmGrain, string> = { NONE: 'None', LIGHT: 'Light', MEDIUM: 'Medium', HEAVY: 'Heavy' };
export const VISUAL_DENSITY_LABELS: Record<VisualDensity, string> = { SPARSE: 'Sparse (long shots)', BALANCED: 'Balanced', DENSE: 'Dense (short shots)' };
export const ARCHIVAL_PREFERENCE_LABELS: Record<ArchivalPreference, string> = { AVOID: 'Avoid archival', WHEN_AVAILABLE: 'Archival when available', PREFER: 'Prefer archival' };
export const GRAPHICS_PREFERENCE_LABELS: Record<GraphicsPreference, string> = { MINIMAL: 'Minimal graphics', BALANCED: 'Balanced graphics', RICH: 'Rich graphics' };
/** How a project's visual profile version was chosen. */
export const VISUAL_SELECTION_MODE_LABELS: Record<VisualSelectionMode, string> = {
  FOLLOW: 'follows the current version',
  PIN: 'pinned to a version',
  DEFAULT: 'library default',
};
export const VISUAL_CONFIG_SOURCE_LABELS: Record<VisualConfigSource, string> = { PROFILE: 'profile', PROJECT: 'project' };
/** How a visual profile version was made. */
export const VISUAL_PROFILE_ORIGIN_LABELS: Record<VisualProfileOrigin['kind'], string> = {
  PRESET: 'a seeded preset',
  DEFAULTS: 'made from the defaults',
  LIBRARY: 'made in the library',
  EDIT: 'an edit',
  DUPLICATE: 'a duplicate',
};
