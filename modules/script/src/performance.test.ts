import { DEFAULT_DELIVERY, NO_PAUSE, scriptTiming, type PauseReason, type RuntimeTarget, type ScriptDelivery } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { allBlocks, derive, type ScriptDraft } from './draft.ts';
import { fitPerformance, performanceBudget, renderBudget } from './performance.ts';
import { syntheticDraft, syntheticScope } from './testing.ts';

/**
 * The runtime maximum holds through the performance pass: pauses and slower
 * delivery spend a budget, and what passes the maximum is given up — the least
 * valuable timing first, never by speeding up. Synthetic biography, numbers
 * from the acceptance criteria (10:00–15:00).
 */

const TARGET: RuntimeTarget = { minSec: 600, maxSec: 900, targetSec: 750 };
const scope = syntheticScope({
  question: 'What did the cartographer leave behind?',
  claims: [{ key: 'M1', statement: 'The cartographer Ines Vale drew the coastline survey between 1820 and 1834.', importance: 'KEY' }],
  sequences: [{ title: 'The survey', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'STAKES', claimKeys: ['M1'] }] }],
});

const words = (n: number) => `${Array.from({ length: n }, () => 'word').join(' ')}.`;
/** A narration of `blocks` blocks of 100 spoken words (40 seconds each at 150 a minute), and a last block of `extra` words. */
const narration = (blocks: number, extra = 0): ScriptDraft =>
  syntheticDraft(scope, [[...Array.from({ length: blocks }, () => words(100)), ...(extra ? [words(extra)] : [])].map((text) => ({ text, infoClass: 'DOCUMENTED' as const, beatIds: ['1.1'], claimKeys: ['M1'] }))]);

const pause = (reason: PauseReason) => ({ length: 'LONG' as const, reason });
function perform(draft: ScriptDraft, marks: Record<number, Partial<ScriptDelivery>>): ScriptDraft {
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b, i) => (marks[i] ? derive({ ...b, delivery: { ...DEFAULT_DELIVERY, ...marks[i] } }, scope) : b)) })) };
}
const total = (d: ScriptDraft) => scriptTiming(allBlocks(d), TARGET).totalSec;

describe('the performance runtime budget', () => {
  it('tells the pass what it may spend: the maximum minus the narration alone', () => {
    const draft = narration(22);
    const budget = performanceBudget(draft, TARGET, new Set([1]));
    expect(budget).toEqual({ minSec: 600, maxSec: 900, targetSec: 750, narrationSec: 880, remainingSec: 20 });
    expect(renderBudget(budget)).toContain('the narration with no pauses or pace changes runs 14:40, so your pauses and slower delivery together may add at most 0:20 (20.0 s)');
    // Existing timing in the sections the pass marks does not count against it.
    expect(performanceBudget(perform(draft, { 0: { pace: 'SLOW', pauseAfter: pause('REVEAL') } }), TARGET, new Set([1])).narrationSec).toBe(880);
    expect(renderBudget(performanceBudget(narration(23), TARGET, new Set([1])))).toContain('it already reaches the maximum, so add no pause and no slower delivery');
  });

  it('narration 14:40 with 35 s of performance: gives up 15 s or more, least valuable first, and lands inside 15:00', () => {
    const marked = perform(narration(22), {
      0: { pace: 'SLOW' },
      1: { pace: 'SLOW' },
      2: { pace: 'SLOW' },
      3: { pace: 'SLOW' },
      4: { pauseAfter: pause('RHYTHM') },
      5: { pauseAfter: pause('RHYTHM') },
      6: { pauseAfter: pause('RHYTHM') },
      7: { pauseAfter: pause('TRANSITION') },
      8: { pauseAfter: pause('TRANSITION') },
      9: { pauseBefore: pause('REVEAL') },
      10: { pauseAfter: pause('REVEAL') },
    });
    expect(total(marked)).toBeGreaterThanOrEqual(915);
    const fit = fitPerformance(marked, TARGET, new Set([1]));
    expect(fit.afterSec).toBeLessThanOrEqual(900);
    expect(total(fit.draft)).toBe(fit.afterSec);
    expect(fit.trimmedSec).toBeGreaterThanOrEqual(15);
    const after = allBlocks(fit.draft);
    // Rhythm pauses went first; reveals and transitions were kept; nothing was sped up.
    expect(after.slice(4, 7).map((b) => b.delivery.pauseAfter)).toEqual([NO_PAUSE, NO_PAUSE, NO_PAUSE]);
    expect(after.slice(7, 9).map((b) => b.delivery.pauseAfter.length)).toEqual(['LONG', 'LONG']);
    expect([after[9]!.delivery.pauseBefore.length, after[10]!.delivery.pauseAfter.length]).toEqual(['LONG', 'LONG']);
    expect(after.some((b) => b.delivery.pace === 'FAST')).toBe(false);
    expect(after.slice(0, 4).filter((b) => b.delivery.pace === 'SLOW').length).toBeLessThan(4);
    // Each block it changed is recorded, with why.
    expect(fit.changes.length).toBeGreaterThanOrEqual(4);
    expect(fit.changes.every((c) => c.reviewer === 'PERFORMANCE' && c.type === 'PERFORMANCE')).toBe(true);
    expect(fit.changes.find((c) => c.ref === '1.5')).toMatchObject({ status: 'REJECTED', originalText: 'pause after long (rhythm)', proposedText: 'no timing' });
    expect(fit.changes[0]!.rejectionReason ?? fit.changes.find((c) => c.rejectionReason)!.rejectionReason).toMatch(/^Over the runtime budget: with its performance timing the script ran 15:\d\d, past the 15:00 maximum/);
  });

  it('narration 14:10 with 20 s of performance: 14:30, untouched', () => {
    const marked = perform(narration(21, 25), {
      0: { pace: 'SLOW' },
      1: { pace: 'SLOW' },
      2: { pauseAfter: pause('REVEAL') },
      3: { pauseAfter: pause('RHYTHM') },
      4: { pauseAfter: pause('TRANSITION') },
      5: { pauseAfter: pause('IMPACT') },
      6: { pauseAfter: { length: 'MEDIUM', reason: 'EMOTIONAL_TURN' } },
    });
    expect(performanceBudget(narration(21, 25), TARGET, new Set([1])).narrationSec).toBe(850);
    const fit = fitPerformance(marked, TARGET, new Set([1]));
    expect(fit.changes).toEqual([]);
    expect(fit.afterSec).toBe(total(marked));
    expect(fit.afterSec).toBeCloseTo(870, 0);
  });

  it('lets the performance run past the maximum only when the user allows it', () => {
    const marked = perform(narration(22), { 0: { pace: 'SLOW' }, 1: { pace: 'SLOW' }, 2: { pace: 'SLOW' }, 3: { pace: 'SLOW' }, 4: { pauseAfter: pause('REVEAL') } });
    expect(fitPerformance(marked, TARGET, new Set([1]), { allowOverMax: true })).toMatchObject({ changes: [], trimmedSec: 0 });
    expect(fitPerformance(marked, TARGET, new Set([1])).afterSec).toBeLessThanOrEqual(900);
  });

  it('touches only the sections the pass marked', () => {
    const marked = perform(narration(23), { 0: { pace: 'SLOW' } });
    const fit = fitPerformance(marked, TARGET, new Set([2]));
    expect(fit.changes).toEqual([]);
    expect(allBlocks(fit.draft)[0]!.delivery.pace).toBe('SLOW');
  });
});
