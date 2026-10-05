import { NO_PAUSE, blockDurationSec, fmtClock, scriptTiming, type PauseLength, type PauseReason, type RuntimeTarget, type ScriptDelivery, type ScriptPause, type ScriptReviewChange } from '@docengine/core';
import type { DraftBlock, ScriptDraft } from './draft.ts';

/**
 * The performance pass and the runtime maximum. Pauses and slower delivery
 * cost time; the pass is told how much it may spend (the maximum minus the
 * narration with no performance timing), and whatever it marks is then held
 * to that: when the full runtime would pass the maximum, the engine gives up
 * the least valuable timing first — rhythm, question and number pauses, then
 * slower delivery, then transitions, emotional turns, impact and, last,
 * reveals — reducing a pause a step at a time before removing it. It never
 * speeds delivery up to make room. Only the user can let a performance run
 * past the maximum.
 */

export interface PerformanceBudget {
  minSec: number;
  maxSec: number;
  targetSec: number;
  /** The runtime with no performance timing in the sections the pass marks (normal pace, no pauses); other sections as they are. */
  narrationSec: number;
  /** Seconds the performance may add before the maximum (0 when the narration alone reaches it). */
  remainingSec: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const plain = (d: ScriptDelivery): ScriptDelivery => ({ ...d, pace: 'NORMAL', pauseBefore: NO_PAUSE, pauseAfter: NO_PAUSE });

export function performanceBudget(draft: ScriptDraft, target: RuntimeTarget, allowed: ReadonlySet<number>): PerformanceBudget {
  const blocks = draft.sections.flatMap((s) => s.blocks.map((b) => (allowed.has(s.sequence) ? { ...b, estimatedDurationSec: blockDurationSec(b.text, plain(b.delivery)) } : b)));
  const narrationSec = scriptTiming(blocks, target).totalSec;
  return { minSec: target.minSec, maxSec: target.maxSec, targetSec: target.targetSec, narrationSec, remainingSec: Math.max(0, round1(target.maxSec - narrationSec)) };
}

/** The budget as the performance pass reads it. */
export function renderBudget(b: PerformanceBudget): string {
  const head = `Runtime budget: the acceptable range is ${fmtClock(b.minSec)}–${fmtClock(b.maxSec)}; the narration with no pauses or pace changes runs ${fmtClock(b.narrationSec)}`;
  return b.remainingSec > 0
    ? `${head}, so your pauses and slower delivery together may add at most ${fmtClock(b.remainingSec)} (${b.remainingSec.toFixed(1)} s). Spend it where it matters: essential dramatic pauses and reveals first, then emotional turns, then transitions. Timing past the maximum is removed, least valuable first.`
    : `${head}: it already reaches the maximum, so add no pause and no slower delivery — anything you add is removed.`;
}

/** How much a kind of timing matters: the lowest goes first when the runtime is over. */
const VALUE: Record<PauseReason, number> = { RHYTHM: 1, QUESTION: 2, NUMBER: 3, TRANSITION: 5, EMOTIONAL_TURN: 6, IMPACT: 7, REVEAL: 8 };
const SLOW_VALUE = 4;
const STEP_DOWN: Record<PauseLength, PauseLength> = { LONG: 'MEDIUM', MEDIUM: 'SHORT', SHORT: 'MICRO', MICRO: 'NONE', NONE: 'NONE' };

type Mark = { kind: 'pauseBefore' | 'pauseAfter' | 'pace'; s: number; i: number };

const describe = (d: ScriptDelivery) =>
  [
    d.pace !== 'NORMAL' ? `pace ${d.pace.toLowerCase()}` : null,
    d.pauseBefore.length !== 'NONE' ? `pause before ${d.pauseBefore.length.toLowerCase()}${d.pauseBefore.reason ? ` (${d.pauseBefore.reason.toLowerCase().replace('_', ' ')})` : ''}` : null,
    d.pauseAfter.length !== 'NONE' ? `pause after ${d.pauseAfter.length.toLowerCase()}${d.pauseAfter.reason ? ` (${d.pauseAfter.reason.toLowerCase().replace('_', ' ')})` : ''}` : null,
  ]
    .filter(Boolean)
    .join('; ') || 'no timing';

/**
 * Hold the marked performance to the maximum: when the full runtime passes
 * it, remove timing in the sections the pass marked, least valuable first,
 * until it fits (or nothing optional is left). Returns the draft and a record
 * of each block whose timing was reduced or removed.
 */
export function fitPerformance(
  draft: ScriptDraft,
  target: RuntimeTarget,
  allowed: ReadonlySet<number>,
  opts: { allowOverMax?: boolean; firstId?: number } = {},
): { draft: ScriptDraft; changes: ScriptReviewChange[]; trimmedSec: number; beforeSec: number; afterSec: number } {
  const beforeSec = scriptTiming(draft.sections.flatMap((s) => s.blocks), target).totalSec;
  if (opts.allowOverMax || beforeSec <= target.maxSec) return { draft, changes: [], trimmedSec: 0, beforeSec, afterSec: beforeSec };
  const sections = draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, delivery: { ...b.delivery } })) }));
  const original = new Map<DraftBlock, ScriptDelivery>();
  sections.forEach((s, si) => s.blocks.forEach((b, bi) => original.set(b, draft.sections[si]!.blocks[bi]!.delivery)));
  let total = beforeSec;

  const value = (m: Mark): number => {
    const d = sections[m.s]!.blocks[m.i]!.delivery;
    if (m.kind === 'pace') return SLOW_VALUE;
    const p: ScriptPause = d[m.kind];
    return p.reason ? VALUE[p.reason] : VALUE.RHYTHM;
  };
  const live = (m: Mark): boolean => {
    const d = sections[m.s]!.blocks[m.i]!.delivery;
    return m.kind === 'pace' ? d.pace === 'SLOW' : d[m.kind].length !== 'NONE';
  };
  let marks: Mark[] = [];
  sections.forEach((s, si) => {
    if (!allowed.has(s.sequence)) return;
    s.blocks.forEach((_, bi) => marks.push({ kind: 'pace', s: si, i: bi }, { kind: 'pauseBefore', s: si, i: bi }, { kind: 'pauseAfter', s: si, i: bi }));
  });
  marks = marks.filter(live);

  while (total > target.maxSec + 1e-9 && marks.length) {
    // The least valuable timing first; between equals, the one that frees the most time, then the latest in the film.
    const saving = (m: Mark) => {
      const b = sections[m.s]!.blocks[m.i]!;
      const d = b.delivery;
      const next = m.kind === 'pace' ? { ...d, pace: 'NORMAL' as const } : { ...d, [m.kind]: { ...d[m.kind], length: STEP_DOWN[d[m.kind].length] } };
      return b.estimatedDurationSec - blockDurationSec(b.text, next);
    };
    marks.sort((a, b) => value(a) - value(b) || saving(b) - saving(a) || b.s - a.s || b.i - a.i);
    const m = marks[0]!;
    const b = sections[m.s]!.blocks[m.i]!;
    const d = b.delivery;
    const next: ScriptDelivery = m.kind === 'pace' ? { ...d, pace: 'NORMAL' } : { ...d, [m.kind]: STEP_DOWN[d[m.kind].length] === 'NONE' ? NO_PAUSE : { ...d[m.kind], length: STEP_DOWN[d[m.kind].length] } };
    const duration = blockDurationSec(b.text, next);
    total = round1(total - (b.estimatedDurationSec - duration));
    sections[m.s]!.blocks[m.i] = { ...b, delivery: next, estimatedDurationSec: duration };
    original.set(sections[m.s]!.blocks[m.i]!, original.get(b)!);
    marks = marks.map((x) => x).filter((x) => live(x));
  }

  const changes: ScriptReviewChange[] = [];
  let n = opts.firstId ?? 0;
  const why = `Over the runtime budget: with its performance timing the script ran ${fmtClock(beforeSec)}, past the ${fmtClock(target.maxSec)} maximum; the least valuable timing goes first (rhythm, question and number pauses, then slower delivery, then transitions, emotional turns, impact and reveals)`;
  for (const s of sections) {
    for (const b of s.blocks) {
      const was = original.get(b)!;
      const now = b.delivery;
      if (was.pace === now.pace && was.pauseBefore.length === now.pauseBefore.length && was.pauseAfter.length === now.pauseAfter.length) continue;
      const removed = now.pace === 'NORMAL' && now.pauseBefore.length === 'NONE' && now.pauseAfter.length === 'NONE';
      changes.push({
        id: `P${++n}`,
        reviewer: 'PERFORMANCE',
        type: 'PERFORMANCE',
        section: s.sequence,
        ref: b.key,
        savedRef: b.key,
        originalText: describe(was),
        proposedText: describe(now),
        reason: 'The performance pass marked this timing',
        status: removed ? 'REJECTED' : 'ACCEPTED',
        rulesImpacted: [removed ? 'runtime maximum: timing removed' : 'runtime maximum: timing reduced'],
        rejectionReason: removed ? why : null,
      });
    }
  }
  return { draft: { ...draft, sections }, changes, trimmedSec: round1(beforeSec - total), beforeSec, afterSec: total };
}
