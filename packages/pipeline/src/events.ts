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
  /** A mock job succeeded where the transition requires real providers (e.g. publishing). */
  PHASE_BLOCKED_MOCK: 'PHASE_BLOCKED_MOCK',
} as const;
