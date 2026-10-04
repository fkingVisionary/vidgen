import { createHash } from 'node:crypto';

/** Text utilities: hashing, quote verification, near-duplicate detection. */

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Normalisation used to compare a quote with the retrieved document:
 * Unicode compatibility forms, typographic quotes/dashes, markdown syntax and
 * whitespace are ignored; letters, digits and punctuation must match.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links/images → their text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[*_`#>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type QuoteCheck = { verified: true; method: 'exact' | 'segments' } | { verified: false; reason: string };

const MIN_QUOTE = 20;
const MIN_SEGMENT = 15;

/**
 * Is `quote` really in the document? Accepts an exact (normalised) match, or
 * — for quotes elided with "..." / "…" — every segment of at least 15
 * characters appearing in order. Anything shorter than 20 characters is
 * rejected as too weak to verify.
 */
export function verifyQuote(normalizedDocument: string, quote: string): QuoteCheck {
  const q = normalizeForMatch(quote);
  if (q.length < MIN_QUOTE) return { verified: false, reason: 'quote too short to verify' };
  if (normalizedDocument.includes(q)) return { verified: true, method: 'exact' };

  const segments = q.split(/\.\.\.|…/).map((s) => s.trim().replace(/^["']|["']$/g, '').trim()).filter((s) => s.length > 0);
  if (segments.length > 1 && segments.every((s) => s.length >= MIN_SEGMENT)) {
    let from = 0;
    for (const seg of segments) {
      const at = normalizedDocument.indexOf(seg, from);
      if (at < 0) return { verified: false, reason: 'elided quote segment not found' };
      from = at + seg.length;
    }
    return { verified: true, method: 'segments' };
  }
  return { verified: false, reason: 'quote not found in retrieved text' };
}

function shingles(normalized: string, size = 8, maxChars = 20_000): Set<string> {
  const words = normalized.slice(0, maxChars).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}

/** Jaccard similarity of 8-word shingles (0–1). Mirrors and syndicated copies score > 0.8. */
export function textSimilarity(aNormalized: string, bNormalized: string): number {
  const a = shingles(aNormalized);
  const b = shingles(bNormalized);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'which', 'were', 'have', 'their', 'into', 'about', 'after', 'before', 'over', 'became',
  'what', 'when', 'where', 'there', 'they', 'them', 'than', 'then', 'also', 'such', 'story', 'history', 'historical',
]);

/** Distinctive words of a topic/title, used to find the relevant part of a long document. */
export function topicKeywords(...texts: string[]): string[] {
  const words = texts.join(' ').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

const SEPARATOR = '\n\n[…]\n\n';

/**
 * Long documents (whole books, long encyclopedia pages) are cut down to the
 * passages that matter instead of their first N characters: paragraphs are
 * grouped into ~4,000-character chunks, chunks are ranked by topic-keyword
 * density, and the best are kept in their original order. Text is never
 * altered, so quotes remain verifiable against the stored document.
 */
export function relevantExcerpt(text: string, keywords: string[], maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: { index: number; text: string; score: number }[] = [];
  let current = '';
  const push = () => {
    if (!current) return;
    const lower = current.toLowerCase();
    const score = keywords.reduce((n, k) => n + (lower.split(k).length - 1), 0) / Math.max(1, current.length / 1000);
    chunks.push({ index: chunks.length, text: current, score });
    current = '';
  };
  for (const p of paragraphs) {
    if (current && current.length + p.length > 4_000) push();
    current = current ? `${current}\n\n${p}` : p;
    while (current.length > 8_000) {
      // A single enormous "paragraph" (no blank lines): split it on a line break or space near 4,000 characters.
      const cut = Math.max(current.lastIndexOf('\n', 4_000), current.lastIndexOf(' ', 4_000), 2_000);
      const head = current.slice(0, cut);
      current = current.slice(cut).trimStart();
      const saved = current;
      current = head;
      push();
      current = saved;
    }
  }
  push();

  if (chunks.every((c) => c.score === 0)) return { text: text.slice(0, maxChars), truncated: true };
  const chosen = new Set<number>([0]); // keep the opening (title, author, date) for context
  let used = chunks[0]!.text.length;
  for (const c of [...chunks].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (c.score === 0 || chosen.has(c.index)) continue;
    if (used + SEPARATOR.length + c.text.length > maxChars) continue;
    chosen.add(c.index);
    used += SEPARATOR.length + c.text.length;
  }
  // Adjacent chunks are rejoined as they were; gaps are marked.
  let out = '';
  let prev = -1;
  for (const c of chunks) {
    if (!chosen.has(c.index)) continue;
    out += prev < 0 ? c.text : c.index === prev + 1 ? `\n\n${c.text}` : `${SEPARATOR}${c.text}`;
    prev = c.index;
  }
  return { text: out, truncated: true };
}
