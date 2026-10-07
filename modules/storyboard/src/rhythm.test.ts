import { syntheticDraft, syntheticScope, type SyntheticSpec } from '@docengine/script/testing';
import type { StoryboardFindingKind, VisualStyleProfileConfig } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import type { PlannedStoryboard } from './draft.ts';
import { planStoryboard } from './plan.ts';
import { domainFilm, profileSnapshot, sketchDraft, subject, syntheticFacts, withRowIds, type BeatSketch, type FactsOptions } from './testing.ts';

/**
 * Visual rhythm (§13): every warning kind, each on the smallest plan that
 * shows it, and the measured stats. A storm told in short sentences gives
 * quick cuts; the history film on a slow clock gives long holds.
 */

const STORM: SyntheticSpec = {
  question: 'What happened in the storm?',
  claims: [{ key: 'S1', statement: 'A storm struck the harbour in 1802.' }],
  sequences: [{ title: 'The storm', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['S1'] }] }],
};
const stormFacts = (o: FactsOptions = {}) => {
  const scope = syntheticScope(STORM);
  const script = withRowIds(syntheticDraft(scope, [[{ text: 'The bell rang. The men ran. The ropes burned. The boats drifted. The smoke rose. The night ended.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'] }]]));
  return syntheticFacts(scope, script, o);
};
const SENTENCES = ['1.1:3', '1.1:6', '1.1:9', '1.1:12', '1.1:15'];

const warned = (p: PlannedStoryboard, kind: StoryboardFindingKind) => p.qa.filter((f) => f.kind === kind && f.severity === 'WARNING');
const profile = (o: Partial<VisualStyleProfileConfig>) => profileSnapshot(o);
const plan = (facts: ReturnType<typeof stormFacts>, beats: BeatSketch[]) => planStoryboard(sketchDraft(facts, beats), facts);
const perSentence = (o: Partial<BeatSketch> = {}): BeatSketch => ({ to: '⟨end⟩', shots: [...SENTENCES.map((to) => ({ to })), {}], ...o });

describe('quick cuts (a storm in short sentences)', () => {
  it('RAPID_CUTS and UNIFORM_DURATIONS: six equal sub-1.5 s shots; a reveal breaks the run', () => {
    const facts = stormFacts();
    const p = plan(facts, [perSentence()]);
    expect(p.rhythm.shots).toBe(6);
    expect(p.rhythm.maxShotMs).toBeLessThan(1500);
    expect(warned(p, 'RAPID_CUTS').map((f) => f.detail)).toEqual(['6 shots under 1.5 s in a row (SH001–SH006) with no reveal, impact or pause']);
    expect(warned(p, 'UNIFORM_DURATIONS').map((f) => f.ref)).toEqual(['SH001']);
    const revealed = plan(facts, [{ to: '⟨end⟩', shots: [...SENTENCES.map((to, i) => ({ to, ...(i === 2 ? { cutIn: 'REVEAL' as const } : {}) })), {}] }]);
    expect(warned(revealed, 'RAPID_CUTS').map((f) => f.detail)).toEqual(['3 shots under 1.5 s in a row (SH004–SH006) with no reveal, impact or pause']);
  });

  it('DENSITY_HIGH and SHOT_COUNT_HIGH against the profile\'s density targets', () => {
    const sparse = plan(stormFacts({ profile: profile({ density: 'SPARSE' }) }), [perSentence()]);
    expect(warned(sparse, 'DENSITY_HIGH').map((f) => f.detail)).toEqual([expect.stringMatching(/^Shots average 1\.\d s; sparse density aims for 6–12 s$/)]);
    expect(warned(sparse, 'SHOT_COUNT_HIGH').map((f) => f.detail)).toEqual([expect.stringMatching(/^\d+(\.\d+)? cuts a minute; sparse density allows 9$/)]);
    const dense = plan(stormFacts({ profile: profile({ density: 'DENSE' }) }), [perSentence()]);
    expect(warned(dense, 'SHOT_COUNT_HIGH').map((f) => f.detail)).toEqual([expect.stringMatching(/dense density allows 22$/)]);
    // Two shots over the whole storm: within a dense film's cuts a minute.
    expect(warned(plan(stormFacts({ profile: profile({ density: 'DENSE' }) }), [{ to: '⟨end⟩', shots: [{ to: '1.1:9' }, {}] }]), 'SHOT_COUNT_HIGH')).toEqual([]);
  });

  it('TREATMENT_REPETITION and TREATMENT_DOMINANT: one treatment for more than four shots and over half the runtime', () => {
    const facts = stormFacts();
    const same = plan(facts, [perSentence()]);
    expect(warned(same, 'TREATMENT_REPETITION').map((f) => f.detail)).toEqual(['6 shots in a row are ENVIRONMENT (SH001–SH006): vary the picture']);
    expect(warned(same, 'TREATMENT_DOMINANT').map((f) => f.detail)).toEqual(['ENVIRONMENT covers 100% of the runtime']);
    const varied = plan(facts, [{ to: '⟨end⟩', shots: [...SENTENCES.map((to, i) => ({ to, treatment: i % 2 ? ('PRODUCT_OBJECT' as const) : ('ENVIRONMENT' as const) })), { treatment: 'MOTION_GRAPHIC' as const }] }]);
    expect(warned(varied, 'TREATMENT_REPETITION')).toEqual([]);
    expect(warned(varied, 'TREATMENT_DOMINANT')).toEqual([]);
    expect(varied.rhythm.treatmentChanges).toBe(5);
  });
});

describe('long holds (the history film, slowed)', () => {
  const slow = (o: FactsOptions = {}) => domainFilm('history', { msPerWord: 1700, ...o }).facts;

  it('STATIC_LONG, NO_VISUAL_CHANGE and SHOT_COUNT_LOW for one held still; a camera move is not static', () => {
    const facts = slow({ profile: profile({ density: 'SPARSE' }) });
    // 1.2 is 15 words (about 25 s), held on one still.
    const p = plan(facts, [{ to: '1.1:end' }, { to: '1.2:end' }, { to: '⟨end⟩', shots: [{ to: '1.3:end' }, { to: '2.2:end' }, {}] }]);
    expect(warned(p, 'STATIC_LONG').map((f) => f.ref)).toContain('SH002');
    expect(warned(p, 'NO_VISUAL_CHANGE').map((f) => f.ref)).toContain('SH002');
    expect(warned(p, 'SHOT_COUNT_LOW').map((f) => f.ref)).toEqual(['VB02']);
    const moving = plan(facts, [{ to: '1.1:end' }, { to: '1.2:end', shots: [{ spec: { movement: { motion: 'PUSH_IN', intensity: 'LOW', note: '' } } }] }, { to: '⟨end⟩' }]);
    expect(warned(moving, 'STATIC_LONG').map((f) => f.ref)).not.toContain('SH002');
  });

  it('DENSITY_LOW against a dense profile', () => {
    const p = plan(slow({ profile: profile({ density: 'DENSE' }) }), [{ to: '1.2:end' }, { to: '⟨end⟩' }]);
    expect(warned(p, 'DENSITY_LOW').map((f) => f.detail)).toEqual([expect.stringMatching(/^Shots average \d+\.\d s; dense density aims for 2\.5–5 s$/)]);
  });

  it('GENERIC_BROLL: more than 15 s of environment and metaphor with no claim and no subject', () => {
    const facts = slow();
    const p = plan(facts, [{ to: '1.2:end', treatment: 'TEXT_ON_SCREEN' }, { to: '1.3:end', treatment: 'ABSTRACT_METAPHOR' }, { to: '⟨end⟩', treatment: 'ENVIRONMENT' }]);
    expect(warned(p, 'GENERIC_BROLL').map((f) => f.ref)).toEqual(['SH002']);
    const grounded = plan(facts, [{ to: '1.2:end', treatment: 'TEXT_ON_SCREEN' }, { to: '1.3:end', treatment: 'ABSTRACT_METAPHOR', shots: [{ claims: [{ claimKey: 'H5', role: 'CONTEXT' }] }] }, { to: '⟨end⟩', treatment: 'ENVIRONMENT', shots: [{ to: '2.2:end', claims: [{ claimKey: 'H2', role: 'CONTEXT' }] }, { claims: [{ claimKey: 'H3', role: 'CONTEXT' }] }] }]);
    expect(warned(grounded, 'GENERIC_BROLL')).toEqual([]);
  });

  it('GENERATED_VIDEO_SHARE: generated video over the profile\'s share', () => {
    const facts = domainFilm('history', { profile: profile({ generation: { maxGeneratedVideoShare: 0.25, preferStillMotion: false, rerolls: {} } }) }).facts;
    const p = plan(facts, [{ to: '1.2:end', treatment: 'TEXT_ON_SCREEN' }, { to: '⟨end⟩', treatment: 'ABSTRACT_METAPHOR' }]);
    expect(p.shots[1]!.method).toBe('GENERATIVE_VIDEO');
    expect(warned(p, 'GENERATED_VIDEO_SHARE').map((f) => f.detail)).toEqual([expect.stringMatching(/^Generated video covers \d+% of the runtime; the profile allows 25%$/)]);
    expect(p.rhythm.generatedVideoShare).toBeGreaterThan(0.25);
  });

  it('MID_SENTENCE_CUT: a cut at a clause needs a change of concept or information, or a reveal', () => {
    const { facts } = domainFilm('history');
    const cut = (cutIn: 'BEAT_CHANGE' | 'INFORMATION_CHANGE') => plan(facts, [{ to: '1.2:end', shots: [{ to: '1.2:2' }, { cutIn }] }, { to: '⟨end⟩' }]);
    expect(warned(cut('BEAT_CHANGE', ), 'MID_SENTENCE_CUT').map((f) => f.detail)).toEqual(['SH002 cuts inside a sentence (1.2:2) without a change of concept or information, or a reveal']);
    expect(warned(cut('INFORMATION_CHANGE'), 'MID_SENTENCE_CUT')).toEqual([]);
  });

  it('ENVIRONMENT_REPEATED: the same environment beat after beat', () => {
    const { facts } = domainFilm('history');
    const harbour = subject('CS01', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const env = { spec: { environment: { subjectKey: 'CS01', description: 'The harbour (test).' } } };
    const beats: BeatSketch[] = ['1.1:end', '1.2:end', '1.3:end', '2.1:end', '⟨end⟩'].map((to) => ({ to, shots: [env] }));
    const p = planStoryboard(sketchDraft(facts, beats, { subjects: [harbour] }), facts);
    expect(warned(p, 'ENVIRONMENT_REPEATED').map((f) => f.detail)).toEqual(['The environment CS01 is the picture in 4 beats in a row']);
  });
});

describe('the measured rhythm', () => {
  it('measures lengths, cuts, treatment changes, motion, information density, resets, peaks and transitions', () => {
    const { facts } = domainFilm('history', { pauses: {} });
    const p = plan(facts, [
      { to: '1.1:end', treatment: 'TEXT_ON_SCREEN' },
      { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.2:9', claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }, { cutIn: 'REVEAL', claims: [{ claimKey: 'H1', role: 'CONTEXT' }] }] },
      { to: '1.3:end' },
      { to: '⟨end⟩', treatment: 'TRANSITION', shots: [{ to: '2.1:end', treatment: 'ENVIRONMENT' }, { spec: { transitionIn: 'DISSOLVE' } }] },
    ]);
    const r = p.rhythm;
    const lengths = p.shots.map((s) => s.endMs! - s.startMs!);
    expect(r.shots).toBe(6);
    expect(r.minShotMs).toBe(Math.min(...lengths));
    expect(r.maxShotMs).toBe(Math.max(...lengths));
    expect(r.averageShotMs).toBe(Math.round(lengths.reduce((a, b) => a + b, 0) / 6));
    expect(r.cutsPerMinute).toBeCloseTo(5 / (facts.spine.totalDurationMs / 60_000), 1);
    expect(r.treatmentChanges).toBe(3);
    expect(r.longestSameTreatmentRun).toBe(2);
    expect(r.staticShare + r.movingShare).toBeCloseTo(1, 2);
    expect(r.claimsPerMinute).toBeCloseTo(2 / (facts.spine.totalDurationMs / 60_000), 1);
    expect(r.resetPoints.map((x) => `${x.kind} ${x.ref}`)).toEqual(['SECTION SC02', 'SECTION SC03']);
    expect(r.peaks.map((x) => `${x.kind} ${x.beatKey}`)).toEqual(['QUESTION_POSED VB01', 'REVEAL VB04', 'QUESTION_ANSWERED VB04']);
    expect(r.reveals).toBe(1);
    expect(r.transitions).toBe(1);
    expect(r.generatedVideoShare).toBeGreaterThan(0);
  });
});
