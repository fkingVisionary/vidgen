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
  /** How usage/cost was determined when it was not reported directly (recorded in the ledger). */
  costNote?: string;
}

/**
 * Typed, validated provider configuration (built from environment variables
 * by the app). Credentials live here and never leave the server.
 */
export interface ProviderSettings {
  anthropic?: {
    apiKey?: string;
    /** Default model for every task unless a request overrides it. */
    model: string;
    maxRetries?: number;
  };
  tavily?: {
    apiKey?: string;
    /** Free, rate-limited access without a key (development/evaluation). */
    keyless: boolean;
    /** Price used to estimate cost from reported credits. */
    usdPerCredit: number;
  };
}

export class ProviderError extends Error {
  /** Usage already billed before the failure (e.g. a truncated or invalid LLM response), so it is still costed. */
  readonly meta?: CallMeta;

  constructor(
    readonly provider: string,
    message: string,
    /** Whether retrying the same request may succeed (rate limit, timeout, 5xx). */
    readonly retryable: boolean,
    options?: { cause?: unknown; meta?: CallMeta },
  ) {
    super(`[${provider}] ${message}`, options);
    this.name = 'ProviderError';
    if (options?.meta) this.meta = options.meta;
  }
}

/** Async generation lifecycle shared by video, image and render providers. */
export type GenerationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
