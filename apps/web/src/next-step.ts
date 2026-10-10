import { takesAllApproved, type ChosenRunInput, type JobType, type NarrationRunView, type ProjectDetailView, type ProjectStatus } from '@docengine/core';

/**
 * A project's next step, for a producer who should not need instructions:
 * one plain sentence and one button that goes there, with the right voice
 * run chosen. Derived from where the project stands — its status, the
 * chosen voice run (core's chosenRun) and its takes, the whole narration,
 * the newest storyboard version and any job running — from an approved
 * script to an approved storyboard, and a failed narration or planning job
 * (started again from its page). Earlier and later stages keep their own
 * next actions (null), as does a stage whose engine is a MOCK placeholder
 * here (it is run from the project page).
 */

export interface NextStep {
  /** What to do next, in one sentence. */
  text: string;
  /** The one button: its words and where it goes, with the part of the page to open at (#…). */
  action: { label: string; to: string };
  /** TODO: the person's turn; WAIT: a job is running; DONE: nothing left to do here. */
  tone: 'TODO' | 'WAIT' | 'DONE';
}

/** Where a next step's button goes on a page: the run's takes, the VOICE gate, the plan form, the decision. */
export const ANCHORS = { takes: 'takes', gate: 'narration-gate', plan: 'plan', decision: 'decision' } as const;

/** The page a next step's button opens ("/projects/tulip-mania/storyboard"): its pill in the project's tabs is the one marked. */
export const stepPage = (s: NextStep) => s.action.to.split(/[?#]/)[0]!;

/** "Voice run 3 (C expressive)", "Voice run 5 (audition)". */
export const runName = (r: Pick<NarrationRunView, 'number' | 'variant' | 'kind'>) => `Voice run ${r.number} (${r.variant ?? (r.kind === 'FULL' ? 'the whole script' : r.kind.toLowerCase())})`;

const VOICE_STEPS: readonly ProjectStatus[] = ['SCRIPT_APPROVED', 'VOICE_GENERATING', 'VOICE_REVIEW'];
const BOARD_STEPS: readonly ProjectStatus[] = ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED'];

type Project = Pick<ProjectDetailView, 'slug' | 'status' | 'failedFromStatus' | 'jobs' | 'storyboard' | 'narration'>;

export function nextStep(p: Project, realStages: readonly string[]): NextStep | null {
  const base = `/projects/${p.slug}`;
  const running = (types: readonly JobType[]) => p.jobs.some((j) => types.includes(j.type) && (j.status === 'QUEUED' || j.status === 'RUNNING'));
  const todo = (text: string, label: string, to: string): NextStep => ({ text, action: { label, to }, tone: 'TODO' });
  const voice = {
    audition: () => todo('Choose a narrator: audition voices on the Voice page.', 'Audition voices', `${base}/voice?tab=generate`),
    whole: (before = '') => todo(`${before}Narrate the whole script: an audition is not the film's final narration.`, 'Narrate the whole script', `${base}/voice?tab=generate&scope=full`),
    takes: (r: NarrationRunView, then = '') => todo(`Approve the takes of ${runName(r)}: ${r.takes.approved} of ${r.takes.total} approved${then ? `; then ${then}` : ''}.`, `Approve run ${r.number}'s takes`, `${base}/voice?run=${r.number}#${ANCHORS.takes}`),
  };
  const board = {
    planning: (): NextStep => ({ text: 'The storyboard is being planned: the Storyboard page updates when it is saved.', action: { label: 'Watch it on the Storyboard page', to: `${base}/storyboard` }, tone: 'WAIT' }),
    plan: (text: string, run?: number) => todo(text, 'Plan the storyboard', `${base}/storyboard${run ? `?run=${run}` : ''}#${ANCHORS.plan}`),
    review: (v: number) => todo(`Review storyboard v${v} and approve it.`, `Review storyboard v${v}`, `${base}/storyboard?v=${v}#${ANCHORS.decision}`),
  };

  // A failed job is started again from its page (the Overview offers no retry for a stage that has one).
  if (p.status === 'FAILED') {
    if (p.failedFromStatus === 'VOICE_GENERATING' && realStages.includes('VOICE')) return todo('Generating the narration failed: start it again on the Voice page.', 'Try again on the Voice page', `${base}/voice?tab=generate`);
    if (p.failedFromStatus === 'VISUAL_PLANNING' && realStages.includes('VISUAL_PLAN')) return board.plan('Planning the storyboard failed: plan it again.');
    return null;
  }

  if (VOICE_STEPS.includes(p.status)) {
    if (!realStages.includes('VOICE')) return null;
    if (p.status === 'VOICE_GENERATING' || running(['VOICE'])) return { text: 'The narration is being generated: the Voice page fills in as each chunk is done.', action: { label: 'Watch it on the Voice page', to: `${base}/voice` }, tone: 'WAIT' };
    const { chosen, full } = p.narration;
    if (!chosen) return voice.audition();
    if (chosen.stale) return todo(`${runName(chosen)} narrates an older version of the script: audition the approved script.`, 'Audition voices', `${base}/voice?tab=generate`);
    // Once the whole script is narrated, its takes and then the VOICE gate come first.
    if (p.status === 'VOICE_REVIEW' && full) {
      if (full.takes.approved < full.takes.total) return voice.takes(full);
      return todo('Every take of the whole narration is approved: approve the narration on the Voice page.', 'Approve the narration', `${base}/voice?run=${full.number}#${ANCHORS.gate}`);
    }
    const storyboardable = p.status === 'VOICE_REVIEW' && realStages.includes('VISUAL_PLAN');
    // The newest storyboard counts when it is planned on the chosen run (another run's is an earlier try).
    const s = p.storyboard && p.storyboard.narration.runId === chosen.id ? p.storyboard : null;
    if (storyboardable && running(['STORYBOARD_PREVIEW', 'VISUAL_PLAN'])) return board.planning();
    if (!s || !storyboardable) {
      if (chosen.takes.approved < chosen.takes.total) return voice.takes(chosen);
      return storyboardable ? board.plan(`Plan the storyboard for ${runName(chosen)}.`, chosen.number) : voice.whole();
    }
    if (s.stale) return todo(`Storyboard v${s.version} no longer matches its narration: open it to re-time or plan it again.`, `Open storyboard v${s.version}`, `${base}/storyboard?v=${s.version}`);
    switch (s.status) {
      case 'IN_REVIEW':
      case 'CHANGES_REQUESTED':
        return s.narration.approval === 'UNREVIEWED' ? voice.takes(chosen, `approve storyboard v${s.version}`) : board.review(s.version);
      case 'APPROVED':
        return voice.whole(`Storyboard v${s.version} is approved. `);
      default:
        // An approved version stays approved while newer ones are edited (§18): a rejected edit leaves it standing.
        if (s.approved && !s.approved.stale) return voice.whole(`Storyboard v${s.version} was ${s.status === 'REJECTED' ? 'rejected' : 'not reviewed'}; v${s.approved.version} stays approved. `);
        return board.plan(`Storyboard v${s.version} was ${s.status === 'REJECTED' ? 'rejected' : 'not reviewed'}: plan the storyboard for ${runName(chosen)} again.`, chosen.number);
    }
  }

  if (BOARD_STEPS.includes(p.status)) {
    if (!realStages.includes('VISUAL_PLAN')) return null;
    if (running(['VISUAL_PLAN', 'STORYBOARD_PREVIEW'])) return board.planning();
    const s = p.storyboard;
    switch (p.status) {
      case 'VOICE_COMPLETE':
        return board.plan('The narration is approved: plan the storyboard of the whole film on it.');
      case 'VISUAL_PLANNING':
        return board.plan('The storyboard was sent back: plan it again.');
      case 'STORYBOARD_REVIEW':
        return s ? board.review(s.version) : board.plan('Plan the storyboard.');
      default:
        return { text: 'The storyboard is approved. Visual generation is the next milestone.', action: { label: 'Open the storyboard', to: `${base}/storyboard` }, tone: 'DONE' };
    }
  }
  return null;
}

/** Where a storyboard preview is planned on any run; after them, only on the narration the VOICE gate approved. */
const PREVIEW_ON_ANY: readonly ProjectStatus[] = ['VOICE_REVIEW', 'VOICE_COMPLETE'];
const GATE_ONLY: readonly ProjectStatus[] = ['VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED'];

/**
 * "Storyboard this run →" on the Voice page: the Storyboard page with the
 * run chosen, or why not yet — its takes to approve first, another script,
 * no assembly, or a status where only the narration the VOICE gate
 * approved is storyboarded. Null: no storyboard from here (its engine is a
 * MOCK placeholder, or the project is past it).
 */
export function storyboardRun(
  p: Pick<ProjectDetailView, 'slug' | 'status'>,
  r: Pick<ChosenRunInput, 'number' | 'stale' | 'chunkCount' | 'takes'> & { assembly: { status: string } | null },
  realStages: readonly string[],
): { to: string; reason: null } | { to: null; reason: string } | null {
  if (!realStages.includes('VISUAL_PLAN')) return null;
  const no = (reason: string) => ({ to: null, reason });
  if (p.status === 'SCRIPT_APPROVED' || p.status === 'VOICE_GENERATING') return no('A storyboard is planned once the voice job has finished');
  if (!PREVIEW_ON_ANY.includes(p.status) && !GATE_ONLY.includes(p.status)) return null;
  if (r.stale) return no('This run narrates an older version of the script');
  if (!r.assembly) return no('This run is not assembled yet');
  if (GATE_ONLY.includes(p.status) && r.assembly.status !== 'APPROVED') return no("The storyboard is now planned on the film's approved narration");
  if (!takesAllApproved(r)) return no("Approve this run's takes first");
  return { to: `/projects/${p.slug}/storyboard?run=${r.number}#${ANCHORS.plan}`, reason: null };
}
