// The provider is imported through the package index FIRST: it pins the load order in which elevenlabs.ts imports
// settings.ts and settings.ts reads the model table (models.ts, never elevenlabs.ts: that cycle crashed at load).
import { ELEVENLABS_MODELS, ElevenLabsVoiceProvider, isSentTo } from '../index.ts';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_MODEL, type ElevenLabsModel } from './models.ts';
import { ELEVENLABS_SETTINGS } from './settings.ts';

const provider = new ElevenLabsVoiceProvider({
  apiKey: 'test-key',
  model: 'eleven_v4',
  outputFormat: 'mp3_44100_128',
  fetch: async () => {
    throw new Error('no network in this test');
  },
});
/** House narrator v1's settings, as production stores them. */
const EARLIER = { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 };
const FLAGS = ['stability', 'similarity', 'style', 'speakerBoost', 'speed'] as const satisfies readonly (keyof ElevenLabsModel['settings'])[];

describe('ElevenLabs voice settings', () => {
  it('are described once the provider is loaded through the package index', () => {
    expect(provider.settings.length).toBeGreaterThan(0);
    expect(provider.settings).toBe(ELEVENLABS_SETTINGS);
    expect(provider.settings.map((d) => d.key)).toEqual(['stability', 'similarity', 'style', 'speakerBoost', 'speed']);
    expect(provider.models).toEqual(Object.keys(ELEVENLABS_MODELS));
  });

  it('are all overridable, with speed as the SPEED role, and read House narrator v1 cleanly', () => {
    expect(provider.settings.every((d) => d.overridable)).toBe(true);
    expect(provider.settings.filter((d) => d.role === 'SPEED').map((d) => d.key)).toEqual(['speed']);
    expect(provider.normalizeSettings(EARLIER)).toEqual({ settings: EARLIER, problems: [] });
    expect(provider.normalizeSettings({})).toEqual({ settings: EARLIER, problems: [] });
    expect(provider.normalizeSettings({ speed: 1.5, pronunciationDictionaries: [] }).problems).toEqual(['pronunciationDictionaries: not a setting this provider has', 'speed: 1.5 is outside 0.7–1.2']);
  });

  it('send Eleven v4 stability and similarity only', () => {
    expect(provider.sentSettings(EARLIER, 'eleven_v4')).toEqual({ sent: { stability: 0.5, similarity: 0.75 }, ignored: ['style', 'speakerBoost', 'speed'] });
    expect(provider.sentSettings(EARLIER, 'eleven_v4_turbo').sent).toEqual({ stability: 0.5, similarity: 0.75 });
  });

  it('send Multilingual v2 and Flash all five', () => {
    for (const model of ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_flash_v2']) expect(provider.sentSettings(EARLIER, model)).toEqual({ sent: EARLIER, ignored: [] });
  });

  it('send Eleven v3 no similarity', () => {
    expect(provider.sentSettings(EARLIER, 'eleven_v3')).toEqual({ sent: { stability: 0.5 }, ignored: ['similarity', 'style', 'speakerBoost', 'speed'] });
  });

  it('send a model the table does not know stability and similarity, as before', () => {
    expect(provider.sentSettings(EARLIER, 'eleven_v9')).toEqual({ sent: { stability: 0.5, similarity: 0.75 }, ignored: ['style', 'speakerBoost', 'speed'] });
  });

  it('agree with the model table for every known model and for one it does not know', () => {
    for (const flag of FLAGS) {
      const d = ELEVENLABS_SETTINGS.find((x) => x.key === flag)!;
      for (const [model, caps] of Object.entries(ELEVENLABS_MODELS)) expect(isSentTo(d, model), `${flag} → ${model}`).toBe(caps.settings[flag]);
      expect(isSentTo(d, 'eleven_v9'), `${flag} → unknown`).toBe(UNKNOWN_MODEL.settings[flag]);
    }
    expect(ELEVENLABS_SETTINGS.find((d) => d.key === 'stability')).toMatchObject({ models: null });
    expect(ELEVENLABS_SETTINGS.find((d) => d.key === 'similarity')).toMatchObject({ models: null, except: ['eleven_v3'] });
    expect(ELEVENLABS_SETTINGS.find((d) => d.key === 'speed')).toMatchObject({ models: ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_flash_v2'] });
  });

  it('are not part of the generic capabilities', () => {
    for (const model of [...Object.keys(ELEVENLABS_MODELS), 'eleven_v9']) {
      const caps = provider.capabilities(model);
      expect(caps).not.toHaveProperty('settings');
      expect(caps.model).toBe(model);
    }
    expect(provider.capabilities('eleven_v4')).toMatchObject({ directions: true, pauses: 'TAGS', phonemes: true, stitching: true, maxCharacters: 10_000, known: true });
    expect(provider.capabilities('eleven_v9')).toMatchObject({ known: false, pauses: 'PUNCTUATION', maxCharacters: 5_000 });
  });
});
