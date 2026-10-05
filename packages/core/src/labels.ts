import type { HistoricalValueKey, OpportunityScoreKey, StoryScoreKey, StoryValueKey } from './contracts/story.ts';
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
  GENERATED: 'To review',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  SUPERSEDED: 'Superseded',
};
export const PERFORMANCE_STRATEGY_LABELS: Record<PerformanceStrategy, string> = { PLAIN: 'Plain text', RESTRAINED: 'Restrained (house style)', DIRECTED: 'Over-directed (comparison only)' };
export const PERFORMANCE_STRATEGY_HELP: Record<PerformanceStrategy, string> = {
  PLAIN: 'No performance directions: the voice reads the words as written.',
  RESTRAINED: "A few directions, only where the script's delivery changes — a documentary narrator, not an audiobook character.",
  DIRECTED: 'A direction on every sentence — kept to hear what over-direction sounds like, never the default.',
};
export const CHUNK_BOUNDARY_LABELS: Record<ChunkBoundary, string> = { SECTION_END: 'section end', SPEAKER: 'change of speaker', PAUSE: 'scripted pause', PERFORMANCE: 'change of delivery', PARAGRAPH: 'paragraph end', SENTENCE: 'sentence end' };
export const PRONUNCIATION_STATUS_LABELS: Record<PronunciationStatus, string> = { PENDING: 'To check', APPROVED: 'Approved', FLAGGED: 'Heard wrong' };
export const PRONUNCIATION_METHOD_LABELS: Record<PronunciationMethod, string> = { DEFAULT: "The voice's own reading", ALIAS: 'Say it as (alias)', IPA: 'Phonemes (IPA)', CMU: 'Phonemes (CMU Arpabet)' };
export const PRONUNCIATION_TERM_KIND_LABELS: Record<PronunciationTermKind, string> = { NAME: 'Name', PLACE: 'Place', ORGANISATION: 'Organisation', FOREIGN: 'Foreign word', TERM: 'Term', ABBREVIATION: 'Abbreviation' };
