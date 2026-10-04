import { describe, expect, it } from 'vitest';
import { PROJECT_STATUSES, STAGES } from './enums.ts';
import { computeProgress, deriveStages } from './stages.ts';

const stateOf = (stages: ReturnType<typeof deriveStages>) => Object.fromEntries(stages.map((s) => [s.stage, s.state]));

describe('deriveStages', () => {
  it('returns all nine dashboard stages in order for every status', () => {
    for (const status of PROJECT_STATUSES) {
      expect(deriveStages(status, { failedFrom: 'EDITING' }).map((s) => s.stage)).toEqual([...STAGES]);
    }
  });

  it('shows nothing started for a new idea', () => {
    expect(deriveStages('IDEA').every((s) => s.state === 'NOT_STARTED')).toBe(true);
  });

  it('marks earlier stages complete and the current one awaiting approval', () => {
    const s = stateOf(deriveStages('SCRIPT_REVIEW'));
    expect(s).toMatchObject({
      RESEARCH: 'COMPLETE',
      STORY: 'COMPLETE',
      SCRIPT: 'AWAITING_APPROVAL',
      VOICE: 'NOT_STARTED',
      FINAL: 'NOT_STARTED',
    });
  });

  it('shows QA in progress until the QA job has succeeded', () => {
    expect(stateOf(deriveStages('QA')).QA).toBe('IN_PROGRESS');
    expect(stateOf(deriveStages('QA', { phaseJobsComplete: true })).QA).toBe('AWAITING_APPROVAL');
  });

  it('pins a failure to the stage where it happened', () => {
    const s = stateOf(deriveStages('FAILED', { failedFrom: 'VOICE_GENERATING' }));
    expect(s).toMatchObject({ SCRIPT: 'COMPLETE', VOICE: 'FAILED', STORYBOARD: 'NOT_STARTED' });
  });

  it('marks every stage complete once published', () => {
    expect(deriveStages('PUBLISHED').every((s) => s.state === 'COMPLETE')).toBe(true);
  });
});

describe('computeProgress', () => {
  it('runs from 0 (idea) to 100 (published) and never decreases along the happy path', () => {
    const path = PROJECT_STATUSES.filter((s) => s !== 'FAILED');
    const progress = path.map((s) => computeProgress(deriveStages(s, { phaseJobsComplete: true })));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]!);
  });
});
