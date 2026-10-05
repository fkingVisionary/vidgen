/**
 * Domain enumerations.
 *
 * These are the single source of truth for the TypeScript side. The Prisma
 * schema declares the same enums for the database; `packages/database`
 * contains a test that fails if the two ever drift apart.
 *
 * Arrays are declared `as const` so they can drive both runtime validation
 * (zod) and static types.
 */

/**
 * Coarse, linear status of the *master* production pipeline of a project.
 * Statuses are phases, not "a job is running right now": a project can sit in
 * SCRIPT_DRAFT for a day while a human edits the script.
 *
 * Order matters: it is the canonical order used for progress and rewinds.
 */
export const PROJECT_STATUSES = [
  'IDEA',
  'RESEARCHING',
  'RESEARCH_REVIEW', // human approval gate #1 (research dossier)
  'RESEARCH_COMPLETE',
  'STORY_MINING', // mining the approved dossier for story candidates
  'STORY_SELECTION', // the editor curates candidates and the documentary selection
  'STORY_ARCHITECTING',
  'STORY_REVIEW', // human approval gate #2 (story architecture)
  'STORY_APPROVED',
  'SCRIPT_DRAFT',
  'SCRIPT_REVIEW', // human approval gate #3 (script)
  'SCRIPT_APPROVED',
  'VOICE_GENERATING',
  'VOICE_COMPLETE',
  'VISUAL_PLANNING',
  'STORYBOARD_REVIEW', // human approval gate #4 (storyboard) — before any paid generation
  'VISUAL_GENERATING',
  'VISUAL_REVIEW', // review of generated assets
  'EDITING',
  'RENDERING',
  'QA', // automated QA report + human approval gate #6 (final video)
  'APPROVED',
  'PUBLISHED',
  'FAILED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Units of work. Each runs in exactly one project status (see pipeline.ts). */
export const JOB_TYPES = [
  'RESEARCH',
  'STORY_MINING',
  'STORY_ARCHITECTURE',
  /** Side job: alternative narrative angles from the curated story pack (see SIDE_JOBS). */
  'STORY_ANGLES',
  'SCRIPT',
  'VOICE',
  'VISUAL_PLAN',
  'VISUAL_GENERATION',
  'INFOGRAPHIC',
  'EDIT',
  'RENDER',
  'QA',
  'PUBLISH',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Dashboard stages. Derived from ProjectStatus; never stored. */
export const STAGES = [
  'RESEARCH',
  'STORY',
  'SCRIPT',
  'VOICE',
  'STORYBOARD',
  'ASSETS',
  'TIMELINE',
  'QA',
  'FINAL',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_STATES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'COMPLETE',
  'FAILED',
] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** Points where a human must approve before the pipeline moves on. */
export const APPROVAL_GATES = [
  'RESEARCH',
  'STORY',
  'SCRIPT',
  'STORYBOARD',
  'VISUAL_ASSETS',
  'FINAL_VIDEO',
] as const;
export type ApprovalGate = (typeof APPROVAL_GATES)[number];

/**
 * Recorded human decisions. EDIT and REGENERATE from the brief are *actions*
 * (create a new artifact version / enqueue a job), not decisions, so they are
 * not stored here.
 */
export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED', 'FLAGGED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Lifecycle of a versioned creative artifact (dossier, story, script, storyboard, timeline). */
export const ARTIFACT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  'PRIMARY',
  'ACADEMIC',
  'BOOK',
  'ARCHIVE',
  'REPUTABLE_SECONDARY', // quality journalism, museums' popular pages, established publishers
  'GENERAL_REFERENCE', // encyclopedias and reference works (Wikipedia, Britannica)
  'GENERAL_WEB', // blogs, SEO/history-content sites, forums — lowest tier
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Source types strong enough to anchor key claims on their own. */
export const HIGH_TIER_SOURCE_TYPES: readonly SourceType[] = ['PRIMARY', 'ACADEMIC', 'BOOK', 'ARCHIVE'];

/** Lower number = stronger source. Used to rank and to measure diversity. */
export const SOURCE_TIER: Record<SourceType, 1 | 2 | 3 | 4> = {
  PRIMARY: 1,
  ACADEMIC: 1,
  BOOK: 1,
  ARCHIVE: 1,
  REPUTABLE_SECONDARY: 2,
  GENERAL_REFERENCE: 3,
  GENERAL_WEB: 4,
};

export const RETRIEVAL_STATUSES = ['PENDING', 'RETRIEVED', 'FAILED'] as const;
export type RetrievalStatus = (typeof RETRIEVAL_STATUSES)[number];

/**
 * Where a claim stands against the evidence. This is how the documentary
 * separates WHAT WE KNOW from WHAT IS COMMONLY CLAIMED.
 */
export const CLAIM_VERDICTS = [
  'ESTABLISHED', // well supported by reliable sources
  'PROBABLE', // supported, but thinly or indirectly
  'DISPUTED', // credible sources/historians disagree
  'UNVERIFIED', // not yet checked — must not be narrated as fact
  'MYTH', // commonly claimed but contradicted by the evidence
] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CLAIM_TYPES = [
  'EVENT',
  'DATE',
  'ECONOMIC_FIGURE', // prices, volumes, wages — require evidence
  'PERSON',
  'QUOTE',
  'INTERPRETATION',
  'CONTEXT',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** How a source relates to a claim. A myth is typically SUPPORTED by a popular source and CONTRADICTED by an archival one. */
export const CITATION_STANCES = ['SUPPORTS', 'CONTRADICTS', 'CONTEXT'] as const;
export type CitationStance = (typeof CITATION_STANCES)[number];

/** KEY claims carry the documentary; they face the strictest evidence checks. */
export const CLAIM_IMPORTANCES = ['KEY', 'SUPPORTING', 'BACKGROUND'] as const;
export type ClaimImportance = (typeof CLAIM_IMPORTANCES)[number];

/** FULL_TEXT: the quote comes from the retrieved document. SNIPPET: search-engine snippet only. */
export const CITATION_BASES = ['FULL_TEXT', 'SNIPPET'] as const;
export type CitationBasis = (typeof CITATION_BASES)[number];

// ---------------------------------------------------------------------------
// Story (mining + architecture)
// ---------------------------------------------------------------------------

/** What kind of story unit a candidate is. */
export const STORY_TYPES = [
  'CHARACTER',
  'DEAL',
  'MARKET_EVENT',
  'FORTUNE',
  'SCAM',
  'CONFLICT',
  'REVERSAL',
  'MYSTERY',
  'MYTH_ORIGIN',
  'DISCOVERY',
  'DISASTER',
  'SOCIAL_PHENOMENON',
] as const;
export type StoryType = (typeof STORY_TYPES)[number];

/**
 * How a story unit stands against the evidence, derived in code from the
 * verdicts of the claims it is built on (never chosen by the model).
 */
export const HISTORICAL_STATUSES = [
  'ESTABLISHED', // every claim ESTABLISHED
  'PROBABLE', // ESTABLISHED/PROBABLE only
  'CONTESTED', // rests partly on DISPUTED claims: must be told as a dispute
  'UNCERTAIN', // rests partly on UNVERIFIED claims: must be told as an open question
  'MYTH_INVESTIGATION', // built around a MYTH: told as popular story → origin → what happened
] as const;
export type HistoricalStatus = (typeof HISTORICAL_STATUSES)[number];

/** The editor's decision on a story candidate. Only a human sets anything but PROPOSED. */
export const CANDIDATE_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'FLAGGED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** The editor's priority for a story unit: HIGH units must be central to the architecture. */
export const CANDIDATE_PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;
export type CandidatePriority = (typeof CANDIDATE_PRIORITIES)[number];

/** Who a story character is. Only NAMED_PERSON needs a name found in the evidence. */
export const CHARACTER_KINDS = ['NAMED_PERSON', 'GROUP', 'ROLE'] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

// ---------------------------------------------------------------------------
// Story Engine 2.0 (cinematic storytelling inside the evidence boundary)
// ---------------------------------------------------------------------------

/** Generation of the story engine that produced a pack or an architecture (1: M3, 2: Story Engine 2.0). */
export const STORY_ENGINE_VERSIONS = [1, 2] as const;
export type StoryEngineVersion = (typeof STORY_ENGINE_VERSIONS)[number];
export const CURRENT_STORY_ENGINE: StoryEngineVersion = 2;

/** How a documentary, a sequence or a story unit is told. Chosen to fit the evidence and the human story. */
export const NARRATIVE_MODES = [
  'IMMERSIVE_RECONSTRUCTION', // the viewer is placed inside a reconstructed scene
  'CHARACTER_FOLLOW', // follow one person or group through events
  'HISTORICAL_MYSTERY', // an unexplained question drives the telling
  'INVESTIGATION', // the telling follows how the truth was found
  'COUNTDOWN', // events race towards a known moment
  'SURVIVAL', // someone struggles to get through
  'CONFLICT', // two sides, one dispute
  'RISE_AND_FALL', // fortune made and lost
  'HEIST_OPERATION', // a plan, its execution and what went wrong
  'JOURNEY', // movement through places or stages
  'COURTROOM_DISPUTE', // claims, evidence and a ruling
  'DISCOVERY', // how something came to be known
  'MYTH_VS_RECORD', // the popular story tested against the record
  'PARALLEL_TIMELINE', // two times told side by side
  'CAUSE_AND_EFFECT', // a chain of decisions and consequences
] as const;
export type NarrativeMode = (typeof NARRATIVE_MODES)[number];

/**
 * What kind of information a story beat is. The research dossier is the fact
 * boundary; creative freedom applies to presentation, never to the facts.
 */
export const INFORMATION_CLASSES = [
  'DOCUMENTED', // directly supported by ESTABLISHED claims: may be stated as fact
  'RECONSTRUCTION', // a plausible scene built from documented circumstances; never presented as a recorded event
  'UNCERTAIN', // rests on PROBABLE, DISPUTED, UNVERIFIED or MYTH claims: told with its presentation instruction
  'FICTION', // a declared narrative device (POV, composite, invented dialogue or sensory detail); carries no facts
] as const;
export type InformationClass = (typeof INFORMATION_CLASSES)[number];

/** The dramatic job of a beat. A framework, not a template: sequences use what the story needs. */
export const BEAT_FUNCTIONS = [
  'COLD_OPEN',
  'ORIENTATION',
  'STAKES',
  'CONFLICT',
  'ESCALATION',
  'TURN',
  'REVEAL',
  'CONSEQUENCE',
  'INVESTIGATION',
  'TRANSITION',
] as const;
export type BeatFunction = (typeof BEAT_FUNCTIONS)[number];

/** Who appears in an architecture. Fictional kinds are narrative devices and are always labelled as such. */
export const CAST_KINDS = [
  'POV_PROXY', // "you": a fictional viewer proxy, never a historical person
  'FICTIONAL_COMPOSITE', // an invented character standing for documented people of a kind
  'REAL_PERSON', // a named person from the evidence
  'REAL_GROUP', // a group from the evidence ("the buyers")
  'REAL_ROLE', // a role from the evidence ("a notary")
] as const;
export type CastKind = (typeof CAST_KINDS)[number];
export const FICTIONAL_CAST_KINDS: readonly CastKind[] = ['POV_PROXY', 'FICTIONAL_COMPOSITE'];

/** Whose eyes the documentary is told through. */
export const POV_STRATEGIES = [
  'VIEWER_POV', // second person: the viewer is placed in the scene
  'COMPANION', // the viewer follows a fictional composite companion
  'CHARACTER_FOLLOW', // the camera follows a real person or group
  'INVESTIGATOR', // the narrator investigates, revealing the record step by step
  'NARRATOR', // no POV device
] as const;
export type PovStrategy = (typeof POV_STRATEGIES)[number];

/** How the narration must present a claim, set by its verdict (see PRESENTATION_FOR_VERDICT). */
export const PRESENTATIONS = ['STATE', 'HEDGE', 'PRESENT_AS_DISPUTED', 'PRESENT_AS_UNCONFIRMED', 'INVESTIGATE_AS_MYTH'] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

/** A line of speech: a verified quotation from the record, or an invented line for a fictional character. */
export const SPEECH_KINDS = ['RECORDED_QUOTE', 'INVENTED'] as const;
export type SpeechKind = (typeof SPEECH_KINDS)[number];

/** How far a sequence moves in time from the one before it. */
export const TIME_JUMPS = ['NONE', 'FORWARD', 'FLASHBACK', 'PARALLEL'] as const;
export type TimeJump = (typeof TIME_JUMPS)[number];

/** Share of reconstruction and fiction in a telling (computed for architectures, estimated for candidates). */
export const RECONSTRUCTION_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type ReconstructionLevel = (typeof RECONSTRUCTION_LEVELS)[number];

// ---------------------------------------------------------------------------
// Content opportunities (the content package: long-form + short-form)
// ---------------------------------------------------------------------------

/** What an opportunity found in an approved architecture could become. */
export const CONTENT_FORMATS = ['LONG_FORM', 'SHORT', 'BOTH'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** The editor's decision on a content opportunity. Only a human sets anything but PROPOSED. */
export const OPPORTUNITY_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Editorial revision loop and alternative angles
// ---------------------------------------------------------------------------

/** What the editor says is not working in an architecture: the checklist of a revision brief. */
export const REVISION_ASPECTS = ['ANGLE', 'POV', 'EMOTIONAL_CENTRE', 'OPENING', 'STRUCTURE', 'PACING', 'NARRATIVE_STRATEGY', 'CENTRAL_QUESTION', 'HUMAN_STAKES'] as const;
export type RevisionAspect = (typeof REVISION_ASPECTS)[number];

/** Where a revision changed the architecture, in the architect's change log. */
export const CHANGE_AREAS = [...REVISION_ASPECTS, 'UNITS', 'EVIDENCE', 'OTHER'] as const;
export type ChangeArea = (typeof CHANGE_AREAS)[number];

/** How an architecture version came about: built from the selection, or a revision of an earlier version. */
export const ARCHITECTURE_ORIGINS = ['NEW', 'REVISION'] as const;
export type ArchitectureOrigin = (typeof ARCHITECTURE_ORIGINS)[number];

// ---------------------------------------------------------------------------
// Script Engine
// ---------------------------------------------------------------------------

export const SCRIPT_ENGINE_VERSIONS = [1] as const;
export type ScriptEngineVersion = (typeof SCRIPT_ENGINE_VERSIONS)[number];

/**
 * The information class of a narration block: the architecture's four, plus
 * FRAMING for the narrator's own connective lines (a question, a turn, a
 * signpost), which carry no facts at all.
 */
export const SCRIPT_BLOCK_CLASSES = [...INFORMATION_CLASSES, 'FRAMING'] as const;
export type ScriptBlockClass = (typeof SCRIPT_BLOCK_CLASSES)[number];

/** Performance metadata. Used where it changes the delivery, not on every block. */
export const DELIVERY_PACES = ['SLOW', 'NORMAL', 'FAST'] as const;
export type DeliveryPace = (typeof DELIVERY_PACES)[number];
export const DELIVERY_ENERGIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DeliveryEnergy = (typeof DELIVERY_ENERGIES)[number];
export const DELIVERY_EMOTIONS = ['NEUTRAL', 'TENSE', 'CURIOUS', 'SOMBER', 'EXCITED', 'REFLECTIVE'] as const;
export type DeliveryEmotion = (typeof DELIVERY_EMOTIONS)[number];
/** Stress on a word or phrase (no entry = no emphasis). */
export const EMPHASIS_LEVELS = ['LIGHT', 'STRONG'] as const;
export type EmphasisLevel = (typeof EMPHASIS_LEVELS)[number];

/** Semantic pauses: placed for a reason, never after every sentence. */
export const PAUSE_LENGTHS = ['NONE', 'MICRO', 'SHORT', 'MEDIUM', 'LONG'] as const;
export type PauseLength = (typeof PAUSE_LENGTHS)[number];
export const PAUSE_REASONS = ['REVEAL', 'NUMBER', 'EMOTIONAL_TURN', 'TRANSITION', 'IMPACT', 'QUESTION', 'RHYTHM'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** What the viewer should see while a block is heard: a handoff to the future storyboard, not a visual plan. */
export const VISUAL_INTENTS = [
  'CINEMATIC_RECONSTRUCTION',
  'DOCUMENT',
  'MAP',
  'DATA',
  'TIMELINE',
  'ARCHIVAL',
  'PORTRAIT',
  'ENVIRONMENT',
  'ABSTRACT_METAPHOR',
  'ON_SCREEN_TEXT',
  'NONE',
] as const;
export type VisualIntent = (typeof VISUAL_INTENTS)[number];
export const VISUAL_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type VisualPriority = (typeof VISUAL_PRIORITIES)[number];

/** The editor's decision on one section of a script version. */
export const SECTION_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SectionReviewStatus = (typeof SECTION_REVIEW_STATUSES)[number];

/** How a script version came about. */
export const SCRIPT_ORIGINS = [
  'DRAFT', // written from the approved architecture
  'SECTIONS', // a version with some sections rewritten (the rest copied unchanged)
  'REVISION', // the whole script rewritten from the editor's brief
  'RESTORE', // a copy of an earlier version, made current again (no model calls)
  'REFINEMENT', // the whole script's narration rewritten for the ear; story, structure and evidence unchanged
] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** Who proposed a change to a script version during its run. */
export const SCRIPT_REVIEWERS = ['SCRIPT_EDITOR', 'FACT_CHECKER', 'PERFORMANCE'] as const;
export type ScriptReviewer = (typeof SCRIPT_REVIEWERS)[number];
/** What a proposed change does: a block's text or evidence, a block removed or added, or performance timing. */
export const SCRIPT_CHANGE_TYPES = ['EDIT', 'REMOVE', 'INSERT', 'PERFORMANCE'] as const;
export type ScriptChangeType = (typeof SCRIPT_CHANGE_TYPES)[number];
/** What became of a proposed change: each is judged on its own. */
export const SCRIPT_CHANGE_STATUSES = ['ACCEPTED', 'REJECTED', 'SKIPPED'] as const;
export type ScriptChangeStatus = (typeof SCRIPT_CHANGE_STATUSES)[number];

/** How sure a pronunciation note is. Anything below HIGH is flagged for human review. */
export const PRONUNCIATION_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type PronunciationConfidence = (typeof PRONUNCIATION_CONFIDENCES)[number];

// ---------------------------------------------------------------------------
// Visuals, infographics, media
// ---------------------------------------------------------------------------

export const VISUAL_TYPES = [
  'CINEMATIC_RECONSTRUCTION',
  'ARCHIVAL_STYLE',
  'MAP',
  'INFOGRAPHIC',
  'DOCUMENT',
  'COIN_CLOSEUP',
  'ENVIRONMENT',
  'CHARACTER',
  'MACRO',
  'ABSTRACT',
  'TEXT',
  'CHART',
] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

export const SHOT_TYPES = [
  'EXTREME_WIDE',
  'WIDE',
  'MEDIUM',
  'CLOSE_UP',
  'EXTREME_CLOSE_UP',
  'MACRO',
  'OVERHEAD',
  'INSERT',
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export const CAMERA_MOTIONS = [
  'STATIC',
  'PUSH_IN',
  'PULL_OUT',
  'PAN',
  'TILT',
  'TRACKING',
  'DOLLY',
  'CRANE',
  'HANDHELD',
  'ORBIT',
] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

export const SHOT_STATUSES = [
  'PLANNED',
  'GENERATING',
  'GENERATED',
  'APPROVED',
  'REJECTED',
  'FAILED',
] as const;
export type ShotStatus = (typeof SHOT_STATUSES)[number];

/** Deterministically rendered graphics. Never generated as AI images. */
export const INFOGRAPHIC_TYPES = [
  'LINE_CHART',
  'BAR_CHART',
  'TIMELINE',
  'MAP',
  'FLOW_DIAGRAM',
  'NUMBER_COUNTER',
  'COMPARISON',
  'PRICE_CHANGE',
  'ECONOMIC_CYCLE',
] as const;
export type InfographicType = (typeof INFOGRAPHIC_TYPES)[number];

export const ASSET_KINDS = [
  'NARRATION_AUDIO',
  'IMAGE',
  'VIDEO_CLIP',
  'INFOGRAPHIC',
  'MUSIC',
  'SFX',
  'AMBIENCE',
  'SUBTITLE',
  'RENDER',
  'DOCUMENT',
  'OTHER',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const RENDER_STATUSES = ['QUEUED', 'RENDERING', 'SUCCEEDED', 'FAILED'] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/** QA categories from the brief. Scores are 0–100. */
export const QA_CATEGORIES = [
  'HISTORICAL_ACCURACY',
  'SCRIPT_QUALITY',
  'AUDIO_QUALITY',
  'VISUAL_QUALITY',
  'CONTINUITY',
  'INFOGRAPHIC_ACCURACY',
  'TIMING',
  'SUBTITLE_ALIGNMENT',
  'TECHNICAL_RENDER',
  'MISSING_ASSETS',
] as const;
export type QaCategory = (typeof QA_CATEGORIES)[number];

/** Script-level QA scores (audio-first quality bar). */
export const SCRIPT_SCORES = [
  'NARRATIVE_SCORE',
  'AUDIO_FLOW_SCORE',
  'CLARITY_SCORE',
  'EMOTIONAL_SCORE',
  'ENDING_SCORE',
] as const;
export type ScriptScore = (typeof SCRIPT_SCORES)[number];

// ---------------------------------------------------------------------------
// Providers & localization
// ---------------------------------------------------------------------------

/** Capability slots that a vendor implementation plugs into. */
export const PROVIDER_KINDS = [
  'AI',
  'RESEARCH',
  'VOICE',
  'VIDEO',
  'STORAGE',
  'RENDER',
  'PUBLISHING',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_CALL_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type ProviderCallStatus = (typeof PROVIDER_CALL_STATUSES)[number];

/** Where a recorded cost comes from. Costs are never invented: no rate → UNPRICED. */
export const COST_BASES = ['VENDOR_REPORTED', 'ESTIMATED', 'UNPRICED', 'MOCK'] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const LANGUAGE_VERSION_STATUSES = [
  'PLANNED',
  'IN_PRODUCTION',
  'READY',
  'PUBLISHED',
  'FAILED',
] as const;
export type LanguageVersionStatus = (typeof LANGUAGE_VERSION_STATUSES)[number];
