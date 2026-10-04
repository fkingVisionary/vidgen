import { describe, expect, it } from 'vitest';
import { sourceTypeHint } from './domains.ts';
import { normalizeForMatch, textSimilarity, verifyQuote } from './text.ts';
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
