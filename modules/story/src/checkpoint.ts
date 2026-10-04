import type { Prisma } from '@docengine/database';
import type { StageContext } from '@docengine/pipeline';
import type { z } from 'zod';
import { PROMPT_VERSION } from './prompts.ts';

/**
 * Saved progress of a story job (jobs.checkpoint): the raw output of each
 * paid model call. Everything else is recomputed from them deterministically,
 * so a retry (automatic, or a manual Retry, which inherits the checkpoint)
 * resumes after the last completed call instead of paying for it again.
 *
 * A step is reused only if every step before it was reused, and only if its
 * saved output still validates. A checkpoint written by another format or
 * prompt version is ignored.
 */
export const CHECKPOINT_VERSION = 1;

const SKIPPED = { skipped: true } as const;

interface Saved {
  version: number;
  promptVersion: string;
  job: string;
  steps: Record<string, unknown>;
}

export class StepCheckpoint<S extends string> {
  private saved: Saved;
  private resuming = true;
  /** Steps reused from an earlier attempt (no provider calls). */
  readonly reused: S[] = [];

  constructor(
    private readonly ctx: StageContext,
    private readonly order: readonly S[],
  ) {
    this.saved = this.fresh();
  }

  private fresh(): Saved {
    return { version: CHECKPOINT_VERSION, promptVersion: PROMPT_VERSION, job: this.ctx.job.type, steps: {} };
  }

  /** Load the job's saved progress. Returns false if it existed but was written by another version. */
  async load(): Promise<boolean> {
    const row = await this.ctx.db.job.findUnique({ where: { id: this.ctx.job.id }, select: { checkpoint: true } });
    const raw = row?.checkpoint as Partial<Saved> | null | undefined;
    if (!raw || typeof raw !== 'object') return true;
    if (raw.version !== CHECKPOINT_VERSION || raw.promptVersion !== PROMPT_VERSION || raw.job !== this.ctx.job.type || typeof raw.steps !== 'object' || !raw.steps) {
      return false;
    }
    this.saved = raw as Saved;
    return true;
  }

  /** Reuse the saved output of `step`, or compute it and save it. */
  async step<T>(step: S, schema: z.ZodType<T>, compute: () => Promise<T>): Promise<T> {
    if (this.resuming && step in this.saved.steps) {
      const parsed = schema.safeParse(this.saved.steps[step]);
      if (parsed.success) {
        this.reused.push(step);
        return parsed.data;
      }
    }
    this.resuming = false;
    const value = await compute();
    await this.save(step, value);
    return value;
  }

  /** Record that a step was not needed this time, so later steps can still be reused. */
  async skip(step: S): Promise<void> {
    const prior = this.saved.steps[step];
    if (this.resuming && prior && typeof prior === 'object' && 'skipped' in prior) return;
    this.resuming = false;
    await this.save(step, SKIPPED);
  }

  async clear(): Promise<void> {
    await this.ctx.db.$executeRaw`UPDATE jobs SET checkpoint = NULL WHERE id = ${this.ctx.job.id}::uuid`;
  }

  /** Save a step; later steps are dropped (they were derived from the previous value). */
  private async save(step: S, value: unknown): Promise<void> {
    const index = this.order.indexOf(step);
    const steps: Record<string, unknown> = {};
    for (const earlier of this.order.slice(0, index)) if (earlier in this.saved.steps) steps[earlier] = this.saved.steps[earlier];
    steps[step] = value;
    this.saved = { ...this.fresh(), steps };
    await this.ctx.db.job.update({ where: { id: this.ctx.job.id }, data: { checkpoint: this.saved as unknown as Prisma.InputJsonValue } });
  }
}
