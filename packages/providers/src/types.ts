import type { ProviderKind, Rate, UsageItem } from '@docengine/core';

/** Static description of a provider implementation. */
export interface ProviderInfo {
  kind: ProviderKind;
  /** Implementation name, e.g. "mock", "elevenlabs", "higgsfield". */
  name: string;
  /** True for MOCK implementations. Everything they return is labelled MOCK. */
  mock: boolean;
  /** Price list used to estimate the cost of reported usage. */
  rates: readonly Rate[];
}

/**
 * Metadata returned with every billable provider call. The pipeline records it
 * in the provider_calls ledger (duration, usage, cost, mock flag).
 */
export interface CallMeta {
  provider: string;
  model?: string;
  mock: boolean;
  usage: UsageItem[];
  /** Cost reported by the vendor itself, when it reports one. */
  actualCostUsd?: number;
  /** Vendor request id, for support tickets and debugging. */
  providerRequestId?: string;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** Whether retrying the same request may succeed (rate limit, timeout, 5xx). */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(`[${provider}] ${message}`, options);
    this.name = 'ProviderError';
  }
}

/** Async generation lifecycle shared by video, image and render providers. */
export type GenerationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
