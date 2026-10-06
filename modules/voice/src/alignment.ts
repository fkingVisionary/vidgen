import type { NarrationAlignment, SpokenForm, TimedWord } from '@docengine/core';
import type { CharacterAlignment, RenderedNarration } from '@docengine/providers';
import { wordSpans, type TextSpan } from './text.ts';

/**
 * When each word of the script is heard in a take. The provider timestamps
 * the characters of the text it received — with or without the characters
 * of its markup, which providers differ on — and this maps them back through
 * the markup and the spoken forms to the canonical words: "1637" gets the
 * time of "sixteen thirty-seven". Markup is never matched to words (it is
 * blanked on both sides first). Times are never invented: a word whose
 * characters cannot be found is counted as unmatched, and a take without
 * timestamps has no alignment.
 */

export interface AlignInput {
  canonical: string;
  forms: readonly SpokenForm[];
  /** Each sentence's range in the canonical text and in the spoken text. */
  canonicalSentences: readonly TextSpan[];
  spokenSentences: readonly TextSpan[];
  rendered: Pick<RenderedNarration, 'text' | 'segments' | 'markup'>;
  characters: CharacterAlignment | null;
  mock: boolean;
}

/** The text with each range replaced by spaces of the same length (offsets are kept). */
function blank(text: string, ranges: readonly TextSpan[]): string {
  const units = text.split('');
  for (const r of ranges) for (let i = r.start; i < r.end; i++) units[i] = ' ';
  return units.join('');
}

/** Markup in the provider's text, if it kept any: the pieces that were sent, and any bracketed span the spoken text itself does not contain. */
function markupIn(providerText: string, pieces: readonly string[], spoken: string): TextSpan[] {
  const out: TextSpan[] = [];
  for (const piece of new Set(pieces)) {
    for (let at = providerText.indexOf(piece); at >= 0; at = providerText.indexOf(piece, at + piece.length)) out.push({ start: at, end: at + piece.length });
  }
  const said = spoken.toLowerCase();
  for (const m of providerText.matchAll(/\[[^[\]\n]*\]|<[^<>\n]*>/g)) if (!said.includes(m[0].toLowerCase())) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
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
    // Look a little ahead in b for the same character (skipping what b inserted, e.g. normalisation); blanked markup is no distance.
    let k = j;
    for (let skipped = 0; k < b.length && skipped < 8 && b[k]!.toLowerCase() !== a[i]!.toLowerCase(); k++) if (!/\s/.test(b[k]!)) skipped++;
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
  const pieces = input.rendered.markup.map((m) => input.rendered.text.slice(m.start, m.end));
  const sent = blank(input.rendered.text, input.rendered.markup);
  const toProvider = charMap(sent, blank(providerText, markupIn(providerText, pieces, sent)));
  // The provider's entry for each code unit of its text (an entry is usually one character).
  const entry: number[] = [];
  c.chars.forEach((ch, k) => {
    for (let i = 0; i < ch.length; i++) entry.push(k);
  });

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
      startMs = Math.min(startMs, c.startMs[entry[p]!]!);
      endMs = Math.max(endMs, c.endMs[entry[p]!]!);
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
