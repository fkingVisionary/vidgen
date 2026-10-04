import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
