import { z } from 'zod';
import {
  CLAIM_VERDICTS,
  DELIVERY_EMOTIONS,
  DELIVERY_ENERGIES,
  DELIVERY_PACES,
  EMPHASIS_LEVELS,
  PAUSE_LENGTHS,
  PAUSE_REASONS,
  PRESENTATIONS,
  PRONUNCIATION_CONFIDENCES,
  SCRIPT_BLOCK_CLASSES,
  SCRIPT_ORIGINS,
  SCRIPT_SCORES,
  SPEECH_KINDS,
  VISUAL_INTENTS,
  VISUAL_PRIORITIES,
} from '../enums.ts';

/**
 * Script Engine 1.0 — the structured, provider-neutral script. A script
 * version (scripts row) has one section per architecture sequence (scenes),
 * the spoken words of each section per language (scene_narrations), and the
 * narration blocks of those words (script_blocks), each traced to the
 * architecture beats it realises and the approved claims it rests on. The
 * shapes below are what code validates when reading or writing them.
 */

const ClaimKeys = z.array(z.string());

/** A pause before or after a block, and why it is there. */
export const ScriptPause = z.object({ length: z.enum(PAUSE_LENGTHS), reason: z.enum(PAUSE_REASONS).nullable() });
export type ScriptPause = z.infer<typeof ScriptPause>;
export const NO_PAUSE: ScriptPause = { length: 'NONE', reason: null };

/** Stress on a word or phrase: `text` is an exact part of the block's text. */
export const ScriptEmphasis = z.object({ text: z.string().min(1), level: z.enum(EMPHASIS_LEVELS) });
export type ScriptEmphasis = z.infer<typeof ScriptEmphasis>;

/** How a block is performed. Provider-neutral: a voice adapter translates it. */
export const ScriptDelivery = z.object({
  pace: z.enum(DELIVERY_PACES),
  energy: z.enum(DELIVERY_ENERGIES),
  emotion: z.enum(DELIVERY_EMOTIONS),
  emphasis: z.array(ScriptEmphasis),
  pauseBefore: ScriptPause,
  pauseAfter: ScriptPause,
});
export type ScriptDelivery = z.infer<typeof ScriptDelivery>;
export const DEFAULT_DELIVERY: ScriptDelivery = { pace: 'NORMAL', energy: 'MEDIUM', emotion: 'NEUTRAL', emphasis: [], pauseBefore: NO_PAUSE, pauseAfter: NO_PAUSE };

/** The handoff to the future storyboard: what the viewer should see while hearing the block. */
export const ScriptVisual = z.object({
  intent: z.enum(VISUAL_INTENTS),
  /** Historical details that must appear, with the claims that ground them. */
  mustShow: z.array(z.object({ detail: z.string(), claimKeys: ClaimKeys })),
  mustAvoid: z.array(z.string()),
  priority: z.enum(VISUAL_PRIORITIES),
  /** A fictional device is in the block: never show it as a historical record. */
  fictional: z.boolean(),
  note: z.string(),
});
export type ScriptVisual = z.infer<typeof ScriptVisual>;

/** How a block must present a claim that is not ESTABLISHED (the architecture's instruction for it). */
export const BlockPresentation = z.object({
  claimKey: z.string(),
  verdict: z.enum(CLAIM_VERDICTS),
  presentation: z.enum(PRESENTATIONS),
  instruction: z.string(),
});
export type BlockPresentation = z.infer<typeof BlockPresentation>;

/** One unit of narration: a few spoken sentences with one information class, its evidence, delivery and visual intent. */
export const ScriptBlockContent = z.object({
  /** "<sequence>.<n>", stable within a version. */
  key: z.string(),
  text: z.string(),
  infoClass: z.enum(SCRIPT_BLOCK_CLASSES),
  /** Architecture beats the block realises ("3.2"). */
  beatIds: z.array(z.string()),
  claimKeys: ClaimKeys,
  /** Cast id of the speaker; null = the narrator. */
  speakerId: z.string().nullable(),
  /** RECORDED_QUOTE or INVENTED when a cast member speaks; null for narration. */
  speechKind: z.enum(SPEECH_KINDS).nullable(),
  /** A fictional device (the viewer's POV, a composite, an invented line) is in the block. */
  fictionalDevice: z.boolean(),
  delivery: ScriptDelivery,
  visual: ScriptVisual,
  presentation: z.array(BlockPresentation),
  wordCount: z.number().int().min(0),
  estimatedDurationSec: z.number().min(0),
});
export type ScriptBlockContent = z.infer<typeof ScriptBlockContent>;

/** The planner's intent for one section (scenes.content). */
export const ScriptSectionPlan = z.object({
  purpose: z.string(),
  /** How the section is told: where narration leads and where it steps back. */
  approach: z.string(),
  /** What the pictures can carry instead of words. */
  showNotSay: z.array(z.string()),
  /** The exposition the viewer cannot do without. */
  exposition: z.array(z.string()),
  tension: z.string(),
  reveal: z.string(),
  /** Narration should be sparse here. */
  sparse: z.boolean(),
  targetSec: z.number().min(0),
});
export type ScriptSectionPlan = z.infer<typeof ScriptSectionPlan>;

/** A pronunciation note for a name or term. Anything not HIGH confidence (or not confirmed by the editor) needs review. */
export const Pronunciation = z.object({
  term: z.string().min(1),
  /** A plain-English respelling ("YOHST van KOYK"). */
  respelling: z.string(),
  ipa: z.string().nullable(),
  /** Language the term comes from ("Dutch"), if known. */
  language: z.string().nullable(),
  confidence: z.enum(PRONUNCIATION_CONFIDENCES),
  note: z.string(),
  needsReview: z.boolean(),
  source: z.enum(['MODEL', 'EDITOR']),
});
export type Pronunciation = z.infer<typeof Pronunciation>;

export const ScriptScoreEntry = z.object({ score: z.number().min(0).max(10), why: z.string() });
export type ScriptScoreEntry = z.infer<typeof ScriptScoreEntry>;

/** A problem a reviewer (script editor or fact checker) found, and what became of it. */
export const ScriptIssue = z.object({
  /** Block key ("3.4"), "S3" for a section, or null for the script as a whole. */
  ref: z.string().nullable(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  kind: z.string(),
  note: z.string(),
  /** Fixed by the reviewer's own edit (kept), or left for the editor. */
  resolution: z.string(),
});
export type ScriptIssue = z.infer<typeof ScriptIssue>;

/** What a version changed and why, in the writer's words. */
export const ScriptChangeLog = z.object({
  summary: z.string(),
  changes: z.array(z.object({ section: z.number().int().nullable(), what: z.string(), why: z.string() })),
});
export type ScriptChangeLog = z.infer<typeof ScriptChangeLog>;

/** How a script version came about. */
export const ScriptProvenance = z.object({
  origin: z.enum(SCRIPT_ORIGINS),
  /** The version it was made from (kept unchanged). */
  baseVersion: z.number().int().nullable(),
  baseId: z.string().nullable(),
  /** Sections written in this version; the others were copied from the base unchanged. */
  sections: z.array(z.number().int()),
  /** The editor's brief for this version. */
  brief: z.string().nullable(),
  requestedBy: z.string().nullable(),
  changeLog: ScriptChangeLog.nullable(),
});
export type ScriptProvenance = z.infer<typeof ScriptProvenance>;

/** Script.content: everything about a version that is not a section or a block. */
export const ScriptContent = z.object({
  engineVersion: z.literal(1),
  /** The approved architecture the script tells. */
  architecture: z.object({ id: z.string(), version: z.number().int() }),
  narrator: z.object({ persona: z.string(), tone: z.string(), approach: z.string() }),
  /** The architecture's central question, and the blocks that pose and answer it. */
  centralQuestion: z.object({ text: z.string(), posedIn: z.string().nullable(), answeredIn: z.string().nullable() }),
  pronunciations: z.array(Pronunciation),
  performanceNotes: z.array(z.string()),
  /** The script editor's verdict (craft), recorded; it never fails the gate. */
  editor: z.object({ verdict: z.string(), scores: z.partialRecord(z.enum(SCRIPT_SCORES), ScriptScoreEntry), issues: z.array(ScriptIssue) }).nullable(),
  /** The fact checker's issues (evidence). */
  factCheck: z.object({ verdict: z.string(), issues: z.array(ScriptIssue) }).nullable(),
  provenance: ScriptProvenance,
});
export type ScriptContent = z.infer<typeof ScriptContent>;

// ---------------------------------------------------------------------------
// Voice rendering (provider-neutral plan; no audio is generated here)
// ---------------------------------------------------------------------------

/** One request a voice adapter would send: a run of blocks of one section with one pace. */
export const VoiceSegment = z.object({
  sectionKey: z.string(),
  blockKeys: z.array(z.string()),
  /** The text as the provider receives it (with the provider's pause markup). */
  text: z.string(),
  /** Provider speed multiplier for this segment. */
  speed: z.number(),
  characters: z.number().int(),
  previousText: z.string().nullable(),
  nextText: z.string().nullable(),
});
export type VoiceSegment = z.infer<typeof VoiceSegment>;

export const VoiceRenderPlan = z.object({
  /** Adapter that produced the plan ("elevenlabs"). */
  provider: z.string(),
  segments: z.array(VoiceSegment),
  /** Pronunciation rules the provider would apply (confirmed notes only). */
  dictionary: z.array(z.object({ term: z.string(), alias: z.string().nullable(), ipa: z.string().nullable() })),
  /** Metadata the adapter cannot express for this provider (kept for later adapters). */
  unsupported: z.array(z.string()),
  /** Pronunciations still to be confirmed by the editor (not sent). */
  pendingPronunciations: z.array(z.string()),
  characters: z.number().int(),
  notes: z.array(z.string()),
});
export type VoiceRenderPlan = z.infer<typeof VoiceRenderPlan>;
