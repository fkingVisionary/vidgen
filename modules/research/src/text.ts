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
