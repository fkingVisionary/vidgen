import { estimateCost, roundUsd } from '@docengine/core';
import type { Database, Job, LanguageVersion, Prisma, Project } from '@docengine/database';
import { SLOT_KINDS, type CallMeta, type ProviderSet, type ProviderSlot } from '@docengine/providers';
import type { Logger } from './logger.ts';

export interface CallProviderOptions<T> {
  /** Summary of the request for the ledger (prompt, parameters). Never include credentials. */
  request?: unknown;
  /** Summary of the response for the ledger; defaults to none (responses can be large). */
  summarize?: (result: T) => unknown;
  shotId?: string;
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
        const cost = estimateCost(meta.provider, meta.model, meta.usage, info.rates);
        if (cost.unpriced.length > 0) {
          logger.warn({ provider: meta.provider, model: meta.model, unpriced: cost.unpriced }, 'provider usage has no price; cost under-reported');
        }
        await db.providerCall.update({
          where: { id: call.id },
          data: {
            status: 'SUCCEEDED',
            model: meta.model ?? null,
            isMock: meta.mock,
            providerJobId: 'providerJobId' in result && typeof result.providerJobId === 'string' ? result.providerJobId : null,
            usage: toJson(meta.usage) ?? [],
            response: toJson(opts.summarize?.(result)),
            estimatedCostUsd: roundUsd(cost.costUsd),
            actualCostUsd: meta.actualCostUsd === undefined ? null : roundUsd(meta.actualCostUsd),
            completedAt: new Date(),
            durationMs,
          },
        });
        logger.info({ provider: meta.provider, operation, durationMs, mock: meta.mock, costUsd: cost.costUsd }, 'provider call succeeded');
        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        await db.providerCall.update({
          where: { id: call.id },
          data: { status: 'FAILED', error: errorMessage(err), completedAt: new Date(), durationMs },
        });
        logger.warn({ provider: info.name, operation, durationMs, err: errorMessage(err) }, 'provider call failed');
        throw err;
      }
    },
  };
}
