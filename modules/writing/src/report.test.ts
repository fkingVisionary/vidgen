import { NarrationRecord, ScriptChangeReport, type BlockChange, type NameEntry, type ScriptReviewChange } from '@docengine/core';
import { EvidenceBase } from '@docengine/story/shared';
import { fakeEvidenceInput } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { blockPatterns, summarise } from './fingerprints.ts';
import { moneyContexts } from './money.ts';
import { changeReport, type ReportArgs } from './report.ts';
import { rhythmProfile } from './rhythm.ts';
import type { NarrationBlock } from './text.ts';

/**
 * The change report (Part XX) between a version and the one it was made
 * from: block by block, the original, the revision and why (from the change
 * ledger), with what each change did to the evidence, the hedges, the money
 * context, the machine habits, the picture description and the names still
 * waiting for a pronunciation. Claim coverage between the versions is always
 * flagged, never silent.
 *
 * Pairing is EXACT when the run's own lineage is given (a narration pass) and
 * MATCHED (by evidence and wording, section by section) otherwise.
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

/** The same block in the next version (a narration pass never renumbers). */
const same = (b: NarrationBlock, extra: Partial<NarrationBlock> = {}): NarrationBlock => ({ ...b, claimKeys: [...b.claimKeys], ...extra });

const change = (id: string, o: Partial<ScriptReviewChange>): ScriptReviewChange => ({
  id,
  reviewer: 'NARRATION',
  type: 'EDIT',
  section: null,
  ref: null,
  savedRef: null,
  originalText: null,
  proposedText: null,
  reason: '',
  status: 'ACCEPTED',
  rulesImpacted: [],
  rejectionReason: null,
  ...o,
});

const nameEntry = (displayName: string, candidate: boolean, o: Partial<NameEntry> = {}): NameEntry => ({
  id: `N-${displayName}`,
  kind: 'PERSON',
  castId: null,
  fictional: false,
  historicalName: displayName,
  displayName,
  spokenForm: null,
  pronunciation: null,
  mentions: 1,
  firstRef: null,
  claimKeys: [],
  candidate,
  candidateReasons: candidate ? ['no pronunciation note'] : [],
  ...o,
});

/**
 * Uncertainty families, as the script rules read them (the script stage
 * passes its own `uncertaintyOf`; the report only needs a callback).
 */
const FAMILIES: [string, RegExp][] = [
  ['hedge', /\b(?:reportedly|probably|apparently|records suggest)\b/i],
  ['disputed', /\b(?:disputed|accounts differ|not everyone agrees)\b/i],
  ['legend', /\b(?:the story goes|legend)\b/i],
];
const uncertainty = (text: string): ReadonlySet<string> => new Set(FAMILIES.filter(([, re]) => re.test(text)).map(([f]) => f));

/** The money context the tulip evidence supports for 1,200 guilders (C008 over C018's wage). */
const [M1] = moneyContexts(new EvidenceBase(fakeEvidenceInput()), new Set(['C008', 'C018']));

/** The record a narration pass saves with the version it made. */
function narrationRecord(blocks: readonly NarrationBlock[], o: Partial<Pick<NarrationRecord, 'money' | 'names' | 'lineage' | 'visualMoved'>> = {}): NarrationRecord {
  return NarrationRecord.parse({
    engine: 'writing-engine-2',
    styleBibleVersion: '1.0.0',
    corpusVersion: '1.0.0',
    rubricVersion: '1.0.0',
    unavailable: null,
    verdict: 'Two blocks reworded for the ear.',
    retrieved: [],
    counts: { flagged: 2, settled: 3, proposed: 2, kept: 2, rejected: 0, skipped: 0 },
    diagnostics: { before: null, after: { fingerprint: summarise(blocks), rhythm: rhythmProfile(blocks), rubric: [] } },
    money: { contexts: [M1!], used: [], gaps: [] },
    names: [],
    visualMoved: [],
    lineage: null,
    ...o,
  });
}

const identity = (blocks: readonly NarrationBlock[]) => blocks.map((b) => ({ base: b.key, saved: b.key }));
/** The block at a key of the revised version (or, for a removed block, of the base). */
const at = (r: ScriptChangeReport, ref: string): BlockChange => (r.blocks.find((b) => b.ref === ref) ?? r.blocks.find((b) => !b.ref && b.baseRef === ref))!;
const pairsOf = (r: ScriptChangeReport) => r.blocks.map((b) => `${b.baseRef ?? '—'} → ${b.ref ?? '—'} ${b.status}`);

function report(base: readonly NarrationBlock[], revised: readonly NarrationBlock[], o: Partial<ReportArgs> = {}): ScriptChangeReport {
  return changeReport({
    base: { id: 'script-a', version: 4, blocks: base },
    revised: { id: 'script-b', version: 5, blocks: revised },
    lineage: null,
    ledger: [],
    narration: null,
    uncertainty,
    ...o,
  });
}

// ── The tulip opening: a Human Narration Pass, v4 → v5 ───────────────────────

const V4: NarrationBlock[] = [
  block('1.1', 'In February 1637 an auction at Alkmaar raised 90,000 guilders.', { claimKeys: ['C003'] }),
  block('1.2', 'Cornelis Proefman agreed to pay 1,200 guilders for a single bulb. From a corner bench, Thijs watches a thumb wipe a figure away.', { claimKeys: ['C008'] }),
  block('1.3', 'One bulb was reportedly offered for 5,500 guilders.', { infoClass: 'UNCERTAIN', claimKeys: ['C009'] }),
  block('2.1', 'Little did they know what the spring would bring.', { speakerId: 'R1', infoClass: 'FICTION' }),
  block('2.2', 'And then everything changed. The market was shrouded in mystery.', { infoClass: 'FRAMING' }),
];

const V5: NarrationBlock[] = [
  same(V4[0]!),
  same(V4[1]!, { text: 'Cornelis Proefman agreed to pay 1,200 guilders for a single bulb, about four years of a skilled craftsman’s wages.', claimKeys: ['C008', 'C018'] }),
  same(V4[2]!),
  same(V4[3]!),
  same(V4[4]!, { text: 'Nobody could say what a bulb in the ground was worth.' }),
];

const LEDGER: ScriptReviewChange[] = [
  change('N1', { section: 1, ref: '1.2', savedRef: '1.2', originalText: V4[1]!.text, proposedText: V5[1]!.text, reason: 'The picture already shows the bench; say what the price meant instead (M1).' }),
  change('N2', { section: 2, ref: '2.2', savedRef: '2.2', originalText: V4[4]!.text, proposedText: V5[4]!.text, reason: 'Says plainly what the dramatic line only promised.' }),
  // Proposals that were not kept are never a reason.
  change('N3', { section: 1, ref: '1.2', originalText: V4[1]!.text, proposedText: 'Proefman paid for a bulb.', reason: 'Shorter.', status: 'REJECTED', rejectionReason: 'The figure 1200 is gone' }),
  change('N4', { section: 1, ref: '1.3', originalText: V4[2]!.text, proposedText: 'One bulb was offered for 5,500 guilders.', reason: 'Tighter.', status: 'SKIPPED', rejectionReason: 'Settled' }),
  // A performance mark on a block whose words did not change.
  change('P1', { reviewer: 'PERFORMANCE', type: 'PERFORMANCE', section: 1, ref: '1.1', savedRef: '1.1', originalText: V4[0]!.text, reason: 'A pause before the total.' }),
];

const RECORD = narrationRecord(V5, {
  money: { contexts: [M1!], used: [{ contextId: M1!.id, ref: '1.2' }], gaps: [] },
  names: [nameEntry('Cornelis Proefman', true), nameEntry('Thijs', false, { castId: 'R1', fictional: true }), nameEntry('Alkmaar', true, { kind: 'PLACE' })],
  visualMoved: [{ ref: '1.2', note: 'Thijs watches from a corner bench as a thumb wipes a figure away.' }],
  lineage: identity(V4),
});

const passReport = () => report(V4, V5, { lineage: RECORD.lineage, ledger: LEDGER, narration: RECORD });

describe('changeReport after a narration pass (exact lineage)', () => {
  const r = passReport();

  it('pairs every block by the run’s own lineage', () => {
    expect(r.pairing).toBe('EXACT');
    expect(r.base).toEqual({ id: 'script-a', version: 4 });
    expect(r.revised).toEqual({ id: 'script-b', version: 5 });
    expect(pairsOf(r)).toEqual(['1.1 → 1.1 UNCHANGED', '1.2 → 1.2 REWRITTEN', '1.3 → 1.3 UNCHANGED', '2.1 → 2.1 UNCHANGED', '2.2 → 2.2 REWRITTEN']);
  });

  it('fits the shared contract the API and the dashboard read', () => {
    expect(() => ScriptChangeReport.parse(r)).not.toThrow();
  });

  it('shows the original and the revision of each block', () => {
    expect(at(r, '1.2')).toMatchObject({ section: 1, baseRef: '1.2', ref: '1.2', original: V4[1]!.text, revised: V5[1]!.text });
    expect(at(r, '1.1')).toMatchObject({ original: V4[0]!.text, revised: V4[0]!.text });
  });

  it('gives the reasons in the reviewer’s own words, from accepted changes only', () => {
    expect(at(r, '1.2')).toMatchObject({ reasons: ['N1: The picture already shows the bench; say what the price meant instead (M1).'], changedBy: ['NARRATION'] });
    expect(at(r, '2.2')).toMatchObject({ reasons: ['N2: Says plainly what the dramatic line only promised.'], changedBy: ['NARRATION'] });
  });

  it('gives an unchanged block no reasons, even when the ledger mentions it (a performance mark, a skipped proposal)', () => {
    expect(at(r, '1.1')).toMatchObject({ status: 'UNCHANGED', reasons: [], changedBy: [] });
    expect(at(r, '1.3')).toMatchObject({ status: 'UNCHANGED', reasons: [], changedBy: [] });
  });

  it('records the money context the pass added, by context id, at the block that uses it', () => {
    expect(M1).toMatchObject({ id: 'M1', sourceClaimKeys: ['C008', 'C018'] });
    expect(at(r, '1.2').moneyContext).toEqual(['M1']);
    expect(r.blocks.filter((b) => b.ref !== '1.2').every((b) => b.moneyContext.length === 0)).toBe(true);
    expect(r.totals.moneyContextAdded).toBe(1);
  });

  it('records the picture description it took out of the narration', () => {
    expect(at(r, '1.2')).toMatchObject({ aiPatternsRemoved: ['visual_description'], aiPatternsAdded: [], visualDuplicationRemoved: true });
    expect(r.totals.visualDescriptionsRemoved).toBe(1);
  });

  it('records the machine habits a rewrite removed', () => {
    expect(at(r, '2.2')).toMatchObject({ aiPatternsRemoved: ['dramatic_transition', 'mystery_language'], aiPatternsAdded: [], visualDuplicationRemoved: false });
  });

  it('never counts the habits of a speaker’s line: the record’s words are not the narrator’s', () => {
    expect(blockPatterns(V4[3]!)).toEqual([]);
    expect(at(r, '2.1')).toMatchObject({ aiPatternsRemoved: [], aiPatternsAdded: [] });
  });

  it('keeps the evidence of every block: the money claim was added, none was dropped', () => {
    expect(at(r, '1.2')).toMatchObject({ evidencePreserved: true, claimsRemoved: [], claimsAdded: ['C018'] });
    expect(r.blocks.every((b) => b.evidencePreserved === true)).toBe(true);
    expect(r.totals.evidencePreserved).toEqual({ kept: 5, of: 5 });
  });

  it('keeps every hedge: the reported offer is still “reportedly”', () => {
    expect(at(r, '1.3').uncertaintyPreserved).toBe(true);
    expect(r.totals.uncertaintyPreserved).toEqual({ kept: 1, of: 1 });
  });

  it('lists the names in each revised block still waiting for a pronunciation (not the confirmed ones)', () => {
    expect(at(r, '1.1').pronunciationCandidates).toEqual(['Alkmaar']);
    expect(at(r, '1.2').pronunciationCandidates).toEqual(['Cornelis Proefman']);
    expect(at(r, '2.2').pronunciationCandidates).toEqual([]);
    expect(r.blocks.some((b) => b.pronunciationCandidates.includes('Thijs'))).toBe(false);
    expect(r.totals.pronunciationCandidates).toBe(2);
  });

  it('adds up the sentences: in each rewritten block one was cut and one reworded', () => {
    expect(r.totals).toMatchObject({ sentencesRemoved: 2, sentencesRewritten: 2 });
  });

  it('adds up the blocks', () => {
    expect(r.totals).toMatchObject({ blocksBefore: 5, blocksAfter: 5, unchanged: 3, rewritten: 2, removed: 0, added: 0 });
  });

  it('gives the fingerprint and the counted AI signals before and after', () => {
    const [before, after] = [summarise(V4), summarise(V5)];
    expect(r.fingerprint).toEqual({ before: before.score, after: after.score });
    expect(r.fingerprint.before).toBeGreaterThan(50);
    expect(r.fingerprint.after).toBe(0);
    // A picture description, a dramatic transition and mystery language: three HARD signals, all gone.
    expect(r.totals).toMatchObject({ aiSignalsBefore: 3, aiSignalsAfter: 0 });
    expect(r.totals.aiSignalsBefore).toBe(before.signals);
  });

  it('flags nothing when claim coverage only grew', () => {
    expect(r.provenance).toEqual({ claimsAdded: ['C018'], claimsRemoved: [], figuresAdded: [], figuresRemoved: [], flags: [] });
  });

  it('is read-only: the versions, the ledger and the record are left as they were', () => {
    const snapshot = JSON.stringify([V4, V5, LEDGER, RECORD]);
    const frozen = <T>(x: T): T => {
      if (x && typeof x === 'object') {
        for (const v of Object.values(x)) frozen(v);
        Object.freeze(x);
      }
      return x;
    };
    const args = frozen(structuredClone({ v4: V4, v5: V5, ledger: LEDGER, record: RECORD }));
    expect(() => report(args.v4, args.v5, { lineage: args.record.lineage, ledger: args.ledger, narration: args.record })).not.toThrow();
    expect(JSON.stringify([V4, V5, LEDGER, RECORD])).toBe(snapshot);
  });

  it('gives the same report however often it is asked for', () => {
    expect(passReport()).toEqual(r);
  });

  it('without a narration record, reports no money context and no pronunciation candidates', () => {
    const bare = report(V4, V5, { lineage: identity(V4), ledger: LEDGER });
    expect(bare.totals).toMatchObject({ moneyContextAdded: 0, pronunciationCandidates: 0 });
    expect(bare.blocks.every((b) => b.moneyContext.length === 0 && b.pronunciationCandidates.length === 0)).toBe(true);
    expect(pairsOf(bare)).toEqual(pairsOf(r));
  });

  it('says so when a kept change gave no reason', () => {
    const silent = report(V4, V5, { lineage: identity(V4), ledger: [change('N1', { ref: '1.2', savedRef: '1.2', originalText: V4[1]!.text })] });
    expect(at(silent, '1.2').reasons).toEqual(['N1: no reason given']);
  });
});

// ── Other reviewers in the same run renumbered the blocks ────────────────────

const S3_BASE: NarrationBlock[] = [
  block('3.1', 'By the first week of February, buyers in Haarlem had stopped coming to the auctions.', { claimKeys: ['C010'] }),
  block('3.2', 'Nobody knew what a contract was worth any more.', { claimKeys: ['C011'] }),
  block('3.3', 'The courts of Holland refused to enforce the contracts.', { claimKeys: ['C012'] }),
];
const S3_REVISED: NarrationBlock[] = [
  same(S3_BASE[0]!),
  same(S3_BASE[2]!, { key: '3.2' }),
  block('3.3', 'The States of Holland left buyers and sellers to settle among themselves.', { claimKeys: ['C012'] }),
];
const S3_LEDGER: ScriptReviewChange[] = [
  change('E1', { reviewer: 'SCRIPT_EDITOR', type: 'REMOVE', section: 3, ref: '3.2', savedRef: null, originalText: S3_BASE[1]!.text, reason: 'Says what the next line shows.' }),
  change('F1', { reviewer: 'FACT_CHECKER', type: 'INSERT', section: 3, ref: '3.3', savedRef: '3.3', proposedText: S3_REVISED[2]!.text, reason: 'The settlement is part of C012.' }),
];
const S3_LINEAGE = [
  { base: '3.1', saved: '3.1' },
  { base: '3.2', saved: null },
  { base: '3.3', saved: '3.2' },
];

describe('changeReport when reviewers removed and inserted blocks (renumbered, exact lineage)', () => {
  const r = report(S3_BASE, S3_REVISED, { lineage: S3_LINEAGE, ledger: S3_LEDGER });

  it('follows the lineage across the renumbering: 3.3 became 3.2 and is unchanged', () => {
    expect(at(r, '3.2')).toMatchObject({ baseRef: '3.3', ref: '3.2', status: 'UNCHANGED' });
    expect(r.totals).toMatchObject({ blocksBefore: 3, blocksAfter: 3, unchanged: 2, rewritten: 0, removed: 1, added: 1 });
  });

  it('lists the blocks in script order: a removed block where it was, an added one where it is', () => {
    expect(pairsOf(r)).toEqual(['3.1 → 3.1 UNCHANGED', '3.2 → — REMOVED', '3.3 → 3.2 UNCHANGED', '— → 3.3 ADDED']);
  });

  it('gives a removed block its original, its reason (found by its wording) and its reviewer', () => {
    const removed = r.blocks.find((b) => b.status === 'REMOVED')!;
    expect(removed).toMatchObject({
      section: 3,
      baseRef: '3.2',
      ref: null,
      original: S3_BASE[1]!.text,
      revised: null,
      reasons: ['E1: Says what the next line shows.'],
      changedBy: ['SCRIPT_EDITOR'],
      evidencePreserved: null,
      uncertaintyPreserved: null,
      claimsRemoved: ['C011'],
      claimsAdded: [],
      moneyContext: [],
      pronunciationCandidates: [],
    });
  });

  it('gives an added block its text, its reason (found where it was saved) and its reviewer', () => {
    const added = r.blocks.find((b) => b.status === 'ADDED')!;
    expect(added).toMatchObject({
      section: 3,
      baseRef: null,
      ref: '3.3',
      original: null,
      revised: S3_REVISED[2]!.text,
      reasons: ['F1: The settlement is part of C012.'],
      changedBy: ['FACT_CHECKER'],
      evidencePreserved: null,
      uncertaintyPreserved: null,
      claimsRemoved: [],
      claimsAdded: ['C012'],
    });
  });

  it('counts the sentences of a removed block as removed, and those of an added block not at all', () => {
    expect(r.totals).toMatchObject({ sentencesRemoved: 1, sentencesRewritten: 0 });
  });

  it('flags the claim no block cites any more', () => {
    expect(r.provenance.claimsRemoved).toEqual(['C011']);
    expect(r.provenance.claimsAdded).toEqual([]);
    expect(r.provenance.flags).toEqual(['Claim C011 is no longer cited anywhere in v5']);
    expect(r.totals.evidencePreserved).toEqual({ kept: 2, of: 2 });
  });

  it('a block missing from the lineage is reported as removed, and the block it left is reported as added (never guessed by key)', () => {
    const partial = report(S3_BASE, S3_REVISED, { lineage: S3_LINEAGE.slice(0, 2), ledger: [] });
    // At one place in the script, additions come before removals (as in a matched pairing).
    expect(pairsOf(partial)).toEqual(['3.1 → 3.1 UNCHANGED', '— → 3.2 ADDED', '— → 3.3 ADDED', '3.2 → — REMOVED', '3.3 → — REMOVED']);
  });

  it('an added block at the very start of the script is listed first', () => {
    const revised = [block('3.1', 'The States of Holland left buyers and sellers to settle among themselves.'), ...S3_BASE.map((b, i) => same(b, { key: `3.${i + 2}` }))];
    const r = report(S3_BASE, revised, { lineage: S3_BASE.map((b, i) => ({ base: b.key, saved: `3.${i + 2}` })) });
    expect(pairsOf(r)).toEqual(['— → 3.1 ADDED', '3.1 → 3.2 UNCHANGED', '3.2 → 3.3 UNCHANGED', '3.3 → 3.4 UNCHANGED']);
  });
});

// ── Without a lineage: blocks matched by evidence and wording ────────────────

describe('changeReport without a lineage (matched pairing)', () => {
  it('pairs the renumbered blocks the same way, by their evidence and wording', () => {
    const r = report(S3_BASE, S3_REVISED, { ledger: S3_LEDGER });
    expect(r.pairing).toBe('MATCHED');
    expect(pairsOf(r)).toEqual(['3.1 → 3.1 UNCHANGED', '3.2 → — REMOVED', '3.3 → 3.2 UNCHANGED', '— → 3.3 ADDED']);
    expect(r.blocks.find((b) => b.status === 'REMOVED')!.reasons).toEqual(['E1: Says what the next line shows.']);
    expect(r.blocks.find((b) => b.status === 'ADDED')!.reasons).toEqual(['F1: The settlement is part of C012.']);
  });

  it('pairs a reworded block that keeps its claims and most of its words', () => {
    const r = report(V4, V5, { ledger: LEDGER });
    expect(r.pairing).toBe('MATCHED');
    expect(pairsOf(r)).toEqual(pairsOf(passReport()));
    expect(at(r, '1.2')).toMatchObject({ status: 'REWRITTEN', reasons: ['N1: The picture already shows the bench; say what the price meant instead (M1).'] });
  });

  it('reports a block replaced by one with other evidence and other words as one removed and one added', () => {
    const base = [block('1.1', 'One bulb was reportedly offered for 5,500 guilders.', { claimKeys: ['C009'] })];
    const revised = [block('1.1', 'The courts of Holland refused to enforce the contracts.', { claimKeys: ['C012'] })];
    expect(pairsOf(report(base, revised))).toEqual(['— → 1.1 ADDED', '1.1 → — REMOVED']);
    // With the run's lineage, the same change is a rewrite.
    expect(pairsOf(report(base, revised, { lineage: identity(base) }))).toEqual(['1.1 → 1.1 REWRITTEN']);
  });

  it('pairs a framing line reworded in place, when nothing else in the section could be its rewrite', () => {
    const base = [block('1.1', 'And then everything changed. The market was shrouded in mystery.', { infoClass: 'FRAMING' })];
    const revised = [block('1.1', 'Nobody could say what a bulb in the ground was worth.', { infoClass: 'FRAMING' })];
    expect(pairsOf(report(base, revised))).toEqual(['1.1 → 1.1 REWRITTEN']);
  });

  it('pairs a block whose wording changed if it still cites the same claims', () => {
    const base = [block('1.1', 'Proefman agreed to pay 1,200 guilders for a single bulb.', { claimKeys: ['C008'] })];
    const revised = [block('1.1', 'The price agreed for one bulb was 1,200 guilders.', { claimKeys: ['C008'] })];
    expect(pairsOf(report(base, revised))).toEqual(['1.1 → 1.1 REWRITTEN']);
  });

  it('never pairs blocks across sections: a line moved to the next section is removed there and added here', () => {
    const moved = 'The courts of Holland refused to enforce the contracts.';
    const base = [block('1.1', 'In February 1637 an auction at Alkmaar raised 90,000 guilders.'), block('1.2', moved), block('2.1', 'Nobody knew what a contract was worth any more.')];
    const revised = [block('1.1', base[0]!.text), block('2.1', moved), block('2.2', base[2]!.text)];
    expect(pairsOf(report(base, revised))).toEqual(['1.1 → 1.1 UNCHANGED', '1.2 → — REMOVED', '— → 2.1 ADDED', '2.1 → 2.2 UNCHANGED']);
  });

  it('reports a whole new section as added and a dropped one as removed', () => {
    const base = [block('1.1', 'In February 1637 an auction at Alkmaar raised 90,000 guilders.'), block('2.1', 'Nobody knew what a contract was worth any more.')];
    const revised = [block('1.1', base[0]!.text), block('3.1', 'The courts of Holland refused to enforce the contracts.')];
    const r = report(base, revised);
    expect(pairsOf(r)).toEqual(['1.1 → 1.1 UNCHANGED', '2.1 → — REMOVED', '— → 3.1 ADDED']);
    expect(r.blocks.map((b) => b.section)).toEqual([1, 2, 3]);
  });

  it('compares two identical versions as unchanged throughout, with nothing flagged', () => {
    const r = report(V4, V4.map((b) => same(b)));
    expect(r.blocks.every((b) => b.status === 'UNCHANGED' && b.reasons.length === 0)).toBe(true);
    expect(r.totals).toMatchObject({ unchanged: 5, rewritten: 0, removed: 0, added: 0, sentencesRemoved: 0, sentencesRewritten: 0, visualDescriptionsRemoved: 0 });
    expect(r.provenance.flags).toEqual([]);
    expect(r.fingerprint.before).toBe(r.fingerprint.after);
  });
});

// ── Claim coverage is never silent ───────────────────────────────────────────

describe('claim coverage between the versions', () => {
  const base = [
    block('1.1', 'Cornelis Proefman agreed to pay 1,200 guilders for a single bulb.', { claimKeys: ['C008'] }),
    block('1.2', 'A skilled craftsman earned roughly 300 guilders a year.', { claimKeys: ['C018'] }),
    block('1.3', 'One bulb was reportedly offered for 5,500 guilders.', { infoClass: 'UNCERTAIN', claimKeys: ['C009'] }),
  ];

  it('a dropped claim: the block’s evidence is not kept, and the report says which claim and which figure are gone', () => {
    const revised = [same(base[0]!, { text: 'Cornelis Proefman agreed to pay a fortune for a single bulb.', claimKeys: [] }), same(base[1]!), same(base[2]!)];
    const r = report(base, revised, { lineage: identity(base) });
    expect(at(r, '1.1')).toMatchObject({ status: 'REWRITTEN', evidencePreserved: false, claimsRemoved: ['C008'], claimsAdded: [] });
    expect(r.totals.evidencePreserved).toEqual({ kept: 2, of: 3 });
    expect(r.provenance).toMatchObject({ claimsRemoved: ['C008'], figuresRemoved: ['1200'], claimsAdded: [], figuresAdded: [] });
    expect(r.provenance.flags).toEqual(['Claim C008 is no longer cited anywhere in v5', 'The figure 1200 is no longer said in v5', '1.1 → 1.1: no longer cites C008']);
  });

  it('a claim moved to another block: still flagged on the block, noted as cited elsewhere, not lost from the version', () => {
    const revised = [same(base[0]!, { claimKeys: [] }), same(base[1]!, { claimKeys: ['C018', 'C008'] }), same(base[2]!)];
    const r = report(base, revised, { lineage: identity(base) });
    expect(at(r, '1.1')).toMatchObject({ status: 'REWRITTEN', evidencePreserved: false, claimsRemoved: ['C008'] });
    expect(at(r, '1.2')).toMatchObject({ status: 'REWRITTEN', evidencePreserved: true, claimsAdded: ['C008'] });
    expect(r.provenance.claimsRemoved).toEqual([]);
    expect(r.provenance.flags).toEqual(['1.1 → 1.1: no longer cites C008 (still cited elsewhere)']);
  });

  it('a claim dropped with only its citation changed (same words) is still a change, never an unchanged block', () => {
    const revised = [same(base[0]!, { claimKeys: [] }), same(base[1]!), same(base[2]!)];
    const r = report(base, revised, { lineage: identity(base) });
    expect(at(r, '1.1')).toMatchObject({ status: 'REWRITTEN', evidencePreserved: false });
    expect(r.provenance.flags).toContain('Claim C008 is no longer cited anywhere in v5');
  });

  it('a block whose class changed has not kept its evidence, and is not reported as unchanged', () => {
    const revised = [same(base[0]!), same(base[1]!, { infoClass: 'UNCERTAIN' }), same(base[2]!)];
    const r = report(base, revised, { lineage: identity(base) });
    expect(at(r, '1.2')).toMatchObject({ status: 'REWRITTEN', evidencePreserved: false, claimsRemoved: [], claimsAdded: [] });
    expect(r.totals).toMatchObject({ unchanged: 2, rewritten: 1, evidencePreserved: { kept: 2, of: 3 } });
  });

  it('a removed block’s claims are flagged unless another block still cites them', () => {
    const revised = [same(base[0]!), same(base[1]!, { claimKeys: ['C018', 'C009'] })];
    const r = report(base, revised, { lineage: [...identity(base.slice(0, 2)), { base: '1.3', saved: null }] });
    expect(at(r, '1.3')).toMatchObject({ status: 'REMOVED', claimsRemoved: ['C009'] });
    expect(r.provenance.claimsRemoved).toEqual([]);
    expect(r.provenance.figuresRemoved).toEqual(['5500']);
  });

  it('lists new claims and figures, sorted', () => {
    const revised = [same(base[0]!), same(base[1]!), same(base[2]!), block('1.4', 'The whole sale at Alkmaar raised 90,000 guilders in 1637.', { claimKeys: ['C003', 'C010'] })];
    const r = report(base, revised, { lineage: identity(base) });
    expect(r.provenance).toMatchObject({ claimsAdded: ['C003', 'C010'], figuresAdded: ['1637', '90000'], claimsRemoved: [], figuresRemoved: [], flags: [] });
  });

  it('never calls a change of a figure unchanged, even when only a decimal point moved', () => {
    const before = [block('1.1', 'The debts came to 1.5 million guilders.', { claimKeys: ['C003'] })];
    const after = [block('1.1', 'The debts came to 15 million guilders.', { claimKeys: ['C003'] })];
    const r = report(before, after, { lineage: identity(before) });
    expect(at(r, '1.1').status).toBe('REWRITTEN');
    expect(r.provenance.figuresAdded).toEqual(['15']);
    // A change of how a figure is written is not a change of the figure.
    const regrouped = report([block('1.1', 'He paid 1,200 guilders.')], [block('1.1', 'He paid 1200 guilders.')], { lineage: [{ base: '1.1', saved: '1.1' }] });
    expect(at(regrouped, '1.1').status).toBe('UNCHANGED');
  });
});

// ── Uncertainty ──────────────────────────────────────────────────────────────

describe('uncertainty between the versions', () => {
  const base = [
    block('1.1', 'One bulb was reportedly offered for 5,500 guilders.', { infoClass: 'UNCERTAIN', claimKeys: ['C009'] }),
    block('1.2', 'In February 1637 an auction at Alkmaar raised 90,000 guilders.', { claimKeys: ['C003'] }),
  ];
  const run = (text: string) => report(base, [same(base[0]!, { text }), same(base[1]!)], { lineage: identity(base) });

  it('a hedge dropped: the block has not kept its uncertainty, and the report flags it', () => {
    const r = run('One bulb was offered for 5,500 guilders.');
    expect(at(r, '1.1')).toMatchObject({ status: 'REWRITTEN', uncertaintyPreserved: false, evidencePreserved: true });
    expect(r.totals.uncertaintyPreserved).toEqual({ kept: 0, of: 1 });
    expect(r.provenance.flags).toEqual(['1.1 → 1.1: a hedge of the original is gone']);
  });

  it('a hedge reworded within its family is kept', () => {
    const r = run('One bulb was probably offered for 5,500 guilders.');
    expect(at(r, '1.1').uncertaintyPreserved).toBe(true);
    expect(r.totals.uncertaintyPreserved).toEqual({ kept: 1, of: 1 });
    expect(r.provenance.flags).toEqual([]);
  });

  it('a hedge swapped for another kind of uncertainty is not kept', () => {
    const r = run('The story goes that one bulb was offered for 5,500 guilders.');
    expect(at(r, '1.1').uncertaintyPreserved).toBe(false);
  });

  it('a hedge added to a plain line takes nothing away', () => {
    const r = report(base, [same(base[0]!), same(base[1]!, { text: 'In February 1637 an auction at Alkmaar apparently raised 90,000 guilders.' })], { lineage: identity(base) });
    expect(at(r, '1.2')).toMatchObject({ status: 'REWRITTEN', uncertaintyPreserved: true });
    // Only blocks that had a hedge count towards the total.
    expect(r.totals.uncertaintyPreserved).toEqual({ kept: 1, of: 1 });
  });

  it('reads the hedges with the callback it is given', () => {
    const seen: string[] = [];
    const r = report(base, base.map((b) => same(b)), {
      lineage: identity(base),
      uncertainty: (t) => {
        seen.push(t);
        return new Set(t.includes('Alkmaar') ? ['place-is-a-hedge'] : []);
      },
    });
    expect(seen).toContain(base[1]!.text);
    expect(r.totals.uncertaintyPreserved).toEqual({ kept: 1, of: 1 });
  });
});

// ── Sentences ────────────────────────────────────────────────────────────────

describe('sentences removed and rewritten', () => {
  const base = [block('1.1', 'The bulbs were sold in taverns. The buyers rarely saw them. Prices doubled in a month.')];
  const run = (text: string) => report(base, [same(base[0]!, { text })], { lineage: identity(base) }).totals;

  it('a sentence cut and a sentence reworded', () => {
    expect(run('The bulbs were sold in taverns. Prices doubled within a month.')).toMatchObject({ sentencesRemoved: 1, sentencesRewritten: 1 });
  });

  it('every sentence reworded, none cut', () => {
    expect(run('Taverns were where the bulbs were sold. Buyers seldom saw them. Within a month, prices had doubled.')).toMatchObject({ sentencesRemoved: 0, sentencesRewritten: 3 });
  });

  it('two sentences joined into one: one cut, one reworded', () => {
    expect(run('The bulbs were sold in taverns, and the buyers rarely saw them. Prices doubled in a month.')).toMatchObject({ sentencesRemoved: 1, sentencesRewritten: 1 });
  });

  it('a sentence added and nothing cut', () => {
    expect(run('The bulbs were sold in taverns. The buyers rarely saw them. Prices doubled in a month. Then they halved.')).toMatchObject({ sentencesRemoved: 0, sentencesRewritten: 0 });
  });
});

// ── Names waiting for a pronunciation ────────────────────────────────────────

describe('pronunciation candidates in a revised block', () => {
  const base = [block('1.1', 'The bulbs went to Willem van Hout, a baker.'), block('1.2', 'Proefman never collected them.')];
  const revised = base.map((b) => same(b));
  const names = [nameEntry('Pieter van der Berg', true), nameEntry('Willem van Hout', true), nameEntry('Proefman', true)];
  const r = report(base, revised, { lineage: identity(base), narration: narrationRecord(revised, { names, lineage: identity(base) }) });

  it('names a candidate only where the block says one of its identifying words, never by a shared particle', () => {
    expect(at(r, '1.1').pronunciationCandidates).toEqual(['Willem van Hout']);
    expect(at(r, '1.2').pronunciationCandidates).toEqual(['Proefman']);
  });

  it('counts every name the pass left waiting', () => {
    expect(r.totals.pronunciationCandidates).toBe(3);
  });
});
