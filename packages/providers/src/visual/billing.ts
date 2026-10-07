import type { AspectRatio, BilledUsageRequest, ProductionMethod, Rate, UsageItem, UsageUnit, VisualModelCard } from '@docengine/core';

/**
 * How a visual model bills one generation of a shot. Instance-free: no
 * client, no credentials, no call. A card prices the usage with its rates
 * (estimateCost); usage with no rate is UNPRICED, never $0.
 */

/** A card's price list, frozen down to each rate: no estimate or view can change a price. */
export function priceList(rates: readonly Rate[]): readonly Rate[] {
  return Object.freeze(rates.map((r) => Object.freeze({ ...r })));
}

/** The clip lengths a model generates, shortest first (seconds). */
export interface ClipSpec {
  minSec: number;
  maxSec: number;
  billableSec: readonly number[];
}

/** Clips of any whole number of seconds from minSec to maxSec. */
export function clipRange(minSec: number, maxSec: number): ClipSpec {
  if (!Number.isInteger(minSec) || !Number.isInteger(maxSec) || minSec < 1 || maxSec < minSec) throw new RangeError(`Invalid clip range ${minSec}–${maxSec} s`);
  return clipLengths(Array.from({ length: maxSec - minSec + 1 }, (_, i) => minSec + i));
}

/** A length of seconds in whole milliseconds; NaN when it is not a whole number of them. */
function wholeMs(sec: number): number {
  const ms = Math.round(sec * 1000);
  return Math.abs(sec * 1000 - ms) < 1e-6 ? ms : Number.NaN;
}

/** Clips of exactly these lengths, e.g. [5, 10]: an 8 s shot bills a 10 s clip. Lengths are whole milliseconds, so billing never drifts. */
export function clipLengths(lengths: readonly number[]): ClipSpec {
  if (lengths.length === 0 || lengths.some((l, i) => !(wholeMs(l) >= 1) || (i > 0 && l <= lengths[i - 1]!))) {
    throw new RangeError(`Clip lengths must be ascending whole milliseconds, at least 1 ms: [${lengths.join(', ')}]`);
  }
  return Object.freeze({ minSec: lengths[0]!, maxSec: lengths.at(-1)!, billableSec: Object.freeze([...lengths]) });
}

function checkDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new RangeError(`Invalid shot duration: ${durationSec} s`);
  return Math.round(durationSec * 1000) / 1000;
}

/** The least total of exactly `clips` billable lengths that covers `needMs` (integer ms, so no float drift). */
function leastCover(lengths: readonly number[], clips: number, needMs: number): number {
  const ms = lengths.map((l) => Math.round(l * 1000));
  let sums = new Set([0]);
  for (let i = 0; i < clips; i++) {
    const next = new Set<number>();
    for (const s of sums) for (const l of ms) next.add(s + l);
    sums = next;
  }
  let best = Infinity;
  for (const s of sums) if (s >= needMs && s < best) best = s;
  return best / 1000;
}

/**
 * What a shot of `durationSec` is billed as on a model's clips: the fewest
 * clips that cover it (⌈d / maxSec⌉, counted in whole milliseconds), with
 * lengths chosen to bill the least (an 8 s shot on [5, 10] bills 10 s; 18 s
 * on [5, 10] bills two clips, 20 s; 16 s on 3–15 s bills two 8 s clips). No
 * clip spec: billed exactly.
 */
export function billedClips(durationSec: number, clip: ClipSpec | null): { clips: number; seconds: number } {
  const d = checkDuration(durationSec);
  if (d === 0) return { clips: 0, seconds: 0 };
  if (!clip) return { clips: 1, seconds: d };
  const needMs = Math.round(d * 1000);
  const clips = Math.ceil(needMs / Math.round(clip.maxSec * 1000));
  return { clips, seconds: leastCover(clip.billableSec, clips, needMs) };
}

/**
 * How each method is billed: generated video by the clip second (image to
 * video adds one still per clip), a generated still per image (STILL_MOTION
 * moves it in the edit), a sourced record per item, and in-house renders and
 * edits by the rendered second.
 */
type Billing = 'CLIP' | 'STILL_AND_CLIP' | 'STILL' | 'ITEM' | 'RENDER';
const METHOD_BILLING: Readonly<Record<ProductionMethod, Billing>> = {
  GENERATIVE_VIDEO: 'CLIP',
  IMAGE_TO_VIDEO: 'STILL_AND_CLIP',
  GENERATIVE_IMAGE: 'STILL',
  STILL_MOTION: 'STILL',
  DETERMINISTIC_GRAPHIC: 'RENDER',
  MAP_RENDER: 'RENDER',
  DOCUMENT_MOTION: 'ITEM',
  ARCHIVAL_SOURCING: 'ITEM',
  STOCK_SOURCING: 'ITEM',
  SCREEN_RECORDING: 'RENDER',
  MOTION_DESIGN: 'RENDER',
  EDIT_TIME: 'RENDER',
};

/** The usage of one generation of a shot by a method, one item per component (an IMAGE_TO_VIDEO shot: its stills, then its clip seconds). */
export function usageFor(method: ProductionMethod, durationSec: number, clip: ClipSpec | null): UsageItem[] {
  switch (METHOD_BILLING[method]) {
    case 'CLIP': {
      const { seconds } = billedClips(durationSec, clip);
      return seconds > 0 ? [{ unit: 'VIDEO_SECONDS', quantity: seconds }] : [];
    }
    case 'STILL_AND_CLIP': {
      const { clips, seconds } = billedClips(durationSec, clip);
      return clips > 0 ? [{ unit: 'IMAGES', quantity: clips }, { unit: 'VIDEO_SECONDS', quantity: seconds }] : [];
    }
    case 'STILL':
      checkDuration(durationSec);
      return [{ unit: 'IMAGES', quantity: 1 }];
    case 'ITEM':
      checkDuration(durationSec);
      return [{ unit: 'REQUESTS', quantity: 1 }];
    case 'RENDER': {
      const { seconds } = billedClips(durationSec, null);
      return seconds > 0 ? [{ unit: 'VIDEO_SECONDS', quantity: seconds }] : [];
    }
  }
}

/** The units a method is billed in: a price in any other unit never applies to it. */
export function billedUnits(method: ProductionMethod): UsageUnit[] {
  return usageFor(method, 1, null).map((u) => u.unit);
}

/**
 * A model as its card lists it; billedUsage is derived from its methods and
 * clips. A model bills what it makes at its own resolution, whatever the
 * request asks: the router reads `resolutions` to judge the fit.
 */
export interface VisualModelSpec {
  model: string;
  label: string;
  methods: readonly ProductionMethod[];
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly string[];
  clip: ClipSpec | null;
}

export function visualModel(provider: string, spec: VisualModelSpec): VisualModelCard {
  const { model, label, clip } = spec;
  const methods = Object.freeze([...spec.methods]);
  return Object.freeze({
    provider,
    model,
    label,
    methods,
    aspectRatios: Object.freeze([...spec.aspectRatios]),
    resolutions: Object.freeze([...spec.resolutions]),
    clip,
    known: true,
    billedUsage(req: BilledUsageRequest): UsageItem[] {
      if (!methods.includes(req.method)) throw new RangeError(`${provider} ${model} does not produce ${req.method}`);
      return usageFor(req.method, req.durationSec, clip);
    },
  });
}

/**
 * The conservative fallback for a model the catalog does not know (a
 * profile may name one): it vouches for no method, frame or resolution, and
 * bills whole seconds rounded up for any method asked of it. Its usage is
 * priced only by a rate its provider's card sets for every model (a plan
 * price), else it is UNPRICED.
 */
export function unknownVisualModel(provider: string, model: string): VisualModelCard {
  return Object.freeze({
    provider,
    model,
    label: `${model} (not in the catalog)`,
    methods: Object.freeze([]),
    aspectRatios: Object.freeze([]),
    resolutions: Object.freeze([]),
    clip: null,
    known: false,
    billedUsage: (req: BilledUsageRequest): UsageItem[] => usageFor(req.method, Math.ceil(checkDuration(req.durationSec)), null),
  });
}
