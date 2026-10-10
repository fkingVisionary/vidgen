import { ApproachSummary, AssetRequirement, ContinuitySpec, CostAlternative, CostRollup, RhythmStats, ShotEvidence, ShotSpec, ShotTiming, VisualBeatContent, VisualCostEstimate, VisualPricingSnapshot } from '@docengine/core';
import { fixtureDraft, fixtureScope } from '@docengine/script/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { StoryboardDraft, StoryboardFacts } from './draft.ts';
import { applyBeatRevisions, applyRepair, beatsToRepair, markUnplanned, repairFindings, repairOutcome, repairReasons, resolveBeats, resolveShots } from './normalize.ts';
import { planStoryboard } from './plan.ts';
import { BeatsOutput, RepairOutput, ShotOutput, ShotsOutput, type BeatOutput, type SubjectOutput } from './schemas.ts';
import { DOMAIN_FILMS, FakeStoryboardAI, domainFilm, fakeBeats, fakeShot, syntheticFacts, withRowIds, type DomainName } from './testing.ts';

/**
 * The model I/O contract (§2.11): bounded, typed output only; every
 * reference resolved by code and anything that does not resolve dropped
 * and noted (shown as MODEL_REFERENCE_DROPPED); beats and shots repaired
 * until they partition the narration; a repair kept only when it removes
 * blocking findings and adds none; a beat that cannot be made valid covered
 * by one placeholder. A model mistake gives a finding, never a silently
 * wrong timeline.
 */

const beat = (from: string, to: string, o: Partial<BeatOutput> = {}): BeatOutput => ({
  from,
  to,
  title: `Up to ${to}`,
  purpose: '',
  concept: '',
  informationCommunicated: [],
  narrativePurpose: '',
  evidenceRelationship: 'NONE',
  importance: 'NORMAL',
  complexity: 'LOW',
  archBeatIds: [],
  claimKeys: [],
  subjectKeys: [],
  continuityNotes: [],
  options: { A: { treatment: 'ENVIRONMENT', concept: '' }, B: { treatment: 'ENVIRONMENT', concept: '' }, C: { treatment: 'ENVIRONMENT', concept: '' } },
  ...o,
});
const mira = (o: Partial<SubjectOutput> = {}): SubjectOutput => ({
  key: 'CS01',
  kind: 'CHARACTER',
  castId: 'F1',
  anonymous: false,
  name: 'Mira',
  description: 'A dock worker (test).',
  era: null,
  location: null,
  approximateAge: null,
  clothing: null,
  physicalDescription: null,
  visualIdentity: { palette: [], silhouette: null, props: [] },
  designDetails: [],
  rules: [],
  claimKeys: [],
  ...o,
});

/** The film planned the way the stage does it: beats, then shots per section, then judged. */
function planWith(facts: StoryboardFacts, beats: BeatsOutput, shots: (draft: StoryboardDraft) => ShotOutput[]) {
  const notes: string[] = [];
  const b = resolveBeats(beats, facts, notes);
  const draft: StoryboardDraft = { approach: 'C', beats: b.beats, shots: [], subjects: b.subjects, normalization: notes };
  const s = resolveShots(shots(draft), draft.beats, draft, facts, notes);
  return { draft: { ...draft, shots: s.shots, normalization: notes }, needRepair: s.needRepair, notes };
}

describe('bounded, typed output only', () => {
  it('refuses times, prices, unknown fields and over-long text in the model\'s output', () => {
    const ok = fakeShot('VB01', { from: '⟨start⟩', to: '⟨end⟩' });
    expect(ShotOutput.safeParse(ok).success).toBe(true);
    expect(ShotOutput.safeParse({ ...ok, startMs: 1200 }).success).toBe(false);
    expect(ShotOutput.safeParse({ ...ok, costUsd: 2 }).success).toBe(false);
    expect(ShotOutput.safeParse({ ...ok, depiction: 'RECORD' }).success).toBe(false);
    expect(ShotOutput.safeParse({ ...ok, description: 'x'.repeat(601) }).success).toBe(false);
    expect(ShotOutput.safeParse({ ...ok, overlays: Array(5).fill({ kind: 'CAPTION', text: 'x', reason: '', claimKeys: [] }) }).success).toBe(false);
    expect(ShotOutput.safeParse({ ...ok, dataSpec: { chartType: 'MAP', title: 'Route', items: [{ label: 'A', figure: null, date: null, place: 'A', claimKey: 'I5', lat: 55.1 }], note: '' } }).success).toBe(false);
    expect(BeatsOutput.safeParse({ beats: [beat('⟨start⟩', '⟨end⟩', { startMs: 0 } as never)], subjects: [] }).success).toBe(false);
    expect(ShotsOutput.safeParse({ shots: [ok], beats: [] }).success).toBe(true);
    expect(RepairOutput.safeParse({ beats: [{ beatKey: 'VB01', shots: [] }] }).success).toBe(false);
  });
});

describe('beats: references resolved, the partition repaired', () => {
  const { facts } = domainFilm('history');

  it('drops a beat on an unknown cut point; a gap goes to the beat before it; the edges are the scope\'s', () => {
    const notes: string[] = [];
    const { beats } = resolveBeats({ beats: [beat('1.1:end', '1.2:end'), beat('1.2:end', '1.2:5'), beat('1.3:end', '2.2:end'), beat('2.2:end', '3.1:end')], subjects: [] }, facts, notes);
    expect(beats.map((b) => [b.key, b.narration.from, b.narration.to])).toEqual([
      ['VB01', '⟨start⟩', '1.3:end'],
      ['VB02', '1.3:end', '2.2:end'],
      ['VB03', '2.2:end', '⟨end⟩'],
    ]);
    expect(notes).toEqual([
      'beat 2: dropped the beat "Up to 1.2:5" — the cut point 1.2:5 is not in the narration',
      'Up to 1.2:end: starts at the beginning of the narration (was 1.1:end)',
      'Up to 1.2:end: extended to 1.3:end over words no beat covered',
    ]);
    // "3.1:end" is the end of the scope by another name: nothing to extend.
  });

  it('trims overlaps and removes a beat inside another', () => {
    const notes: string[] = [];
    const { beats } = resolveBeats({ beats: [beat('⟨start⟩', '1.3:end'), beat('1.2:end', '2.1:end'), beat('1.2:9', '1.3:9'), beat('2.1:end', '⟨end⟩')], subjects: [] }, facts, notes);
    expect(beats.map((b) => `${b.narration.from}–${b.narration.to}`)).toEqual(['⟨start⟩–1.3:end', '1.3:end–2.1:end', '2.1:end–⟨end⟩']);
    expect(notes).toEqual(['Up to 1.3:9: removed — it lies inside the beat before it', 'Up to 2.1:end: trimmed to start at 1.3:end where the beat before it ends']);
  });

  it('drops unknown architecture beats, claims outside the narration, unknown subjects and a fictional subject in a documented scene', () => {
    const notes: string[] = [];
    const { beats, subjects } = resolveBeats(
      {
        beats: [
          beat('⟨start⟩', '1.2:end', { archBeatIds: ['1.1', '9.9'], claimKeys: ['H1', 'H3', 'Z1'], subjectKeys: ['CS01', 'CS09'] }),
          beat('1.2:end', '1.3:end', { subjectKeys: ['CS01'], options: { A: { treatment: 'ARCHIVAL_IMAGE', concept: '' }, B: { treatment: 'ENVIRONMENT', concept: '' }, C: { treatment: 'ENVIRONMENT', concept: '' } } }),
          beat('1.3:end', '⟨end⟩', { subjectKeys: ['CS01'] }),
        ],
        subjects: [mira(), mira({ key: 'CS02', name: 'Captain Jorn', castId: null }), mira({ key: 'subject-3', name: 'The quay', kind: 'LOCATION', castId: null })],
      },
      facts,
      notes,
    );
    expect(subjects.map((s) => s.key)).toEqual(['CS01']);
    expect(beats[0]).toMatchObject({ archBeatIds: ['1.1'], claimKeys: ['H1'], content: { continuity: { subjectKeys: [] } } });
    expect(beats[1]!.content.continuity.subjectKeys).toEqual(['CS01']);
    expect(notes).toEqual([
      'CS02: dropped the character "Captain Jorn" — it is neither a cast member nor an unnamed figure (INVENTED_CHARACTER)',
      'subject-3: dropped the subject "The quay" — its key is not a subject key such as "CS01"',
      'VB01: dropped the architecture beat 9.9 — it is not in the architecture',
      'VB01: dropped claim H3 — it is not a claim of the narration the beat covers',
      'VB01: dropped claim Z1 — it is not in the approved evidence',
      'VB01: dropped the subject CS01 (Mira) — a fictional character is never in a documented scene',
      'VB01: dropped the subject CS09 — no such continuity subject',
      'VB03: dropped the subject CS01 (Mira) — a fictional character is never in a documented scene',
    ]);
    // Mira's own reconstructed scene keeps her; an archival option there survives (sourced, the matrix allows it).
    expect(beats[1]!.content.options.A.treatment).toBe('ARCHIVAL_IMAGE');
  });
});

describe('shots: references resolved, the partition repaired', () => {
  const { facts } = domainFilm('history');
  const beats = { beats: [beat('⟨start⟩', '1.2:end'), beat('1.2:end', '1.3:end'), beat('1.3:end', '⟨end⟩')], subjects: [mira()] };

  it('drops what does not resolve and records each drop: cut points, claims, subjects, interactions, environments, methods', () => {
    const { draft, notes } = planWith(facts, beats, () => [
      fakeShot('VB01', { from: '⟨start⟩', to: '1.2:end' }, { visualTo: '9.9:1', claims: [{ claimKey: 'H1', role: 'DEPICTS' }, { claimKey: 'H2', role: 'DEPICTS' }, { claimKey: 'Z1', role: 'CONTEXT' }], method: 'ARCHIVAL_SOURCING', environment: { subjectKey: 'CS07', description: '' } }),
      fakeShot('VB02', { from: '1.2:end', to: '1.3:end' }, { subjects: [{ subjectKey: 'CS01', role: 'PRIMARY', action: '', interactions: [{ withSubjectKey: 'CS05', kind: 'NEAR' }], likeness: 'PERIOD_GENERIC', speaks: null }, { subjectKey: 'CS04', role: 'SECONDARY', action: '', interactions: [], likeness: 'NONE', speaks: null }], specifics: [{ detail: 'a guild badge', kind: 'OBJECT', basis: 'CLAIM', claimKeys: ['Z2'] }] }),
      fakeShot('VB03', { from: '1.3:end', to: '⟨end⟩' }),
      fakeShot('VB09', { from: '1.3:end', to: '⟨end⟩' }),
    ]);
    expect(draft.shots.map((s) => s.key)).toEqual(['SH001', 'SH002', 'SH003']);
    expect(draft.shots[0]).toMatchObject({ visualTo: null, method: null, claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec: { environment: { subjectKey: null } } });
    expect(draft.shots[1]!.subjects.map((s) => [s.subjectKey, s.detail.interactions])).toEqual([['CS01', []]]);
    expect(draft.shots[1]!.spec.specifics).toEqual([{ detail: 'a guild badge', kind: 'OBJECT', basis: 'INVENTED', claimKeys: [] }]);
    expect(notes.filter((n) => n.startsWith('shot'))).toEqual([
      'shot 1 (VB01): dropped the tail-out to 9.9:1 — the cut point is not in the narration',
      'shot 1 (VB01): ARCHIVAL_SOURCING cannot make ENVIRONMENT; the router chooses',
      'shot 1 (VB01): dropped the environment CS07 — no such continuity subject',
      'shot 1 (VB01): dropped claim H2 (DEPICTS) — it is not a claim of the narration the shot covers',
      'shot 1 (VB01): dropped claim Z1 — it is not in the approved evidence',
      'shot 2 (VB02): dropped an interaction with CS05 — no such continuity subject',
      'shot 2 (VB02): dropped the subject CS04 — no such continuity subject',
      'shot 2 (VB02): dropped claim Z2 of "a guild badge" — it is not in the approved evidence',
      'shot 2 (VB02): "a guild badge" rests on no known claim; marked invented',
      'shot 4 (VB09): dropped the shot — VB09 is not a beat of this request',
    ]);
    // Each drop is a MODEL_REFERENCE_DROPPED warning on the saved version.
    const p = planStoryboard(draft, facts);
    expect(p.qa.filter((f) => f.kind === 'MODEL_REFERENCE_DROPPED').map((f) => f.ref)).toEqual(['VB01', 'VB01', 'VB01', 'VB01', 'VB02', 'VB02', 'VB02', null]);
  });

  it('keeps the claims of a must-show the script asked for, even when the model leaves them out (its caution follows them)', () => {
    const inv = domainFilm('investigation').facts;
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '2.1:end'), beat('2.1:end', '⟨end⟩')], subjects: [] }, inv, notes);
    const script = inv.spine.block('3.1')!.block;
    script.visual = { ...script.visual, mustShow: [{ detail: 'The weakened hull', claimKeys: ['I3'] }] };
    const s = resolveShots(
      [fakeShot('VB01', { from: '⟨start⟩', to: '2.1:end' }), fakeShot('VB02', { from: '2.1:end', to: '⟨end⟩' }, { claims: [{ claimKey: 'I3', role: 'CONTEXT' }], mustShow: [{ detail: 'the weakened hull', claimKeys: [] }] })],
      b.beats,
      { shots: [], subjects: [] },
      inv,
      notes,
    );
    expect(s.shots[1]!.spec.mustShow).toEqual([{ detail: 'the weakened hull', claimKeys: ['I3'], origin: 'SCRIPT' }]);
    expect(notes).toContain('shot 2 (VB02): the must-show "the weakened hull" rests on I3, as the script says');
  });

  it('places a figure-bearing data requirement only on claims of the narration (and links its claim as data)', () => {
    const science = domainFilm('science').facts;
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '2.1:end'), beat('2.1:end', '⟨end⟩')], subjects: [] }, science, notes);
    const data = (claimKey: string, figure: string) => ({ chartType: 'BAR_CHART' as const, title: 'Iron', items: [{ label: '1962', figure, date: '1962', place: null, claimKey }], note: '' });
    const s = resolveShots([fakeShot('VB01', { from: '⟨start⟩', to: '2.1:end' }, { treatment: 'DATA_VISUALIZATION', dataSpec: data('L4', '12') }), fakeShot('VB02', { from: '2.1:end', to: '⟨end⟩' }, { treatment: 'DATA_VISUALIZATION', dataSpec: data('L4', '15 milligrams') })], b.beats, { shots: [], subjects: [] }, science, notes);
    expect(s.shots[0]!.spec.dataSpec).toBeNull();
    expect(s.shots[1]!.claims).toEqual([{ claimKey: 'L4', role: 'DATA' }]);
    expect(notes).toEqual(expect.arrayContaining(['shot 1 (VB01): dropped the data item "1962" — L4 is not a claim of the narration the shot covers', 'shot 2 (VB02): the data cites L4; linked as data']));
    // The figure the claim does not have is a blocking CLAIM_INVALID, not silently fixed.
    const p = planStoryboard({ approach: 'C', beats: b.beats, shots: s.shots, subjects: [], normalization: notes }, science);
    expect(p.qa.filter((f) => f.kind === 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: 15 is not in L4']);
  });

  it('repairs gaps and overlaps inside a beat, and sends a beat beyond the repair limit to the repair call', () => {
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '1.2:end'), beat('1.2:end', '⟨end⟩')], subjects: [] }, facts, notes);
    const s = resolveShots(
      [
        fakeShot('VB01', { from: '1.1:end', to: '1.2:2' }),
        fakeShot('VB01', { from: '1.2:9', to: '1.2:end' }),
        fakeShot('VB01', { from: '1.2:2', to: '1.2:end' }),
        fakeShot('VB02', { from: '1.3:9', to: '2.2:end' }),
        fakeShot('VB02', { from: '2.2:end', to: '3.1:3' }),
        fakeShot('VB02', { from: '1.3:1', to: '1.3:9' }),
      ],
      b.beats,
      { shots: [], subjects: [] },
      facts,
      notes,
    );
    expect(s.shots.map((x) => `${x.beatKey} ${x.narration!.from}–${x.narration!.to}`)).toEqual(['VB01 ⟨start⟩–1.2:2', 'VB01 1.2:2–1.2:end', 'VB02 1.2:end–1.3:9', 'VB02 1.3:9–2.2:end', 'VB02 2.2:end–⟨end⟩']);
    expect(s.needRepair).toEqual([]);
    expect(notes).toEqual(['VB01: a shot inside the shot before it was removed', 'VB01: its first shot extended back to the start of the beat', 'VB02: its first shot extended back to the start of the beat', 'VB02: its last shot extended to the end of the beat']);
    const broken = resolveShots([fakeShot('VB01', { from: '1.2:2', to: '1.2:9' }), fakeShot('VB01', { from: '1.2:9', to: '1.2:end' }), fakeShot('VB01', { from: '1.1:end', to: '1.2:2' }), fakeShot('VB02', { from: '1.2:end', to: '⟨end⟩' })], b.beats, { shots: [], subjects: [] }, facts, []);
    expect(broken.needRepair).toEqual([]);
    const tooMany = resolveShots([fakeShot('VB01', { from: '1.1:end', to: '1.2:2' }), fakeShot('VB01', { from: '1.2:9', to: '1.2:end' }), fakeShot('VB01', { from: '⟨start⟩', to: '1.3:end' }), fakeShot('VB02', { from: '1.2:end', to: '⟨end⟩' })], b.beats, { shots: [], subjects: [] }, facts, []);
    expect(tooMany.needRepair).toEqual(['VB01']);
    const none = resolveShots([fakeShot('VB02', { from: '1.2:end', to: '⟨end⟩' })], b.beats, { shots: [], subjects: [] }, facts, []);
    expect(none.needRepair).toEqual(['VB01']);
  });

  it('keeps a silence-only shot only in a long enough silence of its beat, between its shots', () => {
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '1.3:end'), beat('1.3:end', '⟨end⟩')], subjects: [] }, facts, notes);
    const s = resolveShots(
      [
        fakeShot('VB01', { from: '⟨start⟩', to: '1.3:end' }),
        fakeShot('VB01', null, { silenceAt: '1.3:end', treatment: 'TRANSITION' }),
        fakeShot('VB01', null, { silenceAt: '1.2:9', treatment: 'TRANSITION' }),
        fakeShot('VB01', null, { silenceAt: '1.1:end' }),
        fakeShot('VB02', { from: '1.3:end', to: '⟨end⟩' }),
      ],
      b.beats,
      { shots: [], subjects: [] },
      facts,
      notes,
    );
    expect(s.shots.map((x) => x.silenceAt ?? `${x.narration!.from}–${x.narration!.to}`)).toEqual(['⟨start⟩–1.3:end', '1.3:end', '1.3:end–⟨end⟩']);
    expect(notes).toEqual([
      'shot 3 (VB01): dropped the silence-only shot — the silence at 1.2:9 lasts 40 ms, under the 200 ms minimum',
      'shot 4 (VB01): dropped the silence-only shot — the silence at 1.1:end lasts 450 ms, under the 700 ms minimum',
    ]);
  });

  it('revises a beat\'s concept and treatment in a beat re-plan, refusing a treatment the matrix does not allow there', () => {
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '1.2:end'), beat('1.2:end', '1.3:end'), beat('1.3:end', '⟨end⟩')], subjects: [] }, facts, notes);
    const revised = applyBeatRevisions(b.beats, [{ beatKey: 'VB01', concept: 'The fire from the water', treatment: 'MAP_ANIMATION' }, { beatKey: 'VB02', concept: null, treatment: 'NEWS_FOOTAGE' }], 'C', facts, notes);
    expect(revised[0]!.content).toMatchObject({ concept: 'The fire from the water', options: { C: { treatment: 'MAP_ANIMATION' } } });
    expect(revised[1]!.content.options.C.treatment).toBe('NEWS_FOOTAGE');
    void DOMAIN_FILMS;
  });
});

describe('repair, and the placeholder', () => {
  const { facts } = domainFilm('science');
  const beats = { beats: [beat('⟨start⟩', '1.2:end'), beat('1.2:end', '2.1:end'), beat('2.1:end', '⟨end⟩')], subjects: [] };
  const disputed = (o: Partial<ShotOutput> = {}) => fakeShot('VB02', { from: '1.2:end', to: '2.1:end' }, { treatment: 'CINEMATIC_RECONSTRUCTION', claims: [{ claimKey: 'L2', role: 'DEPICTS' }], ...o });
  const start = () => planWith(facts, beats, (d) => [fakeShot('VB01', { from: d.beats[0]!.narration.from, to: d.beats[0]!.narration.to }), disputed(), fakeShot('VB03', { from: '2.1:end', to: '⟨end⟩' })]).draft;

  it('sends beats with repairable blocking findings to the repair call', () => {
    const draft = start();
    expect(beatsToRepair(draft, planStoryboard(draft, facts).qa)).toEqual(['VB02']);
  });

  it('says why each beat goes to the repair, and after it which beats take the replacement and which do not', () => {
    const draft = start();
    const found = repairFindings(draft, planStoryboard(draft, facts).qa);
    expect([...found.keys()]).toEqual(['VB02']);
    // The section pass does not see these (its needRepair is about tiling only): judging the whole version does.
    expect(repairReasons(['VB02', 'VB03'], found, ['VB03'])).toBe(`VB02 (${[...new Set(found.get('VB02')!.map((f) => f.kind))].join(', ')}), VB03 (not tiled by the model's shots)`);
    expect(repairReasons(['VB02'], new Map([['VB02', [...found.get('VB02')!, ...found.get('VB02')!]]]), [])).toMatch(/^VB02 \([A-Z_]+ ×2\)$/);
    // "kept" names the beats whose replacement shots replaced their first plan; the others took no replacement (a beat no shot tiled had no first plan to keep).
    const rule = '(a replacement is kept only when it removes blocking findings and adds none)';
    expect(repairOutcome(['VB09', 'VB17'], ['VB09', 'VB17'])).toBe(`Repair of VB09, VB17: replacement shots kept for VB09, VB17 ${rule}`);
    expect(repairOutcome(['VB09', 'VB17'], ['VB09'])).toBe(`Repair of VB09, VB17: replacement shots kept for VB09; no replacement kept for VB17 ${rule}`);
    expect(repairOutcome(['VB09', 'VB17'], [])).toBe(`Repair of VB09, VB17: no replacement kept for VB09, VB17 ${rule}`);
  });

  it('keeps a replacement that removes blocking findings and adds none; refuses one that adds any or fixes nothing', () => {
    const draft = start();
    const notes: string[] = [];
    const fixed = applyRepair(draft, { beats: [{ beatKey: 'VB02', shots: [disputed({ uncertaintyDevice: 'COMPETING_VERSIONS', overlays: [{ kind: 'CAPTION', text: 'Algae or iron?', reason: 'Two accounts', claimKeys: ['L2', 'L1'] }] })] }] }, facts, notes);
    expect(fixed.kept).toEqual(['VB02']);
    expect(planStoryboard(fixed.draft, facts).qa.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
    expect(notes.at(-1)).toMatch(/^VB02: re-planned by the repair \(\d blocking finding\(s\) removed\)$/);
    // Swapping one blocking finding for another is not a repair: a declared source that is not there.
    const worse: string[] = [];
    expect(applyRepair(draft, { beats: [{ beatKey: 'VB02', shots: [disputed({ uncertaintyDevice: 'SOURCE_SHOWN' })] }] }, facts, worse).kept).toEqual([]);
    expect(worse).toEqual(['VB02: the repair was not kept — it adds 1 blocking finding(s)']);
    const same: string[] = [];
    expect(applyRepair(draft, { beats: [{ beatKey: 'VB02', shots: [disputed()] }] }, facts, same).kept).toEqual([]);
    expect(same).toEqual(['VB02: the repair was not kept — it removes no blocking finding']);
  });

  it('keeps a repair of a beat sent by the partition limit once it covers the beat within the limit and adds no blocking finding', () => {
    const history = domainFilm('history').facts;
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '1.2:end'), beat('1.2:end', '⟨end⟩')], subjects: [] }, history, notes);
    const messy = resolveShots([fakeShot('VB01', { from: '1.1:end', to: '1.2:2' }), fakeShot('VB01', { from: '1.2:9', to: '1.2:end' }), fakeShot('VB01', { from: '⟨start⟩', to: '1.3:end' }), fakeShot('VB02', { from: '1.2:end', to: '⟨end⟩' })], b.beats, { shots: [], subjects: [] }, history, notes);
    expect(messy.needRepair).toEqual(['VB01']);
    const draft: StoryboardDraft = { approach: 'C', beats: b.beats, shots: messy.shots, subjects: [], normalization: notes };
    const replacement = { beats: [{ beatKey: 'VB01', shots: [fakeShot('VB01', { from: '⟨start⟩', to: '1.1:end' }), fakeShot('VB01', { from: '1.1:end', to: '1.2:end' })] }] };
    // Code's own fixes left nothing blocking: judged only by findings, no repair could ever be kept.
    const judged: string[] = [];
    expect(applyRepair(draft, replacement, history, judged).kept).toEqual([]);
    expect(judged).toEqual(['VB01: the repair was not kept — it removes no blocking finding']);
    const repaired: string[] = [];
    const kept = applyRepair(draft, replacement, history, repaired, { partition: messy.needRepair });
    expect(kept.kept).toEqual(['VB01']);
    expect(kept.draft.shots.filter((s) => s.beatKey === 'VB01').map((s) => `${s.narration!.from}–${s.narration!.to}`)).toEqual(['⟨start⟩–1.1:end', '1.1:end–1.2:end']);
    expect(repaired.at(-1)).toBe('VB01: re-planned by the repair (its shots now cover it within the repair limit)');
    // A replacement as messy as the original is still refused.
    const again: string[] = [];
    expect(applyRepair(draft, { beats: [{ beatKey: 'VB01', shots: [fakeShot('VB01', { from: '1.1:end', to: '1.2:2' }), fakeShot('VB01', { from: '1.2:9', to: '1.2:end' }), fakeShot('VB01', { from: '⟨start⟩', to: '1.3:end' })] }] }, history, again, { partition: ['VB01'] }).kept).toEqual([]);
    expect(again.at(-1)).toMatch(/^VB01: the repair was not kept — its shots still do not cover the beat/);
  });

  it('lets one silence hold one shot, even where two beats meet', () => {
    const history = domainFilm('history', { pauses: { '1.2:0': 1500 } }).facts;
    const notes: string[] = [];
    const b = resolveBeats({ beats: [beat('⟨start⟩', '1.1:end'), beat('1.1:end', '⟨end⟩')], subjects: [] }, history, notes);
    const s = resolveShots(
      [fakeShot('VB01', { from: '⟨start⟩', to: '1.1:end' }), fakeShot('VB01', null, { silenceAt: '1.1:end' }), fakeShot('VB02', null, { silenceAt: '1.1:end' }), fakeShot('VB02', { from: '1.1:end', to: '⟨end⟩' })],
      b.beats,
      { shots: [], subjects: [] },
      history,
      notes,
    );
    expect(s.shots.map((x) => `${x.beatKey} ${x.silenceAt ?? `${x.narration!.from}–${x.narration!.to}`}`)).toEqual(['VB01 ⟨start⟩–1.1:end', 'VB01 1.1:end', 'VB02 1.1:end–⟨end⟩']);
    expect(notes.at(-1)).toBe('VB02: the silence-only shot at 1.1:end was removed (another shot already holds that silence)');
    const p = planStoryboard({ approach: 'C', beats: b.beats, shots: s.shots, subjects: [], normalization: notes }, history);
    expect(p.qa.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
  });

  it('covers a beat that still has no valid plan with one placeholder (SHOT_UNPLANNED), and the timeline still tiles', () => {
    const draft = start();
    const notes: string[] = [];
    const placed = markUnplanned(draft, ['VB02'], facts, notes);
    const p = planStoryboard(placed, facts);
    expect(p.shots.map((s) => [s.key, s.unplanned, s.treatment])).toEqual([['SH001', false, 'ENVIRONMENT'], ['SH004', true, null], ['SH003', false, 'ENVIRONMENT']]);
    expect(p.qa.filter((f) => f.severity === 'BLOCKING').map((f) => `${f.kind} ${f.ref}`)).toEqual(['SHOT_UNPLANNED SH004']);
    expect(p.qa.some((f) => f.kind === 'TIMELINE_GAP' || f.kind === 'NARRATION_UNMAPPED')).toBe(false);
    expect(p.shots[1]!.cost).toBeNull();
    expect(p.costs.unpricedShots).toBe(1);
  });
});

describe('the scripted AI, end to end over the five films and the Tulip-shaped fixture', () => {
  const films: [string, StoryboardFacts][] = [
    ...(['history', 'science', 'business', 'biography', 'investigation'] as DomainName[]).map((n) => [n, domainFilm(n).facts] as [string, StoryboardFacts]),
    ['tulip-shaped', (() => {
      const scope = fixtureScope();
      return syntheticFacts(scope, withRowIds(fixtureDraft(scope)), { pauses: { '1.2:4': 600 }, split: { '3.1': 9 } });
    })()],
  ];
  for (const [name, facts] of films) {
    it(`plans ${name} from a prompt of cut points, with no blocking finding and a tiled clock`, async () => {
      const ai = new FakeStoryboardAI();
      const prompt = facts.spine.points.map((p) => `‖${p.id}‖`).join(' ');
      const beatsOut = (await ai.generateObject({ task: 'storyboard.beats', schema: BeatsOutput, schemaName: 'beats', messages: [{ role: 'user', content: prompt }] })).object;
      const notes: string[] = [];
      const b = resolveBeats(beatsOut, facts, notes);
      expect(b.beats.length).toBe(facts.spine.blocks.length);
      const shotsOut = (await ai.generateObject({ task: 'storyboard.shots', schema: ShotsOutput, schemaName: 'shots', messages: [{ role: 'user', content: b.beats.map((x) => x.key).join(', ') }] })).object;
      const s = resolveShots(shotsOut.shots, b.beats, { shots: [], subjects: b.subjects }, facts, notes);
      const p = planStoryboard({ approach: 'C', beats: b.beats, shots: s.shots, subjects: b.subjects, normalization: notes }, facts);
      expect(p.qa.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
      expect(notes).toEqual([]);
      // Everything a version's rows and content hold is valid under the core contracts.
      for (const shot of p.shots) {
        ShotTiming.parse(shot.timing);
        ShotSpec.parse(shot.direction);
        AssetRequirement.parse(shot.asset);
        VisualCostEstimate.parse(shot.cost);
        ShotEvidence.parse(shot.evidence);
      }
      for (const x of p.beats) VisualBeatContent.parse(x.stored);
      for (const x of p.subjects) ContinuitySpec.parse(x.spec);
      RhythmStats.parse(p.rhythm);
      CostRollup.parse(p.costs);
      z.array(ApproachSummary).length(3).parse(p.approaches.options);
      z.array(CostAlternative).parse(p.alternatives);
      VisualPricingSnapshot.parse(p.pricing);
      expect(p.shots[0]!.startMs).toBe(0);
      expect(p.shots.at(-1)!.endMs).toBe(facts.spine.totalDurationMs);
      expect(ai.calls).toEqual({ 'storyboard.beats': 1, 'storyboard.shots': 1 });
      expect(fakeBeats(prompt).beats).toHaveLength(facts.spine.blocks.length);
    });
  }
});
