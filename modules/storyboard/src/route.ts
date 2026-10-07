import {
  DEFAULT_REROLLS,
  GENERATIVE_METHODS,
  PRICE_CONFIDENCES,
  TREATMENT_METHODS,
  estimateCost,
  roundUsd,
  sumUsd,
  type CostBucket,
  type CostRollup,
  type PriceConfidence,
  type ProductionMethod,
  type UsageItem,
  type VisualCandidate,
  type VisualCatalog,
  type VisualCostBasis,
  type VisualCostEstimate,
  type VisualPricingSnapshot,
  type VisualStyleProfileConfig,
  type VisualTreatment,
} from '@docengine/core';
import { MOCK_VISUAL_PROVIDER, unknownVisualModel, visualPricingSnapshot } from '@docengine/providers';

/**
 * Treatment before provider (§2.8). A shot's treatment gives its production
 * methods (provider-neutral data in core); the class rules and the profile
 * narrow and order them; the visual catalog gives the providers and models
 * that could make the method, in the profile's order of preference; each is
 * priced on its card. The recommendation is the first priced candidate — a
 * person's own choice is kept. Every figure is a forecast: never spend,
 * never in the provider-call ledger, and a price nobody verified is
 * UNPRICED, never $0. The mock card is never recommended while a real card
 * makes the method.
 */

export interface RouteRequest {
  treatment: VisualTreatment;
  /** A method asked for (by the model or a person); used when the treatment and the class rules allow it. */
  method: ProductionMethod | null;
  durationMs: number;
  /** A real person of the cast is in the shot (a portrait of them is sourced, never generated). */
  realPerson: boolean;
  /** A fictional character is in the shot (a portrait of them is generated, never "archival"). */
  fictionalSubject: boolean;
  /** A provider and model a person chose. */
  recommendation: { provider: string; model: string } | null;
  /** The shot reuses this shot's asset: no generation of its own. */
  reuseOf: string | null;
}

export interface RouteResult {
  method: ProductionMethod;
  /** The methods the treatment allows here, in the router's order. */
  methods: ProductionMethod[];
  estimate: VisualCostEstimate;
  /** Why the router chose as it did, where it was not the obvious choice. */
  reasons: string[];
}

/** The methods a treatment may be made with for this shot: a real person's portrait is sourced, a fictional one generated. */
export function allowedMethods(treatment: VisualTreatment, o: { realPerson: boolean; fictionalSubject: boolean }, profile: Pick<VisualStyleProfileConfig, 'generation'>): ProductionMethod[] {
  let methods = [...TREATMENT_METHODS[treatment]];
  if (treatment === 'PORTRAIT' && o.realPerson) methods = methods.filter((m) => m === 'ARCHIVAL_SOURCING');
  else if (treatment === 'PORTRAIT' && o.fictionalSubject) methods = methods.filter((m) => GENERATIVE_METHODS.includes(m));
  if (profile.generation.preferStillMotion && methods.includes('STILL_MOTION')) methods = ['STILL_MOTION', ...methods.filter((m) => m !== 'STILL_MOTION')];
  return methods;
}

const isMock = (c: VisualCandidate) => c.card.provider === MOCK_VISUAL_PROVIDER;

/** Candidates for a method: the profile's preferences first, then models that make the profile's frame and resolution, then catalog order; the mock card only when nothing real makes it. */
export function candidatesFor(method: ProductionMethod, profile: Pick<VisualStyleProfileConfig, 'providerPreferences' | 'aspectRatio' | 'resolution'>, catalog: VisualCatalog): VisualCandidate[] {
  const all = catalog.forMethod(method);
  const real = all.filter((c) => !isMock(c));
  const pool = real.length ? real : all;
  const prefs = profile.providerPreferences[method] ?? [];
  const pref = (c: VisualCandidate) => {
    const i = prefs.findIndex((p) => p.provider === c.card.provider && (!p.model || p.model === c.model.model));
    return i < 0 ? prefs.length : i;
  };
  const fits = (c: VisualCandidate) => (c.model.aspectRatios.includes(profile.aspectRatio) && c.model.resolutions.includes(profile.resolution) ? 0 : 1);
  return pool.map((c, i) => ({ c, i })).sort((a, b) => pref(a.c) - pref(b.c) || fits(a.c) - fits(b.c) || a.i - b.i).map((x) => x.c);
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
/** A price as written on a rate card (to the micro-dollar). */
const usd = (n: number) => `$${Math.round(n * 1_000_000) / 1_000_000}`;

/** One usage item as a reader says it, with its rate ("8 s billed as 10 s × $0.1125/s"). */
function describe(item: UsageItem, durationSec: number, usdPerUnit: number | null): string {
  const price = usdPerUnit === null ? '' : ` × ${usd(usdPerUnit)}`;
  switch (item.unit) {
    case 'VIDEO_SECONDS':
      return `${Math.abs(item.quantity - durationSec) < 0.001 ? `${fmt(durationSec)} s` : `${fmt(durationSec)} s billed as ${fmt(item.quantity)} s`}${price}${usdPerUnit === null ? '' : '/s'}`;
    case 'IMAGES':
      return `${fmt(item.quantity)} still${item.quantity === 1 ? '' : 's'}${price}`;
    case 'REQUESTS':
      return `${fmt(item.quantity)} item${item.quantity === 1 ? '' : 's'}${price}`;
    default:
      return `${fmt(item.quantity)} ${item.unit.toLowerCase().replace(/_/g, ' ')}${price}`;
  }
}

const weakest = (cs: readonly PriceConfidence[]): PriceConfidence | null => (cs.length ? [...cs].sort((a, b) => PRICE_CONFIDENCES.indexOf(b) - PRICE_CONFIDENCES.indexOf(a))[0]! : null);

/** The reroll allowance for a method: the profile's, else the default. */
export const rerollsFor = (method: ProductionMethod, profile: Pick<VisualStyleProfileConfig, 'generation'>) => profile.generation.rerolls[method] ?? DEFAULT_REROLLS[method];

/**
 * What one candidate would charge for a shot: a line per billed component,
 * each with its rate's source, check date and confidence; × (1 + rerolls).
 * Any component without a rate makes the whole estimate UNPRICED.
 */
export function priceCandidate(c: VisualCandidate, method: ProductionMethod, durationMs: number, profile: Pick<VisualStyleProfileConfig, 'generation' | 'resolution'>, source: 'ROUTER' | 'USER'): VisualCostEstimate {
  const durationSec = Math.round(durationMs) / 1000;
  const rerollAllowance = rerollsFor(method, profile);
  const generations = 1 + rerollAllowance;
  const base = { method, provider: c.card.provider, model: c.model.model, source, rerollAllowance, generations, durationSource: 'AUDIO' as const, candidates: [] };
  let usage: UsageItem[];
  try {
    usage = c.model.billedUsage({ durationSec, resolution: profile.resolution, method });
  } catch {
    return { ...base, lines: [], perGenerationUsd: null, totalUsd: null, basis: 'UNPRICED', billedClipSec: null, note: `${c.card.provider} ${c.model.model} does not make ${method.toLowerCase().replace(/_/g, ' ')}`, generationSec: 0, confidence: null };
  }
  const billedClipSec = usage.find((u) => u.unit === 'VIDEO_SECONDS')?.quantity ?? null;
  const generationSec = GENERATIVE_METHODS.includes(method) ? (billedClipSec ?? durationSec) : 0;
  const lines = usage.map((item) => {
    const { costUsd, unpriced } = estimateCost(c.card.provider, c.model.model, [item], c.card.rates);
    const r = c.card.rates.find((x) => x.unit === item.unit && x.model === c.model.model) ?? c.card.rates.find((x) => x.unit === item.unit && x.model === undefined);
    const priced = unpriced.length === 0 && r !== undefined;
    return {
      line: {
        what: describe(item, durationSec, priced ? r.usdPerUnit : null),
        usage: [{ unit: item.unit, quantity: item.quantity }],
        rate: priced ? { unit: item.unit, usdPerUnit: r.usdPerUnit, source: r.source ?? c.card.pricing.source, checkedAt: c.card.pricing.checkedAt, confidence: c.card.pricing.confidence } : null,
      },
      costUsd,
    };
  });
  const missing = lines.filter((l) => l.line.rate === null);
  if (missing.length) {
    const units = missing.map((l) => l.line.usage[0]!.unit.toLowerCase().replace(/_/g, ' ')).join(', ');
    return { ...base, lines: lines.map((l) => l.line), perGenerationUsd: null, totalUsd: null, basis: 'UNPRICED', billedClipSec, note: `No price configured for ${c.card.provider} ${c.model.model} (${units})`, generationSec, confidence: null };
  }
  const perGenerationUsd = sumUsd(lines.map((l) => l.costUsd));
  const totalUsd = roundUsd(perGenerationUsd * generations);
  const mock = isMock(c);
  const parts = lines.map((l) => l.line.what);
  const what = parts.length === 1 ? parts[0]! : `(${parts.join(' + ')})`;
  const note = mock
    ? `${what} × ${fmt(generations)} generation${generations === 1 ? '' : 's'} on the mock card: not a real price`
    : `${what} × ${fmt(generations)} generation${generations === 1 ? '' : 's'} (${c.card.pricing.source}, checked ${c.card.pricing.checkedAt}; ${c.card.pricing.confidence})`;
  return { ...base, lines: lines.map((l) => l.line), perGenerationUsd, totalUsd, basis: mock ? 'MOCK' : 'ESTIMATED', billedClipSec, note, generationSec, confidence: weakest(lines.map((l) => l.line.rate!.confidence)) };
}

function unpriced(method: ProductionMethod, provider: string | null, model: string | null, source: 'ROUTER' | 'USER', note: string, profile: Pick<VisualStyleProfileConfig, 'generation'>): VisualCostEstimate {
  const rerollAllowance = rerollsFor(method, profile);
  return { method, provider, model, source, lines: [], perGenerationUsd: null, rerollAllowance, generations: 1 + rerollAllowance, totalUsd: null, basis: 'UNPRICED', durationSource: 'AUDIO', billedClipSec: null, note, generationSec: 0, confidence: null, candidates: [] };
}

/** The candidate a person named: its catalog entry, or a conservative stand-in for a model the catalog does not know; null when the provider is unknown. */
function named(catalog: VisualCatalog, provider: string, model: string): VisualCandidate | null {
  const card = catalog.cards.find((c) => c.provider === provider);
  if (!card) return null;
  return { card, model: card.models.find((m) => m.model === model) ?? unknownVisualModel(provider, model) };
}

/** Routes and costs one shot (§2.8). */
export function routeShot(req: RouteRequest, profile: VisualStyleProfileConfig, catalog: VisualCatalog): RouteResult {
  const reasons: string[] = [];
  let methods = allowedMethods(req.treatment, req, profile);
  if (methods.length === 0) methods = [...TREATMENT_METHODS[req.treatment]];
  let method = methods[0]!;
  if (req.method && methods.includes(req.method)) method = req.method;
  else if (req.method) reasons.push(`${req.method} cannot make ${req.treatment} here: ${method} instead`);

  if (req.reuseOf) {
    const rerollAllowance = rerollsFor(method, profile);
    return {
      method,
      methods,
      estimate: { method, provider: null, model: null, source: 'ROUTER', lines: [], perGenerationUsd: 0, rerollAllowance, generations: 1 + rerollAllowance, totalUsd: 0, basis: 'ESTIMATED', durationSource: 'AUDIO', billedClipSec: null, note: `Reuses ${req.reuseOf}'s asset: no generation of its own`, generationSec: 0, confidence: null, candidates: [] },
      reasons,
    };
  }

  if (req.durationMs <= 0) return { method, methods, estimate: unpriced(method, null, null, 'ROUTER', 'The shot has no length on the narration clock: it cannot be costed', profile), reasons };
  const candidates = candidatesFor(method, profile, catalog);
  const priced = candidates.map((c) => ({ c, e: priceCandidate(c, method, req.durationMs, profile, 'ROUTER') }));
  const summary = priced.map(({ c, e }) => ({ provider: c.card.provider, model: c.model.model, totalUsd: e.totalUsd, basis: e.basis }));
  const fits = (c: VisualCandidate) => c.model.aspectRatios.includes(profile.aspectRatio) && c.model.resolutions.includes(profile.resolution);
  const first = candidates[0];
  if (first && !fits(first)) reasons.push(`${first.card.provider} ${first.model.model} does not make ${profile.aspectRatio} at ${profile.resolution}${candidates.some(fits) ? ', but the profile prefers it' : ', and no candidate does'}`);

  if (req.recommendation) {
    const c = named(catalog, req.recommendation.provider, req.recommendation.model);
    const estimate = c
      ? priceCandidate(c, method, req.durationMs, profile, 'USER')
      : unpriced(method, req.recommendation.provider, req.recommendation.model, 'USER', `${req.recommendation.provider} is not in the visual catalog`, profile);
    return { method, methods, estimate: { ...estimate, provider: req.recommendation.provider, model: req.recommendation.model, candidates: summary }, reasons };
  }
  const chosen = priced.find((p) => p.e.basis !== 'UNPRICED') ?? priced[0];
  if (!chosen) return { method, methods, estimate: { ...unpriced(method, null, null, 'ROUTER', `No provider in the visual catalog makes ${method.toLowerCase().replace(/_/g, ' ')}`, profile), candidates: [] }, reasons };
  return { method, methods, estimate: { ...chosen.e, candidates: summary }, reasons };
}

// ── Rollups ──────────────────────────────────────────────────────────────────

export interface CostedShot {
  key: string;
  treatment: VisualTreatment | null;
  method: ProductionMethod | null;
  sectionKey: string;
  beatKey: string;
  /** Null: the shot has no plan (a placeholder), so nothing can be priced. */
  cost: VisualCostEstimate | null;
}

type RollupBasis = VisualCostBasis | 'MIXED';

/** The common basis of some shots, or MIXED; a shot with no estimate counts as UNPRICED. */
export function rollupBasis(costs: readonly (VisualCostEstimate | null)[]): RollupBasis {
  const bases = new Set(costs.map((c) => c?.basis ?? 'UNPRICED'));
  if (bases.size === 0) return 'ESTIMATED';
  return bases.size === 1 ? [...bases][0]! : 'MIXED';
}

/** The priced part of some shots' forecast (null: nothing priced, never $0) and how many are unpriced. */
export function rollupTotal(costs: readonly (VisualCostEstimate | null)[]): { totalUsd: number | null; unpricedShots: number; basis: RollupBasis } {
  const priced = costs.filter((c): c is VisualCostEstimate => c !== null && c.basis !== 'UNPRICED');
  const unpricedShots = costs.length - priced.length;
  const basis = rollupBasis(costs);
  return { totalUsd: basis === 'UNPRICED' ? null : sumUsd(priced.map((c) => c.totalUsd)), unpricedShots, basis };
}

function buckets(shots: readonly CostedShot[], key: (s: CostedShot) => string): CostBucket[] {
  const groups = new Map<string, CostedShot[]>();
  for (const s of shots) {
    const k = key(s);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups].map(([k, xs]) => ({ key: k, shots: xs.length, ...rollupTotal(xs.map((x) => x.cost)) }));
}

/** The version's forecast by treatment, method, provider, model, section and beat (§2.8; the Costs tab). */
export function costRollup(shots: readonly CostedShot[], runtimeMs: number): CostRollup {
  const all = rollupTotal(shots.map((s) => s.cost));
  return {
    ...all,
    byTreatment: buckets(shots, (s) => s.treatment ?? 'UNPLANNED'),
    byMethod: buckets(shots, (s) => s.method ?? 'UNPLANNED'),
    byProvider: buckets(shots, (s) => s.cost?.provider ?? 'none'),
    byModel: buckets(shots, (s) => (s.cost?.provider && s.cost.model ? `${s.cost.provider} ${s.cost.model}` : 'none')),
    bySection: buckets(shots, (s) => s.sectionKey),
    byBeat: buckets(shots, (s) => s.beatKey),
    perFinishedMinute: all.totalUsd === null || runtimeMs <= 0 ? null : roundUsd(all.totalUsd / (runtimeMs / 60_000)),
  };
}

/** The catalog entries the recommended estimates used, frozen into the version. */
export function pricingSnapshot(catalog: VisualCatalog, costs: readonly (VisualCostEstimate | null)[]): VisualPricingSnapshot {
  const used = costs.flatMap((c) => (c?.provider && c.model && catalog.cards.some((x) => x.provider === c.provider) ? [{ provider: c.provider, model: c.model }] : []));
  return visualPricingSnapshot(catalog, used);
}
