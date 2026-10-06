import { CHUNK_SECONDS, DEFAULT_DELIVERY, DEFAULT_VOICE_PROFILE_CONFIG, spokenWordCount, wordsForSeconds, type ScriptBlockClass, type ScriptDelivery } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { chunkSeconds, planChunks, spanText, type ChunkBlock, type ChunkSection } from './chunking.ts';
import { countWords, sentenceSpans } from './text.ts';

/**
 * Small-bite chunking: whole sentences, natural boundaries, sizes that suit
 * regeneration — deterministic and explained. Sizes are spoken words; the
 * house default is about 8–12 s of speech.
 */

const SETTINGS = DEFAULT_VOICE_PROFILE_CONFIG.chunking;
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
const keys = (chunks: ReturnType<typeof planChunks>) => chunks.map((c) => c.spans.map((s) => s.blockKey));
const seconds = (c: ReturnType<typeof planChunks>[number]) => chunkSeconds(c.words, c.performance);

describe('sentences', () => {
  it('splits at sentence ends but not at abbreviations, initials, decimals or lower-case continuations', () => {
    const text = 'Dr. Brennan arrived c. 1637 with J. P. Coen. Prices rose 2.5 times… and kept rising! Why? "Nobody knew." It ended.';
    expect(sentenceSpans(text).map((s) => text.slice(s.start, s.end))).toEqual(['Dr. Brennan arrived c. 1637 with J. P. Coen.', 'Prices rose 2.5 times… and kept rising!', 'Why?', '"Nobody knew."', 'It ended.']);
  });
});

describe('planChunks', () => {
  it('the house default is about 8–12 s of speech', () => {
    expect(SETTINGS).toEqual({ minWords: wordsForSeconds(CHUNK_SECONDS.target.min), maxWords: wordsForSeconds(CHUNK_SECONDS.target.max) });
  });

  it('short block: keeps a short paragraph whole, and short blocks of one paragraph flow together', () => {
    order = 0;
    const chunks = planChunks([section('SC01', [block('1.1', 'The bulbs arrive in autumn.'), block('1.2', 'By spring, the whole town is talking about them, and nobody is quite sure why.')])], SETTINGS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, sectionKey: 'SC01', boundary: 'SECTION_END', words: 20 });
    expect(chunks[0]!.text).toBe('The bulbs arrive in autumn.\nBy spring, the whole town is talking about them, and nobody is quite sure why.');
    expect(chunks[0]!.spans.map((s) => s.blockKey)).toEqual(['1.1', '1.2']);
  });

  it('long block and sentence integrity: cuts a long paragraph between sentences only, into chunks within the size range', () => {
    order = 0;
    const text = Array.from({ length: 16 }, (_, i) => sentence(i + 1, 12)).join(' ');
    const chunks = planChunks([section('SC01', [block('1.1', text)])], SETTINGS);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
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

  it('rhetorical question: never separates a question from its answer, or a setup from its payoff', () => {
    order = 0;
    const q = 'So why would a sensible merchant, a man who counted every coin twice, hand over the price of a house for a flower he had never seen?';
    const a = 'Because everyone around him already had.';
    const setup = 'There was only one thing left to sell, and every buyer in the tavern knew exactly what it was…';
    const payoff = 'Nothing.';
    const filler = Array.from({ length: 4 }, (_, i) => sentence(i, 14)).join(' ');
    const chunks = planChunks([section('SC01', [block('1.1', `${filler} ${q}`), block('1.2', `${a} ${setup}`), block('1.3', `${payoff} ${filler}`)])], SETTINGS);
    const containing = (s: string) => chunks.findIndex((c) => c.text.includes(s));
    expect(containing(q)).toBe(containing(a));
    expect(containing(setup)).toBe(containing(payoff));
  });

  it('performance transition: cuts where the delivery changes markedly, and at a long scripted pause', () => {
    order = 0;
    const calm = 'The ledgers of the guild record each sale in the same careful hand, line after line, week after week, for most of the winter.';
    const tense = 'Then, in the first week of February, the buyers stop coming. Nobody bids. Nobody even answers the door.';
    const after = 'What follows is quieter: the courts, the letters, the long arguments about who owes what to whom, and why.';
    const chunks = planChunks(
      [section('SC01', [block('1.1', calm), block('1.2', tense, { emotion: 'TENSE', pace: 'FAST', energy: 'HIGH' }), block('1.3', after, { pauseBefore: { length: 'LONG', reason: 'TRANSITION' } })])],
      SETTINGS,
    );
    expect(keys(chunks)).toEqual([['1.1'], ['1.2'], ['1.3']]);
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

  it('natural boundaries: respects paragraph and section boundaries, speakers, and blocks that are not adjacent', () => {
    order = 0;
    const s1 = section('SC01', [block('1.1', sentence(1, 8)), block('1.2', '"We have nothing left," he wrote.', {}, { speakerId: 'R1' }), block('1.3', sentence(3, 8))]);
    const s2 = section('SC02', [block('2.1', sentence(4, 8))]);
    const gap = section('SC03', [block('3.1', sentence(5, 8)), { ...block('3.3', sentence(6, 8)), order: 999 }]);
    const chunks = planChunks([s1, s2, gap], SETTINGS);
    expect(keys(chunks)).toEqual([['1.1'], ['1.2'], ['1.3'], ['2.1'], ['3.1'], ['3.3']]);
    expect(chunks.map((c) => c.boundary)).toEqual(['SPEAKER', 'SPEAKER', 'SECTION_END', 'SECTION_END', 'PARAGRAPH', 'SECTION_END']);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('natural boundaries: a reveal or impact pause holds setup and payoff together (and is recorded with its reason); a transition still cuts', () => {
    const plan = (reason: 'REVEAL' | 'IMPACT' | 'TRANSITION') => {
      order = 0;
      // 22 + 18 words: over the maximum together, so the cut goes where the pause allows.
      const setup = block('1.1', `${sentence(1, 11)} ${sentence(2, 11)}`, { pauseAfter: { length: 'MEDIUM', reason } });
      const payoff = block('1.2', `${sentence(3, 9)} ${sentence(4, 9)}`);
      return planChunks([section('SC01', [setup, payoff])], SETTINGS);
    };
    for (const reason of ['REVEAL', 'IMPACT'] as const) {
      const chunks = plan(reason);
      const across = chunks.find((c) => c.text.includes('end2.') && c.text.includes('end3.'));
      expect(across, reason).toBeDefined();
      const setupEnd = across!.sentences.findIndex((s) => across!.text.slice(s.start, s.end).endsWith('end2.'));
      expect(across!.performance.pauses.inside).toEqual([{ afterSentence: setupEnd, length: 'MEDIUM', reason }]);
      expect(chunks.every((c) => c.boundary !== 'PAUSE')).toBe(true);
    }
    const transition = plan('TRANSITION');
    expect(keys(transition)).toEqual([['1.1'], ['1.2']]);
    expect(transition[0]!.boundary).toBe('PAUSE');
  });

  it('natural boundaries: a long pause that closes a thought cuts where size alone would not; a holding pause of the same length does not', () => {
    const plan = (pause: ScriptDelivery['pauseAfter'] | null) => {
      order = 0;
      // 16 + 16 words: a little over the maximum together, so without a pause they stay one chunk.
      return planChunks([section('SC01', [block('1.1', sentence(1, 16), pause ? { pauseAfter: pause } : {}), block('1.2', sentence(2, 16))])], SETTINGS);
    };
    expect(keys(plan(null))).toEqual([['1.1', '1.2']]);
    for (const reason of ['TRANSITION', 'EMOTIONAL_TURN', 'RHYTHM', null] as const) {
      const chunks = plan({ length: 'LONG', reason });
      expect(keys(chunks), String(reason)).toEqual([['1.1'], ['1.2']]);
      expect(chunks[0]!.boundary).toBe('PAUSE');
    }
    for (const reason of ['REVEAL', 'IMPACT', 'QUESTION', 'NUMBER'] as const) {
      const [chunk, ...rest] = plan({ length: 'LONG', reason });
      expect(rest, reason).toEqual([]);
      expect(chunk!.performance.pauses.inside).toEqual([{ afterSentence: 0, length: 'LONG', reason }]);
    }
  });

  it('natural boundaries: fiction is a chunk of its own (a change of information class is a PURPOSE cut)', () => {
    order = 0;
    const cls = (c: ScriptBlockClass) => ({ infoClass: c });
    const chunks = planChunks([section('SC01', [block('1.1', sentence(1, 14)), block('1.2', sentence(2, 14), {}, cls('FICTION')), block('1.3', sentence(3, 14))])], SETTINGS);
    expect(keys(chunks)).toEqual([['1.1'], ['1.2'], ['1.3']]);
    expect(chunks.map((c) => c.boundary)).toEqual(['PURPOSE', 'PURPOSE', 'SECTION_END']);
    // Any other change of class only tips a close call: a framing question keeps its documented answer.
    order = 0;
    const framed = planChunks([section('SC01', [block('2.1', 'Why would anyone pay that much for a flower nobody had seen?', {}, cls('FRAMING')), block('2.2', 'Because the price was rising every week, and everyone expected it to rise again.')])], SETTINGS);
    expect(keys(framed)).toEqual([['2.1', '2.2']]);
  });

  it('sizes chunks in spoken words: a figure counts as it is read', () => {
    order = 0;
    const a = 'Prices of 1,200, 1,500, 2,000, 2,500 and 3,000 guilders were all recorded that winter.';
    const b = 'Sales at 1,100, 1,400, 1,900, 2,400 and 2,900 guilders followed within a few weeks.';
    // 28 written words fit the maximum; 38 spoken words do not.
    expect([countWords(a) + countWords(b), spokenWordCount(a) + spokenWordCount(b)]).toEqual([28, 38]);
    const chunks = planChunks([section('SC01', [block('1.1', `${a} ${b}`)])], SETTINGS);
    expect(chunks.map((c) => c.text)).toEqual([a, b]);
    expect(chunks.map((c) => c.words)).toEqual([19, 19]);
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

  it('follows the chunk-size setting (the experiment sizes: about 5–8, 8–12 and 12–20 s)', () => {
    order = 0;
    const text = Array.from({ length: 24 }, (_, i) => sentence(i, 10)).join(' ');
    const sizes = (min: number, max: number) => planChunks([section('SC01', [block('1.1', text)])], { minWords: min, maxWords: max }).map((c) => c.words);
    const [short, house, long] = [
      [wordsForSeconds(5), wordsForSeconds(8)],
      [wordsForSeconds(8), wordsForSeconds(12)],
      [wordsForSeconds(12), wordsForSeconds(20)],
    ] as const;
    expect(sizes(...short).every((w) => w >= short[0] && w <= short[1])).toBe(true);
    expect(sizes(...house).every((w) => w >= house[0] && w <= house[1])).toBe(true);
    expect(sizes(...long).every((w) => w >= long[0] && w <= long[1])).toBe(true);
    expect(sizes(...short).length).toBeGreaterThan(sizes(...long).length);
  });

  it('estimates seconds from spoken words, the chunk pace and the pauses inside it', () => {
    const pauses = { before: 'LONG' as const, after: 'LONG' as const, inside: [{ afterSentence: 0, length: 'MEDIUM' as const, reason: 'REVEAL' as const }] };
    expect(chunkSeconds(25, { pace: 'NORMAL', pauses: { ...pauses, inside: [] } })).toBe(10);
    expect(chunkSeconds(25, { pace: 'NORMAL', pauses })).toBe(11.2);
    expect(chunkSeconds(25, { pace: 'SLOW', pauses })).toBe(12.6);
  });
});

describe('an opening at the house default', () => {
  const NONE = { length: 'NONE' as const, reason: null };
  const OPENING: [string, Partial<ScriptDelivery>?, ScriptBlockClass?][] = [
    ['In the winter of 1637, a single bulb could buy a house on a canal in Amsterdam. Not a fine house. But a house.', { emotion: 'CURIOUS' }],
    ['Nobody at this table has seen what he is buying.', { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }],
    ['What changes hands is not a flower. It’s a promise.', { energy: 'LOW', pace: 'SLOW' }],
    ['The buyers meet in taverns, in back rooms, over wine and pipe smoke. They write their bids on slates, and wipe them clean when the price moves. A clerk keeps the tally. Nobody keeps the bulbs.'],
    ['Records suggest that Cornelis Proefman refused to accept bulbs he had bought for 1,200 guilders. That was about four years of pay for a skilled craftsman.', {}, 'UNCERTAIN'],
    ['So why would a sensible merchant hand over that kind of money for a bulb he had never seen?', { emotion: 'CURIOUS', pauseAfter: { length: 'SHORT', reason: 'QUESTION' } }, 'FRAMING'],
    ['Because everyone around him already had.'],
    [
      'The trade ran on paper, on trust, and on the certainty that tomorrow someone would pay more. For a few weeks, that certainty held. Then, in the first days of February, in a tavern in Haarlem, nobody bid at all.',
      { emotion: 'TENSE', pauseAfter: { length: 'LONG', reason: 'TRANSITION' } },
    ],
    ['Imagine Thijs, a weaver, holding a slip of paper worth more than his loom.', {}, 'FICTION'],
    ['How much of what followed was panic, and how much was later legend, is still argued over. The court records are thin.', { emotion: 'REFLECTIVE' }, 'UNCERTAIN'],
  ];
  const plan = (settings = SETTINGS) => {
    order = 0;
    const blocks = OPENING.map(([text, d, c], i) => block(`1.${i + 1}`, text, { pauseBefore: NONE, ...d }, { infoClass: c ?? 'DOCUMENTED' }));
    return planChunks([section('SC01', blocks)], settings);
  };

  it('gives mostly 8–12 s chunks, none outside 5–20 s, and nothing over the hard ceiling', () => {
    const chunks = plan();
    const secs = chunks.map(seconds);
    const inTarget = secs.filter((s) => s >= CHUNK_SECONDS.target.min && s <= CHUNK_SECONDS.target.max);
    expect(inTarget.length / secs.length).toBeGreaterThan(0.6);
    expect(secs.every((s) => s >= CHUNK_SECONDS.natural.min && s <= CHUNK_SECONDS.natural.max)).toBe(true);
    const median = [...secs].sort((a, b) => a - b)[Math.floor(secs.length / 2)]!;
    expect(median).toBeGreaterThanOrEqual(CHUNK_SECONDS.target.min);
    expect(median).toBeLessThanOrEqual(CHUNK_SECONDS.target.max);
    expect(chunks.filter((c) => c.sentences.length > 1).every((c) => c.words <= SETTINGS.maxWords * 1.5)).toBe(true);
  });

  it('at the larger experiment size (12–20 s) a chunk of several sentences still never runs past about 20 s', () => {
    const large = { minWords: wordsForSeconds(12), maxWords: wordsForSeconds(20) };
    const chunks = plan(large);
    const several = chunks.filter((c) => c.sentences.length > 1);
    expect(several.length).toBeGreaterThan(2);
    expect(several.every((c) => c.words <= wordsForSeconds(CHUNK_SECONDS.natural.max))).toBe(true);
    expect(chunks.every((c) => seconds(c) <= CHUNK_SECONDS.natural.max)).toBe(true);
  });

  it('keeps setup and payoff, question and answer together, gives fiction its own chunk, and never joins a payoff to the next paragraph', () => {
    const chunks = plan();
    const at = (s: string) => chunks.findIndex((c) => c.text.includes(s));
    expect(at('In the winter of 1637')).toBe(at('But a house.'));
    expect(at('Nobody at this table')).toBe(at('It’s a promise.'));
    expect(at('So why would a sensible merchant')).toBe(at('Because everyone around him'));
    expect(at('For a few weeks, that certainty held.')).toBe(at('nobody bid at all.'));
    // The promise ends its chunk: the next paragraph is not split to start there.
    expect(chunks[at('It’s a promise.')]!.text.endsWith('It’s a promise.')).toBe(true);
    expect(chunks.find((c) => c.text.includes('Imagine Thijs'))!.spans.map((s) => s.blockKey)).toEqual(['1.9']);
    expect(chunks.map((c) => c.boundary)).toContain('PURPOSE');
  });
});
