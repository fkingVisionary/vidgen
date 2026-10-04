import { describe, expect, it } from 'vitest';
import { sourceTypeHint } from './domains.ts';
import { cleanJson, cleanText, normalizeForMatch, relevantExcerpt, textSimilarity, topicKeywords, verifyQuote } from './text.ts';
import { isValidSourceUrl, matchesDomain, normalizeUrl } from './urls.ts';

describe('normalizeUrl', () => {
  it.each([
    ['https://www.Example.org/Path/?utm_source=x&b=2&a=1#section', 'example.org/Path?a=1&b=2'],
    ['http://example.org/path/', 'example.org/path'],
    ['https://example.org', 'example.org'],
    ['https://example.org:8443/x?fbclid=abc', 'example.org:8443/x'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected);
  });

  it('treats http/https and www as the same source', () => {
    expect(normalizeUrl('http://www.jstor.org/stable/123')).toBe(normalizeUrl('https://jstor.org/stable/123/'));
  });

  it('returns null for unusable URLs', () => {
    expect(normalizeUrl('ftp://example.org/file')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('isValidSourceUrl', () => {
  it.each([
    ['https://press.uchicago.edu/x.html', true],
    ['https://mock.invalid/search/1', false],
    ['http://localhost:3000/x', false],
    ['http://192.168.1.10/x', false],
    ['https://user:pw@example.org/', false],
    ['mailto:someone@example.org', false],
    ['https://example', false],
  ])('%s → %s', (url, ok) => {
    expect(isValidSourceUrl(url)).toBe(ok);
  });
});

describe('domains', () => {
  it('matches subdomains', () => {
    expect(matchesDomain('en.wikipedia.org', ['wikipedia.org'])).toBe(true);
    expect(matchesDomain('notwikipedia.org', ['wikipedia.org'])).toBe(false);
  });

  it.each([
    ['jstor.org', 'ACADEMIC'],
    ['dbnl.org', 'ARCHIVE'],
    ['press.uchicago.edu', 'BOOK'],
    ['penelope.uchicago.edu', 'ARCHIVE'],
    ['economist.com', 'REPUTABLE_SECONDARY'],
    ['en.wikipedia.org', 'GENERAL_REFERENCE'],
    ['tulip-facts-blog.com', 'GENERAL_WEB'],
  ])('hints %s as %s', (domain, type) => {
    expect(sourceTypeHint(domain)).toBe(type);
  });
});

describe('verifyQuote', () => {
  const doc = normalizeForMatch(`# The Price of a Bulb

In February 1637 a **Viceroy** bulb was recorded at *2,500 guilders* in a contract — according to the
pamphlet [Samen-spraeck](https://dbnl.org/x) — though such prices “were exceptional rather than typical”.
Most trades involved far cheaper bulbs, sold by weight in the taverns of Haarlem.`);

  it('accepts a verbatim quote despite markdown, line breaks, typographic quotes and dashes', () => {
    expect(verifyQuote(doc, 'a Viceroy bulb was recorded at 2,500 guilders in a contract - according to the pamphlet Samen-spraeck')).toEqual({ verified: true, method: 'exact' });
    expect(verifyQuote(doc, 'such prices "were exceptional rather than typical"')).toEqual({ verified: true, method: 'exact' });
  });

  it('accepts an elided quote when every segment appears in order', () => {
    expect(verifyQuote(doc, 'In February 1637 a Viceroy bulb ... sold by weight in the taverns of Haarlem')).toMatchObject({ verified: true, method: 'segments' });
    expect(verifyQuote(doc, 'sold by weight in the taverns of Haarlem ... In February 1637 a Viceroy bulb')).toMatchObject({ verified: false });
  });

  it('rejects paraphrases, invented numbers and trivially short quotes', () => {
    expect(verifyQuote(doc, 'a Viceroy bulb sold for 5,000 guilders in a contract')).toMatchObject({ verified: false });
    expect(verifyQuote(doc, 'Most trades were for cheap bulbs sold by weight')).toMatchObject({ verified: false });
    expect(verifyQuote(doc, 'Viceroy bulb')).toMatchObject({ verified: false, reason: 'quote too short to verify' });
  });
});

describe('textSimilarity', () => {
  const base = normalizeForMatch(Array.from({ length: 300 }, (_, i) => `word${i % 97} filler${i % 13} token${i}`).join(' '));
  it('is ~1 for mirrors and ~0 for unrelated text', () => {
    expect(textSimilarity(base, base)).toBe(1);
    expect(textSimilarity(base, normalizeForMatch(`${base} footer added by the mirror site`))).toBeGreaterThan(0.9);
    expect(textSimilarity(base, normalizeForMatch('completely different content about Roman coinage and its debasement over centuries of empire'))).toBeLessThan(0.05);
  });
});

describe('topicKeywords', () => {
  it('keeps distinctive words, drops stopwords, short words and accents', () => {
    expect(topicKeywords('Tulip Mania', 'The Dutch tulip bubble of 1636–37 and its later story')).toEqual(['tulip', 'mania', 'dutch', 'bubble', 'later']);
    expect(topicKeywords('Tulipomanie in Haarlem — économie')).toEqual(['tulipomanie', 'haarlem', 'economie']);
  });
});

describe('relevantExcerpt', () => {
  const filler = (n: number, word = 'weather') => Array.from({ length: n }, (_, i) => `Paragraph ${i} about the ${word} and the harvest in the provinces, nothing else of note here.`).join('\n\n');
  // A "book": front matter, 200 KB of unrelated chapters, the relevant chapter deep inside, more unrelated text.
  const front = 'MEMOIRS OF EXTRAORDINARY POPULAR DELUSIONS. By Charles Mackay. London, 1841.';
  const chapter = Array.from({ length: 12 }, (_, i) => `In ${1630 + (i % 8)} the tulip trade in Haarlem grew; a Semper Augustus bulb was said to fetch thousands of florins as the mania spread (${i}).`).join('\n\n');
  const book = [front, filler(1500), chapter, filler(800, 'alchemists')].join('\n\n');

  it('returns short documents unchanged', () => {
    expect(relevantExcerpt('short text', ['tulip'], 1000)).toEqual({ text: 'short text', truncated: false });
  });

  it('finds the relevant chapter deep inside a long document and keeps the opening', () => {
    expect(book.indexOf('Semper Augustus')).toBeGreaterThan(100_000);
    const r = relevantExcerpt(book, topicKeywords('Tulip Mania', 'The Dutch tulip bubble'), 20_000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.text.startsWith(front)).toBe(true);
    expect(r.text).toContain('a Semper Augustus bulb was said to fetch thousands of florins');
    expect(r.text).toContain('[…]');
    // A plain head-truncation would have missed the chapter entirely.
    expect(book.slice(0, 20_000)).not.toContain('Semper Augustus');
  });

  it('never alters the text: quotes from the excerpt verify against the full document', () => {
    const r = relevantExcerpt(book, ['tulip', 'mania'], 20_000);
    const quote = r.text.split('\n\n').find((p) => p.includes('Semper Augustus'))!;
    expect(verifyQuote(normalizeForMatch(book), quote)).toEqual({ verified: true, method: 'exact' });
    for (const piece of r.text.split('\n\n[…]\n\n')) expect(book).toContain(piece);
  });

  it('falls back to the opening when no keyword occurs', () => {
    const r = relevantExcerpt(book, ['zeppelin'], 5_000);
    expect(r).toEqual({ text: book.slice(0, 5_000), truncated: true });
  });

  it('splits a single enormous paragraph without losing or reordering text', () => {
    const blob = `${'lorem ipsum '.repeat(5_000)}the tulip mania ${'dolor sit '.repeat(5_000)}`;
    const r = relevantExcerpt(blob, ['tulip'], 10_000);
    expect(r.text.length).toBeLessThanOrEqual(10_000);
    expect(r.text).toContain('the tulip mania');
    for (const piece of r.text.split('\n\n[…]\n\n')) expect(normalizeForMatch(blob)).toContain(normalizeForMatch(piece));
  });
});

describe('cleanText / cleanJson', () => {
  it('removes NUL and other control characters but keeps tabs, newlines and all printable text', () => {
    expect(cleanText('Tulip\u0000 prices\u0007 rose\tin\r\n1636 — “Semper Augustus” ✓')).toBe('Tulip prices rose\tin\r\n1636 — “Semper Augustus” ✓');
  });
  it('cleans every string in a nested value and leaves other values alone', () => {
    expect(cleanJson({ a: 'x\u0000y', b: [1, 'p\u0000', null, { c: '\u0001z' }], d: true })).toEqual({ a: 'xy', b: [1, 'p', null, { c: 'z' }], d: true });
  });
});
