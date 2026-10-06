import { DEFAULT_DELIVERY, DEFAULT_VOICE_PROFILE_CONFIG, type DirectorMark, type PerformanceMark, type PerformanceStrategy, type ScriptBlockClass, type ScriptDelivery } from '@docengine/core';
import { ElevenLabsVoiceProvider } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { checkTake } from './checks.ts';
import { planChunks, type ChunkBlock } from './chunking.ts';
import { isHouseDirection, isReset, performanceMarks, type PreparedSentence } from './performance.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';

/**
 * Performance preparation by strategy, and the director's directions on top
 * of it: the house style is the default, a director adds to it and never
 * replaces it, and the expressive comparison adds one deliberate moment
 * where the script turns.
 */

const v4 = new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: async () => new Response('{}') });

let order = 0;
const block = (key: string, text: string, d: Partial<ScriptDelivery> = {}, infoClass: ScriptBlockClass = 'DOCUMENTED'): ChunkBlock => ({ id: `id-${key}`, key, text, delivery: { ...DEFAULT_DELIVERY, ...d }, speakerId: null, infoClass, order: order++ });

function take(blocks: ChunkBlock[], strategy: PerformanceStrategy, director?: DirectorMark[]) {
  const [chunk] = planChunks([{ id: 's', key: 'SC01', blocks }], { minWords: 150, maxWords: 200 });
  const map = new Map<string, TakeBlock>(blocks.map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  return prepareTake({ chunk: chunk!, blocks: map, strategy, ...(director ? { director } : {}), numberStyle: 'UK', aliases: [], phonemes: [], provider: v4, model: 'eleven_v4', settings: DEFAULT_VOICE_PROFILE_CONFIG.settings, context: { previousText: null, nextText: null }, seed: 7 });
}
const marks = (t: ReturnType<typeof take>) => t.prepared.marks.map((m) => [m.sentence, [m.intent.emotion, m.intent.delivery].filter(Boolean).join(', '), m.source]);
const status = (t: ReturnType<typeof take>, id: string) => t.prepared.checks.find((c) => c.id === id)?.status;

const PROMISE = () => {
  order = 0;
  return [block('1.1', 'Nobody at this table has seen what he is buying.'), block('1.2', 'What changes hands is not a flower.', { emotion: 'CURIOUS' }), block('1.3', "It's a promise.", { energy: 'LOW', pace: 'SLOW' })];
};
/** One tense block of three sentences, then plain narration. */
const BIDDING = () => {
  order = 0;
  return [block('2.1', 'And then the bidding stopped. Nobody in the tavern said a word for a long while. The slates stayed blank.', { emotion: 'TENSE' }), block('2.2', 'The records of the next weeks are mostly court papers and letters.')];
};

describe("a director's directions add to the house style", () => {
  it('keeps the house marks, and goes back to the direction in force after the director\'s sentence', () => {
    const t = take(BIDDING(), 'RESTRAINED', [{ sentence: 1, delivery: 'quiet' }]);
    expect(t.rendered.text).toBe('[tense] And then the bidding stopped. [quiet] Nobody in the tavern said a word for a long while. [tense] The slates stayed blank. [matter-of-fact] The records of the next weeks are mostly court papers and letters.');
    expect(marks(t)).toEqual([
      [0, 'tense', 'SCRIPT'],
      [1, 'quiet', 'DIRECTOR'],
      [2, 'tense', 'DIRECTOR'],
      [3, 'matter-of-fact', 'SCRIPT'],
    ]);
    expect(t.passed).toBe(true);
  });

  it("the director's direction wins on its own sentence; every mark keeps its source", () => {
    const t = take(PROMISE(), 'RESTRAINED', [{ sentence: 1, emotion: 'reflective' }]);
    expect(t.rendered.text).toBe("Nobody at this table has seen what he is buying. [reflective] What changes hands is not a flower. [quiet] It's a promise.");
    expect(marks(t)).toEqual([
      [1, 'reflective', 'DIRECTOR'],
      [2, 'quiet', 'SCRIPT'],
    ]);
    expect(status(t, 'density')).toBe('PASS');
  });

  it('on plain narration it goes back to the plain register; a plain take keeps only the director\'s', () => {
    order = 0;
    const plain = [block('3.1', 'The guild met on Tuesdays. It kept a ledger of every sale, every price and every name. Nobody read it.')];
    const t = take(plain, 'RESTRAINED', [{ sentence: 0, emotion: 'reflective' }]);
    expect(t.rendered.text).toBe('[reflective] The guild met on Tuesdays. [matter-of-fact] It kept a ledger of every sale, every price and every name. Nobody read it.');
    const p = take(BIDDING(), 'PLAIN', [{ sentence: 3, emotion: 'reflective' }]);
    expect(p.rendered.text).toBe('And then the bidding stopped. Nobody in the tavern said a word for a long while. The slates stayed blank. [reflective] The records of the next weeks are mostly court papers and letters.');
    expect(status(p, 'density')).toBe('PASS');
  });

  it('warns, without refusing, when the directions together crowd the chunk', () => {
    const t = take(BIDDING(), 'RESTRAINED', [
      { sentence: 1, delivery: 'quiet' },
      { sentence: 2, emotion: 'somber' },
    ]);
    expect(status(t, 'density')).toBe('WARN');
    expect(t.passed).toBe(true);
  });
});

describe('expressive: the house style plus one deliberate moment where the script turns', () => {
  it("gives the brief's example: the house's curious line, then one fuller direction on the payoff", () => {
    const t = take(PROMISE(), 'EXPRESSIVE');
    expect(t.rendered.text).toBe("Nobody at this table has seen what he is buying. [curious] What changes hands is not a flower. [quiet, deliberate] It's a promise.");
    expect(marks(t)).toEqual([
      [1, 'curious', 'SCRIPT'],
      [2, 'quiet, deliberate', 'STRATEGY'],
    ]);
    expect(t.prepared.marks[1]!.reason).toMatch(/^expressive moment: block 1\.3/);
    expect(t.prepared.checks.map((c) => `${c.id}:${c.status}`)).toContain('density:PASS');
    expect(t.passed).toBe(true);
    // The house style alone, for comparison.
    expect(take(PROMISE(), 'RESTRAINED').rendered.text).toBe("Nobody at this table has seen what he is buying. [curious] What changes hands is not a flower. [quiet] It's a promise.");
  });

  it('after a reveal pause on plain narration: a slower manner for that block, then back to the plain register', () => {
    order = 0;
    const blocks = [
      block('4.1', 'Nobody at this table has seen what he is buying.', { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }),
      block('4.2', "What changes hands is not a flower. It's a promise."),
      block('4.3', 'The buyers meet in taverns, in back rooms, over wine and pipe smoke.'),
    ];
    const t = take(blocks, 'EXPRESSIVE');
    expect(t.rendered.text).toBe("Nobody at this table has seen what he is buying. [pause] [deliberate] What changes hands is not a flower. It's a promise. [matter-of-fact] The buyers meet in taverns, in back rooms, over wine and pipe smoke.");
    expect(marks(t)).toEqual([
      [1, 'deliberate', 'STRATEGY'],
      [3, 'matter-of-fact', 'STRATEGY'],
    ]);
    // Not an emotion on plain narration: nothing manufactured.
    expect(status(t, 'restraint')).toBe('PASS');
    expect(take(blocks, 'RESTRAINED').prepared.marks).toEqual([]);
  });

  it('at most one moment per chunk, the strongest turn first, never crowding another direction', () => {
    order = 0;
    const blocks = [
      block('5.1', 'For a few weeks the certainty held, in every tavern and every back room in town.', { pauseAfter: { length: 'SHORT', reason: 'EMOTIONAL_TURN' } }),
      block('5.2', 'Then, in the first days of February, nobody bid at all.', { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }),
      block('5.3', 'Not one buyer came to the auction in Haarlem that morning.'),
    ];
    const t = take(blocks, 'EXPRESSIVE');
    expect(marks(t)).toEqual([[2, 'deliberate', 'STRATEGY']]);
    expect(t.prepared.marks.filter((m) => m.source === 'STRATEGY')).toHaveLength(1);
    // Too close to the house mark before it (under six words): no moment there.
    order = 0;
    const short = [block('6.1', 'It ended.', { emotion: 'SOMBER' }), block('6.2', 'Quickly.', { energy: 'LOW', pace: 'SLOW' })];
    expect(marks(take(short, 'EXPRESSIVE'))).toEqual(marks(take(short, 'RESTRAINED')));
  });

  it('goes back to the house style at the next block, also where the moment took the place of the house direction', () => {
    order = 0;
    const blocks = [
      block('8.1', 'Nobody at this table has seen what he is buying.'),
      block('8.2', "What changes hands is not a flower. It's a promise.", { energy: 'LOW', pace: 'SLOW' }),
      block('8.3', 'And a promise, in this town, can be sold on before supper.', { energy: 'LOW', pace: 'SLOW' }),
    ];
    const t = take(blocks, 'EXPRESSIVE');
    expect(t.rendered.text).toBe("Nobody at this table has seen what he is buying. [quiet, deliberate] What changes hands is not a flower. It's a promise. [quiet] And a promise, in this town, can be sold on before supper.");
    expect(marks(t)).toEqual([
      [1, 'quiet, deliberate', 'STRATEGY'],
      [3, 'quiet', 'STRATEGY'],
    ]);
    expect(status(t, 'density')).toBe('PASS');
    expect(t.passed).toBe(true);
  });

  it('goes back to what the house style has in force, never to a direction the house did not give (a feeling would carry into plain narration)', () => {
    order = 0;
    const blocks = [
      block('12.1', 'And then the bidding stopped, in every tavern in Haarlem.', { emotion: 'TENSE', pauseAfter: { length: 'LONG', reason: 'EMOTIONAL_TURN' } }),
      block('12.2', 'The records of the next weeks are mostly court papers.'),
      block('12.3', 'What did a promise on paper still mean to anyone?', { emotion: 'CURIOUS' }),
      block('12.4', 'The guild met again on the first of March.'),
    ];
    // The house style has used its two directions by 12.3, so 12.3 and 12.4 are read in the plain register.
    expect(take(blocks, 'RESTRAINED').prepared.marks.map((m) => m.sentence)).toEqual([0, 1]);
    const t = take(blocks, 'EXPRESSIVE');
    expect(t.rendered.text).toBe('[tense] And then the bidding stopped, in every tavern in Haarlem. [long pause] [quiet] The records of the next weeks are mostly court papers. [matter-of-fact] What did a promise on paper still mean to anyone? The guild met again on the first of March.');
    expect(marks(t)).toEqual([
      [0, 'tense', 'SCRIPT'],
      [1, 'quiet', 'STRATEGY'],
      [2, 'matter-of-fact', 'STRATEGY'],
    ]);
    expect(status(t, 'density')).toBe('PASS');
  });

  it('changes nothing outside its own block, and a director nothing outside its own sentence (every combination of three blocks)', () => {
    const DELIVERIES: Partial<ScriptDelivery>[] = [{}, { emotion: 'CURIOUS' }, { emotion: 'SOMBER', energy: 'HIGH', pace: 'SLOW' }, { energy: 'LOW', pace: 'SLOW' }, { emotion: 'CURIOUS', pace: 'FAST' }];
    const PAUSES: Partial<ScriptDelivery>[] = [{}, { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }, { pauseAfter: { length: 'LONG', reason: 'EMOTIONAL_TURN' } }];
    const kinds = DELIVERIES.flatMap((d) => PAUSES.map((p) => ({ ...d, ...p })));
    /** What is in force at each sentence ("plain" for none or a reset). */
    const inForce = (all: readonly PerformanceMark[], n: number) =>
      Array.from({ length: n }, (_, i) => {
        const m = all.filter((x) => x.sentence <= i).at(-1);
        return !m || isReset(m.intent) ? 'plain' : [m.intent.emotion, m.intent.delivery].join('|');
      });
    let moments = 0;
    for (const a of kinds) {
      for (const b of kinds) {
        for (const c of kinds) {
          order = 0;
          const blocks = [block('1.1', 'The buyers met in the tavern every night.', a), block('1.2', 'They wrote their bids on the slates in chalk.', b), block('1.3', 'Nobody in the room had seen a single bulb.', c)];
          const [chunk] = planChunks([{ id: 's', key: 'SC01', blocks }], { minWords: 150, maxWords: 200 });
          const sentences: PreparedSentence[] = blocks.map((x) => ({ text: x.text, blockKey: x.key, delivery: x.delivery, infoClass: x.infoClass, blockStart: true }));
          const house = inForce(performanceMarks(sentences, 'RESTRAINED', chunk!.performance.pauses), 3);
          const expressive = performanceMarks(sentences, 'EXPRESSIVE', chunk!.performance.pauses);
          const moment = expressive.find((m) => m.source === 'STRATEGY' && !isHouseDirection(m, sentences));
          expect(expressive.filter((m) => m.source === 'STRATEGY' && !isHouseDirection(m, sentences)).length).toBeLessThanOrEqual(1);
          const differs = inForce(expressive, 3).flatMap((f, i) => (f !== house[i] ? [i] : []));
          expect(differs, JSON.stringify([a, b, c])).toEqual(moment ? [moment.sentence] : []);
          if (moment) moments++;
          for (const sentence of [0, 1, 2]) {
            const directed = inForce(performanceMarks(sentences, 'RESTRAINED', chunk!.performance.pauses, [{ sentence, emotion: 'reflective' }]), 3);
            expect(directed.flatMap((f, i) => (f !== house[i] ? [i] : [])).every((i) => i === sentence)).toBe(true);
          }
        }
      }
    }
    expect(moments).toBeGreaterThan(1000);
  });

  it('plain narration with no turn gets nothing: expressive is the house style there', () => {
    order = 0;
    const plain = [block('7.1', 'The guild met on Tuesdays. It kept a ledger of every sale, every price and every name.')];
    expect(take(plain, 'EXPRESSIVE').rendered.text).toBe(take(plain, 'PLAIN').rendered.text);
  });

  it('a second deliberate moment fails the density check (never sent)', () => {
    const t = take(PROMISE(), 'EXPRESSIVE');
    expect(status(t, 'density')).toBe('PASS');
    const second: PerformanceMark = { sentence: 0, intent: { emotion: 'somber', delivery: null, intensity: 'LOW', pacing: 'NORMAL', vocalAction: null }, source: 'STRATEGY', reason: 'a second moment' };
    const rendered = v4.render(
      t.segments.map((s, i) => (i === 0 ? { ...s, intent: second.intent } : s)),
      'eleven_v4',
    );
    const sentences = PROMISE().map((b) => ({ text: b.text, blockKey: b.key, delivery: b.delivery, infoClass: b.infoClass, blockStart: true }));
    const checks = checkTake({ canonical: t.spokenText, forms: [], spoken: t.spokenText, spokenSentences: t.spokenSentences, rendered, marks: [second, ...t.prepared.marks], sentences, strategy: 'EXPRESSIVE', director: false, caps: v4.capabilities('eleven_v4') });
    expect(checks.find((c) => c.id === 'density')!.status).toBe('FAIL');
  });
});
