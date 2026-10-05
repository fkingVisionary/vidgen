/** ProjectEvent.type values. */
export const EVENT = {
  PROJECT_CREATED: 'PROJECT_CREATED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  JOB_QUEUED: 'JOB_QUEUED',
  /** Progress note from a long-running stage (e.g. "Research: 34 searches, 118 candidate sources"). */
  JOB_PROGRESS: 'JOB_PROGRESS',
  JOB_SUCCEEDED: 'JOB_SUCCEEDED',
  JOB_RETRY_SCHEDULED: 'JOB_RETRY_SCHEDULED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_CANCELLED: 'JOB_CANCELLED',
  JOB_IGNORED_STALE: 'JOB_IGNORED_STALE',
  APPROVAL_RECORDED: 'APPROVAL_RECORDED',
  /** The editor changed a story candidate (status, selection, priority, notes, title, mode, question, POV). */
  CANDIDATE_UPDATED: 'CANDIDATE_UPDATED',
  /** The editor set the order of the selected story units. */
  SELECTION_REORDERED: 'SELECTION_REORDERED',
  /** The editor approved, rejected or annotated a content opportunity. */
  OPPORTUNITY_UPDATED: 'OPPORTUNITY_UPDATED',
  /** The editor asked the architect to reconsider an architecture version (with a brief). */
  ARCHITECTURE_REVISION_REQUESTED: 'ARCHITECTURE_REVISION_REQUESTED',
  /** An earlier approved architecture was superseded by approving a newer version. */
  ARCHITECTURE_SUPERSEDED: 'ARCHITECTURE_SUPERSEDED',
  /** The editor asked for alternative narrative angles from the story pack. */
  ANGLES_REQUESTED: 'ANGLES_REQUESTED',
  /** The editor asked for a script version: rewritten sections or a whole revision, with a brief. */
  SCRIPT_REVISION_REQUESTED: 'SCRIPT_REVISION_REQUESTED',
  /** The editor changed a narration block (text, class, delivery, visual) or the order of a section's blocks. */
  SCRIPT_EDITED: 'SCRIPT_EDITED',
  /** The editor approved, rejected or annotated a section of the script under review. */
  SCRIPT_SECTION_REVIEWED: 'SCRIPT_SECTION_REVIEWED',
  /** An earlier script version was made current again, as a new version. */
  SCRIPT_RESTORED: 'SCRIPT_RESTORED',
  /** An earlier approved script was superseded by approving a newer version. */
  SCRIPT_SUPERSEDED: 'SCRIPT_SUPERSEDED',
  /** A mock job succeeded where the transition requires real providers (e.g. publishing). */
  PHASE_BLOCKED_MOCK: 'PHASE_BLOCKED_MOCK',
} as const;
