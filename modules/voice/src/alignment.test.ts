import { DEFAULT_DELIVERY, type ScriptDelivery } from '@docengine/core';
import { ElevenLabsVoiceProvider, stripMarkup, type CharacterAlignment } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { alignTake } from './alignment.ts';
import { planChunks, type ChunkBlock } from './chunking.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';

/**
 * Timestamps back to the script's words, whatever the provider's alignment
 * covers: providers differ on whether the characters of their audio tags are
 * in it. Either way every word gets the time of its own characters.
 */

const v4 = new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: async () => new Response('{}') });

let order = 0;
const block = (key: string, text: string, d: Partial<ScriptDelivery> = {}): ChunkBlock => ({ id: `id-${key}`, key, text, delivery: { ...DEFAULT_DELIVERY, ...d }, speakerId: null, infoClass: 'DOCUMENTED', order: order++ });

function prepared(blocks: ChunkBlock[]) {
  const [chunk] = planChunks([{ id: 's', key: 'SC01', blocks }], { minWords: 150, maxWords: 200 });
  const map = new Map<string, TakeBlock>(blocks.map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  const take = prepareTake({ chunk: chunk!, blocks: map, strategy: 'RESTRAINED', numberStyle: 'UK', aliases: [], phonemes: [], provider: v4, model: 'eleven_v4', settings: v4.normalizeSettings({}).settings, context: { previousText: null, nextText: null }, seed: 7 });
  return { chunk: chunk!, take };
}

/** Character timestamps as a provider would return them for `text`: 50 ms per letter, whitespace and markup (if kept) taking no time. */
function timestamps(text: string, markup: readonly string[] = []): CharacterAlignment {
  const chars: string[] = [];
  const startMs: number[] = [];
  const endMs: number[] = [];
  let clock = 0;
  for (let i = 0; i < text.length; ) {
    const piece = markup.find((m) => text.startsWith(m, i));
    if (piece) {
      for (const ch of piece) chars.push(ch), startMs.push(clock), endMs.push(clock);
      i += piece.length;
      continue;
    }
    const ms = /\s/.test(text[i]!) ? 0 : 50;
    chars.push(text[i]!), startMs.push(clock), endMs.push(clock + ms);
    clock += ms;
    i++;
  }
  return { chars, startMs, endMs };
}

/** When the provider says the first character of `word` (in its own text) starts. */
const heard = (a: CharacterAlignment, word: string) => a.startMs[a.chars.join('').indexOf(word)]!;

const PROMISE = () => {
  order = 0;
  return [block('1.1', 'Nobody at this table has seen what he is buying.', { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }), block('1.2', 'What changes hands is not a flower.', { emotion: 'CURIOUS' }), block('1.3', "In 1637 it's a promise.", { energy: 'LOW', pace: 'SLOW' })];
};

describe('alignment with and without the markup characters', () => {
  const { chunk, take } = prepared(PROMISE());
  const align = (characters: CharacterAlignment) =>
    alignTake({ canonical: chunk.text, forms: take.prepared.spokenForms, canonicalSentences: chunk.sentences, spokenSentences: take.spokenSentences, rendered: take.rendered, characters, mock: false })!;
  const pieces = take.rendered.markup.map((m) => take.rendered.text.slice(m.start, m.end));

  it('the take carries tags and a pause (what the test is about)', () => {
    expect(take.rendered.text).toBe("Nobody at this table has seen what he is buying. [pause] [curious] What changes hands is not a flower. [quiet] In sixteen thirty-seven it's a promise.");
  });

  it('maps a tag-free alignment: every word gets its own characters, none is unmatched', () => {
    const tagFree = stripMarkup(take.rendered).replace(/\n/g, ' ');
    const a = timestamps(tagFree);
    const result = align(a);
    expect(result.unmatchedWords).toBe(0);
    const at = (w: string) => result.words.find((x) => x.word === w)!;
    expect(at('What').startMs).toBe(heard(a, 'What'));
    expect(at('changes').startMs).toBe(heard(a, 'changes'));
    expect(at('1637')).toMatchObject({ startMs: heard(a, 'sixteen'), endMs: heard(a, " it's") });
    expect(at('promise').startMs).toBe(heard(a, 'promise'));
  });

  it('maps an alignment that keeps the tags the same way', () => {
    const a = timestamps(take.rendered.text, pieces);
    const result = align(a);
    expect(result.unmatchedWords).toBe(0);
    expect(result.words.find((x) => x.word === 'What')!.startMs).toBe(heard(a, 'What'));
    // Same words, same order, same clock as the tag-free provider (the tags take no time).
    const free = align(timestamps(stripMarkup(take.rendered).replace(/\n/g, ' ')));
    expect(result.words.map((w) => [w.word, w.startMs])).toEqual(free.words.map((w) => [w.word, w.startMs]));
  });

  it('maps an alignment whose tags the provider wrote differently', () => {
    const altered = take.rendered.text.replace('[curious]', '[Curious]').replace('[pause]', '[ pause ]');
    const a = timestamps(altered, ['[Curious]', '[ pause ]', '[quiet]']);
    const result = align(a);
    expect(result.unmatchedWords).toBe(0);
    expect(result.words.find((x) => x.word === 'What')!.startMs).toBe(heard(a, 'What'));
  });

  it('keeps its place when the provider writes a character its own way next to kept markup ("…" as "...")', () => {
    order = 0;
    const own = prepared([block('3.1', 'Nobody at this table has seen what he is buying…', { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } }), block('3.2', 'What changes hands is not a flower.', { emotion: 'CURIOUS' })]);
    expect(own.take.rendered.text).toBe('Nobody at this table has seen what he is buying… [pause] [curious] What changes hands is not a flower.');
    const kept = own.take.rendered.markup.map((m) => own.take.rendered.text.slice(m.start, m.end));
    const a = timestamps(own.take.rendered.text.replace('…', '...'), kept);
    const result = alignTake({ canonical: own.chunk.text, forms: [], canonicalSentences: own.chunk.sentences, spokenSentences: own.take.spokenSentences, rendered: own.take.rendered, characters: a, mock: false })!;
    expect(result.unmatchedWords).toBe(0);
    expect(result.words.find((x) => x.word === 'What')!.startMs).toBe(heard(a, 'What'));
    expect(result.words.find((x) => x.word === 'flower')!.startMs).toBe(heard(a, 'flower'));
  });

  it('keeps brackets that are the script\'s own words', () => {
    order = 0;
    const own = prepared([block('2.1', 'The clerk wrote [sic] beside the price, and nothing more.')]);
    const a = timestamps(own.take.rendered.text);
    const result = alignTake({ canonical: own.chunk.text, forms: [], canonicalSentences: own.chunk.sentences, spokenSentences: own.take.spokenSentences, rendered: own.take.rendered, characters: a, mock: false })!;
    expect(result.unmatchedWords).toBe(0);
    expect(result.words.find((x) => x.word === 'sic')!.startMs).toBe(heard(a, 'sic'));
  });
});
