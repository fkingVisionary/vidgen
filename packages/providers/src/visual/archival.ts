import { ASPECT_RATIOS, VISUAL_RESOLUTIONS, type VisualProviderCard } from '@docengine/core';
import { priceList, visualModel } from './billing.ts';
import type { VisualPriceOverride } from './catalog.ts';

/**
 * Sourced records: archival images and footage, sourced documents, and
 * stock. Licences vary by archive, library, item and use, so these cards
 * carry no rate: every estimate on them is UNPRICED, never $0, until a
 * price is set — an assumed price per archival item (ARCHIVAL_USD_PER_ITEM,
 * an ASSUMPTION) or a stock plan's price (VISUAL_PRICE_OVERRIDES).
 */

const CHECKED = '2026-10-06';

export const ARCHIVAL_PROVIDER = 'archival';
const ARCHIVAL_MODELS = ['archival-item', 'document-item'] as const;

export const ARCHIVAL_CARD: VisualProviderCard = Object.freeze({
  provider: ARCHIVAL_PROVIDER,
  label: 'Archival sourcing',
  implemented: false,
  models: Object.freeze([
    visualModel(ARCHIVAL_PROVIDER, { model: 'archival-item', label: 'Archival image or footage (licensed per item)', methods: ['ARCHIVAL_SOURCING'], aspectRatios: ASPECT_RATIOS, resolutions: VISUAL_RESOLUTIONS, clip: null }),
    visualModel(ARCHIVAL_PROVIDER, { model: 'document-item', label: 'Sourced document (licensed per item, animated in-house)', methods: ['DOCUMENT_MOTION'], aspectRatios: ASPECT_RATIOS, resolutions: VISUAL_RESOLUTIONS, clip: null }),
  ]),
  rates: priceList([]),
  pricing: Object.freeze({ source: 'not priced: archival licences vary by archive and item (ARCHIVAL_USD_PER_ITEM sets an assumed price per item)', checkedAt: CHECKED, confidence: 'ASSUMPTION' }),
});

export const STOCK_CARD: VisualProviderCard = Object.freeze({
  provider: 'stock',
  label: 'Stock footage and images',
  implemented: false,
  models: Object.freeze([visualModel('stock', { model: 'stock-item', label: 'Stock image or clip (licensed per item)', methods: ['STOCK_SOURCING'], aspectRatios: ASPECT_RATIOS, resolutions: VISUAL_RESOLUTIONS, clip: null })]),
  rates: priceList([]),
  pricing: Object.freeze({ source: 'not priced: stock licences vary by library and plan (VISUAL_PRICE_OVERRIDES sets a plan price per item)', checkedAt: CHECKED, confidence: 'ASSUMPTION' }),
});

/** An assumed licence price per archival item and per sourced document (U11): the archival card's whole price list. */
export function archivalItemOverride(usdPerItem: number, checkedAt: string, source: string): VisualPriceOverride {
  return {
    provider: ARCHIVAL_PROVIDER,
    source,
    checkedAt,
    confidence: 'ASSUMPTION',
    note: 'an assumed licence price per archival item',
    rates: ARCHIVAL_MODELS.map((model) => ({ model, unit: 'REQUESTS', usdPerUnit: usdPerItem })),
  };
}
