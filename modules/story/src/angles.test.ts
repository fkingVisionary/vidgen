import { describe, expect, it } from 'vitest';
import { buildAngles } from './angles.ts';
import { buildArchitecture, type SelectedUnit } from './architecture.ts';
import { EvidenceBase } from './evidence.ts';
import { normalizeMined } from './mining.ts';
import type { AnglesOutput } from './schemas.ts';
import { FAKE_VALID, fakeAngles, fakeArchitectOutput, fakeEvidenceInput } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());

/** Seven selected units (S01–S07) and S08 approved in reserve. */
const units: SelectedUnit[] = normalizeMined(FAKE_VALID.slice(0, 8), evidence, { firstRef: 1, known: [], rejected: [] }).kept.map((d, i) => ({
  ...d,
  id: `cand-${i + 1}`,
  key: `S0${i + 1}`,
  notes: null,
  rankScore: 7 - i * 0.1,
  status: i === 7 ? 'APPROVED' : 'PROPOSED',
  priority: i === 2 ? 'HIGH' : 'NORMAL',
  editorNotes: null,
  selectionOrder: null,
  reserve: i === 7,
}));

/** An angles prompt as the stage writes it (only the parts the fake reads). */
const prompt = ['# Story units (the editor\'s selection, then units the editor approved but did not select)', ...units.map((u) => `## ${u.key}${u.reserve ? ' · approved by the editor, not selected (optional)' : ''} — ${u.title}\nclaims: ${u.claimKeys.join(', ')}`), '', '# Evidence'].join('\n\n');
const proposed = () => fakeAngles(prompt);
type Angle = AnglesOutput['angles'][number];
const run = (angles: Angle[], count = 3, base: Parameters<typeof buildAngles>[3]['base'] = null) => buildAngles({ angles }, units, evidence, { count, base, baseVersion: base ? 4 : null });

describe('alternative angles', () => {
  it('keeps 2–3 materially different approaches, keyed A1…, each traced to the pack\'s units and their claims', () => {
    const r = run(proposed());
    expect(r.removed).toEqual([]);
    expect(r.angles.map((a) => `${a.key} ${a.narrativeMode} ${a.povStrategy.type}`)).toEqual(['A1 INVESTIGATION INVESTIGATOR', 'A2 CHARACTER_FOLLOW CHARACTER_FOLLOW', 'A3 COUNTDOWN VIEWER_POV']);
    for (const a of r.angles) {
      expect(a.unitKeys.every((k) => units.some((u) => u.key === k))).toBe(true);
      expect(a.claimKeys).toEqual(evidence.claims.size > 0 ? [...new Set(units.filter((u) => a.unitKeys.includes(u.key)).flatMap((u) => u.claimKeys))].sort() : []);
      expect(a.claimKeys.every((k) => evidence.has(k))).toBe(true);
    }
    expect(r.angles[0]).toMatchObject({ opening: { unitKey: 'S07', basis: 'RECONSTRUCTION' }, unitKeys: ['S07', 'S06', 'S05', 'S04', 'S03', 'S02', 'S01'], historicalStatus: 'CONTESTED' });
    // Every pair differs in at least mode, POV, opening and anchor.
    expect(r.comparisons).toEqual([
      { a: 'A1', b: 'A2', differences: ['narrative mode', 'POV', 'opening', 'human anchor', 'central question', 'structure'] },
      { a: 'A1', b: 'A3', differences: ['narrative mode', 'POV', 'opening', 'human anchor', 'central question', 'structure'] },
      { a: 'A2', b: 'A3', differences: ['narrative mode', 'POV', 'opening', 'human anchor', 'central question', 'structure'] },
    ]);
  });

  it('drops an approach that is the same film in other words, and keeps at most the number asked for', () => {
    const [a, b, c] = proposed() as [Angle, Angle, Angle];
    const twin: Angle = { ...a, title: 'The investigation, retold (test)', logline: 'Another wording of the same investigation (test).' };
    const r = run([a, twin, b, c], 2);
    expect(r.angles.map((x) => x.title)).toEqual([a.title, b.title]);
    expect(r.removed).toEqual([
      { title: twin.title, reason: `too close to "${a.title}": it differs only in wording` },
      { title: c.title, reason: 'beyond the 2 angles asked for' },
    ]);
  });

  it('keeps every angle inside the evidence: no unit outside the pack, no new figures, people, names or quotations', () => {
    const [a, b, c] = proposed() as [Angle, Angle, Angle];
    const r = run([
      { ...a, title: 'Outside units (test)', movements: [{ title: 'M (test)', unitKeys: ['S98', 'S99'], what: 'x (test)' }], opening: { ...a.opening, unitKey: 'S98' } },
      { ...b, title: 'An invented fortune (test)', logline: 'A fortune of 7,777 guilders vanished overnight (test).' },
      { ...c, title: 'An outsider (test)', resolution: 'Charles Mackay later made it famous (test).' },
      { ...a, title: 'An invented name (test)', humanAnchor: 'the trader Willem Fakerson (test)', narrativeMode: 'RISE_AND_FALL', povStrategy: { type: 'COMPANION', description: '' } },
      { ...b, title: 'A made-up quotation (test)', logline: 'A buyer cried "I have bought the wind itself" (test).', narrativeMode: 'SURVIVAL', povStrategy: { type: 'NARRATOR', description: '' } },
    ]);
    expect(r.angles).toEqual([]);
    expect(r.removed.map((x) => `${x.title}: ${x.reason}`)).toEqual([
      'Outside units (test): tells fewer than two story units of the pack (S98, S99 are not units of the pack)',
      "An invented fortune (test): uses figures that are not in the story units' evidence: 7777",
      "An outsider (test): names Charles Mackay, who is not in the story units' evidence",
      'An invented name (test): names Willem, Fakerson, which the evidence does not know (fictional devices are described, not named)',
      'A made-up quotation (test): puts "I have bought the wind itself" in quotation marks, but it is not a verified quotation of the units\' evidence',
    ]);
  });

  it('may use a unit the editor approved but did not select, flags HIGH-priority units left out, and labels the opening honestly', () => {
    const [a, b] = proposed() as [Angle, Angle];
    const r = run([
      { ...a, movements: [{ title: 'M1 (test)', unitKeys: ['S08', 'S07'], what: 'x (test)' }, { title: 'M2 (test)', unitKeys: ['S06', 'S01'], what: 'y (test)' }], opening: { concept: 'You open the ledger (test).', basis: 'DOCUMENTED', unitKey: 'S08' } },
      b,
    ]);
    const first = r.angles[0]!;
    expect(first.unitKeys).toEqual(['S08', 'S07', 'S06', 'S01']);
    expect(first.opening.basis).toBe('RECONSTRUCTION');
    expect(first.notes).toEqual(['the opening addresses the viewer: labelled RECONSTRUCTION, not DOCUMENTED', 'uses S08, approved by the editor but not selected']);
    expect(first.warnings).toEqual(['leaves out S03 "The innkeeper\'s orphans", which the editor marked HIGH priority']);
    expect(first.unusedUnits.map((u) => u.unitKey)).toEqual(['S02', 'S03', 'S04', 'S05']);
    expect(first.unusedUnits.every((u) => u.reason === 'No reason given.')).toBe(true);
  });

  it('as alternatives to an existing architecture, drops an approach that is that architecture again', () => {
    const selection = units.filter((u) => !u.reserve);
    const current = buildArchitecture(fakeArchitectOutput(selection.map((u) => ({ key: u.key, claims: u.claimKeys, characters: u.characters.map((c) => ({ name: c.name, kind: c.kind })) })), (k) => evidence.claim(k)?.verdict, { secondsPerSequence: 100 }), evidence, selection).content;
    const same: Angle = {
      ...proposed()[2]!,
      title: 'The current film again (test)',
      narrativeMode: current.narrativeMode,
      povStrategy: current.povStrategy,
      centralQuestion: current.centralQuestion,
      humanAnchor: current.centralHumanStakes,
      emotionalCentre: '',
      opening: { concept: current.sequences[0]!.beats[0]!.description, basis: 'RECONSTRUCTION', unitKey: 'S01' },
      movements: [{ title: 'All (test)', unitKeys: selection.map((u) => u.key), what: 'As before (test).' }],
    };
    const r = run([same, ...proposed().slice(0, 2)], 3, current);
    expect(r.removed).toEqual([{ title: same.title, reason: 'too close to architecture v4: it differs only in wording' }]);
    expect(r.angles).toHaveLength(2);
  });
});
