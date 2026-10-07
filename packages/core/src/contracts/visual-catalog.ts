import { z } from 'zod';
import { USAGE_UNITS, type Rate, type UsageItem } from '../cost.ts';
import { PRICE_CONFIDENCES, PRODUCTION_METHODS, type AspectRatio, type PriceConfidence, type ProductionMethod } from '../enums.ts';

/**
 * The visual catalog's shape: which providers and models could produce each
 * production method, and at what price, so a storyboard can be costed before
 * anything is generated. Types only: the cards, their prices (each with a
 * source, a check date and a confidence) and the factory that applies the
 * user's plan-price overrides live in packages/providers, never in core.
 * A candidate need not be configured or implemented, and nothing here calls
 * a provider.
 */

/** One generation of a shot, as a model bills it. */
export interface BilledUsageRequest {
  durationSec: number;
  resolution: string;
  method: ProductionMethod;
}

export interface VisualModelCard {
  provider: string;
  model: string;
  label: string;
  methods: readonly ProductionMethod[];
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly string[];
  /**
   * The clip lengths it generates: on billable lengths [5, 10] an 8 s shot
   * bills 10 s, and a shot longer than maxSec is ⌈d / maxSec⌉ clips. Null:
   * billed by the second, or by the item.
   */
  clip: { minSec: number; maxSec: number; billableSec: readonly number[] } | null;
  /** What one generation of a shot is billed for, clip rounding applied. */
  billedUsage(req: BilledUsageRequest): UsageItem[];
  /** False: a conservative fallback for a model the catalog does not know. */
  known: boolean;
}

/** Where a card's prices come from, when they were checked, and how sure they are. */
export interface VisualPricing {
  source: string;
  /** YYYY-MM-DD. */
  checkedAt: string;
  confidence: PriceConfidence;
}

export interface VisualProviderCard {
  provider: string;
  label: string;
  /** A provider adapter exists for it (a candidate need not have one). */
  implemented: boolean;
  models: readonly VisualModelCard[];
  /** Each source reads "<url or document> (checked YYYY-MM-DD)". A usage with no rate is UNPRICED, never $0. */
  rates: readonly Rate[];
  pricing: VisualPricing;
}

/** A model that can produce a method, with its card. */
export interface VisualCandidate {
  card: VisualProviderCard;
  model: VisualModelCard;
}

export interface VisualCatalog {
  /** Changes with any card or price: a frozen estimate names the version it used. */
  version: string;
  cards: readonly VisualProviderCard[];
  /** Every model that produces the method, in catalog order. */
  forMethod(method: ProductionMethod): VisualCandidate[];
}

/** A usage line as an estimate stores it (the shape of UsageItem). */
export const BilledUsage = z.object({ unit: z.enum(USAGE_UNITS), quantity: z.number().min(0) });
export type BilledUsage = z.infer<typeof BilledUsage>;

/** Where a price comes from (a URL or a document): a price without one is not a price. */
export const PriceSource = z.string().trim().min(1).max(500);
/** The day a price was checked, YYYY-MM-DD. */
export const PriceCheckDate = z.iso.date();

/** A rate as a storyboard version froze it. */
export const VisualRateSnapshot = z.object({
  /** Null: the provider-wide rate. */
  model: z.string().nullable(),
  unit: z.enum(USAGE_UNITS),
  usdPerUnit: z.number().min(0),
  source: PriceSource,
});
export type VisualRateSnapshot = z.infer<typeof VisualRateSnapshot>;

/**
 * The catalog entries a storyboard version was costed with, frozen into it,
 * so the version reads the same after a price changes.
 */
export const VisualPricingSnapshot = z.object({
  catalogVersion: z.string(),
  cards: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      label: z.string(),
      methods: z.array(z.enum(PRODUCTION_METHODS)),
      rates: z.array(VisualRateSnapshot),
      source: PriceSource,
      checkedAt: PriceCheckDate,
      confidence: z.enum(PRICE_CONFIDENCES),
    }),
  ),
});
export type VisualPricingSnapshot = z.infer<typeof VisualPricingSnapshot>;
