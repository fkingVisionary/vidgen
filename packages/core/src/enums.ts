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
  'VOICE_REVIEW', // human approval gate (assembled narration of the approved script)
  'VOICE_COMPLETE',
  'VISUAL_PLANNING',
  'STORYBOARD_REVIEW', // human approval gate #4 (storyboard) — before any paid generation
  'STORYBOARD_APPROVED', // a milestone: visual generation is a separate, human-initiated start
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
  /** Side job: a storyboard of part of the script, timed by a narration that is not the approved whole (see SIDE_JOBS). */
  'STORYBOARD_PREVIEW',
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
  'VOICE',
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
  'NARRATION', // the Human Narration Pass on an earlier version: targeted edits, every block's evidence kept (Writing Engine 2)
] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** Who proposed a change to a script version during its run. */
export const SCRIPT_REVIEWERS = ['SCRIPT_EDITOR', 'FACT_CHECKER', 'PERFORMANCE', 'NARRATION'] as const;
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
// Voice
// ---------------------------------------------------------------------------

/** What a voice run narrates: the opening (audition), one section, chosen blocks, a range of blocks, or the whole script. */
export const VOICE_RUN_KINDS = ['AUDITION', 'SECTION', 'BLOCKS', 'RANGE', 'FULL'] as const;
export type VoiceRunKind = (typeof VOICE_RUN_KINDS)[number];

/**
 * Lifecycle of one take of one chunk. Takes are never deleted: a newer current take supersedes the one before.
 * IN_REVIEW is a chunk's current take awaiting a human decision; GENERATED is stored audio that is not
 * current (an A/B variant). A current GENERATED take (made before IN_REVIEW existed) reads as IN_REVIEW.
 */
export const VOICE_GENERATION_STATUSES = ['PENDING', 'GENERATING', 'GENERATED', 'IN_REVIEW', 'FAILED', 'REJECTED', 'APPROVED', 'SUPERSEDED'] as const;
export type VoiceGenerationStatus = (typeof VOICE_GENERATION_STATUSES)[number];

/**
 * How much performance direction goes to the voice: none (plain text), the
 * house style (a few marks where the script's delivery changes), the house
 * style plus at most one deliberate moment per chunk where the script turns
 * (a reveal, an impact, an emotional turn), or over-directed (a mark on every
 * sentence — for comparison only).
 */
export const PERFORMANCE_STRATEGIES = ['PLAIN', 'RESTRAINED', 'EXPRESSIVE', 'DIRECTED'] as const;
export type PerformanceStrategy = (typeof PERFORMANCE_STRATEGIES)[number];

/** Why a chunk ends where it does. PURPOSE: the information class changes (into or out of fiction above all). */
export const CHUNK_BOUNDARIES = ['SECTION_END', 'SPEAKER', 'PURPOSE', 'PAUSE', 'PERFORMANCE', 'PARAGRAPH', 'SENTENCE'] as const;
export type ChunkBoundary = (typeof CHUNK_BOUNDARIES)[number];

/** A term in the pronunciation review list: still to check, confirmed, or heard wrong in an audition. */
export const PRONUNCIATION_STATUSES = ['PENDING', 'APPROVED', 'FLAGGED'] as const;
export type PronunciationStatus = (typeof PRONUNCIATION_STATUSES)[number];
/** How a term is said: the voice's own reading, a spoken alias, or phonemes (IPA or CMU Arpabet). */
export const PRONUNCIATION_METHODS = ['DEFAULT', 'ALIAS', 'IPA', 'CMU'] as const;
export type PronunciationMethod = (typeof PRONUNCIATION_METHODS)[number];
export const PRONUNCIATION_TERM_KINDS = ['NAME', 'PLACE', 'ORGANISATION', 'FOREIGN', 'TERM', 'ABBREVIATION'] as const;
export type PronunciationTermKind = (typeof PRONUNCIATION_TERM_KINDS)[number];

/** Written forms the narrator must not read as written: they are given a spoken form before generation. */
export const SPOKEN_FORM_KINDS = ['YEAR', 'DECADE', 'NUMBER', 'CURRENCY', 'ORDINAL', 'DATE', 'PERCENT', 'DECIMAL', 'RANGE', 'ABBREVIATION', 'ALIAS'] as const;
export type SpokenFormKind = (typeof SPOKEN_FORM_KINDS)[number];

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

/** Frame shapes a visual can be produced in. */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '21:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

// ---------------------------------------------------------------------------
// Storyboard Engine (what the viewer sees, when, why, and how it is produced)
// ---------------------------------------------------------------------------

export const STORYBOARD_ENGINE_VERSIONS = [1] as const;
export type StoryboardEngineVersion = (typeof STORYBOARD_ENGINE_VERSIONS)[number];

/**
 * Lifecycle of one storyboard version. Every version is saved IN_REVIEW
 * (DRAFT: a stale phase run, never reviewable); SUPERSEDED is set by a newer
 * save (or, for an APPROVED version, a newer approval), never by a decision.
 */
export const STORYBOARD_STATUSES = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type StoryboardStatus = (typeof STORYBOARD_STATUSES)[number];

/**
 * How a shot is shown, chosen by what the story needs (provider-neutral; a
 * later router maps a treatment to a production method and a provider).
 */
export const VISUAL_TREATMENTS = [
  'CINEMATIC_RECONSTRUCTION',
  'GENERATED_STILL',
  'ARCHIVAL_IMAGE',
  'ARCHIVAL_VIDEO',
  'DOCUMENT_ANIMATION',
  'MAP_ANIMATION',
  'DATA_VISUALIZATION',
  'TIMELINE',
  'DIAGRAM',
  'INFOGRAPHIC',
  'PORTRAIT',
  'CHARACTER_VISUAL',
  'ENVIRONMENT',
  'PRODUCT_OBJECT',
  'SCREEN_CAPTURE',
  'NEWS_FOOTAGE',
  'ABSTRACT_METAPHOR',
  'TEXT_ON_SCREEN',
  'TRANSITION',
  'MOTION_GRAPHIC',
] as const;
export type VisualTreatment = (typeof VISUAL_TREATMENTS)[number];

/** How a treatment's asset comes to exist: generated, sourced, rendered in-house, or made in the edit. */
export const PRODUCTION_METHODS = [
  'GENERATIVE_VIDEO',
  'IMAGE_TO_VIDEO', // a generated still, then animated by a video model
  'GENERATIVE_IMAGE',
  'STILL_MOTION', // a generated still moved in the edit (push-in, parallax)
  'DETERMINISTIC_GRAPHIC', // charts, timelines and diagrams drawn from data
  'MAP_RENDER',
  'DOCUMENT_MOTION', // a sourced document, animated
  'ARCHIVAL_SOURCING',
  'STOCK_SOURCING',
  'SCREEN_RECORDING',
  'MOTION_DESIGN',
  'EDIT_TIME', // text, transitions and overlays made in the edit
] as const;
export type ProductionMethod = (typeof PRODUCTION_METHODS)[number];

/** Methods whose picture is generated by a model (and so is never a record). */
export const GENERATIVE_METHODS: readonly ProductionMethod[] = ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO', 'GENERATIVE_IMAGE', 'STILL_MOTION'];
/** Methods that produce generated video footage (the share the profile caps). */
export const GENERATED_VIDEO_METHODS: readonly ProductionMethod[] = ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO'];
/** Methods that obtain an existing record or footage instead of making one. */
export const SOURCING_METHODS: readonly ProductionMethod[] = ['ARCHIVAL_SOURCING', 'STOCK_SOURCING', 'DOCUMENT_MOTION', 'SCREEN_RECORDING'];

/** How a shot's picture relates to the narration under it (brief §14: every overlap is explicit). */
export const TIMING_RELATIONS = ['TIMED_TO_NARRATION', 'LEAD_IN', 'TAIL_OUT', 'BRIDGE'] as const;
export type TimingRelation = (typeof TIMING_RELATIONS)[number];

/** What a recurring continuity subject is. */
export const CONTINUITY_KINDS = ['CHARACTER', 'ENVIRONMENT', 'LOCATION', 'BUILDING', 'VEHICLE', 'OBJECT', 'PRODUCT', 'DOCUMENT', 'MAP', 'OTHER'] as const;
export type ContinuityKind = (typeof CONTINUITY_KINDS)[number];

/** FULL: the whole approved script; PARTIAL: a preview of part of it (never eligible for the STORYBOARD gate). */
export const STORYBOARD_SCOPES = ['FULL', 'PARTIAL'] as const;
export type StoryboardScope = (typeof STORYBOARD_SCOPES)[number];

/** A person's decision on a storyboard version or one shot. Append-only; CLEARED withdraws a shot decision. */
export const STORYBOARD_DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CLEARED'] as const;
export type StoryboardDecisionKind = (typeof STORYBOARD_DECISIONS)[number];

/**
 * What a claim does for a shot: the picture depicts it, shows its source,
 * draws its data, sets its context, or grounds its period details.
 */
export const SHOT_CLAIM_ROLES = ['DEPICTS', 'SHOWS_SOURCE', 'DATA', 'CONTEXT', 'PERIOD_BASIS'] as const;
export type ShotClaimRole = (typeof SHOT_CLAIM_ROLES)[number];

/** A shot's review state: its latest decision (PENDING when it has none, or it was CLEARED). */
export const SHOT_REVIEW_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ShotReviewState = (typeof SHOT_REVIEW_STATES)[number];

/** Alternative visual approaches (§23): A cinematic reconstruction, B evidence-led, C hybrid. */
export const VISUAL_APPROACHES = ['A', 'B', 'C'] as const;
export type VisualApproach = (typeof VISUAL_APPROACHES)[number];

/** Why a cut falls where it does. A sentence is never split to hit a duration. */
export const CUT_REASONS = [
  'SENTENCE_END',
  'CLAUSE',
  'BLOCK_END',
  'BEAT_CHANGE',
  'SECTION_CHANGE',
  'CONCEPT_CHANGE',
  'INFORMATION_CHANGE',
  'REVEAL',
  'PAUSE',
  'TRANSITION',
  'SCOPE_EDGE',
] as const;
export type CutReason = (typeof CUT_REASONS)[number];

/** Where a cut may fall on the narration: the only places offered to the model. */
export const CUT_POINT_KINDS = ['SENTENCE', 'CLAUSE', 'BLOCK', 'SECTION', 'PAUSE', 'SCOPE_EDGE'] as const;
export type CutPointKind = (typeof CUT_POINT_KINDS)[number];

/** Text and labels laid over a shot. */
export const OVERLAY_KINDS = ['FICTION_LABEL', 'RECONSTRUCTION_LABEL', 'CAPTION', 'QUOTE', 'SOURCE_CREDIT', 'DATE_STAMP', 'LOCATION_STAMP', 'LOWER_THIRD'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

/** How a picture keeps uncertain material from looking certain. Each must be realised in the shot, not only declared. */
export const UNCERTAINTY_DEVICES = ['NONE', 'NARRATOR_LED', 'SOURCE_SHOWN', 'COMPETING_VERSIONS', 'LABELLED_LEGEND', 'STYLISED_UNREAL', 'ABSENCE'] as const;
export type UncertaintyDevice = (typeof UNCERTAINTY_DEVICES)[number];

/** How one subject in a shot relates to another (a fictional subject may only observe or be near a real one). */
export const SUBJECT_INTERACTIONS = ['NONE', 'OBSERVES', 'NEAR', 'SPEAKS_TO', 'TOUCHES', 'TRADES_WITH', 'PHYSICAL_OTHER'] as const;
export type SubjectInteraction = (typeof SUBJECT_INTERACTIONS)[number];

/** How a person's face is shown. A real person is never given a generated likeness. */
export const LIKENESS_MODES = ['NONE', 'SILHOUETTE', 'PERIOD_GENERIC', 'DOCUMENTED_LIKENESS', 'GENERATED_LIKENESS'] as const;
export type LikenessMode = (typeof LIKENESS_MODES)[number];

/** What a visual detail rests on: a claim, what is generic for the period, or nothing (invented). */
export const DETAIL_BASES = ['CLAIM', 'PERIOD_GENERIC', 'INVENTED'] as const;
export type DetailBasis = (typeof DETAIL_BASES)[number];

/** How a visual beat relates to the evidence. */
export const EVIDENCE_RELATIONS = ['DEPICTS_EVIDENCE', 'SHOWS_SOURCE', 'VISUALISES_DATA', 'ILLUSTRATES_CONTEXT', 'INTERPRETS', 'FICTIONAL_DEVICE', 'NONE'] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

/**
 * What a shot's picture is, derived by code from its treatment, method and
 * content (never proposed by a model): a record, a reconstruction, data, an
 * illustration that asserts nothing, or a fictional device.
 */
export const DEPICTIONS = ['RECORD', 'RECONSTRUCTED', 'DATA', 'ILLUSTRATIVE', 'FICTIONAL'] as const;
export type Depiction = (typeof DEPICTIONS)[number];

/** How a storyboard version came about. */
export const STORYBOARD_ORIGINS = [
  'GENERATED', // planned from the narration
  'APPROACH', // another approach: only the beats whose treatment changes are re-planned
  'BEATS', // chosen beats re-planned, the rest copied
  'EDIT', // a person's edits (no model call)
  'RETIME', // the same plan on another assembly of the same script (no model call)
  'RESTORE', // a copy of an earlier version (no model call)
  'PROFILE', // re-costed for another visual profile (no model call)
] as const;
export type StoryboardOrigin = (typeof STORYBOARD_ORIGINS)[number];

/** What a storyboard job does: plan a version, switch approach, or re-plan chosen beats. */
export const STORYBOARD_MODES = ['GENERATE', 'APPROACH', 'BEATS'] as const;
export type StoryboardMode = (typeof STORYBOARD_MODES)[number];

/**
 * How far the narration a storyboard is timed against is approved: its
 * assembly passed the VOICE gate, every take it uses is approved, or neither.
 */
export const NARRATION_APPROVALS = ['GATE_APPROVED', 'TAKES_APPROVED', 'UNREVIEWED'] as const;
export type NarrationApproval = (typeof NARRATION_APPROVALS)[number];

/** Kinds of specific visual detail that must declare a basis (uniforms, documents, technology…). */
export const SPECIFIC_KINDS = ['CLOTHING', 'UNIFORM', 'ARCHITECTURE', 'DOCUMENT', 'TECHNOLOGY', 'OBJECT', 'DATE', 'PLACE', 'PERSON', 'OTHER'] as const;
export type SpecificKind = (typeof SPECIFIC_KINDS)[number];

export const SHOT_TRANSITIONS = ['CUT', 'DISSOLVE', 'FADE', 'MATCH_CUT', 'WIPE'] as const;
export type ShotTransition = (typeof SHOT_TRANSITIONS)[number];

export const MOTION_INTENSITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type MotionIntensity = (typeof MOTION_INTENSITIES)[number];

export const SUBJECT_ROLES = ['PRIMARY', 'SECONDARY', 'BACKGROUND'] as const;
export type SubjectRole = (typeof SUBJECT_ROLES)[number];

export const BEAT_IMPORTANCES = ['LOW', 'NORMAL', 'HIGH', 'HERO'] as const;
export type BeatImportance = (typeof BEAT_IMPORTANCES)[number];

export const GENERATION_COMPLEXITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type GenerationComplexity = (typeof GENERATION_COMPLEXITIES)[number];

/** What asset a shot needs. */
export const VISUAL_ASSET_TYPES = ['VIDEO_CLIP', 'IMAGE', 'GRAPHIC', 'DOCUMENT', 'MAP', 'TEXT', 'NONE'] as const;
export type VisualAssetType = (typeof VISUAL_ASSET_TYPES)[number];

/** How a shot's asset is obtained. */
export const ASSET_SOURCINGS = ['GENERATE', 'SOURCE', 'RENDER', 'EDIT'] as const;
export type AssetSourcing = (typeof ASSET_SOURCINGS)[number];

/** How each production method obtains its asset. */
export const METHOD_SOURCING: Readonly<Record<ProductionMethod, AssetSourcing>> = {
  GENERATIVE_VIDEO: 'GENERATE',
  IMAGE_TO_VIDEO: 'GENERATE',
  GENERATIVE_IMAGE: 'GENERATE',
  STILL_MOTION: 'GENERATE',
  DETERMINISTIC_GRAPHIC: 'RENDER',
  MAP_RENDER: 'RENDER',
  DOCUMENT_MOTION: 'SOURCE',
  ARCHIVAL_SOURCING: 'SOURCE',
  STOCK_SOURCING: 'SOURCE',
  SCREEN_RECORDING: 'SOURCE',
  MOTION_DESIGN: 'RENDER',
  EDIT_TIME: 'EDIT',
};

export const LICENSING_STATUSES = ['NOT_APPLICABLE', 'REQUIRED', 'UNKNOWN'] as const;
export type LicensingStatus = (typeof LICENSING_STATUSES)[number];

/** What a reusable asset is, for the future reuse library (§18). */
export const REUSE_CATEGORIES = ['ENVIRONMENT', 'CHARACTER', 'LOCATION', 'DOCUMENT', 'MAP', 'ESTABLISHING', 'TRANSITION', 'OTHER'] as const;
export type ReuseCategory = (typeof REUSE_CATEGORIES)[number];

/**
 * How a visual price is known: the vendor's published list price, the
 * user's own plan price (an override), or a labelled assumption. A price
 * that is none of these is not a price: the estimate is UNPRICED.
 */
export const PRICE_CONFIDENCES = ['LIST_PRICE', 'PLAN_PRICE', 'ASSUMPTION'] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCES)[number];

/** The cost bases a visual forecast can have (a forecast is never vendor-reported). */
export const VISUAL_COST_BASES = ['ESTIMATED', 'UNPRICED', 'MOCK'] as const;
export type VisualCostBasis = (typeof VISUAL_COST_BASES)[number];

// Visual style profiles (provider-neutral; the library mirrors saved voice profiles)

export const VISUAL_REALISMS = ['PHOTOREAL', 'CINEMATIC', 'PAINTERLY', 'ILLUSTRATED', 'GRAPHIC'] as const;
export type VisualRealism = (typeof VISUAL_REALISMS)[number];
/** Realisms that read as plainly not footage (an uncertainty device: STYLISED_UNREAL). */
export const UNREAL_REALISMS: readonly VisualRealism[] = ['PAINTERLY', 'ILLUSTRATED', 'GRAPHIC'];

export const CAMERA_STYLES = ['OBSERVATIONAL', 'CLASSICAL', 'HANDHELD', 'STYLISED', 'MINIMAL'] as const;
export type CameraStyle = (typeof CAMERA_STYLES)[number];

export const FILM_GRAINS = ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY'] as const;
export type FilmGrain = (typeof FILM_GRAINS)[number];

export const VISUAL_RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;
export type VisualResolution = (typeof VISUAL_RESOLUTIONS)[number];

/** How often the picture changes (targets in DENSITY_TARGETS). */
export const VISUAL_DENSITIES = ['SPARSE', 'BALANCED', 'DENSE'] as const;
export type VisualDensity = (typeof VISUAL_DENSITIES)[number];

export const ARCHIVAL_PREFERENCES = ['AVOID', 'WHEN_AVAILABLE', 'PREFER'] as const;
export type ArchivalPreference = (typeof ARCHIVAL_PREFERENCES)[number];

export const GRAPHICS_PREFERENCES = ['MINIMAL', 'BALANCED', 'RICH'] as const;
export type GraphicsPreference = (typeof GRAPHICS_PREFERENCES)[number];

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
// Documentary Writing Engine 2 (house-style corpus, diagnostics, narration pass)
// ---------------------------------------------------------------------------

/** What a corpus example does in a documentary (the house's vocabulary, lower case as written in the corpus files). */
export const WRITING_CATEGORIES = ['hook', 'explanation', 'transition', 'character', 'economics', 'numbers', 'uncertainty', 'scene', 'dialogue_adjacent', 'payoff', 'ending', 'context', 'other'] as const;
export type WritingCategory = (typeof WRITING_CATEGORIES)[number];

/** How good an example is: excellent and good are models to follow, bad is a model to avoid, borderline teaches judgment. */
export const WRITING_QUALITIES = ['excellent', 'good', 'borderline', 'bad'] as const;
export type WritingQuality = (typeof WRITING_QUALITIES)[number];

/** Where an example's words come from. Never a scraped commercial transcript. */
export const WRITING_SOURCE_TYPES = ['house', 'public_domain', 'licensed', 'user_provided', 'generated_comparison'] as const;
export type WritingSourceType = (typeof WRITING_SOURCE_TYPES)[number];

/** A house-style example taken from an approved script: a candidate until a person confirms it. */
export const WRITING_EXAMPLE_STATUSES = ['CANDIDATE', 'APPROVED', 'REJECTED', 'RETIRED'] as const;
export type WritingExampleStatus = (typeof WRITING_EXAMPLE_STATUSES)[number];

/**
 * Patterns that make narration sound machine-written. Signals, not
 * failures: each is a warning for an editor to judge.
 */
export const AI_PATTERNS = [
  'stock_phrase', // a phrase from the stock lexicon ("little did they know")
  'dramatic_transition', // a fake dramatic beat ("And then…", "That's when…", "Everything was about to change")
  'hype_adverb', // "Incredibly,", "Remarkably,", "Shockingly," as a sentence opener
  'imagine_opener', // "Imagine…", "Picture this", an unneeded "What if…"
  'trailer_language', // "forever", "destiny", "the unthinkable", "a story of greed and betrayal"
  'mystery_language', // "shrouded in mystery", "the hidden truth", "dark secrets"
  'emotion_explained', // telling the listener what to feel ("a palpable sense of dread")
  'truth_reveal', // "The truth is…", "In reality…", "Here's the thing"
  'micro_hook', // a block or section closing on a tease ("But that was about to change.")
  'contrast_formula', // "not X, but Y" / "It wasn't X. It was Y." — fine once, formulaic when repeated
  'qa_pair', // "The result? Chaos." — a question answered at once by a fragment
  'fragment_run', // three or more very short sentences in a row
  'em_dash', // em-dashes in place of sentences
  'metaphor_stack', // several figures of speech close together
  'rhetorical_question', // questions the narrator answers or leaves hanging, too often
  'repeated_ending', // blocks ending the same way again and again
  'length_repetition', // runs of sentences of the same length
  'visual_description', // narration describing what the picture already shows
] as const;
export type AiPattern = (typeof AI_PATTERNS)[number];

/** The read-aloud rubric: telemetry for the editor, never a gate and never above the factual checks. */
export const RUBRIC_DIMENSIONS = [
  'HUMANITY',
  'CLARITY',
  'SPOKEN_RHYTHM',
  'HISTORICAL_CONTEXT',
  'NARRATIVE_RESTRAINT',
  'INFORMATION_DENSITY',
  'NARRATIVE_PROGRESSION',
  'VISUAL_SEPARATION',
  'AI_FINGERPRINT_RISK',
  'PRONUNCIATION_FRIENDLINESS',
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** How a sum of money is given meaning, in order of preference: a contemporary wage first, a modern estimate last (and always approximate). */
export const MONEY_COMPARISON_TYPES = ['CONTEMPORARY_WAGE', 'INCOME', 'HOUSEHOLD_EXPENSE', 'ASSET', 'MODERN_ESTIMATE'] as const;
export type MoneyComparisonType = (typeof MONEY_COMPARISON_TYPES)[number];

/** What a name in the script names. */
export const NAME_KINDS = ['PERSON', 'PLACE', 'ORGANISATION', 'TERM'] as const;
export type NameKind = (typeof NAME_KINDS)[number];

/** The layers of a script block: only NARRATION is ever spoken. */
export const SEMANTIC_LAYERS = ['NARRATION', 'VISUAL_DIRECTION', 'EDITORIAL_NOTE', 'DELIVERY_DIRECTION', 'EVIDENCE'] as const;
export type SemanticLayer = (typeof SEMANTIC_LAYERS)[number];

/** Delivery marks as an editor reads them, derived from a block's delivery (provider-neutral; used sparingly). */
export const DELIVERY_MARKS = ['curious', 'quiet', 'measured', 'urgent', 'reflective'] as const;
export type DeliveryMark = (typeof DELIVERY_MARKS)[number];

/** What became of a block from one version to the next, in a change report. */
export const BLOCK_CHANGE_STATUSES = ['UNCHANGED', 'REWRITTEN', 'REMOVED', 'ADDED'] as const;
export type BlockChangeStatus = (typeof BLOCK_CHANGE_STATUSES)[number];

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
