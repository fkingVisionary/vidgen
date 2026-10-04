import type { Database, Job } from '@docengine/database';

/**
 * How queued jobs reach workers. The `jobs` table is always the source of
 * truth for job state; a queue is only the transport.
 *
 * V1: PostgresJobQueue — workers poll the table (no extra infrastructure).
 * Later: a BullMQ/Redis queue can implement the same interface: `notify`
 * pushes the job id to Redis and `claim` takes ids from it, then claims the
 * row by id. The runner, handlers and API do not change.
 */
export interface JobQueue {
  readonly name: string;
  /** A job row was committed as QUEUED (new, or rescheduled for retry). */
  notify(job: Job): Promise<void>;
  /** Atomically claim the next runnable job: QUEUED → RUNNING, attempts + 1, locked by `workerId`. */
  claim(workerId: string): Promise<Job | null>;
  /** Refresh the lock of a running job so it is not treated as abandoned. */
  heartbeat(jobId: string, workerId: string): Promise<void>;
  /** RUNNING jobs whose worker stopped heart-beating for longer than `lockTimeoutMs`. */
  findAbandoned(lockTimeoutMs: number): Promise<Job[]>;
}

export class PostgresJobQueue implements JobQueue {
  readonly name = 'postgres';

  constructor(private readonly db: Database) {}

  async notify(): Promise<void> {
    // Polling transport: workers will find the row.
  }

  async claim(workerId: string): Promise<Job | null> {
    // SKIP LOCKED lets any number of workers poll concurrently without ever
    // claiming the same job twice. Times use the database clock throughout.
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE jobs
         SET status = 'RUNNING',
             attempts = attempts + 1,
             locked_at = now(),
             locked_by = ${workerId},
             started_at = now(),
             updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'QUEUED' AND run_after <= now()
          ORDER BY run_after, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING id`;
    const id = rows[0]?.id;
    return id ? this.db.job.findUnique({ where: { id } }) : null;
  }

  async heartbeat(jobId: string, workerId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE jobs SET locked_at = now()
       WHERE id = ${jobId}::uuid AND status = 'RUNNING' AND locked_by = ${workerId}`;
  }

  async findAbandoned(lockTimeoutMs: number): Promise<Job[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM jobs
       WHERE status = 'RUNNING'
         AND locked_at < now() - (${Math.round(lockTimeoutMs)}::int * interval '1 millisecond')`;
    if (rows.length === 0) return [];
    return this.db.job.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }
}
