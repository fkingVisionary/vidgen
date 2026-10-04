import { USAGE_UNITS, type ProviderKind, type Rate, type UsageItem } from '@docengine/core';
import type { CallMeta, ProviderInfo } from '../types.ts';

/** Every mock output carries this label so it can never be mistaken for real work. */
export const MOCK_LABEL = 'MOCK';

/** Mocks report realistic usage at a price of $0, so the cost pipeline is exercised end to end. */
const ZERO_RATES: Rate[] = USAGE_UNITS.map((unit) => ({ provider: 'mock', unit, usdPerUnit: 0 }));

export function mockInfo(kind: ProviderKind): ProviderInfo {
  return { kind, name: 'mock', mock: true, rates: ZERO_RATES };
}

export function mockMeta(usage: UsageItem[], model = 'mock-model'): CallMeta {
  return { provider: 'mock', model, mock: true, usage, actualCostUsd: 0 };
}

/** Deterministic id with a recognisable prefix. */
let counter = 0;
export function mockId(prefix: string): string {
  counter += 1;
  return `mock-${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Prompts containing this marker make mock generations fail — used to test retries. */
export const MOCK_FAIL_MARKER = 'MOCK_FAIL';
