import { NameEntry, type Pronunciation } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { nameLayer, namesAltered, pronunciationRisk, type KnownName } from './names.ts';
import type { NarrationBlock } from './text.ts';

/**
 * Names in layers (Parts X and XI): the historical spelling is kept, the
 * display name is what the narration writes, the spoken form comes only from
 * a pronunciation note (no phonemes are guessed), names a narrator may say
 * wrong are flagged, and a rewording that respells a name is caught.
 */

const THIJS: KnownName = { name: 'Thijs', kind: 'PERSON', castId: 'R1', fictional: true, claimKeys: [] };
const PROEFMAN: KnownName = { name: 'Cornelis Proefman', kind: 'PERSON', castId: null, fictional: false, claimKeys: ['C008'] };
const TESTBROEK: KnownName = { name: 'Jan Testbroek', kind: 'PERSON', castId: null, fictional: false, claimKeys: ['C004'] };
const MACKAY: KnownName = { name: 'Charles Mackay', kind: 'PERSON', castId: null, fictional: false, claimKeys: ['C012'] };
const KNOWN = [THIJS, PROEFMAN, TESTBROEK, MACKAY];

const block = (key: string, text: string, o: Partial<NarrationBlock> = {}): NarrationBlock => ({ key, section: Number(key.split('.')[0]), text, infoClass: 'DOCUMENTED', speakerId: null, claimKeys: [], ...o });

const note = (term: string, o: Partial<Pronunciation> = {}): Pronunciation => ({ term, respelling: 'TICE', ipa: 'tɛis', language: 'Dutch', confidence: 'HIGH', note: 'Confirmed by the editor.', needsReview: false, source: 'EDITOR', ...o });

const BLOCKS = [
  block('1.1', 'Thijs walked to the inn with a contract in his pocket.'),
  block('1.2', 'Proefman had agreed to buy the bulbs.'),
  block('1.3', 'Cornelis Proefman never took them.'),
  block('2.1', 'Charles Mackay told the story two centuries later.'),
];

const layer = (o: { blocks?: NarrationBlock[]; pronunciations?: Pronunciation[]; otherNames?: { form: string; refs: string[] }[] } = {}) =>
  nameLayer({ known: KNOWN, blocks: o.blocks ?? BLOCKS, pronunciations: o.pronunciations ?? [], otherNames: o.otherNames });
const byName = (entries: NameEntry[], historical: string) => entries.find((e) => e.historicalName === historical);

describe('nameLayer: the names the narration uses, in layers', () => {
  it('keeps the historical spelling: "Thijs" stays "Thijs"', () => {
    const thijs = byName(layer(), 'Thijs')!;
    expect(thijs).toMatchObject({ kind: 'PERSON', castId: 'R1', fictional: true, historicalName: 'Thijs', displayName: 'Thijs' });
  });

  it('writes as the display name the form the narration uses', () => {
    expect(byName(layer(), 'Cornelis Proefman')!.displayName).toBe('Proefman');
    expect(byName(layer({ blocks: [block('1.3', 'Cornelis Proefman never took them.')] }), 'Cornelis Proefman')!.displayName).toBe('Cornelis Proefman');
  });

  it('counts the blocks that name a person, the first of them, and the claims behind the name', () => {
    const proefman = byName(layer(), 'Cornelis Proefman')!;
    expect(proefman).toMatchObject({ mentions: 2, firstRef: '1.2', claimKeys: ['C008'] });
  });

  it('leaves out names the narration does not use', () => {
    expect(byName(layer(), 'Jan Testbroek')).toBeUndefined();
  });

  it('only the narrator’s words name a person: a quotation or another speaker’s line does not', () => {
    const blocks = [block('1.1', 'The auction list reads: "the estate of Jan Testbroek, innkeeper."'), block('1.2', 'Jan Testbroek kept a tavern.', { speakerId: 'R1' })];
    expect(byName(layer({ blocks }), 'Jan Testbroek')).toBeUndefined();
  });

  it('counts a cast member’s own lines as mentions of them, even where the narration does not say the name', () => {
    const thijs = byName(layer({ blocks: [block('1.1', 'I will sign for the bulbs tomorrow.', { speakerId: 'R1' })] }), 'Thijs')!;
    expect(thijs).toMatchObject({ historicalName: 'Thijs', displayName: 'Thijs', mentions: 1, firstRef: '1.1' });
    // Narration and the cast member's own lines together, each block counted once — another speaker's line is not theirs.
    const blocks = [block('1.1', 'Thijs walked to the inn.'), block('1.2', 'Thijs, they call me. I will sign tomorrow.', { speakerId: 'R1' }), block('1.3', 'Thijs is late.', { speakerId: 'R2' })];
    expect(byName(layer({ blocks }), 'Thijs')).toMatchObject({ displayName: 'Thijs', mentions: 2, firstRef: '1.1' });
  });

  it('takes the spoken form only from a pronunciation note: without one there is none, and no phonemes are guessed', () => {
    const entries = layer();
    expect(entries.map((e) => e.historicalName)).toEqual(['Thijs', 'Cornelis Proefman', 'Charles Mackay']);
    for (const e of entries) {
      expect(e.spokenForm).toBeNull();
      expect(e.pronunciation).toBeNull();
    }
  });

  it('copies the spoken form and the note from a pronunciation note', () => {
    const thijs = byName(layer({ pronunciations: [note('Thijs')] }), 'Thijs')!;
    expect(thijs.spokenForm).toBe('TICE');
    expect(thijs.pronunciation).toEqual({ respelling: 'TICE', ipa: 'tɛis', language: 'Dutch', confidence: 'HIGH', needsReview: false, source: 'EDITOR' });
  });

  it('matches a note written for a part of the name', () => {
    const proefman = byName(layer({ pronunciations: [note('Proefman', { respelling: 'PROOF-mahn' })] }), 'Cornelis Proefman')!;
    expect(proefman.spokenForm).toBe('PROOF-mahn');
  });

  it('flags a non-English spelling without a note as a pronunciation candidate, and says why', () => {
    const thijs = byName(layer(), 'Thijs')!;
    expect(thijs.candidate).toBe(true);
    expect(thijs.candidateReasons).toHaveLength(1);
    expect(thijs.candidateReasons[0]).toContain('the spelling "ij"');
    expect(thijs.candidateReasons[0]).toContain('no pronunciation note');
    expect(byName(layer(), 'Cornelis Proefman')!.candidateReasons[0]).toContain('the spelling "oe"');
  });

  it('keeps a name a candidate while its note waits for review', () => {
    const thijs = byName(layer({ pronunciations: [note('Thijs', { confidence: 'MEDIUM', needsReview: true, source: 'MODEL' })] }), 'Thijs')!;
    expect(thijs.candidate).toBe(true);
    expect(thijs.candidateReasons).toEqual(['its pronunciation note is medium confidence and not yet confirmed']);
    expect(thijs.spokenForm).toBe('TICE');
  });

  it('settles a name with a confirmed note from the editor: no candidate', () => {
    const thijs = byName(layer({ pronunciations: [note('Thijs')] }), 'Thijs')!;
    expect(thijs.candidate).toBe(false);
    expect(thijs.candidateReasons).toEqual([]);
  });

  it('does not flag a name English readers say without trouble', () => {
    const mackay = byName(layer(), 'Charles Mackay')!;
    expect(mackay).toMatchObject({ candidate: false, candidateReasons: [], spokenForm: null });
  });

  it('adds other proper names as terms, unless a known name already covers them', () => {
    const entries = layer({ otherNames: [{ form: 'Haarlem', refs: ['1.1', '1.2'] }, { form: 'Thijs', refs: ['1.1'] }] });
    expect(entries.filter((e) => e.historicalName === 'Thijs')).toHaveLength(1);
    const haarlem = byName(entries, 'Haarlem')!;
    expect(haarlem).toMatchObject({ kind: 'TERM', castId: null, fictional: false, displayName: 'Haarlem', mentions: 2, firstRef: '1.1', claimKeys: [], candidate: true });
    expect(haarlem.candidateReasons[0]).toContain('the spelling "aa"');
  });

  it('numbers the entries N1, N2… and fits the shared contract', () => {
    const entries = layer({ otherNames: [{ form: 'Haarlem', refs: ['1.1'] }], pronunciations: [note('Thijs')] });
    expect(entries.map((e) => [e.id, e.historicalName])).toEqual([
      ['N1', 'Thijs'],
      ['N2', 'Cornelis Proefman'],
      ['N3', 'Charles Mackay'],
      ['N4', 'Haarlem'],
    ]);
    for (const e of entries) expect(() => NameEntry.parse(e)).not.toThrow();
  });
});

describe('pronunciationRisk: why a narrator might say a name wrong', () => {
  it('names the letter pairs English readers stumble over', () => {
    expect(pronunciationRisk('Thijs')).toEqual(['the spelling "ij"']);
    expect(pronunciationRisk('Cornelis Proefman')).toEqual(['the spelling "oe"']);
    expect(pronunciationRisk('Haarlem')).toEqual(['the spelling "aa"']);
    expect(pronunciationRisk('Schoonhoven')).toEqual(['the spelling "sch"']);
  });

  it('notices accented letters', () => {
    expect(pronunciationRisk('Zoë')).toEqual(['accented letters']);
  });

  it('notices a name particle in a name of more than one word', () => {
    expect(pronunciationRisk('Jan van Goyen')).toEqual(['a name particle']);
    expect(pronunciationRisk('Willem van Schoonhoven')).toEqual(['the spelling "sch"', 'a name particle']);
    expect(pronunciationRisk('Van')).toEqual([]);
  });

  it('finds no reason in a name English readers already know how to say', () => {
    expect(pronunciationRisk('Charles Mackay')).toEqual([]);
    expect(pronunciationRisk('Mary Smith')).toEqual([]);
  });
});

describe('namesAltered: a rewording that respells a name', () => {
  it('catches a respelling: "Thijs" → "Thys", "Cornelis" → "Cornelius"', () => {
    expect(namesAltered('Thijs walked to the inn.', 'Thys walked to the inn.', KNOWN)).toEqual(['"thijs" became "thys"']);
    expect(namesAltered('Cornelis Proefman never took the bulbs.', 'Cornelius Proefman never took the bulbs.', KNOWN)).toEqual(['"cornelis" became "cornelius"']);
  });

  it('catches a westernised name', () => {
    const known: KnownName[] = [
      { name: 'Matthijs Lambrechts', kind: 'PERSON', castId: null, fictional: false, claimKeys: [] },
      { name: 'Pieter Claesz', kind: 'PERSON', castId: null, fictional: false, claimKeys: [] },
    ];
    expect(namesAltered('Matthijs signed the contract.', 'Matthew signed the contract.', known)).toEqual(['"matthijs" became "matthew"']);
    expect(namesAltered('Pieter signed the contract.', 'Peter signed the contract.', known)).toEqual(['"pieter" became "peter"']);
  });

  it('allows up to a third of the name’s length in edits, rounded up: "Hendrik" → "Henry" is three', () => {
    const hendrik: KnownName[] = [{ name: 'Hendrik Fakename', kind: 'PERSON', castId: null, fictional: true, claimKeys: [] }];
    expect(namesAltered('Hendrik bet everything on one bulb.', 'Henry bet everything on one bulb.', hendrik)).toEqual(['"hendrik" became "henry"']);
    // Four edits on eight letters is another word, not a respelling.
    expect(namesAltered('Cornelis Proefman sailed home.', 'Proefman sailed home to Cornwall.', KNOWN)).toEqual([]);
  });

  it('reads only the narrator’s words: a respelling inside a quotation is the record’s', () => {
    expect(namesAltered('Thijs signed the register.', 'He signed the register "Thys".', KNOWN)).toEqual([]);
  });

  it('does not count a pronoun in place of the name', () => {
    expect(namesAltered('Thijs walked to the inn.', 'He walked to the inn.', KNOWN)).toEqual([]);
    expect(namesAltered('Cornelis Proefman never took the bulbs.', 'He never took them.', KNOWN)).toEqual([]);
  });

  it('does not count a shorter form of the same name', () => {
    expect(namesAltered('Cornelis Proefman never took the bulbs.', 'Proefman never took the bulbs.', KNOWN)).toEqual([]);
  });

  it('does not count a different, unrelated name', () => {
    expect(namesAltered('Thijs walked to the inn.', 'Pieter walked to the inn.', KNOWN)).toEqual([]);
    expect(namesAltered('Thijs walked to the inn.', 'Then he walked down to the Thames.', KNOWN)).toEqual([]);
  });

  it('does not count a rewording that keeps the name', () => {
    expect(namesAltered('Thijs walked to the inn.', 'That night Thijs walked slowly to the inn.', KNOWN)).toEqual([]);
  });

  it('looks only at the names it knows', () => {
    expect(namesAltered('Frans signed the contract.', 'Francis signed the contract.', KNOWN)).toEqual([]);
  });
});
