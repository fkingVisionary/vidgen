import { HistoricalMoneyContext, type ClaimVerdict, type ConfidenceLevel } from '@docengine/core';
import { EvidenceBase, type EvidenceClaim } from '@docengine/story/shared';
import { fakeEvidenceInput } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { NO_EQUIVALENT, currenciesOf, moneyContexts, moneyFacts, moneyGaps, moneyInNarration, moneyMentions, parseAmount, renderMoneyContexts, spokenRatio } from './money.ts';
import type { NarrationBlock } from './text.ts';

/**
 * Historical money context (Part IX) on the synthetic tulip dossier and on
 * small dossiers of our own: a sum is given meaning only from the claims an
 * architecture cites — never a made-up comparison, exchange rate or modern
 * conversion — and when the evidence has none, the gap is said plainly.
 */

type PriceEvidence = ReturnType<typeof fakeEvidenceInput>['content']['priceEvidence'][number];

const tulip = () => new EvidenceBase(fakeEvidenceInput());
const keys = (...k: string[]) => new Set(k);

/** The tulip dossier with some claims' verdicts, confidence or wording changed. */
function tulipWith(changes: Record<string, Partial<EvidenceClaim>>): EvidenceBase {
  const input = fakeEvidenceInput();
  return new EvidenceBase({ ...input, claims: input.claims.map((c) => ({ ...c, ...changes[c.key] })) });
}

/** A small dossier of our own: just the claims (and price evidence) a test needs. */
function dossier(claims: { key: string; statement: string; verdict?: ClaimVerdict; confidence?: ConfidenceLevel }[], priceEvidence: PriceEvidence[] = []): EvidenceBase {
  const input = fakeEvidenceInput();
  return new EvidenceBase({
    ...input,
    content: { ...input.content, priceEvidence },
    claims: claims.map((c) => ({
      id: `claim-${c.key}`,
      key: c.key,
      statement: c.statement,
      claimType: 'ECONOMIC_FIGURE',
      importance: 'SUPPORTING',
      verdict: c.verdict ?? 'ESTABLISHED',
      confidence: c.confidence ?? 'HIGH',
      popularVersion: null,
      notes: null,
      citations: [],
    })),
  });
}

const block = (key: string, text: string, o: Partial<NarrationBlock> = {}): NarrationBlock => ({ key, section: Number(key.split('.')[0]), text, infoClass: 'DOCUMENTED', speakerId: null, claimKeys: [], ...o });

const WAGE_C018 = 'A skilled craftsman earned roughly 300 guilders a year.';

// ── Reading sums ─────────────────────────────────────────────────────────────

describe('parseAmount: a sum as written, as a number', () => {
  it('reads digits, with thousands separators and decimals', () => {
    expect(parseAmount('1,200')).toBe(1200);
    expect(parseAmount('90,000')).toBe(90_000);
    expect(parseAmount('300')).toBe(300);
    expect(parseAmount('2.5')).toBe(2.5);
  });

  it('reads sums in words the way a narrator writes them', () => {
    expect(parseAmount('twelve hundred')).toBe(1200);
    expect(parseAmount('three thousand')).toBe(3000);
    expect(parseAmount('a hundred')).toBe(100);
    expect(parseAmount('Three hundred')).toBe(300);
    expect(parseAmount('two hundred and fifty')).toBe(250);
    expect(parseAmount('twenty-five')).toBe(25);
    expect(parseAmount('two thousand five hundred')).toBe(2500);
    expect(parseAmount('a hundred and fifty')).toBe(150);
    expect(parseAmount('twelve hundred and fifty')).toBe(1250);
    expect(parseAmount('a thousand and one')).toBe(1001);
  });

  it('reads large sums whole, a group at a time', () => {
    expect(parseAmount('two hundred and fifty thousand')).toBe(250_000);
    expect(parseAmount('one million two hundred thousand')).toBe(1_200_000);
    expect(parseAmount('three hundred thousand two hundred')).toBe(300_200);
    expect(parseAmount('two billion')).toBe(2_000_000_000);
    expect(parseAmount('ten thousand million')).toBe(10_000_000_000);
  });

  it('gives null for two sums written together: they are not one sum', () => {
    expect(parseAmount('two hundred and three hundred')).toBeNull();
    expect(parseAmount('a hundred and two hundred')).toBeNull();
    expect(parseAmount('one thousand and two thousand')).toBeNull();
  });

  it('reads digits followed by a scale word', () => {
    expect(parseAmount('40 million')).toBe(40_000_000);
    expect(parseAmount('1.5 million')).toBe(1_500_000);
    expect(parseAmount('2 billion')).toBe(2_000_000_000);
    expect(parseAmount('40 dollars')).toBeNull();
  });

  it('gives null for anything that is not a number', () => {
    expect(parseAmount('banana')).toBeNull();
    expect(parseAmount('a few')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('moneyMentions: the sums a text says', () => {
  const currencies = keys('guilder', 'pound', 'dollar', 'euro', 'florin');

  it('finds each sum with its currency (in the singular) and the sentence it is in', () => {
    const text = 'Proefman had bought the bulbs for 1,200 guilders. A craftsman earned about three hundred guilders a year.';
    expect(moneyMentions(text, currencies)).toEqual([
      { amount: 1200, amountText: '1,200', currency: 'guilder', sentence: 'Proefman had bought the bulbs for 1,200 guilders.' },
      { amount: 300, amountText: 'three hundred', currency: 'guilder', sentence: 'A craftsman earned about three hundred guilders a year.' },
    ]);
  });

  it('reads currency symbols', () => {
    const found = moneyMentions('The rent was £30 a year. The company raised $40 million. The painting sold for €1,500. The ship cost £1.5 million.', currencies);
    expect(found.map((m) => [m.amountText, m.amount, m.currency])).toEqual([
      ['30', 30, 'pound'],
      ['40 million', 40_000_000, 'dollar'],
      ['1,500', 1500, 'euro'],
      ['1.5 million', 1_500_000, 'pound'],
    ]);
  });

  it('reads a metal named between the sum and its currency', () => {
    expect(moneyMentions('He paid a thousand gold florins.', currencies).map((m) => [m.amountText, m.amount, m.currency])).toEqual([['a thousand', 1000, 'florin']]);
  });

  it('reads a sum written in several words whole, never just its last word', () => {
    const read = (text: string) => moneyMentions(text, currencies).map((m) => [m.amountText, m.amount]);
    expect(read('It cost twenty-five pounds.')).toEqual([['twenty-five', 25]]);
    expect(read('It cost two thousand five hundred guilders.')).toEqual([['two thousand five hundred', 2500]]);
    expect(read('It cost one hundred and fifty pounds.')).toEqual([['one hundred and fifty', 150]]);
    expect(read('It cost twelve hundred guilders.')).toEqual([['twelve hundred', 1200]]);
    expect(read('It cost a thousand guilders.')).toEqual([['a thousand', 1000]]);
    expect(read('Lumeo raised 40 million dollars in 2019.')).toEqual([['40 million', 40_000_000]]);
  });

  it('does not join two separate numbers into one sum: the currency belongs to the last of them', () => {
    const read = (text: string) => moneyMentions(text, currencies).map((m) => [m.amountText, m.amount]);
    expect(read('Prices ran between ten and twenty pounds.')).toEqual([['twenty', 20]]);
    expect(read('A craftsman earned between two hundred and three hundred guilders a year.')).toEqual([['three hundred', 300]]);
    expect(read('It cost between a hundred and two hundred pounds.')).toEqual([['two hundred', 200]]);
    expect(read('Bids came in at one thousand and two thousand guilders.')).toEqual([['two thousand', 2000]]);
    // …while one sum with "and" in it stays one sum.
    expect(read('The estate was valued at two hundred and fifty thousand guilders.')).toEqual([['two hundred and fifty thousand', 250_000]]);
  });

  it('ignores numbers that are not money, and currencies it was not told about', () => {
    expect(moneyMentions('In 1637, 300 people traded 40 bulbs in 12 taverns.', currencies)).toEqual([]);
    expect(moneyMentions('He paid 1,200 guilders.', keys('pound'))).toEqual([]);
  });

  it("leaves quotations out: the record's words are not the narrator's", () => {
    expect(moneyMentions('He wrote, "I gave 1,200 guilders for nothing." The court was not moved.', currencies)).toEqual([]);
  });
});

describe('currenciesOf: what counts as money in a dossier', () => {
  it("knows the common currencies and adds the ones the dossier's price evidence names", () => {
    const c = currenciesOf(tulip());
    expect(c.has('guilder')).toBe(true);
    expect(c.has('pound')).toBe(true);
    expect(currenciesOf(dossier([])).has('guilder')).toBe(false);
  });

  it('takes the last word of a currency the price evidence qualifies, in the singular', () => {
    const price = (currency: string): PriceEvidence => ({ item: 'a cask', price: '12', currency, date: '1720', context: 'market', reliability: 'high', claimKeys: [] });
    const c = currenciesOf(dossier([], [price('Dutch guilders'), price('rijksdaalders')]));
    expect(c.has('guilder')).toBe(true);
    expect(c.has('rijksdaalder')).toBe(true);
    expect(c.has('dutch')).toBe(false);
  });
});

describe('moneyFacts: every sum the cited claims state, and what it is', () => {
  it('tells a price, a total and a wage apart, and reads only the claims in the set', () => {
    const facts = moneyFacts(tulip(), keys('C003', 'C008', 'C018'));
    const of = (key: string) => facts.find((f) => f.claimKey === key)!;
    expect(facts.map((f) => f.claimKey).sort()).toEqual(['C003', 'C008', 'C018']);
    expect(of('C008')).toMatchObject({ amount: 1200, kind: 'PRICE', total: false, verdict: 'PROBABLE', confidence: 'MEDIUM' });
    expect(of('C003')).toMatchObject({ amount: 90_000, kind: 'PRICE', total: true, year: 1637, item: 'Alkmaar auction (total)' });
    expect(of('C018')).toMatchObject({ amount: 300, kind: 'CONTEMPORARY_WAGE', period: 'year', who: 'a skilled craftsman' });
  });
});

// ── Contexts ─────────────────────────────────────────────────────────────────

describe('moneyContexts: what a sum meant, from the evidence only', () => {
  it('sets a price beside a contemporary wage from the cited claims, as a ratio a narrator can say', () => {
    const contexts = moneyContexts(tulip(), keys('C008', 'C018'));
    expect(contexts).toHaveLength(1);
    const c = contexts[0]!;
    expect(c).toMatchObject({
      id: 'M1',
      amount: 1200,
      amountText: '1,200',
      currency: 'guilder',
      comparisonType: 'CONTEMPORARY_WAGE',
      comparisonValue: WAGE_C018,
      ratio: 4,
      explanation: "about four years' pay for a skilled craftsman",
      sourceClaimKeys: ['C008', 'C018'],
      verdict: 'PROBABLE',
      presentation: 'HEDGE',
      confidence: 'MEDIUM',
      approximate: true,
    });
    expect(() => HistoricalMoneyContext.parse(c)).not.toThrow();
  });

  it('records a method an editor can check: both claims, both figures, the sum and how it is said', () => {
    const { methodology } = moneyContexts(tulip(), keys('C008', 'C018'))[0]!;
    expect(methodology).toContain('C008');
    expect(methodology).toContain('1,200');
    expect(methodology).toContain('C018');
    expect(methodology).toContain('300');
    expect(methodology).toContain('1200 ÷ 300 = 4');
    expect(methodology).toContain("about four years' pay for a skilled craftsman");
  });

  it('takes the weaker verdict and the lowest confidence of the two claims it rests on', () => {
    const stronger = moneyContexts(tulipWith({ C008: { verdict: 'ESTABLISHED', confidence: 'HIGH' } }), keys('C008', 'C018'))[0]!;
    expect(stronger).toMatchObject({ verdict: 'PROBABLE', presentation: 'HEDGE', confidence: 'MEDIUM' });

    const unsureWage = moneyContexts(tulipWith({ C008: { verdict: 'ESTABLISHED', confidence: 'HIGH' }, C018: { verdict: 'ESTABLISHED', confidence: 'LOW' } }), keys('C008', 'C018'))[0]!;
    expect(unsureWage).toMatchObject({ verdict: 'ESTABLISHED', presentation: 'STATE', confidence: 'LOW' });

    const bothSolid = moneyContexts(tulipWith({ C008: { verdict: 'ESTABLISHED', confidence: 'HIGH' }, C018: { verdict: 'ESTABLISHED', confidence: 'HIGH' } }), keys('C008', 'C018'))[0]!;
    expect(bothSolid).toMatchObject({ verdict: 'ESTABLISHED', presentation: 'STATE', confidence: 'HIGH' });
  });

  it('keeps a disputed price disputed: the comparison must be told as disputed', () => {
    const contexts = moneyContexts(tulip(), keys('C009', 'C018'));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      amount: 5500,
      item: 'Semper Augustus (one bulb)',
      date: '1637',
      sourceClaimKeys: ['C009', 'C018'],
      verdict: 'DISPUTED',
      presentation: 'PRESENT_AS_DISPUTED',
      confidence: 'LOW',
      ratio: 18.33,
      explanation: "more than eighteen years' pay for a skilled craftsman",
    });
  });

  it('never sets a total beside a wage', () => {
    expect(moneyContexts(tulip(), keys('C003', 'C018'))).toEqual([]);
    const all = moneyContexts(tulip(), keys('C003', 'C008', 'C009', 'C018'));
    expect(all.some((c) => c.amount === 90_000)).toBe(false);
  });

  it('numbers the contexts M1, M2… from the smallest sum', () => {
    const all = moneyContexts(tulip(), keys('C003', 'C008', 'C009', 'C018'));
    expect(all.map((c) => [c.id, c.amount])).toEqual([
      ['M1', 1200],
      ['M2', 5500],
    ]);
  });

  it('uses only the claims in the claim set', () => {
    expect(moneyContexts(tulip(), keys('C003', 'C008', 'C009'))).toEqual([]);
    expect(moneyContexts(tulip(), keys('C018'))).toEqual([]);
    expect(moneyContexts(tulip(), keys('C008', 'C018', 'C999'))).toHaveLength(1);
  });

  it('reads a wage written in words whole before working out the ratio', () => {
    const evidence = tulipWith({ C018: { statement: 'A skilled craftsman earned two hundred and fifty guilders a year.', citations: [] } });
    const c = moneyContexts(evidence, keys('C008', 'C018'))[0]!;
    expect(c.ratio).toBe(4.8);
    expect(c.explanation).toBe("nearly five years' pay for a skilled craftsman");
  });

  it('reads what a sum in words is from the words around the whole sum, not from a word that happens to contain its first word', () => {
    // "honest" contains "one": the wage and its period are read around "one hundred and fifty", where they are.
    const evidence = tulipWith({ C018: { statement: 'A skilled craftsman of honest trade earned one hundred and fifty guilders a year.', citations: [] } });
    expect(moneyFacts(evidence, keys('C018'))).toMatchObject([{ amount: 150, amountText: 'one hundred and fifty', kind: 'CONTEMPORARY_WAGE', period: 'year', who: 'a skilled craftsman' }]);
    const c = moneyContexts(evidence, keys('C008', 'C018'))[0]!;
    expect(c).toMatchObject({ comparisonType: 'CONTEMPORARY_WAGE', ratio: 8, explanation: "about eight years' pay for a skilled craftsman" });
  });

  describe('on a dossier from another domain', () => {
    const SHARE = 'In 1720 a single share in the company sold for 1,000 pounds.';
    const WAGE = 'A labourer earned about 25 pounds a year in the 1720s.';
    const HOUSE = 'A house in the town was worth 300 pounds in 1720.';
    const LATER_WAGE = 'By 1790 a labourer earned about 40 pounds a year.';

    it('prefers a contemporary wage, then sets other comparisons in the evidence’s own words', () => {
      const evidence = dossier([
        { key: 'S1', statement: SHARE },
        { key: 'S2', statement: WAGE, verdict: 'PROBABLE', confidence: 'MEDIUM' },
        { key: 'S3', statement: HOUSE },
      ]);
      const contexts = moneyContexts(evidence, keys('S1', 'S2', 'S3'));
      expect(contexts.map((c) => c.comparisonType)).toEqual(['CONTEMPORARY_WAGE', 'ASSET']);
      expect(contexts[0]).toMatchObject({ amount: 1000, ratio: 40, explanation: "about forty years' pay for a labourer", sourceClaimKeys: ['S1', 'S2'], verdict: 'PROBABLE', approximate: true });
      expect(contexts[1]).toMatchObject({ amount: 1000, ratio: null, comparisonValue: HOUSE, sourceClaimKeys: ['S1', 'S3'], verdict: 'ESTABLISHED', confidence: 'HIGH', approximate: false });
      expect(contexts[1]!.explanation).toContain(HOUSE);
      for (const c of contexts) expect(() => HistoricalMoneyContext.parse(c)).not.toThrow();
    });

    it('compares only within the same era', () => {
      const evidence = dossier([
        { key: 'S1', statement: SHARE },
        { key: 'S4', statement: LATER_WAGE },
      ]);
      expect(moneyFacts(evidence, keys('S4'))).toMatchObject([{ kind: 'CONTEMPORARY_WAGE', year: 1790 }]);
      expect(moneyContexts(evidence, keys('S1', 'S4'))).toEqual([]);
    });

    it('says how a sum close to a wage, or well below it, compares', () => {
      const evidence = dossier([
        { key: 'S2', statement: WAGE },
        { key: 'S5', statement: 'In 1720 a fine coat sold for 24 pounds.' },
        { key: 'S6', statement: 'In 1720 a pair of boots sold for 5 pounds.' },
      ]);
      const contexts = moneyContexts(evidence, keys('S2', 'S5', 'S6'));
      expect(contexts.map((c) => [c.amount, c.explanation])).toEqual([
        [5, "a fraction of a year's pay for a labourer"],
        [24, "about a year's pay for a labourer"],
      ]);
      expect(contexts.every((c) => c.approximate)).toBe(true);
    });

    it('never converts between currencies: a wage in another currency gives no context', () => {
      const evidence = dossier([
        { key: 'S1', statement: SHARE },
        { key: 'S7', statement: 'A weaver in Leiden earned about 250 guilders a year in 1720.' },
      ], [{ item: 'cloth', price: '250', currency: 'guilders', date: '1720', context: 'wages', reliability: 'high', claimKeys: [] }]);
      expect(moneyFacts(evidence, keys('S7'))).toMatchObject([{ kind: 'CONTEMPORARY_WAGE', currency: 'guilder', period: 'year' }]);
      expect(moneyContexts(evidence, keys('S1', 'S7'))).toEqual([]);
    });

    it('gives a modern estimate only when the evidence gives one in the same sentence: approximate, and LOW confidence', () => {
      const ESTIMATE = 'In 1720 a single share sold for 1,000 pounds, which one historian puts at roughly 150,000 pounds in today’s money.';
      const evidence = dossier([{ key: 'S8', statement: ESTIMATE }]);
      const contexts = moneyContexts(evidence, keys('S8'));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ amount: 1000, comparisonType: 'MODERN_ESTIMATE', explanation: ESTIMATE, ratio: null, sourceClaimKeys: ['S8'], verdict: 'ESTABLISHED', confidence: 'LOW', approximate: true });
      expect(contexts[0]!.methodology).toContain('approximate');
    });

    it('never applies a modern estimate (or an exchange rate) to another sum', () => {
      const evidence = dossier([
        { key: 'S8', statement: 'In 1720 a single share sold for 1,000 pounds, which one historian puts at roughly 150,000 pounds in today’s money.' },
        { key: 'S9', statement: 'In 1721 a share sold for 200 pounds.' },
      ]);
      const contexts = moneyContexts(evidence, keys('S8', 'S9'));
      expect(contexts.map((c) => [c.amount, c.comparisonType, c.sourceClaimKeys])).toEqual([[1000, 'MODERN_ESTIMATE', ['S8']]]);
      expect(JSON.stringify(contexts)).not.toContain('30,000');
    });

    it('gives no context at all when the evidence has no comparison', () => {
      const evidence = dossier([{ key: 'S1', statement: SHARE }]);
      expect(moneyFacts(evidence, keys('S1')).map((f) => f.kind)).toEqual(['PRICE']);
      expect(moneyContexts(evidence, keys('S1'))).toEqual([]);
    });
  });

  it('never applies a rate the evidence gives for one sum to another sum (tulip dossier)', () => {
    const input = fakeEvidenceInput();
    const rate = { ...input.claims.find((c) => c.key === 'C008')!, key: 'C900', id: 'claim-C900', verdict: 'ESTABLISHED' as const, confidence: 'HIGH' as const, statement: 'One guilder of 1637 had the purchasing power of about 10 euros in today’s money.', citations: [] };
    const evidence = new EvidenceBase({ ...input, claims: [...input.claims, rate] });
    const contexts = moneyContexts(evidence, keys('C008', 'C900'));
    expect(contexts.filter((c) => c.amount === 1200)).toEqual([]);
    // The rate stays with the one sum it is given for, in its own words; nothing is multiplied out.
    expect(contexts.map((c) => [c.amount, c.comparisonType, c.sourceClaimKeys, c.ratio])).toEqual([[1, 'MODERN_ESTIMATE', ['C900'], null]]);
    expect(JSON.stringify(contexts)).not.toContain('12,000');
  });
});

describe('spokenRatio: a ratio as a narrator says it', () => {
  it('rounds to a whole number and says how close it is', () => {
    expect(spokenRatio(4)).toEqual({ phrase: 'about four', value: 4 });
    expect(spokenRatio(4.8)).toEqual({ phrase: 'nearly five', value: 5 });
    expect(spokenRatio(18.33)).toEqual({ phrase: 'more than eighteen', value: 18 });
  });

  it('says "about" only within a small margin of the whole number', () => {
    expect(spokenRatio(4.1).phrase).toBe('about four');
    expect(spokenRatio(3.9).phrase).toBe('about four');
    expect(spokenRatio(4.2).phrase).toBe('more than four');
    expect(spokenRatio(3.8).phrase).toBe('nearly four');
  });

  it('rounds large ratios to fives', () => {
    expect(spokenRatio(40)).toEqual({ phrase: 'about forty', value: 40 });
    expect(spokenRatio(22)).toEqual({ phrase: 'more than twenty', value: 20 });
    expect(spokenRatio(24)).toEqual({ phrase: 'nearly twenty-five', value: 25 });
  });
});

// ── The narration ────────────────────────────────────────────────────────────

describe('moneyInNarration and moneyGaps: the sums the narrator says', () => {
  const evidence = tulip();
  const contexts = moneyContexts(evidence, keys('C003', 'C008', 'C009', 'C018'));
  const currencies = currenciesOf(evidence);
  const SUM = block('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.');

  it('finds each sum the narrator says, with the context the evidence offers for it', () => {
    const uses = moneyInNarration([SUM], contexts, currencies);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.ref).toBe('2.1');
    expect(uses[0]!.mention).toMatchObject({ amount: 1200, currency: 'guilder' });
    expect(uses[0]!.contexts.map((c) => c.id)).toEqual(['M1']);
    expect(uses[0]!.contextualised).toBe(false);
  });

  it('counts a sum as contextualised when its block or a neighbour in the same section says what it meant', () => {
    const meaning = "That was about four years' pay for a skilled craftsman.";
    expect(moneyInNarration([SUM, block('2.2', meaning)], contexts, currencies)[0]!.contextualised).toBe(true);
    expect(moneyInNarration([block('2.0', meaning), SUM], contexts, currencies)[0]!.contextualised).toBe(true);
    expect(moneyInNarration([block('2.1', `${SUM.text} ${meaning}`)], contexts, currencies)[0]!.contextualised).toBe(true);
  });

  it('hears a span of working time as context, whatever word follows it', () => {
    const told = (meaning: string) => moneyInNarration([block('2.1', `${SUM.text} ${meaning}`)], contexts, currencies)[0]!.contextualised;
    expect(told("That was four years' work for a skilled craftsman.")).toBe(true);
    expect(told('That was more than four years’ earnings for a skilled craftsman.')).toBe(true);
    expect(told("It was two months' rent for a family.")).toBe(true);
    expect(told("It was a month's pay for a clerk.")).toBe(true);
  });

  it('does not take the words that only lead up to a sum for its meaning', () => {
    const plain = (text: string) => moneyInNarration([block('2.1', text)], contexts, currencies)[0]!.contextualised;
    expect(plain('Cornelis Proefman agreed to pay 1,200 guilders for a single bulb.')).toBe(false);
    expect(plain('He paid 1,200 guilders for a single bulb.')).toBe(false);
    expect(plain('He bought bulbs worth more than 1,200 guilders.')).toBe(false);
    expect(plain('The bulbs came at a cost of 1,200 guilders.')).toBe(false);
    // A sum said as a rate is a wage or an income: that is what it meant.
    expect(plain('A craftsman was paid about 300 guilders a year.')).toBe(true);
    // The same words around something other than the sum still give it meaning.
    expect(plain('He paid 1,200 guilders, as much as a house in the town.')).toBe(true);
  });

  it('does not borrow meaning from another section, or from a block further away', () => {
    const meaning = "That was about four years' pay for a skilled craftsman.";
    expect(moneyInNarration([SUM, block('3.1', meaning)], contexts, currencies)[0]!.contextualised).toBe(false);
    expect(moneyInNarration([SUM, block('2.2', 'The grower took him to court.'), block('2.3', meaning)], contexts, currencies)[0]!.contextualised).toBe(false);
  });

  it("leaves cast speech and quotations out: they are the record's words", () => {
    const spoken = block('2.1', 'I gave 1,200 guilders for those bulbs.', { speakerId: 'R1' });
    const quoted = block('2.2', 'The notary wrote: "he had bought the bulbs for 1,200 guilders."');
    expect(moneyInNarration([spoken, quoted], contexts, currencies)).toEqual([]);
  });

  it('says the gap plainly when neither the narration nor the evidence gives a sum meaning', () => {
    const uses = moneyInNarration([block('1.1', 'The Alkmaar sale raised 90,000 guilders.'), SUM], contexts, currencies);
    const gaps = moneyGaps(uses);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ ref: '1.1', amountText: '90,000', currency: 'guilder' });
    expect(gaps[0]!.note.startsWith(NO_EQUIVALENT)).toBe(true);
    expect(gaps[0]!.note).toContain('No claim the architecture cites sets 90,000 guilders beside a wage');
    expect(NO_EQUIVALENT).toBe("The surviving records don't give us a reliable equivalent.");
  });

  it('still names the gap when the narration only says who paid the sum', () => {
    const gaps = moneyGaps(moneyInNarration([block('1.1', 'Buyers at Alkmaar paid 90,000 guilders in all.')], contexts, currencies));
    expect(gaps.map((g) => [g.ref, g.amountText])).toEqual([['1.1', '90,000']]);
  });

  it('is not a gap when the evidence offers a context (that is an editorial finding) or the narration already gives one', () => {
    expect(moneyGaps(moneyInNarration([SUM], contexts, currencies))).toEqual([]);
    expect(moneyGaps(moneyInNarration([block('1.1', 'The Alkmaar sale raised 90,000 guilders, more than any sale before it.')], contexts, currencies))).toEqual([]);
  });

  it('with no comparison in the evidence, gives no context and names the gap', () => {
    const evidence = dossier([{ key: 'S1', statement: 'In 1720 a single share in the company sold for 1,000 pounds.' }]);
    const none = moneyContexts(evidence, keys('S1'));
    expect(none).toEqual([]);
    const uses = moneyInNarration([block('1.1', 'By the summer a single share sold for 1,000 pounds.')], none, currenciesOf(evidence));
    expect(uses[0]!.contexts).toEqual([]);
    expect(moneyGaps(uses).map((g) => g.note.slice(0, NO_EQUIVALENT.length))).toEqual([NO_EQUIVALENT]);
  });
});

describe('renderMoneyContexts: the money context, for a prompt', () => {
  it('with none, says plainly what to do and never to invent a comparison', () => {
    const text = renderMoneyContexts([]);
    expect(text).toContain(NO_EQUIVALENT);
    expect(text).toContain('never invent a comparison or a modern conversion');
  });

  it('gives each context with its claims, the wording its verdict requires and its method', () => {
    const text = renderMoneyContexts(moneyContexts(tulip(), keys('C008', 'C009', 'C018')));
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    const [first, second] = lines;
    expect(first).toMatch(/^- money context M1: 1,200 guilders — about four years' pay for a skilled craftsman\. /);
    expect(first).toContain('Rests on C008 and C018 (PROBABLE: hedge)');
    expect(first).toContain('confidence medium');
    expect(first).toContain('say "about"');
    expect(first).toContain('1200 ÷ 300 = 4');
    expect(second).toMatch(/^- money context M2: 5,500 guilders \(Semper Augustus \(one bulb\)\) — more than eighteen years' pay for a skilled craftsman\. /);
    expect(second).toContain('(DISPUTED: present as disputed)');
    expect(second).toContain('confidence low');
  });
});
