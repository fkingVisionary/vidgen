import { NonRetryableError, type StageContext } from '@docengine/pipeline';
import type { EvidenceBase } from './evidence.ts';
import type { DraftCandidate } from './mining.ts';

/** The job's recorded spend passed its ceiling. Not retried: raising the ceiling is a human decision. */
export class CostCeilingError extends NonRetryableError {}

/** Cancellation and the per-job cost ceiling, checked between steps. */
export class CostCeiling {
  constructor(
    private readonly ctx: StageContext,
    private readonly maxUsd: number,
    private readonly what: string,
  ) {}

  async check(): Promise<void> {
    this.ctx.signal.throwIfAborted();
    const [row] = await this.ctx.db.$queryRaw<{ spent: string | null }[]>`
      SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd))::text AS spent FROM provider_calls WHERE job_id = ${this.ctx.job.id}::uuid`;
    const spent = Number(row?.spent ?? 0);
    if (spent > this.maxUsd) throw new CostCeilingError(`${this.what} stopped: estimated spend $${spent.toFixed(2)} exceeds the per-job ceiling of $${this.maxUsd}`);
  }
}

export function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/** A candidate followed by the evidence of the claims it cites, for the critic. */
export function renderCandidateForCritic(d: DraftCandidate, evidence: EvidenceBase): string {
  const lines = [
    `### ${d.ref} — ${d.title} [${d.storyType}]`,
    `hook: ${d.hook}`,
    `characters: ${d.characters.map((c) => `${c.name} (${c.kind}): ${c.role}`).join('; ')}`,
    `protagonist: ${d.humanStakes.protagonist || '(none recorded)'} | wants: ${d.desire} | could gain: ${d.humanStakes.couldGain} | could lose: ${d.humanStakes.couldLose}`,
    `immediate problem: ${d.humanStakes.immediateProblem}`,
    `setting: ${d.setting} | period: ${d.timePeriod} | on screen: ${d.storyDesign.visualEnvironment}`,
    `conflict: ${d.conflict}`,
    `stakes: ${d.stakes}`,
    `escalation: ${d.escalation}`,
    `turning point: ${d.turningPoint}`,
    `reveal: ${d.storyDesign.reveal}`,
    `consequence: ${d.payoff}`,
    `cold open [${d.storyDesign.coldOpen.basis}]: ${d.storyDesign.coldOpen.text}`,
    `why interesting: ${d.whyInteresting}`,
    `viewer question: ${d.viewerQuestion}`,
    `central question: ${d.centralQuestion}`,
    `told as: ${d.narrativeMode}; POV ${d.povStrategy.type}${d.povStrategy.description ? ` (${d.povStrategy.description})` : ''}; reconstruction ${d.reconstructionLevel}`,
  ];
  if (d.mythThread) {
    const m = d.mythThread;
    lines.push(`myth thread: popular story: ${m.popularStory} | origin: ${m.origin} | spread by: ${m.whoSpreadIt} | what happened: ${m.whatHappened} | why it survived: ${m.whyItSurvived}`);
  }
  if (d.notes.length) lines.push(`notes: ${d.notes.join(' ')}`);
  lines.push(`Evidence (${d.claimKeys.join(', ')}):`, evidence.renderClaims(d.claimKeys, { quotes: 3, quoteChars: 400 }));
  return lines.join('\n');
}
