import { randomUUID } from 'node:crypto';
import { DEFAULT_VOICE_PROFILE_CONFIG, EARLIER_PERFORMANCE_RULES, VOICE_ACCEPTANCE_EXPERIMENT, type EffectiveVoiceConfig, type VoiceRunConfig, type VoiceSettingDescriptor } from '@docengine/core';
import type { Prisma, VoiceProfileFamily } from '@docengine/database';
import { ElevenLabsVoiceProvider, MockVoiceProvider, normalizeVoiceSettings, sentVoiceSettings } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import {
  checkOverrides,
  configDifferences,
  describeOverrides,
  effectiveConfig,
  newRunConfig,
  newTakeConfig,
  runConfig,
  takeConfig,
  versionFields,
  voiceIdentityDiffers,
  type ConfigProvider,
  type ProfileRow,
} from './config.ts';

/**
 * A take's configuration, layer by layer: the profile version, the
 * project's overrides, the run's options and a take's override, with
 * provenance; runs and takes made before saved profiles read back exactly
 * as they were made; stored snapshots used as they are. No database.
 */

const mock = new MockVoiceProvider();
/** No request is ever made: only the provider's descriptions and filters are used. */
const elevenlabs = new ElevenLabsVoiceProvider({ apiKey: 'unit-test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: () => Promise.reject(new Error('no network in unit tests')) });

const family = (name: string): VoiceProfileFamily => ({ id: randomUUID(), name, description: null, isDefault: true, archivedAt: null, createdBy: 'system', createdAt: new Date(0), updatedAt: new Date(0) });

function version(over: Partial<ProfileRow> = {}): ProfileRow {
  const fam = over.family === undefined ? family('House narrator') : over.family;
  return {
    id: randomUUID(),
    name: 'House narrator',
    version: 1,
    provider: 'mock',
    voiceId: 'mock-narrator-deep',
    modelId: 'mock',
    language: 'en',
    outputFormat: 'wav_22050',
    config: { ...DEFAULT_VOICE_PROFILE_CONFIG, providerSettings: mock.normalizeSettings({}).settings },
    active: false,
    notes: null,
    createdBy: 'system',
    createdAt: new Date(0),
    familyId: fam?.id ?? null,
    basedOnId: null,
    origin: { kind: 'DEFAULTS' },
    family: fam,
    ...over,
  };
}

/** "House narrator" v1 as production stores it: the shape from before saved profiles, made from the configured defaults. */
const EARLIER_HOUSE_CONFIG = {
  settings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 },
  strategy: 'RESTRAINED',
  chunking: { minWords: 20, maxWords: 30 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  numberStyle: 'UK',
};
const houseNarrator = version({ provider: 'elevenlabs', voiceId: 'voice-under-test', modelId: 'eleven_v4', outputFormat: 'mp3_44100_128', config: EARLIER_HOUSE_CONFIG, active: true, origin: null });

describe('layers and provenance', () => {
  it('lays the project, then the run over the version, and says where every setting a layer set came from', () => {
    const v = version();
    const { effective, provenance } = effectiveConfig(
      v,
      [
        { source: 'PROJECT', overrides: { providerSettings: { stability: 0.4 }, numberStyle: 'UK' } },
        { source: 'RUN', overrides: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.3 }, performanceRules: { maxMarksPerChunk: 1 } } },
      ],
      mock,
    );
    expect(effective).toMatchObject({ provider: 'mock', voiceId: 'mock-narrator-deep', model: 'mock', language: 'en', outputFormat: 'wav_22050', strategy: 'EXPRESSIVE', numberStyle: 'UK' });
    // The run wins over the project, key by key; the version's other settings stay.
    expect(effective.providerSettings).toEqual({ stability: 0.3, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 });
    expect(effective.performanceRules).toEqual({ ...EARLIER_PERFORMANCE_RULES, maxMarksPerChunk: 1 });
    // A project override in force is visible even at the profile's own value (number style).
    expect(provenance).toEqual({ 'providerSettings.stability': 'RUN', numberStyle: 'PROJECT', strategy: 'RUN', 'performanceRules.maxMarksPerChunk': 'RUN' });
    // Nothing set: the version as it is.
    expect(effectiveConfig(v, [], mock)).toEqual({ effective: versionFields(v, mock), provenance: {} });
  });

  it('replaces whole values and merges rules and provider settings key by key', () => {
    const { effective } = effectiveConfig(
      version(),
      [
        { source: 'PROJECT', overrides: { context: { previousChars: 0, nextChars: 0, stitch: false }, performanceRules: { paceSpeed: { SLOW: 0.9, FAST: 1.1 } } } },
        { source: 'TAKE', overrides: { context: { previousChars: 300, nextChars: 0, stitch: false }, performanceRules: { resetWord: 'even' }, providerSettings: { speakerBoost: false } } },
      ],
      mock,
    );
    expect(effective.context).toEqual({ previousChars: 300, nextChars: 0, stitch: false });
    expect(effective.performanceRules).toEqual({ ...EARLIER_PERFORMANCE_RULES, paceSpeed: { SLOW: 0.9, FAST: 1.1 }, resetWord: 'even' });
    expect(effective.providerSettings).toMatchObject({ stability: 0.5, speakerBoost: false });
  });

  it('refuses overrides the provider does not describe or let be set, invalid values, and chunking for a take', () => {
    expect(checkOverrides({ strategy: 'PLAIN', providerSettings: { stability: 0.2, speed: 1.1 } }, mock, 'PROJECT')).toEqual([]);
    expect(checkOverrides({ providerSettings: { warmth: 0.2 } }, mock, 'RUN')).toEqual(['warmth: not a setting this provider has']);
    expect(checkOverrides({ providerSettings: { stability: 2 } }, mock, 'RUN')).toEqual(['stability: 2 is outside 0–1']);
    expect(checkOverrides({ providerSettings: { speakerBoost: 'yes' } }, mock, 'PROJECT')).toEqual(['speakerBoost: true or false is needed (got "yes")']);
    expect(checkOverrides({ chunking: { minWords: 13, maxWords: 20 } }, mock, 'RUN')).toEqual([]);
    expect(checkOverrides({ chunking: { minWords: 13, maxWords: 20 } }, mock, 'TAKE')).toEqual(["chunking: a take is made of its run's chunk (start a new run for another chunk size)"]);
    // Every other unknown key beside it is still named.
    expect(checkOverrides({ chunking: { minWords: 13, maxWords: 20 }, warmth: 1, tone: 'dark' } as never, mock, 'TAKE')).toEqual(["chunking: a take is made of its run's chunk (start a new run for another chunk size)", 'warmth, tone: Unrecognized keys: "warmth", "tone"']);
    expect(checkOverrides({ stability: 0.3 } as never, mock, 'RUN')).toEqual([expect.stringMatching(/^stability: Unrecognized key/)]);
    expect(checkOverrides({ performanceRules: { maxMarksPerChunk: 9 } }, mock, 'PROJECT')).toEqual([expect.stringMatching(/^performanceRules\.maxMarksPerChunk: /)]);
  });
});

// ── Runs and takes made before saved profiles ────────────────────────────────

/** The acceptance experiment as production ran it (2026-10-06): seven runs of House narrator v1, each with its strategy, chunking and context. */
const ACCEPTANCE = VOICE_ACCEPTANCE_EXPERIMENT.variants.map((v, i) => ({ number: i + 1, label: v.label, run: { config: null, strategy: v.strategy, settings: { chunking: v.chunking, context: v.context }, profile: houseNarrator } }));

describe('runs made before saved profiles', () => {
  it('reconstructs all seven acceptance runs from their version, strategy and settings', () => {
    const expected = [
      ['A plain', 'PLAIN', { strategy: 'PLAIN' }],
      ['B restrained', 'RESTRAINED', {}],
      ['C expressive', 'EXPRESSIVE', { strategy: 'EXPRESSIVE' }],
      ['D over-directed', 'DIRECTED', { strategy: 'DIRECTED' }],
      ['E no context', 'RESTRAINED', { context: { previousChars: 0, nextChars: 0, stitch: false } }],
      ['F 5–8 s chunks', 'RESTRAINED', { chunking: { minWords: 13, maxWords: 20 } }],
      ['G 12–20 s chunks', 'RESTRAINED', { chunking: { minWords: 30, maxWords: 50 } }],
    ] as const;
    for (const [i, a] of ACCEPTANCE.entries()) {
      const c = runConfig(a.run, elevenlabs);
      const [label, strategy, options] = expected[i]!;
      expect(a.label).toBe(label);
      expect(c).toMatchObject({ reconstructed: true, selection: null, projectOverrides: {}, runOptions: options });
      expect(c.effective.strategy).toBe(strategy);
      expect(Object.keys(c.provenance).sort()).toEqual(Object.keys(options).sort());
      expect(Object.values(c.provenance).every((s) => s === 'RUN')).toBe(true);
      expect(c.effective.chunking).toEqual(a.run.settings.chunking);
      expect(c.effective.context).toEqual(a.run.settings.context);
    }
  });

  it('gives run 3 (C expressive) exactly: EXPRESSIVE, 20–30 words, 200/120 without stitching, UK, the version’s settings, the earlier rules', () => {
    const c = runConfig(ACCEPTANCE[2]!.run, elevenlabs);
    const effective: EffectiveVoiceConfig = {
      provider: 'elevenlabs',
      voiceId: 'voice-under-test',
      model: 'eleven_v4',
      language: 'en',
      outputFormat: 'mp3_44100_128',
      strategy: 'EXPRESSIVE',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      numberStyle: 'UK',
      pronunciation: { rules: [] },
      performanceRules: {
        maxMarksPerChunk: 2,
        minWordsBetweenMarks: 6,
        directorWordsPerMark: 10,
        emotionWords: { REFLECTIVE: 'reflective', CURIOUS: 'curious', TENSE: 'tense', SOMBER: 'somber', EXCITED: 'excited' },
        deliveryWords: { lowEnergy: 'quiet', slowPace: 'deliberate', highEnergy: 'urgent', fastPace: 'brisk' },
        resetWord: 'matter-of-fact',
        paceSpeed: { SLOW: 0.94, FAST: 1.06 },
      },
      providerSettings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 },
    };
    expect(c).toEqual({
      reconstructed: true,
      profile: { familyId: houseNarrator.familyId, familyName: 'House narrator', versionId: houseNarrator.id, version: 1, name: 'House narrator' },
      selection: null,
      projectOverrides: {},
      runOptions: { strategy: 'EXPRESSIVE' },
      effective,
      provenance: { strategy: 'RUN' },
      // The model is sent what it takes; the rest is kept, not sent.
      sent: { stability: 0.5, similarity: 0.75 },
      ignored: ['style', 'speakerBoost', 'speed'],
    });
    // The earlier rules are a copy: nothing read back is frozen or shared.
    expect(Object.isFrozen(c.effective.performanceRules)).toBe(false);
  });

  it('reads context as the stage read it: a figure missing from an early run is no context', () => {
    const c = runConfig({ config: null, strategy: 'RESTRAINED', settings: { context: { previousChars: 200 } }, profile: houseNarrator }, elevenlabs);
    expect(c.effective.context).toEqual({ previousChars: 200, nextChars: 0, stitch: false });
    expect(c.effective.chunking).toEqual({ minWords: 20, maxWords: 30 });
  });

  it('reconstructs a take as the run’s, with its own strategy (an A/B variant) as the only difference', () => {
    const run = runConfig(ACCEPTANCE[1]!.run, elevenlabs);
    const same = takeConfig({ config: null, strategy: 'RESTRAINED', profile: houseNarrator }, run);
    expect(same).toMatchObject({ reconstructed: true, base: 'RUN', override: null, differs: [], identityDiffers: false });
    expect(same.effective).toEqual(run.effective);
    const variant = takeConfig({ config: null, strategy: 'EXPRESSIVE', profile: houseNarrator }, run);
    expect(variant).toMatchObject({ reconstructed: true, base: 'RUN', override: { strategy: 'EXPRESSIVE' }, differs: ['performance: expressive (run: restrained)'], identityDiffers: false, provenance: { strategy: 'TAKE' } });
    expect(variant.effective).toEqual({ ...run.effective, strategy: 'EXPRESSIVE' });
  });
});

// ── Snapshots and new takes ──────────────────────────────────────────────────

/** The mock voice with one more setting, as a later release of the provider might describe. */
class LaterMock extends MockVoiceProvider {
  override readonly settings: readonly VoiceSettingDescriptor[] = [...new MockVoiceProvider().settings, { key: 'breath', label: 'Breath', help: '', kind: 'NUMBER', default: 0.2, min: 0, max: 1, models: null, overridable: true }];
  override normalizeSettings(input: Readonly<Record<string, unknown>>) {
    return normalizeVoiceSettings(this.settings, input);
  }
  override sentSettings(settings: Readonly<Record<string, number | boolean | string>>, model: string) {
    return sentVoiceSettings(this.settings, settings, model);
  }
}

const stored = (c: VoiceRunConfig): Prisma.JsonValue => JSON.parse(JSON.stringify(c)) as Prisma.JsonValue;

describe('snapshots', () => {
  it('uses a stored run snapshot verbatim: a setting the provider describes later does not appear in it or in a RUN take', () => {
    const v = version();
    const made = newRunConfig({ version: v, selection: { mode: 'FOLLOW', revision: 2 }, projectOverrides: { providerSettings: { stability: 0.4 } }, runOptions: { strategy: 'PLAIN' } }, mock);
    expect(made).toMatchObject({ reconstructed: false, selection: { mode: 'FOLLOW', revision: 2 }, provenance: { 'providerSettings.stability': 'PROJECT', strategy: 'RUN' }, sent: { stability: 0.4 } });
    const later = new LaterMock();
    // Read back with the later provider: as stored, not re-normalised.
    const read = runConfig({ config: stored(made), strategy: 'PLAIN', settings: {}, profile: v }, later);
    expect(read).toEqual(made);
    expect(read.effective.providerSettings).not.toHaveProperty('breath');
    // Its version read today does get the new setting: that is why the snapshot, not the version, is what a RUN take uses.
    expect(versionFields(v, later).providerSettings).toHaveProperty('breath', 0.2);
    const take = newTakeConfig({ run: read, base: 'RUN', override: { providerSettings: { stability: 0.3 } } }, later);
    expect(take.effective.providerSettings).toEqual({ ...made.effective.providerSettings, stability: 0.3 });
    expect(take).toMatchObject({ reconstructed: false, base: 'RUN', override: { providerSettings: { stability: 0.3 } }, profile: made.profile, differs: ['stability: 0.3 (run: 0.4)'], identityDiffers: true, provenance: { 'providerSettings.stability': 'TAKE', strategy: 'RUN' } });
    // No override: the run's configuration exactly, no difference.
    const plain = newTakeConfig({ run: read, base: 'RUN', override: {} }, later);
    expect(plain).toMatchObject({ override: null, differs: [], identityDiffers: false });
    expect(plain.effective).toEqual(made.effective);
  });

  it('reads a snapshot a later version stored with an override key this one does not know', () => {
    const v = version();
    const made = stored(newRunConfig({ version: v, selection: { mode: 'DEFAULT', revision: 0 }, projectOverrides: {}, runOptions: {} }, mock)) as Prisma.JsonObject;
    const later = { ...made, runOptions: { strategy: 'PLAIN', breathing: 'deep' } };
    const read = runConfig({ config: later, strategy: 'PLAIN', settings: {}, profile: v }, mock);
    expect(read.reconstructed).toBe(false);
    expect(read.runOptions).toEqual({ strategy: 'PLAIN', breathing: 'deep' });
  });

  it('makes a PRODUCTION take with production’s version and the project’s overrides, but the run’s chunking, and works out how it differs', () => {
    const run = runConfig(ACCEPTANCE[5]!.run, elevenlabs); // F: 13–20 words
    const v2 = version({
      provider: 'elevenlabs',
      name: 'Tulip narrator',
      version: 2,
      family: family('Tulip narrator'),
      voiceId: 'another-voice',
      modelId: 'eleven_v4',
      outputFormat: 'mp3_44100_128',
      config: { ...DEFAULT_VOICE_PROFILE_CONFIG, strategy: 'EXPRESSIVE', chunking: { minWords: 30, maxWords: 50 }, providerSettings: { stability: 0.45 } },
    });
    const take = newTakeConfig({ run, base: 'PRODUCTION', production: { version: v2, overrides: { numberStyle: 'US', chunking: { minWords: 25, maxWords: 35 } } }, override: null }, elevenlabs);
    expect(take.effective.chunking).toEqual({ minWords: 13, maxWords: 20 });
    expect(take.effective).toMatchObject({ voiceId: 'another-voice', strategy: 'EXPRESSIVE', numberStyle: 'US', providerSettings: { stability: 0.45, similarity: 0.75 } });
    expect(take.provenance).toEqual({ numberStyle: 'PROJECT', chunking: 'RUN' });
    expect(take).toMatchObject({ base: 'PRODUCTION', override: null, profile: { versionId: v2.id, version: 2, name: 'Tulip narrator', familyName: 'Tulip narrator' }, identityDiffers: true });
    expect(take.differs).toEqual(['voice: another-voice (run: voice-under-test)', 'performance: expressive (run: restrained)', 'number style: US (run: UK)', 'stability: 0.45 (run: 0.5)']);
    // Production differing only in performance is not a different voice.
    const v3 = version({ ...houseNarrator, id: randomUUID(), version: 2, config: { ...EARLIER_HOUSE_CONFIG, strategy: 'EXPRESSIVE' } });
    const performance = newTakeConfig({ run, base: 'PRODUCTION', production: { version: v3, overrides: {} }, override: null }, elevenlabs);
    expect(performance).toMatchObject({ differs: ['performance: expressive (run: restrained)'], identityDiffers: false, provenance: { chunking: 'RUN' } });
  });

  it('counts a setting the model is not sent as a difference, not as another voice', () => {
    // v4 is sent stability and similarity only: style and speed change nothing heard (no QA warning), but the take still says they differ.
    const run = runConfig(ACCEPTANCE[2]!.run, elevenlabs);
    const unsent = newTakeConfig({ run, base: 'RUN', override: { providerSettings: { style: 0.3, speed: 1.1 } } }, elevenlabs);
    expect(unsent).toMatchObject({ differs: ['style: 0.3 (run: 0)', 'speed: 1.1 (run: 1)'], identityDiffers: false, provenance: { 'providerSettings.style': 'TAKE', 'providerSettings.speed': 'TAKE' } });
    expect(newTakeConfig({ run, base: 'RUN', override: { providerSettings: { stability: 0.3 } } }, elevenlabs)).toMatchObject({ differs: ['stability: 0.3 (run: 0.5)'], identityDiffers: true });
    // A model that takes style is another voice with it.
    const v2 = runConfig({ ...ACCEPTANCE[2]!.run, profile: { ...houseNarrator, modelId: 'eleven_multilingual_v2' } }, elevenlabs);
    expect(newTakeConfig({ run: v2, base: 'RUN', override: { providerSettings: { style: 0.3 } } }, elevenlabs)).toMatchObject({ differs: ['style: 0.3 (run: 0)'], identityDiffers: true });
  });
});

describe('differences and descriptions', () => {
  const a = versionFields(houseNarrator, elevenlabs);
  it('reads differences against the earlier configuration, the run, or as a change from one version to the next', () => {
    const b: EffectiveVoiceConfig = { ...a, strategy: 'EXPRESSIVE', context: { previousChars: 0, nextChars: 0, stitch: false }, pronunciation: { rules: [{ term: 'Thijs', method: 'ALIAS', pronunciation: 'Tice' }] }, performanceRules: { ...a.performanceRules, maxMarksPerChunk: 1, paceSpeed: { SLOW: 0.9, FAST: 1.06 } }, providerSettings: { ...a.providerSettings, stability: 0.3 } };
    expect(configDifferences(a, b)).toEqual([
      'performance: expressive (was restrained)',
      'context: none (was previous 200 / next 120 chars)',
      'pronunciation rules: Thijs (alias Tice) (was none)',
      'directions per chunk: 1 (was 2)',
      'slow pace speed: 0.9 (was 0.94)',
      'stability: 0.3 (was 0.5)',
    ]);
    expect(configDifferences(a, b, 'RUN')[0]).toBe('performance: expressive (run: restrained)');
    expect(configDifferences(a, b, 'ARROW')[0]).toBe('performance: restrained → expressive');
    expect(configDifferences(a, structuredClone(a))).toEqual([]);
    // Performance alone is a performance choice; settings, voice or pronunciation change the voice itself.
    expect(voiceIdentityDiffers(a, { ...a, strategy: 'EXPRESSIVE', chunking: { minWords: 13, maxWords: 20 } })).toBe(false);
    expect(voiceIdentityDiffers(a, { ...a, providerSettings: { ...a.providerSettings, style: 0.2 } })).toBe(true);
    expect(voiceIdentityDiffers(a, { ...a, pronunciation: { rules: [{ term: 'VOC', method: 'ALIAS', pronunciation: 'V O C' }] } })).toBe(true);
    // Key order is not a difference.
    expect(voiceIdentityDiffers(a, { ...a, providerSettings: Object.fromEntries(Object.entries(a.providerSettings).reverse()) })).toBe(false);
  });

  it('describes overrides in a few words', () => {
    expect(describeOverrides({ strategy: 'EXPRESSIVE', providerSettings: { stability: 0.3 }, context: { previousChars: 0, nextChars: 0, stitch: false } })).toBe('performance expressive, context none, stability 0.3');
    expect(describeOverrides({ chunking: { minWords: 13, maxWords: 20 }, numberStyle: 'US', performanceRules: { maxMarksPerChunk: 1, paceSpeed: { SLOW: 0.9, FAST: 1.1 } } })).toBe('chunk size 13–20 words, number style US, directions per chunk 1, slow pace speed 0.9, fast pace speed 1.1');
    expect(describeOverrides({})).toBe('none');
    expect(describeOverrides(null)).toBe('none');
  });
});

// ── A provider that is not ElevenLabs ────────────────────────────────────────

/** A voice with its own settings: warmth, breathiness, a tempo (its speed, sent to one model) and a timbre only a profile may set. */
const FAKE_SETTINGS: VoiceSettingDescriptor[] = [
  { key: 'warmth', label: 'Warmth', help: '', kind: 'NUMBER', default: 0.6, min: 0, max: 1, step: 0.1, models: null, overridable: true },
  { key: 'breathy', label: 'Breathy', help: '', kind: 'BOOLEAN', default: false, models: null, overridable: true },
  { key: 'tempo', label: 'Tempo', help: '', kind: 'NUMBER', default: 1, min: 0.5, max: 2, models: ['studio-2'], overridable: true, role: 'SPEED' },
  { key: 'timbre', label: 'Timbre', help: '', kind: 'CHOICE', default: 'dark', choices: [{ value: 'dark', label: 'Dark' }, { value: 'bright', label: 'Bright' }], models: null, except: ['studio-1'], overridable: false },
];
const fake: ConfigProvider = {
  info: { kind: 'VOICE', name: 'acme', mock: false, rates: [] },
  settings: FAKE_SETTINGS,
  normalizeSettings: (input) => normalizeVoiceSettings(FAKE_SETTINGS, input),
  sentSettings: (settings, model) => sentVoiceSettings(FAKE_SETTINGS, settings, model),
};

describe('a provider with its own settings', () => {
  const acme = version({ provider: 'acme', voiceId: 'acme-voice', modelId: 'studio-1', outputFormat: 'mp3_44100_128', config: { ...DEFAULT_VOICE_PROFILE_CONFIG, providerSettings: { warmth: 0.8, timbre: 'bright' } } });

  it('fills and checks the settings it describes, lays overrides over them, and sends each model what it takes', () => {
    expect(versionFields(acme, fake).providerSettings).toEqual({ warmth: 0.8, breathy: false, tempo: 1, timbre: 'bright' });
    expect(checkOverrides({ providerSettings: { warmth: 0.5, breathy: true, tempo: 1.2 } }, fake, 'PROJECT')).toEqual([]);
    expect(checkOverrides({ providerSettings: { timbre: 'dark' } }, fake, 'TAKE')).toEqual(['timbre: set by the profile only (it cannot be overridden)']);
    expect(checkOverrides({ providerSettings: { stability: 0.5 } }, fake, 'RUN')).toEqual(['stability: not a setting this provider has']);
    const run = newRunConfig({ version: acme, selection: { mode: 'EXPLICIT', revision: 0 }, projectOverrides: {}, runOptions: { providerSettings: { breathy: true, tempo: 1.2 } } }, fake);
    expect(run.effective.providerSettings).toEqual({ warmth: 0.8, breathy: true, tempo: 1.2, timbre: 'bright' });
    expect(run.provenance).toEqual({ 'providerSettings.breathy': 'RUN', 'providerSettings.tempo': 'RUN' });
    // studio-1 takes no tempo and no timbre; studio-2 takes both.
    expect(run).toMatchObject({ sent: { warmth: 0.8, breathy: true }, ignored: ['tempo', 'timbre'] });
    expect(newRunConfig({ version: { ...acme, modelId: 'studio-2' }, selection: { mode: 'EXPLICIT', revision: 0 }, projectOverrides: {}, runOptions: {} }, fake).sent).toEqual({ warmth: 0.8, breathy: false, tempo: 1, timbre: 'bright' });
    const take = newTakeConfig({ run, base: 'RUN', override: { providerSettings: { warmth: 0.3 } } }, fake);
    expect(take.differs).toEqual(['warmth: 0.3 (run: 0.8)']);
    expect(describeOverrides(take.override)).toBe('warmth 0.3');
  });

  it('leaves a version of another provider’s settings raw (it cannot check them)', () => {
    expect(versionFields(acme, mock).providerSettings).toEqual({ warmth: 0.8, timbre: 'bright' });
  });
});
