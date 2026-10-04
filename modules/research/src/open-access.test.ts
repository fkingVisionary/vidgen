import { describe, expect, it } from 'vitest';
import { cleanTitle, openAccessLookup, sameWorkScore, splitTitle, titleMatch, titleTokens } from './open-access.ts';

// Titles below are as Tavily returned them in the live check of 2026-10-04.
describe('cleanTitle / splitTitle', () => {
  it('strips hosting-site names and PDF markers', () => {
    expect(cleanTitle('Tulipmania: Money, Honor, and Knowledge in the Dutch Golden Age on JSTOR')).toBe('Tulipmania: Money, Honor, and Knowledge in the Dutch Golden Age');
    expect(cleanTitle('The tulipmania: Fact or artifact? | Public Choice | Springer Nature Link')).toBe('The tulipmania: Fact or artifact? | Public Choice');
    expect(cleanTitle('[PDF] Famous First Bubbles - SSRN')).toBe('Famous First Bubbles');
    expect(cleanTitle('Tulip mania - Wikipedia')).toBe('Tulip mania - Wikipedia'); // not a scholarly host: left alone
  });

  it('separates the work title from journal, volume, author and year', () => {
    expect(splitTitle('Tulipmania | Journal of Political Economy: Vol 97, No 3')).toEqual({ main: 'Tulipmania', context: 'Journal of Political Economy: Vol 97, No 3' });
    expect(splitTitle('Rational bubbles and middlemen - Awaya - 2022')).toEqual({ main: 'Rational bubbles and middlemen', context: 'Awaya 2022' });
    expect(splitTitle('The tulipmania: Fact or artifact? | Public Choice | Springer Nature Link')).toEqual({ main: 'The tulipmania: Fact or artifact?', context: 'Public Choice' });
  });

  it('tokenises without accents, stopwords or short words', () => {
    expect(titleTokens('Économie de la tulipe | Vol 9')).toEqual(['economie', 'tulipe', 'vol']);
    expect(titleMatch('Économie de la tulipe', 'ECONOMIE DE LA TULIPE (author manuscript)')).toBe(1);
  });
});

describe('openAccessLookup / sameWorkScore', () => {
  it('searches distinctive titles as an exact phrase', () => {
    expect(openAccessLookup('Tiptoe through the tulips – cultural history, molecular ...')?.query).toBe('"Tiptoe through the tulips – cultural history, molecular ..." pdf');
  });

  it('adds journal context to short titles, and skips titles too ambiguous to look up', () => {
    expect(openAccessLookup('Tulipmania | Journal of Political Economy: Vol 97, No 3')?.query).toBe('"Tulipmania" Journal of Political Economy: Vol 97, No 3 pdf');
    expect(openAccessLookup('Tulipmania')).toBeNull();
    expect(openAccessLookup('Tulipmania | JSTOR')).toBeNull();
    expect(openAccessLookup('Vol. 97, No. 3, Jun., 1989 of Journal of Political Economy')).toBeNull(); // an issue's contents page
  });

  it('accepts the same work elsewhere and rejects look-alikes', () => {
    const long = openAccessLookup('Tiptoe through the tulips – cultural history, molecular ... | Wiley Online Library')!;
    expect(sameWorkScore(long, '(PDF) Tiptoe through the tulips - cultural history, molecular ...', '')).toBe(1);
    expect(sameWorkScore(long, 'Tiptoe through the tulips – cultural history ... - Oxford Academic', '')).toBeGreaterThanOrEqual(0.8); // cut-off title
    expect(sameWorkScore(long, 'Growing tulips in your garden', '')).toBeLessThan(0.8);
    // Live false positives at the earlier 0.6 threshold: different papers sharing two of three words.
    const three = openAccessLookup('Rational bubbles and middlemen - Awaya - 2022')!;
    expect(sameWorkScore(three, 'Rational Bubbles and Middlemen', '')).toBe(1);
    expect(sameWorkScore(three, 'Rational Exuberance and Bubbles', '')).toBeLessThan(0.8);
    expect(sameWorkScore(three, 'Rational Bubbles Attached to Real Assets', '')).toBeLessThan(0.8);

    const short = openAccessLookup('Tulipmania | Journal of Political Economy: Vol 97, No 3')!;
    // The McMaster copy of Garber's article: short title must match in full and the journal must appear in title or snippet.
    expect(sameWorkScore(short, 'Tulipmania Author(s): Peter M. Garber Source', 'Journal of Political Economy, Vol. 97, No. 3 (Jun., 1989), pp. 535-560')).toBe(1);
    expect(sameWorkScore(short, 'Tulipmania: Money, Honor, and Knowledge in the Dutch Golden Age', 'A book by Anne Goldgar')).toBe(0);
    expect(sameWorkScore(short, 'Tulipmania explained', 'a blog post')).toBe(0);
    // A student essay about the article mentions the journal but is not the article.
    expect(sameWorkScore(short, 'Term Paper Reflection on Tulipmania', 'Garber (1989), Journal of Political Economy, Vol. 97, No. 3')).toBe(0);
    // A different paper in the same journal is not the same work.
    expect(sameWorkScore(short, 'Famous first bubbles', 'Journal of Political Economy, Vol. 97')).toBe(0);
  });
});
