import { runtimeTarget } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { blockingCount, buildArchitecture, toArchitectOutput, type BuiltArchitecture, type FindingKind, type SelectedUnit } from './architecture.ts';
import { EvidenceBase } from './evidence.ts';
import { normalizeMined } from './mining.ts';
import { computeArchitectureReport, type StoryEditorVerdict } from './quality.ts';
import { ArchitectOutput, type ArchitectSequence } from './schemas.ts';
import { FAKE_VALID, fakeArchitectOutput, fakeEvidenceInput, type FakeArchitectOptions } from './testing.ts';

const evidence = new EvidenceBase(fakeEvidenceInput());
const target = runtimeTarget({ targetMinutesMin: 10, targetMinutesMax: 15 });

/**
 * Eight selected units (synthetic dossier):
 * S01 Contracts… C001,C020 · S02 The tavern colleges C002,C017 · S03 The innkeeper's orphans C003,C004 (Jan Testbroek)
 * S04 The auction where nobody came C005,C020 · S05 Buyers who refused to pay C006 (PROBABLE),C007
 * S06 Proefman in court C008,C018 (both PROBABLE; Cornelis Proefman) · S07 The Semper Augustus price C009 (DISPUTED)
 * S08 The ruin that never happened C010 (MYTH),C016
 */
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
  reserve: false,
}));

const verdictOf = (k: string) => evidence.claim(k)?.verdict;
const fakeUnits = (us: readonly SelectedUnit[]) => us.map((u) => ({ key: u.key, claims: u.claimKeys, characters: u.characters.map((c) => ({ name: c.name, kind: c.kind })) }));

/** A rule-abiding architecture of the units (one sequence each, 100 s), changed by `edit`. */
function draft(edit: (o: ArchitectOutput) => void = () => {}, opts: FakeArchitectOptions = {}, us: readonly SelectedUnit[] = units): ArchitectOutput {
  const out = fakeArchitectOutput(fakeUnits(us), verdictOf, { secondsPerSequence: 100, ...opts });
  edit(out);
  return out;
}

const build = (raw: ArchitectOutput, us: readonly SelectedUnit[] = units) => buildArchitecture(raw, evidence, us);
const kinds = (b: BuiltArchitecture) => b.findings.map((f) => f.kind);
const details = (b: BuiltArchitecture, kind: FindingKind) => b.findings.filter((f) => f.kind === kind).map((f) => `${f.sequence ?? '-'}: ${f.detail}`);
const seq = (o: ArchitectOutput, n: number) => o.sequences[n - 1]!;
const beat = (o: ArchitectOutput, n: number, j: number) => seq(o, n).beats[j - 1]!;
const castId = (o: ArchitectOutput, name: string) => o.cast.find((m) => m.name === name)!.id;

function report(built: BuiltArchitecture, extra: Partial<Parameters<typeof computeArchitectureReport>[0]> = {}, us: readonly SelectedUnit[] = units) {
  return computeArchitectureReport({ content: built.content, evidence, units: us, findings: built.findings, issues: [], normalizations: built.notes, target, ...extra });
}
const statusOf = (r: ReturnType<typeof report>, id: string) => r.checks.find((c) => c.id === id)?.status;

const COMPOSITE = { name: 'Pieter Graanhout' };
const speech = (speakerId: string, text: string, kind: 'INVENTED' | 'RECORDED_QUOTE', claimKey: string | null = null) => ({ speakerId, text, kind, claimKey });
type Beat = ArchitectSequence['beats'][number];
const fiction = (description: string, castIds: string[], extra: Partial<Beat> = {}): Beat => ({ function: 'ESCALATION', basis: 'FICTION', description, claimKeys: [], castIds, speech: [], ...extra });

describe('Story Engine 2.0 architecture: a clean blueprint', () => {
  it('derives beat ids, sources, status, confidence and the reconstruction level, and passes the gate', () => {
    const built = build(draft());
    expect(built.findings).toEqual([]);
    const c = built.content;
    expect(c.engineVersion).toBe(2);
    expect(c.sequences).toHaveLength(8);

    const s3 = c.sequences[2]!;
    expect(s3).toMatchObject({ number: 3, candidateIds: ['cand-3'], candidateKeys: ['S03'], claimKeys: ['C003', 'C004'], historicalStatus: 'ESTABLISHED', historicalConfidence: 10 });
    expect(s3.sourceIds.sort()).toEqual(['src-B', 'src-E']);
    expect(s3.beats.map((b) => `${b.id} ${b.basis}`)).toEqual(['3.1 RECONSTRUCTION', '3.2 DOCUMENTED', '3.3 DOCUMENTED', '3.4 DOCUMENTED']);

    // Uncertain history keeps its status, with the instruction its verdict requires.
    expect(c.sequences[4]!.presentation).toEqual([{ claimKey: 'C006', presentation: 'HEDGE', instruction: 'Records suggest this: word it as probable, not certain (test).' }]);
    expect(c.sequences[6]!).toMatchObject({ historicalStatus: 'CONTESTED', presentation: [{ claimKey: 'C009', presentation: 'PRESENT_AS_DISPUTED' }] });
    expect(c.sequences[7]!).toMatchObject({ historicalStatus: 'MYTH_INVESTIGATION', presentation: [{ claimKey: 'C010', presentation: 'INVESTIGATE_AS_MYTH' }] });

    // The viewer's POV is a declared fictional device; real cast is grounded in the selected units.
    expect(c.cast.find((m) => m.id === 'pov')).toMatchObject({ kind: 'POV_PROXY', claimKeys: [] });
    expect(c.cast.find((m) => m.name === 'Jan Testbroek')).toMatchObject({ kind: 'REAL_PERSON', claimKeys: ['C003', 'C004'] });
    expect(c.reconstruction).toEqual({ level: 'MEDIUM', beats: 32, shares: { DOCUMENTED: 0.47, RECONSTRUCTION: 0.25, UNCERTAIN: 0.28, FICTION: 0 } });

    const r = report(built);
    expect(r.passed).toBe(true);
    // Sequence 7 rests on one disputed claim: shaky, so a warning for the editor.
    expect(r.checks.filter((x) => x.status !== 'PASS').map((x) => `${x.id}:${x.status}`)).toEqual(['historical_confidence:WARN']);
  });

  it('round-trips through the reviewers\' shape: beat ids shown, derived fields re-derived', () => {
    const built = build(draft());
    const shown = toArchitectOutput(built.content);
    expect(shown.sequences[0]!.beats[0]).toMatchObject({ id: '1.1' });
    const again = build(ArchitectOutput.parse(shown));
    expect(again.findings).toEqual([]);
    expect(again.content).toEqual(built.content);
  });

  it('supports different narrative modes per sequence, around one main mode', () => {
    const modes = ['HEIST_OPERATION', 'COURTROOM_DISPUTE', 'MYTH_VS_RECORD', 'COUNTDOWN', 'CHARACTER_FOLLOW', 'RISE_AND_FALL', 'INVESTIGATION', 'HISTORICAL_MYSTERY'] as const;
    const built = build(
      draft((o) => {
        o.narrativeMode = 'INVESTIGATION';
        o.secondaryModes = ['MYTH_VS_RECORD', 'INVESTIGATION', 'MYTH_VS_RECORD'];
        o.povStrategy = { type: 'INVESTIGATOR', description: 'The narrator opens the files one by one.' };
        o.sequences.forEach((s, i) => (s.mode = modes[i]!));
      }),
    );
    expect(built.findings).toEqual([]);
    expect(built.content).toMatchObject({ narrativeMode: 'INVESTIGATION', secondaryModes: ['MYTH_VS_RECORD'], povStrategy: { type: 'INVESTIGATOR' } });
    expect(built.content.sequences.map((s) => s.mode)).toEqual([...modes]);
  });
});

describe('Story Engine 2.0 architecture: information classes', () => {
  it('reconstruction: a reconstructed, documented or uncertain beat cites its claims; only fiction may cite none', () => {
    const built = build(draft((o) => (beat(o, 2, 1).claimKeys = [])));
    expect(details(built, 'BEAT_WITHOUT_EVIDENCE')).toEqual(['2: beat 2.1 is RECONSTRUCTION but cites no claim']);
    expect(statusOf(report(built), 'information_classes')).toBe('FAIL');
  });

  it('documented fact rests on ESTABLISHED claims only: a probable, disputed or mythical claim is never presented as fact', () => {
    const built = build(draft(undefined, { allDocumented: true }));
    expect(details(built, 'DOCUMENTED_NOT_ESTABLISHED')).toEqual([
      '5: beat 5.2 is presented as documented fact but rests on C006 (PROBABLE): label it UNCERTAIN with its presentation',
      '5: beat 5.4 is presented as documented fact but rests on C006 (PROBABLE): label it UNCERTAIN with its presentation',
      '6: beat 6.2 is presented as documented fact but rests on C008 (PROBABLE): label it UNCERTAIN with its presentation',
      '6: beat 6.3 is presented as documented fact but rests on C018 (PROBABLE): label it UNCERTAIN with its presentation',
      '6: beat 6.4 is presented as documented fact but rests on C008 (PROBABLE): label it UNCERTAIN with its presentation',
      '7: beat 7.2 is presented as documented fact but rests on C009 (DISPUTED): label it UNCERTAIN with its presentation',
      '7: beat 7.3 is presented as documented fact but rests on C009 (DISPUTED): label it UNCERTAIN with its presentation',
      '7: beat 7.4 is presented as documented fact but rests on C009 (DISPUTED): label it UNCERTAIN with its presentation',
      '8: beat 8.2 is presented as documented fact but rests on C010 (MYTH): label it UNCERTAIN with its presentation',
    ]);
    expect(details(built, 'MYTH_NOT_INVESTIGATED')).toEqual(['8: beat 8.2 uses a MYTH claim outside an UNCERTAIN beat; myths are told as investigations']);
    const r = report(built);
    expect(r.passed).toBe(false);
    expect(statusOf(r, 'information_classes')).toBe('FAIL');
    expect(statusOf(r, 'presentation')).toBe('FAIL');
  });

  it('the reconstruction budget only warns: the editor decides', () => {
    const built = build(
      draft((o) => {
        for (const s of o.sequences) for (const b of s.beats) if (b.basis === 'DOCUMENTED') b.basis = 'RECONSTRUCTION';
        seq(o, 1).beats.push(...Array.from({ length: 12 }, () => fiction('The viewer imagines the crowd (test).', ['pov'])));
      }),
    );
    expect(kinds(built).filter((k) => k === 'RECONSTRUCTION_BUDGET')).toHaveLength(2);
    expect(details(built, 'RECONSTRUCTION_BUDGET')).toEqual(['-: reconstruction and fiction make up 79% of the beats (budget 40%)', '-: fiction makes up 27% of the beats (budget 25%)']);
    expect(built.content.reconstruction.level).toBe('HIGH');
    expect(blockingCount(built.findings)).toBe(0);
    const r = report(built);
    expect(statusOf(r, 'reconstruction_budget')).toBe('WARN');
    expect(r.passed).toBe(true);
  });
});

describe('Story Engine 2.0 architecture: fiction stays labelled and out of the record', () => {
  it('accepts a declared, justified composite who observes and speaks invented lines in a FICTION beat', () => {
    const built = build(draft(undefined, { composite: COMPOSITE }));
    expect(built.findings).toEqual([]);
    const f1 = built.content.cast.find((m) => m.id === 'F1')!;
    expect(f1).toMatchObject({ kind: 'FICTIONAL_COMPOSITE', name: 'Pieter Graanhout', claimKeys: ['C001'] });
    const line = built.content.sequences[0]!.beats.find((b) => b.basis === 'FICTION')!;
    expect(line.speech).toEqual([{ speakerId: 'F1', text: 'Everyone here is buying paper, not flowers.', kind: 'INVENTED', claimKey: null }]);
  });

  it('flags undeclared characters, composites named like real people or without a basis, and fiction in documented beats', () => {
    const built = build(
      draft(
        (o) => {
          beat(o, 2, 2).castIds.push('F9');
          o.cast.push({ id: 'F2', name: 'Cornelis Testbroek', kind: 'FICTIONAL_COMPOSITE', description: 'A buyer.', claimKeys: ['C002'], justification: 'Needed to follow a buyer.' });
          o.cast.push({ id: 'F3', name: 'Grietje Zonderbron', kind: 'FICTIONAL_COMPOSITE', description: 'A seller.', claimKeys: ['C013'], justification: '' });
          beat(o, 3, 2).castIds.push('F1');
          beat(o, 4, 2).castIds.push('pov');
        },
        { composite: COMPOSITE },
      ),
    );
    expect(details(built, 'UNDECLARED_CHARACTER')).toEqual(['2: beat 2.2 uses the cast id "F9", which is not declared in the cast']);
    expect(details(built, 'FICTION_NAME_COLLISION')).toEqual(['-: the fictional composite "Cornelis Testbroek" is named like someone in the dossier; a fictional character needs a name nobody in the record has']);
    expect(details(built, 'COMPOSITE_WITHOUT_BASIS')).toEqual([
      '-: the fictional composite "Grietje Zonderbron" cites no claim establishing that people like them existed',
      '-: the fictional composite "Grietje Zonderbron" does not say why the device is needed',
    ]);
    expect(details(built, 'FICTION_IN_DOCUMENTED_BEAT')).toEqual([
      "3: beat 3.2 is presented as documented fact but involves Pieter Graanhout; fictional characters never take part in a documented action",
      '4: beat 4.2 is presented as documented fact but involves You; fictional characters never take part in a documented action',
    ]);
    // Three composites and a POV: more devices than the limit, which only warns.
    expect(details(built, 'TOO_MANY_FICTIONAL')).toEqual(['-: 1 POV and 3 fictional composites (one POV and up to two composites before a warning)']);
    const r = report(built);
    expect(statusOf(r, 'fiction_labelled')).toBe('FAIL');
    expect(statusOf(r, 'fiction_boundary')).toBe('FAIL');
    expect(statusOf(r, 'fiction_limits')).toBe('WARN');
  });

  it('lets fictional characters observe real people, never speak to, touch or trade with them', () => {
    const observe = build(
      draft(
        (o) => {
          seq(o, 3).beats.push(fiction('Graanhout watches Testbroek from across the room (test).', ['F1', castId(o, 'Jan Testbroek')]));
        },
        { composite: COMPOSITE },
      ),
    );
    expect(observe.findings).toEqual([]);

    const interact = build(
      draft(
        (o) => {
          const jan = castId(o, 'Jan Testbroek');
          seq(o, 3).beats.push(fiction('Graanhout hands Testbroek a purse (test).', ['F1', jan]));
          beat(o, 3, 1).description = 'Testbroek greets you at the door (test).';
        },
        { composite: COMPOSITE },
      ),
    );
    expect(details(interact, 'FICTION_REAL_INTERACTION')).toEqual([
      '3: beat 3.1: a fictional character and a real person interact ("Testbroek greets you at the door (test)."); fictional characters may only observe real people',
      '3: beat 3.5: a fictional character and a real person interact ("Graanhout hands Testbroek a purse (test)."); fictional characters may only observe real people',
    ]);
    expect(statusOf(report(interact), 'fiction_boundary')).toBe('FAIL');
  });

  it('warns when a real person seems to be given an inner life no source records', () => {
    const built = build(draft((o) => (beat(o, 3, 2).description = 'Testbroek fears what the auction will bring (test).')));
    expect(kinds(built)).toEqual(['POSSIBLE_REAL_INTERIORITY']);
    expect(statusOf(report(built), 'real_interiority')).toBe('WARN');
    expect(report(built).passed).toBe(true);
  });
});

describe('Story Engine 2.0 architecture: speech and quotations', () => {
  it('never presents fictional dialogue as a historical quotation', () => {
    const built = build(
      draft(
        (o) => {
          const jan = castId(o, 'Jan Testbroek');
          beat(o, 3, 1).speech.push(speech(jan, 'My children will be rich.', 'INVENTED'));
          beat(o, 3, 2).speech.push(speech('pov', 'What are we buying?', 'INVENTED'));
          seq(o, 1).beats.find((b) => b.basis === 'FICTION')!.speech.push(speech('F1', 'buyers signed contracts for bulbs that were still in the ground', 'RECORDED_QUOTE', 'C001'));
        },
        { composite: COMPOSITE },
      ),
    );
    expect(details(built, 'INVENTED_SPEECH_REAL_PERSON')).toEqual(['3: beat 3.1 gives Jan Testbroek, a real person, an invented line: "My children will be rich."']);
    expect(details(built, 'FICTION_IN_DOCUMENTED_BEAT')).toEqual(['3: beat 3.2 is presented as documented fact but contains an invented line', '3: beat 3.2 is presented as documented fact but involves You; fictional characters never take part in a documented action']);
    expect(details(built, 'FICTIONAL_RECORDED_QUOTE')).toEqual(['1: beat 1.4 gives Pieter Graanhout, a fictional character, a recorded quotation']);
    // The words are verified, but the fiction beat cites no claim: still not a verified quotation of it.
    expect(details(built, 'UNVERIFIED_QUOTE')).toEqual(['1: beat 1.4: "buyers signed contracts for bulbs that were still in the ground" is not a verified quotation of C001 (not cited by the beat)']);
    expect(statusOf(report(built), 'quotations')).toBe('FAIL');
  });

  it('accepts a recorded quotation only when it is a verified quotation of a claim the beat cites', () => {
    const florists = (o: ArchitectOutput) => castId(o, 'florists');
    const verified = build(draft((o) => beat(o, 2, 2).speech.push(speech(florists(o), 'they meet in the inn to trade bulbs they have never seen', 'RECORDED_QUOTE', 'C002'))));
    expect(verified.findings).toEqual([]);
    const elided = build(draft((o) => beat(o, 2, 2).speech.push(speech(florists(o), 'they meet in the inn … bulbs they have never seen', 'RECORDED_QUOTE', 'C002'))));
    expect(elided.findings).toEqual([]);

    const altered = build(draft((o) => beat(o, 2, 2).speech.push(speech(florists(o), 'they meet in the inn to trade tulips worth a fortune', 'RECORDED_QUOTE', 'C002'))));
    expect(details(altered, 'UNVERIFIED_QUOTE')).toEqual(['2: beat 2.2: "they meet in the inn to trade tulips worth a fortune" is not a verified quotation of C002']);
  });

  it('allows quotation marks only around verified words or a planned invented line', () => {
    const built = build(
      draft(
        (o) => {
          beat(o, 2, 2).description = 'A pamphlet says they "meet in the inn to trade bulbs" (test).';
          beat(o, 2, 3).description = 'The town calls them "fools who buy the wind" (test).';
          seq(o, 1).escalation = 'The phrase "everyone here is buying paper" spreads (test).';
        },
        { composite: COMPOSITE },
      ),
    );
    expect(details(built, 'UNVERIFIED_QUOTATION')).toEqual(['2: "fools who buy the wind" is in quotation marks but is neither a verified quotation from the evidence nor a planned invented line']);
  });
});

describe('Story Engine 2.0 architecture: uncertain history keeps its status', () => {
  it('requires a presentation entry for every claim that is not ESTABLISHED', () => {
    const built = build(draft(undefined, { omitPresentation: true }));
    expect(details(built, 'MISSING_PRESENTATION')).toEqual([
      '5: uses C006 (PROBABLE) without saying how the narration must present it (HEDGE)',
      '6: uses C008 (PROBABLE) without saying how the narration must present it (HEDGE)',
      '6: uses C018 (PROBABLE) without saying how the narration must present it (HEDGE)',
      '7: uses C009 (DISPUTED) without saying how the narration must present it (PRESENT_AS_DISPUTED)',
      '8: uses C010 (MYTH) without saying how the narration must present it (INVESTIGATE_AS_MYTH)',
    ]);
    expect(statusOf(report(built), 'presentation')).toBe('FAIL');
  });

  it('requires the presentation the verdict sets: a disputed claim told as a dispute, a myth as an investigation', () => {
    const built = build(
      draft((o) => {
        seq(o, 7).presentation = [{ claimKey: 'C009', presentation: 'HEDGE', instruction: 'Records suggest it was offered.' }];
        seq(o, 8).presentation = [{ claimKey: 'C010', presentation: 'PRESENT_AS_DISPUTED', instruction: 'Some say so.' }];
      }),
    );
    expect(details(built, 'WRONG_PRESENTATION')).toEqual([
      '7: presents C009 (DISPUTED) as HEDGE; a DISPUTED claim needs PRESENT_AS_DISPUTED',
      '8: presents C010 (MYTH) as PRESENT_AS_DISPUTED; a MYTH claim needs INVESTIGATE_AS_MYTH',
    ]);
  });

  it('a PROBABLE claim is hedged in words ("records suggest", "contemporary accounts indicate")', () => {
    const withInstruction = (instruction: string) => build(draft((o) => (seq(o, 5).presentation = [{ claimKey: 'C006', presentation: 'HEDGE', instruction }])));
    expect(withInstruction('Contemporary accounts indicate that many refused to pay.').findings).toEqual([]);
    expect(withInstruction('Records suggest many buyers refused.').findings).toEqual([]);
    for (const weak of ['State that many buyers refused to pay.', 'This claim is probable.']) {
      expect(details(withInstruction(weak), 'WEAK_HEDGE')).toEqual([`5: the instruction for C006 (PROBABLE) must word the hedge, e.g. "records suggest…", "contemporary accounts indicate…" (it says: "${weak}")`]);
    }
  });

  it('tells a myth as an investigation: a MYTH claim belongs in an UNCERTAIN beat', () => {
    const built = build(draft((o) => (beat(o, 8, 2).basis = 'RECONSTRUCTION')));
    expect(details(built, 'MYTH_NOT_INVESTIGATED')).toEqual(['8: beat 8.2 uses a MYTH claim outside an UNCERTAIN beat; myths are told as investigations']);
    expect(statusOf(report(built), 'presentation')).toBe('FAIL');
  });
});

describe('Story Engine 2.0 architecture: the evidence boundary', () => {
  it('rejects claims that are not in the approved dossier, wherever they are cited', () => {
    const built = build(
      draft((o) => {
        beat(o, 1, 2).claimKeys.push('C999');
        seq(o, 2).claimKeys.push('C998');
        o.cast[1]!.claimKeys.push('C997');
      }),
    );
    expect(details(built, 'UNKNOWN_CLAIM')).toEqual([
      '-: the cast member Haarlem buyers cites C997, which is not in the approved dossier',
      '1: beat 1.2 cites C999, which is not in the approved dossier',
      '2: its story evidence cites C998, which is not in the approved dossier',
    ]);
    expect(statusOf(report(built), 'information_classes')).toBe('FAIL');
    // Nothing unknown reaches the stored architecture.
    expect(built.content.sequences.flatMap((s) => [...s.claimKeys, ...s.beats.flatMap((b) => b.claimKeys)]).every((k) => evidence.has(k))).toBe(true);
  });

  it('uses only the selected units\' claims as story evidence; other dossier claims only orient, with a purpose', () => {
    const outside = build(draft(undefined, { outsideCore: 'C013' }));
    expect(details(outside, 'CORE_OUTSIDE_SELECTION')).toEqual(["1: uses C013 as story evidence, but it is not a claim of the selected units (make it a labelled context claim or drop it)"]);
    expect(details(outside, 'BEAT_OUTSIDE_SELECTION')).toEqual(["1: beat 1.3 rests on C013, outside the selected units' claims (background may only orient)"]);
    expect(statusOf(report(outside), 'core_evidence')).toBe('FAIL');

    const context = build(draft(undefined, { contextClaims: [{ claimKey: 'C013', purpose: 'How the pamphlets shaped later accounts' }] }));
    expect(context.findings).toEqual([]);
    const first = context.content.sequences[0]!;
    expect(first.contextClaims).toEqual([{ claimKey: 'C013', purpose: 'How the pamphlets shaped later accounts' }]);
    expect(first.claimKeys).not.toContain('C013');
    expect(first.contextSourceIds.length).toBeGreaterThan(0);

    const misused = build(
      draft(
        (o) => {
          beat(o, 1, 3).claimKeys.push('C013');
          seq(o, 1).contextClaims[0]!.purpose = '';
        },
        { contextClaims: [{ claimKey: 'C013', purpose: 'x' }] },
      ),
    );
    expect(kinds(misused).sort()).toEqual(['BEAT_OUTSIDE_SELECTION', 'CONTEXT_WITHOUT_PURPOSE']);
  });

  it('every sequence tells a selected unit', () => {
    const built = build(draft((o) => (seq(o, 2).candidateKeys = ['S99'])));
    expect(details(built, 'NO_UNIT')).toEqual(['2: tells no selected story unit, so it would be a new story']);
    expect(built.notes).toContain('Sequence 2: S99 is not a selected unit; ignored');
  });

  it('links one claim for a real cast member present in a sequence that cites none of theirs', () => {
    const built = build(
      draft((o) => {
        const jan = o.cast.find((m) => m.name === 'Jan Testbroek')!;
        jan.claimKeys = ['C004'];
        beat(o, 5, 2).castIds.push(jan.id);
      }),
    );
    expect(built.findings).toEqual([]);
    expect(built.content.sequences[4]!.claimKeys).toEqual(['C004', 'C006', 'C007']);
    expect(built.notes).toContain('Sequence 5: linked C004 (evidence for Jan Testbroek)');
  });
});

describe('Story Engine 2.0 architecture: no invented names, places, figures or dates', () => {
  it('rejects figures and dates that are not in the selected units\' evidence, wherever they appear', () => {
    const built = build(
      draft((o) => {
        beat(o, 2, 2).description = 'Buyers pay 7,777 guilders for one bulb (test).';
        beat(o, 2, 1).speech.push(speech('pov', 'That is 4,321 guilders!', 'INVENTED'));
        seq(o, 2).setting.date = { value: '1625', basis: 'RECONSTRUCTION' };
        o.logline = 'Twelve thousand people and 12,000 tulips (test).';
      }),
    );
    expect(details(built, 'UNSUPPORTED_FIGURE')).toEqual([
      "-: the documentary's framing (logline, thesis, cast) uses the figure 12000, which is not in the evidence it rests on",
      "2: uses the figure 4321, which is not in the selected units' evidence",
      "2: uses the figure 7777, which is not in the selected units' evidence",
      "2: uses the figure 1625, which is not in the selected units' evidence",
    ]);
    expect(statusOf(report(built), 'supported_figures')).toBe('FAIL');
  });

  it('links a figure found in another selected unit\'s claim, and then requires that claim\'s presentation', () => {
    const built = build(
      draft((o) => {
        beat(o, 1, 2).description = 'Elsewhere a whole estate sells for 90,000 guilders (test).';
        seq(o, 1).visual.mustShow.push({ detail: 'a price list showing 5,500 guilders', claimKeys: ['C001'] });
      }),
    );
    expect(built.notes).toEqual(expect.arrayContaining(['Sequence 1: linked C003 (source of the figure 90000)', 'Sequence 1: linked C009 (source of the figure 5500)']));
    expect(built.content.sequences[0]!.claimKeys).toEqual(['C001', 'C003', 'C009', 'C020']);
    expect(details(built, 'MISSING_PRESENTATION')).toEqual([
      '1: uses C009 (DISPUTED) without saying how the narration must present it (PRESENT_AS_DISPUTED) (the evidence rules linked it for the figure 5500: add the instruction, or drop the figure 5500)',
    ]);
  });

  it('rejects invented and outside people, and names or places nobody in the evidence has', () => {
    // Without S08 (whose myth claim quotes Mackay), Mackay is outside the selected units' evidence.
    const seven = units.slice(0, 7);
    const built = build(
      draft(
        (o) => {
          o.cast.push({ id: 'R90', name: 'Hendrik Fakename', kind: 'REAL_PERSON', description: 'A trader.', claimKeys: ['C001'], justification: '' });
          o.cast.push({ id: 'R91', name: 'Charles Mackay', kind: 'REAL_PERSON', description: 'An author.', claimKeys: ['C009'], justification: '' });
          o.cast.push({ id: 'R92', name: 'the town guards', kind: 'REAL_GROUP', description: 'Guards.', claimKeys: [], justification: '' });
          beat(o, 1, 2).castIds.push('R90');
          beat(o, 4, 2).description = 'Willem Fakerson arrives at the inn as the bidding fails (test).';
          seq(o, 7).reveal = 'As Mackay later wrote, the price was a moral tale (test).';
        },
        {},
        seven,
      ),
      seven,
    );
    expect(details(built, 'UNGROUNDED_PERSON')).toEqual(['-: "Hendrik Fakename" is not in the selected units or their evidence']);
    expect(details(built, 'PERSON_OUTSIDE_SELECTION')).toEqual([
      "-: the cast lists Charles Mackay, who appears in the dossier but not in the selected units' evidence",
      "7: mentions Charles Mackay, who appears in the dossier but not in the selected units' evidence",
    ]);
    expect(details(built, 'CAST_WITHOUT_EVIDENCE')).toEqual(['-: the group "the town guards" is not grounded in the selected units\' claims']);
    expect(details(built, 'UNKNOWN_NAME')).toEqual(['4: names "Fakerson", which is neither in the evidence nor a declared cast member (an invented person or place?)']);
    // Dropped cast never reaches the architecture.
    expect(built.content.cast.map((m) => m.name)).not.toEqual(expect.arrayContaining(['Hendrik Fakename']));
    expect(built.content.sequences[0]!.castIds).not.toContain('R90');
    expect(statusOf(report(built, {}, seven), 'grounded_people')).toBe('FAIL');
    expect(statusOf(report(built, {}, seven), 'fiction_labelled')).toBe('FAIL');
  });

  it('keeps setting and visual details honest: documented places and times are in the evidence', () => {
    const built = build(
      draft((o) => {
        seq(o, 1).setting.location = { value: 'Haarlem', basis: 'DOCUMENTED' };
        seq(o, 2).setting.location = { value: 'Amsterdam', basis: 'DOCUMENTED' };
        seq(o, 3).setting.timeOfDay = { value: 'midnight', basis: 'DOCUMENTED' };
        seq(o, 4).visual.mustShow.push({ detail: 'a ledger of debts', claimKeys: [] });
      }),
    );
    expect(details(built, 'SETTING_NOT_IN_EVIDENCE')).toEqual([
      '2: the location "Amsterdam" is presented as documented, but Amsterdam is not in this sequence\'s evidence: mark it RECONSTRUCTION or cite the claim',
      '3: the time of day "midnight" is presented as documented, but the evidence does not give it: mark it RECONSTRUCTION',
    ]);
    expect(details(built, 'UNKNOWN_NAME')).toEqual(['2: names "Amsterdam", which is neither in the evidence nor a declared cast member (an invented person or place?)']);
    expect(details(built, 'VISUAL_DETAIL_WITHOUT_EVIDENCE')).toEqual(['4: the detail "a ledger of debts" must appear on screen but cites no claim of this sequence']);
    expect(statusOf(report(built), 'setting_and_visuals')).toBe('FAIL');
  });
});

describe('Story Engine 2.0 architecture: continuity and the editor', () => {
  it('requires the central question (Q0) to be answered; other threads only warn', () => {
    const built = build(draft((o) => (seq(o, 8).continuity.resolves = seq(o, 8).continuity.resolves.filter((r) => r !== 'Q0'))));
    expect(details(built, 'CENTRAL_QUESTION_UNANSWERED')).toEqual(['-: no sequence resolves the central question (Q0)']);
    expect(statusOf(report(built), 'central_question_answered')).toBe('FAIL');
  });

  it('tracks objects, questions, time and transitions from sequence to sequence', () => {
    const built = build(
      draft((o) => {
        seq(o, 3).continuity.carriesIn.push('the sealed letter');
        seq(o, 2).continuity.opens.push({ id: 'Q9', question: 'Who wrote it?' });
        seq(o, 5).continuity.resolves.push('Q77');
        seq(o, 1).setting.date = { value: 'January 1637', basis: 'RECONSTRUCTION' };
        seq(o, 4).setting.date = { value: 'November 1636', basis: 'RECONSTRUCTION' };
        seq(o, 6).transition = '';
      }),
    );
    expect(built.findings.map((f) => `${f.kind} ${f.sequence}`)).toEqual(['CONTINUITY_BREAK 3', 'CHRONOLOGY_UNMARKED 4', 'UNKNOWN_THREAD 5', 'UNRESOLVED_THREAD 2', 'MISSING_TRANSITION 6']);
    expect(blockingCount(built.findings)).toBe(0);
    const r = report(built);
    expect(statusOf(r, 'continuity')).toBe('WARN');
    expect(r.passed).toBe(true);

    // A marked flashback is fine.
    const flashback = build(
      draft((o) => {
        seq(o, 1).setting.date = { value: 'January 1637', basis: 'RECONSTRUCTION' };
        seq(o, 4).setting.date = { value: 'November 1636', basis: 'RECONSTRUCTION' };
        seq(o, 4).continuity.timeJump = 'FLASHBACK';
      }),
    );
    expect(flashback.findings).toEqual([]);
  });

  it('uses every HIGH-priority unit and explains the units it leaves out', () => {
    const high = units.map((u) => (u.key === 'S08' ? { ...u, priority: 'HIGH' as const } : u));
    const unused = build(draft(undefined, { useUnits: 7 }, high), high);
    expect(details(unused, 'HIGH_PRIORITY_UNUSED')).toEqual(['-: S08 "The ruin that never happened" is HIGH priority but no sequence uses it']);
    expect(statusOf(report(unused, {}, high), 'editor_priorities')).toBe('FAIL');

    const dropped = build(draft(undefined, { useUnits: 7 }));
    expect(details(dropped, 'UNUSED_WITHOUT_REASON')).toEqual(['-: S08 "The ruin that never happened" is not used and no reason is given']);
    const explained = build(draft((o) => (o.unusedCandidates = [{ candidateKey: 'S08', reason: 'The myth is told in sequence 7 instead.' }]), { useUnits: 7 }));
    expect(explained.findings).toEqual([]);
    expect(explained.content.unusedCandidates).toEqual([{ candidateKey: 'S08', reason: 'The myth is told in sequence 7 instead.' }]);
  });

  it('keeps the editor\'s order of the selection, or says why not', () => {
    const ordered = units.map((u, i) => ({ ...u, selectionOrder: i === 0 ? 2 : i === 1 ? 1 : i + 1 }));
    const changed = build(draft(undefined, {}, ordered), ordered);
    expect(details(changed, 'ORDER_CHANGED_WITHOUT_REASON')).toEqual(["-: the units appear as S01, S02, S03, S04, S05, S06, S07, S08; the editor's order is S02, S01, S03, S04, S05, S06, S07, S08"]);
    expect(statusOf(report(changed, {}, ordered), 'editor_order')).toBe('WARN');
    const explained = build(draft((o) => (o.orderNote = 'The contracts must be understood before the colleges.'), {}, ordered), ordered);
    expect(explained.findings).toEqual([]);
  });
});

describe('Story Engine 2.0 architecture gate', () => {
  const verdict = (pass: boolean): StoryEditorVerdict => ({
    scores: { immersion: 6, humanStakes: 5 },
    qualityBar: { storyWithoutCitations: { pass, why: 'Test.' }, compellingDocumentary: { pass: true, why: 'Test.' }, truthAndExperience: { pass: true, why: 'Test.' } },
  });

  it('records the story editor\'s verdict without ever failing on it: the human decides', () => {
    const built = build(draft());
    const failing = report(built, { storyEditor: verdict(false) });
    expect(statusOf(failing, 'story_review')).toBe('WARN');
    expect(failing.passed).toBe(true);
    expect(statusOf(report(built, { storyEditor: verdict(true) }), 'story_review')).toBe('PASS');
    expect(statusOf(report(built, { storyEditor: { unavailable: 'refused (test)' } }), 'story_review')).toBe('WARN');
  });

  it('fails on an open CRITICAL fact issue, and passes once it is fixed', () => {
    const built = build(draft());
    const issue = { severity: 'CRITICAL' as const, description: 'A disputed price told as fact.', claimKeys: ['C009'], resolution: 'Left for human review' };
    expect(statusOf(report(built, { issues: [issue] }), 'review')).toBe('FAIL');
    expect(report(built, { issues: [{ ...issue, resolution: 'Fixed in the revised architecture' }] }).passed).toBe(true);
  });

  it('fails a runtime far from the target and a structure without scenes', () => {
    const short = build(draft(undefined, { secondsPerSequence: 30 }));
    expect(statusOf(report(short), 'runtime')).toBe('FAIL');
    const flat = build(
      draft((o) => {
        for (const s of o.sequences) s.beats = s.beats.map((b) => ({ ...b, function: 'ORIENTATION' }));
      }),
    );
    expect(statusOf(report(flat), 'story_structure')).toBe('FAIL');
  });
});
