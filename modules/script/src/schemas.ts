import {
  DELIVERY_EMOTIONS,
  DELIVERY_ENERGIES,
  DELIVERY_PACES,
  EMPHASIS_LEVELS,
  PAUSE_LENGTHS,
  PAUSE_REASONS,
  PRONUNCIATION_CONFIDENCES,
  SCRIPT_BLOCK_CLASSES,
  SPEECH_KINDS,
  VISUAL_INTENTS,
  VISUAL_PRIORITIES,
} from '@docengine/core';
import { z } from 'zod';

/**
 * What each model call returns. Validated on arrival; everything derived
 * (durations, presentation, fiction markers, timing, findings) is computed
 * by code afterwards, never taken from the model.
 *
 * Blocks are referenced as "<sequence>.<n>" (1-based within the section, in
 * the order the reviewer was shown).
 */

export const WriterBlock = z.object({
  text: z.string(),
  infoClass: z.enum(SCRIPT_BLOCK_CLASSES),
  beatIds: z.array(z.string()),
  claimKeys: z.array(z.string()),
  /** Cast id when a cast member speaks; null for the narrator. */
  speakerId: z.string().nullable(),
  speechKind: z.enum(SPEECH_KINDS).nullable(),
  visual: z.object({
    intent: z.enum(VISUAL_INTENTS),
    mustShow: z.array(z.object({ detail: z.string(), claimKeys: z.array(z.string()) })),
    mustAvoid: z.array(z.string()),
    priority: z.enum(VISUAL_PRIORITIES),
    note: z.string(),
  }),
});
export type WriterBlock = z.infer<typeof WriterBlock>;

const ChangeLog = z.object({
  summary: z.string(),
  changes: z.array(z.object({ section: z.number().int().nullable(), what: z.string(), why: z.string() })),
});

/** Stage B — the narration, section by section. Also used to rewrite chosen sections. */
export const WriterOutput = z.object({
  sections: z.array(z.object({ sequence: z.number().int(), blocks: z.array(WriterBlock) })),
  /** The blocks that pose and answer the central question ("1.2", "9.4"). */
  centralQuestion: z.object({ posedIn: z.string().nullable(), answeredIn: z.string().nullable() }),
  /** For a rewrite: what changed and why. For a draft: the approach in a sentence or two. */
  changeLog: ChangeLog,
});
export type WriterOutput = z.infer<typeof WriterOutput>;

/** A narrative refinement: the whole script rewritten for the ear, and the strongest lines it kept word for word. */
export const RefineOutput = WriterOutput.extend({ keptLines: z.array(z.string()) });
export type RefineOutput = z.infer<typeof RefineOutput>;

/** Stage A — the plan: what is said, what is shown, where tension, reveals and exposition go. */
export const PlannerOutput = z.object({
  narrator: z.object({ persona: z.string(), tone: z.string(), approach: z.string() }),
  sections: z.array(
    z.object({
      sequence: z.number().int(),
      purpose: z.string(),
      approach: z.string(),
      showNotSay: z.array(z.string()),
      exposition: z.array(z.string()),
      tension: z.string(),
      reveal: z.string(),
      sparse: z.boolean(),
      targetSec: z.number(),
    }),
  ),
  centralQuestion: z.object({ poseInSection: z.number().int(), answerInSection: z.number().int() }),
  notes: z.array(z.string()),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

/** A reviewer's targeted changes: replace, remove or insert blocks (never the whole script again). */
const Patch = {
  edits: z.array(
    z.object({
      ref: z.string(),
      text: z.string(),
      infoClass: z.enum(SCRIPT_BLOCK_CLASSES).nullable(),
      claimKeys: z.array(z.string()).nullable(),
      beatIds: z.array(z.string()).nullable(),
    }),
  ),
  removals: z.array(z.string()),
  /** `after` is a block ref, or "<sequence>.0" for the start of a section. */
  insertions: z.array(z.object({ after: z.string(), block: WriterBlock })),
};

const Severity = z.enum(['CRITICAL', 'MAJOR', 'MINOR']);
const Score = z.object({ score: z.number().min(0).max(10), why: z.string() });

export const EDITOR_ISSUE_KINDS = [
  'BORING_EXPOSITION',
  'REPETITION',
  'WEAK_OPENING',
  'SLOW_SECTION',
  'UNNECESSARY_FACT',
  'MISSING_STAKES',
  'UNNATURAL_SPEECH',
  'POOR_TRANSITION',
  'WEAK_ESCALATION',
  'RHETORICAL_QUESTIONS',
  'AI_LANGUAGE',
  'UNSUPPORTED_CLAIM',
  'FICTION_AS_FACT',
  'OTHER',
] as const;

/** Stage C — the script editor: craft. `assessment` answers the refinement checklist (empty when there is none). */
export const ScriptEditorOutput = z.object({
  verdict: z.string(),
  scores: z.object({ NARRATIVE_SCORE: Score, AUDIO_FLOW_SCORE: Score, CLARITY_SCORE: Score, EMOTIONAL_SCORE: Score, ENDING_SCORE: Score }),
  issues: z.array(z.object({ ref: z.string().nullable(), severity: Severity, kind: z.enum(EDITOR_ISSUE_KINDS), note: z.string() })),
  assessment: z.array(z.object({ question: z.string(), answer: z.enum(['YES', 'PARTLY', 'NO']), comparedToPrevious: z.enum(['BETTER', 'SAME', 'WORSE']), note: z.string() })),
  ...Patch,
});
export type ScriptEditorOutput = z.infer<typeof ScriptEditorOutput>;

export const FACT_ISSUE_KINDS = [
  'UNSUPPORTED_STATEMENT',
  'WRONG_NUMBER',
  'WRONG_DATE',
  'WRONG_NAME',
  'MISQUOTE',
  'MISSING_UNCERTAINTY',
  'FICTION_AS_FACT',
  'REAL_PERSON_INVENTED',
  'OTHER',
] as const;

/** Stage D — the fact checker: evidence, with the last word on facts. */
export const FactCheckOutput = z.object({
  verdict: z.string(),
  issues: z.array(z.object({ ref: z.string().nullable(), severity: Severity, kind: z.enum(FACT_ISSUE_KINDS), note: z.string() })),
  ...Patch,
});
export type FactCheckOutput = z.infer<typeof FactCheckOutput>;

export type ScriptPatch = Pick<ScriptEditorOutput, 'edits' | 'removals' | 'insertions'>;

const PauseOut = z.object({ length: z.enum(PAUSE_LENGTHS), reason: z.enum(PAUSE_REASONS).nullable() });

/** Stage E — performance: only blocks whose delivery differs from the default are listed. */
export const PerformanceOutput = z.object({
  blocks: z.array(
    z.object({
      ref: z.string(),
      pace: z.enum(DELIVERY_PACES),
      energy: z.enum(DELIVERY_ENERGIES),
      emotion: z.enum(DELIVERY_EMOTIONS),
      emphasis: z.array(z.object({ text: z.string(), level: z.enum(EMPHASIS_LEVELS) })),
      pauseBefore: PauseOut,
      pauseAfter: PauseOut,
    }),
  ),
  pronunciations: z.array(
    z.object({
      term: z.string(),
      respelling: z.string(),
      ipa: z.string().nullable(),
      language: z.string().nullable(),
      confidence: z.enum(PRONUNCIATION_CONFIDENCES),
      note: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});
export type PerformanceOutput = z.infer<typeof PerformanceOutput>;
