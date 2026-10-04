import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv, providerSelection } from './env.ts';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('parseEnv', () => {
  it('applies defaults, including all-mock providers', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, WORKER_ENABLED: true, JOB_MAX_ATTEMPTS: 3 });
    expect(Object.values(providerSelection(env))).toEqual(Array(7).fill('mock'));
  });

  it('treats empty values from .env as unset', () => {
    const env = parseEnv({ ...base, PORT: '', DASHBOARD_PASSWORD: '', VOICE_PROVIDER: '' });
    expect(env.PORT).toBe(3000);
    expect(env.DASHBOARD_PASSWORD).toBeUndefined();
    expect(env.VOICE_PROVIDER).toBe('mock');
  });

  it('coerces numbers and booleans', () => {
    const env = parseEnv({ ...base, PORT: '8080', WORKER_ENABLED: 'false', WORKER_CONCURRENCY: '2' });
    expect(env).toMatchObject({ PORT: 8080, WORKER_ENABLED: false, WORKER_CONCURRENCY: 2 });
  });

  it('requires a database URL', () => {
    expect(() => parseEnv({})).toThrow(EnvError);
    expect(() => parseEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/must start with postgres/);
  });

  it('refuses to run in production without a strong dashboard password', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/DASHBOARD_PASSWORD/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', DASHBOARD_PASSWORD: 'short' })).toThrow(/DASHBOARD_PASSWORD/);
    expect(parseEnv({ ...base, NODE_ENV: 'production', DASHBOARD_PASSWORD: 'a-long-enough-secret' }).NODE_ENV).toBe('production');
  });
});
