import { describe, expect, it } from 'vitest';
import { emptyContent } from './draft.ts';
import {
  blockFacts,
  claimAllowed,
  claimFacts,
  deriveClass,
  evidenceSnapshot,
  groundedSpec,
  inheritedMustAvoid,
  inheritedMustShow,
  labelObligation,
  narrationCap,
  narrativeClass,
  shotDepiction,
  shownClaimKeys,
  shownFacts,
  type ClassInput,
} from './inherit.ts';
import { domainFilm, subject } from './testing.ts';

/**
 * What each input contributes, and what a shot asserts (§2.6, §2.7): the
 * class derivation table rule by rule, the cap the narration puts on it,
 * the only exception (a record shown as itself), a proposal that may lower
 * but never raise it, the depiction facts, and the script's visual
 * direction re-resolved against the evidence as it is now.
 */

const history = domainFilm('history');
const science = domainFilm('science');
const block = (film: typeof history, key: string) => film.facts.spine.block(key)!.block;
const seq = (film: typeof history, n: number) => film.scope.sequences.get(n)!;

const input = (film: typeof history, claims: { claimKey: string; role: 'DEPICTS' | 'SHOWS_SOURCE' | 'DATA' | 'CONTEXT' | 'PERIOD_BASIS' }[], o: Partial<ClassInput> = {}): ClassInput => ({
  depiction: 'RECONSTRUCTED',
  claims: claimFacts(film.scope, claims),
  grounded: true,
  narrationClasses: ['DOCUMENTED'],
  beatBases: ['DOCUMENTED'],
  proposed: null,
  ...o,
});

describe('the narrative class of the words a shot covers', () => {
  it('is the weakest class; framing only when it is all there is', () => {
    expect(narrativeClass(['DOCUMENTED', 'UNCERTAIN'])).toBe('UNCERTAIN');
    expect(narrativeClass(['DOCUMENTED', 'FRAMING'])).toBe('DOCUMENTED');
    expect(narrativeClass(['RECONSTRUCTION', 'FICTION'])).toBe('FICTION');
    expect(narrativeClass(['FRAMING'])).toBe('FRAMING');
    expect(narrativeClass([])).toBe('FRAMING');
    expect(narrationCap(['FRAMING'])).toBe(3);
    expect(narrationCap(['DOCUMENTED', 'UNCERTAIN'])).toBe(1);
  });
});

describe('the class a shot asserts (the first rule that matches)', () => {
  it('1: a fictional depiction is FICTION', () => {
    expect(deriveClass(input(history, [{ claimKey: 'H5', role: 'CONTEXT' }], { depiction: 'FICTIONAL' })).infoClass).toBe('FICTION');
  });

  it('2: depicting a claim that is not established is UNCERTAIN; a reconstruction of PROBABLE claims only is RECONSTRUCTION', () => {
    expect(deriveClass(input(history, [{ claimKey: 'H2', role: 'DEPICTS' }], { narrationClasses: ['RECONSTRUCTION'] })).infoClass).toBe('RECONSTRUCTION');
    expect(deriveClass(input(history, [{ claimKey: 'H2', role: 'DEPICTS' }], { depiction: 'RECORD', narrationClasses: ['RECONSTRUCTION'] })).infoClass).toBe('UNCERTAIN');
    expect(deriveClass(input(science, [{ claimKey: 'L2', role: 'DEPICTS' }])).infoClass).toBe('UNCERTAIN');
    expect(deriveClass(input(history, [{ claimKey: 'H4', role: 'DEPICTS' }, { claimKey: 'H2', role: 'DEPICTS' }])).infoClass).toBe('UNCERTAIN');
  });

  it('2: a detail resting on a claim that is not established weighs as a depicted one; an established one changes nothing', () => {
    const shown = (film: typeof history, spec: Parameters<typeof shownFacts>[1]) => shownFacts(film.scope, spec);
    const probable = { ...emptyContent(), specifics: [{ detail: 'Brandt at the warehouse doors', kind: 'PERSON' as const, basis: 'CLAIM' as const, claimKeys: ['H2'] }] };
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { shown: shown(history, probable) })).infoClass).toBe('RECONSTRUCTION');
    const disputed = { ...emptyContent(), mustShow: [{ detail: 'Red algae on the water', claimKeys: ['L2'], origin: 'STORYBOARD' as const }] };
    expect(deriveClass(input(science, [{ claimKey: 'L1', role: 'DEPICTS' }], { shown: shown(science, disputed) })).infoClass).toBe('UNCERTAIN');
    const established = { ...emptyContent(), objects: [{ name: 'The burning warehouses', basis: 'CLAIM' as const, claimKeys: ['H1'] }] };
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { shown: shown(history, established) })).infoClass).toBe('DOCUMENTED');
    // What the details rest on: claim-based specifics and objects, and must-shows; never a period-generic or invented detail's keys, or an unknown claim.
    const mixed = { ...emptyContent(), specifics: [{ detail: 'Night', kind: 'OTHER' as const, basis: 'PERIOD_GENERIC' as const, claimKeys: ['H5'] }], objects: [{ name: 'A bucket', basis: 'CLAIM' as const, claimKeys: ['H5', 'X9'] }], mustShow: [{ detail: 'Fire', claimKeys: ['H1'], origin: 'SCRIPT' as const }] };
    expect(shownClaimKeys(mixed)).toEqual(['H5', 'X9', 'H1']);
    expect(shownFacts(history.scope, mixed).map((c) => c.key)).toEqual(['H5', 'H1']);
  });

  it('3: established claims depicted are DOCUMENTED only with grounded specifics over documented beats; otherwise RECONSTRUCTION', () => {
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }])).infoClass).toBe('DOCUMENTED');
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { grounded: false })).infoClass).toBe('RECONSTRUCTION');
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { beatBases: ['DOCUMENTED', 'RECONSTRUCTION'] })).infoClass).toBe('RECONSTRUCTION');
  });

  it('4: a record or data shown from established sources is DOCUMENTED; any other verdict UNCERTAIN', () => {
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'SHOWS_SOURCE' }], { depiction: 'RECORD' })).infoClass).toBe('DOCUMENTED');
    expect(deriveClass(input(science, [{ claimKey: 'L4', role: 'DATA' }], { depiction: 'DATA' })).infoClass).toBe('DOCUMENTED');
    expect(deriveClass(input(history, [{ claimKey: 'H2', role: 'SHOWS_SOURCE' }], { depiction: 'RECORD' })).infoClass).toBe('UNCERTAIN');
  });

  it('5 and 6: an illustration resting on nothing is FRAMING; context alone takes the narration\'s weakest class', () => {
    expect(deriveClass(input(history, [], { depiction: 'ILLUSTRATIVE' })).infoClass).toBe('FRAMING');
    expect(deriveClass(input(history, [{ claimKey: 'H5', role: 'CONTEXT' }], { depiction: 'ILLUSTRATIVE', narrationClasses: ['DOCUMENTED', 'RECONSTRUCTION'] })).infoClass).toBe('RECONSTRUCTION');
  });

  it('never exceeds what the narration allows, except a record shown as itself', () => {
    // A documented reconstruction over uncertain narration is uncertain.
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { narrationClasses: ['UNCERTAIN'] })).infoClass).toBe('UNCERTAIN');
    // The record itself, established, over uncertain narration stays documented.
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'SHOWS_SOURCE' }], { depiction: 'RECORD', narrationClasses: ['UNCERTAIN'] })).infoClass).toBe('DOCUMENTED');
    // Data is not that exception.
    expect(deriveClass(input(science, [{ claimKey: 'L4', role: 'DATA' }], { depiction: 'DATA', narrationClasses: ['UNCERTAIN'] })).infoClass).toBe('UNCERTAIN');
  });

  it('takes a proposal that lowers the class and refuses one that raises it (noted)', () => {
    const lowered = deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { proposed: 'UNCERTAIN' }));
    expect(lowered).toEqual({ infoClass: 'UNCERTAIN', derived: 'DOCUMENTED', note: null });
    const raised = deriveClass(input(science, [{ claimKey: 'L2', role: 'DEPICTS' }], { proposed: 'DOCUMENTED' }));
    expect(raised.infoClass).toBe('UNCERTAIN');
    expect(raised.note).toBe('the proposed class DOCUMENTED was not taken: the evidence and narration make it UNCERTAIN');
    // FICTION and FRAMING are not "lower": they would change what the shot is.
    expect(deriveClass(input(history, [{ claimKey: 'H1', role: 'DEPICTS' }], { proposed: 'FICTION' })).infoClass).toBe('DOCUMENTED');
  });
});

describe('grounded details', () => {
  it('rest on a claim they name, or on the period: a claim basis naming no claim, or an invented detail, is not grounded', () => {
    const spec = (basis: 'CLAIM' | 'PERIOD_GENERIC' | 'INVENTED', claimKeys: string[]) => ({ specifics: [{ detail: 'A uniform', kind: 'UNIFORM' as const, basis, claimKeys }], objects: [] });
    expect(groundedSpec(spec('CLAIM', ['H1']))).toBe(true);
    expect(groundedSpec(spec('PERIOD_GENERIC', []))).toBe(true);
    expect(groundedSpec(spec('CLAIM', []))).toBe(false);
    expect(groundedSpec(spec('INVENTED', ['H1']))).toBe(false);
    expect(groundedSpec({ specifics: [], objects: [{ name: 'A ledger', basis: 'CLAIM', claimKeys: [] }] })).toBe(false);
  });
});

describe('depiction facts', () => {
  const mira = subject('CS01', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' }).spec;
  const crowd = subject('CS02', { name: 'Dock workers', kind: 'CHARACTER', anonymous: true }).spec;
  const harbour = subject('CS03', { name: 'Corvel harbour', kind: 'ENVIRONMENT' }).spec;
  it('reads subjects, objects and DEPICTS claims from the shot', () => {
    expect(shotDepiction('CINEMATIC_RECONSTRUCTION', 'GENERATIVE_VIDEO', [mira], emptyContent(), [])).toBe('FICTIONAL');
    expect(shotDepiction('CINEMATIC_RECONSTRUCTION', 'GENERATIVE_VIDEO', [crowd], emptyContent(), [])).toBe('RECONSTRUCTED');
    expect(shotDepiction('ENVIRONMENT', 'GENERATIVE_IMAGE', [harbour], emptyContent(), [])).toBe('ILLUSTRATIVE');
    expect(shotDepiction('ENVIRONMENT', 'GENERATIVE_IMAGE', [], emptyContent(), [{ role: 'DEPICTS' }])).toBe('RECONSTRUCTED');
    expect(shotDepiction('CINEMATIC_RECONSTRUCTION', 'STILL_MOTION', [], { ...emptyContent(), objects: [{ name: 'a bucket', basis: 'PERIOD_GENERIC', claimKeys: [] }] }, [])).toBe('RECONSTRUCTED');
    expect(shotDepiction('ARCHIVAL_IMAGE', 'ARCHIVAL_SOURCING', [], emptyContent(), [{ role: 'SHOWS_SOURCE' }])).toBe('RECORD');
    expect(shotDepiction('DATA_VISUALIZATION', 'DETERMINISTIC_GRAPHIC', [], emptyContent(), [{ role: 'DATA' }])).toBe('DATA');
  });
});

describe('the script\'s visual direction, re-resolved', () => {
  it('re-resolves must-show claims and cautions on a detail resting on an uncertain claim', () => {
    expect(inheritedMustShow(history.scope, block(history, '1.2'), seq(history, 1))).toEqual([{ detail: 'the burning warehouses', claimKeys: ['H1'], origin: 'SCRIPT', caution: null }]);
    const b = { ...block(history, '2.1'), visual: { ...block(history, '2.1').visual, mustShow: [{ detail: 'Brandt at the warehouse door', claimKeys: ['H2', 'X9'] }] } };
    const [m] = inheritedMustShow(history.scope, b, seq(history, 2));
    expect(m).toMatchObject({ claimKeys: ['H2'], caution: expect.stringMatching(/^rests on H2, not established/) });
  });

  it('merges what the script and the sequence say to avoid, once each', () => {
    const b = { ...block(history, '1.2'), visual: { ...block(history, '1.2').visual, mustAvoid: ['Modern clothing', 'cars'] } };
    expect(inheritedMustAvoid([b], [seq(history, 1)])).toEqual([
      { text: 'Modern clothing', origin: 'SCRIPT' },
      { text: 'cars', origin: 'SCRIPT' },
    ]);
    expect(inheritedMustAvoid([block(history, '1.2')], [seq(history, 1)])).toEqual([{ text: 'modern clothing', origin: 'SEQUENCE' }]);
  });

  it('knows a label obligation, the seed treatment and the treatments a block allows', () => {
    expect(labelObligation(block(history, '1.3'))).toBe(true);
    expect(labelObligation(block(history, '1.2'))).toBe(false);
    const f = blockFacts(history.scope, block(history, '1.3'), seq(history, 1));
    expect(f).toMatchObject({ infoClass: 'RECONSTRUCTION', fictional: true, beatBases: ['RECONSTRUCTION'], seed: 'CINEMATIC_RECONSTRUCTION', labelObligation: true });
    expect(f.treatments).toContain('CINEMATIC_RECONSTRUCTION');
    const fiction = { ...block(history, '1.3'), infoClass: 'FICTION' as const, visual: { ...block(history, '1.3').visual, intent: 'ARCHIVAL' as const } };
    expect(blockFacts(history.scope, fiction, seq(history, 1)).seed).toBeNull();
    expect(blockFacts(history.scope, fiction, seq(history, 1)).treatments).not.toContain('ARCHIVAL_IMAGE');
    const portrait = { ...block(history, '1.3'), visual: { ...block(history, '1.3').visual, intent: 'PORTRAIT' as const } };
    expect(blockFacts(history.scope, portrait, seq(history, 1)).seed).toBe('CHARACTER_VISUAL');
  });
});

describe('which claims a shot may use', () => {
  it('depicts its blocks\' and their beats\' claims; uses its sequences\' and the cast\'s claims only as context', () => {
    const blocks = [block(history, '2.1')];
    const seqs = [seq(history, 2)];
    expect(claimAllowed(history.scope, 'DEPICTS', 'H2', blocks, seqs)).toBe(true);
    expect(claimAllowed(history.scope, 'DEPICTS', 'H1', blocks, seqs)).toBe(false);
    expect(claimAllowed(history.scope, 'CONTEXT', 'H5', blocks, seqs)).toBe(true); // Mira's cast claims
    expect(claimAllowed(history.scope, 'CONTEXT', 'NOPE', blocks, seqs)).toBe(false);
  });

  it('snapshots verdicts, presentation, traceable sources, the narration\'s classes and the setting\'s basis', () => {
    const snap = evidenceSnapshot(history.scope, claimFacts(history.scope, [{ claimKey: 'H2', role: 'DEPICTS' }]), [block(history, '2.1')], [], seq(history, 2));
    expect(snap).toEqual({
      claims: [{ claimId: 'claim-H2', claimKey: 'H2', role: 'DEPICTS', verdict: 'PROBABLE', confidence: 'HIGH', presentation: 'HEDGE', sourceIds: ['src-1'] }],
      narrationClasses: ['UNCERTAIN'],
      beatBases: ['UNCERTAIN'],
      archBeatIds: ['2.1'],
      sequenceNumber: 2,
      settingBasis: { location: 'RECONSTRUCTION', date: null, timeOfDay: 'RECONSTRUCTION' },
    });
    expect(evidenceSnapshot(history.scope, [], [block(history, '1.2')], [], seq(history, 1)).settingBasis).toEqual({ location: 'DOCUMENTED', date: 'DOCUMENTED', timeOfDay: 'RECONSTRUCTION' });
  });
});
