import { DEFAULT_DELIVERY, type ScriptDelivery } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { planChunks, spanText, type ChunkBlock, type ChunkSection } from './chunking.ts';
import { countWords, sentenceSpans } from './text.ts';

/**
 * Small-bite chunking: whole sentences, natural boundaries, sizes that suit
 * regeneration — deterministic and explained.
 */

const SETTINGS = { minWords: 25, maxWords: 80 };
let order = 0;
const block = (key: string, text: string, d: Partial<ScriptDelivery> = {}, extra: Partial<ChunkBlock> = {}): ChunkBlock => ({
  id: `id-${key}`,
  key,
  text,
  delivery: { ...DEFAULT_DELIVERY, ...d },
  speakerId: null,
  infoClass: 'DOCUMENTED',
  order: order++,
  ...extra,
});
const section = (key: string, blocks: ChunkBlock[]): ChunkSection => ({ id: `sec-${key}`, key, blocks });
const sentence = (n: number, words = 10) => `${'word '.repeat(words - 1)}end${n}.`.replace(/^w/, 'W');

describe('sentences', () => {
  it('splits at sentence ends but not at abbreviations, initials, decimals or lower-case continuations', () => {
    const text = 'Dr. Brennan arrived c. 1637 with J. P. Coen. Prices rose 2.5 times… and kept rising! Why? "Nobody knew." It ended.';
    expect(sentenceSpans(text).map((s) => text.slice(s.start, s.end))).toEqual(['Dr. Brennan arrived c. 1637 with J. P. Coen.', 'Prices rose 2.5 times… and kept rising!', 'Why?', '"Nobody knew."', 'It ended.']);
  });
});

describe('planChunks', () => {
  it('keeps a short paragraph whole, and short blocks of one paragraph flow together', () => {
    order = 0;
    const chunks = planChunks([section('SC01', [block('1.1', 'The bulbs arrive in autumn.'), block('1.2', 'By spring, the whole town is talking about them, and nobody is quite sure why.')])], SETTINGS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, sectionKey: 'SC01', boundary: 'SECTION_END', words: 20 });
    expect(chunks[0]!.text).toBe('The bulbs arrive in autumn.\nBy spring, the whole town is talking about them, and nobody is quite sure why.');
    expect(chunks[0]!.spans.map((s) => s.blockKey)).toEqual(['1.1', '1.2']);
  });

  it('cuts a long paragraph between sentences only, into chunks within the size range', () => {
    order = 0;
    const text = Array.from({ length: 16 }, (_, i) => sentence(i + 1, 12)).join(' ');
    const chunks = planChunks([section('SC01', [block('1.1', text)])], SETTINGS);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.words).toBeGreaterThanOrEqual(SETTINGS.minWords);
      expect(c.words).toBeLessThanOrEqual(SETTINGS.maxWords);
      // Sentence integrity: every chunk is whole sentences of the block, verbatim.
      expect(c.text).toMatch(/^Word .*end\d+\.$/);
      expect(text).toContain(c.text);
    }
    expect(chunks.map((c) => c.text).join(' ')).toBe(text);
    expect(chunks.slice(0, -1).every((c) => c.boundary === 'SENTENCE')).toBe(true);
  });

  it('never separates a rhetorical question from its answer, or a setup from its payoff', () => {
    order = 0;
    const q = 'So why would a sensible merchant, a man who counted every coin twice, hand over the price of a house for a flower he had never seen?';
    const a = 'Because everyone around him already had.';
    const setup = 'There was only one thing left to sell, and every buyer in the tavern knew exactly what it was…';
    const payoff = 'Nothing.';
    const filler = Array.from({ length: 4 }, (_, i) => sentence(i, 14)).join(' ');
    const chunks = planChunks([section('SC01', [block('1.1', `${filler} ${q}`), block('1.2', `${a} ${setup}`), block('1.3', `${payoff} ${filler}`)])], { minWords: 20, maxWords: 50 });
    const containing = (s: string) => chunks.findIndex((c) => c.text.includes(s));
    expect(containing(q)).toBe(containing(a));
    expect(containing(setup)).toBe(containing(payoff));
  });

  it('cuts where the delivery changes markedly, and at a long scripted pause', () => {
    order = 0;
    const calm = 'The ledgers of the guild record each sale in the same careful hand, line after line, week after week, for most of the winter.';
    const tense = 'Then, in the first week of February, the buyers stop coming. Nobody bids. Nobody even answers the door.';
    const after = 'What follows is quieter: the courts, the letters, the long arguments about who owes what to whom, and why.';
    const chunks = planChunks(
      [section('SC01', [block('1.1', calm), block('1.2', tense, { emotion: 'TENSE', pace: 'FAST', energy: 'HIGH' }), block('1.3', after, { pauseBefore: { length: 'LONG', reason: 'TRANSITION' } })])],
      SETTINGS,
    );
    expect(chunks.map((c) => c.spans.map((s) => s.blockKey))).toEqual([['1.1'], ['1.2'], ['1.3']]);
    expect(chunks.map((c) => c.boundary)).toEqual(['PERFORMANCE', 'PAUSE', 'SECTION_END']);
    expect(chunks[1]!.performance).toMatchObject({ emotion: 'TENSE', pace: 'FAST', energy: 'HIGH' });
    expect(chunks[2]!.performance.pauses.before).toBe('LONG');
  });

  it('does not shatter a passage into tiny clips because the delivery shifts slightly', () => {
    order = 0;
    const blocks = Array.from({ length: 6 }, (_, i) => block(`1.${i + 1}`, `${sentence(i, 9)}`, { emotion: i % 2 ? 'REFLECTIVE' : 'NEUTRAL' }));
    const chunks = planChunks([section('SC01', blocks)], SETTINGS);
    expect(chunks.length).toBeLessThanOrEqual(2);
    expect(chunks.every((c) => c.words >= 18)).toBe(true);
  });

  it('respects paragraph and section boundaries, speakers, and blocks that are not adjacent', () => {
    order = 0;
    const s1 = section('SC01', [block('1.1', sentence(1, 8)), block('1.2', '"We have nothing left," he wrote.', {}, { speakerId: 'R1' }), block('1.3', sentence(3, 8))]);
    const s2 = section('SC02', [block('2.1', sentence(4, 8))]);
    const gap = section('SC03', [block('3.1', sentence(5, 8)), { ...block('3.3', sentence(6, 8)), order: 999 }]);
    const chunks = planChunks([s1, s2, gap], SETTINGS);
    expect(chunks.map((c) => c.spans.map((s) => s.blockKey))).toEqual([['1.1'], ['1.2'], ['1.3'], ['2.1'], ['3.1'], ['3.3']]);
    expect(chunks.map((c) => c.boundary)).toEqual(['SPEAKER', 'SPEAKER', 'SECTION_END', 'SECTION_END', 'PARAGRAPH', 'SECTION_END']);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('is deterministic, inspectable and traceable back to the exact script text', () => {
    order = 0;
    const text = `${sentence(1, 30)} ${sentence(2, 30)} ${sentence(3, 30)}`;
    const blocks = [block('4.1', text), block('4.2', sentence(9, 20))];
    const a = planChunks([section('SC04', blocks)], SETTINGS);
    const b = planChunks([section('SC04', blocks)], SETTINGS);
    expect(a).toEqual(b);
    const texts = new Map(blocks.map((x) => [x.key, x.text]));
    for (const c of a) expect(spanText(c.spans, (k) => texts.get(k) ?? null)).toBe(c.text);
    // A block edited later no longer matches its chunks.
    texts.set('4.1', text.replace('Word', 'Changed'));
    expect(spanText(a[0]!.spans, (k) => texts.get(k) ?? null)).not.toBe(a[0]!.text);
    expect(a.reduce((n, c) => n + c.words, 0)).toBe(countWords(text) + 20);
  });

  it('follows the chunk-size setting (the experiment sizes)', () => {
    order = 0;
    const text = Array.from({ length: 24 }, (_, i) => sentence(i, 10)).join(' ');
    const sizes = (min: number, max: number) => planChunks([section('SC01', [block('1.1', text)])], { minWords: min, maxWords: max }).map((c) => c.words);
    expect(sizes(20, 40).every((w) => w >= 20 && w <= 40)).toBe(true);
    expect(sizes(40, 80).every((w) => w >= 40 && w <= 80)).toBe(true);
    expect(sizes(80, 120).every((w) => w >= 80 && w <= 120)).toBe(true);
    expect(sizes(20, 40).length).toBeGreaterThan(sizes(80, 120).length);
  });
});
