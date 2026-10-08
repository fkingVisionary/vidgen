import { describe, expect, it } from 'vitest';
import { chosenRun, runTakes, takesAllApproved, type ChosenRunInput } from './narration.ts';

const PROJECT = '6f1c0d0e-3b1a-4e8e-9a51-2d1f3c4b5a60';
const OTHER = '0b7e2c11-8a3d-4f6e-b1c2-9d8e7f6a5b40';
const run = (number: number, approved: number, total = 11, extra: Partial<ChosenRunInput> = {}): ChosenRunInput => ({
  id: `run-${number}`,
  number,
  stale: false,
  chunkCount: total,
  takes: { APPROVED: approved, ...(total - approved ? { IN_REVIEW: total - approved } : {}) },
  ...extra,
});
const savedFrom = (r: ChosenRunInput, projectId = PROJECT) => ({ kind: 'RUN' as const, runId: r.id, run: r.number, projectId, project: 'tulip-mania', experiment: 'Acceptance experiment', variant: 'C expressive', takeId: null, reconstructed: false });

describe('the chosen run', () => {
  // Tulip Mania: seven audition runs A–G, run 3 (C expressive) saved as the production profile.
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => run(n, n === 7 ? 11 : 0));

  it('is the run the production profile was saved from, whatever is newer or approved', () => {
    expect(chosenRun(seven, savedFrom(seven[2]!), PROJECT)).toEqual({ run: seven[2], reason: 'PROFILE' });
  });

  it("passes over a profile saved from another project's run, a run of an older script, or a profile not saved from a run", () => {
    expect(chosenRun(seven, savedFrom(seven[2]!, OTHER), PROJECT)).toEqual({ run: seven[6], reason: 'APPROVED' });
    const older = seven.map((r) => (r.number === 3 ? { ...r, stale: true } : r));
    expect(chosenRun(older, savedFrom(seven[2]!), PROJECT)).toEqual({ run: older[6], reason: 'APPROVED' });
    expect(chosenRun(seven, { kind: 'EDIT', basedOnVersion: 1 }, PROJECT)?.reason).toBe('APPROVED');
    expect(chosenRun(seven, { kind: 'LEGACY' }, PROJECT)?.reason).toBe('APPROVED');
    expect(chosenRun(seven, null, PROJECT)?.reason).toBe('APPROVED');
  });

  it('otherwise is the newest run whose current takes are all approved, in any order given', () => {
    const runs = [run(2, 11), run(5, 10), run(4, 11), run(6, 0, 0)];
    expect(chosenRun(runs, undefined, PROJECT)).toEqual({ run: runs[2], reason: 'APPROVED' });
  });

  it('otherwise is the newest run; none without runs', () => {
    const runs = [run(1, 3), run(2, 0)];
    expect(chosenRun(runs, undefined, PROJECT)).toEqual({ run: runs[1], reason: 'NEWEST' });
    expect(chosenRun([], undefined, PROJECT)).toBeNull();
  });

  it('prefers runs of the approved script while there are any', () => {
    const runs = [run(1, 11), run(2, 11, 11, { stale: true }), run(3, 0, 11, { stale: true })];
    expect(chosenRun(runs, undefined, PROJECT)).toEqual({ run: runs[0], reason: 'APPROVED' });
    const allOld = runs.slice(1);
    expect(chosenRun(allOld, undefined, PROJECT)).toEqual({ run: allOld[0], reason: 'APPROVED' });
    expect(chosenRun([run(1, 0, 11, { stale: true }), run(2, 0, 11, { stale: true })], undefined, PROJECT)?.run.number).toBe(2);
  });

  it('counts approved takes of the chunks; a run without chunks or with a take still to review is not all approved', () => {
    expect(runTakes(run(3, 9))).toEqual({ approved: 9, total: 11 });
    expect(runTakes({ chunkCount: 4, takes: {} })).toEqual({ approved: 0, total: 4 });
    expect(takesAllApproved(run(3, 11))).toBe(true);
    expect(takesAllApproved(run(3, 10))).toBe(false);
    expect(takesAllApproved({ chunkCount: 0, takes: {} })).toBe(false);
  });
});
