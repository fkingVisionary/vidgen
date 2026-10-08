import type { VoiceGenerationStatus } from './enums.ts';
import type { VoiceProfileOrigin } from './contracts/voice.ts';

/**
 * Which voice run a project's next steps refer to. A producer auditions
 * several runs and keeps one — saving its configuration as the production
 * profile — so the pages open on that run and the storyboard is planned on
 * it, unless the person names another.
 */

/** As much of a run as the choice needs (a VoiceRunSummaryView has it). */
export interface ChosenRunInput {
  id: string;
  number: number;
  /** Narrates another script version than the approved one. */
  stale: boolean;
  chunkCount: number;
  /** Current takes by status. */
  takes: Partial<Record<VoiceGenerationStatus, number>>;
}

/** PROFILE: the production profile was saved from it; APPROVED: the newest with every take approved; NEWEST: the newest. */
export type ChosenRunReason = 'PROFILE' | 'APPROVED' | 'NEWEST';

/** A run's current takes approved, of its chunks. */
export const runTakes = (r: Pick<ChosenRunInput, 'chunkCount' | 'takes'>) => ({ approved: r.takes.APPROVED ?? 0, total: r.chunkCount });

/** Every chunk has a current take, and every one is approved. */
export const takesAllApproved = (r: Pick<ChosenRunInput, 'chunkCount' | 'takes'>) => r.chunkCount > 0 && (r.takes.APPROVED ?? 0) === r.chunkCount;

/**
 * The project's chosen run: the run its production profile was saved from,
 * when that run is the project's and narrates the approved script;
 * otherwise the newest run whose current takes are all approved; otherwise
 * the newest run. While any run narrates the approved script, runs of an
 * older one are passed over. Null: no run yet.
 */
export function chosenRun<R extends ChosenRunInput>(runs: readonly R[], origin: VoiceProfileOrigin | { kind: 'LEGACY' } | null | undefined, projectId: string): { run: R; reason: ChosenRunReason } | null {
  if (origin?.kind === 'RUN' && origin.projectId === projectId) {
    const saved = runs.find((r) => r.id === origin.runId && !r.stale);
    if (saved) return { run: saved, reason: 'PROFILE' };
  }
  const current = runs.filter((r) => !r.stale);
  const newest = [...(current.length ? current : runs)].sort((a, b) => b.number - a.number);
  const approved = newest.find(takesAllApproved);
  if (approved) return { run: approved, reason: 'APPROVED' };
  return newest[0] ? { run: newest[0], reason: 'NEWEST' } : null;
}
