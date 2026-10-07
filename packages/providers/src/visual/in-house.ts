import { ASPECT_RATIOS, VISUAL_RESOLUTIONS, type ProductionMethod, type VisualProviderCard } from '@docengine/core';
import { priceList, visualModel } from './billing.ts';

/**
 * What the production makes itself: charts, maps, motion design, screen
 * recordings and everything made in the edit. No vendor charges for them,
 * so they are priced at $0, and the note says so: the compute that renders
 * them is not priced (an ASSUMPTION, not a list price).
 */

const PROVIDER = 'in-house';
const CHECKED = '2026-10-06';
const NOTE = 'no vendor charge; self-hosted render compute not priced';

const MODELS: readonly { model: string; label: string; method: ProductionMethod }[] = [
  { model: 'deterministic-graphics', label: 'Charts, timelines and diagrams drawn from data', method: 'DETERMINISTIC_GRAPHIC' },
  { model: 'map-render', label: 'Map animation', method: 'MAP_RENDER' },
  { model: 'motion-design', label: 'Motion design', method: 'MOTION_DESIGN' },
  { model: 'screen-recording', label: 'Screen recording', method: 'SCREEN_RECORDING' },
  { model: 'edit', label: 'Made in the edit (text, transitions, overlays)', method: 'EDIT_TIME' },
];

export const IN_HOUSE_CARD: VisualProviderCard = Object.freeze({
  provider: PROVIDER,
  label: 'In-house render and edit',
  implemented: false,
  models: Object.freeze(MODELS.map((m) => visualModel(PROVIDER, { model: m.model, label: m.label, methods: [m.method], aspectRatios: ASPECT_RATIOS, resolutions: VISUAL_RESOLUTIONS, clip: null }))),
  rates: priceList(MODELS.map((m) => ({ provider: PROVIDER, model: m.model, unit: 'VIDEO_SECONDS' as const, usdPerUnit: 0, source: `${NOTE} (checked ${CHECKED})` }))),
  pricing: Object.freeze({ source: NOTE, checkedAt: CHECKED, confidence: 'ASSUMPTION' }),
});
