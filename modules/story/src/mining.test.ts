import { describe, expect, it } from 'vitest';
import { EvidenceBase } from './evidence.ts';
import { applyAssessments, byRank, isDuplicate, legacyStoryFields, mythApplicable, normalizeMined, normalizeSelection, scoresFrom, type DraftCandidate, type PackCandidate } from './mining.ts';
import { computeMiningReport } from './quality.ts';
import type { CriticAssessment, MinedCandidate, SelectionOutput } from './schemas.ts';
import { FAKE_INVALID, FAKE_VALID, fakeEvidenceInput } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());
const normalizeAll = () => normalizeMined([...FAKE_VALID, ...FAKE_INVALID], evidence, { firstRef: 1, known: [], rejected: [] });

const assessment = (ref: string, over: Partial<CriticAssessment> = {}): CriticAssessment => ({
  candidateId: ref,
  humanStakes: 7,
  conflict: 6,
  mystery: 6,
  escalation: 5,
  characterPotential: 6,
  visualPotential: 7,
  emotionalPotential: 5,
  revealPotential: 5,
  mythInvestigation: 3,
  significance: 6,
  relevance: 7,
  uniqueness: 5,
  reasons: [{ dimension: 'humanStakes', reason: 'Someone stands to lose (test).' }],
  rationale: 'test',
  support: 'SUPPORTED',
  problems: [],
  caveat: null,
  ...over,
});

const PROPOSAL: SelectionOutput = {
  selected: [],
  workingPremise: '',
  rationale: '',
  alternates: [],
  centralQuestion: 'Why would anyone pay for goods nobody had seen?',
  narrativeMode: 'IMMERSIVE_RECONSTRUCTION',
  povStrategy: { type: 'VIEWER_POV', description: 'The viewer joins the traders.' },
};

function pack(drafts: DraftCandidate[]): PackCandidate[] {
  const { scored } = applyAssessments(drafts, drafts.map((d) => assessment(d.ref)));
  return scored
    .map(({ ref: _r, support: _s, ...c }) => ({ ...c, key: '', rank: 0, status: 'PROPOSED' as const, priority: 'NORMAL' as const, editorNotes: null, aiSelected: false, aiSelectionReason: null, carriedFrom: null }))
    .sort(byRank)
    .map((c, i) => ({ ...c, rank: i + 1, key: `S${String(i + 1).padStart(2, '0')}` }));
}

describe('evidence rules for mined candidates', () => {
  it('keeps evidence-backed stories and removes each kind of violation, with the reason', () => {
    const { kept, removed } = normalizeAll();
    expect(kept.map((k) => k.title)).toEqual([...FAKE_VALID.map((v) => v.title), 'Critic-flagged story']);
    const reasons = Object.fromEntries(removed.map((r) => [r.title, r.reason]));
    expect(reasons).toEqual({
      'The invented merchant': 'names a person who is not in the dossier: Hendrik Fakename',
      'A fortune of 7,777 guilders': 'uses figures that are not in the dossier: 7777',
      'The onion-eating sailor': expect.stringMatching(/^uses a MYTH claim without telling it as a myth/),
      'Contracts for bulbs underground': 'duplicates "Contracts for flowers still in the ground"',
      'Ghost claims': 'cites no claim in the dossier',
      'The chimney sweep': 'no claim it cites is backed by a retrieved source with a verified quote',
    });
  });

  it('links the claim a figure or a person comes from, and drops unknown keys', () => {
    const { kept, notes } = normalizeAll();
    const byTitle = new Map(kept.map((k) => [k.title, k]));
    expect(byTitle.get('Proefman in court')!.claimKeys).toEqual(['C008', 'C018']); // "300 guilders" is in C018
    expect(byTitle.get('How a pamphlet wrote history')!.claimKeys).toEqual(['C012', 'C013']); // Charles Mackay is named in C012
    expect(byTitle.get('Who really traded')!.claimKeys).toEqual(['C002', 'C016']);
    expect(notes).toContain('Proefman in court: linked C018 (source of the figure 300)');
    expect(notes).toContain('How a pamphlet wrote history: linked C012 (where the dossier names Charles Mackay)');
    expect(notes).toContain('Who really traded: unknown claim keys dropped (C777)');
  });

  it('computes historical status, confidence and sources from the claims', () => {
    const byTitle = new Map(normalizeAll().kept.map((k) => [k.title, k]));
    expect(byTitle.get("The innkeeper's orphans")).toMatchObject({ historicalStatus: 'ESTABLISHED', historicalConfidence: 10, sourceIds: ['src-E', 'src-B'] });
    expect(byTitle.get('The Semper Augustus price')).toMatchObject({ historicalStatus: 'CONTESTED' });
    expect(byTitle.get('The ruin that never happened')).toMatchObject({ historicalStatus: 'MYTH_INVESTIGATION' });
    expect(byTitle.get('Proefman in court')).toMatchObject({ historicalStatus: 'PROBABLE' });
    expect(byTitle.get('The Semper Augustus price')!.historicalConfidence).toBeLessThan(byTitle.get("The innkeeper's orphans")!.historicalConfidence);
  });

  it('drops a named character who is not in the dossier when the story does not depend on them', () => {
    const c = { ...FAKE_VALID[0]!, characters: [...FAKE_VALID[0]!.characters, { name: 'Pieter Onbekend', kind: 'NAMED_PERSON' as const, role: 'a witness', claimKeys: [] }] };
    const { kept, notes } = normalizeMined([c], evidence, { firstRef: 1, known: [], rejected: [] });
    expect(kept[0]!.characters.map((x) => x.name)).toEqual(['Haarlem buyers']);
    expect(notes[0]).toMatch(/Pieter Onbekend" dropped/);
  });

  it('removes stories that are not stories', () => {
    const c = { ...FAKE_VALID[0]!, conflict: ' ', payoff: '' };
    const { removed } = normalizeMined([c], evidence, { firstRef: 1, known: [], rejected: [] });
    expect(removed[0]!.reason).toBe('not a complete story: no conflict, payoff');
  });

  it('removes candidates too close to one carried over or rejected by the editor', () => {
    const known = [{ label: 'S04 The tavern colleges', title: 'The tavern colleges', claimKeys: ['C002', 'C017'] }];
    const rejected = [{ label: 'Striped tulips', title: 'Striped tulips', claimKeys: ['C014'] }];
    const { removed } = normalizeMined(FAKE_VALID, evidence, { firstRef: 1, known, rejected });
    expect(removed.map((r) => r.reason)).toEqual(['duplicates "S04 The tavern colleges"', 'too close to a candidate the editor rejected ("Striped tulips")']);
  });

  it('detects duplicates by claims and titles', () => {
    expect(isDuplicate({ title: 'A', claimKeys: ['C1', 'C2'] }, { title: 'B', claimKeys: ['C1', 'C2'] })).toBe(true);
    expect(isDuplicate({ title: 'The Alkmaar auction', claimKeys: ['C1', 'C2'] }, { title: 'Orphans and heirs', claimKeys: ['C1', 'C3'] })).toBe(false);
    expect(isDuplicate({ title: 'The Alkmaar auction', claimKeys: ['C1', 'C2'] }, { title: 'Auction at Alkmaar', claimKeys: ['C1', 'C3'] })).toBe(true); // same title
    expect(isDuplicate({ title: 'The Alkmaar auction', claimKeys: ['C1', 'C2'] }, { title: 'The orphans at the Alkmaar auction', claimKeys: ['C1', 'C2', 'C3', 'C4'] })).toBe(true);
    expect(isDuplicate({ title: 'The Alkmaar auction', claimKeys: ['C1'] }, { title: 'The Alkmaar auction', claimKeys: ['C9'] })).toBe(true);
  });
});

describe('critic assessments', () => {
  it('removes unsupported candidates, adds caveats, clamps scores and ranks', () => {
    const drafts = normalizeAll().kept.slice(0, 4);
    const { scored, removed, unassessed } = applyAssessments(drafts, [
      assessment(drafts[0]!.ref, { humanStakes: 14, conflict: -3, mystery: 6.6 }),
      assessment(drafts[1]!.ref, { support: 'UNSUPPORTED', problems: ['Claims the auction made 100,000 guilders'] }),
      assessment(drafts[2]!.ref, { support: 'NEEDS_CAVEAT', caveat: 'Say the figure is disputed.' }),
      assessment(drafts[2]!.ref, { support: 'UNSUPPORTED' }), // a repeat is ignored
    ]);
    expect(unassessed.map((d) => d.ref)).toEqual([drafts[3]!.ref]);
    expect(removed).toEqual([expect.objectContaining({ title: drafts[1]!.title, reason: 'the critic found statements the evidence does not support: Claims the auction made 100,000 guilders' })]);
    expect(scored[0]!.scores.story).toMatchObject({ humanStakes: 10, conflict: 0, mystery: 7 });
    expect(scored[1]!.notes).toContain('Say the figure is disputed.');
    for (const s of scored) {
      // Story appeal = story value moderated by historical value; the rank score is the appeal.
      expect(s.rankScore).toBe(s.scores.appeal);
      expect(s.scores.appeal).toBeLessThanOrEqual(s.scores.storyValue);
      expect(s.scores.history.evidenceQuality).toBe(s.historicalConfidence);
      expect(s.storyValue).toBe(s.scores.storyValue);
      expect(s.historicalValue).toBe(s.scores.historicalValue);
    }
  });
});

describe('selection proposal', () => {
  const pool = pack(normalizeAll().kept.slice(0, 12));

  it('keeps valid keys in the proposed order and tops up to the minimum, editor-approved first', () => {
    const approved = pool.map((c) => (c.key === 'S09' ? { ...c, status: 'APPROVED' as const } : c));
    const r = normalizeSelection(
      { ...PROPOSAL, selected: [{ candidateKey: 'S03', reason: 'opening' }, { candidateKey: 'S99', reason: '?' }, { candidateKey: 'S03', reason: 'again' }], workingPremise: 'p', rationale: 'r', alternates: ['S03', 'S11', 'S98'] },
      approved,
    );
    expect(r.keys).toEqual(['S03', 'S09', 'S01', 'S02', 'S04']);
    expect(r.reasons.get('S03')).toBe('opening');
    expect(r.alternates).toEqual(['S11']);
    expect(r.notes).toEqual(['Selection: unknown candidate S99 ignored', 'Selection: added S09, S01, S02, S04 to reach the minimum of 5']);
  });

  it('never selects a rejected candidate and cuts to the maximum', () => {
    const withRejected = pool.map((c) => (c.key === 'S02' ? { ...c, status: 'REJECTED' as const } : c));
    const r = normalizeSelection({ ...PROPOSAL, selected: withRejected.map((c) => ({ candidateKey: c.key, reason: '' })) }, withRejected);
    expect(r.keys).toHaveLength(10);
    expect(r.keys).not.toContain('S02');
    expect(r.notes).toContain('Selection: S02 was rejected by the editor; not selected');
  });
});

describe('mining quality gate', () => {
  it('passes a clean pack of 15 and reports what the rules removed', () => {
    const { kept, removed, notes } = normalizeAll();
    const candidates = pack(kept.filter((k) => k.title !== 'Critic-flagged story'));
    const report = computeMiningReport({ candidates, evidence, selectionKeys: candidates.slice(0, 6).map((c) => c.key), removed, normalizations: notes });
    expect(report.checks.filter((c) => c.status !== 'PASS').map((c) => c.id)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.normalizations).toContain('Removed "The chimney sweep" (CHARACTER): no claim it cites is backed by a retrieved source with a verified quote');
  });

  it('fails on too few candidates, untraceable or invented material, unmarked disputes, duplicates and missing scores', () => {
    const candidates = pack(normalizeAll().kept.slice(0, 8));
    const [a, b, c, d, e] = candidates;
    a!.claimKeys = ['C015']; // only an unverified claim, no retrieved source
    b!.characters = [...b!.characters, { name: 'Hendrik Fakename', kind: 'NAMED_PERSON', role: 'x', claimKeys: [] }];
    c!.stakes = 'A loss of 4,321 guilders.';
    d!.historicalStatus = 'ESTABLISHED';
    d!.claimKeys = ['C009']; // DISPUTED
    e!.scores = null as never;
    const dup = { ...candidates[5]!, key: 'S99' };
    const report = computeMiningReport({ candidates: [...candidates, dup], evidence, selectionKeys: ['S01', 'S02'], removed: [], normalizations: [] });
    const failed = report.checks.filter((x) => x.status === 'FAIL').map((x) => x.id);
    expect(failed).toEqual(['candidate_count', 'traceable_sources', 'grounded_people', 'supported_figures', 'historical_status', 'no_duplicates', 'scores_complete', 'selection_proposal']);
    expect(report.passed).toBe(false);
  });

  it('fails a myth told without its investigation', () => {
    const candidates = pack(normalizeAll().kept);
    const myth = candidates.find((c) => c.historicalStatus === 'MYTH_INVESTIGATION')!;
    myth.mythThread = null;
    const report = computeMiningReport({ candidates, evidence, selectionKeys: candidates.slice(0, 6).map((c) => c.key), removed: [], normalizations: [] });
    expect(report.checks.find((c) => c.id === 'myth_framing')).toMatchObject({ status: 'FAIL', metric: 1 });
  });
});

describe('Story Engine 2.0 mining', () => {
  const base = FAKE_VALID[1]!; // The tavern colleges: C002 (ESTABLISHED), C017 (ESTABLISHED); florists

  // Variants of one unit share its claims, so each is normalized on its own (the duplicate rule would merge them).
  const each = (variants: MinedCandidate[]) => {
    const runs = variants.map((v) => normalizeMined([v], evidence, { firstRef: 1, known: [], rejected: [] }));
    return { kept: runs.flatMap((r) => r.kept), notes: runs.flatMap((r) => r.notes) };
  };

  it('keeps the human stakes and labels the cold open honestly (relabelling is recorded)', () => {
    const { kept, notes } = each([
      { ...base, title: 'Addressed to the viewer', coldOpen: { text: 'You push open the door of a crowded room.', basis: 'DOCUMENTED' } },
      { ...FAKE_VALID[6]!, title: 'A disputed price told as fact', coldOpen: { text: 'A single bulb sold for a fortune.', basis: 'DOCUMENTED' } },
      { ...base, title: 'Honest documented opening', coldOpen: { text: 'Florists met in taverns to deal.', basis: 'DOCUMENTED' } },
    ]);
    expect(kept.map((k) => k.storyDesign.coldOpen.basis)).toEqual(['RECONSTRUCTION', 'UNCERTAIN', 'DOCUMENTED']);
    expect(notes).toContain('Addressed to the viewer: cold open addressed to the viewer relabelled RECONSTRUCTION');
    expect(notes).toContain('A disputed price told as fact: cold open relabelled UNCERTAIN (the story rests on claims that are not ESTABLISHED)');
    expect(kept[0]!.humanStakes).toEqual({ protagonist: 'florists', couldGain: base.couldGain, couldLose: base.couldLose, immediateProblem: base.immediateProblem });
  });

  it('finds a human story only when a character has something at stake', () => {
    const { kept } = each([
      { ...base, title: 'With a protagonist' },
      { ...base, title: 'No protagonist recorded', protagonist: '' },
      { ...base, title: 'Protagonist is not a character', protagonist: 'a mysterious stranger' },
      { ...base, title: 'Nothing at stake', couldGain: '', couldLose: '' },
    ]);
    expect(kept.map((k) => [k.title, k.storyDesign.humanStory])).toEqual([
      ['With a protagonist', true],
      ['No protagonist recorded', false],
      ['Protagonist is not a character', false],
      ['Nothing at stake', false],
    ]);
  });

  it('rejects figures in the new story fields that are not in the evidence', () => {
    const { removed } = normalizeMined([{ ...base, title: 'Invented loss', couldLose: 'A loss of 6,543 guilders.' }], evidence, { firstRef: 1, known: [], rejected: [] });
    expect(removed[0]!.reason).toBe('uses figures that are not in the dossier: 6543');
  });

  it('scores story value and historical value separately, with myth potential only where it applies', () => {
    const drafts = normalizeAll().kept;
    const myth = drafts.find((d) => d.historicalStatus === 'MYTH_INVESTIGATION')!;
    const plain = drafts.find((d) => d.historicalStatus === 'ESTABLISHED')!;
    expect(mythApplicable(myth)).toBe(true);
    expect(mythApplicable(plain)).toBe(false);
    const raw = assessment('x', { mythInvestigation: 10, reasons: [{ dimension: 'mystery', reason: ' why ' }, { dimension: 'mystery', reason: 'again' }, { dimension: 'bogus', reason: 'x' }] });
    const m = scoresFrom(raw, myth);
    const p = scoresFrom(raw, plain);
    expect(m.mythApplicable).toBe(true);
    expect(p.mythApplicable).toBe(false);
    expect(m.storyValue).toBeGreaterThan(p.storyValue); // the myth dimension only counts for the myth
    expect(p.reasons).toEqual([{ dimension: 'mystery', reason: 'why' }]);
    expect(p.history).toEqual({ evidenceQuality: plain.historicalConfidence, significance: 6, relevance: 7, uniqueness: 5 });
  });

  it('derives engine-2 fields for an engine-1 candidate from what it already says', () => {
    const f = legacyStoryFields({ storyType: 'MYTH_ORIGIN', characters: [{ name: 'Charles Mackay', kind: 'NAMED_PERSON', role: 'author', claimKeys: ['C012'] }], hook: 'h', setting: 's', stakes: 'st', conflict: 'c', turningPoint: 't', viewerQuestion: 'q?' });
    expect(f).toMatchObject({ narrativeMode: 'MYTH_VS_RECORD', centralQuestion: 'q?', povStrategy: { type: 'NARRATOR' }, humanStakes: { protagonist: 'Charles Mackay', couldLose: 'st' } });
    expect(f.storyDesign.coldOpen).toEqual({ text: 'h', basis: 'UNCERTAIN' });
  });

  it('warns when the proposal includes a unit with no human story', () => {
    const candidates = pack(normalizeAll().kept.filter((k) => k.title !== 'Critic-flagged story'));
    candidates[0]!.storyDesign = { ...candidates[0]!.storyDesign, humanStory: false };
    const report = computeMiningReport({ candidates, evidence, selectionKeys: candidates.slice(0, 6).map((c) => c.key), removed: [], normalizations: [] });
    expect(report.checks.find((c) => c.id === 'human_stories')).toMatchObject({ status: 'WARN' });
    candidates[1]!.storyDesign = { ...candidates[1]!.storyDesign, coldOpen: { text: 'You see it all.', basis: 'DOCUMENTED' } };
    const again = computeMiningReport({ candidates, evidence, selectionKeys: candidates.slice(0, 6).map((c) => c.key), removed: [], normalizations: [] });
    expect(again.checks.find((c) => c.id === 'cold_open_labelled')).toMatchObject({ status: 'FAIL' });
  });
});
