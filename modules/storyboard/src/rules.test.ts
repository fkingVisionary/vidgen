import { TREATMENT_CLASS_RULES, VISUAL_TREATMENTS, type ScriptBlockClass, type StoryboardFindingKind, type VisualTreatment } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import type { DraftSubject, PlannedStoryboard, StoryboardFacts } from './draft.ts';
import { markUnplanned } from './normalize.ts';
import { planStoryboard } from './plan.ts';
import { checkStoryboard } from './rules.ts';
import { DOMAIN_FILMS, domainFilm, profileSnapshot, sketchDraft, subject, syntheticFacts, withRowIds, type BeatSketch, type ShotSketch } from './testing.ts';
import { syntheticDraft, syntheticScope, type SyntheticSpec } from '@docengine/script/testing';

/**
 * The QA rules on five synthetic films: one failing fixture for each
 * blocking kind, the class matrix's refused cells and each of its
 * conditions, and the passing variant beside each failing one — uncertain
 * material (science, investigation), fiction placement and interaction
 * (history), likeness and quotations (biography), generated records
 * (business) and framing.
 */

const blocking = (p: PlannedStoryboard, kind?: StoryboardFindingKind) => p.qa.filter((f) => f.severity === 'BLOCKING' && (!kind || f.kind === kind));
const refs = (p: PlannedStoryboard, kind: StoryboardFindingKind) => p.qa.filter((f) => f.kind === kind).map((f) => f.ref);
const plan = (facts: StoryboardFacts, beats: BeatSketch[], subjects: DraftSubject[] = []) => planStoryboard(sketchDraft(facts, beats, { subjects }), facts);

const MIRA = subject('CS01', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' });
const BRANDT = subject('CS02', { name: 'Elias Brandt', kind: 'CHARACTER', castId: 'R1', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
const LIND = subject('CS01', { name: 'Mara Lind', kind: 'CHARACTER', castId: 'R1', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
const detail = (o: Partial<ShotSketch['subjects'] extends (infer T)[] | undefined ? T extends { detail: infer D } ? D : never : never> = {}) => ({ role: 'PRIMARY' as const, action: '', interactions: [], likeness: 'NONE' as const, speaks: null, ...o });

/** History in three beats: the fire (1.1–1.2), Mira (1.3), the order and the rebuilding. */
const historyPlan = (third: ShotSketch = {}, o: { subjects?: DraftSubject[]; first?: ShotSketch } = {}) => {
  const { facts } = domainFilm('history');
  return plan(
    facts,
    [
      { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.1:end', treatment: 'TEXT_ON_SCREEN' }, { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], ...o.first }] },
      { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ subjects: [{ subjectKey: 'CS01', detail: detail({ action: 'runs with a bucket', likeness: 'PERIOD_GENERIC' }) }], claims: [{ claimKey: 'H5', role: 'CONTEXT' }], ...third }] },
      { to: '⟨end⟩', treatment: 'ENVIRONMENT' },
    ],
    o.subjects ?? [MIRA, BRANDT],
  );
};

describe('a clean plan', () => {
  it('has no blocking finding: a documented reconstruction, a labelled composite in her own scene, framing text', () => {
    const p = historyPlan();
    expect(blocking(p)).toEqual([]);
    expect(p.qaPassed).toBe(true);
    const [sh1, sh2, sh3] = p.shots;
    expect([sh1!.infoClass, sh2!.infoClass, sh3!.infoClass]).toEqual(['FRAMING', 'DOCUMENTED', 'FICTION']);
    expect(sh3!.direction.overlays).toEqual([expect.objectContaining({ kind: 'FICTION_LABEL', auto: true, text: 'Mira: a fictional character' })]);
  });
});

describe('the timeline and the structure', () => {
  it('NARRATION_UNMAPPED: words no shot supports, and a shot outside its beat', () => {
    const { facts } = domainFilm('history');
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:2' }, {}] }, { to: '⟨end⟩' }]);
    draft.shots[1]!.narration = { from: '1.2:9', to: '1.2:end' };
    const p = planStoryboard(draft, facts);
    expect(blocking(p, 'NARRATION_UNMAPPED').map((f) => f.detail)).toEqual([expect.stringMatching(/^Words 1\.2:2–1\.2:8 \("a … Corvel"\) are supported by no shot$/)]);
    draft.shots[1]!.narration = { from: '1.2:2', to: '2.1:end' };
    expect(blocking(planStoryboard(draft, facts), 'NARRATION_UNMAPPED').map((f) => f.ref)).toEqual(expect.arrayContaining(['SH002']));
  });

  it('NARRATION_UNMAPPED: a shot of a beat the version does not have', () => {
    const { facts } = domainFilm('history');
    const draft = sketchDraft(facts, [{ to: '1.2:end' }, { to: '⟨end⟩' }]);
    expect(blocking(planStoryboard(draft, facts))).toEqual([]);
    draft.shots[1]!.beatKey = 'VB09';
    // VB02 is left with no shot: its words are supported by no shot of it, and it has no times.
    expect(blocking(planStoryboard(draft, facts)).map((f) => `${f.kind} ${f.detail}`)).toEqual([
      'TIMING_MISSING VB02 has no times: it has no shots',
      'NARRATION_UNMAPPED SH002 belongs to VB09, which is not a beat of this version',
    ]);
  });

  it('NARRATION_UNMAPPED counts every word: a take without word timings left out of every shot and beat', () => {
    const { facts } = domainFilm('history', { missingAlignment: ['1.2'] });
    const draft = sketchDraft(facts, [{ to: '1.1:end' }, { to: '⟨end⟩' }]);
    draft.beats[1]!.narration = { from: '1.2:end', to: '⟨end⟩' };
    draft.shots[1]!.narration = { from: '1.2:end', to: '⟨end⟩' };
    expect(blocking(planStoryboard(draft, facts), 'NARRATION_UNMAPPED').map((f) => f.detail)).toEqual([
      'Words 1.2:0–1.2:14 ("In … quays") are supported by no shot',
      'Words 1.2:0–1.2:14 ("In … quays") are supported by no beat',
    ]);
    // Covered from clip edge to clip edge, the take is mapped once.
    expect(blocking(plan(facts, [{ to: '1.2:end' }, { to: '⟨end⟩' }]), 'NARRATION_UNMAPPED')).toEqual([]);
  });

  it('TIMING_MISSING: a silence-only shot inside another shot\'s words is not placed (it would hide an overlap)', () => {
    const { facts } = domainFilm('history', { pauses: { '1.2:5': 900 } });
    const p = plan(facts, [{ to: '1.2:end', shots: [{ to: '1.2:end' }, { silenceAt: '1.2:5' }] }, { to: '⟨end⟩' }]);
    // Its beat, with a shot that cannot be placed, has no times either.
    expect(blocking(p).map((f) => `${f.kind} ${f.detail}`)).toEqual(['TIMING_MISSING SH002: its silence 1.2:5 lies inside the words of SH001', 'TIMING_MISSING VB01 has no times: a shot of it is not timed']);
    // SH001 is seen until its words end; the next shot is not shown early.
    expect(p.shots.find((s) => s.key === 'SH001')!.endMs).toBe(facts.spine.point('1.2:end')!.atMs);
    expect(p.shots.find((s) => s.key === 'SH003')!.timing!.leadInMs).toBe(0);
  });

  it('TIMING_MISSING, SHOT_OVERLAP, TIMELINE_GAP and DURATION_IMPOSSIBLE', () => {
    const { facts } = domainFilm('history');
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:7' }, {}] }, { to: '⟨end⟩' }]);
    expect(refs(planStoryboard(draft, facts), 'TIMING_MISSING')).toEqual(['SH001', 'SH002', 'VB01']);
    // A one-word shot ("Mira,") is shorter than 700 ms.
    const short = plan(facts, [{ to: '1.2:end' }, { to: '1.3:end', shots: [{ to: '1.3:1' }, {}] }, { to: '⟨end⟩' }]);
    expect(blocking(short, 'DURATION_IMPOSSIBLE').map((f) => f.detail)).toEqual([expect.stringMatching(/^SH002 lasts \d+ ms, under the 700 ms minimum$/)]);
    // Saved rows that no longer tile: the checks run on what is stored.
    const p = historyPlan();
    const rows = structuredClone(p);
    rows.shots[1]!.startMs! -= 300;
    rows.shots[2]!.startMs! += 500;
    const qa = checkStoryboard(rows, facts);
    expect(qa.filter((f) => f.kind === 'SHOT_OVERLAP').map((f) => f.ref)).toEqual(['SH002']);
    expect(qa.filter((f) => f.kind === 'TIMELINE_GAP').map((f) => f.ref)).toEqual(['SH003']);
  });

  it('TREATMENT_MISSING, INFO_CLASS_MISSING and ASSET_REQUIREMENT_MISSING; SHOT_UNPLANNED for a placeholder', () => {
    const { facts } = domainFilm('science');
    const draft = sketchDraft(facts, [{ to: '1.2:end' }, { to: '⟨end⟩', treatment: 'DATA_VISUALIZATION', shots: [{ claims: [{ claimKey: 'L4', role: 'DATA' }] }] }]);
    draft.shots[0]!.treatment = null;
    const p = planStoryboard(draft, facts);
    expect(blocking(p).map((f) => `${f.kind} ${f.ref}`)).toEqual(expect.arrayContaining(['TREATMENT_MISSING SH001', 'INFO_CLASS_MISSING SH001', 'ASSET_REQUIREMENT_MISSING SH001', 'ASSET_REQUIREMENT_MISSING SH002']));
    expect(blocking(p, 'ASSET_REQUIREMENT_MISSING').find((f) => f.ref === 'SH002')!.detail).toMatch(/without its data requirement/);
    const notes: string[] = [];
    const placeholder = planStoryboard(markUnplanned(sketchDraft(facts, [{ to: '1.2:end' }, { to: '⟨end⟩' }]), ['VB02'], facts, notes), facts);
    expect(blocking(placeholder).map((f) => `${f.kind} ${f.ref}`)).toEqual(['SHOT_UNPLANNED SH003']);
    expect(notes).toEqual(['VB02: no valid plan; one placeholder shot (SH003) covers it until it is edited or re-planned']);
  });
});

describe('evidence (§2.7, §2.10)', () => {
  it('EVIDENCE_MISSING: a factual picture on no claim, or on claims without a traceable source', () => {
    const { facts } = domainFilm('history');
    const crowd = subject('CS03', { name: 'Dock workers', kind: 'CHARACTER', anonymous: true });
    const p = plan(facts, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ subjects: [{ subjectKey: 'CS03', detail: detail() }] }] }, { to: '⟨end⟩' }], [crowd]);
    expect(blocking(p, 'EVIDENCE_MISSING').map((f) => f.detail)).toEqual(['SH001 shows reconstructed material as documented but rests on no claim']);
    const spec = structuredClone(DOMAIN_FILMS.investigation.spec);
    spec.claims[0]!.sources = [{ id: 'src-2', retrieved: false }];
    const scope = syntheticScope(spec);
    const f2 = syntheticFacts(scope, withRowIds(syntheticDraft(scope, DOMAIN_FILMS.investigation.blocks)));
    const untraced = plan(f2, [{ to: '1.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'I1', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }]);
    expect(blocking(untraced, 'EVIDENCE_MISSING').map((f) => f.detail)).toEqual(['SH001: none of I1 has a retrieved source with a verified quote']);
    expect(untraced.evidenceCoverage).toEqual({ factualShots: 1, traced: 0, untraced: ['SH001'] });
    // Every depicted claim is traceable: one traced claim beside it does not carry an untraced one.
    const beside = plan(f2, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'I1', role: 'DEPICTS' }, { claimKey: 'I5', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }]);
    expect(blocking(beside, 'EVIDENCE_MISSING').map((f) => f.detail)).toEqual(['SH001 depicts I1, with no retrieved source with a verified quote']);
    expect(beside.evidenceCoverage).toEqual({ factualShots: 1, traced: 0, untraced: ['SH001'] });
    const traced = plan(f2, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'I1', role: 'CONTEXT' }, { claimKey: 'I5', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }]);
    expect(blocking(traced, 'EVIDENCE_MISSING')).toEqual([]);
    expect(traced.evidenceCoverage).toEqual({ factualShots: 1, traced: 1, untraced: [] });
  });

  it('CLAIM_INVALID: a claim of other narration, data not in its claim, a design that depicts', () => {
    const { facts } = domainFilm('science');
    const other = plan(facts, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'L4', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }]);
    expect(blocking(other, 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH001: L4 (DEPICTS) is not a claim of the narration it covers']);
    const chart = (figure: string) =>
      plan(facts, [
        { to: '2.1:end' },
        { to: '⟨end⟩', treatment: 'DATA_VISUALIZATION', shots: [{ claims: [{ claimKey: 'L4', role: 'DATA' }], spec: { dataSpec: { chartType: 'BAR_CHART', title: 'Iron in the lake', items: [{ label: '1962', figure, date: '1962', place: null, claimKey: 'L4' }], note: '' } } }] },
      ]);
    expect(blocking(chart('12 milligrams per litre'))).toEqual([]);
    expect(blocking(chart('15 milligrams per litre'), 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: 15 is not in L4']);
    const design = plan(facts, [{ to: '1.2:end', treatment: 'MOTION_GRAPHIC', shots: [{ claims: [{ claimKey: 'L1', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }]);
    expect(blocking(design, 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH001: a MOTION_GRAPHIC illustrates, it does not depict L1: cite it as context']);
  });

  it('CLAIM_INVALID: a detail resting on a claim names one of its narration, and its figures are in it', () => {
    const { facts } = domainFilm('history');
    const detailed = (specific: ShotSketch['spec']) =>
      plan(facts, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.1:end', treatment: 'TEXT_ON_SCREEN' }, { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec: specific }] }, { to: '⟨end⟩' }]);
    const of = (detail: string, claimKeys: string[], kind: 'DATE' | 'ARCHITECTURE' | 'UNIFORM' = 'DATE') => ({ specifics: [{ detail, kind, basis: 'CLAIM' as const, claimKeys }] });
    const grounded = detailed(of('The harbour fire of 1771', ['H1']));
    expect(blocking(grounded)).toEqual([]);
    expect(grounded.shots[1]!.infoClass).toBe('DOCUMENTED');
    expect(blocking(detailed(of('The harbour fire of 1802', ['H1'])), 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: 1802 in "The harbour fire of 1802" is not in H1']);
    // H3 is the rebuilding, a claim of other narration (and of no sequence or cast member here).
    expect(blocking(detailed(of('The rebuilt stone quays', ['H3'], 'ARCHITECTURE')), 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: a detail rests on H3, which is not a claim of the narration it covers']);
    expect(blocking(detailed({ objects: [{ name: 'A ledger of 1802', basis: 'CLAIM', claimKeys: ['H1'] }] }), 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: 1802 in "A ledger of 1802" is not in H1']);
    // A claim basis naming no claim rests on nothing: never grounded, so never documented.
    const unnamed = detailed(of('Red harbour-guard uniforms', [], 'UNIFORM'));
    expect(blocking(unnamed, 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: "Red harbour-guard uniforms" rests on a claim but names none']);
    expect(unnamed.shots[1]!.infoClass).toBe('RECONSTRUCTION');
  });

  it('GENERATED_RECORD: a document animation with no sourced document, and a record made by a generative method (business)', () => {
    const { facts } = domainFilm('business');
    const doc = (role: 'DEPICTS' | 'SHOWS_SOURCE') => plan(facts, [{ to: '2.1:end' }, { to: '⟨end⟩', treatment: 'DOCUMENT_ANIMATION', shots: [{ claims: [{ claimKey: 'B3', role }] }] }]);
    expect(blocking(doc('SHOWS_SOURCE'))).toEqual([]);
    expect(blocking(doc('DEPICTS'), 'GENERATED_RECORD').map((f) => f.ref)).toEqual(['SH002']);
    // Rows that say an archival image was generated.
    const rows = structuredClone(doc('SHOWS_SOURCE'));
    rows.shots[1]!.treatment = 'ARCHIVAL_IMAGE';
    rows.shots[1]!.method = 'GENERATIVE_IMAGE';
    expect(checkStoryboard(rows, facts).filter((f) => f.kind === 'GENERATED_RECORD').map((f) => f.detail)).toEqual(['SH002: a ARCHIVAL_IMAGE is a record and is only ever sourced, never made by GENERATIVE_IMAGE']);
  });
});

describe('uncertain material is never shown as fact (science, investigation)', () => {
  const { facts } = domainFilm('science');
  const disputed = (over: ShotSketch) => plan(facts, [{ to: '1.2:end' }, { to: '2.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'L2', role: 'DEPICTS' }], ...over }] }, { to: '⟨end⟩' }]);

  it('refuses a photoreal reconstruction of a disputed explanation with no device, or only the narrator', () => {
    expect(blocking(disputed({}), 'UNCERTAIN_AS_FACT').map((f) => f.detail)).toEqual([expect.stringMatching(/depicts L2 \(DISPUTED, PRESENT_AS_DISPUTED\) with no device: use COMPETING_VERSIONS, SOURCE_SHOWN, LABELLED_LEGEND/)]);
    const narrated = disputed({ spec: { uncertaintyDevice: 'NARRATOR_LED' } });
    expect(blocking(narrated).map((f) => f.kind).sort()).toEqual(['DEVICE_UNREALIZED', 'UNCERTAIN_AS_FACT']);
  });

  it('takes only the devices that fit the presentation: a stylised look does not settle a dispute, but may tell a myth', () => {
    const stylised = disputed({ spec: { uncertaintyDevice: 'STYLISED_UNREAL', styleOverrides: { realism: 'ILLUSTRATED' } } });
    expect(blocking(stylised).map((f) => f.detail)).toEqual([expect.stringMatching(/depicts L2 \(DISPUTED, PRESENT_AS_DISPUTED\) with STYLISED_UNREAL: use COMPETING_VERSIONS, SOURCE_SHOWN, LABELLED_LEGEND/)]);
    const h = domainFilm('history').facts;
    const myth = (spec: ShotSketch['spec']) => plan(h, [{ to: '2.1:end' }, { to: '2.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H4', role: 'DEPICTS' }], spec }] }, { to: '⟨end⟩' }]);
    expect(blocking(myth({ uncertaintyDevice: 'STYLISED_UNREAL', styleOverrides: { realism: 'PAINTERLY' } }))).toEqual([]);
    expect(blocking(myth({ uncertaintyDevice: 'ABSENCE' })).map((f) => f.kind)).toEqual(['UNCERTAIN_AS_FACT']);
  });

  it('accepts competing versions that are really there, and the narrator over a diagram that depicts nothing uncertain', () => {
    expect(blocking(disputed({ spec: { uncertaintyDevice: 'COMPETING_VERSIONS', overlays: [{ kind: 'CAPTION', text: 'Algae or iron?', reason: 'Two accounts', claimKeys: ['L2', 'L1'], auto: false }] } }))).toEqual([]);
    const diagram = plan(facts, [{ to: '1.2:end' }, { to: '2.1:end', treatment: 'DIAGRAM', shots: [{ claims: [{ claimKey: 'L2', role: 'CONTEXT' }], spec: { uncertaintyDevice: 'NARRATOR_LED' } }] }, { to: '⟨end⟩' }]);
    expect(blocking(diagram)).toEqual([]);
    expect(diagram.shots[1]!.infoClass).toBe('UNCERTAIN');
  });

  it('a probable inquiry finding reconstructed over uncertain narration needs a visible device (investigation)', () => {
    const inv = domainFilm('investigation').facts;
    const inquiry = (over: ShotSketch) => plan(inv, [{ to: '2.1:end' }, { to: '3.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'I3', role: 'DEPICTS' }], ...over }] }, { to: '⟨end⟩' }]);
    const bare = inquiry({});
    expect(bare.shots[1]!.infoClass).toBe('UNCERTAIN');
    expect(blocking(bare, 'UNCERTAIN_AS_FACT').map((f) => f.detail)).toEqual([expect.stringMatching(/needs a visible device/)]);
    expect(blocking(inquiry({ spec: { uncertaintyDevice: 'LABELLED_LEGEND', overlays: [{ kind: 'CAPTION', text: 'What the inquiry concluded', reason: 'probable', claimKeys: ['I3'], auto: false }] } }))).toEqual([]);
    // The inquiry report itself, shown as a document: no device needed.
    expect(blocking(plan(inv, [{ to: '2.1:end' }, { to: '3.1:end', treatment: 'DOCUMENT_ANIMATION', shots: [{ claims: [{ claimKey: 'I3', role: 'SHOWS_SOURCE' }] }] }, { to: '⟨end⟩' }]))).toEqual([]);
  });

  it('weighs a detail resting on an uncertain claim as a depicted one: a probable detail is a reconstruction, a disputed one needs its device', () => {
    // History: H2 (PROBABLE, Brandt's order) is a cast claim, so the documented fire may rest a detail on it.
    const h = domainFilm('history').facts;
    const fire = (spec: ShotSketch['spec']) => plan(h, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.1:end', treatment: 'TEXT_ON_SCREEN' }, { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec }] }, { to: '⟨end⟩' }]);
    expect(fire({}).shots[1]!.infoClass).toBe('DOCUMENTED');
    for (const spec of [{ specifics: [{ detail: 'Brandt opening the warehouse doors', kind: 'PERSON' as const, basis: 'CLAIM' as const, claimKeys: ['H2'] }] }, { mustShow: [{ detail: 'The warehouses opened on Brandt\'s order', claimKeys: ['H2'], origin: 'STORYBOARD' as const }] }]) {
      const probable = fire(spec);
      expect(probable.shots[1]!.infoClass).toBe('RECONSTRUCTION');
      expect(probable.shots[1]!.direction.overlays).toEqual([expect.objectContaining({ kind: 'RECONSTRUCTION_LABEL', auto: true })]);
      expect(blocking(probable)).toEqual([]);
      // Saved as documented before the verdict was known: the live check refuses it.
      const rows = structuredClone(probable);
      rows.shots[1]!.infoClass = 'DOCUMENTED';
      expect(checkStoryboard(rows, h).filter((f) => f.kind === 'CLAIM_INVALID').map((f) => f.detail)).toEqual(['SH002: a documented shot shows a detail resting on H2, which is PROBABLE']);
    }
    // Science: L2 (DISPUTED) is a claim of the sequence, so the documented iron reading may rest a detail on it.
    const lake = (spec: ShotSketch['spec']) =>
      plan(facts, [{ to: '2.1:end' }, { to: '⟨end⟩', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'L4', role: 'DEPICTS' }], spec: { specifics: [{ detail: 'Algae blooming red on the water', kind: 'OTHER', basis: 'CLAIM', claimKeys: ['L2'] }], ...spec } }] }]);
    const bare = lake({});
    expect(bare.shots[1]!.infoClass).toBe('UNCERTAIN');
    expect(blocking(bare, 'UNCERTAIN_AS_FACT').map((f) => f.detail)).toEqual([expect.stringMatching(/shows a detail resting on L2 \(DISPUTED, PRESENT_AS_DISPUTED\) with no device: use COMPETING_VERSIONS, SOURCE_SHOWN, LABELLED_LEGEND/)]);
    // The narrator alone is no device for a picture that shows it.
    expect(blocking(lake({ uncertaintyDevice: 'NARRATOR_LED' }), 'DEVICE_UNREALIZED').map((f) => f.detail)).toEqual([expect.stringMatching(/depicts L2, which is not established/)]);
    expect(blocking(lake({ uncertaintyDevice: 'LABELLED_LEGEND', overlays: [{ kind: 'CAPTION', text: 'One explanation: algae', reason: 'disputed', claimKeys: ['L2'], auto: false }] }))).toEqual([]);
  });

  it('DEVICE_UNREALIZED: every declared device must show in the spec', () => {
    const device = (d: ShotSketch['spec'], subjects: DraftSubject[] = []) =>
      blocking(plan(facts, [{ to: '1.2:end' }, { to: '2.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'L2', role: 'DEPICTS' }], spec: d, subjects: subjects.map((s) => ({ subjectKey: s.key, detail: detail({ action: 'takes a water sample' }) })) }] }, { to: '⟨end⟩' }], subjects), 'DEVICE_UNREALIZED').map((f) => f.detail);
    expect(device({ uncertaintyDevice: 'SOURCE_SHOWN' })).toEqual([expect.stringMatching(/no SHOWS_SOURCE claim/)]);
    expect(device({ uncertaintyDevice: 'LABELLED_LEGEND' })).toEqual([expect.stringMatching(/no reconstruction label or caption/)]);
    expect(device({ uncertaintyDevice: 'STYLISED_UNREAL' })).toEqual([expect.stringMatching(/the look is cinematic, not plainly unreal/)]);
    expect(device({ uncertaintyDevice: 'STYLISED_UNREAL', styleOverrides: { realism: 'ILLUSTRATED' } })).toEqual([]);
    expect(device({ uncertaintyDevice: 'COMPETING_VERSIONS' })).toEqual([expect.stringMatching(/only one account/)]);
    const scientist = subject('CS01', { name: 'A scientist', kind: 'CHARACTER', anonymous: true });
    expect(device({ uncertaintyDevice: 'ABSENCE' }, [scientist])).toEqual([expect.stringMatching(/CS01 performs an action on screen/)]);
  });
});

describe('fiction (history)', () => {
  it('FICTION_IN_DOCUMENTED: the composite seen while documented narration is heard', () => {
    const p = historyPlan({ visualFrom: '1.2:9' });
    expect(blocking(p, 'FICTION_IN_DOCUMENTED').map((f) => f.detail)).toEqual(['SH003 shows Mira while the documented narration of 1.2 is heard']);
  });

  it('FICTION_REAL_INTERACTION: a fictional character speaking to a real person, or speaking a recorded quotation', () => {
    const { facts } = domainFilm('history');
    const scene = (miraDetail: ReturnType<typeof detail>) =>
      plan(facts, [{ to: '1.3:end' }, { to: '2.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H2', role: 'CONTEXT' }], spec: { uncertaintyDevice: 'LABELLED_LEGEND', overlays: [{ kind: 'CAPTION', text: 'As told (test)', reason: 'probable', claimKeys: [], auto: false }] }, subjects: [{ subjectKey: 'CS01', detail: miraDetail }, { subjectKey: 'CS02', detail: detail({ likeness: 'SILHOUETTE' }) }] }] }, { to: '⟨end⟩' }], [MIRA, BRANDT]);
    expect(blocking(scene(detail({ interactions: [{ withSubjectKey: 'CS02', kind: 'OBSERVES' }] })), 'FICTION_REAL_INTERACTION')).toEqual([]);
    expect(blocking(scene(detail({ interactions: [{ withSubjectKey: 'CS02', kind: 'SPEAKS_TO' }] })), 'FICTION_REAL_INTERACTION').map((f) => f.detail)).toEqual(['SH002: CS01 speaks to CS02 — fictional characters only observe real people']);
    expect(blocking(scene(detail({ speaks: { kind: 'RECORDED_QUOTE', claimKey: null } })), 'FICTION_REAL_INTERACTION')).toHaveLength(1);
  });

  it('FICTION_WITH_FACTS: a fictional device depicting a claim, or shown as a record', () => {
    const depicts = historyPlan({ claims: [{ claimKey: 'H5', role: 'DEPICTS' }] });
    expect(blocking(depicts, 'FICTION_WITH_FACTS').map((f) => f.detail)).toEqual(['SH003 is a fictional device but depicts H5: fiction carries only context']);
    const archival = historyPlan({ treatment: 'ARCHIVAL_IMAGE' });
    expect(blocking(archival, 'FICTION_WITH_FACTS').map((f) => f.detail)).toEqual(['SH003: a fictional device is never shown as ARCHIVAL_IMAGE']);
  });

  it('INVENTED_CHARACTER and CONTINUITY_INVALID: subjects must be the cast or unnamed', () => {
    const invented = subject('CS03', { name: 'Captain Jorn', kind: 'CHARACTER' });
    const stray = subject('CS04', { name: 'Somebody', kind: 'CHARACTER', castId: 'F9', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' });
    const swapped = subject('CS05', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
    const p = historyPlan({}, { subjects: [MIRA, BRANDT, invented, stray, swapped] });
    expect(blocking(p, 'INVENTED_CHARACTER').map((f) => f.ref)).toEqual(['CS03']);
    expect(blocking(p, 'CONTINUITY_INVALID').map((f) => f.detail)).toEqual([
      'CS04: the cast id "F9" is not in the architecture',
      'CS05: Mira is a fictional device, but the subject is described as real',
      'CS05: Mira is FICTIONAL_COMPOSITE, not REAL_PERSON',
    ]);
  });

  it('FICTION_LABEL_MISSING: the label the script promised is on the shot over the block (and checked in saved rows)', () => {
    const p = historyPlan();
    const rows = structuredClone(p);
    rows.shots[2]!.direction.overlays = [];
    expect(checkStoryboard(rows, domainFilm('history').facts).filter((f) => f.kind === 'FICTION_LABEL_MISSING').map((f) => f.ref)).toEqual(['SH003']);
  });

  it('INVENTED_DETAIL_DOCUMENTED: an invented detail in a documented shot blocks; elsewhere it is a warning', () => {
    const uniform = { specifics: [{ detail: 'blue harbour-guard uniforms', kind: 'UNIFORM' as const, basis: 'INVENTED' as const, claimKeys: [] }] };
    const documented = historyPlan({}, { first: { claims: [{ claimKey: 'H1', role: 'CONTEXT' }], spec: uniform } });
    expect(documented.shots[1]!.infoClass).toBe('DOCUMENTED');
    expect(blocking(documented, 'INVENTED_DETAIL_DOCUMENTED').map((f) => f.detail)).toEqual(['SH002 is documented but invents "blue harbour-guard uniforms"']);
    const reconstructed = historyPlan({}, { first: { spec: uniform } });
    expect(reconstructed.shots[1]!.infoClass).toBe('RECONSTRUCTION');
    expect(blocking(reconstructed, 'INVENTED_DETAIL_DOCUMENTED')).toEqual([]);
    expect(reconstructed.qa.filter((f) => f.kind === 'VISUAL_IMPLICATION' && f.ref === 'SH002').map((f) => f.detail)).toEqual([expect.stringMatching(/invents "blue harbour-guard uniforms"/)]);
  });
});

describe('likeness and quotations (biography)', () => {
  const { facts } = domainFilm('biography');
  const lind = (treatment: VisualTreatment, likeness: ReturnType<typeof detail>['likeness'], o: ShotSketch = {}) =>
    plan(facts, [{ to: '1.1:end' }, { to: '⟨end⟩', treatment, shots: [{ subjects: [{ subjectKey: 'CS01', detail: detail({ likeness }) }], claims: [{ claimKey: 'Q1', role: 'SHOWS_SOURCE' }], ...o }] }], [LIND]);

  it('REAL_LIKENESS: no generated face of a real person; a documented portrait is sourced', () => {
    expect(blocking(lind('CINEMATIC_RECONSTRUCTION', 'GENERATED_LIKENESS', { claims: [{ claimKey: 'Q1', role: 'CONTEXT' }] }), 'REAL_LIKENESS').map((f) => f.detail)).toEqual([
      'SH002: Mara Lind is given a generated likeness — show a real person through a sourced likeness, a silhouette or a period-generic figure',
    ]);
    expect(blocking(lind('CINEMATIC_RECONSTRUCTION', 'DOCUMENTED_LIKENESS', { claims: [{ claimKey: 'Q1', role: 'CONTEXT' }] }), 'REAL_LIKENESS')).toHaveLength(1);
    expect(blocking(lind('CINEMATIC_RECONSTRUCTION', 'SILHOUETTE', { claims: [{ claimKey: 'Q1', role: 'CONTEXT' }] }), 'REAL_LIKENESS')).toEqual([]);
    // A documented portrait: sourced, a documented likeness.
    const portrait = lind('PORTRAIT', 'DOCUMENTED_LIKENESS');
    expect(portrait.shots[1]!.method).toBe('ARCHIVAL_SOURCING');
    expect(blocking(portrait)).toEqual([]);
    expect(blocking(lind('PORTRAIT', 'SILHOUETTE'), 'REAL_LIKENESS').map((f) => f.detail)).toEqual([expect.stringMatching(/a documented portrait of Mara Lind is a sourced, documented likeness/)]);
  });

  it('REAL_LIKENESS: where the matrix allows a real person only unidentified, a sourced likeness is refused too', () => {
    const inv = domainFilm('investigation').facts;
    const OSTROM = subject('CS01', { name: 'Lena Ostrom', kind: 'CHARACTER', castId: 'R1', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
    const portrait = (likeness: ReturnType<typeof detail>['likeness']) =>
      plan(inv, [{ to: '2.1:end' }, { to: '3.1:end', treatment: 'PORTRAIT', shots: [{ subjects: [{ subjectKey: 'CS01', detail: detail({ likeness }) }], claims: [{ claimKey: 'I3', role: 'DEPICTS' }] }] }, { to: '⟨end⟩' }], [OSTROM]);
    const sourced = portrait('DOCUMENTED_LIKENESS');
    expect(sourced.shots[1]).toMatchObject({ infoClass: 'UNCERTAIN', method: 'ARCHIVAL_SOURCING' });
    expect(TREATMENT_CLASS_RULES.PORTRAIT.UNCERTAIN.condition).toBe('NON_IDENTIFYING');
    expect(blocking(sourced, 'REAL_LIKENESS').map((f) => f.detail)).toEqual(['SH002: a portrait of uncertain material shows Lena Ostrom only unidentified (a silhouette or a period-generic figure), not by a documented likeness']);
    expect(blocking(portrait('SILHOUETTE'), 'REAL_LIKENESS')).toEqual([]);
  });

  it('OVERLAY_UNSUPPORTED: a quotation must be the verified one; a date or place must be documented or in the claims', () => {
    const quote = (text: string) => plan(facts, [{ to: '1.2:end' }, { to: '⟨end⟩', treatment: 'TEXT_ON_SCREEN', shots: [{ claims: [{ claimKey: 'Q2', role: 'SHOWS_SOURCE' }], spec: { overlays: [{ kind: 'QUOTE', text, reason: 'Her words', claimKeys: ['Q2'], auto: false }] } }] }]);
    expect(blocking(quote('"The work had become a cage."'))).toEqual([]);
    expect(blocking(quote('"The work had become a prison."'), 'OVERLAY_UNSUPPORTED').map((f) => f.detail)).toEqual(['SH002: ""The work had become a prison."" is not a verified quotation of its claims']);
    const inv = domainFilm('investigation').facts;
    const stamp = (kind: 'DATE_STAMP' | 'LOCATION_STAMP', text: string, claimKeys: string[]) =>
      blocking(plan(inv, [{ to: '1.1:end' }, { to: '⟨end⟩', treatment: 'MAP_ANIMATION', shots: [{ to: '1.2:end', claims: [{ claimKey: 'I5', role: 'DATA' }], spec: { dataSpec: { chartType: 'MAP', title: 'The route', items: [{ label: 'Nordhavn', figure: null, date: null, place: 'Nordhavn', claimKey: 'I5' }], note: '' }, overlays: [{ kind, text, reason: 'Where and when', claimKeys, auto: false }] } }, {}] }]), 'OVERLAY_UNSUPPORTED').map((f) => f.detail);
    expect(stamp('LOCATION_STAMP', 'Nordhavn', ['I5'])).toEqual([]);
    expect(stamp('LOCATION_STAMP', 'Copenhagen', ['I5'])).toEqual(['SH002: the place "Copenhagen" is neither a documented setting nor in its claims']);
    expect(stamp('DATE_STAMP', '1912', ['I1'])).toEqual([]);
    expect(stamp('DATE_STAMP', '1909', ['I1'])).toEqual(['SH002: the date "1909" is neither a documented setting nor in its claims']);
  });

  it('OVERLAY_UNSUPPORTED: a documented setting supports only the date or place it states (history: Corvel harbour, 1771)', () => {
    const h = domainFilm('history').facts;
    const stamp = (kind: 'DATE_STAMP' | 'LOCATION_STAMP', text: string) =>
      blocking(plan(h, [{ to: '1.2:end' }, { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H5', role: 'CONTEXT' }], spec: { overlays: [{ kind, text, reason: 'Where and when', claimKeys: [], auto: false }] } }] }, { to: '⟨end⟩' }]), 'OVERLAY_UNSUPPORTED').map((f) => f.detail);
    expect(stamp('DATE_STAMP', '1771')).toEqual([]);
    expect(stamp('DATE_STAMP', '1802')).toEqual(['SH002: the date "1802" is neither a documented setting nor in its claims']);
    expect(stamp('LOCATION_STAMP', 'Corvel harbour')).toEqual([]);
    expect(stamp('LOCATION_STAMP', 'Corvel')).toEqual([]);
    expect(stamp('LOCATION_STAMP', 'Amsterdam')).toEqual(['SH002: the place "Amsterdam" is neither a documented setting nor in its claims']);
  });
});

describe('narration and the gate', () => {
  it('MOCK_NARRATION blocks; PROVISIONAL_TIMING warns; SCOPE_INCOMPLETE blocks at the gate only', () => {
    const scope = syntheticScope(DOMAIN_FILMS.science.spec);
    const script = withRowIds(syntheticDraft(scope, DOMAIN_FILMS.science.blocks));
    const mock = syntheticFacts(scope, script, { mock: true, approval: 'UNREVIEWED', blocks: ['1.1', '1.2'] });
    const p = plan(mock, [{ to: '⟨end⟩' }]);
    expect(blocking(p).map((f) => f.kind)).toEqual(['MOCK_NARRATION']);
    expect(p.qa.filter((f) => f.kind === 'PROVISIONAL_TIMING').map((f) => f.detail)).toEqual(['Provisional timing: takes 0/2 approved (approving the version needs them all)']);
    expect(p.qa.filter((f) => f.kind === 'SCOPE_PARTIAL').map((f) => f.detail)).toEqual(['A preview of 2 of 4 script blocks (the narrated ones)']);
    expect(checkStoryboard(p, mock, { gate: true }).filter((f) => f.kind === 'SCOPE_INCOMPLETE').map((f) => f.severity)).toEqual(['BLOCKING']);
  });
});

describe('the treatment × class matrix', () => {
  it('refuses every ✗ cell: fiction shown as a record or data, framing shown as a record, data or a likeness', () => {
    const { facts } = domainFilm('history');
    const base = historyPlan();
    const refused = VISUAL_TREATMENTS.flatMap((t) => (['FICTION', 'FRAMING'] as ScriptBlockClass[]).filter((c) => !TREATMENT_CLASS_RULES[t][c].allowed).map((c) => [t, c] as const));
    expect(refused.length).toBeGreaterThan(10);
    for (const [t, c] of refused) {
      const rows = structuredClone(base);
      const shot = rows.shots[0]!;
      shot.treatment = t;
      shot.infoClass = c;
      const kinds = checkStoryboard(rows, facts).filter((f) => f.ref === 'SH001' && f.severity === 'BLOCKING').map((f) => f.kind);
      expect(kinds, `${t} × ${c}`).toContain(c === 'FICTION' ? 'FICTION_WITH_FACTS' : 'EVIDENCE_MISSING');
    }
    // No refused cell outside those two columns.
    expect(VISUAL_TREATMENTS.every((t) => (['DOCUMENTED', 'RECONSTRUCTION', 'UNCERTAIN'] as const).every((c) => TREATMENT_CLASS_RULES[t][c].allowed))).toBe(true);
  });

  it('checks the conditions of the ◐ cells (uncertainty marked, hedged data, ranges captioned)', () => {
    const { facts } = domainFilm('science');
    const map = (o: ShotSketch) => plan(facts, [{ to: '1.2:end' }, { to: '2.1:end', treatment: 'TIMELINE', shots: [{ claims: [{ claimKey: 'L2', role: 'CONTEXT' }], spec: { dataSpec: { chartType: 'TIMELINE', title: 'Two explanations', items: [{ label: 'The dispute', figure: null, date: null, place: null, claimKey: 'L2' }], note: '' } }, ...o }] }, { to: '⟨end⟩' }]);
    expect(blocking(map({}), 'UNCERTAIN_AS_FACT').map((f) => f.detail)).toEqual([expect.stringMatching(/a TIMELINE of uncertain material marks what is uncertain/)]);
    expect(blocking(map({ spec: { overlays: [{ kind: 'CAPTION', text: 'Disputed', reason: 'disputed', claimKeys: ['L2'], auto: false }], dataSpec: { chartType: 'TIMELINE', title: 'Two explanations', items: [{ label: 'The dispute', figure: null, date: null, place: null, claimKey: 'L2' }], note: '' } } }))).toEqual([]);
    const data = (o: ShotSketch) => plan(facts, [{ to: '1.2:end' }, { to: '2.1:end', treatment: 'DATA_VISUALIZATION', shots: [{ claims: [{ claimKey: 'L2', role: 'DATA' }], spec: { dataSpec: { chartType: 'COMPARISON', title: 'Algae or iron', items: [{ label: 'Accounts', figure: null, date: null, place: null, claimKey: 'L2' }], note: '' } }, ...o }] }, { to: '⟨end⟩' }]);
    expect(blocking(data({}), 'UNCERTAIN_AS_FACT').map((f) => f.detail)).toEqual([expect.stringMatching(/uncertain data shows its ranges or competing series with a caption/)]);
  });
});

describe('warnings for a person to weigh', () => {
  const warned = (p: PlannedStoryboard, kind: StoryboardFindingKind) => p.qa.filter((f) => f.kind === kind && f.severity === 'WARNING');

  it('VISUAL_IMPLICATION: names, years and figures the evidence does not have, people the architecture leaves out, a low-confidence claim depicted', () => {
    const spec = structuredClone(DOMAIN_FILMS.science.spec);
    spec.claims[0]!.confidence = 'LOW';
    const scope = syntheticScope(spec);
    const facts = syntheticFacts(scope, withRowIds(syntheticDraft(scope, DOMAIN_FILMS.science.blocks)));
    // A dossier person the architecture does not cite: known to the dossier, left out of the story.
    const known = facts.scope.known;
    facts.scope = { ...facts.scope, outsiders: [{ name: 'Henrik Vass', words: ['henrik', 'vass'] }], known: { has: (w: string) => known.has(w) || w === 'henrik' || w === 'vass' } };
    const p = plan(facts, [
      { to: '1.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'L1', role: 'DEPICTS' }], spec: { description: 'Professor Aldane studies the red water in 1958, next to Henrik Vass and 300 dead fish.' } }] },
      { to: '⟨end⟩' },
    ]);
    expect(warned(p, 'VISUAL_IMPLICATION').map((f) => f.detail)).toEqual([
      'SH001 names Aldane, which the evidence does not; shows the year 1958, 300, not in its claims or setting; depicts Henrik Vass, whom the architecture leaves out; depicts L1, a low-confidence claim',
    ]);
  });

  it('VISUAL_IMPLICATION: a real person named in a generated picture that does not say how they are shown', () => {
    const inv = domainFilm('investigation').facts;
    const captain = subject('CS01', { name: 'Lena Ostrom', kind: 'CHARACTER', castId: 'R1', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
    const bridge = (o: ShotSketch, treatment: 'CINEMATIC_RECONSTRUCTION' | 'TEXT_ON_SCREEN' = 'CINEMATIC_RECONSTRUCTION') =>
      plan(inv, [{ to: '1.1:end', treatment, shots: [{ claims: [{ claimKey: 'I1', role: 'DEPICTS' }], ...o, spec: { description: 'Captain Lena Ostrom on the bridge as the Aster lists', ...o.spec } }] }, { to: '⟨end⟩' }], [captain]);
    const named = (p: PlannedStoryboard) => warned(p, 'VISUAL_IMPLICATION').filter((f) => f.ref === 'SH001').map((f) => f.detail);
    expect(named(bridge({}))).toEqual(['SH001 names Lena Ostrom in a generated picture without a subject saying how they are shown (a real person: a silhouette or a period-generic figure, never a generated likeness)']);
    // Shown as a subject (in silhouette), or only named on screen in text: nothing to add.
    expect(named(bridge({ subjects: [{ subjectKey: 'CS01', detail: detail({ likeness: 'SILHOUETTE' }) }] }))).toEqual([]);
    expect(named(bridge({ spec: { description: 'A dark harbour', overlays: [{ kind: 'LOWER_THIRD', text: 'Captain Lena Ostrom', reason: 'Who', claimKeys: ['I4'], auto: false }] } }))).toEqual([]);
  });

  it('ANACHRONISM_RISK: what the sequence says to avoid, and period details resting on the look in a dated sequence', () => {
    const { facts } = domainFilm('history');
    const p = historyPlan({}, {
      first: {
        claims: [{ claimKey: 'H1', role: 'DEPICTS' }],
        spec: { description: 'Men in modern clothing pass buckets.', specifics: [{ detail: 'leather fire buckets', kind: 'TECHNOLOGY', basis: 'PERIOD_GENERIC', claimKeys: [] }] },
      },
    });
    void facts;
    expect(warned(p, 'ANACHRONISM_RISK').map((f) => f.detail)).toEqual([
      'SH002 shows what it must avoid (modern clothing); has period details resting on the period\'s look only (leather fire buckets) in a sequence dated 1771: check against the period',
    ]);
    expect(historyPlan().qa.filter((f) => f.kind === 'ANACHRONISM_RISK')).toEqual([]);
  });

  it('MUST_SHOW_DROPPED: the script\'s must-show over a block, unless a shot over it carries it', () => {
    expect(warned(historyPlan(), 'MUST_SHOW_DROPPED').map((f) => f.detail)).toEqual(['The script asks to show "the burning warehouses" over 1.2; no shot over those words names it']);
    const kept = historyPlan({}, { first: { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec: { mustShow: [{ detail: 'The burning warehouses', claimKeys: ['H1'], origin: 'SCRIPT' }] } } });
    expect(warned(kept, 'MUST_SHOW_DROPPED')).toEqual([]);
    // An empty or bare must-show carries nothing; part of the wanted one, or more than it, still does.
    const dropped = (detail: string) => warned(historyPlan({}, { first: { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec: { mustShow: [{ detail, claimKeys: [], origin: 'STORYBOARD' }] } } }), 'MUST_SHOW_DROPPED').length;
    expect(['', 'the', 'a', 'warehouses', 'burning warehouses at night', 'the harbour'].map(dropped)).toEqual([1, 1, 1, 0, 0, 1]);
    // What a shot shows carries it when one sentence names it, not words scattered over the description.
    const described = (description: string) => warned(historyPlan({}, { first: { claims: [{ claimKey: 'H1', role: 'DEPICTS' }], spec: { description } } }), 'MUST_SHOW_DROPPED');
    expect(described('The burning warehouses light the harbour.')).toEqual([]);
    expect(described('Warehouses line the quay at dusk; a burning brazier warms the guards.')).toHaveLength(1);
  });

  it('FRAMING_FACTUAL_VISUAL: a record over framing narration with no context claim', () => {
    const { facts } = domainFilm('biography');
    const archival = (claims: ShotSketch['claims']) => plan(facts, [{ to: '1.1:end', treatment: 'ARCHIVAL_IMAGE', shots: [{ claims }] }, { to: '⟨end⟩' }]);
    expect(warned(archival([]), 'FRAMING_FACTUAL_VISUAL').map((f) => f.ref)).toEqual(['SH001']);
    expect(warned(archival([{ claimKey: 'Q3', role: 'CONTEXT' }]), 'FRAMING_FACTUAL_VISUAL')).toEqual([]);
  });

  it('CONTINUITY_RISK: a recurring subject with no reference asset, and one shown with different likenesses', () => {
    const { facts } = domainFilm('history');
    const brandt = (likeness: 'SILHOUETTE' | 'PERIOD_GENERIC') => ({ subjects: [{ subjectKey: 'CS02', detail: detail({ likeness }) }], claims: [{ claimKey: 'H2', role: 'CONTEXT' as const }], spec: { uncertaintyDevice: 'LABELLED_LEGEND' as const, overlays: [{ kind: 'CAPTION' as const, text: 'As told (test)', reason: 'probable', claimKeys: [], auto: false }] } });
    const p = plan(facts, [{ to: '1.3:end' }, { to: '2.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '2.1:4', ...brandt('SILHOUETTE') }, { cutIn: 'INFORMATION_CHANGE', ...brandt('PERIOD_GENERIC') }] }, { to: '⟨end⟩' }], [MIRA, BRANDT]);
    expect(warned(p, 'CONTINUITY_RISK').map((f) => f.detail)).toEqual([
      'Requires Elias Brandt continuity asset: it appears in SH002, SH003 and no reference exists yet',
      'Elias Brandt is shown with different likenesses (SILHOUETTE, PERIOD_GENERIC)',
    ]);
    expect(p.subjects.find((s) => s.key === 'CS02')!.spec.referenceAsset).toEqual({ required: true, status: 'MISSING', note: 'Requires Elias Brandt continuity asset' });
    expect(p.shots[1]!.asset!.references).toEqual([{ subjectKey: 'CS02', status: 'MISSING' }]);
  });

  it('COST_HIGH and COST_UNPRICED against the profile\'s ceiling; an unpriced shot is never $0', () => {
    const facts = domainFilm('history', { profile: profileSnapshotWith({ costCeilingUsd: { perFinishedMinute: null, total: 1 } }) }).facts;
    const p = plan(facts, [{ to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }] }, { to: '1.3:end', treatment: 'ARCHIVAL_IMAGE', shots: [{ claims: [{ claimKey: 'H5', role: 'SHOWS_SOURCE' }] }] }, { to: '⟨end⟩' }]);
    expect(warned(p, 'COST_HIGH').map((f) => f.detail)).toEqual([expect.stringMatching(/^The forecast is \$\d+\.\d\d, over the profile's ceiling of \$1\.00$/)]);
    expect(warned(p, 'COST_UNPRICED').map((f) => f.detail)).toEqual(['1 of 3 shots have no verified price: the total covers the rest only']);
    expect(p.costs.basis).toBe('MIXED');
  });

  it('UNALIGNED_TAKE for a take with no word timings, and MODEL_REFERENCE_DROPPED for every dropped reference', () => {
    const { facts } = domainFilm('history', { missingAlignment: ['3.1'] });
    const draft = sketchDraft(facts, [{ to: '1.2:end' }, { to: '⟨end⟩' }]);
    draft.normalization = ['SH002: dropped claim Z9 — it is not in the approved evidence', 'VB01: trimmed to start at 1.1:end'];
    const p = planStoryboard(draft, facts);
    expect(warned(p, 'UNALIGNED_TAKE').map((f) => f.detail)).toEqual(['Clip 6 has no word timings: only its edges can be cuts']);
    expect(warned(p, 'MODEL_REFERENCE_DROPPED').map((f) => `${f.ref}: ${f.detail}`)).toEqual(['SH002: SH002: dropped claim Z9 — it is not in the approved evidence']);
  });
});

function profileSnapshotWith(over: Parameters<typeof profileSnapshot>[0]) {
  return profileSnapshot(over);
}

/**
 * The warnings' precision on a tavern scene like the Tulip Mania opening
 * (Haarlem, winter 1636): plans a model writes for it — candlelight "with no
 * electric light", the same period clothing in shot after shot, a notary seen
 * by his hands, a must-show worded in the singular — carry no false warning
 * and no warning twice, and the genuine ones still fire beside them.
 */
describe('warning precision on a Haarlem tavern, winter 1636', () => {
  const warned = (p: PlannedStoryboard, kind: StoryboardFindingKind) => p.qa.filter((f) => f.kind === kind && f.severity === 'WARNING').map((f) => `${f.ref}: ${f.detail}`);
  const setting = (date: string) => ({ location: { value: 'Haarlem', basis: 'DOCUMENTED' as const }, date: { value: date, basis: 'DOCUMENTED' as const }, timeOfDay: { value: 'evening', basis: 'RECONSTRUCTION' as const } });
  const SPEC: SyntheticSpec = {
    question: 'Why did people pay a fortune for flowers they never saw?',
    claims: [
      { key: 'T1', statement: 'In the winter of 1636 tulip bulbs were traded in the taverns of Haarlem.' },
      { key: 'T2', statement: 'Buyers signed promissory notes for bulbs that were still in the ground.' },
      { key: 'T6', statement: 'Prices collapsed at an auction in Haarlem in February 1637.' },
    ],
    sequences: [
      {
        title: 'The tavern colleges',
        setting: setting('winter 1636'),
        visual: { mustShow: [{ detail: 'promissory notes changing hands', claimKeys: ['T2'] }], mustAvoid: ['electric light'] },
        beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['T1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['T2'] }, { id: '1.3', basis: 'DOCUMENTED', claimKeys: ['T2'] }],
      },
      { title: 'The auction', setting: setting('February 1637'), beats: [{ id: '2.1', basis: 'DOCUMENTED', claimKeys: ['T6'] }] },
    ],
  };
  const visual = (mustShow: { detail: string; claimKeys: string[] }[] = []) => ({ intent: 'CINEMATIC_RECONSTRUCTION' as const, mustShow, mustAvoid: [], priority: 'NORMAL' as const, note: '' });
  /** Four blocks, one beat and one shot each; the second block may ask for the sequence's must-show itself. */
  const tavern = (o: { ownMustShow?: boolean; shots?: Partial<Record<'1.1' | '1.2' | '1.3' | '2.1', ShotSketch>>; subjects?: DraftSubject[] } = {}) => {
    const scope = syntheticScope(SPEC);
    const script = withRowIds(
      syntheticDraft(scope, [
        [
          { text: 'In the winter of 1636, men traded tulip bulbs in the taverns of Haarlem.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['T1'], visual: visual() },
          { text: 'They signed promissory notes for bulbs still in the ground.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['T2'], visual: visual(o.ownMustShow ? [{ detail: 'promissory notes changing hands', claimKeys: ['T2'] }] : []) },
          { text: 'The notes passed from hand to hand, again and again.', infoClass: 'DOCUMENTED', beatIds: ['1.3'], claimKeys: ['T2'], visual: visual() },
        ],
        [{ text: 'In February 1637, at an auction in Haarlem, nobody bid.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['T6'], visual: visual() }],
      ]),
    );
    const facts = syntheticFacts(scope, script);
    const doublets = { detail: 'black wool doublets with flat white collars', kind: 'CLOTHING' as const, basis: 'PERIOD_GENERIC' as const, claimKeys: [] };
    const shot = (block: '1.1' | '1.2' | '1.3' | '2.1', claim: string): ShotSketch => ({
      claims: [{ claimKey: claim, role: 'DEPICTS' }],
      ...o.shots?.[block],
      spec: { description: 'Traders lean over a tavern table.', lighting: 'Warm candlelight and firelight only, no electric light.', specifics: [doublets], ...o.shots?.[block]?.spec },
    });
    return planStoryboard(
      sketchDraft(
        facts,
        [
          { to: '1.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [shot('1.1', 'T1')] },
          { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [shot('1.2', 'T2')] },
          { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [shot('1.3', 'T2')] },
          { to: '⟨end⟩', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [shot('2.1', 'T6')] },
        ],
        { subjects: o.subjects ?? [] },
      ),
      facts,
    );
  };

  it('plans with no blocking finding (the warnings below are the only findings in question)', () => {
    expect(blocking(tavern())).toEqual([]);
  });

  it('ANACHRONISM_RISK: "no electric light" is not electric light; one period detail is one check per date, on its first shot', () => {
    expect(warned(tavern(), 'ANACHRONISM_RISK')).toEqual([
      "SH001: SH001 has period details resting on the period's look only (black wool doublets with flat white collars, also in SH002, SH003) in a sequence dated winter 1636: check against the period",
      "SH004: SH004 has period details resting on the period's look only (black wool doublets with flat white collars) in a sequence dated February 1637: check against the period",
    ]);
    // A lamp that is really there still warns, on its own shot, though its doublets were reported on the first.
    const lamp = tavern({ shots: { '1.3': { spec: { description: 'An electric light hangs over the tavern table.' } } } });
    expect(warned(lamp, 'ANACHRONISM_RISK')).toContainEqual('SH003: SH003 shows what it must avoid (electric light): check against the period');
  });

  it('ANACHRONISM_RISK: a shot naming a period detail twice, however cased or punctuated, names it once and never itself among the others', () => {
    const doublets = { detail: 'black wool doublets with flat white collars', kind: 'CLOTHING' as const, basis: 'PERIOD_GENERIC' as const, claimKeys: [] };
    const twice = tavern({ shots: { '1.1': { spec: { specifics: [doublets, { ...doublets, detail: 'Black wool doublets, with flat white collars' }] } } } });
    expect(warned(twice, 'ANACHRONISM_RISK')).toEqual([
      "SH001: SH001 has period details resting on the period's look only (black wool doublets with flat white collars, also in SH002, SH003) in a sequence dated winter 1636: check against the period",
      "SH004: SH004 has period details resting on the period's look only (black wool doublets with flat white collars) in a sequence dated February 1637: check against the period",
    ]);
  });

  it('MUST_SHOW_DROPPED: a sequence must-show is asked once over all the blocks of its claim, and a block repeating it is not counted twice', () => {
    expect(warned(tavern(), 'MUST_SHOW_DROPPED')).toEqual(['VB02: The sequence asks to show "promissory notes changing hands" over 1.2, 1.3; no shot over those words names it']);
    expect(warned(tavern({ ownMustShow: true }), 'MUST_SHOW_DROPPED')).toEqual(['VB02: The script asks to show "promissory notes changing hands" over 1.2; no shot over those words names it']);
  });

  it('MUST_SHOW_DROPPED: carried by a must-show in the singular, over any block of the claim, or by what the shot shows; not by a shot saying it is absent', () => {
    const carried = (block: '1.2' | '1.3', spec: ShotSketch['spec']) => warned(tavern({ shots: { [block]: { spec } } }), 'MUST_SHOW_DROPPED');
    expect(carried('1.3', { mustShow: [{ detail: 'a promissory note changing hands', claimKeys: ['T2'], origin: 'STORYBOARD' }] })).toEqual([]);
    expect(carried('1.2', { description: 'Close on the table: promissory notes changing hands between two traders.' })).toEqual([]);
    expect(carried('1.2', { description: 'Traders wait; no promissory notes changing hands yet.' })).toHaveLength(1);
    expect(carried('1.2', { mustShow: [{ detail: 'a notary sealing a contract', claimKeys: ['T2'], origin: 'STORYBOARD' }] })).toHaveLength(1);
    // The words of a must-show spread over separate sentences name nothing together.
    expect(carried('1.2', { description: 'A promissory clause is read aloud; notes pinned to the wall; the hands of a clock; changing light.' })).toHaveLength(1);
  });

  it('CONTINUITY_RISK: a figure seen by his hands in one shot and his face in another is not shown with different likenesses', () => {
    const notary = subject('CS01', { name: 'A Haarlem notary', kind: 'CHARACTER', anonymous: true });
    const seen = (likeness: 'NONE' | 'SILHOUETTE') =>
      warned(
        tavern({
          subjects: [notary],
          shots: { '1.2': { subjects: [{ subjectKey: 'CS01', detail: detail({ action: 'presses a seal into wax', likeness }) }] }, '1.3': { subjects: [{ subjectKey: 'CS01', detail: detail({ action: 'watches', likeness: 'PERIOD_GENERIC' }) }] } },
        }),
        'CONTINUITY_RISK',
      );
    expect(seen('NONE')).toEqual(['CS01: Requires A Haarlem notary continuity asset: it appears in SH002, SH003 and no reference exists yet']);
    expect(seen('SILHOUETTE')).toEqual([
      'CS01: Requires A Haarlem notary continuity asset: it appears in SH002, SH003 and no reference exists yet',
      'CS01: A Haarlem notary is shown with different likenesses (SILHOUETTE, PERIOD_GENERIC)',
    ]);
  });
});
