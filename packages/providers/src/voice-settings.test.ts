import { DEFAULT_VOICE_PROFILE_CONFIG, ProviderSettingValues, VoiceProfileConfig, readProfileConfig, type VoiceSettingDescriptor } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { ElevenLabsVoiceProvider } from './elevenlabs/elevenlabs.ts';
import { MockVoiceProvider } from './mock/voice.ts';
import type { VoiceProvider } from './voice.ts';
import { checkVoiceOverrides, isSentTo, normalizeVoiceSettings, sentVoiceSettings, settingProblem } from './voice-settings.ts';

const DEFAULT_CONFIG = JSON.parse(JSON.stringify(DEFAULT_VOICE_PROFILE_CONFIG)) as VoiceProfileConfig;

/** A made-up provider's settings: a choice, a flag for one model, a SPEED-role number every model but one takes, and a setting only a profile may set. */
const FAKE: VoiceSettingDescriptor[] = [
  {
    key: 'warmth',
    label: 'Warmth',
    help: 'How warm the voice sounds.',
    kind: 'CHOICE',
    default: 'medium',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    models: null,
    overridable: true,
  },
  { key: 'breathy', label: 'Breathy', help: 'Audible breaths.', kind: 'BOOLEAN', default: false, models: ['studio-1'], overridable: true },
  { key: 'tempo', label: 'Tempo', help: 'Base rate.', kind: 'NUMBER', default: 1, min: 0.8, max: 1.2, step: 0.05, models: null, except: ['studio-lite'], overridable: true, role: 'SPEED' },
  { key: 'seedLock', label: 'Seed lock', help: 'Fixed sampling.', kind: 'BOOLEAN', default: true, models: null, overridable: false },
];
const DEFAULTS = { warmth: 'medium', breathy: false, tempo: 1, seedLock: true };

describe('normalizeVoiceSettings', () => {
  it('fills every described setting with its default, and keeps the values that fit', () => {
    expect(normalizeVoiceSettings(FAKE, {})).toEqual({ settings: DEFAULTS, problems: [] });
    expect(normalizeVoiceSettings(FAKE, { tempo: 1.1, warmth: 'high', breathy: true })).toEqual({ settings: { ...DEFAULTS, tempo: 1.1, warmth: 'high', breathy: true }, problems: [] });
    expect(normalizeVoiceSettings(FAKE, { tempo: 0.8 }).settings.tempo).toBe(0.8);
  });

  it('leaves out unknown keys and values that do not fit, and lists them: never clamped', () => {
    const { settings, problems } = normalizeVoiceSettings(FAKE, { tempo: 1.5, breathy: 'yes', warmth: 'hot', pitch: 3 });
    expect(settings).toEqual(DEFAULTS);
    expect(settings).not.toHaveProperty('pitch');
    expect(settings.tempo).not.toBe(1.2);
    expect(problems).toEqual(['pitch: not a setting this provider has', 'warmth: "hot" is not one of low, medium, high', 'breathy: true or false is needed (got "yes")', 'tempo: 1.5 is outside 0.8–1.2']);
  });

  it('refuses a value of the wrong kind for every kind', () => {
    expect(normalizeVoiceSettings(FAKE, { tempo: '1.1' }).problems).toEqual(['tempo: a number is needed (got "1.1")']);
    expect(normalizeVoiceSettings(FAKE, { tempo: Number.NaN }).problems).toHaveLength(1);
    expect(normalizeVoiceSettings(FAKE, { tempo: null }).problems).toEqual(['tempo: a number is needed (got null)']);
    expect(normalizeVoiceSettings(FAKE, { warmth: 2 }).problems).toEqual(['warmth: 2 is not one of low, medium, high']);
    expect(normalizeVoiceSettings(FAKE, { seedLock: 1 }).problems).toEqual(['seedLock: true or false is needed (got 1)']);
  });

  it('takes any word for a choice that lists none', () => {
    const free: VoiceSettingDescriptor = { key: 'accent', label: 'Accent', help: '', kind: 'CHOICE', default: 'neutral', models: null, overridable: true };
    expect(settingProblem(free, 'scottish')).toBeNull();
    expect(settingProblem(free, 1)).not.toBeNull();
  });
});

describe('sentVoiceSettings', () => {
  it('sends a setting with a model list only to those models', () => {
    expect(sentVoiceSettings(FAKE, DEFAULTS, 'studio-1')).toEqual({ sent: DEFAULTS, ignored: [] });
    expect(sentVoiceSettings(FAKE, DEFAULTS, 'studio-2')).toEqual({ sent: { warmth: 'medium', tempo: 1, seedLock: true }, ignored: ['breathy'] });
  });

  it('sends a setting without a list to every model but its exceptions', () => {
    expect(sentVoiceSettings(FAKE, DEFAULTS, 'studio-lite')).toEqual({ sent: { warmth: 'medium', seedLock: true }, ignored: ['breathy', 'tempo'] });
  });

  it('treats a model the provider does not know as "every model": listed settings are not sent, the others are', () => {
    expect(sentVoiceSettings(FAKE, DEFAULTS, 'studio-9')).toEqual({ sent: { warmth: 'medium', tempo: 1, seedLock: true }, ignored: ['breathy'] });
  });

  it('never sends a key the provider does not describe, and sends what it is given in the descriptors’ order', () => {
    const r = sentVoiceSettings(FAKE, { pitch: 2, tempo: 1.06, warmth: 'low' }, 'studio-1');
    expect(r).toEqual({ sent: { warmth: 'low', tempo: 1.06 }, ignored: ['pitch'] });
    expect(Object.keys(r.sent)).toEqual(['warmth', 'tempo']);
  });

  it('agrees with the form rule ("not sent to {model}") for known and unknown models', () => {
    for (const model of ['studio-1', 'studio-2', 'studio-lite', 'studio-9']) {
      const { sent } = sentVoiceSettings(FAKE, DEFAULTS, model);
      for (const d of FAKE) {
        const notSentTo = d.models ? !d.models.includes(model) : !!d.except?.includes(model);
        expect(d.key in sent, `${d.key} → ${model}`).toBe(!notSentTo);
        expect(isSentTo(d, model)).toBe(!notSentTo);
      }
    }
  });
});

describe('checkVoiceOverrides', () => {
  it('takes overridable settings with values that fit', () => {
    expect(checkVoiceOverrides(FAKE, {})).toEqual([]);
    expect(checkVoiceOverrides(FAKE, { tempo: 1.1, warmth: 'low', breathy: true })).toEqual([]);
  });

  it('refuses a setting only the profile may set, an unknown key and a value that does not fit', () => {
    expect(checkVoiceOverrides(FAKE, { seedLock: false })).toEqual(['seedLock: set by the profile only (it cannot be overridden)']);
    expect(checkVoiceOverrides(FAKE, { pitch: 2 })).toEqual(['pitch: not a setting this provider has']);
    expect(checkVoiceOverrides(FAKE, { tempo: 2 })).toEqual(['tempo: 2 is outside 0.8–1.2']);
    expect(checkVoiceOverrides(FAKE, { warmth: 'hot', breathy: 'no' })).toEqual(['warmth: "hot" is not one of low, medium, high', 'breathy: true or false is needed (got "no")']);
  });
});

describe('the MOCK voice settings', () => {
  const mock = new MockVoiceProvider();

  it('are the five settings from before provider settings, for every model, with speed as the SPEED role', () => {
    expect(mock.settings.map((d) => d.key)).toEqual(['stability', 'similarity', 'style', 'speakerBoost', 'speed']);
    expect(mock.settings.every((d) => d.models === null && !d.except && d.overridable)).toBe(true);
    expect(mock.settings.filter((d) => d.role === 'SPEED').map((d) => d.key)).toEqual(['speed']);
    expect(mock.models).toEqual(['mock']);
  });

  it('read an earlier mock profile’s settings cleanly and send all of them', () => {
    const earlier = { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 };
    expect(mock.normalizeSettings(earlier)).toEqual({ settings: earlier, problems: [] });
    expect(mock.sentSettings(earlier, 'mock')).toEqual({ sent: earlier, ignored: [] });
    expect(mock.capabilities('mock')).not.toHaveProperty('settings');
  });
});

describe('every provider’s settings', () => {
  const providers: VoiceProvider[] = [
    new MockVoiceProvider(),
    new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: async () => Promise.reject(new Error('no network in this test')) }),
  ];

  for (const provider of providers) {
    it(`${provider.info.name}: describes keys a profile can store, with defaults that fit, and at most one SPEED-role number`, () => {
      const keys = provider.settings.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const d of provider.settings) {
        expect(ProviderSettingValues.safeParse({ [d.key]: d.default }).success, d.key).toBe(true);
        expect(settingProblem(d, d.default), d.key).toBeNull();
        if (d.kind === 'CHOICE') expect(d.choices?.length, d.key).toBeGreaterThan(0);
      }
      const speed = provider.settings.filter((d) => d.role === 'SPEED');
      expect(speed.length).toBeLessThanOrEqual(1);
      expect(speed.every((d) => d.kind === 'NUMBER')).toBe(true);
    });

    it(`${provider.info.name}: normalised settings survive being stored and read back, and a model is sent only described keys`, () => {
      const { settings, problems } = provider.normalizeSettings({});
      expect(problems).toEqual([]);
      const stored = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, providerSettings: settings }));
      expect(VoiceProfileConfig.parse(stored).providerSettings).toEqual(settings);
      expect(readProfileConfig(stored)).toEqual({ config: { ...DEFAULT_CONFIG, providerSettings: settings }, legacy: false });
      for (const model of [...provider.models, 'not-a-known-model']) {
        const { sent, ignored } = provider.sentSettings(settings, model);
        expect([...Object.keys(sent), ...ignored].sort(), model).toEqual(Object.keys(settings).sort());
      }
    });
  }
});
