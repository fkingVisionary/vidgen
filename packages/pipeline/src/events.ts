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
  /** The editor asked for narration: a voice run, a comparison, or new takes of some chunks. */
  VOICE_RUN_REQUESTED: 'VOICE_RUN_REQUESTED',
  /** The editor approved, rejected or restored a take. */
  VOICE_TAKE_DECIDED: 'VOICE_TAKE_DECIDED',
  /** The editor decided how a term in the pronunciation list is said. */
  VOICE_PRONUNCIATION_UPDATED: 'VOICE_PRONUNCIATION_UPDATED',
  /** A voice profile version was made from the project: a voice run's configuration saved as a profile, new or a new version (before saved profiles: a version made on its Voice page). */
  VOICE_PROFILE_CREATED: 'VOICE_PROFILE_CREATED',
  /** The editor chose the voice profile a language version narrates with (follow its current version, pin one, or the library default), or changed the project's overrides of it. */
  VOICE_PROFILE_SELECTED: 'VOICE_PROFILE_SELECTED',
  /** An earlier approved narration was superseded by approving a newer assembly. */
  VOICE_ASSEMBLY_SUPERSEDED: 'VOICE_ASSEMBLY_SUPERSEDED',
  /** The editor asked for a storyboard of a voice run's narration (the phase job or a preview): a plan, another approach, or chosen beats re-planned. */
  STORYBOARD_REQUESTED: 'STORYBOARD_REQUESTED',
  /** A storyboard version was saved: planned by a job, or re-timed onto another assembly of the same script (earlier versions are kept). */
  STORYBOARD_SAVED: 'STORYBOARD_SAVED',
  /** The editor's changes to a storyboard version were saved as a new version (no model call; the base is kept). */
  STORYBOARD_EDITED: 'STORYBOARD_EDITED',
  /** A person approved, rejected or asked for changes to a storyboard version (at version level or at the STORYBOARD gate). */
  STORYBOARD_DECIDED: 'STORYBOARD_DECIDED',
  /** A person approved or rejected one shot of a storyboard version, or cleared their decision. */
  STORYBOARD_SHOT_DECIDED: 'STORYBOARD_SHOT_DECIDED',
  /** Earlier storyboard versions were superseded: unapproved ones by saving a newer version, an approved one by approving a newer version. */
  STORYBOARD_SUPERSEDED: 'STORYBOARD_SUPERSEDED',
  /** An earlier storyboard version was made current again, as a new version. */
  STORYBOARD_RESTORED: 'STORYBOARD_RESTORED',
  /** Reserved: a visual profile version made from the project's storyboard work (nothing makes one yet; the library's own changes belong to no project and are not logged here). */
  VISUAL_PROFILE_CREATED: 'VISUAL_PROFILE_CREATED',
  /** The editor chose the project's visual profile (follow its current version, pin one, or the library default), or changed the project's overrides of it. */
  VISUAL_PROFILE_SELECTED: 'VISUAL_PROFILE_SELECTED',
  /** A mock job succeeded where the transition requires real providers (e.g. publishing). */
  PHASE_BLOCKED_MOCK: 'PHASE_BLOCKED_MOCK',
} as const;
