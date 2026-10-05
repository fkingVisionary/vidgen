import { z } from 'zod';
import {
  DELIVERY_EMOTIONS,
  DELIVERY_ENERGIES,
  DELIVERY_PACES,
  PAUSE_LENGTHS,
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

/** Voice settings fixed for every take of a profile (provider-neutral names; a provider maps them to its own). */
export const VoiceProfileSettings = z.object({
  /** Higher = more consistent, lower = more expressive. */
  stability: z.number().min(0).max(1),
  /** How closely to keep to the original voice. */
  similarity: z.number().min(0).max(1),
  /** Style exaggeration (0 = none). */
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean(),
  /** Base speaking rate (1 = the voice's natural pace). */
  speed: z.number().min(0.7).max(1.2),
});
export type VoiceProfileSettings = z.infer<typeof VoiceProfileSettings>;

/** Chunk size: the smallest useful regeneration unit that still sounds like one piece of speech. */
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

/** Everything about how a profile narrates beyond the voice and model: reproducible as a whole. */
export const VoiceProfileConfig = z.object({
  settings: VoiceProfileSettings,
  /** Default performance strategy (a run may override it, e.g. for a comparison). */
  strategy: z.enum(PERFORMANCE_STRATEGIES),
  chunking: ChunkingSettings,
  context: ContextSettings,
  /** How spoken forms read amounts: "one hundred and twenty" (UK) or "one hundred twenty" (US). */
  numberStyle: z.enum(['UK', 'US']),
});
export type VoiceProfileConfig = z.infer<typeof VoiceProfileConfig>;

export const DEFAULT_VOICE_PROFILE_CONFIG: VoiceProfileConfig = {
  settings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 },
  strategy: 'RESTRAINED',
  chunking: { minWords: 25, maxWords: 80 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  numberStyle: 'UK',
};

// ── Performance (provider-neutral) ───────────────────────────────────────────

/** Short, plain words a provider can turn into its own direction ("reflective", "intimate", "exhales"). */
const Descriptor = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .regex(/^[a-z][a-z \-']*[a-z]$/, 'lower-case words only (no digits, quotes or brackets)');

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
  /** SCRIPT: translated from the script's delivery marks; STRATEGY: added by an over-directed strategy; DIRECTOR: the editor's own. */
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
  inside: z.array(z.object({ afterSentence: z.number().int().min(0), length: z.enum(PAUSE_LENGTHS) })),
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
  /** Settings sent with the take (the profile's, with the chunk's pace applied). */
  settings: VoiceProfileSettings,
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
  'TAKE_REJECTED',
  'TAKE_UNREVIEWED',
  'STALE_TEXT',
  'STALE_SCRIPT',
  'DUPLICATE_CHUNK',
  'MISSING_CHUNK',
  'INCOMPLETE_NARRATION',
  'DURATION_ANOMALY',
  'EXCESSIVE_SILENCE',
  'PRONUNCIATION_UNRESOLVED',
  'SPOKEN_FORM_CHECK',
  'PERFORMANCE_CHECK',
  'MOCK_AUDIO',
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
  audioChunk: z.object({ id: z.string(), index: z.number().int(), generationId: z.string(), generation: z.number().int() }),
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

/** Options a run may set over its profile's (for a comparison, or a director's choice). */
export const VoiceRunOptions = z.object({
  strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
  chunking: ChunkingSettings.optional(),
  context: ContextSettings.optional(),
});
export type VoiceRunOptions = z.infer<typeof VoiceRunOptions>;

/** Plan a run (nothing is generated): its chunks, characters and estimated cost. */
export const PlanVoiceRunInput = z.object({
  scope: VoiceScope,
  profileId: z.uuid().optional(),
  options: VoiceRunOptions.optional(),
});
export type PlanVoiceRunInput = z.input<typeof PlanVoiceRunInput>;

/** Generate a run. Above the confirmation threshold (or for the whole script) `confirm` must be true. */
export const CreateVoiceRunInput = PlanVoiceRunInput.extend({
  notes: z.string().trim().max(2000).optional(),
  confirm: z.boolean().optional(),
});
export type CreateVoiceRunInput = z.input<typeof CreateVoiceRunInput>;

/** A comparison: the same scope narrated 2–4 ways (each variant is its own run in one experiment). */
export const VoiceExperimentInput = z.object({
  scope: VoiceScope,
  profileId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  variants: z.array(VoiceRunOptions.extend({ label: z.string().trim().min(1).max(40) })).min(2).max(4),
  confirm: z.boolean().optional(),
});
export type VoiceExperimentInput = z.input<typeof VoiceExperimentInput>;

/** New takes for some chunks of a run (earlier takes are kept). */
export const RegenerateVoiceInput = z
  .object({
    chunkIds: z.array(z.uuid()).max(500).optional(),
    section: z.number().int().min(1).optional(),
    blockKeys: z.array(z.string().trim().min(1)).max(200).optional(),
    all: z.boolean().optional(),
    strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
    /** A director's directions — only with exactly one chunk. */
    marks: z.array(DirectorMark).max(12).optional(),
    note: z.string().trim().max(1000).optional(),
    confirm: z.boolean().optional(),
  })
  .refine((v) => [v.chunkIds?.length ? 1 : 0, v.section ? 1 : 0, v.blockKeys?.length ? 1 : 0, v.all ? 1 : 0].reduce((a, b) => a + b, 0) === 1, {
    message: 'choose exactly one of chunkIds, section, blockKeys or all',
  })
  .refine((v) => !v.marks || v.chunkIds?.length === 1, { message: 'directions apply to exactly one chunk', path: ['marks'] });
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

/** A new version of a profile (profiles are never edited in place: takes keep the version they used). */
export const CreateVoiceProfileInput = z.object({
  basedOn: z.uuid().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  voiceId: z.string().trim().min(1).max(100).optional(),
  modelId: z.string().trim().min(1).max(100).optional(),
  outputFormat: z.string().trim().min(1).max(40).optional(),
  settings: VoiceProfileSettings.partial().optional(),
  strategy: z.enum(PERFORMANCE_STRATEGIES).optional(),
  chunking: ChunkingSettings.optional(),
  context: ContextSettings.optional(),
  numberStyle: z.enum(['UK', 'US']).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateVoiceProfileInput = z.infer<typeof CreateVoiceProfileInput>;

