import { createDatabase, type Database } from '@docengine/database';
import { JobRunner, NonRetryableError, PostgresJobQueue, ProjectService, createMockStageHandlers, type JobQueue, type StageHandler } from '@docengine/pipeline';
import type { HealthView, JobType, VisualCatalog } from '@docengine/core';
import { createProviders, createVisualCatalog, describeProviders, probeStorage, type ProviderSet } from '@docengine/providers';
import { createResearchStage, type ResearchConfig } from '@docengine/research';
import { ScriptEditing, createScriptStage, parseNarrationModes, parseScriptModels, type ScriptConfig } from '@docengine/script';
import { createStoryAnglesStage, createStoryArchitectureStage, createStoryMiningStage, type StoryConfig } from '@docengine/story';
import { StoryboardService, createStoryboardStage, parseStoryboardModels, storyboardGate, type StoryboardConfig } from '@docengine/storyboard';
import { VoiceService, createVoiceStage, voiceGate, type VoiceStageConfig } from '@docengine/voice';
import type { Logger } from 'pino';
import { providerSelection, providerSettings, visualPricingSettings, type Env } from './env.ts';
import { toJobView } from './views.ts';

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
  /** The editor's changes to the script under review. */
  scripts: ScriptEditing;
  /** Narration: voice runs, takes, decisions, pronunciations, profiles. */
  voice: VoiceService;
  /** Storyboards: planning requests, versions, edits, decisions, the visual profile library. */
  storyboards: StoryboardService;
  /** The catalog the storyboard's cost forecasts are priced from (published prices, the user's over them); never called. */
  visualCatalog: VisualCatalog;
  /** Stages backed by real implementations (all others are MOCK placeholders). */
  realStages: JobType[];
  /** Whether real storage and the real voice provider were reachable at startup (checked once, in the background). */
  connectivity: ConnectivityCheck;
  close(): Promise<void>;
}

/** What the startup connectivity checks found, as /api/health reports it. */
export type Connectivity = Pick<HealthView, 'storage' | 'storageDetail' | 'voice' | 'voiceDetail'>;

export interface ConnectivityCheck {
  /** Settles when the checks have finished; never rejects. */
  readonly done: Promise<Connectivity>;
  /** The result so far: a real provider reads 'error' ("still running") until its check finishes. */
  current(): Connectivity;
}

/** A startup check that has not answered by then counts as failed. */
export const CONNECTIVITY_TIMEOUT_MS = 15_000;

/** Why visual generation does not run (the hard stop after the storyboard). */
export const VISUAL_GENERATION_HELD = 'Visual generation is the next milestone; it starts only after the storyboard is reviewed and accepted';

/**
 * The hard stop while the storyboard is real: VISUAL_GENERATION and
 * INFOGRAPHIC are refused on enqueue and retry, and a job of either type
 * that reaches the worker anyway (queued before this release) fails here,
 * calling no provider and writing nothing.
 */
export const visualGenerationHeld = (realStages: readonly JobType[], type: JobType): boolean => (type === 'VISUAL_GENERATION' || type === 'INFOGRAPHIC') && realStages.includes('VISUAL_PLAN');

/** A held stage: its job fails at once, non-retryably, with the reason. */
function heldStage(type: JobType): StageHandler {
  return {
    type,
    mock: true,
    run: async () => {
      throw new NonRetryableError(VISUAL_GENERATION_HELD);
    },
  };
}

/**
 * Reaches real storage and the real voice provider once, spending nothing:
 * a tiny object written, read back and deleted; the configured voice and
 * model looked up. Never throws and never blocks startup; MOCK providers are
 * not checked. The result is logged once, without secrets.
 */
export function startConnectivityCheck(providers: ProviderSet, logger: Logger, secrets: readonly string[] = []): ConnectivityCheck {
  const { storage, voice } = providers;
  let result: Connectivity = {
    storage: storage.info.mock ? 'mock' : 'error',
    storageDetail: storage.info.mock ? null : 'Startup check still running',
    voice: voice.info.mock ? 'mock' : 'error',
    voiceDetail: voice.info.mock ? null : 'Startup check still running',
  };
  const clean = (detail: string) => secrets.filter((x) => x.length >= 4).reduce((d, x) => d.split(x).join('[redacted]'), detail).slice(0, 300);
  const bounded = async (check: () => Promise<{ ok: boolean; detail: string }>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${CONNECTIVITY_TIMEOUT_MS / 1000} s`)), CONNECTIVITY_TIMEOUT_MS);
        timer.unref();
      });
      return await Promise.race([check(), timeout]);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const done = (async (): Promise<Connectivity> => {
    const [s, v] = await Promise.all([
      storage.info.mock ? null : bounded(() => probeStorage(storage)),
      voice.info.mock ? null : voice.check ? bounded(() => voice.check!()) : { ok: false, detail: `Not checked: the ${voice.info.name} voice provider has no connectivity check` },
    ]);
    result = {
      storage: s ? (s.ok ? 'ok' : 'error') : 'mock',
      storageDetail: s ? clean(s.detail) : null,
      voice: v ? (v.ok ? 'ok' : 'error') : 'mock',
      voiceDetail: v ? clean(v.detail) : null,
    };
    if (s || v) {
      const entry = { storageProvider: storage.info.name, voiceProvider: voice.info.name, voiceModel: voice.defaults.model, ...result };
      if (result.storage === 'error' || result.voice === 'error') logger.warn(entry, 'connectivity check: a provider is not reachable as configured');
      else logger.info(entry, 'connectivity check passed');
    }
    return result;
  })();
  return { done, current: () => result };
}

export function createContainer(
  env: Env,
  logger: Logger,
  overrides: {
    db?: Database;
    providers?: ProviderSet;
    researchConfig?: Partial<ResearchConfig>;
    storyConfig?: Partial<StoryConfig>;
    scriptConfig?: Partial<ScriptConfig>;
    voiceConfig?: Partial<VoiceStageConfig>;
    storyboardConfig?: Partial<Omit<StoryboardConfig, 'catalog'>>;
  } = {},
): AppContainer {
  const db = overrides.db ?? createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_SIZE });
  // Fails fast with a clear message if a provider is configured that is not implemented.
  const providers = overrides.providers ?? createProviders(providerSelection(env), { settings: providerSettings(env) });
  const queue: JobQueue = new PostgresJobQueue(db);
  // Forecasts only: the catalog prices what a storyboard would cost to produce later; nothing in it is ever called.
  const visualCatalog = createVisualCatalog(visualPricingSettings(env));
  const projects = new ProjectService({
    db,
    logger,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    onJobQueued: (job) => queue.notify(job),
    gateHooks: { VOICE: voiceGate(), STORYBOARD: storyboardGate({ catalog: visualCatalog }) },
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
    handlers.SCRIPT = createScriptStage({ maxCostUsd: env.SCRIPT_MAX_COST_USD, models: parseScriptModels(env.SCRIPT_MODELS), narration: parseNarrationModes(env.SCRIPT_NARRATION_MODES), ...overrides.scriptConfig });
    // Narration needs a real script; with a MOCK voice provider its takes are labelled MOCK (beep and silence).
    handlers.VOICE = createVoiceStage({ maxCharacters: env.VOICE_MAX_CHARACTERS, concurrency: env.VOICE_CONCURRENCY, ...overrides.voiceConfig });
    // The storyboard is planned by the model alone, on the narration's real clock: it generates nothing, so it needs no other real provider.
    const storyboard: Partial<StoryboardConfig> = { maxCostUsd: env.STORYBOARD_MAX_COST_USD, models: parseStoryboardModels(env.STORYBOARD_MODELS), ...overrides.storyboardConfig, catalog: visualCatalog };
    handlers.VISUAL_PLAN = createStoryboardStage('VISUAL_PLAN', storyboard);
    handlers.STORYBOARD_PREVIEW = createStoryboardStage('STORYBOARD_PREVIEW', storyboard);
  }
  const realStages = Object.values(handlers).filter((h) => !h.mock).map((h) => h.type);
  for (const type of ['VISUAL_GENERATION', 'INFOGRAPHIC'] as const) if (visualGenerationHeld(realStages, type)) handlers[type] = heldStage(type);
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
  // Only the credentials these vendors receive and could echo back; redacting anything else in a public reply would only hint at it.
  const connectivity = startConnectivityCheck(providers, logger, [env.ELEVENLABS_API_KEY, env.S3_SECRET_ACCESS_KEY, env.S3_ACCESS_KEY_ID].filter((x): x is string => !!x));

  return {
    env,
    logger,
    db,
    providers,
    queue,
    projects,
    runner,
    scripts: new ScriptEditing(db),
    voice: new VoiceService({ db, projects, providers, config: { confirmCharacters: env.VOICE_CONFIRM_CHARACTERS, maxCharacters: env.VOICE_MAX_CHARACTERS } }),
    storyboards: new StoryboardService({ db, projects, catalog: visualCatalog, realStage: realStages.includes('VISUAL_PLAN'), planningCeilingUsd: overrides.storyboardConfig?.maxCostUsd ?? env.STORYBOARD_MAX_COST_USD, toJobView: toJobView as never }),
    visualCatalog,
    realStages,
    connectivity,
    async close() {
      await runner.stop();
      if (!overrides.db) await db.$disconnect();
    },
  };
}
