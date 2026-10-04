import { describe, expect, it } from 'vitest';
import { WordIndex, extractFigures, isYear, mentionsName, nameGrounded, nameTokens, normalize, titleSimilarity, withinOneEdit } from './text.ts';

describe('figures', () => {
  it('normalizes thousands separators, ordinals and decades', () => {
    expect(extractFigures('5,200 guilders, 5.200 florins, the 1630s, the 17th century')).toEqual(['5200', '1630', '17']);
    expect(extractFigures('1636–37 and 1636-1637')).toEqual(['1636', '37', '1637']);
    expect(extractFigures('2.5 percent and 12.75 per cent')).toEqual(['12.75']);
  });

  it('ignores figures below 10', () => {
    expect(extractFigures('3 bulbs, 2 horses and 1 cart')).toEqual([]);
  });

  it('recognises years', () => {
    expect(isYear('1637')).toBe(true);
    expect(isYear('90000')).toBe(false);
    expect(isYear('37')).toBe(false);
  });
});

describe('names', () => {
  it('keeps the identifying tokens of a name', () => {
    expect(nameTokens('Sir Wouter van der Winckel')).toEqual(['wouter', 'winckel']);
    expect(nameTokens('J. P. Smith')).toEqual(['smith']);
  });

  it('tolerates one letter of early-modern spelling variation, not an invented name', () => {
    const index = new WordIndex('The estate of Wouter Winkel, innkeeper of Alkmaar, was sold for his orphans.');
    expect(nameGrounded('Wouter Winkel', index)).toBe(true);
    expect(nameGrounded('Wouter Winckel', index)).toBe(true);
    expect(nameGrounded('Wouter Bartelmiesz Winkel', index)).toBe(false);
    expect(nameGrounded('Hendrik Winkel', index)).toBe(false);
    expect(nameGrounded('', index)).toBe(false);
  });

  it('measures single edits', () => {
    expect(withinOneEdit('winkel', 'winckel')).toBe(true);
    expect(withinOneEdit('winkel', 'wankel')).toBe(true);
    expect(withinOneEdit('winkel', 'winkle')).toBe(false);
    expect(withinOneEdit('mackay', 'mckay')).toBe(true);
  });

  it('finds a person mentioned by surname', () => {
    expect(mentionsName('Mackay told the story in 1841.', 'Charles Mackay')).toBe(true);
    expect(mentionsName('The buyers refused to pay.', 'Charles Mackay')).toBe(false);
  });
});

describe('text', () => {
  it('normalizes accents, quotes and dashes', () => {
    expect(normalize('  Café “Ö”  –  ‘x’ ')).toBe('cafe “o” - \'x\'');
  });

  it('compares titles by their words', () => {
    expect(titleSimilarity('The Alkmaar auction', 'The auction at Alkmaar')).toBe(1);
    expect(titleSimilarity('The Alkmaar auction', 'A sailor and an onion')).toBe(0);
  });
});
