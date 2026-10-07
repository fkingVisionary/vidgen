import { CostRollup, VisualCostEstimate, VisualPricingSnapshot } from '@docengine/core';
import { IN_HOUSE_CARD, MOCK_VISUAL_CARD } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { planStoryboard } from './plan.ts';
import { allowedMethods, costRollup, pricingSnapshot, priceCandidate, routeShot, type RouteRequest } from './route.ts';
import { ACME_CLIPS, ACME_VIDEO, acmeCatalog, catalogOf, domainFilm, profileSnapshot, sketchDraft } from './testing.ts';

/**
 * Treatment before provider, and honest forecasts: the router narrows the
 * treatment's methods by the class rules and the profile, ranks candidates
 * by the profile's preferences and the catalog, and prices them on their
 * cards. The brief's own example costs $2.25; clips round up; a price
 * nobody verified is UNPRICED, never $0; the mock card never wins over a
 * real one; a person's choice is kept. Every estimate fits the contract.
 */

const profile = profileSnapshot().effective;
const req = (o: Partial<RouteRequest> = {}): RouteRequest => ({ treatment: 'CINEMATIC_RECONSTRUCTION', method: null, durationMs: 8000, realPerson: false, fictionalSubject: false, recommendation: null, reuseOf: null, ...o });
const route = (o: Partial<RouteRequest> = {}, p = profile, catalog = acmeCatalog()) => {
  const r = routeShot(req(o), p, catalog);
  VisualCostEstimate.parse(r.estimate);
  return r;
};

describe('the brief\'s example and clip rounding', () => {
  it('prices 8 s of generated video at $0.1125/s with 1.5 rerolls: $0.90 a generation, $2.25 in all', () => {
    const r = route();
    expect(r.method).toBe('GENERATIVE_VIDEO');
    expect(r.estimate).toMatchObject({
      provider: 'acme-video',
      model: 'acme-motion-1',
      source: 'ROUTER',
      perGenerationUsd: 0.9,
      rerollAllowance: 1.5,
      generations: 2.5,
      totalUsd: 2.25,
      basis: 'ESTIMATED',
      durationSource: 'AUDIO',
      billedClipSec: 8,
      generationSec: 8,
      confidence: 'ASSUMPTION',
      note: '8 s × $0.1125/s × 2.5 generations (https://example.com/acme-video/pricing, checked 2026-10-07; ASSUMPTION)',
    });
    expect(r.estimate.lines).toEqual([
      { what: '8 s × $0.1125/s', usage: [{ unit: 'VIDEO_SECONDS', quantity: 8 }], rate: { unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: expect.stringMatching(/^https:\/\/example\.com\/acme-video\/pricing \(checked 2026-10-07/), checkedAt: '2026-10-07', confidence: 'ASSUMPTION' } },
    ]);
    expect(r.estimate.candidates).toEqual([
      { provider: 'acme-video', model: 'acme-motion-1', totalUsd: 2.25, basis: 'ESTIMATED' },
      { provider: 'acme-clips', model: 'acme-clip-2', totalUsd: 2, basis: 'ESTIMATED' },
    ]);
  });

  it('bills an 8 s shot as a 10 s clip and an 18 s shot as two clips on 5/10 s clips', () => {
    const clips = { card: ACME_CLIPS, model: ACME_CLIPS.models[0]! };
    const eight = priceCandidate(clips, 'GENERATIVE_VIDEO', 8000, profile, 'ROUTER');
    expect(eight).toMatchObject({ billedClipSec: 10, perGenerationUsd: 0.8, totalUsd: 2, note: '8 s billed as 10 s × $0.08/s × 2.5 generations (https://example.com/acme-clips/pricing, checked 2026-10-07; LIST_PRICE)', confidence: 'LIST_PRICE' });
    const eighteen = priceCandidate(clips, 'GENERATIVE_VIDEO', 18_000, profile, 'ROUTER');
    expect(eighteen).toMatchObject({ billedClipSec: 20, perGenerationUsd: 1.6, totalUsd: 4 });
    const fraction = priceCandidate({ card: ACME_VIDEO, model: ACME_VIDEO.models[0]! }, 'GENERATIVE_VIDEO', 7385, profile, 'ROUTER');
    expect(fraction).toMatchObject({ billedClipSec: 7.385, perGenerationUsd: 0.830813, totalUsd: 2.077033 });
  });

  it('prices image to video as a still and the seconds, line by line', () => {
    const r = route({ method: 'IMAGE_TO_VIDEO' });
    expect(r.estimate.lines.map((l) => l.what)).toEqual(['1 still × $0.03', '8 s × $0.1125/s']);
    expect(r.estimate).toMatchObject({ perGenerationUsd: 0.93, totalUsd: 2.325, note: expect.stringMatching(/^\(1 still × \$0\.03 \+ 8 s × \$0\.1125\/s\) × 2\.5 generations/) });
  });
});

describe('unpriced is never $0', () => {
  it('leaves an archival item UNPRICED (no licence price), with no total and no confidence', () => {
    const r = route({ treatment: 'ARCHIVAL_IMAGE' });
    expect(r.estimate).toMatchObject({ method: 'ARCHIVAL_SOURCING', provider: 'archival', basis: 'UNPRICED', totalUsd: null, perGenerationUsd: null, confidence: null, note: 'No price configured for archival archival-item (requests)' });
  });

  it('says so when no provider makes the method, and when a shot has no length', () => {
    const noRender = catalogOf([ACME_VIDEO]);
    expect(route({ treatment: 'DATA_VISUALIZATION' }, profile, noRender).estimate).toMatchObject({ basis: 'UNPRICED', provider: null, totalUsd: null, note: 'No provider in the visual catalog makes deterministic graphic' });
    expect(route({ durationMs: 0 }).estimate).toMatchObject({ basis: 'UNPRICED', totalUsd: null, note: 'The shot has no length on the narration clock: it cannot be costed' });
  });

  it('prices in-house renders at an explicit $0 whose source says why', () => {
    const r = route({ treatment: 'DATA_VISUALIZATION' });
    expect(r.estimate).toMatchObject({ provider: 'in-house', model: 'deterministic-graphics', basis: 'ESTIMATED', totalUsd: 0, confidence: 'ASSUMPTION', note: expect.stringMatching(/no vendor charge; self-hosted render compute not priced/) });
  });

  it('costs a reused asset at $0 with a note, generating nothing', () => {
    expect(route({ reuseOf: 'SH003' }).estimate).toMatchObject({ totalUsd: 0, basis: 'ESTIMATED', generationSec: 0, lines: [], note: "Reuses SH003's asset: no generation of its own" });
  });
});

describe('candidates and choices', () => {
  it('never recommends the mock card while a real card makes the method; uses it, as MOCK, when nothing else does', () => {
    expect(route({}, profile, acmeCatalog({ mock: true })).estimate.provider).toBe('acme-video');
    const mockOnly = route({}, profile, catalogOf([MOCK_VISUAL_CARD]));
    expect(mockOnly.estimate).toMatchObject({ provider: 'mock', basis: 'MOCK', totalUsd: 0, note: expect.stringMatching(/on the mock card: not a real price$/) });
  });

  it('ranks the profile\'s preferred provider first, and says when it does not make the profile\'s frame', () => {
    const preferring = profileSnapshot({ providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-clips' }] } }).effective;
    expect(route({}, preferring).estimate.provider).toBe('acme-clips');
    const portrait = profileSnapshot({ aspectRatio: '9:16', providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-clips' }] } }).effective;
    expect(route({}, portrait).reasons).toEqual(['acme-clips acme-clip-2 does not make 9:16 at 1080p, but the profile prefers it']);
    // Without the preference, the model that makes the frame comes first.
    expect(route({}, profileSnapshot({ aspectRatio: '9:16' }).effective, catalogOf([ACME_CLIPS, ACME_VIDEO])).estimate.provider).toBe('acme-video');
  });

  it('keeps a person\'s choice (source USER), priced on its card — or unpriced when the catalog does not know it', () => {
    expect(route({ recommendation: { provider: 'acme-clips', model: 'acme-clip-2' } }).estimate).toMatchObject({ provider: 'acme-clips', source: 'USER', totalUsd: 2 });
    expect(route({ recommendation: { provider: 'nowhere', model: 'x' } }).estimate).toMatchObject({ provider: 'nowhere', model: 'x', source: 'USER', basis: 'UNPRICED', note: 'nowhere is not in the visual catalog' });
    expect(route({ recommendation: { provider: 'acme-video', model: 'acme-motion-9' } }).estimate).toMatchObject({ source: 'USER', basis: 'UNPRICED', note: 'No price configured for acme-video acme-motion-9 (video seconds)' });
  });

  it('narrows methods by the class rules and the profile: a real person\'s portrait is sourced, a fictional one generated; stills first when preferred', () => {
    expect(allowedMethods('PORTRAIT', { realPerson: true, fictionalSubject: false }, profile)).toEqual(['ARCHIVAL_SOURCING']);
    expect(allowedMethods('PORTRAIT', { realPerson: false, fictionalSubject: true }, profile)).toEqual(['GENERATIVE_IMAGE']);
    const stills = profileSnapshot({ generation: { maxGeneratedVideoShare: 0.5, preferStillMotion: true, rerolls: { STILL_MOTION: 0.5 } } }).effective;
    expect(allowedMethods('CINEMATIC_RECONSTRUCTION', { realPerson: false, fictionalSubject: false }, stills)).toEqual(['STILL_MOTION', 'GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO']);
    expect(route({}, stills).estimate).toMatchObject({ method: 'STILL_MOTION', provider: 'acme-stills', rerollAllowance: 0.5, totalUsd: 0.06 });
    // A method the treatment does not allow is refused, with the reason.
    expect(route({ method: 'GENERATIVE_IMAGE' }).reasons).toEqual(['GENERATIVE_IMAGE cannot make CINEMATIC_RECONSTRUCTION here: GENERATIVE_VIDEO instead']);
  });
});

describe('rollups and the frozen pricing', () => {
  it('rolls up by treatment, method, provider, model, section and beat; unpriced shots make it MIXED and are counted', () => {
    const { facts } = domainFilm('history');
    const p = planStoryboard(
      sketchDraft(facts, [
        { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }] },
        { to: '1.3:end', treatment: 'ARCHIVAL_IMAGE', shots: [{ claims: [{ claimKey: 'H5', role: 'SHOWS_SOURCE' }] }] },
        { to: '⟨end⟩', treatment: 'TEXT_ON_SCREEN' },
      ]),
      facts,
    );
    const c = CostRollup.parse(p.costs);
    expect(c.basis).toBe('MIXED');
    expect(c.unpricedShots).toBe(1);
    expect(c.totalUsd).toBe(p.shots[0]!.cost!.totalUsd);
    expect(c.byTreatment.map((b) => [b.key, b.basis, b.totalUsd])).toEqual([
      ['CINEMATIC_RECONSTRUCTION', 'ESTIMATED', p.shots[0]!.cost!.totalUsd],
      ['ARCHIVAL_IMAGE', 'UNPRICED', null],
      ['TEXT_ON_SCREEN', 'ESTIMATED', 0],
    ]);
    expect(c.byProvider.map((b) => b.key)).toEqual(['acme-video', 'archival', 'in-house']);
    expect(c.bySection.map((b) => [b.key, b.basis])).toEqual([['SC01', 'MIXED'], ['SC02', 'ESTIMATED']]);
    expect(c.perFinishedMinute).toBeCloseTo(c.totalUsd! / (p.runtimeMs / 60_000), 5);
  });

  it('has no total when nothing is priced, and an empty version costs nothing', () => {
    const unpricedEstimate = route({ treatment: 'ARCHIVAL_IMAGE' }).estimate;
    const all = costRollup([{ key: 'SH001', treatment: 'ARCHIVAL_IMAGE', method: 'ARCHIVAL_SOURCING', sectionKey: 'SC01', beatKey: 'VB01', cost: unpricedEstimate }, { key: 'SH002', treatment: null, method: null, sectionKey: 'SC01', beatKey: 'VB01', cost: null }], 60_000);
    expect(CostRollup.parse(all)).toMatchObject({ totalUsd: null, basis: 'UNPRICED', unpricedShots: 2, perFinishedMinute: null });
    expect(CostRollup.parse(costRollup([], 0))).toMatchObject({ totalUsd: 0, basis: 'ESTIMATED', unpricedShots: 0 });
  });

  it('freezes the cards the recommended estimates used, with sources, check dates and confidence', () => {
    const snap = VisualPricingSnapshot.parse(pricingSnapshot(acmeCatalog({ version: 'v-test' }), [route().estimate, route({ treatment: 'DATA_VISUALIZATION' }).estimate, route({ treatment: 'ARCHIVAL_IMAGE' }).estimate, null]));
    expect(snap.catalogVersion).toBe('v-test');
    expect(snap.cards.map((c) => [c.provider, c.model, c.confidence, c.rates.length])).toEqual([
      ['acme-video', 'acme-motion-1', 'ASSUMPTION', 2],
      ['in-house', 'deterministic-graphics', 'ASSUMPTION', 1],
      ['archival', 'archival-item', 'ASSUMPTION', 0],
    ]);
    expect(IN_HOUSE_CARD.rates.every((r) => r.usdPerUnit === 0)).toBe(true);
  });
});
