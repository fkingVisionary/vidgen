import { describe, expect, it } from 'vitest';
import { avoidWords, avoidedMatches, shownWords, showsAll, stem } from './anachronism.ts';

/**
 * The word matching behind ANACHRONISM_RISK and MUST_SHOW_DROPPED, on a
 * Haarlem tavern in the winter of 1636: both numbers of a word are one word,
 * and a shot that says what is absent does not show it.
 */

describe('plurals', () => {
  it('folds both numbers of a word to one ("-es" words included)', () => {
    const pairs = [
      ['notes', 'note'],
      ['houses', 'house'],
      ['candles', 'candle'],
      ['tables', 'table'],
      ['glasses', 'glass'],
      ['boxes', 'box'],
      ['notaries', 'notary'],
      ['bulbs', 'bulb'],
      ['florins', 'florin'],
    ];
    for (const [plural, singular] of pairs) expect([plural, stem(plural!)]).toEqual([plural, stem(singular!)]);
    // Words that only end in s are left alone.
    expect(['glass', 'augustus'].map(stem)).toEqual(['glass', 'augustus']);
    expect(avoidWords('promissory notes')).toEqual(avoidWords('a promissory note'));
  });

  it('folds "-es" after a single s or an o too (buses/bus, heroes/hero), as the old stem did', () => {
    const pairs = [
      ['buses', 'bus'],
      ['gases', 'gas'],
      ['statuses', 'status'],
      ['heroes', 'hero'],
      ['potatoes', 'potato'],
      ['cargoes', 'cargo'],
      ['torpedoes', 'torpedo'],
      ['shoes', 'shoe'],
      ['canoes', 'canoe'],
      ['vases', 'vase'],
    ];
    for (const [plural, singular] of pairs) expect([plural, stem(plural!)]).toEqual([plural, stem(singular!)]);
    expect(avoidedMatches('A motor bus waits at the quay.', ['motor buses'])).toEqual(['motor buses']);
    expect(avoidWords('steam torpedoes')).toEqual(avoidWords('a steam torpedo'));
  });

  it('a must-avoid item in the plural matches a picture of one (the old "-es" stem missed it)', () => {
    expect(avoidedMatches('A merchant counts a printed banknote at the counter.', ['printed banknotes'])).toEqual(['printed banknotes']);
    expect(avoidedMatches('Plate glasses on the shelf.', ['plate glass'])).toEqual(['plate glass']);
  });
});

describe('negation', () => {
  const avoid = ['electric light', 'modern clothing', 'glass windows', 'tulips in bloom', 'modern clock'];

  it('a shot that says an avoided thing is absent does not show it', () => {
    expect(avoidedMatches('Warm candlelight and firelight only, no electric light.', avoid)).toEqual([]);
    expect(avoidedMatches('Leaded panes, no modern glass windows.', avoid)).toEqual([]);
    expect(avoidedMatches('Bulbs in sacks; the tulips not yet in bloom.', avoid)).toEqual([]);
    expect(avoidedMatches('Traders in doublets, without modern clothing.', avoid)).toEqual([]);
  });

  it('still finds what is shown: a negation reaches only the words after it, in its clause and field', () => {
    expect(avoidedMatches('An electric light hangs over the bar.', avoid)).toEqual(['electric light']);
    expect(avoidedMatches('A man with no hat wears modern clothing.', avoid)).toEqual(['modern clothing']);
    expect(avoidedMatches('No candles, electric light from the ceiling.', avoid)).toEqual(['electric light']);
    expect(avoidedMatches('Candles only, no torches\nAn electric light over the door', avoid)).toEqual(['electric light']);
    expect(avoidedMatches('No one notices the modern clock on the wall.', avoid)).toEqual(['modern clock']);
    expect(avoidedMatches('Tulips in bloom fill the garden beds.', avoid)).toEqual(['tulips in bloom']);
  });

  it('a negation reaches its own phrase only, at least two words, and on through "or"', () => {
    expect(avoidedMatches('A man without a coat in modern clothing.', avoid)).toEqual(['modern clothing']);
    expect(avoidedMatches('A room with no shutters and glass windows.', avoid)).toEqual(['glass windows']);
    expect(avoidedMatches('Shelves without books and a modern clock.', avoid)).toEqual(['modern clock']);
    expect(avoidedMatches('No modern cars in the street.', ['cars'])).toEqual([]);
    expect(avoidedMatches('Candles but no electric light or modern clothing.', avoid)).toEqual([]);
    expect(avoidedMatches('No sign of electric light.', avoid)).toEqual([]);
  });

  it('names an avoided item once, whatever its case', () => {
    expect(avoidedMatches('Men in modern clothing.', ['modern clothing', 'Modern clothing'])).toEqual(['modern clothing']);
  });

  it('showsAll: every word of a phrase in one sentence, outside a negation', () => {
    const wanted = avoidWords('promissory notes changing hands');
    expect(showsAll('Close on the table: promissory notes changing hands.', wanted)).toBe(true);
    expect(showsAll('Promissory clause; notes on the wall; hands of a clock; changing light', wanted)).toBe(false);
    expect(showsAll('Traders wait, no promissory notes changing hands yet', wanted)).toBe(false);
    expect(showsAll('anything', [])).toBe(false);
  });

  it('shownWords leaves out only the negated words', () => {
    expect([...shownWords('Candlelight, no electric light in the room', 2)].sort()).toEqual(['candlelight', 'in', 'room', 'the']);
    expect([...shownWords('Candlelight; electric light', 2)].sort()).toEqual(['candlelight', 'electric', 'light']);
  });
});
