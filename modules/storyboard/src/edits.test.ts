import { VersionChanges } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { draftOf, type StoryboardDraft } from './draft.ts';
import { applyEdits, carriedDecisions, EditError, sameDuration, versionChanges, type DecidedShot } from './edits.ts';
import { planStoryboard } from './plan.ts';
import { buildSpine } from './spine.ts';
import { domainFilm, sketchDraft, subject, syntheticSpine, type BeatSketch } from './testing.ts';

/**
 * A person's edits make a new version (§2.12): every op on its own, refused
 * with the reason when it names something that is not there; the base
 * draft untouched; decisions carried only to shots whose content and length
 * did not change; the changes from the base listed field by field.
 */

const { facts, script } = domainFilm('history');
const MIRA = subject('CS01', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' });
const HARBOUR = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
const BEATS: BeatSketch[] = [
  { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.1:end', treatment: 'TEXT_ON_SCREEN' }, { to: '1.2:9', claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }, { claims: [{ claimKey: 'H1', role: 'CONTEXT' }] }] },
  { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ subjects: [{ subjectKey: 'CS01', detail: { role: 'PRIMARY', action: 'runs', interactions: [], likeness: 'PERIOD_GENERIC', speaks: null } }], claims: [{ claimKey: 'H5', role: 'CONTEXT' }] }] },
  { to: '⟨end⟩', treatment: 'ENVIRONMENT', shots: [{ to: '2.1:end', spec: { environment: { subjectKey: 'CS02', description: 'The harbour (test).' } } }, {}] },
];
const base = () => sketchDraft(facts, BEATS, { subjects: [MIRA, HARBOUR] });
const edit = (ops: Parameters<typeof applyEdits>[1], draft: StoryboardDraft = base()) => applyEdits(draft, ops, facts);
const refuse = (ops: Parameters<typeof applyEdits>[1], message: RegExp) => expect(() => edit(ops)).toThrow(message);

describe('each edit, on its own', () => {
  it('leaves the base draft as it was', () => {
    const draft = base();
    const before = structuredClone(draft);
    edit([{ op: 'updateShot', shotKey: 'SH002', patch: { description: 'The harbour burns (edited).' } }, { op: 'splitShot', shotKey: 'SH004', at: '1.3:9' }, { op: 'mergeShots', shotKeys: ['SH005', 'SH006'] }], draft);
    expect(draft).toEqual(before);
  });

  it('updateShot: any spec field, subjects and claims (checked), a class that only lowers, automatic labels recomputed', () => {
    const { draft } = edit([{ op: 'updateShot', shotKey: 'SH002', patch: { description: 'Flames over the warehouse roofs (edited).', infoClass: 'UNCERTAIN', overlays: [{ kind: 'RECONSTRUCTION_LABEL', text: 'x', reason: 'y', claimKeys: [], auto: true }] } }]);
    const s = draft.shots.find((x) => x.key === 'SH002')!;
    expect(s).toMatchObject({ proposedClass: 'UNCERTAIN', spec: { description: 'Flames over the warehouse roofs (edited).', overlays: [] } });
    const p = planStoryboard(draft, facts);
    expect(p.shots.find((x) => x.key === 'SH002')!.infoClass).toBe('UNCERTAIN');
    refuse([{ op: 'updateShot', shotKey: 'SH009', patch: { description: 'x' } }], /There is no shot SH009/);
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { claims: [{ claimKey: 'Z1', role: 'CONTEXT' }] } }], /Z1 is not a claim of the approved evidence/);
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { claims: [{ claimKey: 'H3', role: 'DEPICTS' }] } }], /H3 cannot be DEPICTS for SH002: it is not a claim of the narration the shot covers/);
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { subjects: [{ subjectKey: 'CS09', detail: { role: 'PRIMARY', action: '', interactions: [], likeness: 'NONE', speaks: null } }] } }], /There is no continuity subject CS09/);
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { method: 'ARCHIVAL_SOURCING' } }], /ARCHIVAL_SOURCING cannot make CINEMATIC_RECONSTRUCTION/);
    // A detail on a claim names it: a claim basis with no claim would pass for grounded and make the shot look documented.
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { specifics: [{ detail: 'Red uniforms', kind: 'UNIFORM', basis: 'CLAIM', claimKeys: [] }] } }], /"Red uniforms" rests on a claim: name it, or mark the detail period-generic or invented/);
    refuse([{ op: 'updateShot', shotKey: 'SH002', patch: { objects: [{ name: 'A ledger', basis: 'CLAIM', claimKeys: [] }] } }], /"A ledger" rests on a claim/);
  });

  it('setTreatment: re-routed and re-checked; a chosen provider that cannot make it is cleared (noted)', () => {
    const chosen = edit([{ op: 'setRecommendation', shotKey: 'SH002', provider: 'acme-video', model: 'acme-motion-1' }]).draft;
    const { draft, notes } = edit([{ op: 'setTreatment', shotKey: 'SH002', treatment: 'GENERATED_STILL' }], chosen);
    expect(draft.shots[1]).toMatchObject({ treatment: 'GENERATED_STILL', method: null, recommendation: null });
    expect(notes).toEqual(['SH002: the chosen acme-video acme-motion-1 cannot make GENERATED_STILL; the recommendation was cleared']);
    expect(planStoryboard(draft, facts).shots[1]!.method).toBe('GENERATIVE_IMAGE');
    refuse([{ op: 'setTreatment', shotKey: 'SH002', treatment: 'ARCHIVAL_IMAGE', method: 'GENERATIVE_IMAGE' }], /GENERATIVE_IMAGE cannot make ARCHIVAL_IMAGE/);
  });

  it('moveCut: next shots only; across a beat boundary it moves the beats too; a nudge within the limits', () => {
    const inside = edit([{ op: 'moveCut', leftShotKey: 'SH002', rightShotKey: 'SH003', to: '1.2:2' }]).draft;
    expect(inside.shots.slice(1, 3).map((s) => `${s.narration!.from}–${s.narration!.to}`)).toEqual(['1.1:end–1.2:2', '1.2:2–1.2:end']);
    expect(inside.shots[2]!.cutIn).toBe('CLAUSE');
    const across = edit([{ op: 'moveCut', leftShotKey: 'SH003', rightShotKey: 'SH004', to: '1.3:9', offsetMs: -200 }]).draft;
    expect(across.beats.map((b) => `${b.narration.from}–${b.narration.to}`)).toEqual(['⟨start⟩–1.3:9', '1.3:9–1.3:end', '1.3:end–⟨end⟩']);
    const p = planStoryboard(across, facts);
    expect(p.shots.find((s) => s.key === 'SH004')!.startMs).toBe(facts.spine.point('1.3:9')!.atMs - 200);
    refuse([{ op: 'moveCut', leftShotKey: 'SH002', rightShotKey: 'SH004', to: '1.2:end' }], /SH002 and SH004 are not next to each other/);
    refuse([{ op: 'moveCut', leftShotKey: 'SH002', rightShotKey: 'SH003', to: '1.3:9' }], /1\.3:9 is not between the start of SH002 and the end of SH003/);
    refuse([{ op: 'moveCut', leftShotKey: 'SH001', rightShotKey: 'SH002', to: '1.1:end', offsetMs: -1900 }], /The cut cannot move by -1900 ms: the shots beside it keep their minimum length/);
  });

  it('splitShot: the second half gets the next free key (never one an earlier version used) and a copy of the content', () => {
    const split = applyEdits(base(), [{ op: 'splitShot', shotKey: 'SH004', at: '1.3:9' }], facts, { usedShotKeys: ['SH011'] }).draft;
    const halves = split.shots.filter((s) => s.beatKey === 'VB02');
    expect(halves.map((s) => `${s.key} ${s.narration!.from}–${s.narration!.to} ${s.cutIn}/${s.cutOut}`)).toEqual(['SH004 1.2:end–1.3:9 BEAT_CHANGE/CLAUSE', 'SH012 1.3:9–1.3:end CLAUSE/BEAT_CHANGE']);
    expect(halves[1]!.subjects).toEqual(halves[0]!.subjects);
    refuse([{ op: 'splitShot', shotKey: 'SH004', at: '1.2:9' }], /1\.2:9 is not inside SH004's words/);
  });

  it('mergeShots: next shots of one beat; the first keeps its content and gains the second\'s claims and subjects', () => {
    const { draft } = edit([{ op: 'mergeShots', shotKeys: ['SH002', 'SH003'] }]);
    expect(draft.shots.map((s) => s.key)).toEqual(['SH001', 'SH002', 'SH004', 'SH005', 'SH006']);
    expect(draft.shots[1]).toMatchObject({ narration: { from: '1.1:end', to: '1.2:end' }, claims: [{ claimKey: 'H1', role: 'DEPICTS' }, { claimKey: 'H1', role: 'CONTEXT' }] });
    refuse([{ op: 'mergeShots', shotKeys: ['SH003', 'SH004'] }], /SH003 and SH004 are in different beats/);
    refuse([{ op: 'mergeShots', shotKeys: ['SH003', 'SH002'] }], /SH003 is not right before SH002/);
  });

  it('reorderShots: content moves between the beat\'s slots, the narration stays — and the rules judge the new places', () => {
    const { draft } = edit([{ op: 'reorderShots', beatKey: 'VB01', order: ['SH003', 'SH001', 'SH002'] }]);
    const v1 = draft.shots.filter((s) => s.beatKey === 'VB01');
    expect(v1.map((s) => `${s.key} ${s.narration!.from}–${s.narration!.to} ${s.treatment}`)).toEqual(['SH003 ⟨start⟩–1.1:end CINEMATIC_RECONSTRUCTION', 'SH001 1.1:end–1.2:9 TEXT_ON_SCREEN', 'SH002 1.2:9–1.2:end CINEMATIC_RECONSTRUCTION']);
    // The shot that showed the fire as context now sits over the framing question: its class is judged again.
    const before = planStoryboard(base(), facts).shots.find((s) => s.key === 'SH003')!;
    const after = planStoryboard(draft, facts).shots.find((s) => s.key === 'SH003')!;
    expect([before.infoClass, after.infoClass]).toEqual(['DOCUMENTED', 'FRAMING']);
    expect(after.contentHash).not.toBe(before.contentHash);
    refuse([{ op: 'reorderShots', beatKey: 'VB01', order: ['SH003', 'SH001'] }], /The order must list each shot of VB01 once/);
  });

  it('updateBeat, setRecommendation, clearRecommendation, updateContinuity and setProfile', () => {
    const { draft, notes } = edit([
      { op: 'updateBeat', beatKey: 'VB01', patch: { title: 'The fire (edited)', continuityNotes: ['Smoke stays on screen'] } },
      { op: 'setRecommendation', shotKey: 'SH005', provider: 'nowhere', model: 'm1' },
      { op: 'updateContinuity', subjectKey: 'CS02', patch: { designDetails: [{ detail: 'stone quays', basis: 'CLAIM', claimKeys: ['H3'] }] } },
      { op: 'setProfile', selectionRevision: 4 },
    ]);
    expect(draft.beats[0]!.content).toMatchObject({ title: 'The fire (edited)', continuity: { notes: ['Smoke stays on screen'] } });
    expect(draft.shots[4]!.recommendation).toEqual({ provider: 'nowhere', model: 'm1' });
    expect(draft.subjects[1]!.spec.designDetails).toEqual([{ detail: 'stone quays', basis: 'CLAIM', claimKeys: ['H3'] }]);
    expect(notes).toEqual(['SH005: nowhere is not in the visual catalog; its estimate is unpriced', 'The visual profile was changed (selection revision 4): shots re-costed, their content unchanged']);
    expect(planStoryboard(draft, facts).shots[4]!.cost).toMatchObject({ source: 'USER', basis: 'UNPRICED' });
    expect(edit([{ op: 'clearRecommendation', shotKey: 'SH005' }], draft).draft.shots[4]!.recommendation).toBeNull();
    refuse([{ op: 'updateContinuity', subjectKey: 'CS02', patch: { designDetails: [{ detail: 'x', basis: 'CLAIM', claimKeys: ['Z1'] }] } }], /Z1 is not a claim/);
    refuse([{ op: 'updateContinuity', subjectKey: 'CS02', patch: { designDetails: [{ detail: 'stone quays', basis: 'CLAIM', claimKeys: [] }] } }], /"stone quays" rests on a claim: name it/);
    // Its basis follows its details: documented while every one rests on a claim, a reconstruction once one is invented.
    expect(draft.subjects[1]!.spec.basis).toBe('DOCUMENTED');
    const invented = edit([{ op: 'updateContinuity', subjectKey: 'CS02', patch: { designDetails: [{ detail: 'stone quays', basis: 'CLAIM', claimKeys: ['H3'] }, { detail: 'red cranes', basis: 'INVENTED', claimKeys: [] }] } }], draft).draft;
    expect(invented.subjects[1]!.spec.basis).toBe('RECONSTRUCTION');
    expect(planStoryboard(invented, facts).subjects[1]!.infoClass).toBe('RECONSTRUCTION');
  });

  it('applyAlternative: applies one of the version\'s cheaper alternatives, by id; nothing else', () => {
    const planned = planStoryboard(base(), facts);
    const alt = planned.alternatives.find((a) => a.to.method === 'STILL_MOTION' && a.to.treatment === 'CINEMATIC_RECONSTRUCTION')!;
    const { draft, notes } = applyEdits(base(), [{ op: 'applyAlternative', alternativeId: alt.id }], facts, { alternatives: planned.alternatives });
    expect(draft.shots.filter((s) => alt.shotKeys.includes(s.key)).every((s) => s.method === 'STILL_MOTION')).toBe(true);
    expect(notes).toEqual([`Applied "${alt.title}" to ${alt.shotKeys.join(', ')}`]);
    refuse([{ op: 'applyAlternative', alternativeId: 'alt-sc09-0000000000' }], /does not apply to this version/);
  });
});

describe('content hashes and carried decisions', () => {
  it('hashes content, not times, ids or costs: a re-timed version keeps every hash; an edit changes only its shot\'s', () => {
    const p1 = planStoryboard(base(), facts);
    const slower = { ...facts, spine: buildSpine(syntheticSpine(script, { msPerWord: 470 }), script) };
    const retimed = planStoryboard(draftOf(p1), slower);
    expect(retimed.shots.map((s) => s.contentHash)).toEqual(p1.shots.map((s) => s.contentHash));
    expect(retimed.shots[1]!.endMs).not.toBe(p1.shots[1]!.endMs);
    const edited = planStoryboard(edit([{ op: 'updateShot', shotKey: 'SH002', patch: { mood: 'Dread (edited)' } }], draftOf(p1)).draft, facts);
    expect(edited.shots.map((s, i) => s.contentHash === p1.shots[i]!.contentHash)).toEqual([true, false, true, true, true, true]);
    const recosted = planStoryboard(edit([{ op: 'setRecommendation', shotKey: 'SH002', provider: 'acme-clips', model: 'acme-clip-2' }], draftOf(p1)).draft, facts);
    expect(recosted.shots[1]!.contentHash).toBe(p1.shots[1]!.contentHash);
  });

  it('carries a decision to a shot with the same key and content and a length within 10% or 300 ms — never a cleared one', () => {
    const p1 = planStoryboard(base(), facts);
    const decided: DecidedShot[] = p1.shots.map((s, i) => ({ shotKey: s.key, contentHash: s.contentHash, durationMs: s.endMs! - s.startMs!, latest: i === 3 ? { id: 'd-clear', decision: 'CLEARED' } : { id: `d-${s.key}`, decision: i === 4 ? 'REJECTED' : 'APPROVED' } }));
    const p2 = planStoryboard(edit([{ op: 'updateShot', shotKey: 'SH002', patch: { mood: 'Dread (edited)' } }], draftOf(p1)).draft, facts);
    const carried = carriedDecisions(decided, p2.shots.map((s) => ({ shotKey: s.key, contentHash: s.contentHash, durationMs: s.endMs! - s.startMs! })));
    expect(carried.map((c) => `${c.shotKey} ${c.decision} ${c.fromDecisionId}`)).toEqual(['SH001 APPROVED d-SH001', 'SH003 APPROVED d-SH003', 'SH005 REJECTED d-SH005', 'SH006 APPROVED d-SH006']);
    // Re-timed much slower: the same content, but a length nobody saw — nothing carries.
    const slower = { ...facts, spine: buildSpine(syntheticSpine(script, { msPerWord: 700 }), script) };
    const p3 = planStoryboard(draftOf(p1), slower);
    expect(carriedDecisions(decided, p3.shots.map((s) => ({ shotKey: s.key, contentHash: s.contentHash, durationMs: s.endMs! - s.startMs! })))).toEqual([]);
    expect([sameDuration(10_000, 10_900), sameDuration(10_000, 11_100), sameDuration(1000, 1300), sameDuration(1000, 1301), sameDuration(null, 5)]).toEqual([true, false, true, false, false]);
  });
});

describe('what changed from the base version', () => {
  it('lists shots and beats added, removed and changed, with the fields that differ', () => {
    const p1 = planStoryboard(base(), facts);
    const { draft } = edit([
      { op: 'updateShot', shotKey: 'SH002', patch: { mood: 'Dread (edited)' } },
      { op: 'splitShot', shotKey: 'SH004', at: '1.3:9' },
      { op: 'mergeShots', shotKeys: ['SH005', 'SH006'] },
      { op: 'updateBeat', beatKey: 'VB03', patch: { concept: 'The harbour after (edited).' } },
    ], draftOf(p1));
    const p2 = planStoryboard(draft, facts);
    const changes = VersionChanges.parse(versionChanges(1, p1, p2));
    expect(changes.shots.added).toEqual(['SH007']);
    expect(changes.shots.removed).toEqual(['SH006']);
    expect(changes.shots.changed).toEqual([
      { shotKey: 'SH002', fields: ['mood'] },
      { shotKey: 'SH004', fields: expect.arrayContaining(['narration', 'times', 'cost']) },
      { shotKey: 'SH005', fields: expect.arrayContaining(['narration', 'times']) },
    ]);
    expect(changes.beats).toEqual({ added: [], removed: [], changed: [{ beatKey: 'VB03', fields: ['concept'] }] });
  });
});

describe('a planned version and its draft', () => {
  it('round-trips: the draft of a planned version plans to the same version', () => {
    const p1 = planStoryboard(base(), facts);
    const again = planStoryboard(draftOf(p1), facts);
    expect(again.shots.map((s) => [s.key, s.contentHash, s.startMs, s.endMs, s.cost?.totalUsd])).toEqual(p1.shots.map((s) => [s.key, s.contentHash, s.startMs, s.endMs, s.cost?.totalUsd]));
    expect(again.beats.map((b) => b.contentHash)).toEqual(p1.beats.map((b) => b.contentHash));
    expect(again.qa).toEqual(p1.qa);
    expect(() => applyEdits(base(), [{ op: 'moveCut', leftShotKey: 'SH004', rightShotKey: 'SH005', to: '1.2:end' }], facts)).toThrow(EditError);
  });
});
