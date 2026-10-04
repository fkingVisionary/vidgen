import { hostname } from 'node:os';
import type { Database, Job, Prisma } from '@docengine/database';
import { ProviderError, type ProviderSet } from '@docengine/providers';
import { createStageContext } from './context.ts';
import { NonRetryableError } from './errors.ts';
import { EVENT } from './events.ts';
import type { StageHandlers } from './handlers.ts';
import { silentLogger, type Logger } from './logger.ts';
import type { ProjectService } from './project-service.ts';
import type { JobQueue } from './queue.ts';

export interface JobRunnerOptions {
  db: Database;
  queue: JobQueue;
  projects: ProjectService;
  handlers: StageHandlers;
  providers: ProviderSet;
  logger?: Logger;
  workerId?: string;
  pollIntervalMs?: number;
  concurrency?: number;
  /** RUNNING jobs without a heartbeat for this long are treated as abandoned. */
  lockTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof NonRetryableError) return false;
  if (err instanceof Error && err.name === 'ZodError') return false; // invalid data does not fix itself
  return true;
}

/** Exponential backoff: base, 2×base, 4×base … capped. `attempt` is 1-based. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

const errorMessage = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * Executes queued jobs. In V1 it runs inside the API process
 * (WORKER_ENABLED=true); `apps/api/src/worker.ts` runs the same runner as a
 * standalone process, which is how stages scale out later.
 */
export class JobRunner {
  readonly workerId: string;
  private readonly o: Required<Omit<JobRunnerOptions, 'logger' | 'workerId'>> & { logger: Logger };
  private loops: Promise<void>[] = [];
  private abort = new AbortController();
  private lastRecovery = 0;

  constructor(opts: JobRunnerOptions) {
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}`;
    const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as JobRunnerOptions;
    this.o = {
      pollIntervalMs: 1_000,
      concurrency: 1,
      lockTimeoutMs: 15 * 60_000,
      heartbeatIntervalMs: 30_000,
      retryBaseDelayMs: 5_000,
      retryMaxDelayMs: 5 * 60_000,
      ...defined,
      logger: (opts.logger ?? silentLogger).child({ workerId: this.workerId }),
    };
  }

  get running(): boolean {
    return this.loops.length > 0;
  }

  start(): void {
    if (this.running) return;
    this.abort = new AbortController();
    this.loops = Array.from({ length: this.o.concurrency }, (_, i) => this.loop(i));
    this.o.logger.info({ concurrency: this.o.concurrency, queue: this.o.queue.name }, 'job runner started');
  }

  /** Stops polling and waits for in-flight jobs to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.abort.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
    this.o.logger.info({}, 'job runner stopped');
  }

  /** Claims and executes at most one job. Returns false if nothing was runnable. */
  async runOnce(): Promise<boolean> {
    const job = await this.o.queue.claim(this.workerId);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Runs jobs until none are runnable. For tests and one-off scripts. */
  async drain(maxJobs = 1_000): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  /** Fails-or-retries RUNNING jobs whose worker died (no heartbeat within the lock timeout). */
  async recoverAbandoned(): Promise<number> {
    const abandoned = await this.o.queue.findAbandoned(this.o.lockTimeoutMs);
    for (const job of abandoned) {
      const err = new Error(`Worker ${job.lockedBy ?? 'unknown'} stopped responding (no heartbeat for ${this.o.lockTimeoutMs}ms)`);
      await this.handleFailure(job, err, job.lockedBy ?? '', this.o.logger.child({ jobId: job.id, projectId: job.projectId, jobType: job.type }));
    }
    if (abandoned.length > 0) this.o.logger.warn({ count: abandoned.length }, 'recovered abandoned jobs');
    return abandoned.length;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async loop(index: number): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      let didWork = false;
      try {
        if (index === 0 && Date.now() - this.lastRecovery > Math.min(60_000, this.o.lockTimeoutMs)) {
          this.lastRecovery = Date.now();
          await this.recoverAbandoned();
        }
        didWork = await this.runOnce();
      } catch (err) {
        // Infrastructure trouble (e.g. database unreachable). Never crash the process; back off and retry.
        this.o.logger.error({ err: errorMessage(err) }, 'job runner loop error');
      }
      if (!didWork) await sleep(this.o.pollIntervalMs, signal);
    }
  }

  private async execute(job: Job): Promise<void> {
    const log = this.o.logger.child({ jobId: job.id, projectId: job.projectId, jobType: job.type, attempt: job.attempts });
    const started = performance.now();
    const heartbeat = setInterval(() => {
      this.o.queue.heartbeat(job.id, this.workerId).catch((err) => log.warn({ err: errorMessage(err) }, 'heartbeat failed'));
    }, this.o.heartbeatIntervalMs);
    heartbeat.unref();
    log.info({}, 'job started');

    try {
      const handler = this.o.handlers[job.type];
      if (!handler) throw new NonRetryableError(`No stage handler registered for ${job.type}`);

      const project = await this.o.db.project.findUniqueOrThrow({ where: { id: job.projectId } });
      const languageVersion = job.languageVersionId
        ? await this.o.db.languageVersion.findUniqueOrThrow({ where: { id: job.languageVersionId } })
        : await this.o.db.languageVersion.findUniqueOrThrow({
            where: { projectId_language: { projectId: project.id, language: project.masterLanguage } },
          });
      const ctx = createStageContext({
        job,
        project,
        languageVersion,
        db: this.o.db,
        providers: this.o.providers,
        logger: log,
        signal: this.abort.signal,
      });

      const result = await handler.run(ctx);
      const isMock = handler.mock || ctx.usedMockProvider();
      const durationMs = Math.round(performance.now() - started);

      await this.o.db.$transaction(async (tx) => {
        const claimed = await tx.job.updateMany({
          where: { id: job.id, status: 'RUNNING', lockedBy: this.workerId },
          data: {
            status: 'SUCCEEDED',
            result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            isMock,
            error: null,
            completedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        });
        if (claimed.count === 0) {
          log.warn({}, 'job lock lost before completion; result discarded');
          return;
        }
        const done = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
        await tx.projectEvent.create({
          data: {
            projectId: job.projectId,
            jobId: job.id,
            type: EVENT.JOB_SUCCEEDED,
            message: `${job.type} succeeded${isMock ? ' (MOCK)' : ''} in ${durationMs}ms`,
            data: { durationMs, attempt: job.attempts, isMock },
          },
        });
        await this.o.projects.onJobSucceeded(tx, done);
      });
      log.info({ durationMs, status: 'SUCCEEDED', isMock }, 'job succeeded');
    } catch (err) {
      if (this.abort.signal.aborted) {
        // Interrupted by shutdown (e.g. a Railway redeploy), not by a fault: hand the job back without using up an attempt.
        await this.release(job, log);
      } else {
        await this.handleFailure(job, err, this.workerId, log, Math.round(performance.now() - started));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async release(job: Job, log: Logger): Promise<void> {
    try {
      await this.o.db.$executeRaw`
        UPDATE jobs
           SET status = 'QUEUED', attempts = GREATEST(attempts - 1, 0), locked_at = NULL, locked_by = NULL,
               run_after = now(), updated_at = now()
         WHERE id = ${job.id}::uuid AND status = 'RUNNING' AND locked_by = ${this.workerId}`;
      log.warn({ status: 'RELEASED' }, 'job interrupted by shutdown; returned to the queue');
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'could not release job on shutdown; it will be recovered after the lock timeout');
    }
  }

  private async handleFailure(job: Job, err: unknown, lockOwner: string, log: Logger, durationMs?: number): Promise<void> {
    const message = errorMessage(err).slice(0, 4_000);
    const retry = isRetryable(err) && job.attempts < job.maxAttempts;
    try {
      await this.o.db.$transaction(async (tx) => {
        if (retry) {
          const delayMs = retryDelayMs(job.attempts, this.o.retryBaseDelayMs, this.o.retryMaxDelayMs);
          const n = await tx.$executeRaw`
            UPDATE jobs
               SET status = 'QUEUED', error = ${message}, locked_at = NULL, locked_by = NULL, updated_at = now(),
                   run_after = now() + (${delayMs}::int * interval '1 millisecond')
             WHERE id = ${job.id}::uuid AND status = 'RUNNING' AND locked_by = ${lockOwner}`;
          if (n === 0) return;
          await tx.projectEvent.create({
            data: {
              projectId: job.projectId,
              jobId: job.id,
              type: EVENT.JOB_RETRY_SCHEDULED,
              message: `${job.type} attempt ${job.attempts}/${job.maxAttempts} failed; retrying in ${Math.round(delayMs / 1000)}s: ${message}`,
              data: { attempt: job.attempts, delayMs, error: message },
            },
          });
          log.warn({ durationMs, status: 'RETRY_SCHEDULED', delayMs, err: message }, 'job failed; retry scheduled');
        } else {
          const n = await tx.job.updateMany({
            where: { id: job.id, status: 'RUNNING', lockedBy: lockOwner },
            data: { status: 'FAILED', error: message, completedAt: new Date(), lockedAt: null, lockedBy: null },
          });
          if (n.count === 0) return;
          const failed = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
          await tx.projectEvent.create({
            data: {
              projectId: job.projectId,
              jobId: job.id,
              type: EVENT.JOB_FAILED,
              message: `${job.type} failed after ${job.attempts} attempt(s): ${message}`,
              data: { attempt: job.attempts, error: message, retryable: isRetryable(err) },
            },
          });
          await this.o.projects.onJobFailed(tx, failed);
          log.error({ durationMs, status: 'FAILED', err: message }, 'job failed');
        }
      });
    } catch (dbErr) {
      log.error({ err: errorMessage(dbErr), original: message }, 'could not record job failure');
    }
    if (retry) {
      const queued = await this.o.db.job.findUnique({ where: { id: job.id } });
      if (queued?.status === 'QUEUED') await this.o.queue.notify(queued);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
