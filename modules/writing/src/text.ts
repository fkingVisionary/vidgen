import { sentences, wordTokens } from '@docengine/story/shared';

/**
 * The narration as the diagnostics read it: what the narrator says, block by
 * block, with recorded quotations and cast speech left out (they are the
 * record's words, not the house's). Pure and deterministic.
 */

/** A block of narration, as the writing engine needs it (a script block has more). */
export interface NarrationBlock {
  /** "3.4" */
  key: string;
  section: number;
  text: string;
  infoClass: string;
  /** Cast id when a cast member speaks; null for the narrator. */
  speakerId: string | null;
  claimKeys: readonly string[];
  /** The picture the block asks for (to tell narration that duplicates it). */
  visual?: { note: string; mustShow: readonly { detail: string }[] } | null;
}

export interface Sentence {
  text: string;
  words: number;
  block: string;
  section: number;
  /** Index of the sentence within its block. */
  index: number;
  /** The block's last sentence. */
  last: boolean;
}

/**
 * Quotations masked: their words are not the narrator's. A quotation that
 * ends its sentence ("…ruined." And then…) keeps a full stop after the mask,
 * so the narrator's next sentence stays a sentence of its own.
 */
export const maskQuotes = (text: string) =>
  text.replace(/["“]([^"”]*)["”]/g, (quote: string, inner: string, at: number) =>
    /[.!?…]\s*$/.test(inner) && /^(?:\s*$|\s+["“]?\p{Lu})/u.test(text.slice(at + quote.length)) ? '"…".' : '"…"',
  );

export const narrationOnly = (blocks: readonly NarrationBlock[]) => blocks.filter((b) => !b.speakerId);

/** The narrator's sentences, in order, with their place. */
export function narratorSentences(blocks: readonly NarrationBlock[]): Sentence[] {
  const out: Sentence[] = [];
  for (const b of narrationOnly(blocks)) {
    const ss = sentences(maskQuotes(b.text));
    ss.forEach((s, i) => out.push({ text: s, words: wordTokens(s).length, block: b.key, section: b.section, index: i, last: i === ss.length - 1 }));
  }
  return out;
}

export const countWords = (text: string) => wordTokens(text).length;

export const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Sentences of a single text (quotations masked). */
export const sentencesOf = (text: string) => sentences(maskQuotes(text));

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000, dozen: 12, half: 0.5, quarter: 0.25, third: 1 / 3,
  twice: 2, double: 2, triple: 3, once: 1,
};

/**
 * Every quantity a text states, as numbers: digits ("1,200" → 1200, "1630s"
 * → 1630) and number words ("twelve hundred" → 12 and 100 — counted as the
 * words said, so a change of form is visible). Used to tell that a rewording
 * kept every figure it was given.
 */
export function quantities(text: string): number[] {
  const out: number[] = [];
  for (const m of maskQuotes(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, '')));
  for (const w of wordTokens(text)) if (w in NUMBER_WORDS && w !== 'once' && w !== 'one') out.push(NUMBER_WORDS[w]!);
  return out.sort((a, b) => a - b);
}

/** Quantities in `a` that `b` no longer says (a multiset difference). */
export function quantitiesLost(a: string, b: string): number[] {
  const left = [...quantities(b)];
  const lost: number[] = [];
  for (const q of quantities(a)) {
    const i = left.indexOf(q);
    if (i >= 0) left.splice(i, 1);
    else lost.push(q);
  }
  return lost;
}

/** Quantities in `b` that `a` did not say. */
export const quantitiesAdded = (a: string, b: string) => quantitiesLost(b, a);
