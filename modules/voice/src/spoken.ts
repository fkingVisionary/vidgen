import type { SpokenForm, SpokenFormKind } from '@docengine/core';

/**
 * Spoken forms: what a narrator says for what the script writes. The script
 * keeps "1637" and "ƒ3,000" (that is what the research and the subtitles
 * need); the voice is sent "sixteen thirty-seven" and "three thousand
 * guilders". Every replacement is recorded with its range in the canonical
 * text, so it can be reviewed, verified before sending and mapped back when
 * the take's timestamps return. Guesses (a four-digit number read as a year
 * when nothing says it is one) are marked MEDIUM for review.
 */

export type NumberStyle = 'UK' | 'US';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function under100(n: number): string {
  if (n < 20) return ONES[n]!;
  return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function under1000(n: number, style: NumberStyle): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return under100(r);
  return `${ONES[h]} hundred${r ? `${style === 'UK' ? ' and ' : ' '}${under100(r)}` : ''}`;
}

/** An integer in words ("three thousand five hundred", UK: "one hundred and twenty"). */
export function numberToWords(n: number, style: NumberStyle = 'UK'): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e15) throw new RangeError(`numberToWords: ${n}`);
  if (n === 0) return 'zero';
  const groups: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 1000)) groups.push(v % 1000);
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (!g) continue;
    // UK: "one thousand and five" — "and" before a last group under a hundred.
    const and = style === 'UK' && i === 0 && groups.length > 1 && g < 100 ? 'and ' : '';
    words.push(`${and}${under1000(g, style)}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
  }
  return words.join(' ');
}

/** A year as said aloud: 1637 → "sixteen thirty-seven", 1600 → "sixteen hundred", 1605 → "sixteen oh five". */
export function yearToWords(y: number, style: NumberStyle = 'UK'): string {
  if (y >= 2000 && y < 2010) return y === 2000 ? 'two thousand' : `two thousand ${style === 'UK' ? 'and ' : ''}${ONES[y % 10]}`;
  if (y < 1000 || y >= 10000 || y % 1000 === 0) return numberToWords(y, style);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (!lo) return `${under100(hi)} hundred`;
  if (lo < 10) return `${under100(hi)} oh ${ONES[lo]}`;
  return `${under100(hi)} ${under100(lo)}`;
}

const ORDINAL_WORDS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** "twenty-one" → "twenty-first". */
export function ordinalWords(n: number, style: NumberStyle = 'UK'): string {
  const words = numberToWords(n, style);
  const m = /([a-z]+)$/.exec(words)!;
  const last = m[1]!;
  const ord = ORDINAL_WORDS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, m.index) + ord;
}

/** "1630s" → "sixteen thirties", "1600s" → "sixteen hundreds". */
function decadeWords(y: number, style: NumberStyle): string {
  const w = yearToWords(y, style);
  return w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`;
}

const CURRENCY: Record<string, { one: string; many: string; sub?: { one: string; many: string } }> = {
  'ƒ': { one: 'guilder', many: 'guilders' },
  'fl.': { one: 'guilder', many: 'guilders' },
  'fl': { one: 'guilder', many: 'guilders' },
  '£': { one: 'pound', many: 'pounds', sub: { one: 'penny', many: 'pence' } },
  '$': { one: 'dollar', many: 'dollars', sub: { one: 'cent', many: 'cents' } },
  '€': { one: 'euro', many: 'euros', sub: { one: 'cent', many: 'cents' } },
};

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
/** Words before a four-digit number that make it a year. */
const YEAR_CUES = /\b(?:in|by|of|from|since|until|till|to|before|after|around|about|circa|winter|spring|summer|autumn|fall|early|late|mid|year|and|or|between|during|through)\s+$/i;
const MONTH_BEFORE = new RegExp(`\\b(?:${MONTHS})\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?$`, 'i');
const SCALE_WORD = /^\s+(thousand|million|billion)\b/i;

interface Found {
  kind: SpokenFormKind;
  start: number;
  end: number;
  display?: string;
  spoken: string;
  confidence: 'HIGH' | 'MEDIUM';
}

const toInt = (digits: string) => Number(digits.replace(/,/g, ''));

/** Spoken forms for the numbers, dates, amounts and abbreviations in a text (non-overlapping, in order). */
export function findSpokenForms(text: string, style: NumberStyle = 'UK'): Found[] {
  const found: Found[] = [];
  const taken = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  const add = (f: Found) => {
    if (!taken(f.start, f.end)) found.push(f);
  };

  // Amounts with a currency sign: "ƒ3,000", "£2.50", "$5 million", "fl. 1,200".
  for (const m of text.matchAll(/(ƒ|£|\$|€|\bfl\.?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const unit = CURRENCY[m[1]!] ?? CURRENCY['ƒ']!;
    const whole = toInt(m[2]!);
    let end = m.index + m[0].length;
    const scale = SCALE_WORD.exec(text.slice(end));
    let spoken = numberToWords(whole, style);
    if (scale) {
      spoken += ` ${scale[1]!.toLowerCase()}`;
      end += scale[0].length;
    }
    spoken += ` ${whole === 1 && !scale ? unit.one : unit.many}`;
    if (m[3] && unit.sub) {
      const cents = Number(m[3].padEnd(2, '0'));
      if (cents) spoken += ` and ${numberToWords(cents, style)} ${cents === 1 ? unit.sub.one : unit.sub.many}`;
    } else if (m[3]) spoken = `${numberToWords(whole, style)} point ${[...m[3]].map((d) => ONES[Number(d)]).join(' ')} ${unit.many}`;
    add({ kind: 'CURRENCY', start: m.index, end, spoken, confidence: 'HIGH' });
  }

  // "c. 1637", "ca. 1637": about a year.
  for (const m of text.matchAll(/\b(?:c|ca)\.\s?(\d{4})\b/g)) {
    add({ kind: 'ABBREVIATION', start: m.index, end: m.index + m[0].length, spoken: `around ${yearToWords(Number(m[1]), style)}`, confidence: 'HIGH' });
  }

  // Ranges of years or numbers: "1636–1637", "1636-37", "10–12".
  for (const m of text.matchAll(/(?<!\d|\d[,.])\b(\d{1,4})\s?[–-]\s?(\d{1,4})\b(?!\d|[,.]\d)/g)) {
    const a = Number(m[1]);
    let b = Number(m[2]);
    const years = m[1]!.length === 4 && a >= 1000;
    if (years && m[2]!.length === 2) b = Math.floor(a / 100) * 100 + b;
    if (b <= a) continue;
    const say = (n: number) => (years ? yearToWords(n, style) : numberToWords(n, style));
    add({ kind: 'RANGE', start: m.index, end: m.index + m[0].length, spoken: `${say(a)} to ${say(b)}`, confidence: years ? 'HIGH' : 'MEDIUM' });
  }

  // Dates: "3 February" (UK "the third of February"), "February 3" ("February third").
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b`, 'g'))) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) continue;
    const spoken = style === 'UK' ? `the ${ordinalWords(d, style)} of ${m[2]}` : `${m[2]} ${ordinalWords(d, style)}`;
    add({ kind: 'DATE', start: m.index, end: m.index + m[0].length, spoken, confidence: 'HIGH' });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\d)`, 'g'))) {
    const d = Number(m[2]);
    if (d < 1 || d > 31) continue;
    add({ kind: 'DATE', start: m.index, end: m.index + m[0].length, spoken: `${m[1]} ${ordinalWords(d, style)}`, confidence: 'HIGH' });
  }

  // Decades: "1630s".
  for (const m of text.matchAll(/\b(1[0-9]\d0|20\d0)['’]?s\b/g)) {
    add({ kind: 'DECADE', start: m.index, end: m.index + m[0].length, spoken: decadeWords(Number(m[1]), style), confidence: 'HIGH' });
  }

  // Percentages: "40%", "12.5 per cent".
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s?%/g)) {
    add({ kind: 'PERCENT', start: m.index, end: m.index + m[0].length, spoken: `${decimalWords(m[1]!, style)} percent`, confidence: 'HIGH' });
  }

  // Ordinals: "14th", "1st".
  for (const m of text.matchAll(/\b(\d{1,4})(st|nd|rd|th)\b/g)) {
    add({ kind: 'ORDINAL', start: m.index, end: m.index + m[0].length, spoken: ordinalWords(Number(m[1]), style), confidence: 'HIGH' });
  }

  // Decimals: "2.5".
  for (const m of text.matchAll(/\b\d+\.\d+\b/g)) {
    add({ kind: 'DECIMAL', start: m.index, end: m.index + m[0].length, spoken: decimalWords(m[0], style), confidence: 'HIGH' });
  }

  // Remaining numbers: years (four digits, 1000–2099) and quantities.
  for (const m of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g)) {
    const raw = m[0];
    const end = m.index + raw.length;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(end);
    const n = toInt(raw);
    if (!raw.includes(',') && raw.length === 4 && n >= 1000 && n < 2100) {
      const cued = YEAR_CUES.test(before) || MONTH_BEFORE.test(before);
      // "1637 bulbs" is a quantity; "in 1637", "1637," and "1637." are years.
      const counted = /^\s+\p{Ll}/u.test(after) && !cued;
      if (!counted) {
        add({ kind: 'YEAR', start: m.index, end, spoken: yearToWords(n, style), confidence: cued || /^[,.;:!?)]|^\s*$/.test(after) ? 'HIGH' : 'MEDIUM' });
        continue;
      }
      add({ kind: 'NUMBER', start: m.index, end, spoken: numberToWords(n, style), confidence: 'MEDIUM' });
      continue;
    }
    // "5 million" → "five million": the scale word after it stays as written.
    add({ kind: 'NUMBER', start: m.index, end, spoken: numberToWords(n, style), confidence: 'HIGH' });
  }
  return found.sort((a, b) => a.start - b.start).map((f) => ({ ...f, display: text.slice(f.start, f.end) }));
}

function decimalWords(s: string, style: NumberStyle): string {
  const [whole, frac] = s.split('.');
  const w = numberToWords(Number(whole), style);
  if (!frac) return w;
  const zero = style === 'UK' ? 'nought' : 'zero';
  return `${whole === '0' ? zero : w} point ${[...frac].map((d) => (d === '0' ? zero : ONES[Number(d)])).join(' ')}`;
}

/** An approved alias from the pronunciation list: a term said differently from how it is written. */
export interface AliasRule {
  term: string;
  alias: string;
}

export interface SpokenText {
  /** The text sent to the voice (before performance markup). */
  text: string;
  forms: SpokenForm[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The spoken version of a canonical text: numbers, dates and amounts in
 * words, and approved aliases in place of their terms. Everything else is
 * kept character for character.
 */
export function toSpoken(canonical: string, opts: { style?: NumberStyle; aliases?: readonly AliasRule[] } = {}): SpokenText {
  const style = opts.style ?? 'UK';
  const found: Found[] = [];
  // Aliases first: an approved alias wins over a number inside the same term.
  for (const a of [...(opts.aliases ?? [])].sort((x, y) => y.term.length - x.term.length)) {
    for (const m of canonical.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a.term)}(?![\\p{L}\\p{N}])`, 'gu'))) {
      if (!found.some((f) => m.index < f.end && m.index + m[0].length > f.start)) found.push({ kind: 'ALIAS', start: m.index, end: m.index + m[0].length, spoken: a.alias, confidence: 'HIGH' });
    }
  }
  for (const f of findSpokenForms(canonical, style)) {
    if (!found.some((x) => f.start < x.end && f.end > x.start)) found.push(f);
  }
  found.sort((a, b) => a.start - b.start);
  let text = '';
  let at = 0;
  const forms: SpokenForm[] = [];
  for (const f of found) {
    text += canonical.slice(at, f.start) + f.spoken;
    at = f.end;
    forms.push({ kind: f.kind, start: f.start, end: f.end, display: canonical.slice(f.start, f.end), spoken: f.spoken, confidence: f.confidence });
  }
  text += canonical.slice(at);
  return { text, forms };
}

/** Rebuilds the spoken text from the canonical text and its recorded forms (used to verify a take before sending). */
export function applyForms(canonical: string, forms: readonly SpokenForm[]): string {
  let text = '';
  let at = 0;
  for (const f of [...forms].sort((a, b) => a.start - b.start)) {
    if (f.start < at || canonical.slice(f.start, f.end) !== f.display) throw new Error(`spoken form "${f.display}" does not match the canonical text at ${f.start}`);
    text += canonical.slice(at, f.start) + f.spoken;
    at = f.end;
  }
  return text + canonical.slice(at);
}

/** Where a canonical offset lands in the spoken text (an offset inside a form maps to the form's spoken range start). */
export function canonicalToSpoken(forms: readonly SpokenForm[], offset: number): number {
  let shift = 0;
  for (const f of [...forms].sort((a, b) => a.start - b.start)) {
    if (offset < f.start) break;
    if (offset < f.end) return f.start + shift;
    shift += f.spoken.length - (f.end - f.start);
  }
  return offset + shift;
}

/** What is left in a spoken text that a narrator cannot read as written (digits, symbols). */
export function unspokenLeft(spoken: string): string[] {
  return [...new Set([...spoken.matchAll(/[\d%&@#ƒ£$€/\\]+/g)].map((m) => m[0]))];
}
