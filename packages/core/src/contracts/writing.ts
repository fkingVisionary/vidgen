import { z } from 'zod';
import {
  AI_PATTERNS,
  BLOCK_CHANGE_STATUSES,
  CLAIM_VERDICTS,
  CONFIDENCE_LEVELS,
  MONEY_COMPARISON_TYPES,
  NAME_KINDS,
  PRESENTATIONS,
  PRONUNCIATION_CONFIDENCES,
  RUBRIC_DIMENSIONS,
  SCRIPT_REVIEWERS,
  WRITING_CATEGORIES,
  WRITING_QUALITIES,
  WRITING_SOURCE_TYPES,
} from '../enums.ts';

/**
 * Documentary Writing Engine 2 — the shapes shared by the writing module,
 * the script stage, the API and the dashboard: the house-style corpus, the
 * diagnostics (AI-pattern signals, spoken rhythm, the read-aloud rubric),
 * historical money context, name layers, the record of a narration pass and
 * the change report between two script versions.
 */

// ── The corpus ───────────────────────────────────────────────────────────────

/**
 * One example of narration the house has judged: a model to follow
 * (excellent, good), to avoid (bad) or to think about (borderline). Retrieval
 * gives a writer a handful at a time, by need — never the whole corpus.
 * Copyright: original house writing, the editor's own, public domain or
 * licensed text only; never a transcript of a commercial documentary.
 */
export const WritingCorpusExample = z
  .object({
    /** Stable id ("hook-ledger-opening"); with `version` it says exactly which wording a prompt was given. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case words joined by hyphens'),
    version: z.number().int().min(1),
    text: z.string().min(1),
    category: z.enum(WRITING_CATEGORIES),
    quality: z.enum(WRITING_QUALITIES),
    /** Free vocabulary ("restraint", "number_in_context", "visual_separation") plus the AI-pattern ids an example shows. */
    traits: z.array(z.string().min(1)),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    /** How it moves when spoken ("short, then a long line that resolves it"). */
    spokenRhythm: z.string(),
    /** What it does in the film ("turns a price into stakes"). */
    narrativeFunction: z.string(),
    whyItWorks: z.string().optional(),
    whyItFails: z.string().optional(),
    /** For a bad or borderline example: the house's own better version. */
    rewrite: z.string().optional(),
    source: z.object({ type: z.enum(WRITING_SOURCE_TYPES), reference: z.string().optional() }),
    copyrightSafe: z.boolean(),
    approvedForRetrieval: z.boolean(),
  })
  .superRefine((x, ctx) => {
    if (x.approvedForRetrieval && !x.copyrightSafe) ctx.addIssue({ code: 'custom', message: 'only copyright-safe examples can be retrieved', path: ['approvedForRetrieval'] });
    if ((x.quality === 'excellent' || x.quality === 'good') && !x.whyItWorks?.trim()) ctx.addIssue({ code: 'custom', message: 'a model to follow says why it works', path: ['whyItWorks'] });
    if (x.quality === 'bad' && !x.whyItFails?.trim()) ctx.addIssue({ code: 'custom', message: 'a model to avoid says why it fails', path: ['whyItFails'] });
    if (x.quality === 'borderline' && !(x.whyItWorks?.trim() && x.whyItFails?.trim())) ctx.addIssue({ code: 'custom', message: 'a borderline example says what works and what fails', path: ['whyItFails'] });
  });
export type WritingCorpusExample = z.infer<typeof WritingCorpusExample>;

/** The corpus as a whole: its version and its examples (the files, plus the house examples a person approved). */
export const CorpusManifest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  updated: z.string(),
  changes: z.array(z.object({ version: z.string(), note: z.string() })),
});
export type CorpusManifest = z.infer<typeof CorpusManifest>;

/** Which examples a model call was given, and for which blocks. */
export const RetrievedExample = z.object({ id: z.string(), version: z.number().int(), category: z.enum(WRITING_CATEGORIES), quality: z.enum(WRITING_QUALITIES), refs: z.array(z.string()), reason: z.string() });
export type RetrievedExample = z.infer<typeof RetrievedExample>;

// ── Diagnostics ──────────────────────────────────────────────────────────────

/** One place where the narration shows a machine-writing pattern. */
export const AiSignal = z.object({
  pattern: z.enum(AI_PATTERNS),
  /** Block key ("3.4") or section ("S3"). */
  ref: z.string(),
  excerpt: z.string(),
  /** HARD: wrong wherever it appears; DENSITY: fine once, a problem when it piles up. */
  kind: z.enum(['HARD', 'DENSITY']),
});
export type AiSignal = z.infer<typeof AiSignal>;

export const FingerprintSummary = z.object({
  /** 0 (reads as a person wrote it) to 100 (every sentence a pattern). A heuristic indicator, not a detector. */
  score: z.number().min(0).max(100),
  words: z.number().int(),
  signals: z.number().int(),
  perPattern: z.partialRecord(z.enum(AI_PATTERNS), z.number().int()),
  /** Patterns over their density threshold (the ones that warn). */
  overThreshold: z.array(z.enum(AI_PATTERNS)),
});
export type FingerprintSummary = z.infer<typeof FingerprintSummary>;

/** How the narration moves when spoken: signals for the editor, not targets. */
export const RhythmProfile = z.object({
  sentences: z.number().int(),
  meanWords: z.number(),
  sdWords: z.number(),
  /** Spread of sentence lengths (sd / mean): under about 0.3 sounds monotonous. */
  variation: z.number(),
  fragmentShare: z.number(),
  longShare: z.number(),
  longestFragmentRun: z.number().int(),
  clausesPerSentence: z.number(),
  punctuationPerSentence: z.number(),
  /** Consecutive sentences opening with the same word. */
  repeatedOpenings: z.number().int(),
  /** Runs of four or more sentences within two words of each other's length. */
  sameLengthRuns: z.number().int(),
  /** Share of blocks that end the way the block before them ended. */
  endingRepetition: z.number(),
  tongueTwisters: z.array(z.object({ ref: z.string(), excerpt: z.string() })),
});
export type RhythmProfile = z.infer<typeof RhythmProfile>;

export const RubricScore = z.object({ dimension: z.enum(RUBRIC_DIMENSIONS), score: z.number().min(0).max(10), reasons: z.array(z.string()) });
export type RubricScore = z.infer<typeof RubricScore>;

export const Diagnostics = z.object({ fingerprint: FingerprintSummary, rhythm: RhythmProfile, rubric: z.array(RubricScore) });
export type Diagnostics = z.infer<typeof Diagnostics>;

// ── Historical money context ─────────────────────────────────────────────────

/**
 * What a sum of money meant at the time, from the evidence only: a price and
 * a comparison the cited claims give (a contemporary wage first; a modern
 * estimate last, and only as an approximation). Never invented — when the
 * evidence has no comparison, there is no context.
 */
export const HistoricalMoneyContext = z.object({
  /** "M1" — cited by a narration change that uses it. */
  id: z.string(),
  amount: z.number(),
  /** As the evidence writes it ("1,200"). */
  amountText: z.string(),
  currency: z.string(),
  date: z.string().nullable(),
  /** What the money bought or was ("one bulb", "the whole sale"). */
  item: z.string().nullable(),
  comparisonType: z.enum(MONEY_COMPARISON_TYPES),
  /** The comparison as the evidence gives it ("about 300 a year for a skilled craftsman"). */
  comparisonValue: z.string(),
  /** The amount over the comparison (4 = four years' wages), when both are figures in the same currency and unit. */
  ratio: z.number().nullable(),
  /** The context as a narrator could say it ("about four years' pay for a skilled craftsman"). */
  explanation: z.string(),
  /** The claims it rests on (dossier claim keys): a block using it must cite every one. */
  sourceClaimKeys: z.array(z.string()).min(1),
  /** The weakest of its claims' verdicts, and the wording that verdict requires. */
  verdict: z.enum(CLAIM_VERDICTS),
  presentation: z.enum(PRESENTATIONS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  /** How it was worked out, in a sentence an editor can check. */
  methodology: z.string(),
  /** A ratio rounded for speech, or a modern estimate: say "about", never an exact figure. */
  approximate: z.boolean(),
});
export type HistoricalMoneyContext = z.infer<typeof HistoricalMoneyContext>;

/** A sum the narration says without context, and why there is none to give. */
export const MoneyGap = z.object({ ref: z.string(), amountText: z.string(), currency: z.string(), note: z.string() });
export type MoneyGap = z.infer<typeof MoneyGap>;

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * A name in four layers: the historical name (as the evidence spells it —
 * never westernised), the display name (what the narration, subtitles and
 * on-screen text write: the same, unless an editor decides), the spoken form
 * (how the voice says it — from the pronunciation notes, never invented here)
 * and its pronunciation note. The approved voice lexicon stays the authority.
 */
export const NameEntry = z.object({
  id: z.string(),
  kind: z.enum(NAME_KINDS),
  /** Cast id, when the architecture's cast has them. */
  castId: z.string().nullable(),
  fictional: z.boolean(),
  historicalName: z.string(),
  displayName: z.string(),
  /** The respelling a narrator follows ("TICE"), when a pronunciation note has one. */
  spokenForm: z.string().nullable(),
  pronunciation: z
    .object({ respelling: z.string(), ipa: z.string().nullable(), language: z.string().nullable(), confidence: z.enum(PRONUNCIATION_CONFIDENCES), needsReview: z.boolean(), source: z.enum(['MODEL', 'EDITOR']) })
    .nullable(),
  /** Blocks naming it, and the first. */
  mentions: z.number().int(),
  firstRef: z.string().nullable(),
  claimKeys: z.array(z.string()),
  /** A narrator might say it wrong and no confirmed note says how: flagged for the pronunciation list (no phonemes are guessed here). */
  candidate: z.boolean(),
  candidateReasons: z.array(z.string()),
});
export type NameEntry = z.infer<typeof NameEntry>;

// ── A narration pass, as recorded on the version it made ─────────────────────

export const NarrationRecord = z.object({
  engine: z.literal('writing-engine-2'),
  styleBibleVersion: z.string(),
  corpusVersion: z.string(),
  rubricVersion: z.string(),
  /** The pass did not run (the model refused or failed for good): the version is otherwise complete. */
  unavailable: z.string().nullable(),
  verdict: z.string().nullable(),
  retrieved: z.array(RetrievedExample),
  counts: z.object({ flagged: z.number().int(), settled: z.number().int(), proposed: z.number().int(), kept: z.number().int(), rejected: z.number().int(), skipped: z.number().int() }),
  diagnostics: z.object({ before: Diagnostics.nullable(), after: Diagnostics }),
  money: z.object({ contexts: z.array(HistoricalMoneyContext), used: z.array(z.object({ contextId: z.string(), ref: z.string() })), gaps: z.array(MoneyGap) }),
  names: z.array(NameEntry),
  /** Picture description the pass moved out of the narration, into the block's visual note. */
  visualMoved: z.array(z.object({ ref: z.string(), note: z.string() })),
  /** Each block of the base version and where it is in this one (null: removed) — exact for a narration pass, which never renumbers. */
  lineage: z.array(z.object({ base: z.string(), saved: z.string().nullable() })).nullable(),
});
export type NarrationRecord = z.infer<typeof NarrationRecord>;

// ── The change report between two versions ───────────────────────────────────

export const BlockChange = z.object({
  section: z.number().int(),
  baseRef: z.string().nullable(),
  ref: z.string().nullable(),
  status: z.enum(BLOCK_CHANGE_STATUSES),
  original: z.string().nullable(),
  revised: z.string().nullable(),
  /** Why, in the reviewers' words (the change ledger). */
  reasons: z.array(z.string()),
  changedBy: z.array(z.enum(SCRIPT_REVIEWERS)),
  /** The claims behind the block, its class and its beats are the same (null for a block added or removed). */
  evidencePreserved: z.boolean().nullable(),
  /** Every hedge the block needed is still there. */
  uncertaintyPreserved: z.boolean().nullable(),
  claimsRemoved: z.array(z.string()),
  claimsAdded: z.array(z.string()),
  /** Money context the change added (context ids). */
  moneyContext: z.array(z.string()),
  aiPatternsRemoved: z.array(z.enum(AI_PATTERNS)),
  aiPatternsAdded: z.array(z.enum(AI_PATTERNS)),
  visualDuplicationRemoved: z.boolean(),
  /** Names in the revised block still waiting for a confirmed pronunciation. */
  pronunciationCandidates: z.array(z.string()),
});
export type BlockChange = z.infer<typeof BlockChange>;

export const ScriptChangeReport = z.object({
  base: z.object({ id: z.string(), version: z.number().int() }),
  revised: z.object({ id: z.string(), version: z.number().int() }),
  /** EXACT: from the run's own lineage; MATCHED: blocks paired by their evidence and wording. */
  pairing: z.enum(['EXACT', 'MATCHED']),
  totals: z.object({
    blocksBefore: z.number().int(),
    blocksAfter: z.number().int(),
    unchanged: z.number().int(),
    rewritten: z.number().int(),
    removed: z.number().int(),
    added: z.number().int(),
    sentencesRemoved: z.number().int(),
    sentencesRewritten: z.number().int(),
    moneyContextAdded: z.number().int(),
    pronunciationCandidates: z.number().int(),
    visualDescriptionsRemoved: z.number().int(),
    aiSignalsBefore: z.number().int(),
    aiSignalsAfter: z.number().int(),
    evidencePreserved: z.object({ kept: z.number().int(), of: z.number().int() }),
    uncertaintyPreserved: z.object({ kept: z.number().int(), of: z.number().int() }),
  }),
  fingerprint: z.object({ before: z.number(), after: z.number() }),
  /** Claim coverage between the versions: any claim or figure lost or gained is flagged, never silent. */
  provenance: z.object({ claimsAdded: z.array(z.string()), claimsRemoved: z.array(z.string()), figuresAdded: z.array(z.string()), figuresRemoved: z.array(z.string()), flags: z.array(z.string()) }),
  blocks: z.array(BlockChange),
});
export type ScriptChangeReport = z.infer<typeof ScriptChangeReport>;

// ── House-style examples in the database ─────────────────────────────────────

/** Decide on a house-style candidate: approve (with its annotation), reject or retire. */
export const WritingExampleDecisionInput = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'RETIRE']),
  category: z.enum(WRITING_CATEGORIES).optional(),
  quality: z.enum(WRITING_QUALITIES).optional(),
  whyItWorks: z.string().trim().max(1000).optional(),
  whyItFails: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type WritingExampleDecisionInput = z.infer<typeof WritingExampleDecisionInput>;
