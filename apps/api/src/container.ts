import { createDatabase, type Database } from '@docengine/database';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers, type JobQueue } from '@docengine/pipeline';
import type { JobType } from '@docengine/core';
import { createProviders, describeProviders, type ProviderSet } from '@docengine/providers';
import { createResearchStage, type ResearchConfig } from '@docengine/research';
import { createStoryAnglesStage, createStoryArchitectureStage, createStoryMiningStage, type StoryConfig } from '@docengine/story';
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
  /** Stages backed by real implementations (all others are MOCK placeholders). */
  realStages: JobType[];
  close(): Promise<void>;
}

export function createContainer(
  env: Env,
  logger: Logger,
  overrides: { db?: Database; providers?: ProviderSet; researchConfig?: Partial<ResearchConfig>; storyConfig?: Partial<StoryConfig> } = {},
): AppContainer {
  const db = overrides.db ?? createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_SIZE });
  // Fails fast with a clear message if a provider is configured that is not implemented.
  const providers = overrides.providers ?? createProviders(providerSelection(env), { settings: providerSettings(env) });
  const queue: JobQueue = new PostgresJobQueue(db);
  const projects = new ProjectService({
    db,
    logger,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    onJobQueued: (job) => queue.notify(job),
  });
  // Real stages replace MOCK placeholders when the providers they need are real.
  const handlers = createMockStageHandlers();
  if (!providers.ai.info.mock && !providers.research.info.mock) {
    handlers.RESEARCH = createResearchStage({ maxCostUsd: env.RESEARCH_MAX_COST_USD, maxSourcesToRetrieve: env.RESEARCH_MAX_SOURCES, ...overrides.researchConfig });
  }
  if (!providers.ai.info.mock) {
    const story: Partial<StoryConfig> = { maxCostUsd: { mining: env.STORY_MAX_COST_USD, architecture: env.STORY_MAX_COST_USD, angles: env.STORY_MAX_COST_USD }, ...overrides.storyConfig };
    handlers.STORY_MINING = createStoryMiningStage(story);
    handlers.STORY_ARCHITECTURE = createStoryArchitectureStage(story);
    handlers.STORY_ANGLES = createStoryAnglesStage(story);
  }
  const realStages = Object.values(handlers).filter((h) => !h.mock).map((h) => h.type);
  const runner = new JobRunner({
    db,
    queue,
    projects,
    handlers,
    providers,
    logger,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    concurrency: env.WORKER_CONCURRENCY,
    lockTimeoutMs: env.JOB_LOCK_TIMEOUT_MS,
  });

  const mocks = describeProviders(providers).filter((p) => p.mock).map((p) => p.kind);
  if (mocks.length > 0) logger.warn({ mockProviders: mocks }, 'MOCK providers active: outputs are placeholders, not real work');
  logger.info({ realStages, mockStages: Object.values(handlers).filter((h) => h.mock).map((h) => h.type) }, 'stage handlers');

  return {
    env,
    logger,
    db,
    providers,
    queue,
    projects,
    runner,
    realStages,
    async close() {
      await runner.stop();
      if (!overrides.db) await db.$disconnect();
    },
  };
}
