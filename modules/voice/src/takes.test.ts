import { DEFAULT_DELIVERY, DEFAULT_VOICE_PROFILE_CONFIG, type ScriptDelivery } from '@docengine/core';
import { ElevenLabsVoiceProvider, MockVoiceProvider } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { alignTake } from './alignment.ts';
import { checkTake } from './checks.ts';
import { planChunks, type ChunkBlock } from './chunking.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';
import { takeQa } from './qa.ts';

/**
 * One take, end to end without a network: the canonical chunk, its spoken
 * forms, the performance pass (plain / restrained / over-directed), the
 * provider's markup, the checks that run before sending, and the timestamps
 * mapped back to the script's words.
 */

const v4 = new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: async () => new Response('{}') });
const mock = new MockVoiceProvider();

let order = 0;
const block = (key: string, text: string, d: Partial<ScriptDelivery> = {}): ChunkBlock => ({ id: `id-${key}`, key, text, delivery: { ...DEFAULT_DELIVERY, ...d }, speakerId: null, infoClass: 'DOCUMENTED', order: order++ });

function take(blocks: ChunkBlock[], strategy: 'PLAIN' | 'RESTRAINED' | 'DIRECTED', provider: typeof v4 | typeof mock = v4, model = 'eleven_v4') {
  // One chunk for the whole passage (chunking has its own tests).
  const [chunk] = planChunks([{ id: 's', key: 'SC01', blocks }], { minWords: 150, maxWords: 200 });
  const map = new Map<string, TakeBlock>(blocks.map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  return {
    chunk: chunk!,
    prepared: prepareTake({ chunk: chunk!, blocks: map, strategy, numberStyle: 'UK', aliases: [], phonemes: [], provider, model, settings: DEFAULT_VOICE_PROFILE_CONFIG.settings, context: { previousText: null, nextText: null }, seed: 7 }),
  };
}

const PROMISE = () => {
  order = 0;
  return [
    block('1.1', 'Nobody at this table has seen what he is buying.'),
    block('1.2', 'What changes hands is not a flower.', { emotion: 'CURIOUS' }),
    block('1.3', "It's a promise.", { energy: 'LOW', pace: 'SLOW' }),
  ];
};

describe('performance preparation (the canonical text never changes)', () => {
  it('restrained: directions only where the script marks a delivery, in plain words, at sentence starts', () => {
    const { prepared, chunk } = take(PROMISE(), 'RESTRAINED');
    expect(prepared.rendered.text).toBe("Nobody at this table has seen what he is buying. [curious] What changes hands is not a flower. [quiet] It's a promise.");
    expect(prepared.prepared.marks.map((m) => [m.sentence, m.intent.emotion, m.intent.delivery, m.source])).toEqual([
      [1, 'curious', null, 'SCRIPT'],
      [2, null, 'quiet', 'SCRIPT'],
    ]);
    expect(prepared.passed).toBe(true);
    expect(prepared.prepared.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['spoken-forms:PASS', 'words:PASS', 'sentences:PASS', 'boundaries:PASS', 'quotations:PASS', 'vocabulary:PASS', 'density:PASS', 'restraint:PASS']);
    // v4 has no speed setting: the slow pace is carried by the direction, the setting is unchanged.
    expect(prepared.prepared.settings.speed).toBe(1);
    expect(chunk.text).toBe("Nobody at this table has seen what he is buying.\nWhat changes hands is not a flower.\nIt's a promise.");
  });

  it('plain: no directions at all; over-directed: a direction on every sentence, flagged as a comparison only', () => {
    expect(take(PROMISE(), 'PLAIN').prepared.rendered.text).toBe("Nobody at this table has seen what he is buying. What changes hands is not a flower. It's a promise.");
    const loud = take(PROMISE(), 'DIRECTED').prepared;
    expect(loud.rendered.text).toBe("[dramatic, intense] Nobody at this table has seen what he is buying. [pause] [curious, intense] What changes hands is not a flower. [pause] [dramatic, quiet] It's a promise.");
    expect(loud.passed).toBe(true);
    expect(loud.prepared.checks.filter((c) => c.status === 'WARN').map((c) => c.id)).toEqual(['density', 'restraint']);
  });

  it('does not manufacture emotion: plain documentary narration gets no direction, and a marked passage is reset when plain narration follows', () => {
    order = 0;
    const plain = take([block('2.1', 'The guild met on Tuesdays. It kept a ledger of every sale, every price, every name.')], 'RESTRAINED').prepared;
    expect(plain.rendered.markup).toEqual([]);
    order = 0;
    const reset = take([block('3.1', 'And then the bidding stopped, all at once, in every tavern in town.', { emotion: 'TENSE' }), block('3.2', 'The records of the next weeks are mostly court papers and letters.')], 'RESTRAINED').prepared;
    expect(reset.rendered.text).toBe('[tense] And then the bidding stopped, all at once, in every tavern in town. [matter-of-fact] The records of the next weeks are mostly court papers and letters.');
  });

  it('sends spoken forms, records them, and still says exactly the script\'s words', () => {
    order = 0;
    const { prepared } = take([block('4.1', 'In 1637 one bulb sold for ƒ3,000.', { emotion: 'TENSE' })], 'RESTRAINED');
    expect(prepared.rendered.text).toBe('[tense] In sixteen thirty-seven one bulb sold for three thousand guilders.');
    expect(prepared.prepared.spokenForms.map((f) => f.display)).toEqual(['1637', 'ƒ3,000']);
    expect(prepared.passed).toBe(true);
  });

  it('renders SSML breaks only for a model that takes them, and reports the directions it cannot take', () => {
    order = 0;
    const blocks = [block('5.1', 'It begins.', { emotion: 'TENSE', pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }), block('5.2', 'Then it is over, quickly, for everyone who had bought in late.')];
    const v2 = take(blocks, 'RESTRAINED', v4, 'eleven_multilingual_v2').prepared;
    expect(v2.rendered.text).toBe('It begins. <break time="1.2s" /> Then it is over, quickly, for everyone who had bought in late.');
    expect(v2.prepared.unsupported[0]).toMatch(/direction "tense" \(the model takes no directions\)/);
    const tags = take(blocks, 'RESTRAINED').prepared;
    expect(tags.rendered.text).toBe('[tense] It begins. [pause] [matter-of-fact] Then it is over, quickly, for everyone who had bought in late.');
    expect(tags.rendered.text).not.toContain('<break');
  });
});

describe('performance checks catch a derived text that strays from the script', () => {
  const base = () => {
    const { prepared, chunk } = take(PROMISE(), 'RESTRAINED');
    const input = { canonical: chunk.text, forms: prepared.prepared.spokenForms, spoken: prepared.spokenText, spokenSentences: prepared.spokenSentences, marks: prepared.prepared.marks, sentences: [], strategy: 'RESTRAINED' as const, director: false };
    return { prepared, input };
  };
  const status = (checks: ReturnType<typeof checkTake>, id: string) => checks.find((c) => c.id === id)?.status;

  it('a changed, added or deleted word fails', () => {
    const { prepared, input } = base();
    const changed = { ...prepared.rendered, text: prepared.rendered.text.replace('flower', 'tulip') };
    expect(status(checkTake({ ...input, rendered: changed, sentences: [] }), 'words')).toBe('FAIL');
    const added = { ...prepared.rendered, text: `${prepared.rendered.text} Truly.` };
    expect(checkTake({ ...input, rendered: added, sentences: [] }).find((c) => c.id === 'words')!.detail).toMatch(/word 21: "truly" where the script has "\(none\)"/);
  });

  it('a direction in the middle of a sentence, inside a quotation, or carrying words of its own fails', () => {
    order = 0;
    const quoted = take([block('6.1', 'He wrote: "We have nothing left to sell." Then he signed it.', { emotion: 'SOMBER' })], 'RESTRAINED');
    const r = quoted.prepared.rendered;
    const inside = r.text.replace('"We have', '"We [whispers] have');
    const mid = { ...r, text: inside, markup: [...r.markup, { start: inside.indexOf('[whispers]'), end: inside.indexOf('[whispers]') + 10, kind: 'DIRECTION' as const }] };
    const checks = checkTake({ canonical: quoted.chunk.text, forms: [], spoken: quoted.prepared.spokenText, spokenSentences: quoted.prepared.spokenSentences, rendered: mid, marks: quoted.prepared.prepared.marks, sentences: [], strategy: 'RESTRAINED', director: false });
    expect(status(checks, 'boundaries')).toBe('FAIL');
    expect(status(checks, 'quotations')).toBe('FAIL');
    const dialogue = { ...r, text: r.text.replace('[somber]', '[He Says Hello]') };
    expect(status(checkTake({ canonical: quoted.chunk.text, forms: [], spoken: quoted.prepared.spokenText, spokenSentences: quoted.prepared.spokenSentences, rendered: dialogue, marks: [], sentences: [], strategy: 'RESTRAINED', director: false }), 'vocabulary')).toBe('FAIL');
  });

  it('a plain take with a direction fails; a spoken form that is not recorded fails', () => {
    const { prepared, input } = base();
    expect(status(checkTake({ ...input, strategy: 'PLAIN', rendered: prepared.rendered }), 'density')).toBe('FAIL');
    expect(status(checkTake({ ...input, spoken: input.spoken.replace('Nobody', 'No one'), rendered: prepared.rendered }), 'spoken-forms')).toBe('FAIL');
  });
});

describe('timestamps back to the script', () => {
  it('maps the provider character timestamps through markup and spoken forms to canonical words', async () => {
    order = 0;
    const { prepared, chunk } = take([block('7.1', 'In 1637 the price of one bulb reached ƒ3,000.', { emotion: 'TENSE' }), block('7.2', 'Then it fell.')], 'RESTRAINED', mock, 'mock');
    const r = await mock.generateNarration({ text: prepared.rendered.text, language: 'en', settings: { voiceId: 'mock-narrator-deep', model: 'mock', stability: 0.5, similarity: 0.75, style: 0, speed: 1 }, withTimestamps: true });
    const alignment = alignTake({ canonical: chunk.text, forms: prepared.prepared.spokenForms, canonicalSentences: chunk.sentences, spokenSentences: prepared.spokenSentences, rendered: prepared.rendered, characters: r.characters, mock: true })!;
    expect(alignment.unmatchedWords).toBe(0);
    expect(alignment.words.map((w) => w.word)).toEqual(['In', '1637', 'the', 'price', 'of', 'one', 'bulb', 'reached', 'ƒ3,000', 'Then', 'it', 'fell']);
    // "1637" takes as long as "sixteen thirty-seven": two spoken words.
    const year = alignment.words[1]!;
    const the = alignment.words[2]!;
    expect(year.endMs - year.startMs).toBeGreaterThan(the.endMs - the.startMs);
    expect(alignment.words.every((w, i) => i === 0 || w.startMs >= alignment.words[i - 1]!.startMs)).toBe(true);
    expect(chunk.text.slice(year.start, year.end)).toBe('1637');
    // QA of a good take: nothing blocking (the mock is flagged as mock).
    const qa = takeQa({ ref: '#1', canonical: chunk.text, durationMs: r.durationMs, hasAudio: true, alignment, forms: prepared.prepared.spokenForms, spokenText: prepared.spokenText, checks: prepared.prepared.checks, mock: true });
    expect(qa.map((f) => `${f.kind}:${f.severity}`)).toEqual(['MOCK_AUDIO:WARNING']);
  });

  it('flags a take with no timestamps, missing words, an implausible rate or long silences', () => {
    const base = { ref: '#2', canonical: 'One two three four five six seven eight nine ten.', hasAudio: true, forms: [], spokenText: 'One two three four five six seven eight nine ten.', checks: [], mock: false };
    expect(takeQa({ ...base, durationMs: 4000, alignment: null }).map((f) => `${f.kind}:${f.severity}`)).toEqual(['MISSING_ALIGNMENT:BLOCKING']);
    const words = (n: number, every: number, from = 0) => Array.from({ length: n }, (_, i) => ({ word: `w${i}`, start: 0, end: 1, startMs: from + i * every, endMs: from + i * every + every - 50 }));
    const truncated = { source: 'PROVIDER' as const, words: words(3, 400), characters: null, unmatchedWords: 7 };
    expect(takeQa({ ...base, durationMs: 1300, alignment: truncated }).map((f) => `${f.kind}:${f.severity}`)).toContain('ALIGNMENT_INCOMPLETE:BLOCKING');
    const rushed = { source: 'PROVIDER' as const, words: words(10, 90), characters: null, unmatchedWords: 0 };
    expect(takeQa({ ...base, durationMs: 1000, alignment: rushed }).map((f) => f.kind)).toEqual(['DURATION_ANOMALY']);
    const padded = { source: 'PROVIDER' as const, words: words(10, 400, 2000), characters: null, unmatchedWords: 0 };
    expect(takeQa({ ...base, durationMs: 9000, alignment: padded }).map((f) => f.detail)).toEqual(['2.0 s of silence before the first word', '3.0 s of silence after the last word']);
  });
});
