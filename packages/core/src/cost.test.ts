import { describe, expect, it } from 'vitest';
import { estimateCost, roundUsd, sumUsd, type Rate } from './cost.ts';

const RATES: Rate[] = [
  { provider: 'llm', model: 'big', unit: 'INPUT_TOKENS', usdPerUnit: 4 / 1_000_000 },
  { provider: 'llm', model: 'big', unit: 'OUTPUT_TOKENS', usdPerUnit: 20 / 1_000_000 },
  { provider: 'llm', unit: 'INPUT_TOKENS', usdPerUnit: 1 / 1_000_000 }, // provider-wide fallback
  { provider: 'tts', unit: 'CHARACTERS', usdPerUnit: 0.0003 },
];

describe('estimateCost', () => {
  it('prices usage with model-specific rates', () => {
    const r = estimateCost('llm', 'big', [
      { unit: 'INPUT_TOKENS', quantity: 100_000 },
      { unit: 'OUTPUT_TOKENS', quantity: 10_000 },
    ], RATES);
    expect(r).toEqual({ costUsd: 0.6, unpriced: [] });
  });

  it('falls back to a provider-wide rate when the model has none', () => {
    expect(estimateCost('llm', 'small', [{ unit: 'INPUT_TOKENS', quantity: 1_000_000 }], RATES).costUsd).toBe(1);
  });

  it('reports unpriced usage instead of silently treating it as free', () => {
    const r = estimateCost('video', undefined, [{ unit: 'VIDEO_SECONDS', quantity: 5 }], RATES);
    expect(r).toEqual({ costUsd: 0, unpriced: [{ unit: 'VIDEO_SECONDS', quantity: 5 }] });
  });

  it('rejects negative or non-finite quantities', () => {
    expect(() => estimateCost('tts', undefined, [{ unit: 'CHARACTERS', quantity: -1 }], RATES)).toThrow(RangeError);
    expect(() => estimateCost('tts', undefined, [{ unit: 'CHARACTERS', quantity: Number.NaN }], RATES)).toThrow(RangeError);
  });

  it('is zero for mock usage with no rates', () => {
    expect(estimateCost('mock', undefined, [], [])).toEqual({ costUsd: 0, unpriced: [] });
  });
});

describe('sumUsd', () => {
  it('sums many small amounts without floating-point drift', () => {
    const tenths = Array.from({ length: 10 }, () => 0.1);
    expect(tenths.reduce((a, b) => a + b, 0)).not.toBe(1); // the problem
    expect(sumUsd(tenths)).toBe(1); // the fix
  });

  it('skips null and undefined', () => {
    expect(sumUsd([0.000001, null, undefined, 0.000002])).toBe(0.000003);
  });

  it('rounds to micro-dollar storage precision', () => {
    expect(roundUsd(0.1234567)).toBe(0.123457);
  });
});
