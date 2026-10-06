import { CHUNK_SECONDS, VOICE_ACCEPTANCE_EXPERIMENT, wordsForSeconds, type VoiceChunkView, type VoicePlanView } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { sentenceSpans as engineSentences } from '../../../modules/voice/src/text.ts';
import { CHUNK_SIZES, costWords, experimentRuns, outsideNatural, parseDirections, plansEstimate, sentenceSpans, sizeLabel, takesEstimate } from './voice-plan.ts';

describe('chunk sizes', () => {
  it('are the engine’s seconds at the narration rate: below, at and above the target', () => {
    const { natural, target } = CHUNK_SECONDS;
    expect(CHUNK_SIZES.map((s) => s.label)).toEqual(['≈5–8 s', '≈8–12 s', '≈12–20 s']);
    expect(CHUNK_SIZES.map((s) => s.chunking)).toEqual([
      { minWords: wordsForSeconds(natural.min), maxWords: wordsForSeconds(target.min) },
      { minWords: wordsForSeconds(target.min), maxWords: wordsForSeconds(target.max) },
      { minWords: wordsForSeconds(target.max), maxWords: wordsForSeconds(natural.max) },
    ]);
    expect(sizeLabel(CHUNK_SIZES[1]!.chunking)).toBe('20–30 words (≈8–12 s)');
  });

  it('match the acceptance experiment’s F and G', () => {
    const by = (letter: string) => VOICE_ACCEPTANCE_EXPERIMENT.variants.find((v) => v.label.startsWith(letter))!.chunking;
    expect(by('F')).toEqual(CHUNK_SIZES[0]!.chunking);
    expect(by('B')).toEqual(CHUNK_SIZES[1]!.chunking);
    expect(by('G')).toEqual(CHUNK_SIZES[2]!.chunking);
  });

  it('flag seconds outside the natural range only', () => {
    expect([4.9, 5, 12, 20, 20.1].map(outsideNatural)).toEqual([true, false, false, false, true]);
  });
});

describe('sentence numbers', () => {
  const texts = [
    'Dr. Brennan arrived. He left.',
    'J. P. Coen sailed for Batavia. Then?',
    'It cost 1.5 guilders… What changed hands was not a flower. It was a promise.',
    '"Why?" she asked. "Because the price had doubled."',
    'One sentence.\nA second block, a second sentence',
    'Was it c. 1637? Yes. No. 5 was sold e.g. in Haarlem.',
    '(See above.) Next, the courts.',
    'He waited...  Nothing came. etc. And then',
    'In 1637 a bulb sold for 5,200 guilders. Thijs bought one!',
    '',
  ];

  it('are the engine’s: the dashboard splits every text exactly as modules/voice does', () => {
    for (const t of texts) expect(sentenceSpans(t), t).toEqual(engineSentences(t));
  });
});

describe('directions', () => {
  it('read one line per sentence, by the chunk’s numbers', () => {
    expect(parseDirections('2: curious\n3: quiet, deliberate', 3)).toEqual([
      { sentence: 1, emotion: 'curious' },
      { sentence: 2, emotion: 'quiet', delivery: 'deliberate' },
    ]);
    expect(parseDirections('', 2)).toEqual([]);
  });

  it('refuse a sentence the chunk does not have (the engine would drop it and the take be paid for without it)', () => {
    expect(parseDirections('3: curious', 2)).toBeNull();
    expect(parseDirections('0: curious', 2)).toBeNull();
  });

  it('refuse the same sentence twice, and words the contract refuses', () => {
    expect(parseDirections('1: curious\n1: quiet', 2)).toBeNull();
    expect(parseDirections('1: a', 2)).toBeNull();
    expect(parseDirections(`1: ${'very '.repeat(8)}quiet`, 2)).toBeNull();
    expect(parseDirections('1 curious', 2)).toBeNull();
  });
});

describe('estimates before a confirmation', () => {
  const take = (characters: number | null, performanceText: string | null = null) => ({ characters, performanceText }) as VoiceChunkView['generations'][number];
  const chunk = (text: string, current: ReturnType<typeof take> | null, generations: ReturnType<typeof take>[] = current ? [current] : []) => ({ text, current, generations }) as VoiceChunkView;

  it('count what each chunk’s last take sent, priced at the run’s own rate', () => {
    const chunks = [chunk('a'.repeat(50), take(120)), chunk('b'.repeat(40), null, [take(null, 'x'.repeat(70)), take(90)]), chunk('c'.repeat(30), null)];
    const e = takesEstimate(chunks, 2, { characters: 1000, cost: { totalUsd: 0.08, basis: 'ESTIMATED' } }, false);
    expect(e).toEqual({ takes: 6, characters: 2 * (120 + 90 + 30), costUsd: (0.08 / 1000) * 480, mock: false });
    expect(costWords(e)).toBe('~$0.04 estimated');
  });

  it('never make a price up', () => {
    const e = takesEstimate([chunk('abc', take(3))], 1, { characters: 0, cost: { totalUsd: 0, basis: null } }, false);
    expect(e.costUsd).toBeNull();
    expect(costWords(e)).toBe('cost unknown (no price yet)');
    expect(costWords(takesEstimate([chunk('abc', take(3))], 1, { characters: 10, cost: { totalUsd: 1, basis: 'MOCK' } }, true))).toBe('MOCK voice: no cost');
  });

  it('total a comparison, unpriced when any variant is', () => {
    const plan = (characters: number, estimatedCostUsd: number | null, costBasis: VoicePlanView['estimate']['costBasis']) => ({ estimate: { chunks: 3, characters, estimatedCostUsd, costBasis } }) as VoicePlanView;
    expect(plansEstimate([plan(100, 0.01, 'ESTIMATED'), plan(200, 0.02, 'ESTIMATED')])).toEqual({ takes: 6, characters: 300, costUsd: 0.03, mock: false });
    expect(plansEstimate([plan(100, 0.01, 'ESTIMATED'), plan(200, null, 'UNPRICED')]).costUsd).toBeNull();
    expect(plansEstimate([plan(100, 0, 'MOCK'), plan(200, 0, 'MOCK')])).toMatchObject({ costUsd: 0, mock: true });
  });
});

describe('a comparison’s runs', () => {
  const run = (number: number, experiment: string | null, variant: string | null) => ({ number, experiment, variant });
  const runs = [run(1, null, null), run(2, 'X', 'A'), run(3, 'X', 'B'), run(4, 'X', 'A'), run(5, 'X', 'B'), run(6, 'Y', 'A'), run(7, null, null), run(8, 'X', 'A'), run(9, 'X', 'B'), run(10, 'X', 'C')].reverse();
  const numbers = (n: number) => experimentRuns(runs, n).map((r) => r.number);

  it('are one job’s consecutive runs of one name; a repeated label starts the next job', () => {
    expect(numbers(3)).toEqual([2, 3]);
    expect(numbers(4)).toEqual([4, 5]);
    expect(numbers(9)).toEqual([8, 9, 10]);
    expect(numbers(6)).toEqual([6]);
  });

  it('are none for a run outside any comparison', () => {
    expect(numbers(1)).toEqual([]);
    expect(numbers(7)).toEqual([]);
  });
});
