import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv, providerSelection, visualPricingSettings } from './env.ts';

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

describe('storyboard and visual pricing settings', () => {
  const stock = JSON.stringify([{ provider: 'stock', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]);

  it('defaults to a $5 planning ceiling, the provider default model and the catalog\'s own prices', () => {
    const env = parseEnv(base);
    expect(env.STORYBOARD_MAX_COST_USD).toBe(5);
    expect([env.STORYBOARD_MODELS, env.VISUAL_PRICE_OVERRIDES, env.ARCHIVAL_USD_PER_ITEM]).toEqual([undefined, undefined, undefined]);
    expect(visualPricingSettings(env)).toEqual({ overrides: [] });
    expect(parseEnv({ ...base, STORYBOARD_MAX_COST_USD: '2.5', STORYBOARD_MODELS: 'shots=some-model' })).toMatchObject({ STORYBOARD_MAX_COST_USD: 2.5, STORYBOARD_MODELS: 'shots=some-model' });
    expect(() => parseEnv({ ...base, STORYBOARD_MAX_COST_USD: '0.1' })).toThrow(/STORYBOARD_MAX_COST_USD/);
  });

  it('refuses a step the storyboard does not have', () => {
    expect(() => parseEnv({ ...base, STORYBOARD_MODELS: 'pictures=some-model' })).toThrow(/  - STORYBOARD_MODELS: "pictures=some-model" is not step=model \(steps: beats, shots, repair\)/);
  });

  it('turns the user\'s prices into overrides named after their setting', () => {
    const env = parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: stock, ARCHIVAL_USD_PER_ITEM: '25@2026-10-07' });
    expect(visualPricingSettings(env).overrides).toEqual([
      { provider: 'stock', checkedAt: '2026-10-07', confidence: 'PLAN_PRICE', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }], source: 'VISUAL_PRICE_OVERRIDES' },
      expect.objectContaining({ provider: 'archival', checkedAt: '2026-10-07', confidence: 'ASSUMPTION', source: 'ARCHIVAL_USD_PER_ITEM' }),
    ]);
  });

  it('refuses prices the catalog cannot take at startup, naming the setting, rather than ignoring them', () => {
    expect(() => parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: '{not json' })).toThrow(/VISUAL_PRICE_OVERRIDES: VISUAL_PRICE_OVERRIDES is not valid JSON/);
    expect(() => parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: JSON.stringify([{ provider: 'acme-video', checkedAt: '2026-10-07', rates: [{ unit: 'VIDEO_SECONDS', usdPerUnit: 0.1 }] }]) })).toThrow(
      /VISUAL_PRICE_OVERRIDES: VISUAL_PRICE_OVERRIDES sets prices for "acme-video", which is not in the visual catalog/,
    );
    expect(() => parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: JSON.stringify([{ provider: 'stock', checkedAt: '7 Oct', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]) })).toThrow(/VISUAL_PRICE_OVERRIDES/);
    expect(() => parseEnv({ ...base, ARCHIVAL_USD_PER_ITEM: '25' })).toThrow(/ARCHIVAL_USD_PER_ITEM: ARCHIVAL_USD_PER_ITEM must read "<usd>@<YYYY-MM-DD>"/);
    // Both settings valid on their own, but both pricing archival items.
    const archival = JSON.stringify([{ provider: 'archival', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 30 }] }]);
    expect(() => parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: archival, ARCHIVAL_USD_PER_ITEM: '25@2026-10-07' })).toThrow(/VISUAL_PRICE_OVERRIDES and ARCHIVAL_USD_PER_ITEM both set the prices of "archival"/);
    // Every bad setting is reported, not only the first.
    expect(() => parseEnv({ ...base, VISUAL_PRICE_OVERRIDES: '{not json', ARCHIVAL_USD_PER_ITEM: '25' })).toThrow(/VISUAL_PRICE_OVERRIDES: .*\n.*ARCHIVAL_USD_PER_ITEM: /);
  });
});
