import { STAGES, type ProjectStatus, type Stage, type StageState } from './enums.ts';
import { STATUS_DEFINITIONS } from './pipeline.ts';

/**
 * Dashboard stage view. Derived from the project status on every read —
 * there is deliberately no stage table, so stages can never disagree with the
 * status.
 */
export interface StageView {
  stage: Stage;
  state: StageState;
}

export interface DeriveStagesOptions {
  /** For FAILED projects: the status the project failed in. */
  failedFrom?: ProjectStatus | null;
  /**
   * Whether every job of the current status has succeeded in the current
   * phase run. Matters for statuses that both run jobs and wait for approval
   * (QA): until the QA job succeeds, the stage is IN_PROGRESS, not
   * AWAITING_APPROVAL.
   */
  phaseJobsComplete?: boolean;
}

export function deriveStages(status: ProjectStatus, opts: DeriveStagesOptions = {}): StageView[] {
  const failed = status === 'FAILED';
  const effective: ProjectStatus = failed ? (opts.failedFrom ?? 'IDEA') : status;
  const def = STATUS_DEFINITIONS[effective];
  const currentStage = def.stage ?? 'RESEARCH';
  const currentIndex = STAGES.indexOf(currentStage);

  let currentState: StageState = def.stageState;
  if (failed) currentState = 'FAILED';
  else if (def.gate && def.jobs.length > 0 && !opts.phaseJobsComplete) currentState = 'IN_PROGRESS';

  return STAGES.map((stage, i) => ({
    stage,
    state: i < currentIndex ? 'COMPLETE' : i === currentIndex ? currentState : 'NOT_STARTED',
  }));
}

const STATE_WEIGHT: Record<StageState, number> = {
  NOT_STARTED: 0,
  IN_PROGRESS: 0.4,
  FAILED: 0.4,
  AWAITING_APPROVAL: 0.8,
  COMPLETE: 1,
};

/** Overall progress, 0–100, from the stage view. */
export function computeProgress(stages: readonly StageView[]): number {
  if (stages.length === 0) return 0;
  const total = stages.reduce((sum, s) => sum + STATE_WEIGHT[s.state], 0);
  return Math.round((total / stages.length) * 100);
}
