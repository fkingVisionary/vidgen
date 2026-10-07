import { createHash } from 'node:crypto';
import {
  PRODUCTION_METHODS,
  PriceCheckDate,
  TREATMENT_METHODS,
  USAGE_UNITS,
  VISUAL_COST_BASES,
  VISUAL_TREATMENTS,
  VisualPricingSnapshot,
  type ProductionMethod,
  type Rate,
  type UsageUnit,
  type VisualCandidate,
  type VisualCatalog,
  type VisualCatalogView,
  type VisualProviderCard,
} from '@docengine/core';
import { z } from 'zod';
import { ARCHIVAL_CARD, STOCK_CARD, archivalItemOverride } from './archival.ts';
import { billedUnits, priceList, unknownVisualModel } from './billing.ts';
import { HIGGSFIELD_CARD } from './higgsfield.ts';
import { IN_HOUSE_CARD } from './in-house.ts';
import { MOCK_VISUAL_CARD, MOCK_VISUAL_PROVIDER } from './mock.ts';

/**
 * The visual catalog: which providers and models could produce each
 * production method, and what one generation of a shot would cost, so a
 * storyboard is costed before anything is generated. Instance-free data: no
 * client, no credentials, never a call, never env (the API passes the
 * user's prices in as settings). Every price carries a source, a check date
 * and a confidence; a usage with no rate is UNPRICED, never $0.
 */

/** Changes with any card, model or price: a frozen estimate names the version it was costed with. */
export const CATALOG_VERSION = '2026-10-06.2';

/** The real cards, in the router's fallback order. */
const PROVIDER_CARDS: readonly VisualProviderCard[] = [HIGGSFIELD_CARD, IN_HOUSE_CARD, ARCHIVAL_CARD, STOCK_CARD];

export class VisualCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualCatalogError';
  }
}

const OverrideRate = z
  .object({
    /** Omitted: the rate applies to every model of the provider. */
    model: z.string().trim().min(1).max(100).optional(),
    unit: z.enum(USAGE_UNITS),
    usdPerUnit: z.number().min(0).max(10_000),
  })
  .strict();

const OverrideFields = z
  .object({
    provider: z.string().trim().min(1).max(60),
    /** The setting that holds the prices, e.g. VISUAL_PRICE_OVERRIDES: it becomes every rate's source. */
    source: z.string().trim().min(1).max(100),
    checkedAt: PriceCheckDate,
    confidence: z.enum(['PLAN_PRICE', 'ASSUMPTION']),
    /** Required for an ASSUMPTION: why that price is assumed. */
    note: z.string().trim().min(1).max(200).optional(),
    rates: z.array(OverrideRate).min(1).max(100),
  })
  .strict();

/** An assumed price says why it is assumed. */
const saysWhy = (o: { confidence: string; note?: string | undefined }) => o.confidence !== 'ASSUMPTION' || o.note !== undefined;
const SAYS_WHY = { message: 'an ASSUMPTION needs a note saying why the price is assumed', path: ['note'] };

/**
 * A provider's prices set by the user: a plan's own prices (PLAN_PRICE) or
 * a labelled assumption with its reason. It replaces the card's whole price
 * list, so a card never mixes list prices with the user's: a model it
 * leaves out is UNPRICED. A list price is never set this way.
 */
export const VisualPriceOverride = OverrideFields.refine(saysWhy, SAYS_WHY);
export type VisualPriceOverride = z.infer<typeof VisualPriceOverride>;

export interface VisualPricingSettings {
  /** The user's prices, at most one entry per provider (VISUAL_PRICE_OVERRIDES, ARCHIVAL_USD_PER_ITEM). */
  overrides?: readonly VisualPriceOverride[];
  /** Adds the mock card (zero rates, basis MOCK) after the real ones. */
  mock?: boolean;
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'value'}: ${i.message}`).join('; ');
}

function checkOverrides(cards: readonly VisualProviderCard[], overrides: readonly VisualPriceOverride[]): VisualPriceOverride[] {
  const priceable = cards.filter((c) => c.provider !== MOCK_VISUAL_PROVIDER);
  const seen = new Map<string, string>();
  return overrides.map((input) => {
    const parsed = VisualPriceOverride.safeParse(input);
    if (!parsed.success) throw new VisualCatalogError(`Invalid visual price override: ${describeIssues(parsed.error)}`);
    const o = parsed.data;
    const card = priceable.find((c) => c.provider === o.provider);
    if (!card) throw new VisualCatalogError(`${o.source} sets prices for "${o.provider}", which is not in the visual catalog (providers: ${priceable.map((c) => c.provider).join(', ')})`);
    const earlier = seen.get(o.provider);
    if (earlier !== undefined) throw new VisualCatalogError(earlier === o.source ? `${o.source} sets the prices of "${o.provider}" twice` : `${earlier} and ${o.source} both set the prices of "${o.provider}": set them in one place`);
    seen.set(o.provider, o.source);
    const keys = new Set<string>();
    for (const r of o.rates) {
      if (r.model !== undefined && !card.models.some((m) => m.model === r.model)) {
        throw new VisualCatalogError(`${o.source}: "${o.provider}" has no model "${r.model}" (its models: ${card.models.map((m) => m.model).join(', ')}); a rate without a model applies to all of them`);
      }
      const billed = new Set((r.model === undefined ? card.models : card.models.filter((m) => m.model === r.model)).flatMap((m) => m.methods.flatMap(billedUnits)));
      if (!billed.has(r.unit)) {
        throw new VisualCatalogError(`${o.source}: ${o.provider} ${r.model ?? '(every model)'} is never billed in ${r.unit}, so that price would never apply (it is billed in ${[...billed].join(', ')})`);
      }
      const key = `${r.model ?? ''}\u0000${r.unit}`;
      if (keys.has(key)) throw new VisualCatalogError(`${o.source} prices ${o.provider} ${r.model ?? '(every model)'} ${r.unit} twice`);
      keys.add(key);
    }
    return o;
  });
}

function withOverride(card: VisualProviderCard, o: VisualPriceOverride): VisualProviderCard {
  const source = `${o.source} (checked ${o.checkedAt}${o.note ? `; ${o.note}` : ''})`;
  return Object.freeze({
    ...card,
    rates: priceList(o.rates.map((r) => ({ provider: card.provider, ...(r.model !== undefined ? { model: r.model } : {}), unit: r.unit, usdPerUnit: r.usdPerUnit, source }))),
    pricing: Object.freeze({ source: o.note ? `${o.source}: ${o.note}` : o.source, checkedAt: o.checkedAt, confidence: o.confidence }),
  });
}

/** A short, order-independent digest of the user's prices, so the version changes when they do. */
function settingsDigest(mock: boolean, overrides: readonly VisualPriceOverride[]): string {
  const canonical = [...overrides]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((o) => [o.provider, o.source, o.checkedAt, o.confidence, o.note ?? null, o.rates.map((r) => [r.model ?? null, r.unit, r.usdPerUnit]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  return createHash('sha256').update(JSON.stringify({ mock, overrides: canonical })).digest('hex').slice(0, 8);
}

/**
 * The catalog with the user's prices applied. Settings are passed in by the
 * API; the catalog never reads env. A price setting that names an unknown
 * provider or model, prices a unit its models are never billed in, or sets a
 * price twice, is refused rather than ignored.
 */
export function createVisualCatalog(settings: VisualPricingSettings = {}): VisualCatalog {
  const mock = settings.mock === true;
  const base = mock ? [...PROVIDER_CARDS, MOCK_VISUAL_CARD] : PROVIDER_CARDS;
  const overrides = checkOverrides(base, settings.overrides ?? []);
  const cards: readonly VisualProviderCard[] = Object.freeze(
    base.map((card) => {
      const o = overrides.find((x) => x.provider === card.provider);
      return o ? withOverride(card, o) : card;
    }),
  );
  const version = mock || overrides.length > 0 ? `${CATALOG_VERSION}+${settingsDigest(mock, overrides)}` : CATALOG_VERSION;
  return Object.freeze({
    version,
    cards,
    forMethod: (method: ProductionMethod): VisualCandidate[] => cards.flatMap((card) => card.models.filter((model) => model.methods.includes(method)).map((model) => ({ card, model }))),
  });
}

/**
 * The entry for a provider and model a profile names. A model the catalog
 * does not know gets the conservative fallback (known: false). Null: the
 * catalog has no such provider.
 */
export function findVisualModel(catalog: VisualCatalog, provider: string, model: string): VisualCandidate | null {
  const card = catalog.cards.find((c) => c.provider === provider);
  if (!card) return null;
  return { card, model: card.models.find((m) => m.model === model) ?? unknownVisualModel(provider, model) };
}

/**
 * The rate that prices a unit of a model's usage on its card: the model's
 * own rate, else the provider-wide one (as estimateCost matches them).
 * Undefined: that usage is UNPRICED.
 */
export function rateFor(card: VisualProviderCard, model: string, unit: UsageUnit): Rate | undefined {
  return card.rates.find((r) => r.unit === unit && r.model === model) ?? card.rates.find((r) => r.unit === unit && r.model === undefined);
}

/**
 * The catalog entries a storyboard version is costed with, to freeze into
 * it (every model when `used` is omitted): each model with the rates that
 * apply to it, their sources, check date and confidence.
 */
export function visualPricingSnapshot(catalog: VisualCatalog, used?: readonly { provider: string; model: string }[]): VisualPricingSnapshot {
  const entries = used ?? catalog.cards.flatMap((card) => card.models.map((m) => ({ provider: card.provider, model: m.model })));
  const seen = new Set<string>();
  const cards: VisualPricingSnapshot['cards'] = [];
  for (const { provider, model } of entries) {
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = findVisualModel(catalog, provider, model);
    if (!found) throw new VisualCatalogError(`The visual catalog has no provider "${provider}"`);
    const { card } = found;
    cards.push({
      provider,
      model,
      label: found.model.label,
      methods: [...found.model.methods],
      rates: card.rates.filter((r) => r.model === undefined || r.model === model).map((r) => ({ model: r.model ?? null, unit: r.unit, usdPerUnit: r.usdPerUnit, source: r.source ?? card.pricing.source })),
      source: card.pricing.source,
      checkedAt: card.pricing.checkedAt,
      confidence: card.pricing.confidence,
    });
  }
  return VisualPricingSnapshot.parse({ catalogVersion: catalog.version, cards });
}

/** The catalog as the dashboard shows it: methods with their treatments and candidates, cards, models and rates. */
export function describeVisualCatalog(catalog: VisualCatalog): VisualCatalogView {
  return {
    version: catalog.version,
    methods: PRODUCTION_METHODS.map((method) => ({
      method,
      treatments: VISUAL_TREATMENTS.filter((t) => TREATMENT_METHODS[t].includes(method)),
      candidates: catalog.forMethod(method).length,
    })),
    cards: catalog.cards.map((card) => ({
      provider: card.provider,
      label: card.label,
      implemented: card.implemented,
      pricing: { ...card.pricing },
      models: card.models.map((m) => ({
        model: m.model,
        label: m.label,
        methods: [...m.methods],
        aspectRatios: [...m.aspectRatios],
        resolutions: [...m.resolutions],
        clip: m.clip ? { minSec: m.clip.minSec, maxSec: m.clip.maxSec, billableSec: [...m.clip.billableSec] } : null,
        known: m.known,
      })),
      rates: card.rates.map((r) => ({ model: r.model ?? null, unit: r.unit, usdPerUnit: r.usdPerUnit, source: r.source ?? card.pricing.source })),
    })),
    bases: [...VISUAL_COST_BASES],
  };
}

const OverrideInput = z.array(OverrideFields.omit({ source: true }).extend({ confidence: OverrideFields.shape.confidence.default('PLAN_PRICE') }).refine(saysWhy, SAYS_WHY)).max(20);

/**
 * Parses VISUAL_PRICE_OVERRIDES: a JSON list of
 * `{provider, checkedAt, confidence?, note?, rates: [{model?, unit, usdPerUnit}]}`
 * (confidence defaults to PLAN_PRICE). `source` names the setting, and
 * becomes every rate's source.
 */
export function parseVisualPriceOverrides(text: string, source: string): VisualPriceOverride[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VisualCatalogError(`${source} is not valid JSON: give a list of {provider, checkedAt, rates: [{model?, unit, usdPerUnit}]}`);
  }
  const parsed = OverrideInput.safeParse(json);
  if (!parsed.success) throw new VisualCatalogError(`${source}: ${describeIssues(parsed.error)}`);
  return parsed.data.map((o) => ({ ...o, source }));
}

/**
 * Parses ARCHIVAL_USD_PER_ITEM, "<usd>@<YYYY-MM-DD>": an assumed licence
 * price per archival item and the day it was set (U11). The date keeps the
 * catalog version stable until the assumption changes.
 */
export function parseArchivalUsdPerItem(text: string, source: string): VisualPriceOverride {
  const m = /^\s*(\d+(?:\.\d+)?)\s*@\s*(\S+)\s*$/.exec(text);
  if (!m) throw new VisualCatalogError(`${source} must read "<usd>@<YYYY-MM-DD>", the assumed licence price per archival item and the day it was set (e.g. "25@2026-10-07")`);
  const parsed = VisualPriceOverride.safeParse(archivalItemOverride(Number(m[1]), m[2]!, source));
  if (!parsed.success) throw new VisualCatalogError(`${source}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}
