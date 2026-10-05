import { DEFAULT_DELIVERY, type NarrationAlignment, type ScriptVisual } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { assemble, formatClock, parseClock, whatIsSaidAt, type AssemblyBlock, type AssemblyChunk } from './assembly.ts';
import { detectTerms, proposeEntries, rulesFor, unresolvedIn } from './pronunciation.ts';
import { wordSpans } from './text.ts';

/** Assembly on the takes' measured clock, the narration timeline, and the pronunciation list. */

const VISUAL: ScriptVisual = { intent: 'CINEMATIC_RECONSTRUCTION', mustShow: [{ detail: 'a tavern auction', claimKeys: ['C1'] }], mustAvoid: [], priority: 'HIGH', fictional: false, note: '' };
const blocks = new Map<string, AssemblyBlock>(['1.1', '1.2', '2.1'].map((k) => [k, { id: `b${k}`, key: k, delivery: { ...DEFAULT_DELIVERY, emotion: k === '1.2' ? 'TENSE' : 'NEUTRAL' }, visual: VISUAL }]));

/** A take whose words are evenly spaced, with 200 ms of silence at each end. */
function take(id: string, text: string, msPerWord = 400): AssemblyChunk['take'] {
  const words = wordSpans(text).map((w, i) => ({ word: w.word, start: w.start, end: w.end, startMs: 200 + i * msPerWord, endMs: 200 + i * msPerWord + msPerWord - 40 }));
  const alignment: NarrationAlignment = { source: 'PROVIDER', words, characters: null, unmatchedWords: 0 };
  return { id, generation: 1, durationMs: 400 + words.length * msPerWord, alignment };
}

function chunk(index: number, sectionKey: string, parts: [string, string][], over: Partial<AssemblyChunk> = {}): AssemblyChunk {
  const text = parts.map((p) => p[1]).join('\n');
  return {
    id: `c${index}`,
    index,
    sectionKey,
    blockKeys: parts.map((p) => p[0]),
    spans: parts.map(([k, t]) => ({ blockId: `b${k}`, blockKey: k, start: 0, end: t.length })),
    text,
    boundary: 'PARAGRAPH',
    pauses: { before: 'NONE', after: 'NONE', inside: [] },
    take: take(`g${index}`, text),
    ...over,
  };
}

describe('assembled narration', () => {
  const a = chunk(0, 'SC01', [['1.1', 'The bulbs arrive.'], ['1.2', 'Prices climb.']], { pauses: { before: 'NONE', after: 'MEDIUM', inside: [] }, boundary: 'PAUSE' });
  const b = chunk(1, 'SC01', [['1.2', 'Nobody sells.']], { boundary: 'SECTION_END' });
  const c = chunk(2, 'SC02', [['2.1', 'The courts step in.']]);

  it('orders takes on their measured clock, with the scripted pauses less the silence the clips already hold', () => {
    const r = assemble([c, a, b], blocks);
    expect(r.findings).toEqual([]);
    expect(r.entries.map((e) => [e.chunkIndex, e.startMs, e.endMs, e.gapAfterMs])).toEqual([
      // a: 5 words → 2400 ms; MEDIUM pause 1200 ms − 240 ms already at its end − 200 ms at the start of b = 760 ms.
      [0, 0, 2400, 760],
      // b: 2 words → 1200 ms; a new section: 1000 ms − 240 − 200 = 560 ms.
      [1, 3160, 4360, 560],
      [2, 4920, 6920, 0],
    ]);
    expect(r.totalDurationMs).toBe(6920);
  });

  it('builds the timeline: block parts, words and visual hints, on the assembled clock', () => {
    const r = assemble([a, b, c], blocks);
    expect(r.timeline.map((t) => [t.scriptBlock.key, t.audioChunk.index, t.startMs, t.endMs, t.text])).toEqual([
      ['1.1', 0, 200, 1360, 'The bulbs arrive.'],
      ['1.2', 0, 1400, 2160, 'Prices climb.'],
      ['1.2', 1, 3360, 4120, 'Nobody sells.'],
      ['2.1', 2, 5120, 6680, 'The courts step in.'],
    ]);
    expect(r.timeline[1]).toMatchObject({ performance: { emotion: 'TENSE' }, visualHints: { intent: 'CINEMATIC_RECONSTRUCTION', priority: 'HIGH', mustShow: ['a tavern auction'], fictional: false } });
    // "What is being said at 00:03.5?"
    const at = whatIsSaidAt(r.timeline, parseClock('00:03.5')!)!;
    expect(at.entry.scriptBlock.key).toBe('1.2');
    expect(at.word?.word).toBe('Nobody');
    expect(whatIsSaidAt(r.timeline, parseClock('0:02.9')!)!.between).toBe(true);
    expect(formatClock(163_400)).toBe('02:43.4');
    expect(parseClock('02:43')).toBe(163_000);
    expect(parseClock('nonsense')).toBeNull();
  });

  it('reports duplicate and missing chunks, and leaves out chunks with no take', () => {
    const dup = assemble([a, { ...b, index: 0 }, c], blocks);
    expect(dup.findings.map((f) => `${f.kind} ${f.ref}`)).toEqual(['DUPLICATE_CHUNK #1', 'MISSING_CHUNK #2']);
    const noTake = assemble([a, { ...b, take: null }, c], blocks);
    expect(noTake.entries.map((e) => e.chunkIndex)).toEqual([0, 2]);
  });
});

describe('pronunciation review list', () => {
  const text = 'The VOC traded from Amsterdam. In Haarlem, Jan van Goyen bought bulbs; later Pieter Bol sold them in Alkmaar. Most people never saw one.';

  it('finds foreign spellings, names with particles and abbreviations, not every capitalised word', () => {
    expect(detectTerms(text).map((t) => `${t.term}:${t.kind}`)).toEqual(['VOC:ABBREVIATION', 'Haarlem:FOREIGN', 'Jan van Goyen:NAME', 'Alkmaar:FOREIGN']);
  });

  it('starts from the script notes (editor-confirmed ones approved), adds detected terms as pending, never overwrites a decision', () => {
    const notes = [
      { term: 'Haarlem', respelling: 'HAR-lem', ipa: 'ˈɦaːrlɛm', language: 'Dutch', confidence: 'HIGH' as const, note: '', needsReview: false, source: 'EDITOR' as const },
      { term: 'Pieter Bol', respelling: 'PEE-ter BOL', ipa: null, language: 'Dutch', confidence: 'MEDIUM' as const, note: '', needsReview: true, source: 'MODEL' as const },
    ];
    const entries = proposeEntries(text, notes, new Set(['VOC']));
    expect(entries.map((e) => [e.term, e.status, e.method, e.source])).toEqual([
      ['Haarlem', 'APPROVED', 'IPA', 'SCRIPT'],
      ['Pieter Bol', 'PENDING', 'DEFAULT', 'SCRIPT'],
      ['Jan van Goyen', 'PENDING', 'DEFAULT', 'DETECTED'],
      ['Alkmaar', 'PENDING', 'DEFAULT', 'DETECTED'],
    ]);
    expect(entries[1]!.hint).toBe('PEE-ter BOL · Dutch');
  });

  it('applies only approved rules: aliases spoken by the engine, phonemes sent to the provider; lists what is unresolved', () => {
    const lexicon = [
      { term: 'VOC', method: 'ALIAS' as const, pronunciation: 'V O C', status: 'APPROVED' as const },
      { term: 'Haarlem', method: 'IPA' as const, pronunciation: 'ˈɦaːrlɛm', status: 'APPROVED' as const },
      { term: 'Alkmaar', method: 'IPA' as const, pronunciation: 'ˈɑlkmaːr', status: 'PENDING' as const },
      { term: 'Leiden', method: 'IPA' as const, pronunciation: 'ˈlɛidə(n)', status: 'APPROVED' as const },
    ];
    expect(rulesFor(text, lexicon)).toEqual({ aliases: [{ term: 'VOC', alias: 'V O C' }], phonemes: [{ term: 'Haarlem', method: 'IPA', pronunciation: 'ˈɦaːrlɛm' }] });
    expect(unresolvedIn(text, lexicon)).toEqual(['Alkmaar']);
  });
});
