import { DEFAULT_DELIVERY, EARLIER_PERFORMANCE_RULES, type ProviderSettingValues, type ScriptDelivery, type VoiceSettingDescriptor } from '@docengine/core';
import { ElevenLabsVoiceProvider, MockVoiceProvider, renderSegments, sentVoiceSettings, type VoiceProvider } from '@docengine/providers';
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
    prepared: prepareTake({ chunk: chunk!, blocks: map, strategy, numberStyle: 'UK', aliases: [], phonemes: [], provider, model, settings: provider.normalizeSettings({}).settings, context: { previousText: null, nextText: null }, seed: 7 }),
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
    expect(prepared.prepared.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['spoken-forms:PASS', 'words:PASS', 'sentences:PASS', 'boundaries:PASS', 'quotations:PASS', 'vocabulary:PASS', 'markup:PASS', 'density:PASS', 'restraint:PASS']);
    // v4 has no speed setting: the slow pace is carried by the direction, the setting is unchanged; every setting is kept, two are sent.
    expect(prepared.prepared.settings.speed).toBe(1);
    expect(prepared.prepared.settings).toEqual({ stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 });
    expect(prepared.prepared.sent).toEqual({ stability: 0.5, similarity: 0.75 });
    expect(chunk.text).toBe("Nobody at this table has seen what he is buying.\nWhat changes hands is not a flower.\nIt's a promise.");
  });

  it('plain: no directions at all; over-directed: a direction on every sentence, flagged as a comparison only', () => {
    expect(take(PROMISE(), 'PLAIN').prepared.rendered.text).toBe("Nobody at this table has seen what he is buying. What changes hands is not a flower. It's a promise.");
    const loud = take(PROMISE(), 'DIRECTED').prepared;
    expect(loud.rendered.text).toBe("[dramatic, intense] Nobody at this table has seen what he is buying. [pause] [curious, intense] What changes hands is not a flower. [pause] [dramatic, quiet] It's a promise.");
    expect(loud.passed).toBe(true);
    // The high intensity is not in the words the model takes: reported, not dropped.
    expect(loud.prepared.checks.filter((c) => c.status === 'WARN').map((c) => c.id)).toEqual(['density', 'restraint', 'unsupported']);
    expect(loud.prepared.unsupported).toEqual(['high intensity on sentences 1, 2, 3 (not expressed: only the direction\'s words are sent)']);
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

describe("provider settings: every one kept, sent as the model takes them, the chunk's pace on the speed setting", () => {
  /** One slow (or fast) chunk of plain narration: no direction carries the pace. */
  const paced = (pace: 'SLOW' | 'FAST', provider: Pick<VoiceProvider, 'render' | 'capabilities' | 'settings' | 'sentSettings'>, model: string, settings: ProviderSettingValues, strategy: 'PLAIN' | 'RESTRAINED' = 'RESTRAINED', rules = EARLIER_PERFORMANCE_RULES) => {
    order = 0;
    const blocks = [block('12.1', 'The guild met on Tuesdays, in the back room of the tavern.')];
    const [chunk] = planChunks([{ id: 's', key: 'SC01', blocks }], { minWords: 150, maxWords: 200 });
    const map = new Map<string, TakeBlock>(blocks.map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
    return prepareTake({ chunk: { ...chunk!, performance: { ...chunk!.performance, pace } }, blocks: map, strategy, numberStyle: 'UK', aliases: [], phonemes: [], provider, model, settings, context: { previousText: null, nextText: null }, seed: 7, rules }).prepared;
  };
  const defaults = v4.normalizeSettings({}).settings;

  it('eleven v4 keeps all five settings and is sent stability and similarity; the pace is left to the text', () => {
    const p = paced('SLOW', v4, 'eleven_v4', defaults);
    expect(p.settings).toEqual({ stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 });
    expect(p.sent).toEqual({ stability: 0.5, similarity: 0.75 });
    expect(p.unsupported).toEqual(['slow pace: the model has no speed setting (left to the text)']);
    // A plain take says nothing about pace, as before.
    expect(paced('SLOW', v4, 'eleven_v4', defaults, 'PLAIN').unsupported).toEqual([]);
  });

  it("multilingual v2 takes a speed: a slow chunk is 0.94 of it in the settings and in what is sent; the factor is the rules'", () => {
    const p = paced('SLOW', v4, 'eleven_multilingual_v2', defaults);
    expect(p.settings).toEqual({ stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 0.94 });
    expect(p.sent).toEqual(p.settings);
    expect(p.unsupported).toEqual([]);
    expect(paced('FAST', v4, 'eleven_multilingual_v2', defaults).settings.speed).toBe(1.06);
    expect(paced('SLOW', v4, 'eleven_multilingual_v2', defaults, 'RESTRAINED', { ...EARLIER_PERFORMANCE_RULES, paceSpeed: { SLOW: 0.9, FAST: 1.1 } }).sent?.speed).toBe(0.9);
    // Rounded to 0.01 (0.9 × 0.94 = 0.846) and kept within the setting's range (0.7–1.2).
    expect(paced('SLOW', v4, 'eleven_multilingual_v2', { ...defaults, speed: 0.9 }).settings.speed).toBe(0.85);
    expect(paced('SLOW', v4, 'eleven_multilingual_v2', { ...defaults, speed: 0.73 }).settings.speed).toBe(0.7);
    expect(paced('FAST', v4, 'eleven_multilingual_v2', { ...defaults, speed: 1.17 }).settings.speed).toBe(1.2);
  });

  it("another provider's settings: its speed setting (tempo) takes the pace only where the model is sent it; nothing else is touched", () => {
    const FAKE: VoiceSettingDescriptor[] = [
      { key: 'warmth', label: 'Warmth', help: '', kind: 'NUMBER', default: 0.3, min: 0, max: 1, models: null, overridable: true },
      { key: 'breathy', label: 'Breathy', help: '', kind: 'BOOLEAN', default: false, models: null, overridable: true },
      { key: 'tempo', label: 'Tempo', help: '', kind: 'NUMBER', default: 1, min: 0.8, max: 1.1, models: ['paced'], overridable: true, role: 'SPEED' },
    ];
    const fake = { settings: FAKE, sentSettings: (s: ProviderSettingValues, m: string) => sentVoiceSettings(FAKE, s, m), capabilities: (m: string) => mock.capabilities(m), render: (segments: Parameters<VoiceProvider['render']>[0], m: string) => renderSegments(segments, mock.capabilities(m)) };
    const settings = { warmth: 0.3, breathy: false, tempo: 1 };
    const sent = paced('SLOW', fake, 'paced', settings);
    expect(sent.settings).toEqual({ warmth: 0.3, breathy: false, tempo: 0.94 });
    expect(sent.sent).toEqual({ warmth: 0.3, breathy: false, tempo: 0.94 });
    expect(sent.unsupported).toEqual([]);
    const notSent = paced('SLOW', fake, 'flat', settings);
    expect(notSent.settings).toEqual(settings);
    expect(notSent.sent).toEqual({ warmth: 0.3, breathy: false });
    expect(notSent.unsupported).toEqual(['slow pace: the model has no speed setting (left to the text)']);
    // Within tempo's own range, not another provider's.
    expect(paced('FAST', fake, 'paced', { ...settings, tempo: 1.1 }).settings.tempo).toBe(1.1);
  });
});

describe('performance checks catch a derived text that strays from the script', () => {
  const base = () => {
    const { prepared, chunk } = take(PROMISE(), 'RESTRAINED');
    const input = { canonical: chunk.text, forms: prepared.prepared.spokenForms, spoken: prepared.spokenText, spokenSentences: prepared.spokenSentences, marks: prepared.prepared.marks, sentences: [], strategy: 'RESTRAINED' as const, director: false, caps: v4.capabilities('eleven_v4') };
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
    const caps = v4.capabilities('eleven_v4');
    const checks = checkTake({ canonical: quoted.chunk.text, forms: [], spoken: quoted.prepared.spokenText, spokenSentences: quoted.prepared.spokenSentences, rendered: mid, marks: quoted.prepared.prepared.marks, sentences: [], strategy: 'RESTRAINED', director: false, caps });
    expect(status(checks, 'boundaries')).toBe('FAIL');
    expect(status(checks, 'quotations')).toBe('FAIL');
    const dialogue = { ...r, text: r.text.replace('[somber]', '[He Says Hello]') };
    expect(status(checkTake({ canonical: quoted.chunk.text, forms: [], spoken: quoted.prepared.spokenText, spokenSentences: quoted.prepared.spokenSentences, rendered: dialogue, marks: [], sentences: [], strategy: 'RESTRAINED', director: false, caps }), 'vocabulary')).toBe('FAIL');
  });

  it('a plain take with a direction fails; a spoken form that is not recorded fails', () => {
    const { prepared, input } = base();
    expect(status(checkTake({ ...input, strategy: 'PLAIN', rendered: prepared.rendered }), 'density')).toBe('FAIL');
    expect(status(checkTake({ ...input, spoken: input.spoken.replace('Nobody', 'No one'), rendered: prepared.rendered }), 'spoken-forms')).toBe('FAIL');
  });

  it('only markup the model takes: an SSML break fails for v4 (it takes no SSML) and passes for v2; a pause tag fails for v2', () => {
    order = 0;
    const blocks = [block('8.1', 'It begins.', { pauseAfter: { length: 'MEDIUM', reason: 'TRANSITION' } }), block('8.2', 'Then it is over, quickly, for everyone who had bought in late.')];
    const tags = take(blocks, 'PLAIN').prepared;
    const v2 = take(blocks, 'PLAIN', v4, 'eleven_multilingual_v2').prepared;
    const input = (p: typeof tags, model: string) => ({ canonical: tags.spokenText, forms: [], spoken: p.spokenText, spokenSentences: p.spokenSentences, marks: [], sentences: [], strategy: 'PLAIN' as const, director: false, caps: v4.capabilities(model) });
    expect(status(tags.prepared.checks, 'markup')).toBe('PASS');
    expect(status(v2.prepared.checks, 'markup')).toBe('PASS');
    // The v2 rendering (an SSML break) sent to v4, and the v4 rendering (a pause tag) sent to v2.
    const ssmlToV4 = checkTake({ ...input(v2, 'eleven_v4'), rendered: v2.rendered });
    expect(status(ssmlToV4, 'markup')).toBe('FAIL');
    expect(ssmlToV4.find((c) => c.id === 'markup')!.detail).toMatch(/<break time="1\.2s" \/> \(it takes audio tags\)/);
    expect(status(checkTake({ ...input(v2, 'eleven_multilingual_v2'), rendered: v2.rendered }), 'markup')).toBe('PASS');
    expect(status(checkTake({ ...input(tags, 'eleven_multilingual_v2'), rendered: tags.rendered }), 'markup')).toBe('FAIL');
  });

  it('warns about a forward slash for a tag model (it may read the text between two slashes as phonemes); fractions are spoken as words', () => {
    order = 0;
    const fraction = take([block('9.1', 'About 1/3 of the buyers never paid, and 2 1/2 thousand guilders went unpaid.')], 'PLAIN').prepared;
    expect(fraction.rendered.text).toBe('About one third of the buyers never paid, and two and a half thousand guilders went unpaid.');
    expect(fraction.prepared.checks.map((c) => c.id)).not.toContain('slashes');
    order = 0;
    const slash = take([block('9.2', 'The market ran 24/7 that winter, or so the pamphlets claimed.')], 'PLAIN').prepared;
    expect(status(slash.prepared.checks, 'slashes')).toBe('WARN');
    expect(slash.passed).toBe(true);
  });

  it('warns when a direction heightens a sentence the script marks uncertain, reconstructed or fictional', () => {
    order = 0;
    const uncertain = { ...block('10.1', 'Some said a single bulb once bought a brewery outright.', { emotion: 'EXCITED' }), infoClass: 'UNCERTAIN' as const };
    const restrained = take([uncertain], 'RESTRAINED').prepared;
    expect(restrained.prepared.checks.find((c) => c.id === 'info-class')).toMatchObject({ status: 'WARN', detail: 'sentence 1 (uncertain): excited' });
    order = 0;
    const documented = take([block('10.2', 'The guild records list every sale that winter.', { emotion: 'CURIOUS' })], 'DIRECTED').prepared;
    expect(documented.prepared.checks.map((c) => c.id)).not.toContain('info-class');
    // A direction carries forward: the excitement marked on the documented block is in force over the uncertain one.
    order = 0;
    const excited = { emotion: 'EXCITED' } as const;
    const carried = take([block('10.3', 'The price doubled in a week, and then it doubled again.', excited), { ...block('10.4', 'Some said a single bulb once bought a brewery outright.', excited), infoClass: 'UNCERTAIN' as const }], 'RESTRAINED').prepared;
    expect(carried.prepared.marks.map((m) => m.sentence)).toEqual([0]);
    expect(carried.prepared.checks.find((c) => c.id === 'info-class')).toMatchObject({ status: 'WARN', detail: 'sentence 2 (uncertain): excited (carried from sentence 1)' });
    expect(carried.passed).toBe(true);
  });

  it('reports the script\'s emphasis as not expressed, never silently dropped (stress would need the words changed)', () => {
    order = 0;
    const stressed = take([block('11.1', 'In 1637 nobody paid. Nobody.', { emphasis: [{ text: 'nobody', level: 'STRONG' }, { text: '1637', level: 'LIGHT' }] })], 'PLAIN');
    expect(stressed.prepared.segments[0]!.emphasis).toEqual([
      { start: 3, end: 23, level: 'LIGHT' },
      { start: 24, end: 30, level: 'STRONG' },
    ]);
    expect(stressed.prepared.segments[0]!.text.slice(3, 23)).toBe('sixteen thirty-seven');
    expect(stressed.prepared.prepared.unsupported).toEqual([
      'sentence 1: light stress on "sixteen thirty-seven" (not expressed: the words are sent as written)',
      'sentence 1: strong stress on "nobody" (not expressed: the words are sent as written)',
    ]);
    expect(stressed.prepared.rendered.text).toBe('In sixteen thirty-seven nobody paid. Nobody.');
    // Stress on part of a figure is stress on all of it as said.
    order = 0;
    const part = take([block('11.2', 'In 1637 nobody paid.', { emphasis: [{ text: '16', level: 'LIGHT' }] })], 'PLAIN');
    expect(part.prepared.segments[0]!.emphasis).toEqual([{ start: 3, end: 23, level: 'LIGHT' }]);
    expect(status(stressed.prepared.prepared.checks, 'unsupported')).toBe('WARN');
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
