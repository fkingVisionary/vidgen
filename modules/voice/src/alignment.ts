import type { NarrationAlignment, SpokenForm, TimedWord } from '@docengine/core';
import type { CharacterAlignment, RenderedNarration } from '@docengine/providers';
import { wordSpans, type TextSpan } from './text.ts';

/**
 * When each word of the script is heard in a take. The provider timestamps
 * the characters of the text it received (spoken forms, markup and all);
 * this maps them back through the markup and the spoken forms to the
 * canonical words — "1637" gets the time of "sixteen thirty-seven". Times
 * are never invented: a word whose characters cannot be found is counted as
 * unmatched, and a take without timestamps has no alignment.
 */

export interface AlignInput {
  canonical: string;
  forms: readonly SpokenForm[];
  /** Each sentence's range in the canonical text and in the spoken text. */
  canonicalSentences: readonly TextSpan[];
  spokenSentences: readonly TextSpan[];
  rendered: Pick<RenderedNarration, 'text' | 'segments'>;
  characters: CharacterAlignment | null;
  mock: boolean;
}

/** For each index of `a`, the index of the same character in `b` (whitespace runs may differ), or -1. */
function charMap(a: string, b: string): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  if (a === b) {
    for (let i = 0; i < a.length; i++) map[i] = i;
    return map;
  }
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    if (/\s/.test(a[i]!)) {
      while (j < b.length && /\s/.test(b[j]!)) j++;
      continue;
    }
    // Look a little ahead in b for the same character (skipping what b inserted, e.g. normalisation).
    let k = j;
    while (k < b.length && k - j < 8 && b[k]!.toLowerCase() !== a[i]!.toLowerCase()) k++;
    if (k < b.length && b[k]!.toLowerCase() === a[i]!.toLowerCase()) {
      map[i] = k;
      j = k + 1;
    }
  }
  return map;
}

export function alignTake(input: AlignInput): NarrationAlignment | null {
  const c = input.characters;
  if (!c || !c.chars.length) return null;
  const providerText = c.chars.join('');
  const toProvider = charMap(input.rendered.text, providerText);

  /** A spoken-text offset → the rendered-text offset (through the sentence it is in). */
  const spokenToRendered = (offset: number): number => {
    const i = input.spokenSentences.findIndex((s) => offset >= s.start && offset < s.end);
    if (i === -1) return -1;
    const seg = input.rendered.segments[i];
    return seg ? seg.start + (offset - input.spokenSentences[i]!.start) : -1;
  };

  const words: TimedWord[] = [];
  let unmatched = 0;
  for (const w of wordSpans(input.canonical)) {
    // The word's range in the spoken text: the whole spoken form when it is (part of) one.
    const form = input.forms.find((f) => w.start < f.end && w.end > f.start);
    let sStart: number;
    let sEnd: number;
    if (form) {
      const shift = shiftBefore(input.forms, form.start);
      sStart = form.start + shift;
      sEnd = sStart + form.spoken.length;
    } else {
      const shift = shiftBefore(input.forms, w.start);
      sStart = w.start + shift;
      sEnd = w.end + shift;
    }
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = -1;
    for (let k = sStart; k < sEnd; k++) {
      const r = spokenToRendered(k);
      if (r < 0) continue;
      const p = toProvider[r]!;
      if (p < 0 || /\s/.test(providerText[p]!)) continue;
      startMs = Math.min(startMs, c.startMs[p]!);
      endMs = Math.max(endMs, c.endMs[p]!);
    }
    if (endMs < 0) {
      unmatched++;
      continue;
    }
    words.push({ word: w.word, start: w.start, end: w.end, startMs, endMs: Math.max(endMs, startMs) });
  }
  return { source: input.mock ? 'MOCK' : 'PROVIDER', words, characters: c, unmatchedWords: unmatched };
}

/** How far the spoken text has shifted from the canonical text before a canonical offset. */
function shiftBefore(forms: readonly SpokenForm[], offset: number): number {
  let shift = 0;
  for (const f of forms) if (f.end <= offset) shift += f.spoken.length - (f.end - f.start);
  return shift;
}
