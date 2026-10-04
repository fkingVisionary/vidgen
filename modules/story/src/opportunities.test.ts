import { CONTENT_LIMITS } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { buildArchitecture, toArchitectOutput, type SelectedUnit } from './architecture.ts';
import { EvidenceBase } from './evidence.ts';
import { normalizeMined } from './mining.ts';
import { buildOpportunities } from './opportunities.ts';
import type { OpportunityOutput } from './schemas.ts';
import { FAKE_VALID, fakeArchitectOutput, fakeEvidenceInput, fakeOpportunities, type ShownArchitecture } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());

/** The same eight units as the architecture tests (S07: C009 DISPUTED; S08: C010 MYTH, C016). */
const units: SelectedUnit[] = normalizeMined(FAKE_VALID.slice(0, 8), evidence, { firstRef: 1, known: [], rejected: [] }).kept.map((d, i) => ({
  ...d,
  id: `cand-${i + 1}`,
  key: `S0${i + 1}`,
  notes: null,
  rankScore: 7 - i * 0.1,
  status: 'PROPOSED',
  priority: 'NORMAL',
  editorNotes: null,
  selectionOrder: null,
}));
const raw = fakeArchitectOutput(
  units.map((u) => ({ key: u.key, claims: u.claimKeys, characters: u.characters.map((c) => ({ name: c.name, kind: c.kind })) })),
  (k) => evidence.claim(k)?.verdict,
  { secondsPerSequence: 100, composite: { name: 'Pieter Graanhout' } },
);
const architecture = buildArchitecture(raw, evidence, units);
const shown = toArchitectOutput(architecture.content) as ShownArchitecture;

type Proposed = OpportunityOutput['opportunities'][number];
const short = (over: Partial<Proposed> = {}): Proposed => ({
  format: 'SHORT',
  title: 'The price nobody paid',
  hook: 'Was one bulb really worth a house?',
  centralQuestion: 'What did the record actually show?',
  standalonePremise: 'A famous price, tested against the record.',
  angle: 'The legend versus the ledger.',
  beatIds: ['7.2', '7.3'],
  claimKeys: ['C009'],
  castIds: [],
  escalation: 'Each retelling raises the price.',
  payoff: 'No completed sale is documented.',
  suggestedEnding: 'So where did the number come from?',
  visualConcept: 'A ledger page with an empty line.',
  targetDurationSec: 50,
  independent: true,
  requiresContext: false,
  contextNote: '',
  hookScore: 8,
  payoffScore: 8,
  standaloneScore: 8,
  visualScore: 7,
  emotionScore: 6,
  paceScore: 8,
  whyItWorks: 'A myth-busting payoff in under a minute.',
  ...over,
});
const run = (opportunities: Proposed[]) => buildOpportunities({ opportunities }, architecture.content, evidence, units);

describe('content opportunities', () => {
  it('starts from an architecture that passed the rules', () => {
    expect(architecture.findings).toEqual([]);
  });

  it('keeps shorts and long-form threads that trace to architecture beats, ranks shorts by short-form potential, and removes the rest with reasons', () => {
    const r = run(fakeOpportunities(shown));
    expect(r.opportunities.map((o) => `${o.key} ${o.format} ${o.rank ?? '-'} ${o.title}`)).toEqual([
      'O01 SHORT 1 Short: The story of S01',
      'O02 BOTH 2 Short: The story of S02',
      'O03 SHORT 3 Short: The story of S03',
      'O04 SHORT 4 Short: The story of S04',
      'O05 SHORT 5 Short: The story of S05',
      'O06 LONG_FORM - The whole trade, from promise to court',
    ]);
    const scores = r.opportunities.filter((o) => o.format !== 'LONG_FORM').map((o) => o.shortScore!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(r.opportunities.at(-1)).toMatchObject({ format: 'LONG_FORM', shortScore: null, rank: null, targetDurationSec: 780 });
    expect(r.removed).toEqual([
      { title: 'A beat that does not exist', reason: 'not traceable: beat 99.1 does not exist in the architecture' },
      { title: 'The invented fortune', reason: 'uses figures that are not in its evidence: 7777' },
    ]);
    expect(r.notes).toEqual(['Content opportunities: 8 proposed, 6 kept (5 short-form), 2 removed']);
  });

  it('traces every short to architecture beats, and every factual element to approved claims of those beats', () => {
    const r = run(fakeOpportunities(shown));
    const beats = new Map(architecture.content.sequences.flatMap((s) => s.beats.map((b) => [b.id, { b, s }] as const)));
    for (const o of r.opportunities) {
      expect(o.content.beatIds.length).toBeGreaterThan(0);
      expect(o.content.beatIds.every((id) => beats.has(id))).toBe(true);
      const allowed = new Set(o.content.beatIds.flatMap((id) => [...beats.get(id)!.b.claimKeys, ...beats.get(id)!.s.claimKeys]));
      expect(o.content.claimKeys.length).toBeGreaterThan(0);
      expect(o.content.claimKeys.every((k) => allowed.has(k) && evidence.has(k))).toBe(true);
      expect(o.content.sourceIds).toEqual(evidence.sourcesFor(o.content.claimKeys));
      expect(o.content.sequenceNumbers).toEqual([...new Set(o.content.beatIds.map((id) => Number(id.split('.')[0])))]);
      expect(o.content.candidateIds.every((id) => units.some((u) => u.id === id))).toBe(true);
    }
    const first = r.opportunities[0]!;
    expect(first.content).toMatchObject({ beatIds: ['1.1', '1.2', '1.3', '1.5'], sequenceNumbers: [1], candidateKeys: ['S01'], candidateIds: ['cand-1'], claimKeys: ['C001', 'C020'] });
  });

  it('lets no unapproved research into a short: claims outside its beats, unknown claims, undeclared cast', () => {
    const r = run([
      short({ title: 'Outside its beats', claimKeys: ['C009', 'C001'] }),
      short({ title: 'Background only', claimKeys: ['C009', 'C013'] }),
      short({ title: 'Unknown claim', claimKeys: ['C009', 'C999'] }),
      short({ title: 'Undeclared cast', castIds: ['F7'] }),
      short({ title: 'No beats', beatIds: [] }),
      short({ title: 'Fiction only', beatIds: ['1.4'], claimKeys: [] }),
    ]);
    expect(r.opportunities).toEqual([]);
    expect(r.removed.map((x) => `${x.title}: ${x.reason}`)).toEqual([
      'Outside its beats: uses C001, which is not in its beats or their sequences',
      'Background only: uses C013, which is not in its beats or their sequences',
      'Unknown claim: cites C999, which is not in the approved dossier',
      'Undeclared cast: uses the cast id F7, which the architecture does not declare',
      'No beats: not traceable: it names no architecture beat',
      'Fiction only: its beats cite no claim, so nothing in it traces to the evidence',
    ]);
  });

  it('keeps disputed, myth and uncertain material in its presentation, copied from the architecture', () => {
    const r = run([
      short(),
      short({ title: 'The ruin that never was', beatIds: ['8.2'], claimKeys: ['C010'], centralQuestion: 'Were people really ruined?', payoff: 'The archives show no wave of bankruptcies.' }),
      short({ title: 'Promises nobody kept', beatIds: ['5.2'], claimKeys: ['C006'], centralQuestion: 'What happened when prices fell?', payoff: 'Many refused to pay.' }),
    ]);
    expect(r.removed).toEqual([]);
    const byTitle = new Map(r.opportunities.map((o) => [o.title, o]));
    expect(byTitle.get('The price nobody paid')).toMatchObject({
      historicalStatus: 'CONTESTED',
      content: { presentation: [{ claimKey: 'C009', presentation: 'PRESENT_AS_DISPUTED', instruction: 'Present it as disputed and give both sides (test).' }] },
    });
    expect(byTitle.get('The ruin that never was')).toMatchObject({ historicalStatus: 'MYTH_INVESTIGATION', content: { presentation: [{ claimKey: 'C010', presentation: 'INVESTIGATE_AS_MYTH' }] } });
    expect(byTitle.get('Promises nobody kept')!.content.presentation).toEqual([{ claimKey: 'C006', presentation: 'HEDGE', instruction: 'Records suggest this: word it as probable, not certain (test).' }]);
  });

  it('cannot invent people, places, dates, numbers or quotations', () => {
    const r = run([
      short({ title: 'An invented trader', hook: 'Willem Fakerson bet his house on one bulb.' }),
      short({ title: 'An outside person', payoff: 'Charles Mackay made the price famous.' }),
      short({ title: 'An invented year', suggestedEnding: 'By 1625 nobody remembered it.' }),
      short({ title: 'An invented number', hook: 'One bulb, 12,345 guilders.' }),
      short({ title: 'An invented quotation', hook: 'A buyer cried "I have bought the wind itself"!' }),
      short({ title: 'A verified quotation', beatIds: ['2.2'], claimKeys: ['C002'], hook: 'They met "in the inn to trade bulbs they have never seen".', payoff: 'The colleges.' }),
      short({ title: 'A figure from its claims', hook: 'Was one bulb really worth 5,500 guilders?' }),
    ]);
    expect(r.removed.map((x) => `${x.title}: ${x.reason}`)).toEqual([
      'An invented trader: names Fakerson, which neither the evidence nor the declared cast knows',
      "An outside person: names Charles Mackay, who is not in the selected units' evidence",
      'An invented year: uses figures that are not in its evidence: 1625',
      'An invented number: uses figures that are not in its evidence: 12345',
      'An invented quotation: puts "I have bought the wind itself" in quotation marks, but it is neither a verified quotation nor one of the architecture\'s invented lines',
    ]);
    expect(r.opportunities.map((o) => o.title).sort()).toEqual(['A figure from its claims', 'A verified quotation']);
  });

  it('lets LONG_FORM and SHORT coexist on the same beats, and fits durations, independence and scores to the format', () => {
    const r = run([
      short({ title: 'Long thread on the price', format: 'LONG_FORM', targetDurationSec: 120 }),
      short({ title: 'The price, short' }),
      short({ title: 'Too long for a short', beatIds: ['6.2'], claimKeys: ['C008'], targetDurationSec: 400, hookScore: 14, paceScore: -3 }),
      short({ title: 'No duration given', beatIds: ['4.2'], claimKeys: ['C005'], targetDurationSec: 0 }),
      short({ title: 'Needs the documentary', beatIds: ['3.2'], claimKeys: ['C003'], independent: false, requiresContext: false }),
    ]);
    expect(r.removed).toEqual([]);
    const byTitle = new Map(r.opportunities.map((o) => [o.title, o]));
    expect(byTitle.get('Long thread on the price')).toMatchObject({ format: 'LONG_FORM', rank: null, shortScore: null, targetDurationSec: null });
    expect(byTitle.get('Long thread on the price')!.content.notes).toEqual(['target 120s is too short for long-form; left open']);
    expect(byTitle.get('The price, short')).toMatchObject({ format: 'SHORT', targetDurationSec: 50 });
    expect(byTitle.get('Too long for a short')).toMatchObject({ targetDurationSec: CONTENT_LIMITS.short.maxSec, content: { scores: { hook: 10, pace: 0 } } });
    expect(byTitle.get('No duration given')).toMatchObject({ targetDurationSec: CONTENT_LIMITS.short.defaultSec });
    expect(byTitle.get('Needs the documentary')).toMatchObject({ independent: false, requiresContext: true });
  });

  it('removes duplicates and never keeps more than the limit (quality over quantity, never padded)', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      short({ title: `Distinct short number ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'][i]}`, beatIds: [`${(i % 8) + 1}.${i < 8 ? 2 : 3}`], claimKeys: [], hookScore: 10 - (i % 10) }),
    );
    const r = run([...many, short({ title: 'Distinct short number one!' })]);
    expect(r.opportunities).toHaveLength(CONTENT_LIMITS.maxOpportunities);
    expect(r.removed.map((x) => x.reason)).toEqual([
      'duplicates "Distinct short number one"',
      'beyond the limit of 12 opportunities (weakest)',
      'beyond the limit of 12 opportunities (weakest)',
    ]);
    expect(run([]).opportunities).toEqual([]);
  });
});
