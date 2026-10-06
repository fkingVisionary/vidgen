import { describe, expect, it } from 'vitest';
import { CHUNK_BOUNDARIES, PERFORMANCE_STRATEGIES, VOICE_GENERATION_STATUSES } from '../enums.ts';
import { CHUNK_BOUNDARY_LABELS, PERFORMANCE_STRATEGY_HELP, PERFORMANCE_STRATEGY_LABELS, VOICE_GENERATION_STATUS_LABELS } from '../labels.ts';
import { wordsForSeconds } from '../script.ts';
import {
  AssemblyEntry,
  CHUNK_SECONDS,
  ChunkPauses,
  ChunkPerformance,
  DEFAULT_VOICE_PROFILE_CONFIG,
  NarrationTimelineEntry,
  PreparedNarration,
  RegenerateVoiceInput,
  VOICE_ACCEPTANCE_EXPERIMENT,
  VoiceExperimentInput,
  VoiceProfileConfig,
  VoiceQaFinding,
  VoiceRunOptions,
} from './voice.ts';

const CHUNK = '0190f3a0-0000-7000-8000-000000000001';
const OTHER = '0190f3a0-0000-7000-8000-000000000002';
const AUDITION = { kind: 'AUDITION', seconds: 100 } as const;

describe('chunk size', () => {
  it('defaults to about 8–12 s of speech at the narration rate', () => {
    expect(DEFAULT_VOICE_PROFILE_CONFIG.chunking).toEqual({ minWords: wordsForSeconds(CHUNK_SECONDS.target.min), maxWords: wordsForSeconds(CHUNK_SECONDS.target.max) });
    expect(DEFAULT_VOICE_PROFILE_CONFIG.chunking).toEqual({ minWords: 20, maxWords: 30 });
    expect(VoiceProfileConfig.parse(DEFAULT_VOICE_PROFILE_CONFIG)).toEqual(DEFAULT_VOICE_PROFILE_CONFIG);
  });

  it('keeps reading profiles stored with the earlier default', () => {
    const stored = { ...DEFAULT_VOICE_PROFILE_CONFIG, chunking: { minWords: 25, maxWords: 80 } };
    expect(VoiceProfileConfig.parse(JSON.parse(JSON.stringify(stored))).chunking).toEqual({ minWords: 25, maxWords: 80 });
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

  it('reads a prepared take of the earlier shape', () => {
    const prepared = {
      strategy: 'RESTRAINED',
      spokenForms: [{ kind: 'YEAR', start: 3, end: 7, display: '1637', spoken: 'sixteen thirty-seven', confidence: 'HIGH' }],
      marks: [{ sentence: 0, intent: { emotion: 'curious', delivery: null, intensity: 'LOW', pacing: 'NORMAL', vocalAction: null }, source: 'SCRIPT', reason: 'block SC01-B01' }],
      pauses: { before: 'NONE', after: 'SHORT', inside: [{ afterSentence: 0, length: 'MEDIUM' }] },
      context: { previousText: null, nextText: 'It was a promise.' },
      settings: DEFAULT_VOICE_PROFILE_CONFIG.settings,
      seed: 7,
      dictionary: [],
      unsupported: [],
      checks: [{ id: 'words', label: 'Words unchanged', status: 'PASS', detail: '' }],
    };
    expect(PreparedNarration.parse(prepared)).toEqual(prepared);
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
});
