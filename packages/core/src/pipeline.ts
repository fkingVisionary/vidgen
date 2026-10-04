import {
  PROJECT_STATUSES,
  type ApprovalDecision,
  type ApprovalGate,
  type JobType,
  type ProjectStatus,
  type Stage,
  type StageState,
} from './enums.ts';

/**
 * The production pipeline, declared as data.
 *
 * Every ProjectStatus is described once here. All transition rules, the
 * dashboard stage view and the "what can I do next" actions are derived from
 * this table, so changing the pipeline means changing this table (and its
 * tests), not hunting through handlers.
 */

export interface GateDefinition {
  gate: ApprovalGate;
  onApprove: ProjectStatus;
  onReject: ProjectStatus;
}

export interface StatusDefinition {
  /** Dashboard stage this status belongs to (null only for FAILED, whose stage depends on where it failed). */
  stage: Stage | null;
  /** Stage state shown on the dashboard while in this status. */
  stageState: StageState;
  /** Jobs that may run while the project is in this status. */
  jobs: readonly JobType[];
  /** Automatic transition once every job in `jobs` has succeeded during the current phase. */
  onJobsComplete?: ProjectStatus;
  /** Human approval needed to leave this status. */
  gate?: GateDefinition;
  /** Manual "start the next phase" transition from a milestone status. */
  next?: ProjectStatus;
  /** Jobs completed with MOCK providers must not advance this status (e.g. a mock publish is not a publish). */
  requiresRealProviders?: boolean;
  terminal?: boolean;
}

export const STATUS_DEFINITIONS: Record<ProjectStatus, StatusDefinition> = {
  IDEA: { stage: 'RESEARCH', stageState: 'NOT_STARTED', jobs: [], next: 'RESEARCHING' },

  RESEARCHING: {
    stage: 'RESEARCH',
    stageState: 'IN_PROGRESS',
    jobs: ['RESEARCH'],
    onJobsComplete: 'RESEARCH_REVIEW',
  },
  RESEARCH_REVIEW: {
    stage: 'RESEARCH',
    stageState: 'AWAITING_APPROVAL',
    jobs: [],
    gate: { gate: 'RESEARCH', onApprove: 'RESEARCH_COMPLETE', onReject: 'RESEARCHING' },
  },
  RESEARCH_COMPLETE: { stage: 'RESEARCH', stageState: 'COMPLETE', jobs: [], next: 'STORY_MINING' },

  // Story mining finds candidate story units in the approved dossier; the editor
  // curates them (approve/reject/flag, select, prioritise) before the architect
  // turns the selection into a documentary plan, which a human must approve.
  STORY_MINING: {
    stage: 'STORY',
    stageState: 'IN_PROGRESS',
    jobs: ['STORY_MINING'],
    onJobsComplete: 'STORY_SELECTION',
  },
  STORY_SELECTION: { stage: 'STORY', stageState: 'IN_PROGRESS', jobs: [], next: 'STORY_ARCHITECTING' },
  STORY_ARCHITECTING: {
    stage: 'STORY',
    stageState: 'IN_PROGRESS',
    jobs: ['STORY_ARCHITECTURE'],
    onJobsComplete: 'STORY_REVIEW',
  },
  STORY_REVIEW: {
    stage: 'STORY',
    stageState: 'AWAITING_APPROVAL',
    jobs: [],
    gate: { gate: 'STORY', onApprove: 'STORY_APPROVED', onReject: 'STORY_SELECTION' },
  },
  // Nothing proceeds to the script automatically.
  STORY_APPROVED: { stage: 'STORY', stageState: 'COMPLETE', jobs: [], next: 'SCRIPT_DRAFT' },

  SCRIPT_DRAFT: {
    stage: 'SCRIPT',
    stageState: 'IN_PROGRESS',
    jobs: ['SCRIPT'],
    onJobsComplete: 'SCRIPT_REVIEW',
  },
  SCRIPT_REVIEW: {
    stage: 'SCRIPT',
    stageState: 'AWAITING_APPROVAL',
    jobs: [],
    gate: { gate: 'SCRIPT', onApprove: 'SCRIPT_APPROVED', onReject: 'SCRIPT_DRAFT' },
  },
  SCRIPT_APPROVED: { stage: 'SCRIPT', stageState: 'COMPLETE', jobs: [], next: 'VOICE_GENERATING' },

  VOICE_GENERATING: {
    stage: 'VOICE',
    stageState: 'IN_PROGRESS',
    jobs: ['VOICE'],
    onJobsComplete: 'VOICE_COMPLETE',
  },
  VOICE_COMPLETE: { stage: 'VOICE', stageState: 'COMPLETE', jobs: [], next: 'VISUAL_PLANNING' },

  VISUAL_PLANNING: {
    stage: 'STORYBOARD',
    stageState: 'IN_PROGRESS',
    jobs: ['VISUAL_PLAN'],
    onJobsComplete: 'STORYBOARD_REVIEW',
  },
  STORYBOARD_REVIEW: {
    stage: 'STORYBOARD',
    stageState: 'AWAITING_APPROVAL',
    jobs: [],
    gate: { gate: 'STORYBOARD', onApprove: 'VISUAL_GENERATING', onReject: 'VISUAL_PLANNING' },
  },

  VISUAL_GENERATING: {
    stage: 'ASSETS',
    stageState: 'IN_PROGRESS',
    jobs: ['VISUAL_GENERATION', 'INFOGRAPHIC'],
    onJobsComplete: 'VISUAL_REVIEW',
  },
  VISUAL_REVIEW: {
    stage: 'ASSETS',
    stageState: 'AWAITING_APPROVAL',
    jobs: [],
    gate: { gate: 'VISUAL_ASSETS', onApprove: 'EDITING', onReject: 'VISUAL_GENERATING' },
  },

  EDITING: { stage: 'TIMELINE', stageState: 'IN_PROGRESS', jobs: ['EDIT'], onJobsComplete: 'RENDERING' },

  RENDERING: { stage: 'QA', stageState: 'IN_PROGRESS', jobs: ['RENDER'], onJobsComplete: 'QA' },
  QA: {
    stage: 'QA',
    stageState: 'AWAITING_APPROVAL',
    jobs: ['QA'],
    gate: { gate: 'FINAL_VIDEO', onApprove: 'APPROVED', onReject: 'EDITING' },
  },

  APPROVED: {
    stage: 'FINAL',
    stageState: 'IN_PROGRESS',
    jobs: ['PUBLISH'],
    onJobsComplete: 'PUBLISHED',
    requiresRealProviders: true,
  },
  PUBLISHED: { stage: 'FINAL', stageState: 'COMPLETE', jobs: [], terminal: true },

  FAILED: { stage: null, stageState: 'FAILED', jobs: [] },
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const ORDER: Record<ProjectStatus, number> = Object.fromEntries(
  PROJECT_STATUSES.map((s, i) => [s, i]),
) as Record<ProjectStatus, number>;

/** Position in the canonical pipeline order. FAILED sorts last but is never "after" anything for rewinds. */
export function statusIndex(status: ProjectStatus): number {
  return ORDER[status];
}

const JOB_PHASE = new Map<JobType, ProjectStatus>();
for (const status of PROJECT_STATUSES) {
  for (const job of STATUS_DEFINITIONS[status].jobs) {
    if (JOB_PHASE.has(job)) throw new Error(`Job type ${job} is declared in more than one status`);
    JOB_PHASE.set(job, status);
  }
}

/** The status in which a job type runs. Every job type runs in exactly one status. */
export function jobPhase(type: JobType): ProjectStatus {
  const phase = JOB_PHASE.get(type);
  if (!phase) throw new Error(`Job type ${type} is not part of the pipeline`);
  return phase;
}

/** The next status on the happy path (start → jobs complete → approve), or null at the end. */
export function forwardStatus(status: ProjectStatus): ProjectStatus | null {
  const def = STATUS_DEFINITIONS[status];
  return def.next ?? def.onJobsComplete ?? def.gate?.onApprove ?? null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const TRANSITION_KINDS = [
  'START', // milestone → next phase (human-initiated or by enqueueing its first job)
  'COMPLETE', // all phase jobs succeeded → next status
  'APPROVE', // human approval at a gate
  'REJECT', // human rejection at a gate → back to the working phase
  'FAIL', // a job exhausted its retries
  'RECOVER', // FAILED → the phase that failed (retry)
  'REWIND', // human moves the project back to an earlier status
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TransitionContext {
  /** For FAILED projects: the status the project was in when it failed. */
  failedFrom?: ProjectStatus | null;
}

/**
 * Classifies a transition, or returns null if it is not allowed.
 * This is the single authority on legal status changes.
 */
export function getTransitionKind(
  from: ProjectStatus,
  to: ProjectStatus,
  ctx: TransitionContext = {},
): TransitionKind | null {
  if (from === to) return null;

  if (from === 'FAILED') {
    const failedFrom = ctx.failedFrom;
    if (!failedFrom || failedFrom === 'FAILED') return null;
    if (to === failedFrom) return 'RECOVER';
    if (to !== 'FAILED' && statusIndex(to) < statusIndex(failedFrom)) return 'REWIND';
    return null;
  }

  const def = STATUS_DEFINITIONS[from];
  if (def.terminal) return null;

  if (to === 'FAILED') return def.jobs.length > 0 ? 'FAIL' : null;
  if (def.next === to) return 'START';
  if (def.onJobsComplete === to) return 'COMPLETE';
  if (def.gate?.onApprove === to) return 'APPROVE';
  if (def.gate?.onReject === to) return 'REJECT';
  if (statusIndex(to) < statusIndex(from)) return 'REWIND';
  return null;
}

export function canTransition(from: ProjectStatus, to: ProjectStatus, ctx?: TransitionContext): boolean {
  return getTransitionKind(from, to, ctx) !== null;
}

export class TransitionError extends Error {
  constructor(
    readonly from: ProjectStatus,
    readonly to: ProjectStatus,
    detail?: string,
  ) {
    super(`Illegal project status transition ${from} → ${to}${detail ? `: ${detail}` : ''}`);
    this.name = 'TransitionError';
  }
}

export function assertTransition(
  from: ProjectStatus,
  to: ProjectStatus,
  ctx?: TransitionContext,
): TransitionKind {
  const kind = getTransitionKind(from, to, ctx);
  if (!kind) throw new TransitionError(from, to);
  return kind;
}

/**
 * Whether a transition begins a new "phase run". Jobs are stamped with the
 * project's phase sequence when enqueued; only jobs from the current run count
 * towards completing a phase. Failing and recovering do not start a new run,
 * so work that already succeeded in the failed phase is not thrown away.
 */
export function startsNewPhaseRun(kind: TransitionKind): boolean {
  return kind !== 'FAIL' && kind !== 'RECOVER';
}

// ---------------------------------------------------------------------------
// Commands: enqueueing jobs and recording approvals
// ---------------------------------------------------------------------------

export type EnqueueResolution =
  | { ok: true; /** Status to START into before enqueueing, if the job belongs to the next phase. */ enterStatus: ProjectStatus | null }
  | { ok: false; reason: string };

/** Can a job of `type` be enqueued while the project is in `status`? */
export function resolveEnqueue(status: ProjectStatus, type: JobType): EnqueueResolution {
  if (status === 'FAILED') {
    return { ok: false, reason: 'Project has FAILED: retry the failed job or rewind the project first' };
  }
  const def = STATUS_DEFINITIONS[status];
  if (def.jobs.includes(type)) return { ok: true, enterStatus: null };
  if (def.next && STATUS_DEFINITIONS[def.next].jobs.includes(type)) {
    return { ok: true, enterStatus: def.next };
  }
  return {
    ok: false,
    reason: `${type} jobs run in ${jobPhase(type)}; the project is in ${status}`,
  };
}

export type ApprovalResolution =
  | { ok: true; /** null when the decision does not move the project (FLAGGED). */ nextStatus: ProjectStatus | null }
  | { ok: false; reason: string };

export function resolveApproval(
  status: ProjectStatus,
  gate: ApprovalGate,
  decision: ApprovalDecision,
  opts: { phaseJobsComplete: boolean },
): ApprovalResolution {
  const def = STATUS_DEFINITIONS[status];
  if (!def.gate) return { ok: false, reason: `Status ${status} is not an approval gate` };
  if (def.gate.gate !== gate) {
    return { ok: false, reason: `Status ${status} is gated by ${def.gate.gate}, not ${gate}` };
  }
  if (decision === 'FLAGGED') return { ok: true, nextStatus: null };
  if (decision === 'APPROVED' && !opts.phaseJobsComplete) {
    return { ok: false, reason: `Cannot approve ${gate}: ${def.jobs.join(', ')} must succeed first` };
  }
  return { ok: true, nextStatus: decision === 'APPROVED' ? def.gate.onApprove : def.gate.onReject };
}

export interface AvailableActions {
  /** Job types that can be enqueued right now. */
  runnableJobs: JobType[];
  /** Status the project will START into when one of those jobs is enqueued, if any. */
  startsPhase: ProjectStatus | null;
  gate: GateDefinition | null;
  rewindTargets: ProjectStatus[];
}

export function getAvailableActions(status: ProjectStatus, ctx: TransitionContext = {}): AvailableActions {
  const def = STATUS_DEFINITIONS[status];
  let runnableJobs: JobType[] = [];
  let startsPhase: ProjectStatus | null = null;
  if (status !== 'FAILED') {
    if (def.jobs.length > 0) {
      runnableJobs = [...def.jobs];
    } else if (def.next) {
      runnableJobs = [...STATUS_DEFINITIONS[def.next].jobs];
      startsPhase = def.next;
    }
  }
  const rewindTargets = PROJECT_STATUSES.filter(
    (to) => getTransitionKind(status, to, ctx) === 'REWIND',
  );
  return { runnableJobs, startsPhase, gate: def.gate ?? null, rewindTargets };
}
