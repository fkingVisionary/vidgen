import { describe, expect, it } from 'vitest';
import { JOB_TYPES, PROJECT_STATUSES, type ProjectStatus } from './enums.ts';
import {
  SIDE_JOBS,
  STATUS_DEFINITIONS,
  assertTransition,
  canTransition,
  forwardStatus,
  getAvailableActions,
  getTransitionKind,
  isSideJob,
  jobPhase,
  resolveApproval,
  resolveEnqueue,
  startsNewPhaseRun,
  statusIndex,
} from './pipeline.ts';

const HAPPY_PATH: ProjectStatus[] = PROJECT_STATUSES.filter((s) => s !== 'FAILED');

describe('pipeline definition', () => {
  it('follows the canonical status order on the happy path, from IDEA to PUBLISHED', () => {
    const walked: ProjectStatus[] = ['IDEA'];
    let current: ProjectStatus | null = 'IDEA';
    while ((current = forwardStatus(current)) !== null) walked.push(current);
    expect(walked).toEqual(HAPPY_PATH);
  });

  it('assigns every phase job type to exactly one status, and side jobs to none', () => {
    for (const type of JOB_TYPES) {
      const owners = PROJECT_STATUSES.filter((s) => STATUS_DEFINITIONS[s].jobs.includes(type));
      if (isSideJob(type)) {
        expect(owners, type).toEqual([]);
        expect(() => jobPhase(type)).toThrow(/side job/);
        continue;
      }
      expect(owners, type).toHaveLength(1);
      expect(jobPhase(type)).toBe(owners[0]);
    }
  });

  it('runs story angles as a side job in the story statuses, without starting or advancing anything', () => {
    expect(SIDE_JOBS.STORY_ANGLES).toEqual(['STORY_SELECTION', 'STORY_REVIEW', 'STORY_APPROVED']);
    for (const s of ['STORY_SELECTION', 'STORY_REVIEW', 'STORY_APPROVED'] as const) {
      expect(resolveEnqueue(s, 'STORY_ANGLES')).toEqual({ ok: true, enterStatus: null });
      expect(getAvailableActions(s).sideJobs).toEqual(['STORY_ANGLES']);
      expect(getAvailableActions(s).runnableJobs).not.toContain('STORY_ANGLES');
    }
    for (const s of ['RESEARCH_COMPLETE', 'STORY_MINING', 'STORY_ARCHITECTING', 'SCRIPT_DRAFT', 'FAILED'] as const) {
      expect(resolveEnqueue(s, 'STORY_ANGLES').ok, s).toBe(false);
      expect(getAvailableActions(s).sideJobs).toEqual([]);
    }
    // The architecture still starts from the selection as before.
    expect(resolveEnqueue('STORY_SELECTION', 'STORY_ARCHITECTURE')).toEqual({ ok: true, enterStatus: 'STORY_ARCHITECTING' });
  });

  it('gives every non-FAILED status a dashboard stage', () => {
    for (const s of HAPPY_PATH) expect(STATUS_DEFINITIONS[s].stage, s).not.toBeNull();
  });

  it('has exactly the seven human review points, each with approve and reject targets', () => {
    const gated = PROJECT_STATUSES.filter((s) => STATUS_DEFINITIONS[s].gate);
    expect(gated).toEqual(['RESEARCH_REVIEW', 'STORY_REVIEW', 'SCRIPT_REVIEW', 'VOICE_REVIEW', 'STORYBOARD_REVIEW', 'VISUAL_REVIEW', 'QA']);
    for (const s of gated) {
      const gate = STATUS_DEFINITIONS[s].gate!;
      // Rejection always goes back, approval always goes forward.
      expect(statusIndex(gate.onReject)).toBeLessThan(statusIndex(s));
      expect(statusIndex(gate.onApprove)).toBeGreaterThan(statusIndex(s));
    }
  });

  it('mines stories, lets the editor curate, then architects; a human approves before anything moves on', () => {
    expect(forwardStatus('RESEARCH_COMPLETE')).toBe('STORY_MINING');
    expect(jobPhase('STORY_MINING')).toBe('STORY_MINING');
    expect(getTransitionKind('STORY_MINING', 'STORY_SELECTION')).toBe('COMPLETE');
    expect(getTransitionKind('STORY_SELECTION', 'STORY_ARCHITECTING')).toBe('START');
    expect(jobPhase('STORY_ARCHITECTURE')).toBe('STORY_ARCHITECTING');
    expect(getTransitionKind('STORY_ARCHITECTING', 'STORY_REVIEW')).toBe('COMPLETE');
    expect(getTransitionKind('STORY_REVIEW', 'STORY_APPROVED')).toBe('APPROVE');
    // Reject → rework: back to the editor's selection, where the architecture can be regenerated.
    expect(getTransitionKind('STORY_REVIEW', 'STORY_SELECTION')).toBe('REJECT');
    // Approval does not start the script: that is a separate, human-initiated START.
    expect(STATUS_DEFINITIONS.STORY_APPROVED.onJobsComplete).toBeUndefined();
    expect(getTransitionKind('STORY_APPROVED', 'SCRIPT_DRAFT')).toBe('START');
    // Another mining pass from selection or review is a rewind.
    expect(getTransitionKind('STORY_SELECTION', 'STORY_MINING')).toBe('REWIND');
    expect(getTransitionKind('STORY_REVIEW', 'STORY_MINING')).toBe('REWIND');
  });

  it('requires storyboard approval before any visual generation (cost control)', () => {
    expect(jobPhase('VISUAL_GENERATION')).toBe('VISUAL_GENERATING');
    expect(getTransitionKind('VISUAL_PLANNING', 'VISUAL_GENERATING')).toBeNull();
    // Approving the storyboard reaches a milestone; generation is a separate START from it.
    expect(getTransitionKind('STORYBOARD_REVIEW', 'STORYBOARD_APPROVED')).toBe('APPROVE');
    expect(getTransitionKind('STORYBOARD_REVIEW', 'VISUAL_GENERATING')).toBeNull();
    expect(getTransitionKind('STORYBOARD_APPROVED', 'VISUAL_GENERATING')).toBe('START');
    expect(getTransitionKind('STORYBOARD_REVIEW', 'VISUAL_PLANNING')).toBe('REJECT');
  });

  it('makes an approved storyboard a milestone that runs nothing and starts nothing by itself', () => {
    const def = STATUS_DEFINITIONS.STORYBOARD_APPROVED;
    expect(def).toEqual({ stage: 'STORYBOARD', stageState: 'COMPLETE', jobs: [], next: 'VISUAL_GENERATING' });
    expect(STATUS_DEFINITIONS.STORYBOARD_REVIEW.gate).toEqual({ gate: 'STORYBOARD', onApprove: 'STORYBOARD_APPROVED', onReject: 'VISUAL_PLANNING' });
    expect(statusIndex('STORYBOARD_APPROVED')).toBe(statusIndex('STORYBOARD_REVIEW') + 1);
    // Nothing runs in the milestone, so nothing can fail there.
    expect(canTransition('STORYBOARD_APPROVED', 'FAILED')).toBe(false);
    // An edit reopens the review; a re-plan goes further back.
    expect(getTransitionKind('STORYBOARD_APPROVED', 'STORYBOARD_REVIEW')).toBe('REWIND');
    expect(getTransitionKind('STORYBOARD_APPROVED', 'VISUAL_PLANNING')).toBe('REWIND');
    expect(getAvailableActions('STORYBOARD_APPROVED')).toMatchObject({ gate: null, startsPhase: 'VISUAL_GENERATING', sideJobs: [] });
  });

  it('plans a storyboard preview as a side job while the narration is reviewed or complete, never moving the project', () => {
    expect(isSideJob('STORYBOARD_PREVIEW')).toBe(true);
    expect(SIDE_JOBS.STORYBOARD_PREVIEW).toEqual(['VOICE_REVIEW', 'VOICE_COMPLETE']);
    expect(() => jobPhase('STORYBOARD_PREVIEW')).toThrow(/side job/);
    for (const s of ['VOICE_REVIEW', 'VOICE_COMPLETE'] as const) {
      expect(resolveEnqueue(s, 'STORYBOARD_PREVIEW')).toEqual({ ok: true, enterStatus: null });
      expect(getAvailableActions(s).sideJobs).toEqual(['STORYBOARD_PREVIEW']);
      expect(getAvailableActions(s).runnableJobs).not.toContain('STORYBOARD_PREVIEW');
    }
    for (const s of ['SCRIPT_APPROVED', 'VOICE_GENERATING', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED', 'FAILED'] as const) {
      expect(resolveEnqueue(s, 'STORYBOARD_PREVIEW').ok, s).toBe(false);
    }
    // The phase job still starts from the VOICE milestone.
    expect(resolveEnqueue('VOICE_COMPLETE', 'VISUAL_PLAN')).toEqual({ ok: true, enterStatus: 'VISUAL_PLANNING' });
    expect(getAvailableActions('VOICE_COMPLETE')).toMatchObject({ runnableJobs: ['VISUAL_PLAN'], startsPhase: 'VISUAL_PLANNING', sideJobs: ['STORYBOARD_PREVIEW'] });
  });
});

describe('getTransitionKind', () => {
  it.each([
    ['IDEA', 'RESEARCHING', 'START'],
    ['RESEARCHING', 'RESEARCH_REVIEW', 'COMPLETE'],
    ['RESEARCH_REVIEW', 'RESEARCH_COMPLETE', 'APPROVE'],
    ['RESEARCH_REVIEW', 'RESEARCHING', 'REJECT'],
    ['SCRIPT_REVIEW', 'SCRIPT_DRAFT', 'REJECT'],
    ['QA', 'APPROVED', 'APPROVE'],
    ['QA', 'EDITING', 'REJECT'],
    ['APPROVED', 'PUBLISHED', 'COMPLETE'],
    ['VOICE_GENERATING', 'FAILED', 'FAIL'],
    ['VISUAL_REVIEW', 'SCRIPT_DRAFT', 'REWIND'],
    ['APPROVED', 'IDEA', 'REWIND'],
  ] as const)('%s → %s is %s', (from, to, kind) => {
    expect(getTransitionKind(from, to)).toBe(kind);
  });

  it.each([
    ['RESEARCHING', 'RESEARCH_COMPLETE'], // cannot skip research review
    ['SCRIPT_DRAFT', 'SCRIPT_APPROVED'], // cannot skip script review
    ['SCRIPT_REVIEW', 'VOICE_GENERATING'], // cannot skip a milestone
    ['EDITING', 'APPROVED'], // cannot skip render + QA
    ['IDEA', 'PUBLISHED'],
    ['RESEARCH_REVIEW', 'FAILED'], // nothing runs in a review status, so nothing can fail there
    ['IDEA', 'IDEA'],
  ] as const)('%s → %s is illegal', (from, to) => {
    expect(getTransitionKind(from, to)).toBeNull();
    expect(() => assertTransition(from, to)).toThrow(/Illegal project status transition/);
  });

  it('treats PUBLISHED as terminal', () => {
    for (const to of PROJECT_STATUSES) expect(canTransition('PUBLISHED', to)).toBe(false);
  });

  it('only lets a FAILED project recover to where it failed, or rewind before that', () => {
    const ctx = { failedFrom: 'VOICE_GENERATING' as const };
    expect(getTransitionKind('FAILED', 'VOICE_GENERATING', ctx)).toBe('RECOVER');
    expect(getTransitionKind('FAILED', 'SCRIPT_DRAFT', ctx)).toBe('REWIND');
    expect(getTransitionKind('FAILED', 'VISUAL_PLANNING', ctx)).toBeNull(); // would skip ahead
    expect(getTransitionKind('FAILED', 'APPROVED', ctx)).toBeNull();
    expect(getTransitionKind('FAILED', 'VOICE_GENERATING')).toBeNull(); // unknown origin → refuse
  });

  it('allows every status with jobs to fail, and no status without jobs', () => {
    for (const s of PROJECT_STATUSES) {
      if (s === 'FAILED') continue;
      expect(canTransition(s, 'FAILED'), s).toBe(STATUS_DEFINITIONS[s].jobs.length > 0);
    }
  });

  it('only rewinds backwards', () => {
    for (const from of HAPPY_PATH) {
      for (const to of HAPPY_PATH) {
        if (getTransitionKind(from, to) === 'REWIND') {
          expect(statusIndex(to)).toBeLessThan(statusIndex(from));
        }
      }
    }
  });

  it('keeps the phase run across FAIL/RECOVER so succeeded work is not discarded', () => {
    expect(startsNewPhaseRun('FAIL')).toBe(false);
    expect(startsNewPhaseRun('RECOVER')).toBe(false);
    expect(startsNewPhaseRun('REWIND')).toBe(true);
    expect(startsNewPhaseRun('REJECT')).toBe(true);
  });
});

describe('resolveEnqueue', () => {
  it('runs a job in its own phase', () => {
    expect(resolveEnqueue('RESEARCHING', 'RESEARCH')).toEqual({ ok: true, enterStatus: null });
    expect(resolveEnqueue('VISUAL_GENERATING', 'INFOGRAPHIC')).toEqual({ ok: true, enterStatus: null });
  });

  it('starts the next phase from a milestone', () => {
    expect(resolveEnqueue('IDEA', 'RESEARCH')).toEqual({ ok: true, enterStatus: 'RESEARCHING' });
    expect(resolveEnqueue('RESEARCH_COMPLETE', 'STORY_MINING')).toEqual({ ok: true, enterStatus: 'STORY_MINING' });
    expect(resolveEnqueue('STORY_SELECTION', 'STORY_ARCHITECTURE')).toEqual({ ok: true, enterStatus: 'STORY_ARCHITECTING' });
    expect(resolveEnqueue('SCRIPT_APPROVED', 'VOICE')).toEqual({ ok: true, enterStatus: 'VOICE_GENERATING' });
  });

  it('refuses jobs outside the current phase', () => {
    expect(resolveEnqueue('IDEA', 'SCRIPT').ok).toBe(false);
    expect(resolveEnqueue('RESEARCH_REVIEW', 'STORY_MINING').ok).toBe(false); // research must be approved first
    expect(resolveEnqueue('RESEARCH_COMPLETE', 'STORY_ARCHITECTURE').ok).toBe(false); // mining comes first
    expect(resolveEnqueue('STORY_REVIEW', 'SCRIPT').ok).toBe(false);
    expect(resolveEnqueue('SCRIPT_REVIEW', 'VOICE').ok).toBe(false);
    expect(resolveEnqueue('STORYBOARD_REVIEW', 'VISUAL_GENERATION').ok).toBe(false);
    expect(resolveEnqueue('FAILED', 'RESEARCH').ok).toBe(false);
  });

  it('starts visual generation only from the approved-storyboard milestone (the API refuses it while the storyboard stage is real)', () => {
    expect(resolveEnqueue('STORYBOARD_APPROVED', 'VISUAL_GENERATION')).toEqual({ ok: true, enterStatus: 'VISUAL_GENERATING' });
    expect(resolveEnqueue('STORYBOARD_APPROVED', 'INFOGRAPHIC')).toEqual({ ok: true, enterStatus: 'VISUAL_GENERATING' });
    expect(resolveEnqueue('STORYBOARD_APPROVED', 'VISUAL_PLAN').ok).toBe(false);
    for (const s of ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW'] as const) {
      expect(resolveEnqueue(s, 'VISUAL_GENERATION').ok, s).toBe(false);
      expect(resolveEnqueue(s, 'INFOGRAPHIC').ok, s).toBe(false);
    }
  });
});

describe('resolveApproval', () => {
  it('approves and rejects at the matching gate', () => {
    expect(resolveApproval('SCRIPT_REVIEW', 'SCRIPT', 'APPROVED', { phaseJobsComplete: true })).toEqual({
      ok: true,
      nextStatus: 'SCRIPT_APPROVED',
    });
    expect(resolveApproval('SCRIPT_REVIEW', 'SCRIPT', 'REJECTED', { phaseJobsComplete: true })).toEqual({
      ok: true,
      nextStatus: 'SCRIPT_DRAFT',
    });
  });

  it('records a FLAG without moving the project', () => {
    expect(resolveApproval('RESEARCH_REVIEW', 'RESEARCH', 'FLAGGED', { phaseJobsComplete: true })).toEqual({
      ok: true,
      nextStatus: null,
    });
  });

  it('refuses the wrong gate or a non-gate status', () => {
    expect(resolveApproval('SCRIPT_REVIEW', 'RESEARCH', 'APPROVED', { phaseJobsComplete: true }).ok).toBe(false);
    expect(resolveApproval('SCRIPT_DRAFT', 'SCRIPT', 'APPROVED', { phaseJobsComplete: true }).ok).toBe(false);
  });

  it('refuses final approval until the automated QA job has succeeded', () => {
    expect(resolveApproval('QA', 'FINAL_VIDEO', 'APPROVED', { phaseJobsComplete: false }).ok).toBe(false);
    expect(resolveApproval('QA', 'FINAL_VIDEO', 'APPROVED', { phaseJobsComplete: true })).toEqual({
      ok: true,
      nextStatus: 'APPROVED',
    });
    // Rejecting does not need QA to have run.
    expect(resolveApproval('QA', 'FINAL_VIDEO', 'REJECTED', { phaseJobsComplete: false }).ok).toBe(true);
  });
});

describe('getAvailableActions', () => {
  it('offers the next phase from a milestone', () => {
    expect(getAvailableActions('IDEA')).toMatchObject({ runnableJobs: ['RESEARCH'], startsPhase: 'RESEARCHING', gate: null });
  });

  it('offers both parallel jobs while generating visuals', () => {
    expect(getAvailableActions('VISUAL_GENERATING').runnableJobs).toEqual(['VISUAL_GENERATION', 'INFOGRAPHIC']);
  });

  it('offers only the gate in a review status', () => {
    const a = getAvailableActions('STORYBOARD_REVIEW');
    expect(a.runnableJobs).toEqual([]);
    expect(a.gate?.gate).toBe('STORYBOARD');
    expect(a.rewindTargets).toContain('SCRIPT_DRAFT');
  });

  it('offers nothing to run for a FAILED project', () => {
    expect(getAvailableActions('FAILED', { failedFrom: 'EDITING' })).toMatchObject({ runnableJobs: [], startsPhase: null });
  });
});
