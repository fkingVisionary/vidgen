import { WRITING_CATEGORIES, type WritingExampleDecisionInput } from '@docengine/core';
import type { Database, WritingExample } from '@docengine/database';
import { describe, expect, it } from 'vitest';
import { aiSignals } from './fingerprints.ts';
import { ExampleDecisionError, approvedHouseExamples, candidateLines, decideExample, textHash, toCorpusExample, type CandidateProposal } from './house.ts';
import { countWords, type NarrationBlock } from './text.ts';

/**
 * House-style evolution (pure part): an approved script proposes lines worth
 * keeping as examples — never automatically approved, and only lines that
 * are a model to follow: narrator lines (never a speaker's), of a speakable
 * length (8–90 words), with no AI-pattern signal at all, at most two per
 * category, a hook from the film's opening and an ending from its last
 * section. A person's decision is tested on a one-row stand-in for the table;
 * saving to the database is tested with the API.
 */

const block = (key: string, text: string, extra: Partial<NarrationBlock> = {}): NarrationBlock => ({
  key,
  section: Number(key.split('.')[0]),
  text,
  infoClass: 'DOCUMENTED',
  speakerId: null,
  claimKeys: [],
  ...extra,
});

/** A fixture with no AI-pattern signal anywhere (so only the rule under test decides). */
function clean(film: NarrationBlock[]): NarrationBlock[] {
  expect(aiSignals(film)).toEqual([]);
  return film;
}

const keysOf = (ps: readonly CandidateProposal[]) => ps.map((p) => p.blockKey);
const categoryOf = (ps: readonly CandidateProposal[], key: string) => ps.find((p) => p.blockKey === key)?.category;

/** A plain line of exactly `n` words (no figures, no signals). */
const words = (n: number, lead = 'The') => [lead, ...Array.from({ length: n - 1 }, (_, i) => ['merchants', 'kept', 'careful', 'records', 'of', 'every', 'sale', 'in', 'the', 'town'][i % 10])].join(' ') + '.';

/**
 * An approved three-section film. Every narrator line here is clean, except
 * 2.6 (machine habits) and 2.7 (too short); 1.3 and 3.3 are spoken by a cast
 * member.
 */
const FILM: NarrationBlock[] = [
  block('1.1', 'In the winter of 1637, a single tulip bulb could change hands five times in a week.', { claimKeys: ['C003'] }),
  block('1.2', 'Cornelis Proefman agreed to pay 1,200 guilders for one bulb, about four years of a craftsman’s wages.', { claimKeys: ['C008', 'C018'] }),
  block('1.3', 'I will sign for the bulbs tomorrow, whatever the price is by then, and my brother will witness it.', { speakerId: 'R1', infoClass: 'FICTION' }),
  block('2.1', 'The buyers met in the back rooms of taverns, where the trade had its own rules.', { claimKeys: ['C004'] }),
  block('2.2', 'Some accounts say one bulb was offered for 5,500 guilders, but no signed contract survives.', { infoClass: 'UNCERTAIN', claimKeys: ['C009'] }),
  block('2.3', 'A clerk copies the agreed price into the tavern ledger before the buyer can change his mind.', { infoClass: 'RECONSTRUCTION' }),
  block('2.4', 'Nobody could say what a bulb in the ground was worth, so the price was whatever the next buyer would pay.'),
  block('2.5', 'Most of the contracts were promises to pay in the spring, when the bulbs could be lifted.'),
  block('2.6', 'Little did they know, everything was about to change.'),
  block('2.7', 'Nobody paid.'),
  block('3.1', 'In February 1637 the buyers in Haarlem stopped coming to the taverns at all.', { claimKeys: ['C010'] }),
  block('3.2', 'The courts of Holland would not enforce the contracts, and most were settled for a fraction.', { claimKeys: ['C012'] }),
  block('3.3', 'We all signed, and none of us ever paid what we had promised to pay for them.', { speakerId: 'R1', infoClass: 'FICTION' }),
  block('3.4', 'The bulbs were still in the ground, and the debts were still on paper.'),
];

describe('candidateLines on an approved film', () => {
  const proposals = candidateLines(FILM, { moneyRefs: new Set(['1.2']) });

  it('the fixture is what it says: only 2.6 has an AI-pattern signal', () => {
    expect([...new Set(aiSignals(FILM).map((s) => s.ref))]).toEqual(['2.6']);
  });

  it('proposes the clean narrator lines in script order, one category each', () => {
    expect(proposals.map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'economics'],
      ['2.1', 'transition'],
      ['2.2', 'uncertainty'],
      ['2.3', 'scene'],
      ['2.4', 'explanation'],
      ['2.5', 'explanation'],
      ['3.1', 'transition'],
      ['3.4', 'ending'],
    ]);
  });

  it('leaves out a third explanation: 3.2 is clean, but 2.4 and 2.5 already explain', () => {
    expect(keysOf(proposals)).not.toContain('3.2');
    expect(proposals.filter((p) => p.category === 'explanation').map((p) => p.blockKey)).toEqual(['2.4', '2.5']);
  });

  it('takes the hook from the opening line of the film', () => {
    expect(proposals[0]).toEqual({
      blockKey: '1.1',
      text: FILM[0]!.text,
      category: 'hook',
      traits: ['restraint', 'curiosity'],
      narrativeFunction: 'Opens the film',
      spokenRhythm: '1 sentence(s) of 17 words',
    });
    expect(proposals.filter((p) => p.category === 'hook')).toHaveLength(1);
  });

  it('takes the ending from the last narrator line of the last section', () => {
    expect(proposals.at(-1)).toMatchObject({ blockKey: '3.4', category: 'ending', traits: ['payoff', 'restraint'], narrativeFunction: 'Ends the film' });
    expect(proposals.filter((p) => p.category === 'ending')).toHaveLength(1);
  });

  it('never proposes a speaker’s line, however clean and well placed', () => {
    expect(keysOf(proposals)).not.toContain('1.3');
    expect(keysOf(proposals)).not.toContain('3.3');
  });

  it('never proposes a line with a machine habit, or one too short to teach anything', () => {
    expect(keysOf(proposals)).not.toContain('2.6');
    expect(keysOf(proposals)).not.toContain('2.7');
  });

  it('copies the line word for word, with what it does in the film and how it moves', () => {
    for (const p of proposals) expect(p.text).toBe(FILM.find((b) => b.key === p.blockKey)!.text);
    expect(proposals.find((p) => p.blockKey === '1.2')).toMatchObject({ traits: ['money_context', 'number_in_context'], narrativeFunction: 'Gives a sum of money its meaning' });
    expect(proposals.find((p) => p.blockKey === '2.1')).toMatchObject({ traits: ['transition_by_consequence'], narrativeFunction: 'Opens a section' });
    expect(proposals.find((p) => p.blockKey === '2.2')).toMatchObject({ traits: ['hedge_natural'], narrativeFunction: 'Tells uncertain history at its level' });
    expect(proposals.find((p) => p.blockKey === '2.3')).toMatchObject({ traits: ['visual_separation'], narrativeFunction: 'Sets a scene the pictures show' });
    expect(proposals.find((p) => p.blockKey === '2.4')).toMatchObject({ traits: ['plain_language'], narrativeFunction: 'Explains what happened' });
    expect(proposals.every((p) => (WRITING_CATEGORIES as readonly string[]).includes(p.category))).toBe(true);
  });
});

describe('what makes a line a candidate', () => {
  it('excludes a line with any signal, even a DENSITY one that nobody would act on', () => {
    // One "It wasn't X. It was Y." is fine in a script — but a house example is a model to follow.
    const film = [block('1.1', words(12)), block('1.2', 'It wasn’t a market in flowers at all. It was a market in promises to pay.'), block('1.3', words(10, 'Every'))];
    expect(aiSignals(film).filter((s) => s.ref === '1.2').map((s) => [s.pattern, s.kind])).toEqual([['contrast_formula', 'DENSITY']]);
    expect(keysOf(candidateLines(film))).toEqual(['1.1', '1.3']);
  });

  it('keeps to 8–90 words: 7 and 91 are out, 8 and 90 are in', () => {
    expect([7, 8, 90, 91].map((n) => countWords(words(n)))).toEqual([7, 8, 90, 91]);
    const film = [block('1.1', words(12, 'Opening')), block('2.1', words(7)), block('2.2', words(8)), block('2.3', words(90)), block('2.4', words(91)), block('3.1', words(12, 'Closing'))];
    // Only lines without signals can be compared; the long ones repeat words but carry no machine habit.
    expect(aiSignals(film)).toEqual([]);
    expect(keysOf(candidateLines(film))).toEqual(['1.1', '2.2', '2.3', '3.1']);
  });

  it('proposes at most two lines per category, the first two in script order', () => {
    const film = clean([
      block('1.1', 'The guild of florists in Haarlem kept no register of its members.'),
      block('1.2', 'Its members traded bulbs from the back rooms of the taverns they owned.'),
      block('1.3', 'Most of them had other trades, and the bulbs were a sideline at first.'),
      block('1.4', 'A weaver might sell a bulb in the evening and his cloth in the morning.'),
      block('1.5', 'By the end of the year the sideline had become a living for some of them.'),
      block('1.6', 'The town council, which taxed everything else, did not tax the bulbs.'),
    ]);
    const proposals = candidateLines(film);
    expect(proposals.map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'explanation'],
      ['1.3', 'explanation'],
      ['1.6', 'ending'],
    ]);
  });

  it('a category that is full does not push a line into another category', () => {
    const film = clean([
      block('1.1', 'The guild of florists in Haarlem kept no register of its members.'),
      block('1.2', 'Some say the first bulbs reached the town in a merchant’s luggage, wrapped in cloth among the spices he had bought in the east.', { infoClass: 'UNCERTAIN' }),
      block('1.3', 'Others say a botanist in Leiden gave them away.', { infoClass: 'UNCERTAIN' }),
      block('1.4', 'A third story credits a gardener who had once worked for the emperor in Vienna.', { infoClass: 'UNCERTAIN' }),
      block('1.5', 'What the records do show is a sale.'),
    ]);
    expect(candidateLines(film).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'uncertainty'],
      ['1.3', 'uncertainty'],
      ['1.5', 'ending'],
    ]);
  });

  it('proposes a wording only once, even when the film says it twice', () => {
    const refrain = 'The bulbs were still in the ground, and the debts were still on paper.';
    const film = clean([block('1.1', words(12, 'Opening')), block('2.1', refrain), block('2.2', words(10, 'Every')), block('2.3', refrain.toUpperCase()), block('3.1', words(12, 'Closing'))]);
    const proposals = candidateLines(film);
    expect(proposals.filter((p) => p.text.toLowerCase() === refrain.toLowerCase()).map((p) => p.blockKey)).toEqual(['2.1']);
    // 2.3 is left out as a repeat, not because its category was full: without 2.1 it is proposed.
    expect(categoryOf(candidateLines(film.filter((b) => b.key !== '2.1')), '2.3')).toBe('explanation');
  });

  it('stops at twelve proposals by default, and at `max` when given', () => {
    // Eight sections of three clean lines, with money, people, hedges and scenes spread among them: more than twelve lines qualify.
    const film: NarrationBlock[] = [];
    const classes = ['DOCUMENTED', 'UNCERTAIN', 'RECONSTRUCTION'] as const;
    for (let s = 1; s <= 8; s++) for (let b = 1; b <= 3; b++) film.push(block(`${s}.${b}`, `${words(8 + s + b, `Section${s}line${b}`)}`, { infoClass: classes[(s + b) % 3]! }));
    const money = new Set(film.filter((_, i) => i % 5 === 2).map((b) => b.key));
    const people = new Set(film.filter((_, i) => i % 7 === 4).map((b) => b.key));
    const all = candidateLines(film, { moneyRefs: money, firstMentions: people, max: 100 });
    expect(all.length).toBeGreaterThan(12);
    expect(keysOf(candidateLines(film, { moneyRefs: money, firstMentions: people }))).toEqual(keysOf(all.slice(0, 12)));
    expect(keysOf(candidateLines(film, { moneyRefs: money, firstMentions: people, max: 3 }))).toEqual(keysOf(all.slice(0, 3)));
  });

  it('proposes nothing from an empty script, or from one with only speakers', () => {
    expect(candidateLines([])).toEqual([]);
    expect(candidateLines([block('1.1', words(12), { speakerId: 'R1' }), block('1.2', words(14), { speakerId: 'R2' })])).toEqual([]);
  });
});

describe('the place of a line decides its category', () => {
  it('the hook is the first narrator line, even when a cast member speaks first', () => {
    const film = clean([block('1.1', words(12, 'Spoken'), { speakerId: 'R1' }), block('1.2', words(12, 'Opening')), block('1.3', words(10, 'Every'))]);
    expect(candidateLines(film).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.2', 'hook'],
      ['1.3', 'ending'],
    ]);
  });

  it('only the opening of the first section is a hook: later sections open with a transition', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('1.2', words(10, 'Every')), block('2.1', words(11, 'Later')), block('3.1', words(12, 'Closing')), block('3.2', words(9, 'Final'))]);
    expect(candidateLines(film).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'explanation'],
      ['2.1', 'transition'],
      ['3.1', 'transition'],
      ['3.2', 'ending'],
    ]);
  });

  it('the ending is the last narrator line, even when a cast member has the last word', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('2.1', words(11, 'Later')), block('2.2', words(10, 'Final')), block('2.3', words(12, 'Spoken'), { speakerId: 'R1' })]);
    expect(categoryOf(candidateLines(film), '2.2')).toBe('ending');
    expect(keysOf(candidateLines(film))).not.toContain('2.3');
  });

  it('an ending only comes from the last section: the last line of an earlier section is not one', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('1.2', words(10, 'Every')), block('2.1', words(11, 'Later')), block('2.2', words(10, 'Final'), { infoClass: 'UNCERTAIN' })]);
    const proposals = candidateLines(film);
    expect(categoryOf(proposals, '1.2')).toBe('explanation');
    expect(categoryOf(proposals, '2.2')).toBe('ending');
  });

  it('no hook is proposed when the film’s first narrator line is not a model (it is not replaced by a later line)', () => {
    const habit = [block('1.1', 'Little did they know, everything was about to change.'), block('1.2', words(10, 'Every')), block('2.1', words(12, 'Closing'))];
    expect(aiSignals(habit).map((s) => s.ref)).toContain('1.1');
    expect(candidateLines(habit).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.2', 'explanation'],
      ['2.1', 'ending'],
    ]);
    const short = [block('1.1', 'Nobody paid.'), block('1.2', words(10, 'Every')), block('2.1', words(12, 'Closing'))];
    expect(candidateLines(short).some((p) => p.category === 'hook')).toBe(false);
  });

  it('a last section of one line gives the ending (not a transition), and a film of one line gives only a hook', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('1.2', words(10, 'Every')), block('2.1', words(12, 'Closing'))]);
    expect(candidateLines(film).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'explanation'],
      ['2.1', 'ending'],
    ]);
    expect(candidateLines(clean([block('1.1', words(12, 'Opening'))])).map((p) => [p.blockKey, p.category])).toEqual([['1.1', 'hook']]);
  });

  it('no ending is proposed when the film’s last narrator line is not a model (it is not replaced by an earlier line)', () => {
    const film = [block('1.1', words(12, 'Opening')), block('2.1', words(11, 'Later')), block('2.2', words(10, 'Every')), block('2.3', 'Nobody paid.')];
    const proposals = candidateLines(film);
    expect(proposals.some((p) => p.category === 'ending')).toBe(false);
    expect(categoryOf(proposals, '2.2')).toBe('explanation');
  });

  it('a line with money context is economics, and the first mention of a person is character', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('2.1', words(20, 'Later')), block('2.2', words(9, 'Money')), block('2.3', words(16, 'Person')), block('2.4', words(30, 'Plain')), block('3.1', words(12, 'Closing'))]);
    const proposals = candidateLines(film, { moneyRefs: new Set(['2.2']), firstMentions: new Set(['2.3']) });
    expect(categoryOf(proposals, '2.2')).toBe('economics');
    expect(proposals.find((p) => p.blockKey === '2.3')).toMatchObject({ category: 'character', traits: ['character_intro'], narrativeFunction: 'Introduces a person' });
    expect(categoryOf(proposals, '2.4')).toBe('explanation');
  });

  it('the opening and the ending outrank money and people; money outranks a person, a person outranks a hedge', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('2.1', words(20, 'Later')), block('2.2', words(9, 'Both')), block('2.3', words(16, 'Hedged'), { infoClass: 'UNCERTAIN' }), block('3.1', words(12, 'Closing'))]);
    const proposals = candidateLines(film, { moneyRefs: new Set(['1.1', '2.2', '3.1']), firstMentions: new Set(['1.1', '2.2', '2.3', '3.1']) });
    expect(proposals.map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['2.1', 'transition'],
      ['2.2', 'economics'],
      ['2.3', 'character'],
      ['3.1', 'ending'],
    ]);
  });

  it('a reconstruction or a fiction is a scene; an uncertain line is uncertainty', () => {
    const film = clean([block('1.1', words(12, 'Opening')), block('1.2', words(20, 'Staged'), { infoClass: 'RECONSTRUCTION' }), block('1.3', words(9, 'Invented'), { infoClass: 'FICTION' }), block('1.4', words(16, 'Hedged'), { infoClass: 'UNCERTAIN' }), block('1.5', words(30, 'Closing'))]);
    expect(candidateLines(film).map((p) => [p.blockKey, p.category])).toEqual([
      ['1.1', 'hook'],
      ['1.2', 'scene'],
      ['1.3', 'scene'],
      ['1.4', 'uncertainty'],
      ['1.5', 'ending'],
    ]);
  });

  it('describes the spoken rhythm sentence by sentence', () => {
    const film = [block('1.1', 'Nobody kept the minutes. The council met anyway, every week, in the back room of the inn.')];
    expect(candidateLines(film)[0]!.spokenRhythm).toBe('2 sentence(s) of 4, 13 words');
  });
});

describe('textHash: one wording, one example', () => {
  it('is the same for wordings that differ only in case, spacing and typographic quotes', () => {
    expect(textHash('The bulbs’ price  rose.')).toBe(textHash("the bulbs' price rose."));
    expect(textHash('The bulbs’ price rose.')).not.toBe(textHash('The bulbs’ price fell.'));
    expect(textHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decideExample: an approved example is one retrieval can use', () => {
  const line = FILM.find((b) => b.key === '2.4')!.text;
  const CANDIDATE: WritingExample = {
    id: 'row-1',
    exampleId: 'house-0000abcd-2-4',
    version: 1,
    projectId: null,
    scriptId: null,
    scriptVersion: 3,
    blockKey: '2.4',
    text: line,
    textHash: textHash(line),
    category: 'explanation',
    quality: 'good',
    traits: ['plain_language'],
    strengths: [],
    weaknesses: [],
    spokenRhythm: candidateLines(FILM).find((p) => p.blockKey === '2.4')!.spokenRhythm,
    narrativeFunction: 'Explains what happened',
    whyItWorks: null,
    whyItFails: null,
    sourceType: 'house',
    sourceReference: 'Approved script v3, block 2.4',
    copyrightSafe: true,
    approvedForRetrieval: false,
    status: 'CANDIDATE',
    diagnostics: {},
    createdBy: 'editor',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };

  /** One house example in a stand-in for the table: what deciding writes, and what retrieval reads back. */
  function table() {
    let stored = CANDIDATE;
    const db = {
      writingExample: {
        findUnique: async () => stored,
        update: async ({ data }: { data: Partial<WritingExample> }) => (stored = { ...stored, ...data }),
        findMany: async () => (stored.status === 'APPROVED' && stored.approvedForRetrieval && stored.copyrightSafe ? [stored] : []),
      },
    } as unknown as Database;
    return { db, decide: (input: WritingExampleDecisionInput) => decideExample(db, CANDIDATE.id, input, 'editor'), row: () => stored };
  }

  it('refuses a model to avoid without why it fails, and a borderline one without both reasons: nothing is saved', async () => {
    for (const quality of ['bad', 'borderline'] as const) {
      const t = table();
      const refused = t.decide({ decision: 'APPROVE', quality, whyItWorks: 'Plain and specific (test).' });
      await expect(refused).rejects.toThrow(ExampleDecisionError);
      await expect(refused).rejects.toThrow(/^Retrieval cannot use it as it stands: a (model to avoid says why it fails|borderline example says what works and what fails)$/);
      expect(t.row()).toBe(CANDIDATE);
      expect(await approvedHouseExamples(t.db)).toEqual([]);
    }
  });

  it('approves them with their reasons, and retrieval reads them as they were approved', async () => {
    const bad = table();
    const saved = await bad.decide({ decision: 'APPROVE', quality: 'bad', whyItWorks: 'The sum is right (test).', whyItFails: 'It explains what the listener already knows (test).' });
    expect(saved).toMatchObject({ status: 'APPROVED', approvedForRetrieval: true, quality: 'bad' });
    expect(toCorpusExample(saved)).toMatchObject({ id: CANDIDATE.exampleId, quality: 'bad', whyItFails: 'It explains what the listener already knows (test).' });
    expect((await approvedHouseExamples(bad.db)).map((e) => e.id)).toEqual([CANDIDATE.exampleId]);
    const borderline = table();
    await borderline.decide({ decision: 'APPROVE', quality: 'borderline', whyItWorks: 'Plain (test).', whyItFails: 'Long for one breath (test).' });
    expect((await approvedHouseExamples(borderline.db)).map((e) => e.quality)).toEqual(['borderline']);
  });

  it('a good example still needs only why it works', async () => {
    const t = table();
    await expect(t.decide({ decision: 'APPROVE' })).rejects.toThrow(/why it works/);
    await t.decide({ decision: 'APPROVE', whyItWorks: 'Plain, specific and in proportion (test).' });
    expect((await approvedHouseExamples(t.db)).map((e) => [e.id, e.quality])).toEqual([[CANDIDATE.exampleId, 'good']]);
  });
});
