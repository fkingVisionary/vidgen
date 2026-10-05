import { describe, expect, it } from 'vitest';
import { applyForms, canonicalToSpoken, findSpokenForms, numberToWords, ordinalWords, toSpoken, unspokenLeft, yearToWords } from './spoken.ts';

/** Numbers, dates and amounts get a spoken form before generation; the script keeps what it wrote. */

describe('numbers in words', () => {
  it('reads integers, years and ordinals as a narrator says them', () => {
    expect(numberToWords(3000)).toBe('three thousand');
    expect(numberToWords(5500)).toBe('five thousand five hundred');
    expect(numberToWords(120)).toBe('one hundred and twenty');
    expect(numberToWords(120, 'US')).toBe('one hundred twenty');
    expect(numberToWords(1005)).toBe('one thousand and five');
    expect(numberToWords(2_400_000)).toBe('two million four hundred thousand');
    expect(yearToWords(1637)).toBe('sixteen thirty-seven');
    expect(yearToWords(1600)).toBe('sixteen hundred');
    expect(yearToWords(1605)).toBe('sixteen oh five');
    expect(yearToWords(2005)).toBe('two thousand and five');
    expect(yearToWords(2026)).toBe('twenty twenty-six');
    expect(ordinalWords(21)).toBe('twenty-first');
    expect(ordinalWords(12)).toBe('twelfth');
    expect(ordinalWords(40)).toBe('fortieth');
  });
});

describe('spoken forms', () => {
  it('converts the brief examples and records each one against the canonical text', () => {
    const canonical = 'In 1637 a single bulb sold for 3,000 guilders, and another for ƒ5,500.';
    const s = toSpoken(canonical);
    expect(s.text).toBe('In sixteen thirty-seven a single bulb sold for three thousand guilders, and another for five thousand five hundred guilders.');
    expect(s.forms.map((f) => [f.kind, f.display, f.spoken, f.confidence])).toEqual([
      ['YEAR', '1637', 'sixteen thirty-seven', 'HIGH'],
      ['NUMBER', '3,000', 'three thousand', 'HIGH'],
      ['CURRENCY', 'ƒ5,500', 'five thousand five hundred guilders', 'HIGH'],
    ]);
    // The forms rebuild the spoken text exactly, and offsets map across.
    expect(applyForms(canonical, s.forms)).toBe(s.text);
    expect(s.text.slice(canonicalToSpoken(s.forms, canonical.indexOf('a single')))).toMatch(/^a single bulb/);
    expect(unspokenLeft(s.text)).toEqual([]);
  });

  it('handles dates, decades, ranges, percentages, decimals, circa and currency with scales', () => {
    const say = (t: string) => toSpoken(t).text;
    expect(say('On 3 February 1637 the market broke.')).toBe('On the third of February sixteen thirty-seven the market broke.');
    expect(say('By February 5th it was over.')).toBe('By February fifth it was over.');
    expect(say('In the 1630s, and in the 1600s.')).toBe('In the sixteen thirties, and in the sixteen hundreds.');
    expect(say('Between 1636–1637, and 1636-37.')).toBe('Between sixteen thirty-six to sixteen thirty-seven, and sixteen thirty-six to sixteen thirty-seven.');
    expect(say('Prices rose 40% in 2.5 weeks.')).toBe('Prices rose forty percent in two point five weeks.');
    expect(say('Built c. 1610.')).toBe('Built around sixteen ten.');
    expect(say('A $5 million loss, a £2.50 fee.')).toBe('A five million dollars loss, a two pounds and fifty pence fee.');
    expect(say('The 14th buyer.')).toBe('The fourteenth buyer.');
  });

  it('marks a guess for review: a four-digit number with nothing saying it is a year', () => {
    const forms = findSpokenForms('He kept 1637 bulbs in the cellar, and sold them in 1638.');
    expect(forms.map((f) => [f.display, f.kind, f.spoken, f.confidence])).toEqual([
      ['1637', 'NUMBER', 'one thousand six hundred and thirty-seven', 'MEDIUM'],
      ['1638', 'YEAR', 'sixteen thirty-eight', 'HIGH'],
    ]);
  });

  it('speaks approved aliases in place of their terms, as recorded forms', () => {
    const s = toSpoken('The VOC sent ships from Texel.', { aliases: [{ term: 'VOC', alias: 'V O C' }, { term: 'Texel', alias: 'Tessel' }] });
    expect(s.text).toBe('The V O C sent ships from Tessel.');
    expect(s.forms.map((f) => f.kind)).toEqual(['ALIAS', 'ALIAS']);
    expect(unspokenLeft('Call 555 & ask')).toEqual(['555', '&']);
  });
});
