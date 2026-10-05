import { StoryArchitectureContent } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { buildArchitecture, toArchitectOutput, type SelectedUnit } from './architecture.ts';
import { diffArchitectures, unaddressedAspects } from './diff.ts';
import { EvidenceBase } from './evidence.ts';
import { normalizeMined } from './mining.ts';
import { ArchitectOutput } from './schemas.ts';
import { FAKE_VALID, fakeArchitectOutput, fakeEvidenceInput, fakeRevision, type FakeUnit } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());

/** Eight units as in the architecture tests; S08 is held in reserve (approved, not selected) where a test says so. */
const allUnits: SelectedUnit[] = normalizeMined(FAKE_VALID.slice(0, 8), evidence, { firstRef: 1, known: [], rejected: [] }).kept.map((d, i) => ({
  ...d,
  id: `cand-${i + 1}`,
  key: `S0${i + 1}`,
  notes: null,
  rankScore: 7 - i * 0.1,
  status: 'PROPOSED',
  priority: 'NORMAL',
  editorNotes: null,
  selectionOrder: null,
  reserve: false,
}));
const verdictOf = (k: string) => evidence.claim(k)?.verdict;
const fake = (us: readonly SelectedUnit[]): FakeUnit[] => us.map((u) => ({ key: u.key, claims: u.claimKeys, characters: u.characters.map((c) => ({ name: c.name, kind: c.kind })), reserve: u.reserve }));
const selection = allUnits.slice(0, 7);
const withReserve: SelectedUnit[] = [...selection, { ...allUnits[7]!, status: 'APPROVED', reserve: true }];

/** The base: one sequence per selected unit, 100 s each, built and checked by the rules. */
const base = buildArchitecture(fakeArchitectOutput(fake(selection), verdictOf, { secondsPerSequence: 100 }), evidence, selection);

/** A revision prompt as the stage writes it (only the parts the fake reads). */
function revisionPrompt(units: readonly SelectedUnit[]): string {
  const renderUnits = units
    .map((u) => `## ${u.key}${u.reserve ? ' · approved by the editor, not selected (optional)' : ''} · ${u.historicalStatus} ${u.historicalConfidence}/10 — ${u.title} [${u.storyType}]\ncharacters: ${u.characters.map((c) => `${c.name} (${c.kind}): ${c.role}`).join('; ')}\nclaims: ${u.claimKeys.join(', ')}`)
    .join('\n\n');
  return [
    '# Architecture v1 (IN_REVIEW) — the version to revise (it is kept unchanged; yours becomes a new version)',
    JSON.stringify(toArchitectOutput(base.content), null, 1),
    '',
    '# Story units you may use (the selection, then units the editor approved but did not select)',
    renderUnits,
    '',
    "# Story evidence: the units' claims",
  ].join('\n');
}

describe('a revision of an architecture', () => {
  it('starts from a clean base', () => {
    expect(base.findings).toEqual([]);
  });

  it('may restructure substantially — reorder, merge, bring in an approved unit, change mode, POV, question and opening — inside the rules', () => {
    const raw = fakeRevision(revisionPrompt(withReserve), verdictOf, {
      order: (keys, reserve) => [...reserve, ...[...keys].reverse().filter((k) => k !== 'S02')],
      merge: [['S04', 'S05']],
    });
    const revised = buildArchitecture(ArchitectOutput.parse(raw), evidence, withReserve);
    expect(revised.findings).toEqual([]);
    const d = diffArchitectures(base.content, revised.content);
    expect(d).toMatchObject({
      substantial: true,
      unitsAdded: ['S08'],
      unitsRemoved: ['S02'],
      reordered: true,
      merged: [['S04', 'S05']],
      split: [],
      sequences: { before: 7, after: 6 },
      narrativeMode: { changed: true, before: 'IMMERSIVE_RECONSTRUCTION', after: 'INVESTIGATION' },
      pov: { changed: true },
      centralQuestion: { changed: true, after: 'Who was left holding the promises (revised, test)?' },
      opening: { changed: true, before: 'The story of S01: You stand at the edge of the crowd as the bidding starts (test).', after: 'The story of S08: You stand at the edge of the crowd as the bidding starts (test).' },
      logline: { changed: true },
      humanStakes: { changed: true },
    });
    expect(d.unitsAfter).toEqual(['S08', 'S07', 'S06', 'S04', 'S05', 'S03', 'S01']);
    // S02 was a selected unit: the revision says why it left it out. S08 is in reserve: no reason needed either way.
    expect(revised.content.unusedCandidates).toEqual([{ candidateKey: 'S02', reason: 'Folded into the investigation (test).' }]);
    expect(raw.changeLog.changes.map((c) => c.area)).toEqual(['STRUCTURE', 'OPENING', 'POV', 'CENTRAL_QUESTION']);
    expect(unaddressedAspects(['STRUCTURE', 'OPENING', 'POV', 'CENTRAL_QUESTION', 'PACING', 'NARRATIVE_STRATEGY', 'ANGLE', 'EMOTIONAL_CENTRE', 'HUMAN_STAKES'], d)).toEqual([]);
  });

  it('cannot leave the evidence boundary: units outside the pool are ignored, outside claims and invented facts are findings', () => {
    const raw = fakeRevision(revisionPrompt(selection), verdictOf, {
      transform: (r) => {
        r.sequences[0]!.candidateKeys.push('S09');
        r.sequences[0]!.beats[1]!.claimKeys.push('C019');
        r.sequences[0]!.claimKeys.push('C019');
        r.sequences[1]!.beats[1]!.description = 'Buyers pay 7,777 guilders for a single bulb (test).';
        return r;
      },
    });
    const revised = buildArchitecture(ArchitectOutput.parse(raw), evidence, selection);
    expect(revised.notes).toContain('Sequence 1: S09 is not a selected unit; ignored');
    expect(revised.findings.map((f) => f.kind).sort()).toEqual(['BEAT_OUTSIDE_SELECTION', 'CORE_OUTSIDE_SELECTION', 'MISSING_PRESENTATION', 'UNSUPPORTED_FIGURE']);
  });

  it('reports what the editor named that did not measurably change', () => {
    const raw = fakeRevision(revisionPrompt(selection), verdictOf, { unchanged: true });
    const same = buildArchitecture(ArchitectOutput.parse(raw), evidence, selection);
    const d = diffArchitectures(base.content, same.content);
    expect(d.substantial).toBe(false);
    expect(d).toMatchObject({ unitsAdded: [], unitsRemoved: [], reordered: false, merged: [], split: [], opening: { changed: false }, centralQuestion: { changed: false } });
    expect(unaddressedAspects(['OPENING', 'POV', 'STRUCTURE', 'OPENING'], d)).toEqual(['OPENING', 'POV', 'STRUCTURE']);
  });

  it('detects a split and a pure reorder', () => {
    const merged = fakeRevision(revisionPrompt(selection), verdictOf, { order: (keys) => keys, merge: [['S01', 'S02']] });
    const mergedBuilt = buildArchitecture(ArchitectOutput.parse(merged), evidence, selection);
    const back = diffArchitectures(mergedBuilt.content, base.content);
    expect(back).toMatchObject({ split: [['S01', 'S02']], merged: [], reordered: false, sequences: { before: 6, after: 7 } });

    const swapped = fakeRevision(revisionPrompt(selection), verdictOf, { order: (keys) => [keys[1]!, keys[0]!, ...keys.slice(2)] });
    const d = diffArchitectures(base.content, buildArchitecture(ArchitectOutput.parse(swapped), evidence, selection).content);
    expect(d).toMatchObject({ reordered: true, unitsAdded: [], unitsRemoved: [], merged: [], opening: { changed: true } });
  });

  it('compares with an engine-1 base too', () => {
    const v1 = StoryArchitectureContent.parse({
      premise: 'An engine-1 premise.',
      centralQuestion: 'Why did it end in court?',
      narrativeSpine: 'Spine.',
      resolution: 'Answer.',
      sequences: [
        { number: 1, title: 'First', purpose: '', candidateIds: [], candidateKeys: ['S01'], openingHook: 'Hook.', narrativeQuestion: '', keyEvents: [{ event: 'E', claimKeys: ['C001'] }], characters: [], conflict: '', escalation: '', reveal: '', endingBeat: '', claimKeys: ['C001'], sourceIds: [], caveats: [], historicalStatus: 'ESTABLISHED', historicalConfidence: 9, estimatedDurationSec: 120 },
      ],
      unusedCandidates: [],
    });
    const d = diffArchitectures(v1, base.content);
    expect(d).toMatchObject({ unitsBefore: ['S01'], unitsAdded: ['S02', 'S03', 'S04', 'S05', 'S06', 'S07'], logline: { before: 'An engine-1 premise.' }, narrativeMode: { before: '', changed: true }, reconstruction: { before: 'n/a' } });
  });
});
