import type { ApprovalInput, ProjectStatus } from '@docengine/core';
import type { Project } from '@docengine/database';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { ConflictError, NonRetryableError, NotFoundError } from './errors.ts';
import type { StageHandlers } from './handlers.ts';
import { ProjectService, type GateHook, type StoryboardJobRequest } from './project-service.ts';
import { PostgresJobQueue } from './queue.ts';
import { JobRunner } from './runner.ts';
import { createMockStageHandlers } from './stages/mock-stages.ts';

const db = useTestDatabase();

function setup(opts: { gateHooks?: ConstructorParameters<typeof ProjectService>[0]['gateHooks']; handlers?: Partial<StageHandlers> } = {}) {
  const projects = new ProjectService({ db, ...(opts.gateHooks ? { gateHooks: opts.gateHooks } : {}) });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    handlers: { ...createMockStageHandlers(), ...opts.handlers },
    providers: createProviders(ALL_MOCK),
    retryBaseDelayMs: 0,
  });
  return { projects, runner };
}

/** The statuses past the VOICE gate seeded here (the gate approved the seed's narration). */
const PAST_VOICE_GATE: readonly ProjectStatus[] = ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED', 'VISUAL_GENERATING'];

/** The VOICE gate's approval of an assembly (as its hook records it). */
const approveNarration = (projectId: string, voiceAssemblyId: string, decision: 'APPROVED' | 'FLAGGED' = 'APPROVED') =>
  db.approval.create({ data: { projectId, gate: 'VOICE', decision, decidedBy: 'reviewer', projectStatus: 'VOICE_REVIEW', voiceAssemblyId } });

/**
 * A project in `status` (phase run 7) with an approved script and a voice run
 * with one assembly, the narration the VOICE gate approved once the project
 * is past it: the rows a storyboard request names.
 */
async function seed(projects: ProjectService, status: ProjectStatus, failedFromStatus: ProjectStatus | null = null) {
  const p = await projects.createProject(tulipInput, 'test');
  const lv = await db.languageVersion.findFirstOrThrow({ where: { projectId: p.id } });
  const script = await db.script.create({ data: { projectId: p.id, version: 1, status: 'APPROVED' } });
  const profile = await db.voiceProfile.create({
    data: { name: `Narrator ${p.slug}`, version: 1, provider: 'mock', voiceId: 'mock-voice', modelId: 'mock-model', language: 'en', outputFormat: 'mp3_44100_128', config: {} },
  });
  const run = await db.voiceRun.create({
    data: { projectId: p.id, languageVersionId: lv.id, scriptId: script.id, profileId: profile.id, number: 3, kind: 'AUDITION', scope: {}, strategy: 'EXPRESSIVE', settings: {} },
  });
  const assembly = await db.voiceAssembly.create({
    data: { runId: run.id, projectId: p.id, scriptId: script.id, profileId: profile.id, version: 1, status: 'IN_REVIEW', entries: [], timeline: [], totalDurationMs: 109_800, qa: [] },
  });
  const project = await db.project.update({ where: { id: p.id }, data: { status, phaseSeq: 7, failedFromStatus } });
  if ([status, failedFromStatus].some((x) => x && PAST_VOICE_GATE.includes(x))) await approveNarration(p.id, assembly.id);
  const request: StoryboardJobRequest = { mode: 'GENERATE', narration: { runId: run.id, assemblyId: assembly.id }, selectionRevision: 0 };
  return { project, lv, script, profile, run, assembly, request };
}

const projectOf = (id: string) => db.project.findUniqueOrThrow({ where: { id } });
const eventsOf = (projectId: string, type: string) => db.projectEvent.findMany({ where: { projectId, type }, orderBy: { createdAt: 'asc' } });

describe('storyboardJob: the VISUAL_PLAN phase job', () => {
  it('starts visual planning from VOICE_COMPLETE, in the voice run’s language version, and records the request', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'VOICE_COMPLETE');
    let seen: Project | null = null;
    const job = await projects.storyboardJob(s.project.id, 'editor', 'Storyboard of voice run 3, assembly v1', async (tx, p) => {
      seen = p;
      expect(await tx.job.count({ where: { projectId: p.id } })).toBe(0);
      return { ...s.request, approach: 'C' };
    });

    expect(seen).toMatchObject({ id: s.project.id, status: 'VOICE_COMPLETE' });
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'VISUAL_PLANNING', phaseSeq: 8 });
    expect(job).toMatchObject({ type: 'VISUAL_PLAN', status: 'QUEUED', phaseSeq: 8, languageVersionId: s.lv.id });
    expect(job.input).toEqual({ ...s.request, approach: 'C', requestedBy: 'editor' });
    const [changed] = await eventsOf(s.project.id, 'STATUS_CHANGED');
    expect(changed!.data).toMatchObject({ from: 'VOICE_COMPLETE', to: 'VISUAL_PLANNING', kind: 'START', reason: 'Storyboard of voice run 3, assembly v1', actor: 'editor' });
    const [requested] = await eventsOf(s.project.id, 'STORYBOARD_REQUESTED');
    expect(requested).toMatchObject({ jobId: job.id, message: 'Storyboard of voice run 3, assembly v1' });
    expect(requested!.data).toEqual({ actor: 'editor', type: 'VISUAL_PLAN', mode: 'GENERATE', narration: s.request.narration, approach: 'C', base: null, beatKeys: null, instructions: null, selectionRevision: 0 });
  });

  it('enters VISUAL_PLANNING by START, the gate’s send-back, REWIND or RECOVER, and runs again within it', async () => {
    const { projects } = setup();
    const cases: { from: ProjectStatus; failedFrom?: ProjectStatus; kind: string | null; phaseSeq: number }[] = [
      { from: 'VOICE_COMPLETE', kind: 'START', phaseSeq: 8 },
      { from: 'STORYBOARD_REVIEW', kind: 'REJECT', phaseSeq: 8 },
      { from: 'STORYBOARD_APPROVED', kind: 'REWIND', phaseSeq: 8 },
      { from: 'FAILED', failedFrom: 'VISUAL_PLANNING', kind: 'RECOVER', phaseSeq: 7 },
      { from: 'VISUAL_PLANNING', kind: null, phaseSeq: 7 },
    ];
    for (const c of cases) {
      const s = await seed(projects, c.from, c.failedFrom ?? null);
      const underReview = c.from === 'STORYBOARD_REVIEW' ? await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 1, status: 'IN_REVIEW' } }) : null;
      const job = await projects.storyboardJob(s.project.id, 'editor', `Re-plan from ${c.from}`, async () => s.request);
      expect(await projectOf(s.project.id), c.from).toMatchObject({ status: 'VISUAL_PLANNING', phaseSeq: c.phaseSeq, failedFromStatus: null });
      expect(job.phaseSeq, c.from).toBe(c.phaseSeq);
      const changes = await eventsOf(s.project.id, 'STATUS_CHANGED');
      expect(changes.map((e) => (e.data as { kind: string }).kind), c.from).toEqual(c.kind ? [c.kind] : []);
      // The send-back records no gate decision, and the version under review is left for the new version to supersede.
      expect(await db.approval.count({ where: { projectId: s.project.id, gate: 'STORYBOARD' } })).toBe(0);
      if (underReview) expect((await db.storyboard.findUniqueOrThrow({ where: { id: underReview.id } })).status).toBe('IN_REVIEW');
    }
  });

  it('is refused before the VOICE gate, once visual generation starts, and after another phase failed', async () => {
    const { projects } = setup();
    for (const [status, failedFrom] of [['SCRIPT_APPROVED'], ['VOICE_GENERATING'], ['VOICE_REVIEW'], ['VISUAL_GENERATING'], ['FAILED', 'VOICE_GENERATING']] as [ProjectStatus, ProjectStatus?][]) {
      const s = await seed(projects, status, failedFrom ?? null);
      let prepared = false;
      await expect(
        projects.storyboardJob(s.project.id, 'editor', 'Plan', async () => {
          prepared = true;
          return s.request;
        }),
        status,
      ).rejects.toThrow(/planned once the VOICE gate has approved the narration and before visual generation starts/);
      expect(prepared, status).toBe(false);
      expect(await projectOf(s.project.id), status).toMatchObject({ status, phaseSeq: 7 });
      expect(await db.job.count({ where: { projectId: s.project.id } }), status).toBe(0);
    }
  });

  it('runs one storyboard job at a time, whatever its type or phase run, and refuses before moving the project', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'VOICE_COMPLETE');
    const preview = await projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request);
    await expect(projects.storyboardJob(s.project.id, 'editor', 'Plan', async () => s.request)).rejects.toThrow(`A storyboard job (STORYBOARD_PREVIEW) is already queued (${preview.id}): wait for it to finish`);
    // Refused before the START, which would have cancelled the queued preview.
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'VOICE_COMPLETE', phaseSeq: 7 });
    expect((await db.job.findUniqueOrThrow({ where: { id: preview.id } })).status).toBe('QUEUED');
    expect(await db.$transaction((tx) => projects.activeStoryboardJob(tx, s.project.id))).toEqual({ id: preview.id, type: 'STORYBOARD_PREVIEW', status: 'QUEUED' });

    // A planning job still running from an earlier phase run (the project was sent back meanwhile) blocks too.
    const a = await seed(projects, 'STORYBOARD_APPROVED');
    const running = await db.job.create({ data: { projectId: a.project.id, languageVersionId: a.lv.id, type: 'VISUAL_PLAN', status: 'RUNNING', phaseSeq: 6 } });
    await expect(projects.storyboardJob(a.project.id, 'editor', 'Plan', async () => a.request)).rejects.toThrow(/A storyboard job \(VISUAL_PLAN\) is already running/);
    expect(await projectOf(a.project.id)).toMatchObject({ status: 'STORYBOARD_APPROVED', phaseSeq: 7 });
    await db.job.update({ where: { id: running.id }, data: { status: 'SUCCEEDED' } });
    expect(await db.$transaction((tx) => projects.activeStoryboardJob(tx, a.project.id))).toBeNull();
    await projects.storyboardJob(a.project.id, 'editor', 'Plan', async () => a.request);
    expect((await projectOf(a.project.id)).status).toBe('VISUAL_PLANNING');
  });

  it('names only the project’s own run, assembly and base version, with a valid input; a refused request changes nothing', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'VOICE_COMPLETE');
    const other = await seed(projects, 'VOICE_COMPLETE');
    const otherBoard = await db.storyboard.create({ data: { projectId: other.project.id, scriptId: other.script.id, version: 1 } });
    const ownBoard = await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 1 } });
    const notFound: [StoryboardJobRequest, RegExp][] = [
      [{ ...s.request, narration: { runId: other.run.id, assemblyId: other.assembly.id } }, /^Voice run .* not found$/],
      [{ ...s.request, narration: { runId: s.run.id, assemblyId: other.assembly.id } }, /^Assembly .* of voice run 3 not found$/],
      [{ ...s.request, mode: 'BEATS', base: { storyboardId: otherBoard.id, version: 1 }, beatKeys: ['VB01'] }, /^Storyboard v1 .* not found$/],
      [{ ...s.request, mode: 'APPROACH', approach: 'B', base: { storyboardId: ownBoard.id, version: 2 } }, /^Storyboard v2 .* not found$/],
    ];
    for (const [request, message] of notFound) {
      const attempt = projects.storyboardJob(s.project.id, 'editor', 'Plan', async () => request);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
      await expect(attempt).rejects.toThrow(message);
    }
    const invalid: StoryboardJobRequest[] = [
      { ...s.request, base: { storyboardId: ownBoard.id, version: 1 } }, // GENERATE has no base
      { ...s.request, mode: 'BEATS', base: { storyboardId: ownBoard.id, version: 1 } }, // BEATS names its beats
    ];
    for (const request of invalid) {
      await expect(projects.storyboardJob(s.project.id, 'editor', 'Plan', async () => request)).rejects.toHaveProperty('name', 'ZodError');
    }
    await expect(
      projects.storyboardJob(s.project.id, 'editor', 'Plan', async (tx, p) => {
        await tx.projectEvent.create({ data: { projectId: p.id, type: 'NOTE', message: 'written by prepare' } });
        throw new ConflictError('The visual profile selection changed: reload');
      }),
    ).rejects.toThrow(/selection changed/);

    expect(await projectOf(s.project.id)).toMatchObject({ status: 'VOICE_COMPLETE', phaseSeq: 7 });
    expect(await db.job.count({ where: { projectId: s.project.id } })).toBe(0);
    expect(await db.projectEvent.count({ where: { projectId: s.project.id, type: { in: ['STATUS_CHANGED', 'STORYBOARD_REQUESTED', 'JOB_QUEUED', 'NOTE'] } } })).toBe(0);

    // A base version of the project's own line is accepted.
    const beats = await projects.storyboardJob(s.project.id, 'editor', 'Re-plan VB02', async () => ({ ...s.request, mode: 'BEATS', base: { storyboardId: ownBoard.id, version: 1 }, beatKeys: ['VB02'], instructions: 'Show the ledger' }));
    expect(beats.input).toMatchObject({ mode: 'BEATS', base: { storyboardId: ownBoard.id, version: 1 }, beatKeys: ['VB02'], instructions: 'Show the ledger', requestedBy: 'editor' });
  });

  it('refuses a narration the job would refuse (another language, another script than the approved one) before anything moves', async () => {
    const { projects } = setup();
    const plan = await seed(projects, 'STORYBOARD_APPROVED');
    const preview = await seed(projects, 'VOICE_REVIEW');
    const cases = [
      { s: plan, ask: (r: StoryboardJobRequest) => projects.storyboardJob(plan.project.id, 'editor', 'Re-plan', async () => r) },
      { s: preview, ask: (r: StoryboardJobRequest) => projects.storyboardPreview(preview.project.id, 'editor', 'Preview', async () => r) },
    ];
    for (const { s, ask } of cases) {
      const status = s.project.status;
      const narrationOf = async (number: number, languageVersionId: string, scriptId: string) => {
        const run = await db.voiceRun.create({ data: { projectId: s.project.id, languageVersionId, scriptId, profileId: s.profile.id, number, kind: 'FULL', scope: {}, strategy: 'PLAIN', settings: {} } });
        const assembly = await db.voiceAssembly.create({ data: { runId: run.id, projectId: s.project.id, scriptId, profileId: s.profile.id, version: 1, entries: [], timeline: [], totalDurationMs: 0, qa: [] } });
        return { ...s.request, narration: { runId: run.id, assemblyId: assembly.id } };
      };
      const nl = await db.languageVersion.create({ data: { projectId: s.project.id, language: 'nl' } });
      const dutch = await narrationOf(4, nl.id, s.script.id);
      const v2 = await db.script.create({ data: { projectId: s.project.id, version: 2, status: 'IN_REVIEW' } });
      const ofDraft = await narrationOf(5, s.lv.id, v2.id);
      const refusals: [StoryboardJobRequest, string][] = [
        [dutch, 'Voice run 4 is not in the master language (en): a storyboard is timed by the master narration'],
        [ofDraft, "Voice run 5 narrates script v2, but the approved script is v1: a storyboard is planned on the approved script's narration"],
      ];
      for (const [request, message] of refusals) {
        const attempt = ask(request);
        await expect(attempt, status).rejects.toBeInstanceOf(ConflictError);
        await expect(attempt, status).rejects.toThrow(message);
      }
      // The approved script decides, not the run's own: once v2 is approved, v1's narration is refused; with none approved, every narration is.
      await db.script.update({ where: { id: s.script.id }, data: { status: 'SUPERSEDED' } });
      await db.script.update({ where: { id: v2.id }, data: { status: 'APPROVED' } });
      await expect(ask(s.request), status).rejects.toThrow("Voice run 3 narrates script v1, but the approved script is v2: a storyboard is planned on the approved script's narration");
      await db.script.update({ where: { id: v2.id }, data: { status: 'REJECTED' } });
      await expect(ask(ofDraft), status).rejects.toThrow("Voice run 5 narrates script v2, and no script is approved: a storyboard is planned on the approved script's narration");

      // A refused phase job never left the approved milestone.
      expect(await projectOf(s.project.id), status).toMatchObject({ status, phaseSeq: 7 });
      expect(await db.job.count({ where: { projectId: s.project.id } }), status).toBe(0);
      expect(await db.projectEvent.count({ where: { projectId: s.project.id, type: { in: ['STATUS_CHANGED', 'STORYBOARD_REQUESTED', 'JOB_QUEUED'] } } }), status).toBe(0);

      // The master narration of the approved script is planned (approved at the VOICE gate, for the phase job), with the actor as its requester whatever the request says.
      await db.script.update({ where: { id: v2.id }, data: { status: 'APPROVED' } });
      if (s === plan) await approveNarration(s.project.id, ofDraft.narration.assemblyId);
      const job = await ask({ ...ofDraft, requestedBy: 'someone else' } as StoryboardJobRequest);
      expect(job, status).toMatchObject({ languageVersionId: s.lv.id, input: { ...ofDraft, requestedBy: 'editor' } });
    }
  });

  it('plans on the narration the VOICE gate approved last, and on no other (a preview may use another)', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'STORYBOARD_APPROVED');
    const restored = await db.voiceAssembly.create({ data: { runId: s.run.id, projectId: s.project.id, scriptId: s.script.id, profileId: s.profile.id, version: 2, entries: [], timeline: [], totalDurationMs: 109_900, qa: [] } });
    const onRestored = { ...s.request, narration: { runId: s.run.id, assemblyId: restored.id } };
    const plan = (r: StoryboardJobRequest) => projects.storyboardJob(s.project.id, 'editor', 'Re-plan', async () => r);
    const notApproved = (v: number) => `Voice run 3, assembly v${v} is not the narration the VOICE gate approved: the storyboard reviewed at the STORYBOARD gate is planned on that narration (a preview may use another)`;

    // A newer assembly of the approved run is not approved; a later decision that is not an approval changes nothing.
    await approveNarration(s.project.id, restored.id, 'FLAGGED');
    await expect(plan(onRestored)).rejects.toThrow(notApproved(2));
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'STORYBOARD_APPROVED', phaseSeq: 7 });
    expect(await db.job.count({ where: { projectId: s.project.id } })).toBe(0);

    // The newest approval decides.
    await approveNarration(s.project.id, restored.id);
    await expect(plan(s.request)).rejects.toThrow(notApproved(1));
    expect(await plan(onRestored)).toMatchObject({ type: 'VISUAL_PLAN', input: { narration: onRestored.narration } });

    // No narration approved (a VOICE approval that names none) refuses the phase job, not a preview.
    const n = await seed(projects, 'VOICE_COMPLETE');
    await db.approval.updateMany({ where: { projectId: n.project.id }, data: { voiceAssemblyId: null } });
    await expect(projects.storyboardJob(n.project.id, 'editor', 'Plan', async () => n.request)).rejects.toThrow(
      'No narration is approved at the VOICE gate: the storyboard reviewed at the STORYBOARD gate is planned on the narration it approves',
    );
    expect(await projectOf(n.project.id)).toMatchObject({ status: 'VOICE_COMPLETE', phaseSeq: 7 });
    expect(await projects.storyboardPreview(n.project.id, 'editor', 'Preview', async () => n.request)).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED' });
  });

  it('runs on the mock pipeline to the STORYBOARD gate', async () => {
    const { projects, runner } = setup();
    const s = await seed(projects, 'VOICE_COMPLETE');
    await projects.storyboardJob(s.project.id, 'editor', 'Plan', async () => s.request);
    expect(await runner.drain()).toBe(1);
    expect((await projectOf(s.project.id)).status).toBe('STORYBOARD_REVIEW');
  });
});

describe('storyboardPreview: a side job', () => {
  it('runs in VOICE_REVIEW and VOICE_COMPLETE without ever moving the project', async () => {
    const { projects, runner } = setup();
    for (const status of ['VOICE_REVIEW', 'VOICE_COMPLETE'] as const) {
      const s = await seed(projects, status);
      const job = await projects.storyboardPreview(s.project.id, 'editor', 'Preview of the opening (audition run 3)', async () => s.request);
      expect(job, status).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED', phaseSeq: 7, languageVersionId: s.lv.id, input: { ...s.request, requestedBy: 'editor' } });
      const [requested] = await eventsOf(s.project.id, 'STORYBOARD_REQUESTED');
      expect(requested, status).toMatchObject({ jobId: job.id, message: 'Preview of the opening (audition run 3)' });
      expect(requested!.data, status).toMatchObject({ type: 'STORYBOARD_PREVIEW', mode: 'GENERATE' });
      expect(await runner.drain(), status).toBe(1);
      expect(await db.job.findUniqueOrThrow({ where: { id: job.id } }), status).toMatchObject({ status: 'SUCCEEDED', isMock: true });
      expect(await projectOf(s.project.id), status).toMatchObject({ status, phaseSeq: 7 });
      expect(await eventsOf(s.project.id, 'STATUS_CHANGED'), status).toHaveLength(0);
    }
  });

  it('is refused in every other status', async () => {
    const { projects } = setup();
    for (const status of ['SCRIPT_APPROVED', 'VOICE_GENERATING', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED', 'VISUAL_GENERATING'] as const) {
      const s = await seed(projects, status);
      await expect(projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request), status).rejects.toThrow(
        `STORYBOARD_PREVIEW runs while the project is in VOICE_REVIEW, VOICE_COMPLETE; it is in ${status}`,
      );
      expect(await db.job.count({ where: { projectId: s.project.id } }), status).toBe(0);
    }
    const failed = await seed(projects, 'FAILED', 'VOICE_GENERATING');
    await expect(projects.storyboardPreview(failed.project.id, 'editor', 'Preview', async () => failed.request)).rejects.toThrow(/Project has FAILED/);
  });

  it('leaves the project where it is when the preview fails', async () => {
    const { projects, runner } = setup({
      handlers: {
        STORYBOARD_PREVIEW: {
          type: 'STORYBOARD_PREVIEW',
          mock: true,
          run: async () => {
            throw new NonRetryableError('the narration has no word timings');
          },
        },
      },
    });
    const s = await seed(projects, 'VOICE_REVIEW');
    const job = await projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request);
    await runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', error: 'NonRetryableError: the narration has no word timings' });
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'VOICE_REVIEW', phaseSeq: 7, failedFromStatus: null });
  });

  it('is cancelled while queued when the VOICE gate decides (expected: request it again)', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'VOICE_REVIEW');
    const queued = await projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request);
    await projects.recordApproval(s.project.id, { gate: 'VOICE', decision: 'APPROVED' }, 'editor');
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'CANCELLED', error: 'Cancelled: project moved VOICE_REVIEW → VOICE_COMPLETE' });
    const again = await projects.storyboardPreview(s.project.id, 'editor', 'Preview again', async () => s.request);
    expect(again).toMatchObject({ status: 'QUEUED', phaseSeq: 8 });
  });

  it('runs one storyboard job at a time, through every way a job is queued', async () => {
    const { projects, runner } = setup({
      handlers: {
        STORYBOARD_PREVIEW: {
          type: 'STORYBOARD_PREVIEW',
          mock: true,
          run: async () => {
            throw new NonRetryableError('refused');
          },
        },
      },
    });
    const s = await seed(projects, 'VOICE_COMPLETE');
    const queued = await projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request);
    await expect(projects.storyboardPreview(s.project.id, 'editor', 'Preview', async () => s.request)).rejects.toThrow(/A storyboard job \(STORYBOARD_PREVIEW\) is already queued/);
    // The generic route refuses too, before its START would cancel the queued preview.
    await expect(projects.enqueueJob(s.project.id, { type: 'VISUAL_PLAN' }, 'editor')).rejects.toThrow(/A storyboard job \(STORYBOARD_PREVIEW\) is already queued/);
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'VOICE_COMPLETE', phaseSeq: 7 });
    expect((await db.job.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('QUEUED');

    // A retry waits for a planning job still running from an earlier phase run.
    await runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('FAILED');
    const running = await db.job.create({ data: { projectId: s.project.id, languageVersionId: s.lv.id, type: 'VISUAL_PLAN', status: 'RUNNING', phaseSeq: 6 } });
    await expect(projects.retryJob(queued.id, 'editor')).rejects.toThrow(/A storyboard job \(VISUAL_PLAN\) is already running/);
    await db.job.update({ where: { id: running.id }, data: { status: 'FAILED' } });
    expect(await projects.retryJob(queued.id, 'editor')).toMatchObject({ type: 'STORYBOARD_PREVIEW', status: 'QUEUED', input: queued.input });
  });
});

describe('reopenStoryboardReview', () => {
  it('re-opens an approved storyboard’s gate in the caller’s transaction, and the gate decides again', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'STORYBOARD_APPROVED');
    const reopened = await db.$transaction(async (tx) => {
      const p = await projects.reopenStoryboardReview(tx, s.project, 'editor', 'Edited shot SH004 of approved v1 (v2 to review)');
      await tx.projectEvent.create({ data: { projectId: p.id, type: 'STORYBOARD_EDITED', message: 'v2 saved' } });
      return p;
    });
    expect(reopened).toMatchObject({ status: 'STORYBOARD_REVIEW', phaseSeq: 8 });
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'STORYBOARD_REVIEW', phaseSeq: 8 });
    const [changed] = await eventsOf(s.project.id, 'STATUS_CHANGED');
    expect(changed!.data).toMatchObject({ from: 'STORYBOARD_APPROVED', to: 'STORYBOARD_REVIEW', kind: 'REWIND', reason: 'Edited shot SH004 of approved v1 (v2 to review)', actor: 'editor' });
    expect(await eventsOf(s.project.id, 'STORYBOARD_EDITED')).toHaveLength(1);

    await projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED' }, 'editor');
    expect((await projectOf(s.project.id)).status).toBe('STORYBOARD_APPROVED');
  });

  it('rolls back with the caller', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'STORYBOARD_APPROVED');
    await expect(
      db.$transaction(async (tx) => {
        await projects.reopenStoryboardReview(tx, s.project, 'editor', 'Edit');
        await tx.projectEvent.create({ data: { projectId: s.project.id, type: 'STORYBOARD_EDITED', message: 'v2 saved' } });
        throw new ConflictError('Storyboard v1 is no longer the newest version');
      }),
    ).rejects.toThrow(/no longer the newest/);
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'STORYBOARD_APPROVED', phaseSeq: 7 });
    expect(await db.projectEvent.count({ where: { projectId: s.project.id, type: { in: ['STATUS_CHANGED', 'STORYBOARD_EDITED'] } } })).toBe(0);
  });

  it('leaves an open gate as it is, reads the project’s current status, and refuses any other status', async () => {
    const { projects } = setup();
    const open = await seed(projects, 'STORYBOARD_REVIEW');
    const stale = { ...open.project, status: 'STORYBOARD_APPROVED' as const };
    const same = await db.$transaction((tx) => projects.reopenStoryboardReview(tx, stale, 'editor', 'Edit'));
    expect(same).toMatchObject({ status: 'STORYBOARD_REVIEW', phaseSeq: 7 });
    expect(await eventsOf(open.project.id, 'STATUS_CHANGED')).toHaveLength(0);

    for (const status of ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'VISUAL_GENERATING'] as const) {
      const s = await seed(projects, status);
      await expect(db.$transaction((tx) => projects.reopenStoryboardReview(tx, s.project, 'editor', 'Edit')), status).rejects.toThrow(
        `The STORYBOARD gate is re-opened from STORYBOARD_APPROVED (the project is ${status})`,
      );
      expect((await projectOf(s.project.id)).status, status).toBe(status);
    }
  });
});

describe('gate hooks', () => {
  it('passes the reviewer’s request to the hook and records the storyboard and language version it returns', async () => {
    const calls: Parameters<GateHook>[] = [];
    const boards: { id?: string; lv?: string } = {};
    const hook: GateHook = async (...args) => {
      calls.push(args);
      return { storyboardId: boards.id, languageVersionId: boards.lv };
    };
    const { projects } = setup({ gateHooks: { STORYBOARD: hook } });
    const s = await seed(projects, 'STORYBOARD_REVIEW');
    const board = await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 2, status: 'IN_REVIEW' } });
    Object.assign(boards, { id: board.id, lv: s.lv.id });

    const input: ApprovalInput = { gate: 'STORYBOARD', decision: 'APPROVED', notes: 'Cut points read well', artifactId: board.id };
    const { approval, project } = await projects.recordApproval(s.project.id, input, 'editor');
    expect(calls).toHaveLength(1);
    const [, seen, decision, actor, received] = calls[0]!;
    expect(seen).toMatchObject({ id: s.project.id, status: 'STORYBOARD_REVIEW' });
    expect([decision, actor, received]).toEqual(['APPROVED', 'editor', input]);
    expect(approval).toMatchObject({ gate: 'STORYBOARD', decision: 'APPROVED', storyboardId: board.id, languageVersionId: s.lv.id, voiceAssemblyId: null, projectStatus: 'STORYBOARD_REVIEW' });
    expect(project.status).toBe('STORYBOARD_APPROVED');
    expect(await db.job.count({ where: { projectId: s.project.id } })).toBe(0); // approving the gate enqueues nothing
  });

  it('refuses a decision on another version than the one the reviewer looked at, undoing the hook’s writes', async () => {
    let decidedOn = '';
    const hook: GateHook = async (tx) => {
      await tx.storyboard.update({ where: { id: decidedOn }, data: { status: 'APPROVED' } });
      return { storyboardId: decidedOn };
    };
    const { projects } = setup({ gateHooks: { STORYBOARD: hook } });
    const s = await seed(projects, 'STORYBOARD_REVIEW');
    const looked = await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 1, status: 'SUPERSEDED' } });
    const newer = await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 2, status: 'IN_REVIEW' } });
    decidedOn = newer.id;

    await expect(projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: looked.id }, 'editor')).rejects.toThrow(
      `STORYBOARD: the version you looked at (${looked.id}) is not the one under review (${newer.id}): reload and review it`,
    );
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe('IN_REVIEW');
    expect(await db.approval.count({ where: { projectId: s.project.id, gate: 'STORYBOARD' } })).toBe(0);
    expect((await projectOf(s.project.id)).status).toBe('STORYBOARD_REVIEW');

    // Without an artifact the decision stands on whatever the hook decides (the earlier contract).
    const { approval } = await projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED' }, 'editor');
    expect(approval).toMatchObject({ storyboardId: newer.id, languageVersionId: null });
  });

  it('runs the hook’s writes that name the approval once it is written, in the same transaction', async () => {
    let failWith: Error | null = null;
    const recorded: string[] = [];
    const hook: GateHook = async (tx, project, decision, actor) => {
      const board = await tx.storyboard.findFirstOrThrow({ where: { projectId: project.id, status: 'IN_REVIEW' } });
      await tx.storyboard.update({ where: { id: board.id }, data: { status: 'APPROVED' } });
      return {
        storyboardId: board.id,
        onRecorded: async (tx2, approval) => {
          recorded.push(approval.id);
          // A decision row naming the approval: the foreign key needs the approval written first.
          await tx2.storyboardDecision.create({ data: { projectId: project.id, storyboardId: board.id, decision: decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', decidedBy: actor, approvalId: approval.id } });
          if (failWith) throw failWith;
        },
      };
    };
    const { projects } = setup({ gateHooks: { STORYBOARD: hook } });
    const s = await seed(projects, 'STORYBOARD_REVIEW');
    const board = await db.storyboard.create({ data: { projectId: s.project.id, scriptId: s.script.id, version: 1, status: 'IN_REVIEW' } });

    // A refused artifact never reaches the writes that name the approval.
    await expect(projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: s.script.id }, 'editor')).rejects.toThrow(/is not the one under review/);
    expect(recorded).toHaveLength(0);

    // They roll back with the approval, the hook's writes and the status change.
    failWith = new ConflictError('decision row refused');
    await expect(projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: board.id }, 'editor')).rejects.toThrow('decision row refused');
    expect(recorded).toHaveLength(1);
    expect(await db.approval.count({ where: { projectId: s.project.id, gate: 'STORYBOARD' } })).toBe(0);
    expect(await db.storyboardDecision.count({ where: { projectId: s.project.id } })).toBe(0);
    expect((await db.storyboard.findUniqueOrThrow({ where: { id: board.id } })).status).toBe('IN_REVIEW');
    expect(await projectOf(s.project.id)).toMatchObject({ status: 'STORYBOARD_REVIEW', phaseSeq: 7 });
    expect(await eventsOf(s.project.id, 'APPROVAL_RECORDED')).toHaveLength(0);

    failWith = null;
    const { approval, project } = await projects.recordApproval(s.project.id, { gate: 'STORYBOARD', decision: 'APPROVED', artifactId: board.id }, 'editor');
    expect(recorded).toEqual([expect.any(String), approval.id]);
    expect(await db.storyboardDecision.findMany({ where: { projectId: s.project.id } })).toEqual([expect.objectContaining({ storyboardId: board.id, shotId: null, decision: 'APPROVED', decidedBy: 'editor', approvalId: approval.id })]);
    expect(approval.storyboardId).toBe(board.id);
    expect(project.status).toBe('STORYBOARD_APPROVED');
  });

  it('checks the artifact at the STORY, SCRIPT and VOICE gates against the version each records', async () => {
    let assemblyUnderReview = '';
    const { projects } = setup({ gateHooks: { VOICE: async () => ({ voiceAssemblyId: assemblyUnderReview }) } });
    const story = await seed(projects, 'STORY_REVIEW');
    const architecture = await db.storyArchitecture.create({ data: { projectId: story.project.id, version: 1, status: 'IN_REVIEW', content: {} } });
    const script = await seed(projects, 'SCRIPT_REVIEW');
    const draft = await db.script.create({ data: { projectId: script.project.id, version: 2, status: 'IN_REVIEW' } });
    const voice = await seed(projects, 'VOICE_REVIEW');
    assemblyUnderReview = voice.assembly.id;
    const cases = [
      { s: story, gate: 'STORY', looked: story.script.id, current: architecture.id, field: 'storyId' },
      { s: script, gate: 'SCRIPT', looked: script.script.id, current: draft.id, field: 'scriptId' }, // the approved v1, not the v2 under review
      { s: voice, gate: 'VOICE', looked: voice.run.id, current: voice.assembly.id, field: 'voiceAssemblyId' },
    ] as const;
    for (const c of cases) {
      await expect(projects.recordApproval(c.s.project.id, { gate: c.gate, decision: 'FLAGGED', artifactId: c.looked }, 'editor'), c.gate).rejects.toThrow(
        `${c.gate}: the version you looked at (${c.looked}) is not the one under review (${c.current}): reload and review it`,
      );
      const { approval } = await projects.recordApproval(c.s.project.id, { gate: c.gate, decision: 'FLAGGED', artifactId: c.current }, 'editor');
      expect(approval[c.field], c.gate).toBe(c.current);
    }
  });

  it('checks the artifact at every gate: the dossier, story or script under review, and nothing where a gate records none', async () => {
    const { projects } = setup();
    const s = await seed(projects, 'RESEARCH_REVIEW');
    const dossier = await db.researchDossier.create({ data: { projectId: s.project.id, version: 1, status: 'IN_REVIEW' } });
    await expect(projects.recordApproval(s.project.id, { gate: 'RESEARCH', decision: 'APPROVED', artifactId: s.script.id }, 'editor')).rejects.toThrow(
      `RESEARCH: the version you looked at (${s.script.id}) is not the one under review (${dossier.id}): reload and review it`,
    );
    expect((await db.researchDossier.findUniqueOrThrow({ where: { id: dossier.id } })).status).toBe('IN_REVIEW');
    const { approval } = await projects.recordApproval(s.project.id, { gate: 'RESEARCH', decision: 'APPROVED', artifactId: dossier.id }, 'editor');
    expect(approval).toMatchObject({ dossierId: dossier.id, storyboardId: null, languageVersionId: null });

    const assets = await seed(projects, 'VISUAL_REVIEW');
    await expect(projects.recordApproval(assets.project.id, { gate: 'VISUAL_ASSETS', decision: 'APPROVED', artifactId: assets.script.id }, 'editor')).rejects.toThrow(
      `VISUAL_ASSETS: the version you looked at (${assets.script.id}) is not the one under review: reload and review it`,
    );
    expect(await db.approval.count({ where: { projectId: assets.project.id } })).toBe(0);
  });
});
