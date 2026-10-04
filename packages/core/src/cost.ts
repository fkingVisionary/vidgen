/**
 * Cost accounting.
 *
 * Providers report *usage* (tokens, characters, seconds, images...). Cost is
 * computed from usage and a rate card. Usage with no matching rate is returned
 * as `unpriced` rather than silently counted as $0, so missing price data is
 * visible.
 *
 * Arithmetic is done in integer micro-dollars to avoid floating-point drift
 * when summing many small API calls.
 */

export const USAGE_UNITS = [
  'INPUT_TOKENS',
  'OUTPUT_TOKENS',
  'CACHED_INPUT_TOKENS',
  'CHARACTERS',
  'AUDIO_SECONDS',
  'VIDEO_SECONDS',
  'IMAGES',
  'REQUESTS',
  'CREDITS',
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export interface UsageItem {
  unit: UsageUnit;
  quantity: number;
}

export interface Rate {
  provider: string;
  /** Omit for a provider-wide rate; a model-specific rate wins over it. */
  model?: string;
  unit: UsageUnit;
  usdPerUnit: number;
}

export interface CostEstimate {
  costUsd: number;
  unpriced: UsageItem[];
}

const MICROS = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS;
}

/** Round a USD amount to the storage precision (6 decimal places, matching Decimal(14,6)). */
export function roundUsd(usd: number): number {
  return microsToUsd(usdToMicros(usd));
}

function findRate(rates: readonly Rate[], provider: string, model: string | undefined, unit: UsageUnit) {
  return (
    rates.find((r) => r.provider === provider && r.unit === unit && model !== undefined && r.model === model) ??
    rates.find((r) => r.provider === provider && r.unit === unit && r.model === undefined)
  );
}

export function estimateCost(
  provider: string,
  model: string | undefined,
  usage: readonly UsageItem[],
  rates: readonly Rate[],
): CostEstimate {
  let micros = 0;
  const unpriced: UsageItem[] = [];
  for (const item of usage) {
    if (!Number.isFinite(item.quantity) || item.quantity < 0) {
      throw new RangeError(`Invalid usage quantity for ${item.unit}: ${item.quantity}`);
    }
    if (item.quantity === 0) continue;
    const rate = findRate(rates, provider, model, item.unit);
    if (!rate) {
      unpriced.push(item);
      continue;
    }
    micros += Math.round(item.quantity * rate.usdPerUnit * MICROS);
  }
  return { costUsd: microsToUsd(micros), unpriced };
}

/** Sum USD amounts exactly at micro-dollar precision. null/undefined are skipped. */
export function sumUsd(values: Iterable<number | null | undefined>): number {
  let micros = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    micros += usdToMicros(v);
  }
  return microsToUsd(micros);
}
