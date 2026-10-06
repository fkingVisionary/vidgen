import { estimateCost, roundUsd } from '@docengine/core';
import type { Prisma } from '@docengine/database';
import type { VoiceProvider } from '@docengine/providers';
import { z } from 'zod';

/**
 * What a take's request cost, from its ledger row. The estimate's basis is
 * the characters sent (an upper bound); figures the provider reported about
 * the call (ElevenLabs' character-cost header) are kept raw under their own
 * name, never priced, because their unit is the vendor's. Rows written
 * before 2026-10-06 priced the reported figure; they are re-estimated here
 * from the characters sent, and say so. The ledger is never rewritten.
 */

/** A take's ledger row, as much of it as a cost needs. */
export interface LedgerRow {
  id: string;
  status: string;
  provider: string;
  model: string | null;
  costBasis: string | null;
  estimatedCostUsd: Prisma.Decimal | number | null;
  actualCostUsd: Prisma.Decimal | number | null;
  usage: Prisma.JsonValue;
  response: Prisma.JsonValue;
}

/** Select for LedgerRow. */
export const LEDGER = { select: { id: true, status: true, provider: true, model: true, costBasis: true, estimatedCostUsd: true, actualCostUsd: true, usage: true, response: true } } as const;

export interface ReportedFigure {
  name: string;
  quantity: number;
}

export interface TakeCost {
  ledgerId: string;
  status: string;
  basis: string | null;
  estimatedUsd: number | null;
  reportedUsd: number | null;
  /** Characters sent: the estimate's basis. */
  characters: number | null;
  /** The provider's own figures, raw (never priced). */
  reported: ReportedFigure[];
  /** Re-estimated here from the characters sent (the row priced the provider's figure). */
  reestimated: boolean;
  usageSource: string | null;
  attempts: number | null;
}

/** The figure rows before 2026-10-06 put in `usage` when REPORTED. */
const EARLIER_REPORTED = 'character-cost';

const Usage = z.array(z.object({ unit: z.string(), quantity: z.number() })).catch([]);
const Facts = z
  .object({
    usageSource: z.string().optional(),
    attempts: z.number().optional(),
    reported: z.array(z.object({ name: z.string(), quantity: z.number() })).optional(),
  })
  .catch({});

const num = (v: Prisma.Decimal | number | null) => (v === null ? null : Number(v));

/**
 * A take's request as the ledger has it: estimated from the characters
 * sent, the provider's own figures kept raw. A row written before
 * 2026-10-06 (usage = the character-cost figure, REPORTED) is re-estimated
 * from the characters sent when they are known and priced, and says so;
 * otherwise its estimate is unknown (null), never the figure it priced.
 */
export function takeCost(call: LedgerRow | null, sentCharacters: number | null, provider: Pick<VoiceProvider, 'info'>): TakeCost | null {
  if (!call) return null;
  const facts = Facts.parse(call.response ?? {});
  const usage = Usage.parse(call.usage).find((u) => u.unit === 'CHARACTERS')?.quantity ?? null;
  const base: TakeCost = {
    ledgerId: call.id,
    status: call.status,
    basis: call.costBasis,
    estimatedUsd: num(call.estimatedCostUsd),
    reportedUsd: num(call.actualCostUsd),
    characters: sentCharacters ?? usage,
    reported: facts.reported ?? [],
    reestimated: false,
    usageSource: facts.usageSource ?? null,
    attempts: facts.attempts ?? null,
  };
  if (facts.usageSource !== 'REPORTED') return base;
  // Before 2026-10-06: the usage was the provider's figure, and it was priced. That price is never shown: without the characters sent or a rate for them, the estimate is unknown.
  const reported = facts.reported ?? (usage === null ? [] : [{ name: EARLIER_REPORTED, quantity: usage }]);
  const unknown = { ...base, characters: sentCharacters, reported, estimatedUsd: null };
  if (sentCharacters === null || call.costBasis !== 'ESTIMATED') return unknown;
  const estimate = estimateCost(call.provider, call.model ?? undefined, [{ unit: 'CHARACTERS', quantity: sentCharacters }], provider.info.rates);
  if (estimate.unpriced.length) return unknown;
  return { ...base, reported, estimatedUsd: roundUsd(estimate.costUsd), reestimated: true };
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "sent 1,577 characters; provider reported 174 (character-cost header)", or "…; provider reported none". */
export function costText(characters: number, reported: readonly ReportedFigure[]): string {
  const figures = reported.map((r) => `${thousands(r.quantity)} (${r.name} header)`).join(', ');
  return `sent ${thousands(characters)} character${characters === 1 ? '' : 's'}; provider reported ${figures || 'none'}`;
}

/** Reported figures summed per name, with how many requests reported each. */
export function sumReported(costs: readonly { reported: readonly ReportedFigure[] }[]): { name: string; total: number; requests: number }[] {
  const out = new Map<string, { name: string; total: number; requests: number }>();
  for (const c of costs) {
    for (const r of c.reported) {
      const s = out.get(r.name) ?? { name: r.name, total: 0, requests: 0 };
      s.total += r.quantity;
      s.requests += 1;
      out.set(r.name, s);
    }
  }
  return [...out.values()];
}
