import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_GATES,
  CANDIDATE_PRIORITIES,
  CANDIDATE_STATUSES,
  JOB_TYPES,
  NARRATIVE_MODES,
  OPPORTUNITY_STATUSES,
  POV_STRATEGIES,
  PROJECT_STATUSES,
  REVISION_ASPECTS,
  SCRIPT_BLOCK_CLASSES,
  SECTION_REVIEW_STATUSES,
  VISUAL_INTENTS,
  VISUAL_PRIORITIES,
} from '../enums.ts';
import { ScriptDelivery, ScriptVisual } from './script.ts';
import { DEFAULT_MASTER_LANGUAGE, LANGUAGE_CODES } from '../languages.ts';
import { STORY_LIMITS } from '../story.ts';

/** Request bodies accepted by the HTTP API. Validated server-side; reused by the dashboard for typing. */

export const CreateProjectInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    workingTitle: z.string().trim().max(200).optional(),
    topic: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).optional(),
    category: z.string().trim().max(100).optional(),
    style: z.string().trim().max(200).optional(),
    targetMinutesMin: z.number().int().min(1).max(180).default(10),
    targetMinutesMax: z.number().int().min(1).max(180).default(15),
    masterLanguage: z.enum(LANGUAGE_CODES).default(DEFAULT_MASTER_LANGUAGE),
  })
  .refine((v) => v.targetMinutesMin <= v.targetMinutesMax, {
    message: 'targetMinutesMin must be ≤ targetMinutesMax',
    path: ['targetMinutesMin'],
  });
/** What callers send (defaults optional). The service parses it into the full shape. */
export type CreateProjectInput = z.input<typeof CreateProjectInput>;

export const EnqueueJobInput = z.object({
  type: z.enum(JOB_TYPES),
  /** Defaults to the project's master language version. */
  languageVersionId: z.uuid().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
export type EnqueueJobInput = z.infer<typeof EnqueueJobInput>;

export const ApprovalInput = z.object({
  gate: z.enum(APPROVAL_GATES),
  decision: z.enum(APPROVAL_DECISIONS),
  notes: z.string().trim().max(5000).optional(),
});
export type ApprovalInput = z.infer<typeof ApprovalInput>;

export const RewindInput = z.object({
  to: z.enum(PROJECT_STATUSES),
  reason: z.string().trim().min(1).max(2000),
});
export type RewindInput = z.infer<typeof RewindInput>;

/** The editor's changes to one story candidate. */
const PovChoiceInput = z.object({ type: z.enum(POV_STRATEGIES), description: z.string().trim().max(1000) });

export const UpdateStoryCandidateInput = z
  .object({
    status: z.enum(CANDIDATE_STATUSES).optional(),
    selected: z.boolean().optional(),
    priority: z.enum(CANDIDATE_PRIORITIES).optional(),
    editorNotes: z.string().trim().max(5000).nullable().optional(),
    // Story Engine 2.0 editorial overrides; null restores the AI's value.
    title: z.string().trim().min(1).max(200).nullable().optional(),
    narrativeMode: z.enum(NARRATIVE_MODES).nullable().optional(),
    centralQuestion: z.string().trim().min(1).max(500).nullable().optional(),
    povStrategy: PovChoiceInput.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })
  .refine((v) => !(v.status === 'REJECTED' && v.selected === true), {
    message: 'A rejected candidate cannot be selected',
    path: ['selected'],
  });
export type UpdateStoryCandidateInput = z.infer<typeof UpdateStoryCandidateInput>;

/** The editor's preferences for the documentary (the architect follows them or explains why not). */
const StoryPreferences = z.object({
  narrativeMode: z.enum(NARRATIVE_MODES).optional(),
  povStrategy: PovChoiceInput.optional(),
  centralQuestion: z.string().trim().min(1).max(500).optional(),
});

/** An explored angle: exploration version and angle key ("A2"). */
export const AngleRef = z.object({ exploration: z.number().int().min(1), key: z.string().regex(/^A[1-9]$/) });
export type AngleRef = z.infer<typeof AngleRef>;

/** Input of a STORY_MINING or STORY_ARCHITECTURE job: the editor's instructions for the pass. */
export const StoryJobInput = z.object({
  notes: z.string().trim().max(5000).optional(),
  /** STORY_ARCHITECTURE only. */
  preferences: StoryPreferences.optional(),
  /** STORY_ARCHITECTURE: revise this version instead of building a new one; `notes` is the editor's brief. */
  revise: z
    .object({
      baseVersion: z.number().int().min(1),
      aspects: z.array(z.enum(REVISION_ASPECTS)).max(REVISION_ASPECTS.length).default([]),
    })
    .optional(),
  /** STORY_ARCHITECTURE: build on (or revise toward) this explored angle. */
  angle: AngleRef.optional(),
});
export type StoryJobInput = z.infer<typeof StoryJobInput>;

/**
 * Reconsider an architecture: the architect revises version `baseVersion`
 * from the editor's brief, using only the story pack and the approved
 * dossier. A new version is created; every earlier version is kept.
 */
export const ReviseArchitectureInput = z.object({
  baseVersion: z.number().int().min(1),
  brief: z.string().trim().min(10, 'Say what is not working (at least a sentence)').max(5000),
  aspects: z.array(z.enum(REVISION_ASPECTS)).max(REVISION_ASPECTS.length).default([]),
  preferences: StoryPreferences.optional(),
  angle: AngleRef.optional(),
});
export type ReviseArchitectureInput = z.infer<typeof ReviseArchitectureInput>;

/** Input of a STORY_ANGLES job: explore 2–3 materially different approaches to the curated story pack. */
export const ExploreAnglesInput = z.object({
  notes: z.string().trim().max(5000).optional(),
  count: z.union([z.literal(2), z.literal(3)]).default(3),
  /** Explore alternatives to this architecture version (each angle must differ from it too). */
  basedOnVersion: z.number().int().min(1).optional(),
});
export type ExploreAnglesInput = z.infer<typeof ExploreAnglesInput>;

/** The editor's order of the selected story units (exactly the current selection). */
export const ReorderSelectionInput = z.object({
  candidateIds: z.array(z.string().uuid()).min(1).max(STORY_LIMITS.selection.max),
});
export type ReorderSelectionInput = z.infer<typeof ReorderSelectionInput>;

/** The editor's decision on a content opportunity. */
export const UpdateContentOpportunityInput = z
  .object({
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    editorNotes: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.editorNotes !== undefined, { message: 'Nothing to update' });
export type UpdateContentOpportunityInput = z.infer<typeof UpdateContentOpportunityInput>;

/**
 * A request for a content package, e.g. { documentary: true, shorts: 6, languages: ["en","es"] }.
 * Today it only resolves which approved outputs the package would contain; nothing is generated.
 */
export const ContentPackageRequest = z.object({
  documentary: z.boolean().default(true),
  shorts: z.union([z.number().int().min(0).max(50), z.literal('all')]).default('all'),
  languages: z
    .array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'a language code such as "en" or "pt-BR"'))
    .max(20)
    .default([]),
});
export type ContentPackageRequest = z.infer<typeof ContentPackageRequest>;

// ---------------------------------------------------------------------------
// Script Engine
// ---------------------------------------------------------------------------

/**
 * Input of a SCRIPT job. Without `revise`: a draft of the approved
 * architecture. With `revise`: a new version made from `baseVersion` — the
 * listed sections rewritten (the rest copied unchanged), or the whole script
 * when no section is listed; `notes` is the editor's brief.
 */
export const ScriptJobInput = z.object({
  notes: z.string().trim().max(5000).optional(),
  /** The user lets the performance pass (pauses, slower delivery) take the script past the runtime maximum. Off by default. */
  allowPerformanceOverMax: z.boolean().default(false),
  revise: z
    .object({
      baseVersion: z.number().int().min(1),
      sections: z.array(z.number().int().min(1)).max(60).default([]),
      /** A narrative refinement of the whole script: the telling rewritten, the story and evidence unchanged. */
      refine: z.boolean().default(false),
    })
    .optional(),
});
export type ScriptJobInput = z.infer<typeof ScriptJobInput>;

/** Generate the first draft (or a fresh draft) from the approved architecture. */
export const GenerateScriptInput = z.object({ notes: z.string().trim().max(5000).optional(), allowPerformanceOverMax: z.boolean().optional() });
export type GenerateScriptInput = z.infer<typeof GenerateScriptInput>;

/**
 * Rewrite part or all of a script version from the editor's brief: the
 * listed sections (by sequence number), or the whole script when none is
 * listed. A new version is created; every earlier version is kept.
 */
export const ReviseScriptInput = z.object({
  baseVersion: z.number().int().min(1),
  sections: z.array(z.number().int().min(1)).max(60).default([]),
  brief: z.string().trim().min(10, 'Say what to change (at least a sentence)').max(5000),
  allowPerformanceOverMax: z.boolean().optional(),
});
// The request shape (`sections` may be left out); the service parses it.
export type ReviseScriptInput = z.input<typeof ReviseScriptInput>;

/**
 * Refine the narration of a whole script version for the ear: the story,
 * structure, information classes and evidence stay; the writing changes. The
 * house style is built in. `instructions` (Director Mode, optional) steer
 * style, emphasis, pacing and creative direction for this film; they never
 * override the evidence rules, the architecture, information classes,
 * quotations or the boundaries of fictional characters.
 */
export const RefineScriptInput = z.object({
  baseVersion: z.number().int().min(1),
  instructions: z.string().trim().max(5000).optional(),
  allowPerformanceOverMax: z.boolean().optional(),
});
export type RefineScriptInput = z.input<typeof RefineScriptInput>;

/** The editor's change to one narration block (the version under review only). */
export const UpdateScriptBlockInput = z
  .object({
    text: z.string().trim().min(1).max(4000).optional(),
    infoClass: z.enum(SCRIPT_BLOCK_CLASSES).optional(),
    delivery: ScriptDelivery.partial().optional(),
    visual: ScriptVisual.pick({ mustAvoid: true, note: true })
      .extend({ intent: z.enum(VISUAL_INTENTS), priority: z.enum(VISUAL_PRIORITIES) })
      .partial()
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to change' });
export type UpdateScriptBlockInput = z.infer<typeof UpdateScriptBlockInput>;

/** The editor's order of the blocks of one section (exactly that section's blocks). */
export const ReorderScriptBlocksInput = z.object({ blockIds: z.array(z.string().uuid()).min(1).max(200) });
export type ReorderScriptBlocksInput = z.infer<typeof ReorderScriptBlocksInput>;

/** The editor's decision and notes on one section. */
export const ReviewScriptSectionInput = z
  .object({
    reviewStatus: z.enum(SECTION_REVIEW_STATUSES).optional(),
    editorNotes: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((v) => v.reviewStatus !== undefined || v.editorNotes !== undefined, { message: 'Nothing to change' });
export type ReviewScriptSectionInput = z.infer<typeof ReviewScriptSectionInput>;

/** Make an earlier version current again, as a new version (no model calls). */
export const RestoreScriptInput = z.object({ version: z.number().int().min(1) });
export type RestoreScriptInput = z.infer<typeof RestoreScriptInput>;
