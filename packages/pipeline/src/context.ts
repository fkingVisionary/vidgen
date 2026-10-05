import { estimateCost, roundUsd, type CostBasis, type Rate } from '@docengine/core';
import type { Database, Job, LanguageVersion, Prisma, Project } from '@docengine/database';
import { ProviderError, SLOT_KINDS, type CallMeta, type ProviderSet, type ProviderSlot } from '@docengine/providers';
import { EVENT } from './events.ts';
import type { Logger } from './logger.ts';

export interface CallProviderOptions<T> {
  /** Summary of the request for the ledger (prompt, parameters). Never include credentials. */
  request?: unknown;
  /** Summary of the response for the ledger; defaults to none (responses can be large). */
  summarize?: (result: T) => unknown;
  shotId?: string;
  /** Receives the ledger row's id once the call is recorded (succeeded or failed), to link it to what it produced. */
  onRecorded?: (callId: string) => void;
}

/** Everything a stage handler may use. Handlers never construct providers or DB clients themselves. */
export interface StageContext {
  readonly job: Job;
  readonly project: Project;
  readonly languageVersion: LanguageVersion;
  readonly db: Database;
  readonly providers: ProviderSet;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /**
   * Invoke a billable provider operation and record it in the provider_calls
   * ledger (duration, usage, estimated cost, mock flag, errors).
   */
  callProvider<T extends { meta: CallMeta }>(
    slot: ProviderSlot,
    operation: string,
    fn: () => Promise<T>,
    opts?: CallProviderOptions<T>,
  ): Promise<T>;
  /** True if any provider call made through this context was served by a MOCK. */
  usedMockProvider(): boolean;
  /** Record a progress note on the project's activity log (visible live in the dashboard). */
  progress(message: string, data?: Record<string, unknown>): Promise<void>;
}

/**
 * Prices a call and says where the number comes from. Costs are never
 * invented: a vendor-reported amount wins; otherwise usage × rate card is an
 * ESTIMATE; usage with no rate (or no usage at all) is UNPRICED.
 */
export function priceCall(meta: CallMeta, rates: readonly Rate[]): {
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  costBasis: CostBasis;
  costNote: string | null;
  unpriced: CallMeta['usage'];
} {
  const estimate = estimateCost(meta.provider, meta.model, meta.usage, rates);
  const estimatedCostUsd = meta.usage.length > 0 ? roundUsd(estimate.costUsd) : null;
  const actualCostUsd = meta.actualCostUsd === undefined ? null : roundUsd(meta.actualCostUsd);
  let costBasis: CostBasis;
  let note = meta.costNote ?? null;
  if (meta.mock) costBasis = 'MOCK';
  else if (actualCostUsd !== null) costBasis = 'VENDOR_REPORTED';
  else if (meta.usage.length === 0 || estimate.unpriced.length > 0) {
    costBasis = 'UNPRICED';
    const missing = estimate.unpriced.map((u) => `${u.quantity} ${u.unit}`).join(', ') || 'no usage reported';
    note = `${note ? `${note}. ` : ''}No price configured for: ${missing}`;
  } else costBasis = 'ESTIMATED';
  return { estimatedCostUsd, actualCostUsd, costBasis, costNote: note, unpriced: estimate.unpriced };
}

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createStageContext(args: {
  job: Job;
  project: Project;
  languageVersion: LanguageVersion;
  db: Database;
  providers: ProviderSet;
  logger: Logger;
  signal: AbortSignal;
}): StageContext {
  let usedMock = false;
  const { db, job, providers, logger } = args;

  return {
    ...args,
    usedMockProvider: () => usedMock,

    async progress(message, data = {}) {
      await db.projectEvent.create({
        data: { projectId: job.projectId, jobId: job.id, type: EVENT.JOB_PROGRESS, message, data: toJson(data) ?? {} },
      });
      logger.info(data, message);
    },

    async callProvider(slot, operation, fn, opts = {}) {
      const info = providers[slot].info;
      if (info.mock) usedMock = true;
      const call = await db.providerCall.create({
        data: {
          projectId: job.projectId,
          jobId: job.id,
          languageVersionId: job.languageVersionId,
          shotId: opts.shotId ?? null,
          kind: SLOT_KINDS[slot],
          provider: info.name,
          operation,
          isMock: info.mock,
          status: 'RUNNING',
          request: toJson(opts.request),
        },
      });
      const started = performance.now();
      try {
        const result = await fn();
        const durationMs = Math.round(performance.now() - started);
        const { meta } = result;
        const price = priceCall(meta, info.rates);
        if (price.costBasis === 'UNPRICED') {
          logger.warn({ provider: meta.provider, model: meta.model, unpriced: price.unpriced }, 'provider usage has no price; cost under-reported');
        }
        await db.providerCall.update({
          where: { id: call.id },
          data: {
            status: 'SUCCEEDED',
            model: meta.model ?? null,
            isMock: meta.mock,
            providerJobId: 'providerJobId' in result && typeof result.providerJobId === 'string' ? result.providerJobId : null,
            providerRequestId: meta.providerRequestId ?? null,
            usage: toJson(meta.usage) ?? [],
            response: toJson(opts.summarize?.(result)),
            estimatedCostUsd: price.estimatedCostUsd,
            actualCostUsd: price.actualCostUsd,
            costBasis: price.costBasis,
            costNote: price.costNote,
            completedAt: new Date(),
            durationMs,
          },
        });
        logger.info({ provider: meta.provider, operation, model: meta.model, durationMs, mock: meta.mock, costUsd: price.estimatedCostUsd, costBasis: price.costBasis }, 'provider call succeeded');
        opts.onRecorded?.(call.id);
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        // A failed call may still have been billed (e.g. truncated or invalid LLM output): record its usage.
        const billed = err instanceof ProviderError && err.meta ? priceCall(err.meta, info.rates) : null;
        await db.providerCall.update({
          where: { id: call.id },
          data: {
            status: 'FAILED',
            error: errorMessage(err),
            completedAt: new Date(),
            durationMs,
            ...(billed && err instanceof ProviderError && err.meta
              ? {
                  model: err.meta.model ?? null,
                  usage: toJson(err.meta.usage) ?? [],
                  providerRequestId: err.meta.providerRequestId ?? null,
                  estimatedCostUsd: billed.estimatedCostUsd,
                  actualCostUsd: billed.actualCostUsd,
                  costBasis: billed.costBasis,
                  costNote: billed.costNote,
                }
              : {}),
          },
        });
        logger.warn({ provider: info.name, operation, durationMs, err: errorMessage(err) }, 'provider call failed');
        opts.onRecorded?.(call.id);
        throw err;
      }
    },
  };
}
