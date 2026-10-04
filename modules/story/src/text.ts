/**
 * Text matching for the evidence rules: are a story's people and figures in
 * the evidence it cites? Deliberately simple and deterministic, so every
 * decision can be explained in a normalization note and tested.
 */

/** Lower-case, accents stripped, typographic quotes and dashes unified, whitespace collapsed. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word tokens (letters and digits) of a text. */
export function wordTokens(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// ── People ───────────────────────────────────────────────────────────────────

const NAME_PARTICLES = new Set(['van', 'de', 'der', 'den', 'von', 'la', 'le', 'du', 'di', 'da', 'het', 'ten', 'ter', 'of', 'the', 'and', 'jr', 'sr', 'st']);
const NAME_TITLES = new Set(['sir', 'lord', 'lady', 'mr', 'mrs', 'dr', 'captain', 'mayor', 'burgomaster', 'widow', 'master']);

/** Tokens that identify a person: no particles, titles or initials. */
export function nameTokens(name: string): string[] {
  return wordTokens(name).filter((t) => t.length >= 3 && !NAME_PARTICLES.has(t) && !NAME_TITLES.has(t) && !/^\d+$/.test(t));
}

/** True when a and b differ by at most one inserted, deleted or substituted letter. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) i++;
    j++;
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

/** A searchable set of the words in some evidence. */
export class WordIndex {
  private readonly words: Set<string>;
  /** Longer words, for tolerant matching of early-modern spelling variants. */
  private readonly long: string[];

  constructor(text: string) {
    this.words = new Set(wordTokens(text));
    this.long = [...this.words].filter((w) => w.length >= 5);
  }

  has(word: string): boolean {
    if (this.words.has(word)) return true;
    return word.length >= 5 && this.long.some((w) => withinOneEdit(w, word));
  }
}

/**
 * Is this person's name in the evidence? Every identifying token must appear
 * (tolerating one letter's difference in longer tokens: early-modern spelling
 * varies, e.g. Winkel/Winckel), so an invented first name or surname added to
 * a real one is caught.
 */
export function nameGrounded(name: string, index: WordIndex): boolean {
  const tokens = nameTokens(name);
  return tokens.length > 0 && tokens.every((t) => index.has(t));
}

/** Does a text mention this person (by any identifying token of their name)? */
export function mentionsName(text: string, name: string): boolean {
  const words = new Set(wordTokens(text));
  const tokens = nameTokens(name);
  const surname = tokens.at(-1);
  return surname !== undefined && words.has(surname);
}

// ── Figures ──────────────────────────────────────────────────────────────────

const FIGURE = /\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * Figures in a text, normalized ("5,200" and "5.200" → "5200", "1630s" →
 * "1630", "17th" → "17"). Figures below 10 are ignored: small counts are too
 * common to check and rarely the facts a viewer remembers.
 */
export function extractFigures(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0];
    const value = /^\d{1,3}(?:[,.]\d{3})+$/.test(raw) ? raw.replace(/[,.]/g, '') : raw.replace(/,/g, '');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 10) continue;
    out.add(String(n));
  }
  return [...out];
}

/** Four-digit years: checked against the whole dossier rather than a story's own claims. */
export function isYear(figure: string): boolean {
  const n = Number(figure);
  return Number.isInteger(n) && n >= 1000 && n <= 2100;
}

// ── Similarity ───────────────────────────────────────────────────────────────

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'by', 'for', 'from', 'to', 'as', 'into', 'who', 'that', 'with', 'how', 'why', 'what', 'when', 'where', 'his', 'her', 'its', 'their', 'was', 'is']);

/** Word overlap of two titles (stop words ignored). */
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(wordTokens(s).filter((w) => !STOP.has(w)));
  return jaccard(words(a), words(b));
}
