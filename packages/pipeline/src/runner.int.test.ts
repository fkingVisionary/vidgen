import type { JobType, ProjectStatus } from '@docengine/core';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { NonRetryableError } from './errors.ts';
import type { StageHandler, StageHandlers } from './handlers.ts';
import { ProjectService } from './project-service.ts';
import { PostgresJobQueue } from './queue.ts';
import { JobRunner, isRetryable, retryDelayMs } from './runner.ts';
import { createMockStageHandlers } from './stages/mock-stages.ts';

const db = useTestDatabase();

function setup(overrides: Partial<StageHandlers> = {}, runnerOpts: { workerId?: string } = {}) {
  const projects = new ProjectService({ db });
  const queue = new PostgresJobQueue(db);
  const runner = new JobRunner({
    db,
    queue,
    projects,
    handlers: { ...createMockStageHandlers(), ...overrides },
    providers: createProviders(ALL_MOCK),
    retryBaseDelayMs: 0, // retries are immediately claimable in tests
    ...runnerOpts,
  });
  return { projects, queue, runner };
}

const statusOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).status;

describe('mocked pipeline, end to end', () => {
  it('moves a project from IDEA to APPROVED with MOCK jobs and human approvals, but never fakes PUBLISHED', async () => {
    const { projects, runner } = setup();
    const p = await projects.createProject(tulipInput, 'test');
    const visited: ProjectStatus[] = [];

    const run = async (type: JobType) => {
      await projects.enqueueJob(p.id, { type }, 'test');
      expect(await runner.drain()).toBe(1);
      visited.push(await statusOf(p.id));
    };
    const approve = async (gate: Parameters<typeof projects.recordApproval>[1]['gate']) => {
      await projects.recordApproval(p.id, { gate, decision: 'APPROVED', notes: 'looks good' }, 'test');
      visited.push(await statusOf(p.id));
    };

    await run('RESEARCH');
    await approve('RESEARCH');
    await run('STORY_MINING');
    await run('STORY_ARCHITECTURE');
    await approve('STORY');
    await run('SCRIPT');
    await approve('SCRIPT');
    await run('VOICE');
    await approve('VOICE');
    await run('VISUAL_PLAN');
    await approve('STORYBOARD');
    await run('VISUAL_GENERATION');
    expect(await statusOf(p.id)).toBe('VISUAL_GENERATING'); // waits for the parallel INFOGRAPHIC job
    await run('INFOGRAPHIC');
    await approve('VISUAL_ASSETS');
    await run('EDIT');
    await run('RENDER');
    await run('QA');
    await approve('FINAL_VIDEO');
    await run('PUBLISH');

    expect(visited).toEqual([
      'RESEARCH_REVIEW',
      'RESEARCH_COMPLETE',
      'STORY_SELECTION', // mining done; the editor curates the candidates
      'STORY_REVIEW',
      'STORY_APPROVED',
      'SCRIPT_REVIEW', // enqueueing SCRIPT starts SCRIPT_DRAFT; the job completes it
      'SCRIPT_APPROVED',
      'VOICE_REVIEW', // narration generated; a human approves the assembled narration
      'VOICE_COMPLETE',
      'STORYBOARD_REVIEW',
      'VISUAL_GENERATING',
      'VISUAL_GENERATING',
      'VISUAL_REVIEW',
      'EDITING',
      'RENDERING',
      'QA',
      'QA', // QA job done; waiting for the human
      'APPROVED',
      'APPROVED', // a MOCK publish must not mark the project PUBLISHED
    ]);

    const jobs = await db.job.findMany({ where: { projectId: p.id } });
    expect(jobs).toHaveLength(12);
    expect(jobs.every((j) => j.status === 'SUCCEEDED' && j.isMock && j.attempts === 1)).toBe(true);
    const publish = jobs.find((j) => j.type === 'PUBLISH')!;
    expect(publish.result).toMatchObject({ mock: true, published: false, state: 'NOT_PUBLISHED' });
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'PHASE_BLOCKED_MOCK' } })).toBe(1);

    // Every provider call is in the ledger, flagged MOCK, at $0.
    const calls = await db.providerCall.findMany({ where: { projectId: p.id } });
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.every((c) => c.isMock && c.status === 'SUCCEEDED' && c.durationMs !== null)).toBe(true);
    expect(calls.every((c) => c.estimatedCostUsd?.toNumber() === 0)).toBe(true);
    expect(calls.find((c) => c.operation === 'createImage')?.providerJobId).toMatch(/^mock-image-/);

    // Approvals were recorded with the status they were made in.
    const approvals = await db.approval.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'asc' } });
    expect(approvals.map((a) => `${a.gate}@${a.projectStatus}`)).toEqual([
      'RESEARCH@RESEARCH_REVIEW',
      'STORY@STORY_REVIEW',
      'SCRIPT@SCRIPT_REVIEW',
      'VOICE@VOICE_REVIEW',
      'STORYBOARD@STORYBOARD_REVIEW',
      'VISUAL_ASSETS@VISUAL_REVIEW',
      'FINAL_VIDEO@QA',
    ]);
  });

  it('refuses final approval before the QA job has run', async () => {
    const { projects, runner } = setup();
    const p = await projects.createProject(tulipInput, 'test');
    await db.project.update({ where: { id: p.id }, data: { status: 'RENDERING' } });
    await projects.enqueueJob(p.id, { type: 'RENDER' }, 'test');
    await runner.drain();
    expect(await statusOf(p.id)).toBe('QA');
    await expect(projects.recordApproval(p.id, { gate: 'FINAL_VIDEO', decision: 'APPROVED' }, 'test')).rejects.toThrow(/must succeed first/);
  });
});

describe('failures and retries', () => {
  const flaky = (failures: number, err: () => Error = () => new Error('transient')): StageHandler & { calls: number } => {
    const h = {
      type: 'RESEARCH' as const,
      mock: true,
      calls: 0,
      async run() {
        h.calls++;
        if (h.calls <= failures) throw err();
        return { ok: true };
      },
    };
    return h;
  };

  it('retries a transient failure and then succeeds', async () => {
    const handler = flaky(1);
    const { projects, runner } = setup({ RESEARCH: handler });
    const p = await projects.createProject(tulipInput, 'test');
    const job = await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await runner.drain();
    expect(handler.calls).toBe(2);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 2, error: null });
    expect(await statusOf(p.id)).toBe('RESEARCH_REVIEW');
    expect(await db.projectEvent.count({ where: { jobId: job.id, type: 'JOB_RETRY_SCHEDULED' } })).toBe(1);
  });

  it('fails the project after the last attempt, then recovers through a retry', async () => {
    const handler = flaky(3);
    const { projects, runner } = setup({ RESEARCH: handler });
    const p = await projects.createProject(tulipInput, 'test');
    const job = await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await db.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'FAILED', failedFromStatus: 'RESEARCHING' });

    const retry = await projects.retryJob(job.id, 'test');
    expect(await db.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'RESEARCHING', failedFromStatus: null });
    await runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await statusOf(p.id)).toBe('RESEARCH_REVIEW');
  });

  it('does not retry non-retryable errors', async () => {
    const handler = flaky(5, () => new NonRetryableError('bad input'));
    const { projects, runner } = setup({ RESEARCH: handler });
    const p = await projects.createProject(tulipInput, 'test');
    const job = await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await runner.drain();
    expect(handler.calls).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', attempts: 1, error: 'NonRetryableError: bad input' });
  });

  it('ignores a job that finishes after the project was rewound', async () => {
    const { projects, queue, runner } = setup();
    const p = await projects.createProject(tulipInput, 'test');
    await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    const claimed = await queue.claim('other-worker');
    // While the job is "running", a human rewinds the project.
    await projects.rewind(p.id, { to: 'IDEA', reason: 'changed topic' }, 'test');
    await db.$transaction((tx) => projects.onJobSucceeded(tx, { ...claimed!, status: 'SUCCEEDED' }));
    expect(await statusOf(p.id)).toBe('IDEA');
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'JOB_IGNORED_STALE' } })).toBe(1);
    expect(runner).toBeDefined();
  });
});

describe('queue mechanics', () => {
  it('never hands the same job to two workers (FOR UPDATE SKIP LOCKED)', async () => {
    const { projects } = setup();
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const p = await projects.createProject({ ...tulipInput, title: `Project ${i}` }, 'test');
      ids.push((await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test')).id);
    }
    const executed: string[] = [];
    const recording: StageHandler = { type: 'RESEARCH', mock: true, run: async (ctx) => (executed.push(ctx.job.id), {}) };
    const a = setup({ RESEARCH: recording }, { workerId: 'worker-a' }).runner;
    const b = setup({ RESEARCH: recording }, { workerId: 'worker-b' }).runner;
    const [na, nb] = await Promise.all([a.drain(), b.drain()]);
    expect(na + nb).toBe(6);
    expect(executed.sort()).toEqual(ids.sort());
  });

  it('recovers a job whose worker died', async () => {
    const { projects, queue, runner } = setup();
    const p = await projects.createProject(tulipInput, 'test');
    const job = await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await queue.claim('dead-worker');
    await db.$executeRaw`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}::uuid`;
    expect(await runner.recoverAbandoned()).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'QUEUED', lockedBy: null });
    await runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });

  it('returns an interrupted job to the queue on shutdown without using an attempt', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const blocking: StageHandler = {
      type: 'RESEARCH',
      mock: true,
      run: (ctx) =>
        new Promise((_, reject) => {
          started();
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const { projects, runner } = setup({ RESEARCH: blocking });
    const p = await projects.createProject(tulipInput, 'test');
    const job = await projects.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    runner.start();
    await startedP;
    await runner.stop();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'QUEUED', attempts: 0, lockedBy: null });
  });
});

describe('runner configuration', () => {
  it('keeps the heartbeat well inside a short lock timeout', () => {
    const base = { db, queue: new PostgresJobQueue(db), projects: new ProjectService({ db }), handlers: createMockStageHandlers(), providers: createProviders(ALL_MOCK) };
    expect(new JobRunner({ ...base, lockTimeoutMs: 10_000 }).heartbeatIntervalMs).toBe(3_333);
    expect(new JobRunner({ ...base }).heartbeatIntervalMs).toBe(30_000);
  });
});

describe('retry policy', () => {
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, 5_000, 30_000))).toEqual([5_000, 10_000, 20_000, 30_000]);
  });

  it('classifies errors', () => {
    expect(isRetryable(new Error('timeout'))).toBe(true);
    expect(isRetryable(new NonRetryableError('bad'))).toBe(false);
  });
});
