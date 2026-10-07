import { ASPECT_RATIOS, PRODUCTION_METHODS, VISUAL_RESOLUTIONS, type VisualProviderCard } from '@docengine/core';
import { billedUnits, priceList, visualModel } from './billing.ts';

/**
 * The mock card, for an all-mock setup: every method, zero rates. An
 * estimate on it has basis MOCK, which is never a real price, and the router
 * never recommends it while a real card offers the method.
 */

export const MOCK_VISUAL_PROVIDER = 'mock';
const MODEL = 'mock-model';
const NOTE = 'mock: zero rates for tests and demos, never a real price';
/** Every unit a method is billed in, each once. */
const UNITS = [...new Set(PRODUCTION_METHODS.flatMap(billedUnits))];

export const MOCK_VISUAL_CARD: VisualProviderCard = Object.freeze({
  provider: MOCK_VISUAL_PROVIDER,
  label: 'Mock (no real price)',
  implemented: true,
  models: Object.freeze([visualModel(MOCK_VISUAL_PROVIDER, { model: MODEL, label: 'Mock model', methods: PRODUCTION_METHODS, aspectRatios: ASPECT_RATIOS, resolutions: VISUAL_RESOLUTIONS, clip: null })]),
  rates: priceList(UNITS.map((unit) => ({ provider: MOCK_VISUAL_PROVIDER, model: MODEL, unit, usdPerUnit: 0, source: `${NOTE} (checked 2026-10-06)` }))),
  pricing: Object.freeze({ source: NOTE, checkedAt: '2026-10-06', confidence: 'ASSUMPTION' }),
});
