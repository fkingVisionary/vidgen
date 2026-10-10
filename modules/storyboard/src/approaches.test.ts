import { ApproachSummary, CostAlternative, sumUsd } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { costAlternatives } from './alternatives.ts';
import { beatsToReplan, checkOptions, chooseApproach, plannedCard, switchApproach } from './approaches.ts';
import { applyEdits } from './edits.ts';
import { planStoryboard } from './plan.ts';
import { domainFilm, sketchDraft, subject, type BeatSketch } from './testing.ts';

/**
 * Alternative approaches (§23) and cheaper alternatives (§17), both
 * computed, never applied on their own: options outside the class matrix
 * are replaced by the seed; the three approaches are costed and measured by
 * the same rules; switching approach re-plans only the beats whose
 * treatment changes; cheaper ways to show a generated-video shot are
 * offered by section, with what the picture loses.
 */

const business = domainFilm('business');
/** The business film in four beats, each with its three options. */
const beats: BeatSketch[] = [
  { to: '1.1:end', treatment: 'DATA_VISUALIZATION', options: { A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'The pitch room' }, B: { treatment: 'DATA_VISUALIZATION', concept: 'The money' } }, claimKeys: ['B1'], shots: [{ claims: [{ claimKey: 'B1', role: 'DATA' }], spec: { dataSpec: { chartType: 'BAR_CHART', title: 'Raised in 2019', items: [{ label: 'Lumeo', figure: '40 million dollars', date: '2019', place: null, claimKey: 'B1' }], note: '' } } }] },
  { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', options: { A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'The glowing device' }, B: { treatment: 'PRODUCT_OBJECT', concept: 'The device alone' } }, shots: [{ claims: [{ claimKey: 'B4', role: 'DEPICTS' }] }] },
  { to: '2.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', options: { A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'The lab' }, B: { treatment: 'DIAGRAM', concept: 'The test results' } }, shots: [{ claims: [{ claimKey: 'B2', role: 'DEPICTS' }] }] },
  { to: '⟨end⟩', treatment: 'DOCUMENT_ANIMATION', options: { A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'The empty office' }, B: { treatment: 'DOCUMENT_ANIMATION', concept: 'The filing' } }, claimKeys: ['B3'], shots: [{ claims: [{ claimKey: 'B3', role: 'SHOWS_SOURCE' }] }] },
];

describe('options and the approach', () => {
  it('replaces an option the class matrix refuses with the seed treatment (or an environment), and notes it', () => {
    const notes: string[] = [];
    const options = { A: { treatment: 'ARCHIVAL_IMAGE' as const, concept: 'x' }, B: { treatment: 'DIAGRAM' as const, concept: 'y' }, C: { treatment: 'CHARACTER_VISUAL' as const, concept: 'z' } };
    expect(checkOptions('VB03', options, 'FICTION', 'CHARACTER_VISUAL', notes)).toEqual({ A: { treatment: 'CHARACTER_VISUAL', concept: 'x' }, B: { treatment: 'CHARACTER_VISUAL', concept: 'y' }, C: options.C });
    // Over framing a character visual is refused; a chart seed is refused too, so an environment it is.
    expect(checkOptions('VB04', options, 'FRAMING', 'DATA_VISUALIZATION', []).C.treatment).toBe('ENVIRONMENT');
    expect(checkOptions('VB04', options, 'FRAMING', 'ARCHIVAL_IMAGE', []).C.treatment).toBe('ARCHIVAL_IMAGE');
    expect(notes).toEqual(['VB03: option A (ARCHIVAL_IMAGE) is not allowed over FICTION narration; replaced by CHARACTER_VISUAL', 'VB03: option B (DIAGRAM) is not allowed over FICTION narration; replaced by CHARACTER_VISUAL']);
    expect([chooseApproach('A', 'B'), chooseApproach(undefined, 'B'), chooseApproach(undefined, undefined)]).toEqual(['A', 'B', 'C']);
  });

  it('costs and measures all three approaches by the same rules', () => {
    const p = planStoryboard(sketchDraft(business.facts, beats), business.facts);
    const [a, b, c] = p.approaches.options.map((x) => ApproachSummary.parse(x));
    const runtime = p.beats.reduce((n, x) => n + (x.endMs! - x.startMs!), 0);
    for (const x of [a!, b!, c!]) expect(Object.values(x.treatmentMix).reduce((n, v) => n + v!, 0)).toBe(runtime);
    expect(a!.generatedVideoShare).toBe(1);
    expect(b!.generatedVideoShare).toBe(0);
    expect(c!.generatedVideoShare).toBeGreaterThan(0);
    expect(c!.generatedVideoShare).toBeLessThan(1);
    expect(a!.estimatedCostUsd!).toBeGreaterThan(c!.estimatedCostUsd!);
    expect(b!.costBasis).toBe('MIXED'); // the filing is a sourced document: licence unpriced
    expect(b!.unpricedShots).toBeGreaterThan(0);
    // The money, the test results and the filing: data or a record, each with claims. The test results count though their only claim (B2) is
    // DEPICTS: the share follows the option's treatment, not the claims' roles.
    expect(b!.evidenceShare).toBe(0.75);
    expect(c!.evidenceShare).toBe(0.5); // C's options: a chart, two reconstructions and the filing
    expect(a!.evidenceShare).toBe(0);
    expect(p.approaches.chosen).toBe('C');
  });

  const history = domainFilm('history');
  const twoWays = { A: { treatment: 'CINEMATIC_RECONSTRUCTION' as const, concept: 'The fire (test)' }, B: { treatment: 'DOCUMENT_ANIMATION' as const, concept: 'The record (test)' } };
  /** A reconstruction cut in two shots, then a long establishing view planned as one shot (the density estimate counts four). */
  const multiShot = () =>
    planStoryboard(
      sketchDraft(history.facts, [
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', options: twoWays, claimKeys: ['H1'], shots: [{ to: '1.2:2' }, {}] },
        { to: '⟨end⟩', treatment: 'ENVIRONMENT', options: twoWays },
      ]),
      history.facts,
    );

  it("the planned approach's card is this version's own forecast; another counts the shots of the beats it keeps", () => {
    const p = multiShot();
    expect(p.approaches.keptAsPlanned).toBe(true); // saved with the version: the page tells these cards from older ones
    const [a, b, c] = p.approaches.options.map((x) => ApproachSummary.parse(x));
    expect(c!.approach).toBe(p.approaches.chosen);
    expect({ usd: c!.estimatedCostUsd, basis: c!.costBasis, unpriced: c!.unpricedShots, shots: c!.estimatedShots, video: c!.generatedVideoShare }).toEqual({
      usd: p.costs.totalUsd,
      basis: p.costs.basis,
      unpriced: p.costs.unpricedShots,
      shots: p.shots.length,
      video: p.rhythm.generatedVideoShare,
    });
    const view = p.beats[1]!;
    expect(a!.estimatedShots).toBe(2 + Math.max(1, Math.round((view.endMs! - view.startMs!) / 6000))); // keeps VB01's two shots, estimates VB02
    expect(b!.estimatedShots).toBe(p.beats.reduce((n, x) => n + Math.max(1, Math.round((x.endMs! - x.startMs!) / 6000)), 0)); // changes both beats
    const runtime = p.beats.reduce((n, x) => n + (x.endMs! - x.startMs!), 0);
    for (const x of [a!, b!, c!]) expect(Object.values(x.treatmentMix).reduce((n, v) => n + v!, 0)).toBe(runtime);
  });

  it("a version saved with a stale card for its own approach shows the version's forecast when read", () => {
    const p = multiShot();
    const chosen = p.approaches.options.find((o) => o.approach === p.approaches.chosen)!;
    const stale = { ...chosen, estimatedCostUsd: 16.46, unpricedShots: 4, estimatedShots: 19, treatmentMix: { TIMELINE: 1 } };
    const card = plannedCard(stale, p.costs, p.shots, p.rhythm.generatedVideoShare);
    expect(card).toEqual(chosen);
    expect([card.estimatedCostUsd, card.unpricedShots, card.estimatedShots]).toEqual([p.costs.totalUsd, p.costs.unpricedShots, p.shots.length]);
  });

  it('switches approach by re-planning only the beats whose treatment changes; the rest are copied as they were', () => {
    const draft = sketchDraft(business.facts, beats);
    expect(beatsToReplan(draft, 'B')).toEqual(['VB02', 'VB03']);
    const before = planStoryboard(draft, business.facts);
    const { draft: switched, replan } = switchApproach(draft, 'B');
    expect(replan).toEqual(['VB02', 'VB03']);
    expect(switched.approach).toBe('B');
    expect(switched.shots.map((s) => s.beatKey)).toEqual(['VB01', 'VB04']);
    // Re-planned by hand here (the model's job): the copied beats keep their shot keys and content hashes.
    const replanned = { ...switched, shots: [...switched.shots, ...sketchDraft(business.facts, beats, { approach: 'B' }).shots.filter((s) => replan.includes(s.beatKey)).map((s, i) => ({ ...s, key: `SH00${5 + i}`, treatment: s.beatKey === 'VB02' ? ('PRODUCT_OBJECT' as const) : ('DIAGRAM' as const), claims: s.beatKey === 'VB03' ? [{ claimKey: 'B2', role: 'CONTEXT' as const }] : [] }))] };
    const after = planStoryboard(replanned, business.facts);
    const hash = (p: typeof before, key: string) => p.shots.find((s) => s.key === key)!.contentHash;
    expect(hash(after, 'SH001')).toBe(hash(before, 'SH001'));
    expect(hash(after, 'SH004')).toBe(hash(before, 'SH004'));
    expect(after.beats.map((b) => b.treatment)).toEqual(['DATA_VISUALIZATION', 'PRODUCT_OBJECT', 'DIAGRAM', 'DOCUMENT_ANIMATION']);
  });

  it('a copied shot keeps its hash when a re-planned beat before it now makes the asset it shares: only its cost follows', () => {
    const draft = sketchDraft(business.facts, beats);
    const before = planStoryboard(draft, business.facts);
    const filing = before.shots.find((s) => s.key === 'SH004')!;
    expect(filing.asset!.reuseOf).toBeNull();
    // The test results re-planned as the same filing shown as its source: the earlier shot now makes the asset, and the copied one reuses it.
    const { draft: switched, replan } = switchApproach(draft, 'B');
    const planned = sketchDraft(business.facts, beats, { approach: 'B' }).shots.filter((s) => replan.includes(s.beatKey));
    const replanned = { ...switched, shots: [...switched.shots, ...planned.map((s, i) => ({ ...s, key: `SH00${5 + i}`, ...(s.beatKey === 'VB03' ? { treatment: 'DOCUMENT_ANIMATION' as const, claims: [{ claimKey: 'B3', role: 'SHOWS_SOURCE' as const }] } : { treatment: 'PRODUCT_OBJECT' as const, claims: [] }) }))] };
    const after = planStoryboard(replanned, business.facts);
    const copied = after.shots.find((s) => s.key === 'SH004')!;
    expect(copied.asset!.reuseOf).toBe('SH006');
    expect(copied.cost).toMatchObject({ totalUsd: 0, basis: 'ESTIMATED' });
    expect(copied.contentHash).toBe(filing.contentHash);
  });
});

describe('cheaper alternatives (§17)', () => {
  it('offers animated stills or a generated still for generated-video shots, grouped by section, never applied', () => {
    const p = planStoryboard(sketchDraft(business.facts, beats), business.facts);
    const alts = p.alternatives.map((a) => CostAlternative.parse(a));
    expect(new Set(alts.map((a) => a.title))).toEqual(
      new Set([
        'Replace 1 generated video shot in section 1 with animated stills',
        'Replace 1 generated video shot in section 1 with generated stills moved in the edit',
        'Replace 1 generated video shot in section 2 with animated stills',
        'Replace 1 generated video shot in section 2 with generated stills moved in the edit',
      ]),
    );
    // Largest saving first.
    expect(alts.every((a, i) => i === 0 || a.savingUsd! <= alts[i - 1]!.savingUsd!)).toBe(true);
    const first = alts.find((a) => a.shotKeys[0] === 'SH002' && a.to.treatment === 'CINEMATIC_RECONSTRUCTION')!;
    expect(first).toMatchObject({ shotKeys: ['SH002'], from: { treatment: 'CINEMATIC_RECONSTRUCTION', method: 'GENERATIVE_VIDEO' }, to: { method: 'STILL_MOTION' }, basis: 'ESTIMATED' });
    expect(first.savingUsd).toBeCloseTo(first.beforeUsd! - first.afterUsd!, 6);
    expect(first.savingUsd!).toBeGreaterThan(0);
    // Nothing applied: the shots are still generated video.
    expect(p.shots.filter((s) => s.method === 'GENERATIVE_VIDEO').map((s) => s.key)).toEqual(['SH002', 'SH003']);
  });

  it('offers the sourced record for a shot that already shows its source, and an environment the version has', () => {
    const inv = domainFilm('investigation').facts;
    const harbour = subject('CS01', { name: 'The harbour', kind: 'ENVIRONMENT' });
    const env = { environment: { subjectKey: 'CS01', description: 'The harbour (test).' } };
    const p = planStoryboard(
      sketchDraft(inv, [
        { to: '1.1:end', treatment: 'ENVIRONMENT', shots: [{ spec: env }] },
        { to: '2.1:end' },
        { to: '3.1:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'I3', role: 'SHOWS_SOURCE' }], spec: { ...env, uncertaintyDevice: 'SOURCE_SHOWN' } }] },
        { to: '⟨end⟩' },
      ], { subjects: [harbour] }),
      inv,
    );
    const targets = p.alternatives.filter((a) => a.shotKeys.includes('SH003')).map((a) => `${a.to.treatment}/${a.to.method}`);
    expect(targets).toEqual(expect.arrayContaining(['CINEMATIC_RECONSTRUCTION/STILL_MOTION', 'GENERATED_STILL/STILL_MOTION', 'ENVIRONMENT/GENERATIVE_IMAGE']));
    // The documents are unpriced (licences): no saving can be shown, so they are not offered as cheaper.
    expect(targets).not.toContain('DOCUMENT_ANIMATION/DOCUMENT_MOTION');
    const reuse = p.alternatives.find((a) => a.to.treatment === 'ENVIRONMENT')!;
    expect(reuse).toMatchObject({ afterUsd: 0, tradeoff: "Reuses SH001's environment: the same place seen again, nothing happening in it" });
    expect(costAlternatives(p.shots, new Map(p.subjects.map((s) => [s.key, { spec: s.spec }])), inv).map((a) => a.id)).toEqual(p.alternatives.map((a) => a.id));
  });

  it('promises what applying it costs; the environment is offered only for a shot of the empty place', () => {
    const history = domainFilm('history').facts;
    const mira = subject('CS01', { name: 'Mira', kind: 'CHARACTER', castId: 'F1', castKind: 'FICTIONAL_COMPOSITE', basis: 'FICTION' });
    const harbour = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const env = { subjectKey: 'CS02', description: 'The harbour (test).' };
    const draft = sketchDraft(
      history,
      [
        { to: '1.1:end', treatment: 'ENVIRONMENT', shots: [{ spec: { environment: env } }] },
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.2:9', spec: { description: 'Flames leap from the roofs', environment: env }, claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }, { spec: { description: 'The empty quay', environment: env } }] },
        { to: '1.3:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ spec: { description: 'Mira runs', environment: env }, subjects: [{ subjectKey: 'CS01', detail: { role: 'PRIMARY', action: 'runs', interactions: [], likeness: 'PERIOD_GENERIC', speaks: null } }], claims: [{ claimKey: 'H5', role: 'CONTEXT' }] }] },
        { to: '⟨end⟩', treatment: 'ENVIRONMENT' },
      ],
      { subjects: [mira, harbour] },
    );
    const p = planStoryboard(draft, history);
    // The fire (a depicted event) and Mira (a person) are not the empty quay seen again.
    expect(p.alternatives.filter((a) => a.to.treatment === 'ENVIRONMENT').map((a) => a.shotKeys)).toEqual([['SH003']]);
    expect(p.alternatives.length).toBeGreaterThan(1);
    for (const alt of p.alternatives) {
      const applied = planStoryboard(applyEdits(draft, [{ op: 'applyAlternative', alternativeId: alt.id }], history, { alternatives: p.alternatives }).draft, history);
      expect(sumUsd(alt.shotKeys.map((k) => applied.shots.find((s) => s.key === k)!.cost!.totalUsd))).toBeCloseTo(alt.afterUsd!, 6);
    }
  });

  it('offers generated footage of the place only to a shot no longer than it (a longer one would need footage of its own)', () => {
    const history = domainFilm('history').facts;
    const harbour = subject('CS02', { name: 'Corvel harbour', kind: 'ENVIRONMENT' });
    const env = { subjectKey: 'CS02', description: 'The harbour (test).' };
    const draft = sketchDraft(
      history,
      [
        // 2.0 s of generated footage of the harbour, then a 1.0 s and a 5.4 s shot of the empty quay.
        { to: '1.1:end', treatment: 'ENVIRONMENT', shots: [{ method: 'GENERATIVE_VIDEO', spec: { environment: env } }] },
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ to: '1.2:2', spec: { description: 'The quay', environment: env } }, { spec: { description: 'The quay at night', environment: env } }] },
        { to: '⟨end⟩', treatment: 'ENVIRONMENT' },
      ],
      { subjects: [harbour] },
    );
    const p = planStoryboard(draft, history);
    const lasts = (k: string) => p.shots.find((s) => s.key === k)!.endMs! - p.shots.find((s) => s.key === k)!.startMs!;
    expect(lasts('SH002')).toBeLessThan(lasts('SH001'));
    expect(lasts('SH003')).toBeGreaterThan(lasts('SH001'));
    expect(p.alternatives.filter((a) => a.tradeoff.startsWith('Reuses')).map((a) => [a.shotKeys, a.afterUsd])).toEqual([[['SH002'], 0]]);
    // The place's own footage as animated stills is a still of its own, priced: never a reuse of itself.
    expect(p.alternatives.find((a) => a.shotKeys.includes('SH001') && a.to.method === 'STILL_MOTION' && a.to.treatment === 'ENVIRONMENT')!.afterUsd).toBeGreaterThan(0);
    for (const alt of p.alternatives) {
      const applied = planStoryboard(applyEdits(draft, [{ op: 'applyAlternative', alternativeId: alt.id }], history, { alternatives: p.alternatives }).draft, history);
      expect(sumUsd(alt.shotKeys.map((k) => applied.shots.find((s) => s.key === k)!.cost!.totalUsd))).toBeCloseTo(alt.afterUsd!, 6);
    }
  });
});
