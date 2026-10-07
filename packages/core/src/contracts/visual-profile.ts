import { z } from 'zod';
import {
  ARCHIVAL_PREFERENCES,
  ASPECT_RATIOS,
  CAMERA_STYLES,
  FILM_GRAINS,
  GRAPHICS_PREFERENCES,
  MOTION_INTENSITIES,
  PRODUCTION_METHODS,
  VISUAL_APPROACHES,
  VISUAL_DENSITIES,
  VISUAL_REALISMS,
  VISUAL_RESOLUTIONS,
} from '../enums.ts';

/**
 * Visual Style Profiles: the look of a documentary, saved and reused like a
 * voice profile. A family has immutable versions; a project chooses one
 * (following its current version, pinned to one, or the library default) and
 * may override settings on its choice without changing the profile. Every
 * storyboard version freezes the effective configuration it was planned with.
 *
 * Provider-neutral: realism, camera language, lenses, colour, light, grain,
 * frame, motion, density, archival and graphics preferences, generation
 * limits, the default approach and a cost ceiling. Provider and model
 * preferences are free strings checked against the visual catalog (an
 * unknown one is a warning, never a vendor enum).
 */

const Text = z.string().trim().max(200);
const Words = z.array(z.string().trim().min(1).max(60)).max(8);

/** A provider (and model) a production method should be recommended first. */
export const ProviderPreference = z.object({ provider: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(100).optional() });
export type ProviderPreference = z.infer<typeof ProviderPreference>;

export const VisualStyleProfileConfig = z.object({
  realism: z.enum(VISUAL_REALISMS),
  cameraLanguage: z.object({ style: z.enum(CAMERA_STYLES), note: Text }),
  /** Focal lengths or lens character ("35mm", "long-lens compression"). */
  lenses: Words,
  colour: z.object({ treatment: Text, palette: Words }),
  lighting: Text,
  filmGrain: z.enum(FILM_GRAINS),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(VISUAL_RESOLUTIONS),
  motionIntensity: z.enum(MOTION_INTENSITIES),
  density: z.enum(VISUAL_DENSITIES),
  archival: z.enum(ARCHIVAL_PREFERENCES),
  graphics: z.enum(GRAPHICS_PREFERENCES),
  generation: z.object({
    /** Share of the runtime (0–1) generated video may cover before GENERATED_VIDEO_SHARE warns. */
    maxGeneratedVideoShare: z.number().min(0).max(1),
    /** Prefer an animated still to generated video where the treatment allows both. */
    preferStillMotion: z.boolean(),
    /** Reroll allowances per method, over DEFAULT_REROLLS. */
    rerolls: z.partialRecord(z.enum(PRODUCTION_METHODS), z.number().min(0).max(10)),
  }),
  /** The approach a new storyboard plans in full (the other two are costed beside it). */
  approach: z.enum(VISUAL_APPROACHES),
  /** Providers (and models) to recommend first, per method, in order. The presets name none. */
  providerPreferences: z.partialRecord(z.enum(PRODUCTION_METHODS), z.array(ProviderPreference).max(6)),
  /** COST_HIGH warns above either (null: no ceiling). */
  costCeilingUsd: z.object({ perFinishedMinute: z.number().min(0).nullable(), total: z.number().min(0).nullable() }),
  notes: z.string().trim().max(1000),
});
export type VisualStyleProfileConfig = z.infer<typeof VisualStyleProfileConfig>;

const shape = VisualStyleProfileConfig.shape;

/**
 * What a project sets over its chosen profile version: any setting, nested
 * objects key by key. Stored on the project's selection, never on the
 * profile. Strict: a key it does not take is refused, never dropped.
 */
export const VisualConfigOverrides = z
  .object({
    realism: shape.realism.optional(),
    cameraLanguage: shape.cameraLanguage.partial().strict().optional(),
    lenses: shape.lenses.optional(),
    colour: shape.colour.partial().strict().optional(),
    lighting: shape.lighting.optional(),
    filmGrain: shape.filmGrain.optional(),
    aspectRatio: shape.aspectRatio.optional(),
    resolution: shape.resolution.optional(),
    motionIntensity: shape.motionIntensity.optional(),
    density: shape.density.optional(),
    archival: shape.archival.optional(),
    graphics: shape.graphics.optional(),
    generation: shape.generation.partial().strict().optional(),
    approach: shape.approach.optional(),
    providerPreferences: shape.providerPreferences.optional(),
    costCeilingUsd: shape.costCeilingUsd.partial().strict().optional(),
    notes: shape.notes.optional(),
  })
  .strict();
export type VisualConfigOverrides = z.infer<typeof VisualConfigOverrides>;

/** How a version was made. */
export const VisualProfileOrigin = z.discriminatedUnion('kind', [
  /** One of the seeded presets (VISUAL_PROFILE_PRESETS), made at the library's first use. */
  z.object({ kind: z.literal('PRESET'), preset: z.string() }),
  /** From DEFAULT_VISUAL_PROFILE_CONFIG. */
  z.object({ kind: z.literal('DEFAULTS') }),
  /** Created in the library. */
  z.object({ kind: z.literal('LIBRARY') }),
  /** An edit: a new version of its family based on another. */
  z.object({ kind: z.literal('EDIT'), basedOnVersion: z.number().int() }),
  /** The first version of a new family, copied from another family's version. */
  z.object({ kind: z.literal('DUPLICATE'), fromFamily: z.string(), fromVersion: z.number().int() }),
]);
export type VisualProfileOrigin = z.infer<typeof VisualProfileOrigin>;

/** How a project's profile version is chosen: following a family's current version, pinned to one, or the library default. */
export const VISUAL_SELECTION_MODES = ['FOLLOW', 'PIN', 'DEFAULT'] as const;
export type VisualSelectionMode = (typeof VISUAL_SELECTION_MODES)[number];

/** Where an effective setting came from: the profile version, or the project's overrides. */
export const VISUAL_CONFIG_SOURCES = ['PROFILE', 'PROJECT'] as const;
export type VisualConfigSource = (typeof VISUAL_CONFIG_SOURCES)[number];

/** Where each setting that is not the profile version's came from, by path ("density", "generation.maxGeneratedVideoShare"). */
export const VisualConfigProvenance = z.record(z.string(), z.enum(VISUAL_CONFIG_SOURCES));
export type VisualConfigProvenance = z.infer<typeof VisualConfigProvenance>;

/** The profile a storyboard version was planned with, frozen into it. */
export const VisualProfileSnapshot = z.object({
  mode: z.enum(VISUAL_SELECTION_MODES),
  /** The project's selection revision it was resolved at (0: no choice made yet). */
  revision: z.number().int().min(0),
  familyId: z.string(),
  familyName: z.string(),
  profileId: z.string(),
  /** The version's own name, as it was made. */
  name: z.string(),
  version: z.number().int().min(1),
  overrides: VisualConfigOverrides,
  effective: VisualStyleProfileConfig,
  provenance: VisualConfigProvenance,
});
export type VisualProfileSnapshot = z.infer<typeof VisualProfileSnapshot>;

/** A seeded preset: provider-neutral settings, no provider or model preference (the user adds those). */
export interface VisualProfilePreset {
  /** Stable key, recorded in the origin of the version made from it. */
  key: string;
  name: string;
  description: string;
  config: VisualStyleProfileConfig;
}

const NO_CEILING = { perFinishedMinute: null, total: null };

/** Freezes an object and every object in it. */
function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/**
 * The five presets of brief §21, created in the library on first use. The
 * first is the library default until the user chooses another; the effective
 * profile of a project that has chosen none is the library default.
 */
export const VISUAL_PROFILE_PRESETS: readonly VisualProfilePreset[] = deepFreeze([
  {
    key: 'cinematic-history',
    name: 'Cinematic History',
    description: 'Period reconstruction with classical camera work, warm natural light and documents where the record exists.',
    config: {
      realism: 'CINEMATIC',
      cameraLanguage: { style: 'CLASSICAL', note: 'Composed frames, slow deliberate moves; wide to establish, close for detail.' },
      lenses: ['24mm', '35mm', '50mm', '85mm'],
      colour: { treatment: 'Warm, slightly desaturated period palette', palette: ['umber', 'ochre', 'slate', 'candlelight amber'] },
      lighting: 'Natural and practical light: window light by day, candle and fire light at night.',
      filmGrain: 'LIGHT',
      aspectRatio: '16:9',
      resolution: '1080p',
      motionIntensity: 'MEDIUM',
      density: 'BALANCED',
      archival: 'WHEN_AVAILABLE',
      graphics: 'BALANCED',
      generation: { maxGeneratedVideoShare: 0.5, preferStillMotion: false, rerolls: {} },
      approach: 'C',
      providerPreferences: {},
      costCeilingUsd: NO_CEILING,
      notes: '',
    },
  },
  {
    key: 'corporate-investigative',
    name: 'Corporate Investigative',
    description: 'Documents, data and sourced footage first; restrained, clean reconstruction only where the record is silent.',
    config: {
      realism: 'PHOTOREAL',
      cameraLanguage: { style: 'OBSERVATIONAL', note: 'Steady, unshowy framing; slow push-ins on documents and figures.' },
      lenses: ['35mm', '50mm', 'macro for documents'],
      colour: { treatment: 'Cool, neutral and clean', palette: ['steel blue', 'graphite', 'paper white'] },
      lighting: 'Soft, even office and overcast daylight.',
      filmGrain: 'NONE',
      aspectRatio: '16:9',
      resolution: '1080p',
      motionIntensity: 'LOW',
      density: 'BALANCED',
      archival: 'PREFER',
      graphics: 'RICH',
      generation: { maxGeneratedVideoShare: 0.25, preferStillMotion: true, rerolls: {} },
      approach: 'B',
      providerPreferences: {},
      costCeilingUsd: NO_CEILING,
      notes: '',
    },
  },
  {
    key: 'dark-true-crime',
    name: 'Dark True Crime',
    description: 'Low-key, high-contrast reconstruction held back by the evidence: places, objects and records more than faces.',
    config: {
      realism: 'CINEMATIC',
      cameraLanguage: { style: 'STYLISED', note: 'Slow creeping moves, partial frames, faces kept out of reach.' },
      lenses: ['35mm', '85mm', 'long-lens compression'],
      colour: { treatment: 'Low-key, desaturated with deep shadows', palette: ['ink black', 'sodium orange', 'cold teal'] },
      lighting: 'Hard single sources, pools of light, night exteriors.',
      filmGrain: 'MEDIUM',
      aspectRatio: '16:9',
      resolution: '1080p',
      motionIntensity: 'MEDIUM',
      density: 'SPARSE',
      archival: 'PREFER',
      graphics: 'MINIMAL',
      generation: { maxGeneratedVideoShare: 0.4, preferStillMotion: false, rerolls: {} },
      approach: 'C',
      providerPreferences: {},
      costCeilingUsd: NO_CEILING,
      notes: '',
    },
  },
  {
    key: 'clean-business-explainer',
    name: 'Clean Business Explainer',
    description: 'Clear graphics, products and data on a clean ground; motion design over footage.',
    config: {
      realism: 'GRAPHIC',
      cameraLanguage: { style: 'MINIMAL', note: 'Locked frames and simple moves that follow the information.' },
      lenses: ['50mm', 'macro for products'],
      colour: { treatment: 'Bright, clean and brand-neutral', palette: ['white', 'charcoal', 'one accent colour'] },
      lighting: 'Even, soft studio light.',
      filmGrain: 'NONE',
      aspectRatio: '16:9',
      resolution: '1080p',
      motionIntensity: 'MEDIUM',
      density: 'DENSE',
      archival: 'WHEN_AVAILABLE',
      graphics: 'RICH',
      generation: { maxGeneratedVideoShare: 0.15, preferStillMotion: true, rerolls: {} },
      approach: 'B',
      providerPreferences: {},
      costCeilingUsd: NO_CEILING,
      notes: '',
    },
  },
  {
    key: 'retro-documentary',
    name: 'Retro Documentary',
    description: 'Archival-led, the look of a broadcast documentary of an earlier age: stills moved slowly, heavy grain, faded colour.',
    config: {
      realism: 'CINEMATIC',
      cameraLanguage: { style: 'OBSERVATIONAL', note: 'Slow pans and zooms across stills; long holds.' },
      lenses: ['zoom lens', '50mm'],
      colour: { treatment: 'Faded film stock, lifted blacks', palette: ['faded teal', 'warm sepia', 'cream'] },
      lighting: 'Available light.',
      filmGrain: 'HEAVY',
      aspectRatio: '16:9',
      resolution: '1080p',
      motionIntensity: 'LOW',
      density: 'SPARSE',
      archival: 'PREFER',
      graphics: 'MINIMAL',
      generation: { maxGeneratedVideoShare: 0.3, preferStillMotion: true, rerolls: {} },
      approach: 'B',
      providerPreferences: {},
      costCeilingUsd: NO_CEILING,
      notes: '',
    },
  },
]);

/** The library default until the user chooses another. */
export const DEFAULT_VISUAL_PRESET = 'cinematic-history';

/** A new profile's starting point: the default preset's settings (frozen; copy before changing). */
export const DEFAULT_VISUAL_PROFILE_CONFIG: VisualStyleProfileConfig = VISUAL_PROFILE_PRESETS.find((p) => p.key === DEFAULT_VISUAL_PRESET)!.config;
