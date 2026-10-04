import { createDatabase, type Database } from '@docengine/database';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers, type JobQueue } from '@docengine/pipeline';
import { createProviders, describeProviders, type ProviderSet } from '@docengine/providers';
import type { Logger } from 'pino';
import { providerSelection, providerSettings, type Env } from './env.ts';

/**
 * Composition root: the only place where concrete implementations are chosen
 * and wired together. Everything else depends on interfaces.
 */
export interface AppContainer {
  env: Env;
  logger: Logger;
  db: Database;
  providers: ProviderSet;
  queue: JobQueue;
  projects: ProjectService;
  runner: JobRunner;
  close(): Promise<void>;
}

export function createContainer(env: Env, logger: Logger, overrides: { db?: Database } = {}): AppContainer {
  const db = overrides.db ?? createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_SIZE });
  // Fails fast with a clear message if a provider is configured that is not implemented.
  const providers = createProviders(providerSelection(env), { settings: providerSettings(env) });
  const queue: JobQueue = new PostgresJobQueue(db);
  const projects = new ProjectService({
    db,
    logger,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    onJobQueued: (job) => queue.notify(job),
  });
  const runner = new JobRunner({
    db,
    queue,
    projects,
    // Milestone 1: every stage is a MOCK placeholder. Real modules replace entries here.
    handlers: createMockStageHandlers(),
    providers,
    logger,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    concurrency: env.WORKER_CONCURRENCY,
    lockTimeoutMs: env.JOB_LOCK_TIMEOUT_MS,
  });

  const mocks = describeProviders(providers).filter((p) => p.mock).map((p) => p.kind);
  if (mocks.length > 0) logger.warn({ mockProviders: mocks }, 'MOCK providers active: outputs are placeholders, not real work');

  return {
    env,
    logger,
    db,
    providers,
    queue,
    projects,
    runner,
    async close() {
      await runner.stop();
      if (!overrides.db) await db.$disconnect();
    },
  };
}
