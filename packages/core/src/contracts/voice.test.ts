import { describe, expect, it } from 'vitest';
import { CHUNK_BOUNDARIES, PERFORMANCE_STRATEGIES, VOICE_GENERATION_STATUSES } from '../enums.ts';
import {
  CHUNK_BOUNDARY_LABELS,
  CONFIG_SOURCE_LABELS,
  PERFORMANCE_RULE_LABELS,
  PERFORMANCE_STRATEGY_HELP,
  PERFORMANCE_STRATEGY_LABELS,
  SELECTION_MODE_LABELS,
  TAKE_CONFIG_BASE_LABELS,
  VOICE_GENERATION_STATUS_LABELS,
  VOICE_PROFILE_ORIGIN_LABELS,
} from '../labels.ts';
import { wordsForSeconds } from '../script.ts';
import {
  AssemblyEntry,
  CHUNK_SECONDS,
  CONFIG_SOURCES,
  CreateVoiceProfileFamilyInput,
  ChunkPauses,
  ChunkPerformance,
  DEFAULT_PERFORMANCE_RULES,
  DEFAULT_VOICE_PROFILE_CONFIG,
  DuplicateVoiceProfileInput,
  EARLIER_PERFORMANCE_RULES,
  NarrationTimelineEntry,
  NewVoiceProfileVersionInput,
  PerformanceRules,
  PlanVoiceRunInput,
  PreparedNarration,
  RegenerateVoiceInput,
  SELECTION_MODES,
  SaveRunAsProfileInput,
  VOICE_ACCEPTANCE_EXPERIMENT,
  VOICE_QA_KINDS,
  VoiceConfigOverrides,
  VoiceExperimentInput,
  VoiceProfileConfig,
  VoiceProfileOrigin,
  VoiceQaFinding,
  VoiceRunOptions,
  VoiceSelectionInput,
  VoiceTakeConfig,
  VoiceTakeOverride,
  performanceRulesProblems,
  readProfileConfig,
} from './voice.ts';

const CHUNK = '0190f3a0-0000-7000-8000-000000000001';
const OTHER = '0190f3a0-0000-7000-8000-000000000002';
const FAMILY = '0190f3a0-0000-7000-8000-000000000003';
const VERSION = '0190f3a0-0000-7000-8000-000000000004';
const AUDITION = { kind: 'AUDITION', seconds: 100 } as const;

/** The voice settings every take stored before saved profiles (and House narrator v1's). */
const EARLIER_SETTINGS = { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 };
/** "House narrator" v1 as production stores it (the earlier shape). */
const PRODUCTION_V1 = {
  settings: EARLIER_SETTINGS,
  strategy: 'RESTRAINED',
  chunking: { minWords: 20, maxWords: 30 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  numberStyle: 'UK',
};
/** Today's performance.ts and prepare.ts constants (HOUSE_STYLE, the director's one in ten words, EMOTION_WORDS, deliveryWord, RESET, PACE_SPEED). */
const TODAYS_RULES = {
  maxMarksPerChunk: 2,
  minWordsBetweenMarks: 6,
  directorWordsPerMark: 10,
  emotionWords: { REFLECTIVE: 'reflective', CURIOUS: 'curious', TENSE: 'tense', SOMBER: 'somber', EXCITED: 'excited' },
  deliveryWords: { lowEnergy: 'quiet', slowPace: 'deliberate', highEnergy: 'urgent', fastPace: 'brisk' },
  resetWord: 'matter-of-fact',
  paceSpeed: { SLOW: 0.94, FAST: 1.06 },
};

describe('chunk size', () => {
  it('defaults to about 8–12 s of speech at the narration rate', () => {
    expect(DEFAULT_VOICE_PROFILE_CONFIG.chunking).toEqual({ minWords: wordsForSeconds(CHUNK_SECONDS.target.min), maxWords: wordsForSeconds(CHUNK_SECONDS.target.max) });
    expect(DEFAULT_VOICE_PROFILE_CONFIG.chunking).toEqual({ minWords: 20, maxWords: 30 });
    expect(VoiceProfileConfig.parse(DEFAULT_VOICE_PROFILE_CONFIG)).toEqual(DEFAULT_VOICE_PROFILE_CONFIG);
  });

  it('keeps reading profiles stored with the earlier default', () => {
    const stored = { ...PRODUCTION_V1, chunking: { minWords: 25, maxWords: 80 } };
    const read = readProfileConfig(JSON.parse(JSON.stringify(stored)));
    expect(read.legacy).toBe(true);
    expect(read.config.chunking).toEqual({ minWords: 25, maxWords: 80 });
  });
});

describe('the house default for a new profile', () => {
  it('is restrained, 20–30 words, 200/120 characters of context without stitching, UK, no profile rules and no provider settings', () => {
    expect(DEFAULT_VOICE_PROFILE_CONFIG).toEqual({
      strategy: 'RESTRAINED',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      numberStyle: 'UK',
      pronunciation: { rules: [] },
      performanceRules: TODAYS_RULES,
      providerSettings: {},
    });
  });

  it('is not the acceptance winner (expressive moments)', () => {
    expect(DEFAULT_VOICE_PROFILE_CONFIG.strategy).not.toBe('EXPRESSIVE');
  });
});

describe('performance rules', () => {
  it('are exactly the constants the engine applied, both the frozen earlier rules and the default', () => {
    expect(EARLIER_PERFORMANCE_RULES).toEqual(TODAYS_RULES);
    expect(DEFAULT_PERFORMANCE_RULES).toEqual(TODAYS_RULES);
    expect(PerformanceRules.parse(TODAYS_RULES)).toEqual(TODAYS_RULES);
  });

  it('freezes the earlier rules all the way down, and the default is a separate copy', () => {
    expect(Object.isFrozen(EARLIER_PERFORMANCE_RULES)).toBe(true);
    for (const nested of [EARLIER_PERFORMANCE_RULES.emotionWords, EARLIER_PERFORMANCE_RULES.deliveryWords, EARLIER_PERFORMANCE_RULES.paceSpeed]) expect(Object.isFrozen(nested)).toBe(true);
    expect(() => {
      (EARLIER_PERFORMANCE_RULES as { maxMarksPerChunk: number }).maxMarksPerChunk = 3;
    }).toThrow(TypeError);
    expect(() => {
      (EARLIER_PERFORMANCE_RULES.paceSpeed as { SLOW: number }).SLOW = 0.8;
    }).toThrow(TypeError);
    expect(DEFAULT_PERFORMANCE_RULES).not.toBe(EARLIER_PERFORMANCE_RULES);
    expect(DEFAULT_PERFORMANCE_RULES.paceSpeed).not.toBe(EARLIER_PERFORMANCE_RULES.paceSpeed);
    expect(Object.isFrozen(DEFAULT_PERFORMANCE_RULES)).toBe(false);
  });

  it('work together unless the reset word is also a delivery word (its directions would read as resets)', () => {
    expect(performanceRulesProblems(EARLIER_PERFORMANCE_RULES)).toEqual([]);
    expect(performanceRulesProblems({ ...TODAYS_RULES, resetWord: 'neutral' })).toEqual([]);
    expect(performanceRulesProblems({ ...TODAYS_RULES, resetWord: 'quiet' })).toEqual(['resetWord: "quiet" is also the word for low energy; a direction in it would be read as a reset']);
    expect(performanceRulesProblems({ ...TODAYS_RULES, resetWord: 'steady', deliveryWords: { lowEnergy: 'steady', slowPace: 'steady', highEnergy: 'urgent', fastPace: 'brisk' } })).toHaveLength(2);
  });

  it('refuse values outside their limits and words that are not plain', () => {
    expect(PerformanceRules.safeParse({ ...TODAYS_RULES, maxMarksPerChunk: 7 }).success).toBe(false);
    expect(PerformanceRules.safeParse({ ...TODAYS_RULES, paceSpeed: { SLOW: 1.1, FAST: 1.06 } }).success).toBe(false);
    expect(PerformanceRules.safeParse({ ...TODAYS_RULES, resetWord: '[calm]' }).success).toBe(false);
    expect(PerformanceRules.safeParse({ ...TODAYS_RULES, emotionWords: { ...TODAYS_RULES.emotionWords, TENSE: null } }).success).toBe(true);
  });
});

describe('readProfileConfig', () => {
  it('reads House narrator v1 as production stores it: the earlier shape, its settings as provider settings, no profile rules, the earlier rules', () => {
    const { config, legacy } = readProfileConfig(JSON.parse(JSON.stringify(PRODUCTION_V1)));
    expect(legacy).toBe(true);
    expect(config).toEqual({
      strategy: 'RESTRAINED',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      numberStyle: 'UK',
      pronunciation: { rules: [] },
      performanceRules: EARLIER_PERFORMANCE_RULES,
      providerSettings: EARLIER_SETTINGS,
    });
    expect(VoiceProfileConfig.parse(config)).toEqual(config);
  });

  it('reads {} and a config without provider settings as the earlier shape, filled as the engine filled it then', () => {
    for (const raw of [{}, { strategy: 'EXPRESSIVE' }]) {
      const { config, legacy } = readProfileConfig(raw);
      expect(legacy).toBe(true);
      expect(config.providerSettings).toEqual({});
      expect(config.performanceRules).toEqual(TODAYS_RULES);
      expect(config.pronunciation).toEqual({ rules: [] });
      expect(config.chunking).toEqual({ minWords: 20, maxWords: 30 });
      expect(config.context).toEqual({ previousChars: 200, nextChars: 120, stitch: false });
      expect(config.numberStyle).toBe('UK');
    }
    expect(readProfileConfig({ strategy: 'EXPRESSIVE' }).config.strategy).toBe('EXPRESSIVE');
    expect(readProfileConfig({}).config.strategy).toBe('RESTRAINED');
  });

  it('fills an earlier context field by field and keeps the earlier shape when both settings and provider settings are there', () => {
    expect(readProfileConfig({ settings: {}, context: { previousChars: 0 } }).config.context).toEqual({ previousChars: 0, nextChars: 120, stitch: false });
    const both = readProfileConfig({ settings: { stability: 0.4 }, providerSettings: { stability: 0.9 } });
    expect(both.legacy).toBe(true);
    expect(both.config.providerSettings).toEqual({ stability: 0.4 });
  });

  it('drops earlier settings that are not a number, a flag or a word', () => {
    const { config } = readProfileConfig({ settings: { stability: 0.5, speakerBoost: true, voiceName: 'Ruth', broken: null, nested: { a: 1 }, list: [1], 'Bad-Key': 1 } });
    expect(config.providerSettings).toEqual({ stability: 0.5, speakerBoost: true, voiceName: 'Ruth' });
  });

  it('reads the current shape as it is stored', () => {
    const stored: VoiceProfileConfig = {
      strategy: 'EXPRESSIVE',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      numberStyle: 'US',
      pronunciation: { rules: [{ term: 'Thijs', method: 'ALIAS', pronunciation: 'Tice' }] },
      performanceRules: { ...TODAYS_RULES, maxMarksPerChunk: 1, resetWord: 'plain' },
      providerSettings: { stability: 0.3, similarity: 0.75, warmth: 'high' },
    };
    expect(readProfileConfig(JSON.parse(JSON.stringify(stored)))).toEqual({ config: stored, legacy: false });
  });

  it('fills a partial current shape from the frozen earlier values, rule by rule, and keeps the valid pronunciation rules', () => {
    const { config, legacy } = readProfileConfig({
      providerSettings: { tempo: 1.1 },
      performanceRules: { maxMarksPerChunk: 1, minWordsBetweenMarks: 99 },
      pronunciation: { rules: [{ term: 'Haarlem', method: 'IPA', pronunciation: 'ˈɦaːrlɛm' }, { term: '', method: 'ALIAS', pronunciation: 'x' }, { term: 'VOC', method: 'DEFAULT', pronunciation: 'x' }] },
    });
    expect(legacy).toBe(false);
    expect(config.providerSettings).toEqual({ tempo: 1.1 });
    expect(config.performanceRules).toEqual({ ...TODAYS_RULES, maxMarksPerChunk: 1 });
    expect(config.pronunciation.rules).toEqual([{ term: 'Haarlem', method: 'IPA', pronunciation: 'ˈɦaːrlɛm' }]);
    expect(config.strategy).toBe('RESTRAINED');
    expect(config.chunking).toEqual({ minWords: 20, maxWords: 30 });
  });

  it('never throws, and always returns a valid config', () => {
    const garbage: unknown[] = [null, undefined, 42, 'config', [], [1, 2], { settings: 5 }, { providerSettings: null }, { providerSettings: [1] }, { chunking: { minWords: 30, maxWords: 20 } }, { context: 'none', strategy: 'LOUD', numberStyle: 'FR' }, { performanceRules: 'x', pronunciation: { rules: 'x' }, providerSettings: {} }];
    for (const raw of garbage) {
      const { config } = readProfileConfig(raw);
      expect(VoiceProfileConfig.safeParse(config).success, JSON.stringify(raw)).toBe(true);
    }
    expect(readProfileConfig({ chunking: { minWords: 30, maxWords: 20 } }).config.chunking).toEqual({ minWords: 20, maxWords: 30 });
    expect(readProfileConfig(null).legacy).toBe(true);
  });

  it('gives a copy: changing what it returns changes neither the earlier rules nor the next read', () => {
    const first = readProfileConfig({});
    first.config.performanceRules.maxMarksPerChunk = 5;
    first.config.chunking.maxWords = 99;
    expect(EARLIER_PERFORMANCE_RULES.maxMarksPerChunk).toBe(2);
    expect(readProfileConfig({}).config.performanceRules.maxMarksPerChunk).toBe(2);
    expect(readProfileConfig({}).config.chunking.maxWords).toBe(30);
  });
});

describe('overrides', () => {
  it('take what a project, a run or a take may set, and refuse keys they do not know', () => {
    const o = { strategy: 'EXPRESSIVE', context: { previousChars: 0, nextChars: 0, stitch: false }, numberStyle: 'US', performanceRules: { maxMarksPerChunk: 1 }, providerSettings: { stability: 0.4 } };
    expect(VoiceConfigOverrides.parse(o)).toEqual(o);
    expect(VoiceConfigOverrides.safeParse({ strategy: 'PLAIN', voiceId: 'x' }).success).toBe(false);
    expect(VoiceConfigOverrides.safeParse({ providerSettings: { stability: null } }).success).toBe(false);
    expect(VoiceRunOptions).toBe(VoiceConfigOverrides);
  });

  it('give a take no chunking (its chunk is the run’s), and are strict there too', () => {
    expect(VoiceTakeOverride.safeParse({ strategy: 'PLAIN', providerSettings: { stability: 0.3 } }).success).toBe(true);
    expect(VoiceTakeOverride.safeParse({ chunking: { minWords: 13, maxWords: 20 } }).success).toBe(false);
    expect(VoiceTakeOverride.safeParse({ strategy: 'PLAIN', model: 'other' }).success).toBe(false);
  });
});

describe('library and selection inputs', () => {
  it('save a run as a new profile by name or as a new version of one, never both or neither', () => {
    expect(SaveRunAsProfileInput.safeParse({ name: 'Tulip narrator', use: true }).success).toBe(true);
    expect(SaveRunAsProfileInput.safeParse({ familyId: FAMILY, generationId: CHUNK }).success).toBe(true);
    expect(SaveRunAsProfileInput.safeParse({ name: 'Tulip narrator', familyId: FAMILY }).success).toBe(false);
    expect(SaveRunAsProfileInput.safeParse({}).success).toBe(false);
    expect(SaveRunAsProfileInput.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('choose a profile for a language version at the revision the editor saw; a pin needs its profile', () => {
    expect(VoiceSelectionInput.parse({ familyId: FAMILY, revision: 0 })).toEqual({ familyId: FAMILY, overrides: {}, revision: 0 });
    expect(VoiceSelectionInput.safeParse({ familyId: FAMILY, versionId: VERSION, revision: 3, overrides: { providerSettings: { stability: 0.4 } } }).success).toBe(true);
    expect(VoiceSelectionInput.safeParse({ familyId: null, revision: 1 }).success).toBe(true);
    expect(VoiceSelectionInput.safeParse({ familyId: null, versionId: VERSION, revision: 1 }).success).toBe(false);
    expect(VoiceSelectionInput.safeParse({ familyId: FAMILY }).success).toBe(false);
    expect(VoiceSelectionInput.safeParse({ familyId: FAMILY, revision: 1, overrides: { voiceId: 'x' } }).success).toBe(false);
  });

  it('carry the selection revision a plan was made at, and a variant may narrate with another saved profile', () => {
    expect(PlanVoiceRunInput.parse({ scope: AUDITION, selectionRevision: 4 }).selectionRevision).toBe(4);
    const parsed = VoiceExperimentInput.parse({ scope: AUDITION, name: 'Profiles', selectionRevision: 2, variants: [{ profileId: VERSION }, { strategy: 'PLAIN', providerSettings: { stability: 0.3 } }] });
    expect(parsed.variants).toEqual([
      { label: 'A', profileId: VERSION },
      { label: 'B', strategy: 'PLAIN', providerSettings: { stability: 0.3 } },
    ]);
    expect(parsed.selectionRevision).toBe(2);
  });

  it('refuse a key a comparison variant does not take (a misspelt setting is not paid for unheard); a preset’s question is taken and left out', () => {
    const experiment = (variants: unknown[]) => VoiceExperimentInput.safeParse({ scope: AUDITION, name: 'Stability', variants });
    expect(experiment([{ providerSetings: { stability: 0.3 } }, { strategy: 'PLAIN' }]).success).toBe(false);
    expect(experiment([{ strategy: 'PLAIN', stability: 0.3 }, { strategy: 'RESTRAINED' }]).success).toBe(false);
    const asked = experiment([{ label: 'A plain', strategy: 'PLAIN', question: 'What does the voice do with no direction?' }, { strategy: 'RESTRAINED' }]);
    expect(asked.success && asked.data.variants).toEqual([
      { label: 'A plain', strategy: 'PLAIN' },
      { label: 'B', strategy: 'RESTRAINED' },
    ]);
  });

  it('refuse a field a version does not take: never saved without it (an edit cannot change the language)', () => {
    expect(NewVoiceProfileVersionInput.safeParse({ fields: { strategy: 'EXPRESSIVE' } }).success).toBe(true);
    expect(NewVoiceProfileVersionInput.safeParse({ fields: { strategy: 'EXPRESSIVE', language: 'es' } }).success).toBe(false);
    expect(NewVoiceProfileVersionInput.safeParse({ fields: { model: 'eleven_v4' } }).success).toBe(false);
    expect(CreateVoiceProfileFamilyInput.safeParse({ name: 'Tulip narrator', fields: { language: 'es', providerSettings: { stability: 0.4 } } }).success).toBe(true);
    expect(CreateVoiceProfileFamilyInput.safeParse({ name: 'Tulip narrator', fields: { stability: 0.4 } }).success).toBe(false);
    expect(DuplicateVoiceProfileInput.safeParse({ name: 'Tulip narrator (es)', fields: { language: 'es' } }).success).toBe(true);
    expect(DuplicateVoiceProfileInput.safeParse({ name: 'Tulip narrator (es)', fields: { lang: 'es' } }).success).toBe(false);
  });

  it('record how a version was made', () => {
    const run = { kind: 'RUN', runId: CHUNK, run: 3, projectId: OTHER, project: 'tulip-mania', experiment: 'Acceptance experiment', variant: 'C expressive', takeId: null, reconstructed: true };
    expect(VoiceProfileOrigin.parse(run)).toEqual(run);
    expect(VoiceProfileOrigin.safeParse({ kind: 'EDIT' }).success).toBe(false);
  });

  it('store how a take differs from its run', () => {
    const effective = { ...DEFAULT_VOICE_PROFILE_CONFIG, provider: 'mock', voiceId: 'voice-test', model: 'mock', language: 'en', outputFormat: 'wav_22050' };
    const take = {
      reconstructed: false,
      base: 'PRODUCTION',
      override: { providerSettings: { stability: 0.3 } },
      profile: { familyId: FAMILY, familyName: 'Tulip narrator', versionId: VERSION, version: 2, name: 'Tulip narrator' },
      effective,
      provenance: { 'providerSettings.stability': 'TAKE' },
      differs: ['stability: 0.3 (run: 0.5)'],
      identityDiffers: true,
    };
    expect(VoiceTakeConfig.parse(take)).toEqual(take);
    expect(VoiceTakeConfig.safeParse({ ...take, override: { chunking: { minWords: 13, maxWords: 20 } } }).success).toBe(false);
  });
});

describe('stored voice JSON written before the production changes', () => {
  it('reads pauses without a reason, and keeps a reason when there is one', () => {
    const old = { before: 'SHORT', after: 'MEDIUM', inside: [{ afterSentence: 0, length: 'LONG' }] };
    expect(ChunkPauses.parse(old)).toEqual(old);
    expect(ChunkPerformance.parse({ pace: 'SLOW', energy: 'LOW', emotion: 'REFLECTIVE', pauses: old }).pauses.inside[0]).toEqual({ afterSentence: 0, length: 'LONG' });
    expect(ChunkPauses.parse({ ...old, inside: [{ afterSentence: 0, length: 'LONG', reason: 'REVEAL' }] }).inside[0]?.reason).toBe('REVEAL');
    expect(ChunkPauses.parse({ ...old, inside: [{ afterSentence: 0, length: 'LONG', reason: null }] }).inside[0]?.reason).toBeNull();
    expect(ChunkPauses.safeParse({ ...old, inside: [{ afterSentence: 0, length: 'LONG', reason: 'SUSPENSE' }] }).success).toBe(false);
  });

  it('reads a prepared take of the earlier shape (five settings, nothing recorded as sent), and a new one with what was sent', () => {
    const prepared = {
      strategy: 'RESTRAINED',
      spokenForms: [{ kind: 'YEAR', start: 3, end: 7, display: '1637', spoken: 'sixteen thirty-seven', confidence: 'HIGH' }],
      marks: [{ sentence: 0, intent: { emotion: 'curious', delivery: null, intensity: 'LOW', pacing: 'NORMAL', vocalAction: null }, source: 'SCRIPT', reason: 'block SC01-B01' }],
      pauses: { before: 'NONE', after: 'SHORT', inside: [{ afterSentence: 0, length: 'MEDIUM' }] },
      context: { previousText: null, nextText: 'It was a promise.' },
      settings: EARLIER_SETTINGS,
      seed: 7,
      dictionary: [],
      unsupported: [],
      checks: [{ id: 'words', label: 'Words unchanged', status: 'PASS', detail: '' }],
    };
    const old = PreparedNarration.parse(JSON.parse(JSON.stringify(prepared)));
    expect(old).toEqual(prepared);
    expect(old.sent).toBeUndefined();
    const sent = { stability: 0.5, similarity: 0.75 };
    expect(PreparedNarration.parse({ ...prepared, sent }).sent).toEqual(sent);
    expect(PreparedNarration.parse({ ...prepared, settings: { warmth: 'high', breathy: false, tempo: 1.06 } }).settings).toEqual({ warmth: 'high', breathy: false, tempo: 1.06 });
    expect(PreparedNarration.safeParse({ ...prepared, settings: { stability: null } }).success).toBe(false);
  });

  it('reads assembly entries and timeline parts without an audio asset, and keeps one when recorded', () => {
    const entry = { chunkId: 'c1', chunkIndex: 0, generationId: 'g1', generation: 1, sectionKey: 'SC01', blockKeys: ['SC01-B01'], startMs: 0, endMs: 9400, gapAfterMs: 300 };
    expect(AssemblyEntry.parse(entry)).toEqual(entry);
    expect(AssemblyEntry.parse({ ...entry, audioAssetId: 'a1' }).audioAssetId).toBe('a1');
    const part = {
      scriptBlock: { id: 'b1', key: 'SC01-B01', sectionKey: 'SC01' },
      audioChunk: { id: 'c1', index: 0, generationId: 'g1', generation: 1 },
      startMs: 0,
      endMs: 9400,
      durationMs: 9400,
      text: 'In 1637 a bulb changed hands.',
      words: [{ word: 'In', startMs: 0, endMs: 120 }],
      performance: { pace: 'NORMAL', energy: 'MEDIUM', emotion: 'NEUTRAL' },
      visualHints: { intent: 'ENVIRONMENT', priority: 'NORMAL', mustShow: [], fictional: false },
    };
    expect(NarrationTimelineEntry.parse(part)).toEqual(part);
    expect(NarrationTimelineEntry.parse({ ...part, audioChunk: { ...part.audioChunk, audioAssetId: 'a1' } }).audioChunk.audioAssetId).toBe('a1');
  });

  it('reads the earlier QA kinds and the new ones', () => {
    for (const kind of ['MISSING_AUDIO', 'TAKE_UNREVIEWED', 'STORAGE_FAILED', 'ASSEMBLY_MISMATCH']) {
      expect(VoiceQaFinding.safeParse({ kind, severity: 'BLOCKING', ref: '#1', detail: '' }).success).toBe(true);
    }
    expect(VOICE_QA_KINDS).toContain('CONFIGURATION_DIFFERS');
    expect(VoiceQaFinding.safeParse({ kind: 'CONFIGURATION_DIFFERS', severity: 'WARNING', ref: '#4', detail: "Chunk 4's take 3 was made with the production profile" }).success).toBe(true);
  });

  it('reads run settings and comparison options of the earlier shape', () => {
    const settings = { chunking: { minWords: 25, maxWords: 80 }, context: { previousChars: 200, nextChars: 120, stitch: false } };
    expect(VoiceRunOptions.parse({ strategy: 'DIRECTED', ...settings })).toEqual({ strategy: 'DIRECTED', ...settings });
  });
});

describe('labels', () => {
  it('names every status, strategy and boundary', () => {
    for (const s of VOICE_GENERATION_STATUSES) expect(VOICE_GENERATION_STATUS_LABELS[s]).toBeTruthy();
    for (const s of PERFORMANCE_STRATEGIES) expect(PERFORMANCE_STRATEGY_LABELS[s] && PERFORMANCE_STRATEGY_HELP[s]).toBeTruthy();
    for (const b of CHUNK_BOUNDARIES) expect(CHUNK_BOUNDARY_LABELS[b]).toBeTruthy();
    expect(PERFORMANCE_STRATEGY_LABELS.EXPRESSIVE).toBe('Expressive moments');
    expect(VOICE_GENERATION_STATUS_LABELS.IN_REVIEW).toBe('To review');
  });

  it('names every configuration source, selection mode, take base, performance rule and origin', () => {
    for (const s of CONFIG_SOURCES) expect(CONFIG_SOURCE_LABELS[s]).toBeTruthy();
    for (const m of SELECTION_MODES) expect(SELECTION_MODE_LABELS[m]).toBeTruthy();
    for (const b of ['RUN', 'PRODUCTION'] as const) expect(TAKE_CONFIG_BASE_LABELS[b]).toBeTruthy();
    for (const k of Object.keys(PerformanceRules.shape) as (keyof PerformanceRules)[]) expect(PERFORMANCE_RULE_LABELS[k]).toBeTruthy();
    for (const k of ['DEFAULTS', 'LIBRARY', 'EDIT', 'DUPLICATE', 'RUN', 'LEGACY'] as const) expect(VOICE_PROFILE_ORIGIN_LABELS[k]).toBeTruthy();
    expect(Object.keys(PERFORMANCE_RULE_LABELS).sort()).toEqual(Object.keys(PerformanceRules.shape).sort());
  });

  it('orders strategies from no direction to over-direction', () => {
    expect(PERFORMANCE_STRATEGIES).toEqual(['PLAIN', 'RESTRAINED', 'EXPRESSIVE', 'DIRECTED']);
  });
});

describe('VoiceExperimentInput', () => {
  const variant = (label?: string) => ({ ...(label ? { label } : {}), strategy: 'RESTRAINED' as const });

  it('still takes a labelled comparison of the earlier shape', () => {
    const input = { scope: AUDITION, name: 'Direction', variants: [{ label: 'A plain', strategy: 'PLAIN' as const }, { label: 'B restrained', strategy: 'RESTRAINED' as const }], confirm: true };
    expect(VoiceExperimentInput.parse(input).variants).toEqual(input.variants);
  });

  it('takes 2–8 variants', () => {
    const of = (n: number) => VoiceExperimentInput.safeParse({ scope: AUDITION, name: 'Size', variants: Array.from({ length: n }, () => variant()) });
    expect(of(1).success).toBe(false);
    expect(of(2).success).toBe(true);
    expect(of(8).success).toBe(true);
    expect(of(9).success).toBe(false);
  });

  it('names unlabelled variants by their place and refuses two with one label', () => {
    const parsed = VoiceExperimentInput.parse({ scope: AUDITION, name: 'Mixed', variants: [variant(), variant('Long chunks'), variant()] });
    expect(parsed.variants.map((v) => v.label)).toEqual(['A', 'Long chunks', 'C']);
    expect(VoiceExperimentInput.safeParse({ scope: AUDITION, name: 'Twice', variants: [variant('B'), variant()] }).success).toBe(false);
    expect(VoiceExperimentInput.safeParse({ scope: AUDITION, name: 'Case', variants: [variant('plain'), variant('Plain')] }).success).toBe(false);
  });

  it('lets each variant set its own strategy, chunking and context', () => {
    const parsed = VoiceExperimentInput.parse({
      scope: AUDITION,
      name: 'Each',
      variants: [
        { strategy: 'EXPRESSIVE' },
        { chunking: { minWords: 13, maxWords: 20 } },
        { context: { previousChars: 0, nextChars: 0, stitch: false } },
      ],
    });
    expect(parsed.variants).toEqual([
      { label: 'A', strategy: 'EXPRESSIVE' },
      { label: 'B', chunking: { minWords: 13, maxWords: 20 } },
      { label: 'C', context: { previousChars: 0, nextChars: 0, stitch: false } },
    ]);
  });
});

describe('VOICE_ACCEPTANCE_EXPERIMENT', () => {
  const variants = VOICE_ACCEPTANCE_EXPERIMENT.variants;
  const byLetter = (l: string) => variants.find((v) => v.label.startsWith(`${l} `))!;
  const house = { chunking: DEFAULT_VOICE_PROFILE_CONFIG.chunking, context: DEFAULT_VOICE_PROFILE_CONFIG.context };

  it('is a valid experiment of seven variants, A to G, on the opening', () => {
    const input: VoiceExperimentInput = { ...VOICE_ACCEPTANCE_EXPERIMENT, confirm: true };
    const parsed = VoiceExperimentInput.parse(input);
    expect(parsed.scope).toEqual(AUDITION);
    expect(parsed.variants.map((v) => v.label[0])).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(parsed.variants.every((v) => !('question' in v))).toBe(true);
  });

  it('compares direction at the house settings', () => {
    expect(['A', 'B', 'C', 'D'].map((l) => byLetter(l).strategy)).toEqual(['PLAIN', 'RESTRAINED', 'EXPRESSIVE', 'DIRECTED']);
    for (const l of ['A', 'B', 'C', 'D']) expect(byLetter(l)).toMatchObject(house);
  });

  it('varies one setting at a time against B for context and chunk size', () => {
    const b = byLetter('B');
    const differences = (v: (typeof variants)[number]) => (['strategy', 'chunking', 'context'] as const).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(b[k]));
    expect(differences(byLetter('E'))).toEqual(['context']);
    expect(byLetter('E').context).toEqual({ previousChars: 0, nextChars: 0, stitch: false });
    expect(differences(byLetter('F'))).toEqual(['chunking']);
    expect(differences(byLetter('G'))).toEqual(['chunking']);
  });

  it('sizes F at about 5–8 s and G at about 12–20 s', () => {
    expect(byLetter('F').chunking).toEqual({ minWords: wordsForSeconds(CHUNK_SECONDS.natural.min), maxWords: wordsForSeconds(CHUNK_SECONDS.target.min) });
    expect(byLetter('G').chunking).toEqual({ minWords: wordsForSeconds(CHUNK_SECONDS.target.max), maxWords: wordsForSeconds(CHUNK_SECONDS.natural.max) });
  });

  it('spells every variant out, with what it is there to hear', () => {
    for (const v of variants) {
      expect(v.strategy && v.chunking && v.context).toBeTruthy();
      expect(v.question.length).toBeGreaterThan(10);
    }
  });

  it('is unchanged by saved profiles (the same seven variants the user heard)', () => {
    const house = { chunking: { minWords: 20, maxWords: 30 }, context: { previousChars: 200, nextChars: 120, stitch: false } };
    expect(JSON.parse(JSON.stringify(VOICE_ACCEPTANCE_EXPERIMENT))).toEqual({
      name: 'Acceptance experiment',
      scope: { kind: 'AUDITION', seconds: 100 },
      variants: [
        { label: 'A plain', strategy: 'PLAIN', ...house, question: 'What does the voice do with no direction?' },
        { label: 'B restrained', strategy: 'RESTRAINED', ...house, question: 'Does the house style sound like a documentary narrator?' },
        { label: 'C expressive', strategy: 'EXPRESSIVE', ...house, question: 'Do the deliberate moments land, or over-act?' },
        { label: 'D over-directed', strategy: 'DIRECTED', ...house, question: 'What does over-direction sound like (the reference to avoid)?' },
        { label: 'E no context', strategy: 'RESTRAINED', chunking: house.chunking, context: { previousChars: 0, nextChars: 0, stitch: false }, question: 'Does neighbouring text help continuity (B without it)?' },
        { label: 'F 5–8 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 13, maxWords: 20 }, context: house.context, question: 'Are smaller chunks more natural, or choppy (B smaller)?' },
        { label: 'G 12–20 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 30, maxWords: 50 }, context: house.context, question: 'Do larger chunks stay natural, or flatten (B larger)?' },
      ],
    });
  });
});

describe('RegenerateVoiceInput', () => {
  it('still takes the earlier requests', () => {
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK] }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], marks: [{ sentence: 0, emotion: 'reflective' }], note: 'C' }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ section: 2, strategy: 'RESTRAINED' }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK, OTHER], marks: [{ sentence: 0, emotion: 'reflective' }] }).success).toBe(false);
  });

  it('takes an A/B of chosen chunks, naming unlabelled sides by their place', () => {
    const parsed = RegenerateVoiceInput.parse({ chunkIds: [CHUNK, OTHER], variants: [{ strategy: 'RESTRAINED' }, { label: 'B reflective', strategy: 'EXPRESSIVE' }], confirm: true });
    expect(parsed.variants).toEqual([
      { label: 'A', strategy: 'RESTRAINED' },
      { label: 'B reflective', strategy: 'EXPRESSIVE' },
    ]);
  });

  it('refuses variants that are not an A/B of chosen chunks', () => {
    const ab = [{ strategy: 'PLAIN' as const }, { strategy: 'RESTRAINED' as const }];
    expect(RegenerateVoiceInput.safeParse({ section: 1, variants: ab }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ all: true, variants: ab }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: ab.slice(0, 1) }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: [...ab, ...ab] }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: ab, strategy: 'DIRECTED' }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: ab, marks: [{ sentence: 0, emotion: 'curious' }] }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: [{ label: 'X' }, { label: 'x' }] }).success).toBe(false);
  });

  it('takes directions in a variant only for a single chunk', () => {
    const directed = [{ strategy: 'RESTRAINED' as const }, { marks: [{ sentence: 1, delivery: 'quiet' }] }];
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: directed }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK, OTHER], variants: directed }).success).toBe(false);
  });

  it("takes the run's configuration or the production profile, with a temporary override", () => {
    expect(RegenerateVoiceInput.parse({ chunkIds: [CHUNK] }).configuration).toBeUndefined();
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], configuration: 'PRODUCTION', selectionRevision: 2 }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], configuration: 'RUN', override: { providerSettings: { stability: 0.3 }, context: { previousChars: 0, nextChars: 0, stitch: false } } }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ section: 1, configuration: 'PRODUCTION', override: { strategy: 'PLAIN' } }).success).toBe(true);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], configuration: 'LATEST' }).success).toBe(false);
  });

  it('refuses chunking in an override, the strategy given twice, and an override strategy with variants', () => {
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], override: { chunking: { minWords: 13, maxWords: 20 } } }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], strategy: 'PLAIN', override: { strategy: 'EXPRESSIVE' } }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], strategy: 'PLAIN', override: { providerSettings: { stability: 0.3 } } }).success).toBe(true);
    const ab = [{ strategy: 'PLAIN' as const }, { strategy: 'RESTRAINED' as const }];
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: ab, override: { strategy: 'EXPRESSIVE' } }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: ab, override: { providerSettings: { stability: 0.3 } } }).success).toBe(true);
  });

  it('refuses a setting inside an A/B variant instead of making two takes that differ only in their label', () => {
    const variants = [{ label: 'A steady', providerSettings: { stability: 0.6 } }, { label: 'B loose', providerSettings: { stability: 0.3 } }];
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants, confirm: true }).success).toBe(false);
    expect(RegenerateVoiceInput.safeParse({ chunkIds: [CHUNK], variants: [{ label: 'A neutral' }, { label: 'B reflective', marks: [{ sentence: 0, emotion: 'reflective' }] }] }).success).toBe(true);
  });
});
