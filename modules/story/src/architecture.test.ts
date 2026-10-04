import { runtimeTarget } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { blockingCount, buildArchitecture, type SelectedUnit } from './architecture.ts';
import { EvidenceBase } from './evidence.ts';
import { normalizeMined } from './mining.ts';
import { computeArchitectureReport } from './quality.ts';
import type { ArchitectOutput, ArchitectSequence } from './schemas.ts';
import { FAKE_VALID, fakeEvidenceInput } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());
const target = runtimeTarget({ targetMinutesMin: 10, targetMinutesMax: 15 });

/** Six selected units: S01 Contracts…, S02 The tavern colleges, S03 The innkeeper's orphans, S04 …, S05 …, S06 Proefman in court. */
const units: SelectedUnit[] = normalizeMined(FAKE_VALID.slice(0, 7), evidence, { firstRef: 1, known: [], rejected: [] }).kept.map((d, i) => ({
  ...d,
  id: `cand-${i + 1}`,
  key: `S0${i + 1}`,
  notes: null,
  rankScore: 7 - i * 0.1,
  status: 'PROPOSED',
  priority: 'NORMAL',
  editorNotes: null,
}));

function seq(u: SelectedUnit, over: Partial<ArchitectSequence> = {}): ArchitectSequence {
  return {
    title: `Sequence on ${u.title}`,
    purpose: 'Moves the story on.',
    candidateKeys: [u.key],
    openingHook: 'A hook.',
    narrativeQuestion: 'What happens next?',
    keyEvents: [
      { event: 'First turn', claimKeys: [u.claimKeys[0]!] },
      { event: 'Second turn', claimKeys: [u.claimKeys.at(-1)!] },
    ],
    characters: u.characters.map((c) => c.name),
    conflict: 'A conflict.',
    escalation: 'It escalates.',
    reveal: 'A reveal.',
    endingBeat: 'And then…',
    claimKeys: u.claimKeys,
    contextClaims: [],
    caveats: [],
    estimatedDurationSec: 120,
    ...over,
  };
}

function output(sequences: ArchitectSequence[], over: Partial<ArchitectOutput> = {}): ArchitectOutput {
  return { premise: 'A premise.', centralQuestion: 'Why did a flower trade end in court?', narrativeSpine: 'A spine.', resolution: 'An answer.', sequences, unusedCandidates: [], ...over };
}

const report = (built: ReturnType<typeof buildArchitecture>, issues = [] as Parameters<typeof computeArchitectureReport>[0]['issues']) =>
  computeArchitectureReport({ content: built.content, evidence, units, findings: built.findings, issues, normalizations: built.notes, target });

/** Caveats every unit needs (S07 = the Semper Augustus price, DISPUTED). */
const withCaveats = (u: SelectedUnit) => seq(u, { caveats: u.claimKeys.filter((k) => ['DISPUTED', 'MYTH', 'UNVERIFIED'].includes(evidence.claim(k)!.verdict)).map((k) => ({ claimKey: k, framing: 'Told as disputed.' })) });

describe('building the architecture', () => {
  it('derives sources, status and confidence per sequence and passes a clean blueprint', () => {
    const built = buildArchitecture(output(units.map(withCaveats)), evidence, units);
    expect(built.findings).toEqual([]);
    const s3 = built.content.sequences[2]!;
    expect(s3).toMatchObject({ number: 3, candidateIds: ['cand-3'], candidateKeys: ['S03'], claimKeys: ['C003', 'C004'], historicalStatus: 'ESTABLISHED', historicalConfidence: 10 });
    expect(s3.sourceIds.sort()).toEqual(['src-B', 'src-E']);
    expect(built.content.sequences[6]!).toMatchObject({ historicalStatus: 'CONTESTED' });
    const r = report(built);
    // Sequence 7 rests on one disputed claim: shaky, so a warning for the editor.
    expect(r.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.id}:${c.status}`)).toEqual(['historical_confidence:WARN']);
    expect(r.passed).toBe(true);
  });

  it('flags disputed or myth claims without a caveat (presented as established)', () => {
    const built = buildArchitecture(output(units.map((u) => seq(u))), evidence, units);
    expect(built.findings).toEqual([{ kind: 'MISSING_CAVEAT', sequence: 7, detail: 'uses C009 (DISPUTED) without saying how the narration must present it' }]);
    expect(report(built).checks.find((c) => c.id === 'uncertainty_framed')).toMatchObject({ status: 'FAIL' });
  });

  it('flags invented people, unsupported figures and events without evidence', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, characters: [...s[0]!.characters, 'Hendrik Fakename'], reveal: 'A loss of 4,321 guilders.' };
    s[1] = { ...s[1]!, keyEvents: [...s[1]!.keyEvents, { event: 'An invented event', claimKeys: ['C999'] }] };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings.map((f) => f.kind)).toEqual(['UNGROUNDED_PERSON', 'UNSUPPORTED_FIGURE', 'EVENT_WITHOUT_EVIDENCE']);
    expect(built.content.sequences[0]!.characters).not.toContain('Hendrik Fakename');
    expect(blockingCount(built.findings)).toBe(3);
    const failed = report(built).checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
    expect(failed).toEqual(['evidence', 'grounded_people', 'supported_figures']);
  });

  it('links the claim a figure comes from instead of failing', () => {
    const s = units.map(withCaveats);
    s[1] = { ...s[1]!, reveal: 'Prices were reported at 5,500 guilders for one bulb.' };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.content.sequences[1]!.claimKeys).toContain('C009');
    // C009 is DISPUTED: linking it means the sequence now needs a caveat for it, and the finding says why it was linked.
    expect(built.findings).toEqual([
      {
        kind: 'MISSING_CAVEAT',
        sequence: 2,
        detail: 'uses C009 (DISPUTED) without saying how the narration must present it (the evidence rules linked it for the figure 5500: add a caveat for it, or drop the figure 5500)',
      },
    ]);
  });

  it('ignores units outside the selection, and requires HIGH-priority units and reasons for unused ones', () => {
    const high = units.map((u) => (u.key === 'S06' ? { ...u, priority: 'HIGH' as const } : u));
    const s = high.slice(0, 5).map(withCaveats);
    s[0] = { ...s[0]!, candidateKeys: ['S01', 'S42'] };
    const built = buildArchitecture(output(s, { unusedCandidates: [{ candidateKey: 'S07', reason: 'Too contested for this cut.' }] }), evidence, high);
    expect(built.notes).toContain('Sequence 1: S42 is not a selected unit; ignored');
    expect(built.findings.map((f) => f.kind)).toEqual(['HIGH_PRIORITY_UNUSED']);
    expect(built.content.unusedCandidates).toEqual([
      { candidateKey: 'S06', reason: 'No reason given.' },
      { candidateKey: 'S07', reason: 'Too contested for this cut.' },
    ]);
    const r = computeArchitectureReport({ content: built.content, evidence, units: high, findings: built.findings, issues: [], normalizations: [], target });
    expect(r.checks.find((c) => c.id === 'editor_priorities')).toMatchObject({ status: 'FAIL' });
  });
});

describe('story evidence is the selected units\' own claims', () => {
  // The seven units above rest on C001–C009, C017, C018 and C020; C010–C016 and C019 belong to no selected unit.
  const failed = (b: ReturnType<typeof buildArchitecture>) => report(b).checks.filter((c) => c.status === 'FAIL').map((c) => c.id);

  it('fails story evidence and key events taken from outside the selection', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, claimKeys: [...s[0]!.claimKeys, 'C016'] };
    s[1] = { ...s[1]!, keyEvents: [...s[1]!.keyEvents, { event: 'A beat from elsewhere', claimKeys: ['C013'] }] };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings.map((f) => `${f.sequence}:${f.kind}`)).toEqual(['1:CORE_OUTSIDE_SELECTION', '2:EVENT_OUTSIDE_SELECTION', '2:CORE_OUTSIDE_SELECTION']);
    expect(built.content.sequences[0]!.claimKeys).toContain('C016'); // kept, so the gate sees what was proposed
    expect(failed(built)).toEqual(['core_evidence']);
  });

  it('accepts other dossier claims only as labelled background, with their own sources and caveats', () => {
    const s = units.map(withCaveats);
    s[0] = {
      ...s[0]!,
      contextClaims: [
        { claimKey: 'C016', purpose: 'Who the traders were' },
        { claimKey: 'C019', purpose: 'The debate the film leaves open' },
        { claimKey: 'C001', purpose: 'already a unit claim' },
      ],
      caveats: [...s[0]!.caveats, { claimKey: 'C019', framing: 'As a debate between economists.' }],
    };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings).toEqual([]);
    const sq = built.content.sequences[0]!;
    expect(sq.claimKeys).toEqual(['C001', 'C020']);
    expect(sq.contextClaims).toEqual([
      { claimKey: 'C016', purpose: 'Who the traders were' },
      { claimKey: 'C019', purpose: 'The debate the film leaves open' },
    ]);
    expect(built.notes).toContain('Sequence 1: C001 is a claim of the selected units; counted as story evidence, not context');
    expect(sq.sourceIds.sort()).toEqual(['src-A', 'src-B']);
    expect(sq.contextSourceIds).toEqual(['src-F']); // C016's source B is already a story source; C019 adds F
    expect(sq.historicalStatus).toBe('CONTESTED'); // a disputed context claim still counts
    expect(report(built).checks.find((c) => c.id === 'context_claims')).toMatchObject({ status: 'PASS' }); // 2 background vs 2 story claims

    // Background must not outweigh the story evidence.
    s[0] = { ...s[0], contextClaims: [...s[0].contextClaims, { claimKey: 'C013', purpose: 'How it was reported' }] };
    const heavier = buildArchitecture(output(s), evidence, units);
    expect(report(heavier).checks.find((c) => c.id === 'context_claims')).toMatchObject({ status: 'WARN', detail: '1: Sequence 1: 3 context claims against 2 story claims' });
  });

  it('requires a purpose and a caveat for background claims', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, contextClaims: [{ claimKey: 'C019', purpose: ' ' }] };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings.map((f) => f.kind)).toEqual(['CONTEXT_WITHOUT_PURPOSE', 'MISSING_CAVEAT']);
    expect(failed(built)).toEqual(['context_claims', 'uncertainty_framed']);
  });

  it('lets no person, figure or date in from outside the selection', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, reveal: 'In 1841 Charles Mackay told it differently.', contextClaims: [{ claimKey: 'C012', purpose: 'How the story was retold' }] };
    s[1] = { ...s[1]!, characters: [...s[1]!.characters, 'Charles Mackay'] };
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings.map((f) => `${f.sequence}:${f.kind}`)).toEqual(['1:UNSUPPORTED_FIGURE', '1:PERSON_OUTSIDE_SELECTION', '2:UNGROUNDED_PERSON']);
    expect(built.findings[0]!.detail).toBe("uses the figure 1841, which is not in the selected units' evidence");
    expect(failed(built)).toEqual(['grounded_people', 'supported_figures']);
  });

  it('still links a figure or person found in another selected unit\'s claims', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, reveal: 'A total of 90,000 guilders, Jan Testbroek\'s estate.' }; // both in unit S03's claims
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings).toEqual([]);
    expect(built.content.sequences[0]!.claimKeys).toEqual(['C001', 'C003', 'C020']);
  });

  it('fails a sequence that tells no selected unit', () => {
    const s = units.map(withCaveats);
    s.push({ ...withCaveats(units[0]!), title: 'A new story', candidateKeys: [] });
    const built = buildArchitecture(output(s), evidence, units);
    expect(built.findings.map((f) => f.kind)).toEqual(['NO_UNIT']);
    expect(failed(built)).toContain('selected_units');
  });
});

describe('architecture quality gate', () => {
  it('fails a blueprint far off the runtime and warns near it', () => {
    const short = buildArchitecture(output(units.map((u) => withCaveats(u)).map((s) => ({ ...s, estimatedDurationSec: 40 }))), evidence, units);
    expect(report(short).checks.find((c) => c.id === 'runtime')).toMatchObject({ status: 'FAIL', metric: 280 });
    const near = buildArchitecture(output(units.map((u) => withCaveats(u)).map((s) => ({ ...s, estimatedDurationSec: 75 }))), evidence, units);
    expect(report(near).checks.find((c) => c.id === 'runtime')).toMatchObject({ status: 'WARN', metric: 525 });
  });

  it('fails a list of facts and a missing central question', () => {
    const flat = units.map((u) => ({ ...withCaveats(u), conflict: '', escalation: '', reveal: '', narrativeQuestion: '' }));
    const built = buildArchitecture(output(flat, { centralQuestion: '' }), evidence, units);
    const failed = report(built).checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
    expect(failed).toEqual(['central_question', 'story_structure']);
  });

  it('fails on unresolved critical review issues, warns on major ones', () => {
    const built = buildArchitecture(output(units.map(withCaveats)), evidence, units);
    const critical = report(built, [{ severity: 'CRITICAL', description: 'Sequence 2 presents a dispute as fact', claimKeys: [], resolution: 'Left for human review' }]);
    expect(critical.checks.find((c) => c.id === 'review')).toMatchObject({ status: 'FAIL' });
    const fixed = report(built, [{ severity: 'CRITICAL', description: 'x', claimKeys: [], resolution: 'Fixed in the revised architecture' }, { severity: 'MAJOR', description: 'y', claimKeys: [], resolution: 'Left for human review' }]);
    expect(fixed.checks.find((c) => c.id === 'review')).toMatchObject({ status: 'WARN' });
    expect(fixed.passed).toBe(true);
  });

  it('warns when a sequence estimate does not fit its structure', () => {
    const s = units.map(withCaveats);
    s[0] = { ...s[0]!, estimatedDurationSec: 400 };
    expect(report(buildArchitecture(output(s), evidence, units)).checks.find((c) => c.id === 'duration_consistency')).toMatchObject({ status: 'WARN', metric: 1 });
  });
});

describe('evidence for characters', () => {
  // Shaped like the live Tulip Mania run: the florists appear in an established claim, a myth and the pamphlets.
  const s02 = units[1]!;
  const colleges: SelectedUnit = {
    ...s02,
    claimKeys: ['C002', 'C010', 'C013', 'C017'],
    characters: [
      { name: 'florists', kind: 'GROUP', role: 'Trade bulbs in the taverns', claimKeys: ['C002', 'C010', 'C013'] },
      { name: 'ruined speculators', kind: 'GROUP', role: 'The legend', claimKeys: ['C010'] },
    ],
  };
  const selection = [units[0]!, colleges, ...units.slice(2)];
  const build = (over: Partial<ArchitectSequence>) =>
    buildArchitecture(output([seq(colleges, { keyEvents: [{ event: 'The colleges meet in the inn', claimKeys: ['C002'] }], ...over })]), evidence, selection);
  const missingCaveats = (built: ReturnType<typeof build>) => built.findings.filter((f) => f.kind === 'MISSING_CAVEAT');

  it('does not pull every claim that names a character into the sequence', () => {
    // The live failure: the reviewer dropped the myth from a sequence, and naming the florists brought it back.
    const built = build({ claimKeys: ['C002', 'C017'], characters: ['florists'] });
    expect(built.content.sequences[0]!.claimKeys).toEqual(['C002', 'C017']);
    expect(missingCaveats(built)).toEqual([]);
  });

  it('links only the firmest claim of a character the sequence does not cite', () => {
    const built = build({ claimKeys: ['C017'], keyEvents: [{ event: 'Haarlem is the centre of the trade', claimKeys: ['C017'] }], characters: ['florists'] });
    expect(built.content.sequences[0]!.claimKeys).toEqual(['C002', 'C017']);
    expect(built.notes).toContain('Sequence 1: linked C002 (evidence for the character florists)');
    expect(missingCaveats(built)).toEqual([]);
  });

  it('says why a claim the rules linked needs a caveat', () => {
    const built = build({ claimKeys: ['C002', 'C017'], characters: ['ruined speculators'] });
    expect(built.content.sequences[0]!.claimKeys).toEqual(['C002', 'C010', 'C017']);
    expect(missingCaveats(built)).toEqual([
      {
        kind: 'MISSING_CAVEAT',
        sequence: 1,
        detail: 'uses C010 (MYTH) without saying how the narration must present it (the evidence rules linked it for the character ruined speculators: add a caveat for it, or drop the character ruined speculators)',
      },
    ]);
    // With the caveat the sequence is sound.
    const framed = build({ claimKeys: ['C002', 'C017'], characters: ['ruined speculators'], caveats: [{ claimKey: 'C010', framing: 'The ruin is the legend, not the record.' }] });
    expect(missingCaveats(framed)).toEqual([]);
  });
});
