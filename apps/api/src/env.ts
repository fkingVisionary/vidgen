import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProviderSettings } from '@docengine/providers';
import { z } from 'zod';

/** Treat empty strings (e.g. `KEY=` in .env) as unset. */
const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);

const ProviderName = opt(z.string().trim().toLowerCase().default('mock'));

export const EnvSchema = z
  .object({
    NODE_ENV: opt(z.enum(['development', 'test', 'production']).default('development')),
    PORT: opt(z.coerce.number().int().min(1).max(65_535).default(3000)),
    HOST: opt(z.string().default('0.0.0.0')),
    LOG_LEVEL: opt(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info')),

    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required (PostgreSQL connection string)' })
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must start with postgres:// or postgresql://'),
    DATABASE_POOL_SIZE: opt(z.coerce.number().int().min(1).max(100).default(10)),

    DASHBOARD_USER: opt(z.string().min(1).default('admin')),
    DASHBOARD_PASSWORD: opt(z.string().optional()),

    WORKER_ENABLED: opt(z.stringbool().default(true)),
    WORKER_POLL_INTERVAL_MS: opt(z.coerce.number().int().min(50).default(1_000)),
    WORKER_CONCURRENCY: opt(z.coerce.number().int().min(1).max(16).default(1)),
    JOB_MAX_ATTEMPTS: opt(z.coerce.number().int().min(1).max(10).default(3)),
    JOB_LOCK_TIMEOUT_MS: opt(z.coerce.number().int().min(10_000).default(900_000)),

    AI_PROVIDER: ProviderName,
    RESEARCH_PROVIDER: ProviderName,
    VOICE_PROVIDER: ProviderName,
    VIDEO_PROVIDER: ProviderName,
    STORAGE_PROVIDER: ProviderName,
    RENDER_PROVIDER: ProviderName,
    PUBLISHING_PROVIDER: ProviderName,

    // Anthropic (AI_PROVIDER=anthropic)
    ANTHROPIC_API_KEY: opt(z.string().optional()),
    AI_MODEL: opt(z.string().default('claude-opus-5-5')),
    // Tavily (RESEARCH_PROVIDER=tavily)
    TAVILY_API_KEY: opt(z.string().optional()),
    TAVILY_ACCESS_MODE: opt(z.enum(['api-key', 'keyless']).default('api-key')),
    /** $/credit for cost estimates: pay-as-you-go 0.008; monthly plans 0.005–0.0075. */
    TAVILY_USD_PER_CREDIT: opt(z.coerce.number().min(0).max(1).default(0.008)),

    // ElevenLabs (VOICE_PROVIDER=elevenlabs)
    ELEVENLABS_API_KEY: opt(z.string().optional()),
    /** Default voice for new voice profiles (chosen per profile; never hard-coded). */
    ELEVENLABS_VOICE_ID: opt(z.string().trim().optional()),
    /** Production default: Eleven v4. No automatic fallback to another model. */
    ELEVENLABS_MODEL_ID: opt(z.string().trim().default('eleven_v4')),
    ELEVENLABS_OUTPUT_FORMAT: opt(z.string().trim().regex(/^(mp3_\d+_\d+|pcm_\d+|wav_\d+)$/, 'use an mp3_*, wav_* or pcm_* output format').default('mp3_44100_128')),
    /** Optional: your plan's price per 1,000 characters (defaults to ElevenLabs' documented API list price per model). */
    ELEVENLABS_USD_PER_1K_CHARS: opt(z.coerce.number().min(0).max(10).optional()),
    // S3-compatible storage (STORAGE_PROVIDER=s3): a Railway bucket, Cloudflare R2, AWS S3…
    S3_ENDPOINT: opt(z.url().optional()),
    S3_REGION: opt(z.string().default('auto')),
    S3_BUCKET: opt(z.string().optional()),
    S3_ACCESS_KEY_ID: opt(z.string().optional()),
    S3_SECRET_ACCESS_KEY: opt(z.string().optional()),
    S3_FORCE_PATH_STYLE: opt(z.stringbool().default(false)),
    S3_SIGNED_URL_TTL_SEC: opt(z.coerce.number().int().min(60).max(604_800).default(3600)),

    // Voice stage
    /** Above this many characters a voice run or regeneration needs an explicit confirmation. */
    VOICE_CONFIRM_CHARACTERS: opt(z.coerce.number().int().min(100).max(200_000).default(3_000)),
    /** Hard ceiling on the characters one voice job may send (a full documentary is ~15,000–25,000). */
    VOICE_MAX_CHARACTERS: opt(z.coerce.number().int().min(500).max(500_000).default(40_000)),
    /** Takes generated at the same time within one job. */
    VOICE_CONCURRENCY: opt(z.coerce.number().int().min(1).max(5).default(2)),

    // Research stage
    /** Hard ceiling on one research run's estimated provider spend (USD). */
    RESEARCH_MAX_COST_USD: opt(z.coerce.number().min(0.5).max(500).default(40)),
    /** Upper bound of sources retrieved and read per run. */
    RESEARCH_MAX_SOURCES: opt(z.coerce.number().int().min(5).max(120).default(45)),

    // Story stage
    /** Hard ceiling on one story-mining or story-architecture job's estimated provider spend (USD). */
    STORY_MAX_COST_USD: opt(z.coerce.number().min(0.5).max(200).default(15)),

    // Script stage
    /** Hard ceiling on one script job's estimated provider spend (USD): a draft, a revision or a section rewrite. */
    SCRIPT_MAX_COST_USD: opt(z.coerce.number().min(0.5).max(200).default(15)),
    /** Optional per-step model overrides, e.g. "perform=<model id>" (steps: plan, write, edit, factCheck, perform). Unset steps use AI_MODEL. */
    SCRIPT_MODELS: opt(z.string().max(500).optional()),

    /** Directory of the built dashboard. Defaults to apps/web/dist. */
    WEB_DIST_DIR: opt(z.string().optional()),
    /** Set by Railway on deploys; shown on /api/health. */
    RAILWAY_GIT_COMMIT_SHA: opt(z.string().optional()),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 12)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DASHBOARD_PASSWORD'],
        message: 'DASHBOARD_PASSWORD (at least 12 characters) is required in production: the dashboard can start paid generation jobs',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) throw new EnvError(result.error.issues);
  return result.data;
}

/**
 * Loads the repository-root .env in local development (existing variables
 * always win), then validates. Railway injects variables directly.
 */
export function loadEnv(): Env {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }
  return parseEnv(process.env);
}

/** Typed provider configuration (credentials stay server-side). */
export function providerSettings(env: Env): ProviderSettings {
  return {
    anthropic: { model: env.AI_MODEL, ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}) },
    tavily: {
      keyless: env.TAVILY_ACCESS_MODE === 'keyless',
      usdPerCredit: env.TAVILY_USD_PER_CREDIT,
      ...(env.TAVILY_API_KEY && env.TAVILY_ACCESS_MODE !== 'keyless' ? { apiKey: env.TAVILY_API_KEY } : {}),
    },
    elevenlabs: {
      model: env.ELEVENLABS_MODEL_ID,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
      ...(env.ELEVENLABS_API_KEY ? { apiKey: env.ELEVENLABS_API_KEY } : {}),
      ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
      ...(env.ELEVENLABS_USD_PER_1K_CHARS !== undefined ? { usdPer1kChars: env.ELEVENLABS_USD_PER_1K_CHARS } : {}),
    },
    s3: {
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      signedUrlTtlSec: env.S3_SIGNED_URL_TTL_SEC,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      ...(env.S3_BUCKET ? { bucket: env.S3_BUCKET } : {}),
      ...(env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID } : {}),
      ...(env.S3_SECRET_ACCESS_KEY ? { secretAccessKey: env.S3_SECRET_ACCESS_KEY } : {}),
    },
  };
}

export function providerSelection(env: Env) {
  return {
    ai: env.AI_PROVIDER,
    research: env.RESEARCH_PROVIDER,
    voice: env.VOICE_PROVIDER,
    video: env.VIDEO_PROVIDER,
    storage: env.STORAGE_PROVIDER,
    render: env.RENDER_PROVIDER,
    publishing: env.PUBLISHING_PROVIDER,
  };
}
