import { describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY, ScriptContent, ScriptDelivery } from './contracts/script.ts';
import { blockDurationSec, fmtClock, fmtVariance, scriptTiming, spokenWordCount, wordsForSeconds } from './script.ts';

describe('script timing', () => {
  it('counts words as a narrator says them', () => {
    expect(spokenWordCount('The courts sent the contracts back.')).toBe(6);
    // A year reads as two words; 1,200 as two ("twelve hundred"); punctuation is silent: 9 words + 2 + 2.
    expect(spokenWordCount('In 1637 a buyer paid 1,200 guilders — or so it seems.')).toBe(13);
    expect(spokenWordCount('— … ?')).toBe(0);
  });

  it('estimates a block from its words, its pace and its pauses', () => {
    expect(blockDurationSec('one two three four five six seven eight nine ten', DEFAULT_DELIVERY)).toBe(4);
    expect(blockDurationSec('one two three four five six seven eight nine ten', { pace: 'FAST', pauseBefore: { length: 'SHORT', reason: 'TRANSITION' }, pauseAfter: { length: 'LONG', reason: 'REVEAL' } })).toBe(Math.round((4 / 1.12 + 0.6 + 2) * 10) / 10);
    expect(wordsForSeconds(780)).toBe(1950);
  });

  it('totals a script against its target, with the variance', () => {
    const t = scriptTiming(
      [
        { wordCount: 900, estimatedDurationSec: 380 },
        { wordCount: 950, estimatedDurationSec: 374 },
      ],
      { minSec: 600, maxSec: 900, targetSec: 780 },
    );
    expect(t).toEqual({ words: 1850, totalSec: 754, targetSec: 780, minSec: 600, maxSec: 900, varianceSec: -26, fit: 'WITHIN' });
    expect(`${fmtClock(t.totalSec)} ${fmtVariance(t.varianceSec)}`).toBe('12:34 −0:26');
    expect(fmtVariance(65)).toBe('+1:05');
  });
});

describe('script contracts', () => {
  it('validate delivery and content', () => {
    expect(ScriptDelivery.safeParse({ ...DEFAULT_DELIVERY, pace: 'RUSHED' }).success).toBe(false);
    expect(ScriptDelivery.parse({ ...DEFAULT_DELIVERY, pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }).pauseAfter.reason).toBe('REVEAL');
    const content = {
      engineVersion: 1,
      architecture: { id: 'a', version: 3 },
      narrator: { persona: 'p', tone: 't', approach: 'a' },
      centralQuestion: { text: 'Why?', posedIn: '1.1', answeredIn: '9.4' },
      pronunciations: [],
      performanceNotes: [],
      editor: null,
      factCheck: null,
      provenance: { origin: 'SECTIONS', baseVersion: 1, baseId: 'b', sections: [3], brief: 'Tighter.', requestedBy: 'editor', changeLog: null },
    };
    expect(ScriptContent.parse(content).provenance.sections).toEqual([3]);
    expect(ScriptContent.safeParse({ ...content, engineVersion: 2 }).success).toBe(false);
  });
});
