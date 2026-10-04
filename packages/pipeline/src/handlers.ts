import type { JobType } from '@docengine/core';
import type { StageContext } from './context.ts';

/**
 * A pipeline stage. Pure with respect to infrastructure: it receives
 * everything through the context, so the same handler runs in the embedded
 * V1 worker, a standalone worker process, or a future queue consumer.
 *
 * Throw `NonRetryableError` (or a non-retryable ProviderError) for failures
 * that retrying cannot fix; any other error is retried with backoff.
 */
export interface StageHandler {
  type: JobType;
  /** True for placeholder handlers that do no real work. Their jobs are flagged MOCK. */
  mock: boolean;
  /** Returns a JSON-serialisable summary stored on the job. */
  run(ctx: StageContext): Promise<Record<string, unknown>>;
}

export type StageHandlers = Record<JobType, StageHandler>;
