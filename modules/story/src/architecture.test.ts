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
    // C009 is DISPUTED: linking it means the sequence now needs a caveat for it.
    expect(built.findings).toEqual([{ kind: 'MISSING_CAVEAT', sequence: 2, detail: 'uses C009 (DISPUTED) without saying how the narration must present it' }]);
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
