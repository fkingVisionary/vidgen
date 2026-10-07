import { createHash } from 'node:crypto';
import { DEFAULT_REROLLS, PRODUCTION_METHODS, VISUAL_PROFILE_PRESETS, estimateCost, roundUsd, type Rate, type VisualProviderCard } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { runVisualCatalogContract } from '../contract/index.ts';
import { ARCHIVAL_CARD, STOCK_CARD } from './archival.ts';
import { billedClips, clipLengths, clipRange, usageFor, visualModel } from './billing.ts';
import {
  CATALOG_VERSION,
  VisualCatalogError,
  createVisualCatalog,
  describeVisualCatalog,
  findVisualModel,
  parseArchivalUsdPerItem,
  parseVisualPriceOverrides,
  rateFor,
  visualPricingSnapshot,
} from './catalog.ts';
import { HIGGSFIELD_CARD } from './higgsfield.ts';
import { IN_HOUSE_CARD } from './in-house.ts';
import { MOCK_VISUAL_CARD } from './mock.ts';

const KLING_PRO = 'kling-video/v3.0/pro/text-to-video';
const KLING_PRO_I2V = 'kling-video/v3.0/pro/image-to-video';
const KLING_25 = 'kling-video/v2.5-turbo/pro/text-to-video';
const SOUL = 'higgsfield-ai/soul/v2/standard';

const OVERRIDES = JSON.stringify([{ provider: 'higgsfield', checkedAt: '2026-10-07', note: 'launch discount', rates: [{ model: KLING_PRO, unit: 'VIDEO_SECONDS', usdPerUnit: 0.084 }] }]);

runVisualCatalogContract('the default catalog', () => createVisualCatalog());
runVisualCatalogContract('with plan prices, an archival assumption and the mock card', () =>
  createVisualCatalog({ mock: true, overrides: [...parseVisualPriceOverrides(OVERRIDES, 'VISUAL_PRICE_OVERRIDES'), parseArchivalUsdPerItem('25@2026-10-07', 'ARCHIVAL_USD_PER_ITEM')] }),
);

/** The cost of one generation of a shot on a card, as the router computes it. */
function generation(card: VisualProviderCard, model: string, method: (typeof PRODUCTION_METHODS)[number], durationSec: number) {
  const m = card.models.find((x) => x.model === model)!;
  return estimateCost(card.provider, model, m.billedUsage({ durationSec, resolution: '1080p', method }), card.rates);
}

describe('billing a shot', () => {
  // The brief's example: an 8 s reconstruction at $0.1125/s is $0.90 a generation; 1.5 rerolls make it $2.25.
  const acmeVideo = visualModel('acme-video', { model: 'acme-v1', label: 'Acme video', methods: ['GENERATIVE_VIDEO'], aspectRatios: ['16:9'], resolutions: ['1080p'], clip: null });
  const acmeRates: Rate[] = [{ provider: 'acme-video', model: 'acme-v1', unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: 'synthetic (checked 2026-10-06)' }];

  it('bills per second exactly when the model has no clip lengths', () => {
    const usage = acmeVideo.billedUsage({ durationSec: 8, resolution: '1080p', method: 'GENERATIVE_VIDEO' });
    expect(usage).toEqual([{ unit: 'VIDEO_SECONDS', quantity: 8 }]);
    const { costUsd, unpriced } = estimateCost('acme-video', 'acme-v1', usage, acmeRates);
    expect({ costUsd, unpriced }).toEqual({ costUsd: 0.9, unpriced: [] });
    expect(roundUsd(costUsd * (1 + DEFAULT_REROLLS.GENERATIVE_VIDEO))).toBe(2.25);
    expect(acmeVideo.billedUsage({ durationSec: 7.4, resolution: '1080p', method: 'GENERATIVE_VIDEO' })).toEqual([{ unit: 'VIDEO_SECONDS', quantity: 7.4 }]);
  });

  it('rounds a shot up to the clip lengths a model generates', () => {
    const tens = clipLengths([5, 10]);
    expect(billedClips(8, tens)).toEqual({ clips: 1, seconds: 10 });
    expect(billedClips(7.4, tens)).toEqual({ clips: 1, seconds: 10 });
    expect(billedClips(3, tens)).toEqual({ clips: 1, seconds: 5 });
    expect(billedClips(0.7, tens)).toEqual({ clips: 1, seconds: 5 });
    expect(billedClips(10, tens)).toEqual({ clips: 1, seconds: 10 });
  });

  it('splits a shot longer than a clip into the fewest clips, billing the least', () => {
    const tens = clipLengths([5, 10]);
    expect(billedClips(18, tens)).toEqual({ clips: 2, seconds: 20 });
    expect(billedClips(10.2, tens)).toEqual({ clips: 2, seconds: 15 });
    const whole = clipRange(3, 15);
    expect(billedClips(7.4, whole)).toEqual({ clips: 1, seconds: 8 });
    expect(billedClips(2, whole)).toEqual({ clips: 1, seconds: 3 });
    expect(billedClips(16, whole)).toEqual({ clips: 2, seconds: 16 });
    expect(billedClips(45.5, whole)).toEqual({ clips: 4, seconds: 46 });
  });

  it('bills a shot measured in milliseconds without float drift', () => {
    expect(billedClips(8000.0004 / 1000, clipRange(3, 15))).toEqual({ clips: 1, seconds: 8 });
    expect(billedClips((2100 + 5900) / 1000, clipLengths([5, 10]))).toEqual({ clips: 1, seconds: 10 });
  });

  it('counts clips in whole milliseconds, so a fractional clip length never bills an extra clip', () => {
    // 6.9 / 2.3 and 8.4 / 2.8 are 3.0000000000000004 in floating point.
    expect(billedClips(6.9, clipLengths([2.3]))).toEqual({ clips: 3, seconds: 6.9 });
    expect(billedClips(8.4, clipLengths([1.4, 2.8]))).toEqual({ clips: 3, seconds: 8.4 });
    expect(usageFor('IMAGE_TO_VIDEO', 8.4, clipLengths([1.4, 2.8]))).toEqual([{ unit: 'IMAGES', quantity: 3 }, { unit: 'VIDEO_SECONDS', quantity: 8.4 }]);
    expect(billedClips(6.901, clipLengths([2.3]))).toEqual({ clips: 4, seconds: 9.2 });
  });

  it('bills each component: image to video is a still per clip plus the clip seconds', () => {
    const tens = clipLengths([5, 10]);
    expect(usageFor('IMAGE_TO_VIDEO', 18, tens)).toEqual([{ unit: 'IMAGES', quantity: 2 }, { unit: 'VIDEO_SECONDS', quantity: 20 }]);
    expect(usageFor('GENERATIVE_IMAGE', 18, null)).toEqual([{ unit: 'IMAGES', quantity: 1 }]);
    expect(usageFor('STILL_MOTION', 6, null)).toEqual([{ unit: 'IMAGES', quantity: 1 }]);
    expect(usageFor('ARCHIVAL_SOURCING', 6, null)).toEqual([{ unit: 'REQUESTS', quantity: 1 }]);
    expect(usageFor('DETERMINISTIC_GRAPHIC', 6.5, null)).toEqual([{ unit: 'VIDEO_SECONDS', quantity: 6.5 }]);
    expect(usageFor('GENERATIVE_VIDEO', 0, tens)).toEqual([]);
  });

  it('refuses impossible durations and clip lengths', () => {
    for (const d of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => billedClips(d, null)).toThrow(RangeError);
    expect(() => usageFor('GENERATIVE_IMAGE', -1, null)).toThrow(RangeError);
    expect(() => clipLengths([])).toThrow(RangeError);
    expect(() => clipLengths([10, 5])).toThrow(RangeError);
    expect(() => clipLengths([0, 5])).toThrow(RangeError);
    expect(() => clipLengths([5, 5])).toThrow(RangeError);
    expect(() => clipLengths([5, Number.POSITIVE_INFINITY])).toThrow(RangeError);
    // Not a whole number of milliseconds: a clip shorter than 1 ms would bill an infinite length.
    expect(() => clipLengths([0.0004])).toThrow(RangeError);
    expect(() => clipLengths([2.3005])).toThrow(RangeError);
    expect(clipLengths([2.3]).billableSec).toEqual([2.3]);
    expect(() => clipRange(0, 3)).toThrow(RangeError);
    expect(() => clipRange(5, 3)).toThrow(RangeError);
  });
});

describe("the generative video platform's card", () => {
  const catalog = createVisualCatalog();
  const card = catalog.cards.find((c) => c.provider === 'higgsfield')!;

  it('prices every rate at a list price checked on the vendor page', () => {
    expect(card.pricing).toEqual({ source: expect.stringContaining('https://open.higgsfield.ai/pricing'), checkedAt: '2026-10-06', confidence: 'LIST_PRICE' });
    for (const rate of card.rates) expect(rate.source).toMatch(/^https:\/\/open\.higgsfield\.ai\/models\/\S+ \(checked 2026-10-06; .*list price \$/);
  });

  it('costs a generation from the list price, rounded to the clips the model makes', () => {
    expect(generation(card, KLING_PRO, 'GENERATIVE_VIDEO', 8)).toEqual({ costUsd: 1.344, unpriced: [] });
    expect(generation(card, KLING_PRO, 'GENERATIVE_VIDEO', 7.4)).toEqual({ costUsd: 1.344, unpriced: [] });
    expect(generation(card, KLING_PRO, 'GENERATIVE_VIDEO', 18)).toEqual({ costUsd: 3.024, unpriced: [] });
    expect(generation(card, KLING_25, 'GENERATIVE_VIDEO', 8)).toEqual({ costUsd: 0.7, unpriced: [] });
    expect(generation(card, KLING_PRO_I2V, 'IMAGE_TO_VIDEO', 8)).toEqual({ costUsd: 1.3497, unpriced: [] });
    expect(generation(card, SOUL, 'STILL_MOTION', 12)).toEqual({ costUsd: 0.0057, unpriced: [] });
  });

  it('puts the 1080p flagship first, the order the router falls back on', () => {
    expect(catalog.forMethod('GENERATIVE_VIDEO').map((c) => c.model.model)).toEqual([KLING_PRO, 'kling-video/v3.0-turbo/text-to-video', KLING_25, 'kling-video/v3.0/4k/text-to-video']);
    expect(catalog.forMethod('GENERATIVE_IMAGE').map((c) => c.model.model)).toEqual([SOUL]);
  });
});

describe('the built-in cards', () => {
  const catalog = createVisualCatalog({ mock: true });

  it('price every usage of a priced card, and nothing on an unpriced one (never a partial or invented $0)', () => {
    for (const card of catalog.cards) {
      for (const m of card.models) {
        for (const method of m.methods) {
          const { costUsd, unpriced } = generation(card, m.model, method, 8);
          if (card.rates.length > 0) expect(unpriced).toEqual([]);
          else expect({ costUsd, priced: unpriced.length === 0 }).toEqual({ costUsd: 0, priced: false });
        }
      }
    }
  });

  it('name, for every usage item, the rate that prices it, exactly as the estimate matches it', () => {
    const priced = createVisualCatalog({ mock: true, overrides: parseVisualPriceOverrides(JSON.stringify([{ provider: 'stock', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]), 'VISUAL_PRICE_OVERRIDES') });
    for (const card of priced.cards) {
      for (const m of card.models) {
        for (const method of m.methods) {
          for (const item of m.billedUsage({ durationSec: 8, resolution: '1080p', method })) {
            const rate = rateFor(card, m.model, item.unit);
            expect(estimateCost(card.provider, m.model, [item], card.rates)).toEqual(rate ? { costUsd: roundUsd(item.quantity * rate.usdPerUnit), unpriced: [] } : { costUsd: 0, unpriced: [item] });
          }
        }
      }
    }
    expect(rateFor(HIGGSFIELD_CARD, KLING_PRO_I2V, 'IMAGES')).toMatchObject({ model: KLING_PRO_I2V, usdPerUnit: 0.0057, source: expect.stringContaining('the source still') });
    expect(rateFor(HIGGSFIELD_CARD, 'not-a-model', 'VIDEO_SECONDS')).toBeUndefined();
    expect(rateFor(priced.cards.find((c) => c.provider === 'stock')!, 'stock-item', 'REQUESTS')).toMatchObject({ usdPerUnit: 12, source: 'VISUAL_PRICE_OVERRIDES (checked 2026-10-07)' });
  });

  it('leave archival, documents and stock unpriced, never $0', () => {
    expect(ARCHIVAL_CARD.rates).toEqual([]);
    expect(STOCK_CARD.rates).toEqual([]);
    expect(generation(ARCHIVAL_CARD, 'archival-item', 'ARCHIVAL_SOURCING', 6).unpriced).toEqual([{ unit: 'REQUESTS', quantity: 1 }]);
    expect(generation(ARCHIVAL_CARD, 'document-item', 'DOCUMENT_MOTION', 6).unpriced).toEqual([{ unit: 'REQUESTS', quantity: 1 }]);
    expect(generation(STOCK_CARD, 'stock-item', 'STOCK_SOURCING', 6).unpriced).toEqual([{ unit: 'REQUESTS', quantity: 1 }]);
  });

  it('price in-house work at $0 and say why: no vendor charge, compute not priced', () => {
    expect(IN_HOUSE_CARD.pricing).toMatchObject({ source: 'no vendor charge; self-hosted render compute not priced', confidence: 'ASSUMPTION' });
    expect(generation(IN_HOUSE_CARD, 'deterministic-graphics', 'DETERMINISTIC_GRAPHIC', 9)).toEqual({ costUsd: 0, unpriced: [] });
    expect(IN_HOUSE_CARD.models.flatMap((m) => m.methods).sort()).toEqual(['DETERMINISTIC_GRAPHIC', 'EDIT_TIME', 'MAP_RENDER', 'MOTION_DESIGN', 'SCREEN_RECORDING']);
  });

  it('add the mock card only when asked, after every real candidate', () => {
    expect(createVisualCatalog().cards.map((c) => c.provider)).toEqual(['higgsfield', 'in-house', 'archival', 'stock']);
    expect(catalog.cards.map((c) => c.provider)).toEqual(['higgsfield', 'in-house', 'archival', 'stock', 'mock']);
    for (const method of PRODUCTION_METHODS) {
      const candidates = catalog.forMethod(method);
      expect(candidates.at(-1)!.card).toBe(MOCK_VISUAL_CARD);
      expect(candidates.length).toBeGreaterThan(1);
    }
    expect(MOCK_VISUAL_CARD.rates.every((r) => r.usdPerUnit === 0)).toBe(true);
    expect(MOCK_VISUAL_CARD.rates.map((r) => r.unit)).toEqual(['VIDEO_SECONDS', 'IMAGES', 'REQUESTS']);
  });

  it('are frozen down to each rate, so no estimate can change a price', () => {
    const priced = createVisualCatalog({ overrides: parseVisualPriceOverrides(JSON.stringify([{ provider: 'stock', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 12 }] }]), 'VISUAL_PRICE_OVERRIDES') });
    for (const card of [HIGGSFIELD_CARD, IN_HOUSE_CARD, ARCHIVAL_CARD, STOCK_CARD, MOCK_VISUAL_CARD, ...priced.cards]) {
      expect(Object.isFrozen(card) && Object.isFrozen(card.rates) && Object.isFrozen(card.models) && Object.isFrozen(card.pricing)).toBe(true);
      expect(card.models.every((m) => Object.isFrozen(m))).toBe(true);
      expect(card.rates.every((r) => Object.isFrozen(r))).toBe(true);
    }
    expect(() => {
      (HIGGSFIELD_CARD.rates[0] as { usdPerUnit: number }).usdPerUnit = 0;
    }).toThrow(TypeError);
    expect(createVisualCatalog().cards[0]!.rates[0]!.usdPerUnit).toBe(0.168);
  });

  it('change only with CATALOG_VERSION: bump it with any change to a card, model, price or billing rule, then pin the new digest here', () => {
    // The cards (the mock card too) and what each model bills, not core's treatment table: a version change marks every frozen estimate STALE_PRICING.
    const catalog = createVisualCatalog({ mock: true });
    const { cards } = describeVisualCatalog(catalog);
    const billing = catalog.cards.flatMap((card) =>
      card.models.flatMap((m) => m.methods.map((method) => [card.provider, m.model, method, [0.7, 3, 7.4, 8, 10.2, 16, 18, 60.5].map((durationSec) => m.billedUsage({ durationSec, resolution: m.resolutions[0]!, method }))])),
    );
    expect({ version: CATALOG_VERSION, digest: createHash('sha256').update(JSON.stringify({ cards, billing })).digest('hex').slice(0, 16) }).toEqual({ version: '2026-10-06.2', digest: 'b3cf532aed9ee8eb' });
  });

  it('keep the catalog version unless the user sets prices', () => {
    expect(createVisualCatalog().version).toBe(CATALOG_VERSION);
    expect(catalog.version).toMatch(new RegExp(`^${CATALOG_VERSION.replace(/\./g, '\\.')}\\+[0-9a-f]{8}$`));
  });
});

describe("the user's prices", () => {
  const overrides = parseVisualPriceOverrides(OVERRIDES, 'VISUAL_PRICE_OVERRIDES');
  const catalog = createVisualCatalog({ overrides });
  const card = catalog.cards.find((c) => c.provider === 'higgsfield')!;

  it('rewrite a rate, with the setting as its source, as a plan price', () => {
    expect(card.rates).toEqual([{ provider: 'higgsfield', model: KLING_PRO, unit: 'VIDEO_SECONDS', usdPerUnit: 0.084, source: 'VISUAL_PRICE_OVERRIDES (checked 2026-10-07; launch discount)' }]);
    expect(card.pricing).toEqual({ source: 'VISUAL_PRICE_OVERRIDES: launch discount', checkedAt: '2026-10-07', confidence: 'PLAN_PRICE' });
    expect(generation(card, KLING_PRO, 'GENERATIVE_VIDEO', 8)).toEqual({ costUsd: 0.672, unpriced: [] });
    expect(card.models).toBe(HIGGSFIELD_CARD.models);
    expect(HIGGSFIELD_CARD.rates.find((r) => r.model === KLING_PRO)!.usdPerUnit).toBe(0.168);
  });

  it('replace the whole price list: a model they leave out is unpriced, never priced at the list price', () => {
    expect(generation(card, KLING_25, 'GENERATIVE_VIDEO', 8).unpriced).toEqual([{ unit: 'VIDEO_SECONDS', quantity: 10 }]);
    expect(catalog.cards.find((c) => c.provider === 'in-house')).toBe(IN_HOUSE_CARD);
  });

  it('change the catalog version, the same for the same prices in any order', () => {
    expect(catalog.version).not.toBe(CATALOG_VERSION);
    const archival = parseArchivalUsdPerItem('25@2026-10-07', 'ARCHIVAL_USD_PER_ITEM');
    expect(createVisualCatalog({ overrides: [...overrides, archival] }).version).toBe(createVisualCatalog({ overrides: [archival, ...overrides] }).version);
    const cheaper = parseVisualPriceOverrides(OVERRIDES.replace('0.084', '0.08'), 'VISUAL_PRICE_OVERRIDES');
    expect(createVisualCatalog({ overrides: cheaper }).version).not.toBe(catalog.version);
  });

  it('price every model of a provider with a rate that names none, including one the catalog does not know', () => {
    const wide = createVisualCatalog({ overrides: parseVisualPriceOverrides(JSON.stringify([{ provider: 'higgsfield', checkedAt: '2026-10-07', rates: [{ unit: 'VIDEO_SECONDS', usdPerUnit: 0.05 }] }]), 'VISUAL_PRICE_OVERRIDES') });
    const found = findVisualModel(wide, 'higgsfield', 'some-new-model')!;
    const usage = found.model.billedUsage({ durationSec: 7.4, resolution: '1080p', method: 'GENERATIVE_VIDEO' });
    expect(estimateCost('higgsfield', 'some-new-model', usage, found.card.rates)).toEqual({ costUsd: 0.4, unpriced: [] });
    expect(found.card.pricing.confidence).toBe('PLAN_PRICE');
  });

  it('set an assumed price per archival item, labelled as an assumption; stock stays unpriced', () => {
    const archival = createVisualCatalog({ overrides: [parseArchivalUsdPerItem(' 25.5 @ 2026-10-07 ', 'ARCHIVAL_USD_PER_ITEM')] });
    const card = archival.cards.find((c) => c.provider === 'archival')!;
    expect(card.pricing).toEqual({ source: 'ARCHIVAL_USD_PER_ITEM: an assumed licence price per archival item', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' });
    expect(generation(card, 'archival-item', 'ARCHIVAL_SOURCING', 6)).toEqual({ costUsd: 25.5, unpriced: [] });
    expect(generation(card, 'document-item', 'DOCUMENT_MOTION', 6)).toEqual({ costUsd: 25.5, unpriced: [] });
    expect(archival.cards.find((c) => c.provider === 'stock')).toBe(STOCK_CARD);
  });

  it('are refused, not ignored, when they name an unknown provider or model, repeat a price, or claim a list price', () => {
    const set = (entries: unknown[]) => () => createVisualCatalog({ overrides: parseVisualPriceOverrides(JSON.stringify(entries), 'VISUAL_PRICE_OVERRIDES') });
    const rate = { unit: 'VIDEO_SECONDS', usdPerUnit: 0.1 };
    expect(set([{ provider: 'acme', checkedAt: '2026-10-07', rates: [rate] }])).toThrow(/VISUAL_PRICE_OVERRIDES sets prices for "acme", which is not in the visual catalog/);
    expect(set([{ provider: 'mock', checkedAt: '2026-10-07', rates: [rate] }])).toThrow(/not in the visual catalog/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', rates: [{ ...rate, model: 'kling-9' }] }])).toThrow(/"higgsfield" has no model "kling-9"/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', rates: [rate, rate] }])).toThrow(/twice/);
    const item = { unit: 'REQUESTS', usdPerUnit: 4 };
    expect(set([{ provider: 'stock', checkedAt: '2026-10-07', rates: [item] }, { provider: 'stock', checkedAt: '2026-10-08', rates: [item] }])).toThrow(/twice/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', confidence: 'LIST_PRICE', rates: [rate] }])).toThrow(VisualCatalogError);
    expect(set([{ provider: 'higgsfield', checkedAt: '7 Oct', rates: [rate] }])).toThrow(/checkedAt/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', rates: [{ ...rate, usdPerUnit: -1 }] }])).toThrow(/usdPerUnit/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', rates: [] }])).toThrow(/rates/);
    expect(set([{ provider: 'higgsfield', checkedAt: '2026-10-07', price: 1, rates: [rate] }])).toThrow(VisualCatalogError);
    expect(() => parseVisualPriceOverrides('{not json', 'VISUAL_PRICE_OVERRIDES')).toThrow(/VISUAL_PRICE_OVERRIDES is not valid JSON/);
    expect(() => createVisualCatalog({ overrides: [{ provider: 'higgsfield', source: '', checkedAt: '2026-10-07', confidence: 'PLAN_PRICE', rates: [{ unit: 'VIDEO_SECONDS', usdPerUnit: 0.1 }] }] })).toThrow(VisualCatalogError);
  });

  it('are refused when they price a unit the models are never billed in, which would silently leave the card unpriced', () => {
    const set = (rates: unknown[], provider = 'higgsfield') => () => createVisualCatalog({ overrides: parseVisualPriceOverrides(JSON.stringify([{ provider, checkedAt: '2026-10-07', rates }]), 'VISUAL_PRICE_OVERRIDES') });
    expect(set([{ unit: 'CREDITS', usdPerUnit: 0.05 }])).toThrow(
      'VISUAL_PRICE_OVERRIDES: higgsfield (every model) is never billed in CREDITS, so that price would never apply (it is billed in VIDEO_SECONDS, IMAGES)',
    );
    expect(set([{ model: KLING_PRO, unit: 'IMAGES', usdPerUnit: 0.01 }])).toThrow(`higgsfield ${KLING_PRO} is never billed in IMAGES`);
    expect(set([{ model: SOUL, unit: 'VIDEO_SECONDS', usdPerUnit: 0.01 }])).toThrow(`higgsfield ${SOUL} is never billed in VIDEO_SECONDS`);
    expect(set([{ unit: 'VIDEO_SECONDS', usdPerUnit: 1 }], 'stock')).toThrow('stock (every model) is never billed in VIDEO_SECONDS, so that price would never apply (it is billed in REQUESTS)');
    // An image-to-video model is billed for its source stills as well as its seconds.
    const i2v = set([{ model: KLING_PRO_I2V, unit: 'IMAGES', usdPerUnit: 0.004 }, { model: KLING_PRO_I2V, unit: 'VIDEO_SECONDS', usdPerUnit: 0.084 }])();
    expect(generation(i2v.cards[0]!, KLING_PRO_I2V, 'IMAGE_TO_VIDEO', 8)).toEqual({ costUsd: 0.676, unpriced: [] });
  });

  it('refuse an assumed price that does not say why it is assumed', () => {
    const entry = { provider: 'stock', checkedAt: '2026-10-07', confidence: 'ASSUMPTION', rates: [{ unit: 'REQUESTS', usdPerUnit: 8 }] };
    expect(() => parseVisualPriceOverrides(JSON.stringify([entry]), 'VISUAL_PRICE_OVERRIDES')).toThrow(/VISUAL_PRICE_OVERRIDES: 0\.note: an ASSUMPTION needs a note/);
    expect(() => createVisualCatalog({ overrides: [{ ...entry, confidence: 'ASSUMPTION', source: 'VISUAL_PRICE_OVERRIDES', rates: [{ unit: 'REQUESTS', usdPerUnit: 8 }] }] })).toThrow(/note: an ASSUMPTION needs a note/);
    const said = createVisualCatalog({ overrides: parseVisualPriceOverrides(JSON.stringify([{ ...entry, note: 'typical library price per clip' }]), 'VISUAL_PRICE_OVERRIDES') });
    expect(said.cards.find((c) => c.provider === 'stock')!.pricing).toEqual({ source: 'VISUAL_PRICE_OVERRIDES: typical library price per clip', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' });
  });

  it('name the setting, so every price they set fits a frozen snapshot', () => {
    const override = (source: string) => ({ provider: 'stock', source, checkedAt: '2026-10-07', confidence: 'PLAN_PRICE' as const, note: 'n'.repeat(200), rates: [{ unit: 'REQUESTS' as const, usdPerUnit: 1 }] });
    expect(visualPricingSnapshot(createVisualCatalog({ overrides: [override('S'.repeat(100))] })).cards.find((c) => c.provider === 'stock')!.rates).toHaveLength(1);
    expect(() => createVisualCatalog({ overrides: [override('S'.repeat(450))] })).toThrow(/source/);
  });

  it('are refused when two settings price the same provider, naming both', () => {
    const archival = JSON.stringify([{ provider: 'archival', checkedAt: '2026-10-07', rates: [{ unit: 'REQUESTS', usdPerUnit: 3 }] }]);
    expect(() => createVisualCatalog({ overrides: [...parseVisualPriceOverrides(archival, 'VISUAL_PRICE_OVERRIDES'), parseArchivalUsdPerItem('25@2026-10-07', 'ARCHIVAL_USD_PER_ITEM')] })).toThrow(
      'VISUAL_PRICE_OVERRIDES and ARCHIVAL_USD_PER_ITEM both set the prices of "archival": set them in one place',
    );
  });

  it('refuse an archival assumption without the day it was set', () => {
    for (const text of ['25', 'abc', '25@yesterday', '25@2026-13-40', '-5@2026-10-07']) {
      expect(() => parseArchivalUsdPerItem(text, 'ARCHIVAL_USD_PER_ITEM')).toThrow(/ARCHIVAL_USD_PER_ITEM/);
    }
  });
});

describe('models the catalog does not know', () => {
  it('get a conservative fallback that vouches for nothing and stays unpriced', () => {
    const catalog = createVisualCatalog();
    const found = findVisualModel(catalog, 'higgsfield', 'veo-3.1')!;
    expect(found.model).toMatchObject({ provider: 'higgsfield', model: 'veo-3.1', known: false, methods: [], aspectRatios: [], resolutions: [] });
    const usage = found.model.billedUsage({ durationSec: 8.2, resolution: '1080p', method: 'IMAGE_TO_VIDEO' });
    expect(usage).toEqual([{ unit: 'IMAGES', quantity: 1 }, { unit: 'VIDEO_SECONDS', quantity: 9 }]);
    expect(estimateCost('higgsfield', 'veo-3.1', usage, found.card.rates).unpriced).toEqual(usage);
    expect(findVisualModel(catalog, 'higgsfield', KLING_PRO)!.model.known).toBe(true);
  });
});

describe('the pricing snapshot and the catalog view', () => {
  const catalog = createVisualCatalog();

  it('freeze the entries used, once each, with the rates that apply to them', () => {
    const snapshot = visualPricingSnapshot(catalog, [
      { provider: 'higgsfield', model: KLING_PRO_I2V },
      { provider: 'archival', model: 'archival-item' },
      { provider: 'higgsfield', model: KLING_PRO_I2V },
    ]);
    expect(snapshot.catalogVersion).toBe(CATALOG_VERSION);
    expect(snapshot.cards.map((c) => [c.provider, c.model, c.confidence, c.rates.map((r) => `${r.unit} ${r.usdPerUnit}`)])).toEqual([
      ['higgsfield', KLING_PRO_I2V, 'LIST_PRICE', ['VIDEO_SECONDS 0.168', 'IMAGES 0.0057']],
      ['archival', 'archival-item', 'ASSUMPTION', []],
    ]);
    expect(() => visualPricingSnapshot(catalog, [{ provider: 'acme', model: 'x' }])).toThrow(/no provider "acme"/);
  });

  it('describes every method with its treatments and candidates, and every card with its prices', () => {
    const view = describeVisualCatalog(catalog);
    expect(view.version).toBe(CATALOG_VERSION);
    expect(view.methods.map((m) => m.method)).toEqual([...PRODUCTION_METHODS]);
    expect(view.methods.find((m) => m.method === 'DETERMINISTIC_GRAPHIC')).toEqual({ method: 'DETERMINISTIC_GRAPHIC', treatments: ['DATA_VISUALIZATION', 'TIMELINE', 'DIAGRAM', 'INFOGRAPHIC'], candidates: 1 });
    expect(view.methods.every((m) => m.candidates > 0)).toBe(true);
    expect(view.bases).toEqual(['ESTIMATED', 'UNPRICED', 'MOCK']);
    const hf = view.cards.find((c) => c.provider === 'higgsfield')!;
    expect(hf.models.find((m) => m.model === KLING_25)!.clip).toEqual({ minSec: 5, maxSec: 10, billableSec: [5, 10] });
    expect(hf.rates.every((r) => r.source.length > 0)).toBe(true);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});

describe('the seeded visual presets', () => {
  it('name no provider or model (U4: providerPreferences stays empty until the user sets one)', () => {
    for (const preset of VISUAL_PROFILE_PRESETS) expect(preset.config.providerPreferences).toEqual({});
  });
});
