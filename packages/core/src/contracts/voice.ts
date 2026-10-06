import { z } from 'zod';
import {
  DELIVERY_EMOTIONS,
  DELIVERY_ENERGIES,
  DELIVERY_PACES,
  PAUSE_LENGTHS,
  PAUSE_REASONS,
  PERFORMANCE_STRATEGIES,
  PRONUNCIATION_METHODS,
  PRONUNCIATION_STATUSES,
  PRONUNCIATION_TERM_KINDS,
  SPOKEN_FORM_KINDS,
  VISUAL_INTENTS,
  VISUAL_PRIORITIES,
} from '../enums.ts';

/**
 * Voice Engine 1.0 — narration is the first temporal production layer. An
 * approved script version is narrated in voice runs; a run splits its blocks
 * into small chunks of natural speech; each chunk is generated as takes
 * (generations) that are reviewed one by one; the current takes are
 * assembled, and the assembly's actual timing — not a words-per-minute
 * estimate — is what everything downstream is timed against.
 *
 * The script is never changed by any of this: spoken forms (numbers, dates,
 * aliases) and performance markup are derived representations, stored with
 * each take next to the canonical text they were derived from.
 */

// ── Voice profiles ───────────────────────────────────────────────────────────

/**
 * A saved voice profile is a family with immutable versions: each version
 * fixes provider, voice, model, language and output format, and a
 * VoiceProfileConfig. A project chooses one per language version and may
 * override supported settings without changing it; every run and take keeps
 * the configuration it was made with.
 */

/** A provider setting's value: a number, a flag or a word. */
export const VoiceSettingValue = z.union([z.number(), z.boolean(), z.string()]);
export type VoiceSettingValue = z.infer<typeof VoiceSettingValue>;

/** Provider-specific settings under the provider's own keys; the provider describes, checks and normalises them. */
export const ProviderSettingValues = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), VoiceSettingValue);
export type ProviderSettingValues = z.infer<typeof ProviderSettingValues>;

/**
 * One provider-specific voice setting, described by the provider so a form
 * can be built and a value checked without the engine knowing the provider.
 */
export interface VoiceSettingDescriptor {
  key: string;
  label: string;
  help: string;
  kind: 'NUMBER' | 'BOOLEAN' | 'CHOICE';
  default: VoiceSettingValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: { value: string; label: string }[];
  /** The models it is sent to (null: every model but those in `except`; a model the provider does not know is "every model"); `VoiceProvider.sentSettings` is what decides. */
  models: string[] | null;
  except?: string[];
  /** A project, a run or a single take may set it over the profile. */
  overridable: boolean;
  /** SPEED: the base speaking rate (1 = natural), scaled by a chunk's pace where the model takes it. */
  role?: 'SPEED';
}

/** Short, plain words a provider can turn into its own direction ("reflective", "intimate", "exhales"). */
const Descriptor = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .regex(/^[a-z][a-z \-']*[a-z]$/, 'lower-case words only (no digits, quotes or brackets)');

/**
 * Seconds of speech a chunk is sized for: about 8–12 by default, 5–20 when
 * that keeps a natural thought whole (a setup and its payoff, a question and
 * its answer). Natural boundaries come before duration.
 */
export const CHUNK_SECONDS = { target: { min: 8, max: 12 }, natural: { min: 5, max: 20 } } as const;

/** Chunk size in spoken words (a figure counts as it is read): the smallest useful regeneration unit that still sounds like one piece of speech. */
export const ChunkingSettings = z
  .object({ minWords: z.number().int().min(5).max(200), maxWords: z.number().int().min(10).max(300) })
  .refine((c) => c.minWords < c.maxWords, { message: 'minWords must be below maxWords', path: ['minWords'] });
export type ChunkingSettings = z.infer<typeof ChunkingSettings>;

/**
 * Continuity between independently generated chunks: neighbouring narration
 * sent as context (heard by the model, never generated; 0 = none), and —
 * where the model supports it — request stitching (the previous take's
 * request id as context instead of its text; takes are then generated one
 * after another).
 */
export const ContextSettings = z.object({ previousChars: z.number().int().min(0).max(1000), nextChars: z.number().int().min(0).max(1000), stitch: z.boolean() });
export type ContextSettings = z.infer<typeof ContextSettings>;

const NumberStyle = z.enum(['UK', 'US']);

/**
 * The house style's limits and words, as a profile sets them. A strategy's
 * own definition is not a rule: EXPRESSIVE is one moment of at most two
 * cues, and DIRECTED's words are the reference to avoid.
 */
export const PerformanceRules = z.object({
  /** House-style directions translated from the script, per chunk. */
  maxMarksPerChunk: z.number().int().min(0).max(6),
  /** Spoken words at least between two directions (a reset to the plain register excepted). */
  minWordsBetweenMarks: z.number().int().min(0).max(40),
  /** The director's own directions warn above one per this many words. */
  directorWordsPerMark: z.number().int().min(1).max(100),
  /** The word for each scripted feeling (null: no direction for it). */
  emotionWords: z.object({
    REFLECTIVE: Descriptor.nullable(),
    CURIOUS: Descriptor.nullable(),
    TENSE: Descriptor.nullable(),
    SOMBER: Descriptor.nullable(),
    EXCITED: Descriptor.nullable(),
  }),
  /** The word for each scripted manner (also the manner of a turn the script gives no delivery). */
  deliveryWords: z.object({ lowEnergy: Descriptor, slowPace: Descriptor, highEnergy: Descriptor, fastPace: Descriptor }),
  /** Back to the plain register. */
  resetWord: Descriptor,
  /** A chunk's pace as a multiple of the base speed, for models that take a speed. */
  paceSpeed: z.object({ SLOW: z.number().min(0.7).max(1), FAST: z.number().min(1).max(1.3) }),
});
export type PerformanceRules = z.infer<typeof PerformanceRules>;

/** Freezes an object and every object in it. */
function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/** A deep copy of plain data (structuredClone is not in this package's lib; JSON is exact for these constants). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * What the engine applied before saved profiles. Frozen: versions in the
 * earlier shape and runs made before 2026-10-06 are read with it. Never edit
 * it; tune DEFAULT_PERFORMANCE_RULES instead.
 */
export const EARLIER_PERFORMANCE_RULES: PerformanceRules = deepFreeze({
  maxMarksPerChunk: 2,
  minWordsBetweenMarks: 6,
  directorWordsPerMark: 10,
  emotionWords: { REFLECTIVE: 'reflective', CURIOUS: 'curious', TENSE: 'tense', SOMBER: 'somber', EXCITED: 'excited' },
  deliveryWords: { lowEnergy: 'quiet', slowPace: 'deliberate', highEnergy: 'urgent', fastPace: 'brisk' },
  resetWord: 'matter-of-fact',
  paceSpeed: { SLOW: 0.94, FAST: 1.06 },
});

/** A new profile's rules (today the same as EARLIER_PERFORMANCE_RULES). */
export const DEFAULT_PERFORMANCE_RULES: PerformanceRules = copy(EARLIER_PERFORMANCE_RULES);

const MANNERS: Record<keyof PerformanceRules['deliveryWords'], string> = { lowEnergy: 'low energy', slowPace: 'slow pace', highEnergy: 'high energy', fastPace: 'fast pace' };

/**
 * What the rules' schema cannot see: a reset word that is also a delivery
 * word would make every direction in that word read as a reset (exempt from
 * the spacing between directions). Empty when the rules work together.
 */
export function performanceRulesProblems(rules: PerformanceRules): string[] {
  return (Object.keys(MANNERS) as (keyof typeof MANNERS)[])
    .filter((m) => rules.deliveryWords[m] === rules.resetWord)
    .map((m) => `resetWord: "${rules.resetWord}" is also the word for ${MANNERS[m]}; a direction in it would be read as a reset`);
}

const ProfilePronunciationRule = z.object({
  term: z.string().trim().min(1).max(80),
  method: z.enum(['ALIAS', 'IPA', 'CMU']),
  pronunciation: z.string().trim().min(1).max(200),
});

/**
 * How a profile's terms are said beyond the project's approved review list
 * (which always applies, and wins for a term it has approved): the profile's
 * own rules, e.g. a voice's known misreadings. Phoneme rules reach the
 * provider the way the project's do.
 */
export const PronunciationConfig = z.object({ rules: z.array(ProfilePronunciationRule).max(200) });
export type PronunciationConfig = z.infer<typeof PronunciationConfig>;

/** Everything about how a profile version narrates beyond provider, voice, model, language and output format: reproducible as a whole. */
export const VoiceProfileConfig = z.object({
  /** Default performance strategy (a run may override it, e.g. for a comparison). */
  strategy: z.enum(PERFORMANCE_STRATEGIES),
  chunking: ChunkingSettings,
  context: ContextSettings,
  /** How spoken forms read amounts: "one hundred and twenty" (UK) or "one hundred twenty" (US). */
  numberStyle: NumberStyle,
  pronunciation: PronunciationConfig,
  performanceRules: PerformanceRules,
  /** The provider's own settings (its descriptors say what each is; normalised by the provider). */
  providerSettings: ProviderSettingValues,
});
export type VoiceProfileConfig = z.infer<typeof VoiceProfileConfig>;

/** The house default for a new profile (the provider fills in its settings' defaults). Never the acceptance winner. */
export const DEFAULT_VOICE_PROFILE_CONFIG: VoiceProfileConfig = {
  strategy: 'RESTRAINED',
  /** CHUNK_SECONDS.target at the narration rate: wordsForSeconds(8)–wordsForSeconds(12). */
  chunking: { minWords: 20, maxWords: 30 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  numberStyle: 'UK',
  pronunciation: { rules: [] },
  performanceRules: DEFAULT_PERFORMANCE_RULES,
  providerSettings: {},
};

/** How the engine filled a missing field before saved profiles. Frozen, like EARLIER_PERFORMANCE_RULES: a stored version always reads the same. */
const EARLIER_FILL: Pick<VoiceProfileConfig, 'strategy' | 'chunking' | 'context' | 'numberStyle'> = deepFreeze({
  strategy: 'RESTRAINED',
  chunking: { minWords: 20, maxWords: 30 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  numberStyle: 'UK',
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The value if the schema takes it, else a copy of the fill. */
const or = <T>(schema: z.ZodType<T>, value: unknown, fill: T): T => {
  const r = schema.safeParse(value);
  return r.success ? r.data : copy(fill);
};

/** Settings of a stored record that are a valid key with a number, a flag or a word (the rest are dropped). */
const settingValues = (raw: unknown): ProviderSettingValues =>
  Object.fromEntries(Object.entries(isRecord(raw) ? raw : {}).filter(([k, v]) => ProviderSettingValues.safeParse({ [k]: v }).success)) as ProviderSettingValues;

/**
 * A version's config as stored, in either shape: the current one, or the
 * earlier one (`settings` became `providerSettings`; no profile rules; the
 * rules are EARLIER_PERFORMANCE_RULES, what the engine did then). The earlier
 * shape is any config with `settings`, or without `providerSettings` (so `{}`
 * too). Missing or invalid fields are filled as the engine filled them then
 * (restrained, 20–30 words, 200/120 characters of context without stitching,
 * UK, the earlier rules: a frozen copy, not DEFAULT_VOICE_PROFILE_CONFIG);
 * provider settings that are missing are the provider's to fill. Never throws.
 */
export function readProfileConfig(raw: unknown): { config: VoiceProfileConfig; legacy: boolean } {
  const c = isRecord(raw) ? raw : {};
  const legacy = c.settings !== undefined || c.providerSettings === undefined;
  const context = isRecord(c.context) ? c.context : {};
  const shape = ContextSettings.shape;
  const base = {
    strategy: or(z.enum(PERFORMANCE_STRATEGIES), c.strategy, EARLIER_FILL.strategy),
    chunking: or(ChunkingSettings, c.chunking, EARLIER_FILL.chunking),
    context: {
      previousChars: or(shape.previousChars, context.previousChars, EARLIER_FILL.context.previousChars),
      nextChars: or(shape.nextChars, context.nextChars, EARLIER_FILL.context.nextChars),
      stitch: or(shape.stitch, context.stitch, EARLIER_FILL.context.stitch),
    },
    numberStyle: or(NumberStyle, c.numberStyle, EARLIER_FILL.numberStyle),
  };
  if (legacy) return { config: { ...base, pronunciation: { rules: [] }, performanceRules: copy(EARLIER_PERFORMANCE_RULES), providerSettings: settingValues(c.settings) }, legacy };
  const rules: Record<string, unknown> = copy(EARLIER_PERFORMANCE_RULES);
  const stored = isRecord(c.performanceRules) ? c.performanceRules : {};
  for (const [key, schema] of Object.entries(PerformanceRules.shape)) {
    const r = schema.safeParse(stored[key]);
    if (r.success) rules[key] = r.data;
  }
  const pronunciation = isRecord(c.pronunciation) && Array.isArray(c.pronunciation.rules) ? c.pronunciation.rules : [];
  return {
    config: {
      ...base,
      pronunciation: { rules: pronunciation.flatMap((r) => { const p = ProfilePronunciationRule.safeParse(r); return p.success ? [p.data] : []; }).slice(0, 200) },
      performanceRules: rules as PerformanceRules,
      providerSettings: settingValues(c.providerSettings),
    },
    legacy,
  };
}

// ── Effective configuration ──────────────────────────────────────────────────

/** A profile version's whole configuration, with whatever a project, a run or a take set over it. */
export const EffectiveVoiceConfig = VoiceProfileConfig.extend({
  provider: z.string(),
  voiceId: z.string(),
  model: z.string(),
  language: z.string(),
  outputFormat: z.string(),
});
export type EffectiveVoiceConfig = z.infer<typeof EffectiveVoiceConfig>;

/** Where a setting came from: the profile version, the project's overrides, the run's options, or a take's temporary override. */
export const CONFIG_SOURCES = ['PROFILE', 'PROJECT', 'RUN', 'TAKE'] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

/** Where each setting that is not the profile version's came from, by path ("strategy", "providerSettings.stability", "performanceRules.maxMarksPerChunk"). */
export const ConfigProvenance = z.record(z.string(), z.enum(CONFIG_SOURCES));
export type ConfigProvenance = z.infer<typeof ConfigProvenance>;

/**
 * Settings a project, a run or a single take may set over a profile version
 * — never stored on the profile. Provider settings only where the provider
 * marks them overridable; performance rules and provider settings merge key
 * by key.
 */
export const VoiceConfigOverrides = z
  .object({
    strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
    chunking: ChunkingSettings.optional(),
    context: ContextSettings.optional(),
    numberStyle: NumberStyle.optional(),
    performanceRules: PerformanceRules.partial().optional(),
    providerSettings: ProviderSettingValues.optional(),
  })
  .strict();
export type VoiceConfigOverrides = z.infer<typeof VoiceConfigOverrides>;

/** A take's temporary override: a run's chunks are fixed, so no chunking. */
export const VoiceTakeOverride = VoiceConfigOverrides.omit({ chunking: true });
export type VoiceTakeOverride = z.infer<typeof VoiceTakeOverride>;

/** A profile version as a run or take names it: its family (null for a version made before saved profiles and not yet adopted) and the version. */
export const VoiceProfileRef = z.object({
  familyId: z.uuid().nullable(),
  familyName: z.string().nullable(),
  versionId: z.uuid(),
  version: z.number().int().min(1),
  /** The version's own name (the family's name when it was made). */
  name: z.string(),
});
export type VoiceProfileRef = z.infer<typeof VoiceProfileRef>;

/** How a run's profile version was chosen: following the family's current version, pinned to one, the library default, or named by the request. */
export const SELECTION_MODES = ['FOLLOW', 'PIN', 'DEFAULT', 'EXPLICIT'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

/** What a run was made with, frozen when it was created. */
export const VoiceRunConfig = z.object({
  /** Read back from a run made before saved profiles (rebuilt from its profile version, strategy and settings). */
  reconstructed: z.boolean(),
  profile: VoiceProfileRef,
  /** How the version was chosen: the project's choice (FOLLOW, PIN, DEFAULT) at `revision`, or EXPLICIT (named by the request); null when reconstructed. */
  selection: z.object({ mode: z.enum(SELECTION_MODES), revision: z.number().int().min(0) }).nullable(),
  projectOverrides: VoiceConfigOverrides,
  runOptions: VoiceConfigOverrides,
  effective: EffectiveVoiceConfig,
  provenance: ConfigProvenance,
  /** Provider settings as the model is sent them, and those it does not take (kept in `effective`, not sent). */
  sent: ProviderSettingValues,
  ignored: z.array(z.string()),
});
export type VoiceRunConfig = z.infer<typeof VoiceRunConfig>;

/** What a take was made with. */
export const VoiceTakeConfig = z.object({
  reconstructed: z.boolean(),
  /** RUN: the run's configuration; PRODUCTION: the project's production profile when the take was asked for. */
  base: z.enum(['RUN', 'PRODUCTION']),
  /** A temporary override for this take only (null: none). */
  override: VoiceTakeOverride.nullable(),
  profile: VoiceProfileRef,
  effective: EffectiveVoiceConfig,
  provenance: ConfigProvenance,
  /** How it differs from its run's configuration, worked out when the take was asked for ("stability: 0.3 (run: 0.5)"); empty when it does not. */
  differs: z.array(z.string()),
  /** The difference is in what the voice sounds like (provider, voice, model, output format, provider settings, number style, pronunciation rules). */
  identityDiffers: z.boolean(),
});
export type VoiceTakeConfig = z.infer<typeof VoiceTakeConfig>;

/** How a version was made. */
export const VoiceProfileOrigin = z.discriminatedUnion('kind', [
  /** From the configured provider's defaults and the house default (the library default made at the first plan). */
  z.object({ kind: z.literal('DEFAULTS') }),
  /** Created in the library. */
  z.object({ kind: z.literal('LIBRARY') }),
  /** An edit: a new version of its family based on another. */
  z.object({ kind: z.literal('EDIT'), basedOnVersion: z.number().int() }),
  /** The first version of a new family, copied from another family's version. */
  z.object({ kind: z.literal('DUPLICATE'), fromFamily: z.string(), fromVersion: z.number().int() }),
  /** A run's (or one of its takes') configuration, saved. */
  z.object({
    kind: z.literal('RUN'),
    runId: z.uuid(),
    run: z.number().int(),
    projectId: z.uuid(),
    project: z.string(),
    experiment: z.string().nullable(),
    variant: z.string().nullable(),
    takeId: z.uuid().nullable(),
    reconstructed: z.boolean(),
  }),
]);
export type VoiceProfileOrigin = z.infer<typeof VoiceProfileOrigin>;

// ── Performance (provider-neutral) ───────────────────────────────────────────

/**
 * How a passage should be performed — open words rather than a closed list,
 * so expressive models can be directed in natural language; a provider
 * renders it in its own markup (or reports it cannot).
 */
export const PerformanceIntent = z.object({
  /** The feeling ("reflective", "curious"); null = none. */
  emotion: Descriptor.nullable(),
  /** How it is said ("intimate", "deliberate"); null = none. */
  delivery: Descriptor.nullable(),
  intensity: z.enum(DELIVERY_ENERGIES),
  pacing: z.enum(DELIVERY_PACES),
  /** A non-verbal sound ("exhales") — only ever from a director's instruction. */
  vocalAction: Descriptor.nullable(),
});
export type PerformanceIntent = z.infer<typeof PerformanceIntent>;

/** A performance direction placed before one sentence of a chunk, and where it came from. */
export const PerformanceMark = z.object({
  /** Index of the sentence (within the chunk) the direction precedes. */
  sentence: z.number().int().min(0),
  intent: PerformanceIntent,
  /** SCRIPT: translated from the script's delivery marks; STRATEGY: added by the strategy (an expressive moment, or over-direction); DIRECTOR: the editor's own. */
  source: z.enum(['SCRIPT', 'STRATEGY', 'DIRECTOR']),
  reason: z.string(),
});
export type PerformanceMark = z.infer<typeof PerformanceMark>;

/** A director's direction for one sentence of a chunk (regenerating it). */
export const DirectorMark = z.object({
  sentence: z.number().int().min(0).max(50),
  emotion: Descriptor.nullable().optional(),
  delivery: Descriptor.nullable().optional(),
  vocalAction: Descriptor.nullable().optional(),
});
export type DirectorMark = z.infer<typeof DirectorMark>;

/** A written form given a spoken one before generation (the script keeps the written form). */
export const SpokenForm = z.object({
  kind: z.enum(SPOKEN_FORM_KINDS),
  /** Character range in the canonical text. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  display: z.string(),
  spoken: z.string(),
  /** MEDIUM: a guess worth hearing (a four-digit number read as a year). */
  confidence: z.enum(['HIGH', 'MEDIUM']),
});
export type SpokenForm = z.infer<typeof SpokenForm>;

/** One deterministic check of a take's performance text, run before anything is sent. */
export const PerformanceCheck = z.object({ id: z.string(), label: z.string(), status: z.enum(['PASS', 'WARN', 'FAIL']), detail: z.string() });
export type PerformanceCheck = z.infer<typeof PerformanceCheck>;

/** Pauses at a chunk's edges and between its sentences. */
export const ChunkPauses = z.object({
  before: z.enum(PAUSE_LENGTHS),
  after: z.enum(PAUSE_LENGTHS),
  inside: z.array(
    z.object({
      afterSentence: z.number().int().min(0),
      length: z.enum(PAUSE_LENGTHS),
      /** Why the script pauses there (null: no reason given; absent in chunks planned before it was recorded). */
      reason: z.enum(PAUSE_REASONS).nullable().optional(),
    }),
  ),
});
export type ChunkPauses = z.infer<typeof ChunkPauses>;

/** The derived representation of one take: what was sent, how it was derived, and the checks it passed. */
export const PreparedNarration = z.object({
  strategy: z.enum(PERFORMANCE_STRATEGIES),
  spokenForms: z.array(SpokenForm),
  marks: z.array(PerformanceMark),
  pauses: ChunkPauses,
  /** Neighbouring narration sent as context (not generated), if any. */
  context: z.object({ previousText: z.string().nullable(), nextText: z.string().nullable() }),
  /** The take's provider settings with the chunk's pace applied (every key, sent or not). */
  settings: ProviderSettingValues,
  /** What the model was sent of them (`sentSettings`); absent on takes made before saved profiles. */
  sent: ProviderSettingValues.optional(),
  seed: z.number().int().nullable(),
  /** Pronunciation rules applied by the provider (phonemes), as term → rule. */
  dictionary: z.array(z.object({ term: z.string(), method: z.enum(PRONUNCIATION_METHODS), pronunciation: z.string() })),
  /** Directions the model cannot express (kept, reported). */
  unsupported: z.array(z.string()),
  checks: z.array(PerformanceCheck),
});
export type PreparedNarration = z.infer<typeof PreparedNarration>;

// ── Chunks, takes, alignment ─────────────────────────────────────────────────

/** A part of a script block spoken in a chunk: the block and a character range of its text. */
export const ChunkSpan = z.object({ blockId: z.string(), blockKey: z.string(), start: z.number().int().min(0), end: z.number().int().min(0) });
export type ChunkSpan = z.infer<typeof ChunkSpan>;

/** The script's delivery for a chunk (word-weighted across its blocks) and its pauses. */
export const ChunkPerformance = z.object({
  pace: z.enum(DELIVERY_PACES),
  energy: z.enum(DELIVERY_ENERGIES),
  emotion: z.enum(DELIVERY_EMOTIONS),
  pauses: ChunkPauses,
});
export type ChunkPerformance = z.infer<typeof ChunkPerformance>;

/** A word of the canonical text and when it is heard within the clip. */
export const TimedWord = z.object({
  word: z.string(),
  /** Character range in the chunk's canonical text. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type TimedWord = z.infer<typeof TimedWord>;

/** When each word of a take is heard. Provider timestamps when it returns them; otherwise none (never invented). */
export const NarrationAlignment = z.object({
  source: z.enum(['PROVIDER', 'MOCK']),
  words: z.array(TimedWord),
  /** The provider's character timestamps for the text it received, as returned. */
  characters: z.object({ chars: z.array(z.string()), startMs: z.array(z.number()), endMs: z.array(z.number()) }).nullable(),
  /** Words of the canonical text the timestamps could not be matched to. */
  unmatchedWords: z.number().int().min(0),
});
export type NarrationAlignment = z.infer<typeof NarrationAlignment>;

// ── QA ───────────────────────────────────────────────────────────────────────

export const VOICE_QA_KINDS = [
  'MISSING_AUDIO',
  'MISSING_ALIGNMENT',
  'ALIGNMENT_INCOMPLETE',
  'GENERATION_FAILED',
  /** The audio came back but could not be stored (the request may still have been billed). */
  'STORAGE_FAILED',
  'TAKE_REJECTED',
  'TAKE_UNREVIEWED',
  'STALE_TEXT',
  'STALE_SCRIPT',
  'DUPLICATE_CHUNK',
  'MISSING_CHUNK',
  /** The assembly's clips are not the chunks' current takes, or not where its entries say. */
  'ASSEMBLY_MISMATCH',
  'INCOMPLETE_NARRATION',
  'DURATION_ANOMALY',
  'EXCESSIVE_SILENCE',
  'PRONUNCIATION_UNRESOLVED',
  'SPOKEN_FORM_CHECK',
  'PERFORMANCE_CHECK',
  'MOCK_AUDIO',
  /** A chunk's current take was made with another voice than its run's (the production profile, or a temporary override): a warning. */
  'CONFIGURATION_DIFFERS',
] as const;
export type VoiceQaKind = (typeof VOICE_QA_KINDS)[number];

export const VoiceQaFinding = z.object({
  kind: z.enum(VOICE_QA_KINDS),
  severity: z.enum(['BLOCKING', 'WARNING']),
  /** "#3" for a chunk, a block key, or null for the whole run. */
  ref: z.string().nullable(),
  detail: z.string(),
});
export type VoiceQaFinding = z.infer<typeof VoiceQaFinding>;

// ── Assembly and the narration timeline ─────────────────────────────────────

/** One clip in an assembly, where it starts and ends in the assembled narration. */
export const AssemblyEntry = z.object({
  chunkId: z.string(),
  chunkIndex: z.number().int().min(0),
  generationId: z.string(),
  generation: z.number().int().min(1),
  /** The take's audio file (absent in assemblies made before it was recorded). */
  audioAssetId: z.string().optional(),
  sectionKey: z.string(),
  blockKeys: z.array(z.string()),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  /** Silence placed after the clip (a pause between chunks). */
  gapAfterMs: z.number().int().min(0),
});
export type AssemblyEntry = z.infer<typeof AssemblyEntry>;

/**
 * The downstream contract: for each part of a script block, when it is
 * heard in the assembled narration, its words, its performance and the
 * script's visual hints. The storyboard is timed against this, not against
 * a words-per-minute estimate.
 */
export const NarrationTimelineEntry = z.object({
  scriptBlock: z.object({ id: z.string(), key: z.string(), sectionKey: z.string() }),
  /** The chunk and take heard, and the take's audio file (absent in assemblies made before it was recorded). */
  audioChunk: z.object({ id: z.string(), index: z.number().int(), generationId: z.string(), generation: z.number().int(), audioAssetId: z.string().optional() }),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  text: z.string(),
  words: z.array(z.object({ word: z.string(), startMs: z.number().int(), endMs: z.number().int() })),
  performance: z.object({ pace: z.enum(DELIVERY_PACES), energy: z.enum(DELIVERY_ENERGIES), emotion: z.enum(DELIVERY_EMOTIONS) }),
  visualHints: z.object({ intent: z.enum(VISUAL_INTENTS), priority: z.enum(VISUAL_PRIORITIES), mustShow: z.array(z.string()), fictional: z.boolean() }),
});
export type NarrationTimelineEntry = z.infer<typeof NarrationTimelineEntry>;

// ── Pronunciation review ─────────────────────────────────────────────────────

export const PronunciationEntry = z.object({
  term: z.string().min(1),
  kind: z.enum(PRONUNCIATION_TERM_KINDS),
  method: z.enum(PRONUNCIATION_METHODS),
  /** IPA or CMU phonemes, or the alias spoken instead; null for the voice's own reading. */
  pronunciation: z.string().nullable(),
  status: z.enum(PRONUNCIATION_STATUSES),
});
export type PronunciationEntry = z.infer<typeof PronunciationEntry>;

// ── Requests ─────────────────────────────────────────────────────────────────

/** What a run narrates. */
export const VoiceScope = z.discriminatedUnion('kind', [
  /** The opening: whole blocks from the start until about `seconds` of planned narration. */
  z.object({ kind: z.literal('AUDITION'), seconds: z.number().int().min(20).max(300).default(100) }),
  z.object({ kind: z.literal('SECTION'), section: z.number().int().min(1) }),
  z.object({ kind: z.literal('BLOCKS'), blockKeys: z.array(z.string().trim().min(1)).min(1).max(200) }),
  z.object({ kind: z.literal('RANGE'), from: z.string().trim().min(1), to: z.string().trim().min(1) }),
  z.object({ kind: z.literal('FULL') }),
]);
export type VoiceScope = z.infer<typeof VoiceScope>;

/**
 * Settings a run sets over its profile version (for a comparison, an
 * audition or a director's choice): the RUN layer of VoiceConfigOverrides.
 */
export const VoiceRunOptions = VoiceConfigOverrides;
export type VoiceRunOptions = VoiceConfigOverrides;

/** The project's selection revision a plan was made at: generating is refused when its profile or overrides changed since. */
const SelectionRevision = z.number().int().min(0);

/** Plan a run (nothing is generated): its chunks, characters and estimated cost. */
export const PlanVoiceRunInput = z.object({
  scope: VoiceScope,
  /** A profile version to narrate with (default: the project's production profile). */
  profileId: z.uuid().optional(),
  options: VoiceRunOptions.optional(),
  selectionRevision: SelectionRevision.optional(),
});
export type PlanVoiceRunInput = z.input<typeof PlanVoiceRunInput>;

/** Generate a run. Above the confirmation threshold (or for the whole script) `confirm` must be true. */
export const CreateVoiceRunInput = PlanVoiceRunInput.extend({
  notes: z.string().trim().max(2000).optional(),
  confirm: z.boolean().optional(),
});
export type CreateVoiceRunInput = z.input<typeof CreateVoiceRunInput>;

const VariantLabel = z.string().trim().min(1).max(40);

/** Unlabelled variants are named by their place (A, B, C…); labels must differ. */
const lettered = <T extends { label?: string | undefined }>(variants: T[]) => variants.map((v, i) => ({ ...v, label: v.label ?? String.fromCharCode(65 + i) }));
const distinctLabels = (variants: readonly { label: string }[]) => new Set(variants.map((v) => v.label.toLowerCase())).size === variants.length;

/**
 * One way of narrating an experiment's scope: the profile's settings, with
 * whatever the variant sets over them. Strict like the run's options: a key
 * it does not know is refused, never dropped (a comparison is paid for). A
 * preset's `question` is taken and left out (shown, never sent).
 */
export const VoiceExperimentVariant = VoiceRunOptions.extend({
  label: VariantLabel.optional(),
  /** Another saved profile version to narrate this variant with (heard as saved: the project's overrides apply to its production profile only). */
  profileId: z.uuid().optional(),
  question: z.string().max(500).optional(),
}).transform(({ question: _question, ...variant }) => variant);
export type VoiceExperimentVariant = z.input<typeof VoiceExperimentVariant>;

/**
 * A comparison: the same scope narrated 2–8 ways, generated in one job. Each
 * variant is its own run with its own assembly (so each can be heard whole).
 * Always confirmed: the service says what it would send and cost.
 */
export const VoiceExperimentInput = z.object({
  scope: VoiceScope,
  profileId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  variants: z
    .array(VoiceExperimentVariant)
    .min(2)
    .max(8)
    .transform(lettered)
    .refine(distinctLabels, { message: 'each variant needs its own label' }),
  confirm: z.boolean().optional(),
  selectionRevision: SelectionRevision.optional(),
});
export type VoiceExperimentInput = z.input<typeof VoiceExperimentInput>;

/** A variant spelled out in full (strategy, chunking and context), so the comparison does not depend on the profile. */
export interface VoiceExperimentPresetVariant extends Required<Pick<VoiceRunOptions, 'strategy' | 'chunking' | 'context'>> {
  label: string;
  /** What the variant is there to hear (shown, never sent). */
  question: string;
}

/** An experiment ready to queue: a name, a scope and fully specified variants. */
export interface VoiceExperimentPreset {
  name: string;
  scope: VoiceScope;
  variants: VoiceExperimentPresetVariant[];
}

const { chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT } = DEFAULT_VOICE_PROFILE_CONFIG;
const NO_CONTEXT: ContextSettings = { previousChars: 0, nextChars: 0, stitch: false };

/**
 * The acceptance experiment, queued as one job on the opening: direction
 * (A–D), neighbouring context (E against B) and chunk size (F and G against
 * B). B is the house default the others are heard against.
 */
export const VOICE_ACCEPTANCE_EXPERIMENT: VoiceExperimentPreset = {
  name: 'Acceptance experiment',
  scope: { kind: 'AUDITION', seconds: 100 },
  variants: [
    { label: 'A plain', strategy: 'PLAIN', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT, question: 'What does the voice do with no direction?' },
    { label: 'B restrained', strategy: 'RESTRAINED', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT, question: 'Does the house style sound like a documentary narrator?' },
    { label: 'C expressive', strategy: 'EXPRESSIVE', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT, question: 'Do the deliberate moments land, or over-act?' },
    { label: 'D over-directed', strategy: 'DIRECTED', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT, question: 'What does over-direction sound like (the reference to avoid)?' },
    { label: 'E no context', strategy: 'RESTRAINED', chunking: HOUSE_CHUNKING, context: NO_CONTEXT, question: 'Does neighbouring text help continuity (B without it)?' },
    { label: 'F 5–8 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 13, maxWords: 20 }, context: HOUSE_CONTEXT, question: 'Are smaller chunks more natural, or choppy (B smaller)?' },
    { label: 'G 12–20 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 30, maxWords: 50 }, context: HOUSE_CONTEXT, question: 'Do larger chunks stay natural, or flatten (B larger)?' },
  ],
};

/**
 * One side of an A/B take of chosen chunks: its strategy and, for a single
 * chunk, a director's directions. Anything else is refused, not dropped (the
 * request's `override` applies to every variant).
 */
export const RegenerateVariant = z
  .object({
    label: VariantLabel.optional(),
    strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
    marks: z.array(DirectorMark).max(12).optional(),
  })
  .strict();
export type RegenerateVariant = z.input<typeof RegenerateVariant>;

/** New takes for some chunks of a run (earlier takes are kept). */
export const RegenerateVoiceInput = z
  .object({
    chunkIds: z.array(z.uuid()).max(500).optional(),
    section: z.number().int().min(1).optional(),
    blockKeys: z.array(z.string().trim().min(1)).max(200).optional(),
    all: z.boolean().optional(),
    /**
     * What the takes are made with: RUN (default) the run's own
     * configuration; PRODUCTION the project's production profile now (the
     * chunk is still the run's). Recorded on each take.
     */
    configuration: z.enum(['RUN', 'PRODUCTION']).optional(),
    /** A temporary override for these takes only, over the configuration (never saved to a profile). */
    override: VoiceTakeOverride.optional(),
    /** With PRODUCTION: the project's selection revision the request was made at (refused when it changed since). */
    selectionRevision: SelectionRevision.optional(),
    /** Shorthand for `override.strategy`. */
    strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
    /** A director's directions — only with exactly one chunk. */
    marks: z.array(DirectorMark).max(12).optional(),
    /**
     * A/B: one take per variant per chosen chunk, kept beside the current take
     * and never made current by itself (the editor picks one). Only with
     * chunkIds; always confirmed.
     */
    variants: z.array(RegenerateVariant).min(2).max(3).transform(lettered).refine(distinctLabels, { message: 'each variant needs its own label' }).optional(),
    note: z.string().trim().max(1000).optional(),
    confirm: z.boolean().optional(),
  })
  .refine((v) => [v.chunkIds?.length ? 1 : 0, v.section ? 1 : 0, v.blockKeys?.length ? 1 : 0, v.all ? 1 : 0].reduce((a, b) => a + b, 0) === 1, {
    message: 'choose exactly one of chunkIds, section, blockKeys or all',
  })
  .refine((v) => !v.marks || v.chunkIds?.length === 1, { message: 'directions apply to exactly one chunk', path: ['marks'] })
  .refine((v) => !v.variants || !!v.chunkIds?.length, { message: 'variants apply to chosen chunks', path: ['variants'] })
  .refine((v) => !v.variants || (!v.strategy && !v.marks), { message: 'with variants, each variant sets its own strategy and directions', path: ['variants'] })
  .refine((v) => !v.variants?.some((x) => x.marks?.length) || v.chunkIds?.length === 1, { message: 'directions apply to exactly one chunk', path: ['variants'] })
  .refine((v) => !(v.strategy && v.override?.strategy), { message: 'give the strategy once: as strategy or as override.strategy', path: ['strategy'] })
  .refine((v) => !v.variants || !v.override?.strategy, { message: 'with variants, each variant sets its own strategy', path: ['override', 'strategy'] });
export type RegenerateVoiceInput = z.input<typeof RegenerateVoiceInput>;

/** The editor's decision on one take: approve it, reject it (no regeneration is forced), or make it current again. */
export const DecideVoiceGenerationInput = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'RESTORE']),
  note: z.string().trim().max(1000).optional(),
});
export type DecideVoiceGenerationInput = z.infer<typeof DecideVoiceGenerationInput>;

export const UpdatePronunciationInput = z
  .object({
    method: z.enum(PRONUNCIATION_METHODS),
    pronunciation: z.string().trim().max(200).nullable().optional(),
    status: z.enum(PRONUNCIATION_STATUSES),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => v.method === 'DEFAULT' || !!v.pronunciation, { message: 'an alias or phonemes are needed unless the voice reads it as it is', path: ['pronunciation'] });
export type UpdatePronunciationInput = z.infer<typeof UpdatePronunciationInput>;

// ── Saved profiles and a project's choice ────────────────────────────────────

/** A saved profile's name: unique among profiles, ignoring case. */
const ProfileName = z.string().trim().min(1).max(80);
const ProfileDescription = z.string().trim().max(1000);
const ProfileNotes = z.string().trim().max(1000);

/**
 * What a version sets; a new version copies whatever is not given from the
 * version it is based on (performance rules and provider settings key by
 * key). Strict: a key it does not take is refused, never dropped (an edit
 * that names the language is refused, not saved without it).
 */
export const VoiceProfileFieldsInput = z
  .object({
    voiceId: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(100),
    language: z.string().trim().min(2).max(10),
    outputFormat: z.string().trim().min(1).max(40),
    strategy: z.enum(PERFORMANCE_STRATEGIES),
    chunking: ChunkingSettings,
    context: ContextSettings,
    numberStyle: NumberStyle,
    pronunciation: PronunciationConfig,
    performanceRules: PerformanceRules.partial(),
    providerSettings: ProviderSettingValues,
  })
  .partial()
  .strict();
export type VoiceProfileFieldsInput = z.infer<typeof VoiceProfileFieldsInput>;

/** A new saved profile (its v1): the configured provider's defaults and the house default, with `fields` over them. */
export const CreateVoiceProfileFamilyInput = z.object({
  name: ProfileName,
  description: ProfileDescription.optional(),
  fields: VoiceProfileFieldsInput.optional(),
  notes: ProfileNotes.optional(),
});
export type CreateVoiceProfileFamilyInput = z.infer<typeof CreateVoiceProfileFamilyInput>;

/** An edit: a new version of a saved profile (versions are never changed: runs and takes keep the version they used). */
export const NewVoiceProfileVersionInput = z.object({
  /** The version it is based on (default: the current one). */
  basedOn: z.uuid().optional(),
  /** Refused when the family's current version is no longer this one (an edit made in another tab). */
  expectedCurrent: z.uuid().optional(),
  /** The language is the family's (a voice for another language is a duplicate). */
  fields: VoiceProfileFieldsInput.omit({ language: true }),
  notes: ProfileNotes.optional(),
});
export type NewVoiceProfileVersionInput = z.infer<typeof NewVoiceProfileVersionInput>;

/** A new saved profile from any version of another (another language allowed). */
export const DuplicateVoiceProfileInput = z.object({
  /** The version copied (default: the family's current one). */
  fromVersionId: z.uuid().optional(),
  name: ProfileName,
  description: ProfileDescription.optional(),
  fields: VoiceProfileFieldsInput.optional(),
});
export type DuplicateVoiceProfileInput = z.infer<typeof DuplicateVoiceProfileInput>;

/** Rename, describe, archive or unarchive a saved profile, or make it the library default (its versions are not touched). */
export const UpdateVoiceProfileFamilyInput = z
  .object({
    name: ProfileName.optional(),
    description: ProfileDescription.nullable().optional(),
    archived: z.boolean().optional(),
    /** The library default for its provider and language (another default for them loses the flag). */
    isDefault: z.literal(true).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to change' });
export type UpdateVoiceProfileFamilyInput = z.infer<typeof UpdateVoiceProfileFamilyInput>;

/** Save a run's (or one of its takes') configuration as a profile: a new one by name, or a new version of one. */
export const SaveRunAsProfileInput = z
  .object({
    name: ProfileName.optional(),
    familyId: z.uuid().optional(),
    /** A take of the run whose configuration is saved instead (a temporary override that was liked). */
    generationId: z.uuid().optional(),
    description: ProfileDescription.optional(),
    notes: ProfileNotes.optional(),
    /**
     * Also use it for the run's project (its language version), following its
     * current version. The project's overrides are cleared: they are in the
     * saved configuration where they applied to the run.
     */
    use: z.boolean().optional(),
  })
  .refine((v) => !!v.name !== !!v.familyId, { message: 'give a name for a new profile, or the profile to add a version to' });
export type SaveRunAsProfileInput = z.infer<typeof SaveRunAsProfileInput>;

/** A project's choice of profile for one language version, and its overrides (never stored on the profile). */
export const VoiceSelectionInput = z
  .object({
    /** The language version (default: the master language). */
    language: z.string().trim().min(2).max(10).optional(),
    /** Null: the library default. */
    familyId: z.uuid().nullable(),
    /** Pinned to this version of the family (null or absent: follow its current version). */
    versionId: z.uuid().nullable().optional(),
    overrides: VoiceConfigOverrides.default({}),
    /** The revision the editor saw (0: none yet); another revision is refused (changed in another tab). */
    revision: SelectionRevision,
  })
  .refine((v) => !v.versionId || !!v.familyId, { message: 'a pinned version needs its profile', path: ['versionId'] });
export type VoiceSelectionInput = z.input<typeof VoiceSelectionInput>;

