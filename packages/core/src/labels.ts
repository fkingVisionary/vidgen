import type { ApprovalGate, ClaimVerdict, JobType, ProjectStatus, SourceType, Stage, StageState } from './enums.ts';

/** Human-readable labels for the dashboard. Kept out of the enums so copy can change freely. */

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  IDEA: 'Idea',
  RESEARCHING: 'Researching',
  RESEARCH_REVIEW: 'Research review',
  RESEARCH_COMPLETE: 'Research complete',
  STORY_DEVELOPMENT: 'Story development',
  SCRIPT_DRAFT: 'Script draft',
  SCRIPT_REVIEW: 'Script review',
  SCRIPT_APPROVED: 'Script approved',
  VOICE_GENERATING: 'Voice generating',
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
  STORY: 'Story architecture',
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
  SCRIPT: 'Script',
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
