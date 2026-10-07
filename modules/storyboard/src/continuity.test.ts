import { describe, expect, it } from 'vitest';
import { continuityRequirement, planSubjects, resolveSubject, type SubjectProposal } from './continuity.ts';
import { planStoryboard } from './plan.ts';
import { domainFilm, sketchDraft, subject, type ShotSketch } from './testing.ts';

/**
 * Continuity (§19): characters are the cast or unnamed figures — never
 * invented; a cast member keeps the cast's name and kind; every design
 * detail says what it rests on; subjects know where they appear, and the
 * recurring ones (and fictional characters) require a reference asset.
 */

const { scope, facts } = domainFilm('history');

const proposal = (o: Partial<SubjectProposal> & Pick<SubjectProposal, 'key' | 'name' | 'kind'>): SubjectProposal => ({
  castId: null,
  anonymous: false,
  description: 'Seen in the harbour (test).',
  era: '1771',
  location: 'Corvel',
  approximateAge: null,
  clothing: null,
  physicalDescription: null,
  visualIdentity: { palette: [], silhouette: null, props: [] },
  designDetails: [],
  rules: [],
  claimKeys: [],
  ...o,
});

describe('characters are the cast, or unnamed', () => {
  it('takes a cast member\'s name and kind from the architecture, with the rules a fictional device keeps', () => {
    const notes: string[] = [];
    const mira = resolveSubject(proposal({ key: 'CS01', name: 'Mira the dock girl', kind: 'CHARACTER', castId: 'F1' }), scope, notes)!;
    expect(mira.spec).toMatchObject({ name: 'Mira', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION', anonymous: false });
    expect(mira.spec.rules).toEqual(['A fictional device: observes real people, never interacts with them', 'Never shown in a documented scene']);
    const brandt = resolveSubject(proposal({ key: 'CS02', name: 'Brandt', kind: 'CHARACTER', castId: 'R1' }), scope, notes)!;
    expect(brandt.spec).toMatchObject({ name: 'Elias Brandt', castKind: 'REAL_PERSON', basis: 'DOCUMENTED' });
    expect(brandt.spec.rules[0]).toMatch(/no generated likeness/);
    expect(notes).toEqual([]);
  });

  it('keeps anonymous figures, and drops a named character the architecture does not have (INVENTED_CHARACTER)', () => {
    const notes: string[] = [];
    const crowd = resolveSubject(proposal({ key: 'CS03', name: 'Dock workers', kind: 'CHARACTER', anonymous: true }), scope, notes)!;
    expect(crowd.spec).toMatchObject({ basis: 'RECONSTRUCTION', anonymous: true, castId: null, rules: ['Anonymous: never named or given a known face'] });
    expect(resolveSubject(proposal({ key: 'CS04', name: 'Captain Jorn', kind: 'CHARACTER' }), scope, notes)).toBeNull();
    // "Anonymous" does not license a name.
    expect(resolveSubject(proposal({ key: 'CS05', name: 'Old Jorn Haldersen', kind: 'CHARACTER', anonymous: true }), scope, notes)).toBeNull();
    expect(resolveSubject(proposal({ key: 'CS06', name: 'Somebody', kind: 'CHARACTER', castId: 'F9' }), scope, notes)).toBeNull();
    expect(notes).toEqual([
      'CS04: dropped the character "Captain Jorn" — it is neither a cast member nor an unnamed figure (INVENTED_CHARACTER)',
      'CS05: dropped the character "Old Jorn Haldersen" — it is neither a cast member nor an unnamed figure (INVENTED_CHARACTER)',
      'CS06: dropped the cast id "F9" — it is not in the architecture',
      'CS06: dropped the character "Somebody" — it is neither a cast member nor an unnamed figure (INVENTED_CHARACTER)',
    ]);
  });

  it('gives a place no cast id, and marks a design detail invented when its claim is not in the evidence', () => {
    const notes: string[] = [];
    const harbour = resolveSubject(
      proposal({
        key: 'CS07',
        name: 'Corvel harbour',
        kind: 'ENVIRONMENT',
        castId: 'R1',
        designDetails: [
          { detail: 'stone quays', basis: 'CLAIM', claimKeys: ['H3'] },
          { detail: 'red-tiled warehouses', basis: 'CLAIM', claimKeys: ['Z1'] },
        ],
      }),
      scope,
      notes,
    )!;
    expect(harbour.spec.castId).toBeNull();
    expect(harbour.spec.designDetails).toEqual([
      { detail: 'stone quays', basis: 'CLAIM', claimKeys: ['H3'] },
      { detail: 'red-tiled warehouses', basis: 'INVENTED', claimKeys: [] },
    ]);
    expect(harbour.spec.basis).toBe('RECONSTRUCTION');
    expect(notes).toEqual(['CS07: dropped the cast id "R1" — a environment is not a cast member', 'CS07: dropped claim Z1 of "red-tiled warehouses" — not in the approved evidence']);
  });
});

describe('appearances and reference assets', () => {
  it('lists where each subject appears; a recurring one, or a fictional character, requires a reference asset', () => {
    const mira = subject('CS01', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' });
    const harbour = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const quay = subject('CS03', { name: 'The north quay', kind: 'LOCATION' });
    const env = (key: string) => ({ spec: { environment: { subjectKey: key, description: 'The harbour (test).' } } });
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.1:end', ...env('CS02') }, env('CS03')] }, { to: '1.3:end', shots: [{ subjects: [{ subjectKey: 'CS01', detail: { role: 'PRIMARY', action: '', interactions: [], likeness: 'PERIOD_GENERIC', speaks: null } }], claims: [{ claimKey: 'H5', role: 'CONTEXT' }] }] }, { to: '⟨end⟩', shots: [env('CS02')] }], { subjects: [mira, harbour, quay] });
    const planned = planSubjects(draft.subjects, draft.shots);
    expect(planned.map((s) => [s.key, s.appearances, s.spec.referenceAsset.required, s.infoClass])).toEqual([
      ['CS01', ['SH003'], true, 'FICTION'],
      ['CS02', ['SH001', 'SH004'], true, 'RECONSTRUCTION'],
      ['CS03', ['SH002'], false, 'RECONSTRUCTION'],
    ]);
    expect(continuityRequirement(planned[1]!.spec)).toBe('Requires Corvel harbour continuity asset');
    expect(continuityRequirement(planned[2]!.spec)).toBeNull();
    // The version's shots name the references they need.
    const p = planStoryboard(draft, facts);
    expect(p.shots.map((s) => s.asset!.references.map((r) => r.subjectKey))).toEqual([['CS02'], [], ['CS01'], ['CS02']]);
    expect(p.shots[0]!.asset!.reuse).toMatchObject({ reusable: true, category: 'ENVIRONMENT', subjects: ['CS02'] });
    // The second view of the same place, with the same treatment, reuses the first's asset.
    expect(p.shots[3]!.asset!.reuseOf).toBe('SH001');
    expect(p.shots[3]!.cost).toMatchObject({ totalUsd: 0, generationSec: 0, note: "Reuses SH001's asset: no generation of its own" });
  });

  it('reuses an asset only for the same picture: never for another scene in the place, or the place with something happening in it', () => {
    const harbour = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const env = { subjectKey: 'CS02', description: 'The harbour (test).' };
    const scene = (description: string): ShotSketch => ({ spec: { description, environment: env }, claims: [{ claimKey: 'H1', role: 'CONTEXT' }] });
    const draft = sketchDraft(
      facts,
      [
        { to: '1.1:end', treatment: 'TEXT_ON_SCREEN' },
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.2:9', ...scene('Flames leap from the warehouse roofs') }, scene('Calm water at dawn, smoke drifting')] },
        // 1.2:end–1.3:9 lasts exactly as long as SH002 (1.1:end–1.2:9).
        { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.3:9', ...scene('Flames leap from the warehouse roofs') }, scene('Ash settles on the empty quay')] },
        { to: '⟨end⟩', treatment: 'ENVIRONMENT', shots: [{ to: '2.1:end', spec: { environment: env } }, { spec: { environment: env }, claims: [{ claimKey: 'H3', role: 'DEPICTS' }] }] },
      ],
      { subjects: [harbour] },
    );
    const p = planStoryboard(draft, facts);
    expect(p.shots[3]!.endMs! - p.shots[3]!.startMs!).toBe(p.shots[1]!.endMs! - p.shots[1]!.startMs!);
    expect(p.shots.map((s) => [s.key, s.asset!.reuse.category, s.asset!.reuseOf])).toEqual([
      ['SH001', 'OTHER', null],
      ['SH002', 'ESTABLISHING', null],
      // Another scene in the same place is its own generation.
      ['SH003', 'ESTABLISHING', null],
      // The same view again, no longer than the footage made for it, is a reuse.
      ['SH004', 'ESTABLISHING', 'SH002'],
      ['SH005', 'ESTABLISHING', null],
      ['SH006', 'ENVIRONMENT', null],
      // The place with a depicted event in it is not the empty place again.
      ['SH007', 'ENVIRONMENT', null],
    ]);
    expect(p.shots[2]!.cost!.totalUsd).toBeGreaterThan(0);
    expect(p.shots[6]!.cost!.totalUsd).toBeGreaterThan(0);
  });

  it('never reuses generated footage for a longer shot: the longer one is its own generation, and a later shorter one reuses either', () => {
    const harbour = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const env = { subjectKey: 'CS02', description: 'The harbour (test).' };
    const view: ShotSketch = { spec: { description: 'Flames leap from the warehouse roofs', environment: env }, claims: [{ claimKey: 'H1', role: 'CONTEXT' }] };
    const draft = sketchDraft(
      facts,
      [
        { to: '1.1:end', treatment: 'TEXT_ON_SCREEN' },
        // 3.8 s, then the whole of 1.3 (8.7 s), then 1.3-long again, then 3.0 s.
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.2:9', ...view }, { ...view, spec: { ...view.spec, description: 'Calm water at dawn' } }] },
        { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [view] },
        { to: '2.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '2.1:end', ...view, spec: { ...view.spec, description: 'Smoke over the town' } }, view] },
        { to: '⟨end⟩', treatment: 'ENVIRONMENT' },
      ],
      { subjects: [harbour] },
    );
    const p = planStoryboard(draft, facts);
    const shot = (k: string) => p.shots.find((s) => s.key === k)!;
    expect(shot('SH004').endMs! - shot('SH004').startMs!).toBeGreaterThan(shot('SH002').endMs! - shot('SH002').startMs!);
    expect([shot('SH002'), shot('SH004'), shot('SH006')].map((s) => [s.method, s.asset!.reuseOf])).toEqual([
      ['GENERATIVE_VIDEO', null],
      // Longer than the 3.8 s made for SH002: footage of its own, priced.
      ['GENERATIVE_VIDEO', null],
      // No longer than SH004's: a reuse of it.
      ['GENERATIVE_VIDEO', 'SH004'],
    ]);
    expect(shot('SH004').cost).toMatchObject({ basis: 'ESTIMATED', generationSec: (shot('SH004').endMs! - shot('SH004').startMs!) / 1000 });
    expect(shot('SH004').cost!.totalUsd).toBeGreaterThan(0);
    expect(shot('SH006').cost!.totalUsd).toBe(0);
  });
});
