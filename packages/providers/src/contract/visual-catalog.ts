/**
 * The VisualCatalog contract: what every catalog the storyboard costs with
 * must hold, whatever its cards and the user's prices. Every price is
 * sourced, dated and attributed to the card that sets it; every model bills
 * the whole shot and never a method it does not make; every production
 * method has a candidate; a model the catalog does not know is never priced
 * by another model's rate.
 */
import { ASPECT_RATIOS, PRICE_CONFIDENCES, PRODUCTION_METHODS, PriceCheckDate, PriceSource, USAGE_UNITS, estimateCost, type VisualCatalog } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { findVisualModel, visualPricingSnapshot } from '../visual/catalog.ts';

type Factory<T> = () => T | Promise<T>;

/** Shot lengths every model is billed for: short, fractional, on and off clip lengths, over a clip's maximum. */
const DURATIONS = [0.7, 3, 7.4, 8, 10, 10.2, 18, 60.5];

export function runVisualCatalogContract(name: string, factory: Factory<VisualCatalog>) {
  describe(`VisualCatalog contract: ${name}`, () => {
    it('names its version, and each provider and each of its models once', async () => {
      const catalog = await factory();
      expect(catalog.version).toMatch(/\S/);
      expect(catalog.cards.length).toBeGreaterThan(0);
      const providers = catalog.cards.map((c) => c.provider);
      expect(new Set(providers).size).toBe(providers.length);
      for (const card of catalog.cards) {
        expect(card.label).toMatch(/\S/);
        const models = card.models.map((m) => m.model);
        expect(new Set(models).size).toBe(models.length);
        for (const m of card.models) expect(m.provider).toBe(card.provider);
      }
    });

    it('sources and dates every price, and attributes each rate to its own card', async () => {
      const catalog = await factory();
      for (const card of catalog.cards) {
        expect(PriceSource.safeParse(card.pricing.source).success).toBe(true);
        expect(PriceCheckDate.safeParse(card.pricing.checkedAt).success).toBe(true);
        expect(PRICE_CONFIDENCES).toContain(card.pricing.confidence);
        const models = new Set(card.models.map((m) => m.model));
        const keys = new Set<string>();
        for (const rate of card.rates) {
          expect(rate.provider).toBe(card.provider);
          expect(Number.isFinite(rate.usdPerUnit) && rate.usdPerUnit >= 0).toBe(true);
          expect(USAGE_UNITS).toContain(rate.unit);
          // An estimate line takes its check date and confidence from the card: every rate on it was checked that day.
          expect(rate.source).toMatch(/\S.*\(checked \d{4}-\d{2}-\d{2}\b/);
          expect(rate.source).toContain(`(checked ${card.pricing.checkedAt}`);
          expect(PriceSource.safeParse(rate.source).success).toBe(true);
          if (rate.model !== undefined) expect(models.has(rate.model)).toBe(true);
          // A price in a unit its models are never billed in would never apply.
          const priced = card.models.filter((m) => rate.model === undefined || m.model === rate.model);
          const units = new Set(priced.flatMap((m) => m.methods.flatMap((method) => m.billedUsage({ durationSec: 8, resolution: m.resolutions[0]!, method }).map((u) => u.unit))));
          expect(units.has(rate.unit), `${card.provider} ${rate.model ?? '(every model)'} ${rate.unit}`).toBe(true);
          const key = `${rate.model ?? ''} ${rate.unit}`;
          expect(keys.has(key)).toBe(false);
          keys.add(key);
        }
      }
    });

    it('says what each model makes, in which frames and resolutions, and on which clip lengths', async () => {
      const catalog = await factory();
      for (const m of catalog.cards.flatMap((c) => c.models)) {
        expect(m.known).toBe(true);
        expect(m.label).toMatch(/\S/);
        expect(m.methods.length).toBeGreaterThan(0);
        for (const method of m.methods) expect(PRODUCTION_METHODS).toContain(method);
        expect(m.aspectRatios.length).toBeGreaterThan(0);
        for (const ratio of m.aspectRatios) expect(ASPECT_RATIOS).toContain(ratio);
        expect(m.resolutions.length).toBeGreaterThan(0);
        if (m.clip) {
          const { minSec, maxSec, billableSec } = m.clip;
          expect(billableSec[0]).toBe(minSec);
          expect(billableSec.at(-1)).toBe(maxSec);
          for (let i = 1; i < billableSec.length; i++) expect(billableSec[i]!).toBeGreaterThan(billableSec[i - 1]!);
        }
      }
    });

    it('bills every method a model makes for the whole shot, never negative, the same each time', async () => {
      const catalog = await factory();
      for (const m of catalog.cards.flatMap((c) => c.models)) {
        for (const method of m.methods) {
          let lastSeconds = 0;
          for (const durationSec of DURATIONS) {
            const usage = m.billedUsage({ durationSec, resolution: m.resolutions[0]!, method });
            expect(m.billedUsage({ durationSec, resolution: m.resolutions[0]!, method })).toEqual(usage);
            for (const u of usage) {
              expect(USAGE_UNITS).toContain(u.unit);
              expect(Number.isFinite(u.quantity) && u.quantity >= 0).toBe(true);
            }
            const seconds = usage.find((u) => u.unit === 'VIDEO_SECONDS')?.quantity;
            if (seconds !== undefined) {
              expect(seconds).toBeGreaterThanOrEqual(durationSec);
              expect(seconds).toBeGreaterThanOrEqual(lastSeconds);
              lastSeconds = seconds;
            }
          }
          expect(() => m.billedUsage({ durationSec: -1, resolution: m.resolutions[0]!, method })).toThrow(RangeError);
          expect(() => m.billedUsage({ durationSec: Number.NaN, resolution: m.resolutions[0]!, method })).toThrow(RangeError);
        }
      }
    });

    it('refuses to bill a method a model does not make', async () => {
      const catalog = await factory();
      for (const m of catalog.cards.flatMap((c) => c.models)) {
        const other = PRODUCTION_METHODS.find((method) => !m.methods.includes(method));
        if (other) expect(() => m.billedUsage({ durationSec: 8, resolution: m.resolutions[0]!, method: other })).toThrow(RangeError);
      }
    });

    it('offers every production method, listing exactly the models that make it in card order', async () => {
      const catalog = await factory();
      for (const method of PRODUCTION_METHODS) {
        const candidates = catalog.forMethod(method);
        expect(candidates.length).toBeGreaterThan(0);
        const expected = catalog.cards.flatMap((card) => card.models.filter((m) => m.methods.includes(method)).map((m) => `${card.provider}/${m.model}`));
        expect(candidates.map((c) => `${c.card.provider}/${c.model.model}`)).toEqual(expected);
        for (const c of candidates) expect(catalog.cards).toContain(c.card);
      }
    });

    it('freezes into a pricing snapshot the storyboard contract accepts', async () => {
      const catalog = await factory();
      const snapshot = visualPricingSnapshot(catalog);
      expect(snapshot.catalogVersion).toBe(catalog.version);
      expect(snapshot.cards).toHaveLength(catalog.cards.flatMap((c) => c.models).length);
      for (const entry of snapshot.cards) {
        const card = catalog.cards.find((c) => c.provider === entry.provider)!;
        expect(entry).toMatchObject({ source: card.pricing.source, checkedAt: card.pricing.checkedAt, confidence: card.pricing.confidence });
        for (const r of entry.rates) expect(card.rates).toContainEqual(expect.objectContaining({ unit: r.unit, usdPerUnit: r.usdPerUnit, source: r.source, ...(r.model !== null ? { model: r.model } : {}) }));
      }
    });

    it('falls back conservatively for a model it does not know, priced by no other model\'s rate', async () => {
      const catalog = await factory();
      expect(findVisualModel(catalog, 'no-such-provider', 'x')).toBeNull();
      for (const card of catalog.cards) {
        const found = findVisualModel(catalog, card.provider, 'not-a-catalogued-model')!;
        expect(found.card).toBe(card);
        expect(found.model).toMatchObject({ known: false, methods: [], aspectRatios: [], resolutions: [], clip: null });
        const usage = found.model.billedUsage({ durationSec: 7.4, resolution: '1080p', method: 'GENERATIVE_VIDEO' });
        expect(usage).toEqual([{ unit: 'VIDEO_SECONDS', quantity: 8 }]);
        const providerWide = card.rates.some((r) => r.model === undefined && r.unit === 'VIDEO_SECONDS');
        expect(estimateCost(card.provider, found.model.model, usage, card.rates).unpriced.length).toBe(providerWide ? 0 : 1);
      }
    });
  });
}
