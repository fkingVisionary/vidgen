import { createHash } from 'node:crypto';

/**
 * Text helpers for narration: sentences with exact character offsets (so a
 * chunk is always a verbatim slice of the script), words, and hashes.
 */

export interface TextSpan {
  start: number;
  end: number;
}

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(
  'mr mrs ms dr st mt jr sr prof gen col capt lt sgt rev hon vs etc eg ie approx c ca no vol pp p fig ed eds inc ltd co corp dept est fl cf al'.split(' '),
);
const CLOSERS = `"'”’)]`;

/**
 * Sentences of a text, as character ranges (trailing whitespace excluded).
 * A sentence ends at . ! ? or an ellipsis (with any closing quote or
 * bracket) followed by whitespace and a capital, a digit or an opening quote
 * — not after an abbreviation or an initial, and not before a lower-case
 * continuation. A line break always ends one.
 */
export function sentenceSpans(text: string): TextSpan[] {
  const out: TextSpan[] = [];
  let start = skipSpace(text, 0);
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(out, text, start, i);
      start = skipSpace(text, i + 1);
      i = start;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let end = i + 1;
      while (end < text.length && (text[end] === '.' || text[end] === '!' || text[end] === '?' || text[end] === '…')) end++;
      while (end < text.length && CLOSERS.includes(text[end]!)) end++;
      const next = skipSpace(text, end);
      if (next > end && next < text.length && isSentenceEnd(text, i, end, next)) {
        push(out, text, start, end);
        start = next;
        i = next;
        continue;
      }
      i = end;
      continue;
    }
    i++;
  }
  push(out, text, start, text.length);
  return out;
}

function isSentenceEnd(text: string, at: number, end: number, next: number): boolean {
  const following = text[next]!;
  // A lower-case continuation ("… and then", "e.g. the") is the same sentence.
  if (/\p{Ll}/u.test(following)) return false;
  if (text[at] === '.' && end === at + 1) {
    const word = /([\p{L}]+)$/u.exec(text.slice(Math.max(0, at - 12), at))?.[1] ?? '';
    // An initial ("J. P. Coen") or an abbreviation ("Dr. Brennan", "c. 1637").
    if (word.length === 1 && /\p{Lu}/u.test(word)) return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  }
  return /[\p{Lu}\p{N}"'“‘(\[]/u.test(following);
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function push(out: TextSpan[], text: string, start: number, end: number) {
  let e = end;
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  if (e > start) out.push({ start, end: e });
}

/** Words as a narrator says them: "3,000", "1.5" and "Coen's" are one word each. */
const WORD = /[\p{L}\p{N}]+(?:[.,'’\-][\p{L}\p{N}]+)*/gu;

export function wordSpans(text: string): (TextSpan & { word: string })[] {
  return [...text.matchAll(WORD)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
}

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** The words of a text in lower case, for comparing two texts word by word. */
export function wordList(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.toLowerCase().replace(/’/g, "'"));
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** True when a sentence asks (ends with a question mark, before any closing quote). */
export const isQuestion = (s: string) => /\?["'”’)\]]*$/.test(s.trim());
