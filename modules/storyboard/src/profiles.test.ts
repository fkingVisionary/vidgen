import { DEFAULT_VISUAL_PROFILE_CONFIG, VISUAL_PROFILE_PRESETS } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { applyOverrides, configDifferences, unknownPreferences } from './profiles.ts';
import { acmeCatalog } from './testing.ts';

/**
 * A visual profile's settings with a project's overrides over them (nested
 * objects key by key, lists whole), where each overridden setting came
 * from, what differs between two versions, and provider preferences the
 * catalog does not know (notices, never errors).
 */

const base = DEFAULT_VISUAL_PROFILE_CONFIG;

describe('profile settings and overrides', () => {
  it('lays overrides over the settings key by key, a list whole, and says where each came from', () => {
    const { effective, provenance } = applyOverrides(base, {
      density: 'DENSE',
      colour: { palette: ['ink', 'bone'] },
      generation: { rerolls: { GENERATIVE_VIDEO: 2 }, maxGeneratedVideoShare: 0.1 },
      costCeilingUsd: { total: 40 },
    });
    expect(effective.density).toBe('DENSE');
    expect(effective.colour).toEqual({ treatment: base.colour.treatment, palette: ['ink', 'bone'] });
    expect(effective.generation).toEqual({ maxGeneratedVideoShare: 0.1, preferStillMotion: base.generation.preferStillMotion, rerolls: { GENERATIVE_VIDEO: 2 } });
    expect(effective.costCeilingUsd).toEqual({ perFinishedMinute: null, total: 40 });
    expect(provenance).toEqual({ density: 'PROJECT', 'colour.palette': 'PROJECT', 'generation.rerolls.GENERATIVE_VIDEO': 'PROJECT', 'generation.maxGeneratedVideoShare': 'PROJECT', 'costCeilingUsd.total': 'PROJECT' });
    // The profile itself is never changed.
    expect(base.density).toBe('BALANCED');
    expect(applyOverrides(base, {})).toEqual({ effective: base, provenance: {} });
  });

  it('refuses a setting it does not take, or a value out of range, rather than dropping it', () => {
    expect(() => applyOverrides(base, { density: 'BUSY' } as never)).toThrow();
    expect(() => applyOverrides(base, { tempo: 'fast' } as never)).toThrow();
    expect(() => applyOverrides(base, { generation: { maxGeneratedVideoShare: 1.5 } })).toThrow();
  });

  it('says what differs between two versions, one line per setting', () => {
    const crime = VISUAL_PROFILE_PRESETS.find((p) => p.key === 'dark-true-crime')!.config;
    const next = applyOverrides(crime, { density: 'BALANCED', lenses: ['50mm'] }).effective;
    expect(configDifferences(crime, next)).toEqual(['lenses: 35mm, 85mm, long-lens compression → 50mm', 'density: SPARSE → BALANCED']);
    expect(configDifferences(crime, crime)).toEqual([]);
  });

  it('lists provider and model preferences the catalog does not know or that cannot make their method', () => {
    const config = applyOverrides(base, {
      providerPreferences: {
        GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-motion-1' }, { provider: 'acme-nobody' }, { provider: 'acme-video', model: 'acme-motion-9' }],
        GENERATIVE_IMAGE: [{ provider: 'acme-clips', model: 'acme-clip-2' }, { provider: 'acme-clips' }],
      },
    }).effective;
    expect(unknownPreferences(config, acmeCatalog())).toEqual([
      'GENERATIVE_VIDEO: acme-nobody is not in the visual catalog',
      'GENERATIVE_VIDEO: acme-video acme-motion-9 is not a model the visual catalog knows (it is priced only by a rate for the whole provider)',
      'GENERATIVE_IMAGE: acme-clips acme-clip-2 does not make generative image',
      'GENERATIVE_IMAGE: no model of acme-clips makes generative image',
    ]);
    expect(unknownPreferences(base, acmeCatalog())).toEqual([]);
  });
});
