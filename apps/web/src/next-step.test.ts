import type { JobView, NarrationRunView, NarrationSummaryView, ProjectDetailView, ProjectStoryboardView } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { nextStep, runName, stepPage, storyboardRun } from './next-step.ts';

const REAL = ['RESEARCH', 'STORY_MINING', 'STORY_ARCHITECTURE', 'SCRIPT', 'VOICE', 'VISUAL_PLAN', 'STORYBOARD_PREVIEW'];

/** Tulip Mania's run 3: an audition of the acceptance experiment, variant C. */
const run3 = (approved = 0, over: Partial<NarrationRunView> = {}): NarrationRunView => ({
  id: 'run-3',
  number: 3,
  kind: 'AUDITION',
  label: 'Acceptance experiment — C expressive',
  variant: 'C expressive',
  takes: { approved, total: 11 },
  durationMs: 109_800,
  stale: false,
  ...over,
});
const narration = (chosen: NarrationRunView | null, over: Partial<NarrationSummaryView> = {}): NarrationSummaryView => ({ runs: chosen ? 7 : 0, chosen: chosen ? { ...chosen, reason: 'PROFILE' } : null, full: null, ...over });
const board = (over: Partial<ProjectStoryboardView> = {}) =>
  ({ id: 'sb-1', version: 1, status: 'IN_REVIEW', scope: 'PARTIAL', stale: false, narration: { runId: 'run-3', runNumber: 3, runKind: 'AUDITION', assemblyId: 'as-1', assemblyVersion: 1, approval: 'TAKES_APPROVED' }, approved: null, ...over }) as ProjectStoryboardView;
const job = (type: JobView['type'], status: JobView['status'] = 'RUNNING') => ({ id: `job-${type}`, type, status }) as JobView;
const project = (status: ProjectDetailView['status'], over: Partial<Pick<ProjectDetailView, 'failedFromStatus' | 'jobs' | 'storyboard' | 'narration'>> = {}) => ({ slug: 'tulip-mania', status, failedFromStatus: null, jobs: [], storyboard: null, narration: narration(run3()), ...over });

describe("a project's next step", () => {
  it('from an approved script: audition voices', () => {
    expect(nextStep(project('SCRIPT_APPROVED', { narration: narration(null) }), REAL)).toEqual({
      text: 'Choose a narrator: audition voices on the Voice page.',
      action: { label: 'Audition voices', to: '/projects/tulip-mania/voice?tab=generate' },
      tone: 'TODO',
    });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11, { stale: true })) }), REAL)).toMatchObject({ text: 'Voice run 3 (C expressive) narrates an older version of the script: audition the approved script.', action: { label: 'Audition voices' } });
  });

  it('while takes are generated: wait, watching the Voice page', () => {
    for (const p of [project('VOICE_GENERATING'), project('VOICE_REVIEW', { jobs: [job('VOICE', 'QUEUED')] })]) {
      expect(nextStep(p, REAL)).toEqual({ text: 'The narration is being generated: the Voice page fills in as each chunk is done.', action: { label: 'Watch it on the Voice page', to: '/projects/tulip-mania/voice' }, tone: 'WAIT' });
    }
  });

  it('the chosen run with takes to review: approve them, on that run', () => {
    expect(nextStep(project('VOICE_REVIEW'), REAL)).toEqual({
      text: 'Approve the takes of Voice run 3 (C expressive): 0 of 11 approved.',
      action: { label: "Approve run 3's takes", to: '/projects/tulip-mania/voice?run=3#takes' },
      tone: 'TODO',
    });
  });

  it('its takes approved and no storyboard: plan the storyboard for that run', () => {
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)) }), REAL)).toEqual({
      text: 'Plan the storyboard for Voice run 3 (C expressive).',
      action: { label: 'Plan the storyboard', to: '/projects/tulip-mania/storyboard?run=3#plan' },
      tone: 'TODO',
    });
    // A storyboard of another run is an earlier try: the chosen run is planned.
    const other = board({ narration: { runId: 'run-2', runNumber: 2, runKind: 'AUDITION', assemblyId: 'as-2', assemblyVersion: 1, approval: 'TAKES_APPROVED' } });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: other }), REAL)?.action.to).toBe('/projects/tulip-mania/storyboard?run=3#plan');
  });

  it('a storyboard being planned: wait, watching the Storyboard page', () => {
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), jobs: [job('STORYBOARD_PREVIEW')] }), REAL)).toEqual({
      text: 'The storyboard is being planned: the Storyboard page updates when it is saved.',
      action: { label: 'Watch it on the Storyboard page', to: '/projects/tulip-mania/storyboard' },
      tone: 'WAIT',
    });
  });

  it('storyboard v1 in review: review and approve it, or approve the takes it is timed on first', () => {
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board() }), REAL)).toEqual({
      text: 'Review storyboard v1 and approve it.',
      action: { label: 'Review storyboard v1', to: '/projects/tulip-mania/storyboard?v=1#decision' },
      tone: 'TODO',
    });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(4)), storyboard: board({ status: 'CHANGES_REQUESTED', narration: { ...board().narration, approval: 'UNREVIEWED' } }) }), REAL)).toMatchObject({
      text: 'Approve the takes of Voice run 3 (C expressive): 4 of 11 approved; then approve storyboard v1.',
      action: { to: '/projects/tulip-mania/voice?run=3#takes' },
    });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board({ stale: true }) }), REAL)).toMatchObject({ action: { label: 'Open storyboard v1', to: '/projects/tulip-mania/storyboard?v=1' } });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board({ status: 'REJECTED' }) }), REAL)).toMatchObject({ text: 'Storyboard v1 was rejected: plan the storyboard for Voice run 3 (C expressive) again.', action: { to: '/projects/tulip-mania/storyboard?run=3#plan' } });
  });

  it('a rejected edit of an approved preview: the approval stands, so narrate the whole script, not a re-plan', () => {
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board({ version: 2, status: 'REJECTED', approved: { version: 1, stale: false } }) }), REAL)).toEqual({
      text: "Storyboard v2 was rejected; v1 stays approved. Narrate the whole script: an audition is not the film's final narration.",
      action: { label: 'Narrate the whole script', to: '/projects/tulip-mania/voice?tab=generate&scope=full' },
      tone: 'TODO',
    });
    for (const approved of [null, { version: 1, stale: true }]) {
      expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board({ version: 2, status: 'REJECTED', approved }) }), REAL)).toMatchObject({
        text: 'Storyboard v2 was rejected: plan the storyboard for Voice run 3 (C expressive) again.',
        action: { to: '/projects/tulip-mania/storyboard?run=3#plan' },
      });
    }
  });

  it('the preview approved: narrate the whole script; then its takes; then the VOICE gate', () => {
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)), storyboard: board({ status: 'APPROVED' }) }), REAL)).toEqual({
      text: "Storyboard v1 is approved. Narrate the whole script: an audition is not the film's final narration.",
      action: { label: 'Narrate the whole script', to: '/projects/tulip-mania/voice?tab=generate&scope=full' },
      tone: 'TODO',
    });
    const full = run3(40, { id: 'run-9', number: 9, kind: 'FULL', variant: null, label: 'The whole script', takes: { approved: 40, total: 80 } });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11), { full }), storyboard: board({ status: 'APPROVED' }) }), REAL)).toMatchObject({
      text: 'Approve the takes of Voice run 9 (the whole script): 40 of 80 approved.',
      action: { to: '/projects/tulip-mania/voice?run=9#takes' },
    });
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11), { full: { ...full, takes: { approved: 80, total: 80 } } }) }), REAL)).toEqual({
      text: 'Every take of the whole narration is approved: approve the narration on the Voice page.',
      action: { label: 'Approve the narration', to: '/projects/tulip-mania/voice?run=9#narration-gate' },
      tone: 'TODO',
    });
  });

  it('after the VOICE gate: plan the whole storyboard, wait for it, review it, and done', () => {
    expect(nextStep(project('VOICE_COMPLETE'), REAL)).toEqual({ text: 'The narration is approved: plan the storyboard of the whole film on it.', action: { label: 'Plan the storyboard', to: '/projects/tulip-mania/storyboard#plan' }, tone: 'TODO' });
    expect(nextStep(project('VISUAL_PLANNING', { jobs: [job('VISUAL_PLAN')] }), REAL)?.tone).toBe('WAIT');
    expect(nextStep(project('VISUAL_PLANNING'), REAL)).toMatchObject({ text: 'The storyboard was sent back: plan it again.', action: { to: '/projects/tulip-mania/storyboard#plan' } });
    expect(nextStep(project('STORYBOARD_REVIEW', { storyboard: board({ version: 4, scope: 'FULL' }) }), REAL)).toMatchObject({ text: 'Review storyboard v4 and approve it.', action: { to: '/projects/tulip-mania/storyboard?v=4#decision' } });
    expect(nextStep(project('STORYBOARD_APPROVED', { storyboard: board({ status: 'APPROVED', scope: 'FULL' }) }), REAL)).toEqual({ text: 'The storyboard is approved. Visual generation is the next milestone.', action: { label: 'Open the storyboard', to: '/projects/tulip-mania/storyboard' }, tone: 'DONE' });
  });

  it('a failed narration or planning job: start it again from its page (the Overview has no retry for it)', () => {
    expect(nextStep(project('FAILED', { failedFromStatus: 'VOICE_GENERATING' }), REAL)).toEqual({
      text: 'Generating the narration failed: start it again on the Voice page.',
      action: { label: 'Try again on the Voice page', to: '/projects/tulip-mania/voice?tab=generate' },
      tone: 'TODO',
    });
    expect(nextStep(project('FAILED', { failedFromStatus: 'VISUAL_PLANNING' }), REAL)).toEqual({
      text: 'Planning the storyboard failed: plan it again.',
      action: { label: 'Plan the storyboard', to: '/projects/tulip-mania/storyboard#plan' },
      tone: 'TODO',
    });
    // Elsewhere, or where the stage is a MOCK placeholder, the Overview's retry stays the next action.
    expect(nextStep(project('FAILED', { failedFromStatus: 'SCRIPT_DRAFT' }), REAL)).toBeNull();
    expect(nextStep(project('FAILED', { failedFromStatus: 'VOICE_GENERATING' }), ['SCRIPT'])).toBeNull();
    expect(nextStep(project('FAILED', { failedFromStatus: 'VISUAL_PLANNING' }), ['SCRIPT', 'VOICE'])).toBeNull();
  });

  it('none before an approved script, after the storyboard, on another failure, or where the stage is a MOCK placeholder', () => {
    for (const status of ['IDEA', 'RESEARCH_REVIEW', 'STORY_SELECTION', 'SCRIPT_REVIEW', 'VISUAL_GENERATING', 'PUBLISHED', 'FAILED'] as const) expect(nextStep(project(status), REAL)).toBeNull();
    expect(nextStep(project('VOICE_REVIEW'), ['SCRIPT'])).toBeNull();
    expect(nextStep(project('VOICE_COMPLETE'), ['SCRIPT', 'VOICE'])).toBeNull();
    // Without a real storyboard, an audition's approved takes lead to the whole narration.
    expect(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)) }), ['VOICE'])?.action.label).toBe('Narrate the whole script');
  });

  it("name the page its button opens (the project tab marked)", () => {
    expect(stepPage(nextStep(project('VOICE_REVIEW'), REAL)!)).toBe('/projects/tulip-mania/voice');
    expect(stepPage(nextStep(project('VOICE_REVIEW', { narration: narration(run3(11)) }), REAL)!)).toBe('/projects/tulip-mania/storyboard');
  });

  it('name a run by its variant, or by what it narrates', () => {
    expect(runName(run3())).toBe('Voice run 3 (C expressive)');
    expect(runName({ number: 5, variant: null, kind: 'AUDITION' })).toBe('Voice run 5 (audition)');
    expect(runName({ number: 9, variant: null, kind: 'FULL' })).toBe('Voice run 9 (the whole script)');
  });
});

describe('"Storyboard this run"', () => {
  const p = (status: ProjectDetailView['status']) => ({ slug: 'tulip-mania', status });
  const r = (approved: number, over: Partial<Parameters<typeof storyboardRun>[1]> = {}) => ({ number: 3, stale: false, chunkCount: 11, takes: { APPROVED: approved, IN_REVIEW: 11 - approved }, assembly: { status: 'IN_REVIEW' }, ...over });

  it('opens the Storyboard page with the run chosen once its takes are approved', () => {
    expect(storyboardRun(p('VOICE_REVIEW'), r(11), REAL)).toEqual({ to: '/projects/tulip-mania/storyboard?run=3#plan', reason: null });
    expect(storyboardRun(p('VOICE_COMPLETE'), r(11), REAL)?.to).toBe('/projects/tulip-mania/storyboard?run=3#plan');
  });

  it('says why not yet', () => {
    expect(storyboardRun(p('VOICE_REVIEW'), r(9), REAL)).toEqual({ to: null, reason: "Approve this run's takes first" });
    expect(storyboardRun(p('VOICE_REVIEW'), r(11, { stale: true }), REAL)?.reason).toBe('This run narrates an older version of the script');
    expect(storyboardRun(p('VOICE_REVIEW'), r(11, { assembly: null }), REAL)?.reason).toBe('This run is not assembled yet');
    expect(storyboardRun(p('VOICE_GENERATING'), r(11), REAL)?.reason).toBe('A storyboard is planned once the voice job has finished');
    expect(storyboardRun(p('STORYBOARD_REVIEW'), r(11), REAL)?.reason).toBe("The storyboard is now planned on the film's approved narration");
    expect(storyboardRun(p('STORYBOARD_REVIEW'), r(11, { assembly: { status: 'APPROVED' } }), REAL)?.to).toBe('/projects/tulip-mania/storyboard?run=3#plan');
  });

  it('is not offered without a real storyboard engine or past the storyboard', () => {
    expect(storyboardRun(p('VOICE_REVIEW'), r(11), ['VOICE'])).toBeNull();
    expect(storyboardRun(p('VISUAL_GENERATING'), r(11), REAL)).toBeNull();
  });
});
