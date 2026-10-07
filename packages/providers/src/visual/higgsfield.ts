import type { AspectRatio, Rate, VisualProviderCard } from '@docengine/core';
import { clipLengths, clipRange, priceList, visualModel } from './billing.ts';

/**
 * Higgsfield's pay-as-you-go API (open.higgsfield.ai): the generated video
 * and still endpoints a storyboard can recommend, at the published list
 * ("standard") prices. Video is billed per second of the requested clip,
 * stills per image. Each model id is the API endpoint a later adapter calls.
 *
 * Checked 2026-10-06 on the API pricing page and each model's page. The API
 * then billed 50% off the video list prices, with no stated end date: a
 * forecast uses the list price, and a plan's own price is set with
 * VISUAL_PRICE_OVERRIDES (PLAN_PRICE). Veo is not on the API's price list,
 * so it is not catalogued; nor are endpoints whose price varies with a
 * setting a shot does not fix (quality tiers, batch sizes).
 */

const PROVIDER = 'higgsfield';
const CHECKED = '2026-10-06';
const PRICING_PAGE = 'https://open.higgsfield.ai/pricing';
const DISCOUNT = 'billed 50% off at the check, no end date stated';

const KLING_FRAMES: readonly AspectRatio[] = ['16:9', '9:16', '1:1'];
const STILL = 'higgsfield-ai/soul/v2/standard';
const STILL_USD = 0.0057;

const page = (model: string) => `https://open.higgsfield.ai/models/${model}`;
const source = (model: string, note: string) => `${page(model)} (checked ${CHECKED}; ${note})`;

const perSecond = (model: string, usd: number, note: string): Rate => ({ provider: PROVIDER, model, unit: 'VIDEO_SECONDS', usdPerUnit: usd, source: source(model, `list price $${usd}/s ${note}; ${DISCOUNT}`) });
const stillPrice: Rate = { provider: PROVIDER, model: STILL, unit: 'IMAGES', usdPerUnit: STILL_USD, source: source(STILL, `list price $${STILL_USD} per image at 1080p; no discount listed`) };
/** An image-to-video shot's source stills, made with the still endpoint. */
const sourceStill = (model: string): Rate => ({ provider: PROVIDER, model, unit: 'IMAGES', usdPerUnit: STILL_USD, source: source(STILL, `the source still: list price $${STILL_USD} per image at 1080p`) });

const KLING_3_PRO_T2V = 'kling-video/v3.0/pro/text-to-video';
const KLING_3_PRO_I2V = 'kling-video/v3.0/pro/image-to-video';
const KLING_3_TURBO_T2V = 'kling-video/v3.0-turbo/text-to-video';
const KLING_3_TURBO_I2V = 'kling-video/v3.0-turbo/image-to-video';
const KLING_25_PRO_T2V = 'kling-video/v2.5-turbo/pro/text-to-video';
const KLING_25_PRO_I2V = 'kling-video/v2.5-turbo/pro/image-to-video';
const KLING_3_4K_T2V = 'kling-video/v3.0/4k/text-to-video';

export const HIGGSFIELD_CARD: VisualProviderCard = Object.freeze({
  provider: PROVIDER,
  label: 'Higgsfield API',
  implemented: false,
  // Catalog order is the router's fallback order: the 1080p flagship first.
  models: Object.freeze([
    // Kling 3.0 Pro renders 1080p (Kling's Pro tier; the vendor page gives no resolution). Whole seconds, 3–15 s.
    visualModel(PROVIDER, { model: KLING_3_PRO_T2V, label: 'Kling 3.0 Pro · text to video', methods: ['GENERATIVE_VIDEO'], aspectRatios: KLING_FRAMES, resolutions: ['1080p'], clip: clipRange(3, 15) }),
    // Image to video follows the source still's frame; Kling 3.0 documents 16:9, 9:16 and 1:1.
    visualModel(PROVIDER, { model: KLING_3_PRO_I2V, label: 'Kling 3.0 Pro · image to video', methods: ['IMAGE_TO_VIDEO'], aspectRatios: KLING_FRAMES, resolutions: ['1080p'], clip: clipRange(3, 15) }),
    visualModel(PROVIDER, { model: KLING_3_TURBO_T2V, label: 'Kling 3.0 Turbo · text to video (1080p)', methods: ['GENERATIVE_VIDEO'], aspectRatios: KLING_FRAMES, resolutions: ['1080p'], clip: clipRange(3, 15) }),
    visualModel(PROVIDER, { model: KLING_3_TURBO_I2V, label: 'Kling 3.0 Turbo · image to video (1080p)', methods: ['IMAGE_TO_VIDEO'], aspectRatios: KLING_FRAMES, resolutions: ['1080p'], clip: clipRange(3, 15) }),
    // 5 or 10 s clips. The request takes no aspect ratio: 16:9 only is assumed.
    visualModel(PROVIDER, { model: KLING_25_PRO_T2V, label: 'Kling 2.5 Turbo Pro · text to video', methods: ['GENERATIVE_VIDEO'], aspectRatios: ['16:9'], resolutions: ['1080p'], clip: clipLengths([5, 10]) }),
    visualModel(PROVIDER, { model: KLING_25_PRO_I2V, label: 'Kling 2.5 Turbo Pro · image to video', methods: ['IMAGE_TO_VIDEO'], aspectRatios: ['16:9'], resolutions: ['1080p'], clip: clipLengths([5, 10]) }),
    visualModel(PROVIDER, { model: KLING_3_4K_T2V, label: 'Kling 3.0 4K · text to video', methods: ['GENERATIVE_VIDEO'], aspectRatios: KLING_FRAMES, resolutions: ['2160p'], clip: clipRange(3, 15) }),
    // The still route: Soul 2 at 1080p (also 720p, at $0.0032, not used).
    visualModel(PROVIDER, { model: STILL, label: 'Soul 2 · still image (1080p)', methods: ['GENERATIVE_IMAGE', 'STILL_MOTION'], aspectRatios: ['16:9', '9:16', '4:3', '1:1'], resolutions: ['1080p'], clip: null }),
  ]),
  rates: priceList([
    perSecond(KLING_3_PRO_T2V, 0.168, 'for 3–15 s clips'),
    perSecond(KLING_3_PRO_I2V, 0.168, 'for 3–15 s clips'),
    sourceStill(KLING_3_PRO_I2V),
    perSecond(KLING_3_TURBO_T2V, 0.14, 'at 1080p'),
    perSecond(KLING_3_TURBO_I2V, 0.14, 'at 1080p'),
    sourceStill(KLING_3_TURBO_I2V),
    perSecond(KLING_25_PRO_T2V, 0.07, 'at 1080p, 5 or 10 s clips'),
    perSecond(KLING_25_PRO_I2V, 0.07, 'at 1080p, 5 or 10 s clips'),
    sourceStill(KLING_25_PRO_I2V),
    perSecond(KLING_3_4K_T2V, 0.42, 'for 3–15 s clips'),
    stillPrice,
  ]),
  pricing: Object.freeze({ source: `${PRICING_PAGE} and each model's page (list prices)`, checkedAt: CHECKED, confidence: 'LIST_PRICE' }),
});
