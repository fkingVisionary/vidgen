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
  'STORY_DEVELOPMENT',
  'SCRIPT_DRAFT',
  'SCRIPT_REVIEW', // human approval gate #2 (script)
  'SCRIPT_APPROVED',
  'VOICE_GENERATING',
  'VOICE_COMPLETE',
  'VISUAL_PLANNING',
  'STORYBOARD_REVIEW', // human approval gate #3 (storyboard) — before any paid generation
  'VISUAL_GENERATING',
  'VISUAL_REVIEW', // review of generated assets
  'EDITING',
  'RENDERING',
  'QA', // automated QA report + human approval gate #4 (final video)
  'APPROVED',
  'PUBLISHED',
  'FAILED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Units of work. Each runs in exactly one project status (see pipeline.ts). */
export const JOB_TYPES = [
  'RESEARCH',
  'STORY',
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
  'REPUTABLE_SECONDARY',
  'GENERAL_REFERENCE',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

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

export const LANGUAGE_VERSION_STATUSES = [
  'PLANNED',
  'IN_PRODUCTION',
  'READY',
  'PUBLISHED',
  'FAILED',
] as const;
export type LanguageVersionStatus = (typeof LANGUAGE_VERSION_STATUSES)[number];
