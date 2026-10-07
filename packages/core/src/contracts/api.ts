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
  VISUAL_APPROACHES,
  VISUAL_INTENTS,
  VISUAL_PRIORITIES,
} from '../enums.ts';
import { ScriptDelivery, ScriptVisual } from './script.ts';
import { BeatKey, StoryboardEditOp, STORYBOARD_LIMITS } from './storyboard.ts';
import { VisualConfigOverrides } from './visual-profile.ts';
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
  /** The artifact version the reviewer looked at (a storyboard version at the STORYBOARD gate): refused when another is under review. */
  artifactId: z.uuid().optional(),
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
      /** The Human Narration Pass alone on the whole script (Writing Engine 2): targeted edits, every block's evidence kept. */
      narration: z.boolean().default(false),
    })
    .refine((r) => !(r.narration && (r.refine || r.sections.length)), { message: 'A narration pass works on the whole script and is not a refinement' })
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

/**
 * The Human Narration Pass on a whole script version (Writing Engine 2): the
 * house-style corpus and the diagnostics guide targeted edits — artificial
 * patterns out, rhythm, missing context from the evidence, picture
 * description moved to the visual layer — then the script editor, the fact
 * checker and the performance pass, as for any version. The base is kept.
 * `instructions` (optional) steer the style for this film, never the evidence.
 */
export const NarrateScriptInput = z.object({
  baseVersion: z.number().int().min(1),
  instructions: z.string().trim().max(5000).optional(),
  allowPerformanceOverMax: z.boolean().optional(),
});
export type NarrateScriptInput = z.input<typeof NarrateScriptInput>;

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

// ---------------------------------------------------------------------------
// Storyboard Engine
// ---------------------------------------------------------------------------

/** Planning calls the model (paid, within the job's ceiling): the request must say so. */
const Confirm = z.literal(true, { error: 'Planning a storyboard calls the model and is paid for: confirm it' });

/** The newest version of the storyboard the request was made against (another is refused: changed elsewhere). */
const ExpectedVersion = z.number().int().min(1);

/**
 * Plan a storyboard from a voice run's narration. A preview (side job) or the
 * phase job is chosen by the narration and the project's status. Default
 * assembly: the run's latest (a preview) or the one the VOICE gate approved.
 */
export const GenerateStoryboardInput = z.object({
  narration: z.object({ runId: z.uuid(), assemblyId: z.uuid().optional() }),
  /** Default: the visual profile's approach. */
  approach: z.enum(VISUAL_APPROACHES).optional(),
  /** The project's visual selection revision the request was made at (0: none chosen yet). */
  selectionRevision: z.number().int().min(0),
  confirm: Confirm,
});
export type GenerateStoryboardInput = z.infer<typeof GenerateStoryboardInput>;

/** Re-plan chosen beats of a version (their ranges stay; the rest is copied). */
export const RegenerateBeatsInput = z.object({
  beatKeys: z.array(BeatKey).min(1).max(STORYBOARD_LIMITS.beatsPerSection),
  instructions: z.string().trim().max(STORYBOARD_LIMITS.instructions).optional(),
  expectedVersion: ExpectedVersion,
  confirm: Confirm,
});
export type RegenerateBeatsInput = z.infer<typeof RegenerateBeatsInput>;

/** Plan another approach: only the beats whose treatment changes are re-planned. */
export const SwitchApproachInput = z.object({ approach: z.enum(VISUAL_APPROACHES), expectedVersion: ExpectedVersion, confirm: Confirm });
export type SwitchApproachInput = z.infer<typeof SwitchApproachInput>;

/** A person's edits of a version, in order: a new version, no model call. */
export const StoryboardEditInput = z.object({
  expectedVersion: ExpectedVersion,
  ops: z.array(StoryboardEditOp).min(1).max(50),
  note: z.string().trim().max(1000).optional(),
});
export type StoryboardEditInput = z.infer<typeof StoryboardEditInput>;

/** The same plan on another assembly of the same script: times recomputed from the word anchors (no model call). */
export const RetimeStoryboardInput = z.object({ assemblyId: z.uuid(), expectedVersion: ExpectedVersion });
export type RetimeStoryboardInput = z.infer<typeof RetimeStoryboardInput>;

/** A copy of an older version as the newest (the history is kept). */
export const RestoreStoryboardInput = z.object({ expectedVersion: ExpectedVersion });
export type RestoreStoryboardInput = z.infer<typeof RestoreStoryboardInput>;

/** A person's decision on a whole version. A whole-script version under review goes through the STORYBOARD gate. */
export const StoryboardDecisionInput = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  note: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersion,
});
export type StoryboardDecisionInput = z.infer<typeof StoryboardDecisionInput>;

/** A person's decision on one shot (CLEARED withdraws it). Never changes the version's content. */
export const ShotDecisionInput = z.object({ decision: z.enum(['APPROVED', 'REJECTED', 'CLEARED']), note: z.string().trim().max(1000).optional() });
export type ShotDecisionInput = z.infer<typeof ShotDecisionInput>;

// ── Visual profiles ──────────────────────────────────────────────────────────

/** A visual profile's name: unique among profiles, ignoring case. */
const VisualProfileName = z.string().trim().min(1).max(80);
const VisualProfileDescription = z.string().trim().max(1000);
const VisualProfileNotes = z.string().trim().max(1000);

/** A new visual profile (its v1): DEFAULT_VISUAL_PROFILE_CONFIG with `config` over it. */
export const CreateVisualProfileFamilyInput = z.object({
  name: VisualProfileName,
  description: VisualProfileDescription.optional(),
  config: VisualConfigOverrides.optional(),
  notes: VisualProfileNotes.optional(),
});
export type CreateVisualProfileFamilyInput = z.infer<typeof CreateVisualProfileFamilyInput>;

/** An edit: a new version of a visual profile (versions are never changed; storyboards keep the version they used). */
export const NewVisualProfileVersionInput = z.object({
  /** The version it is based on (default: the current one). */
  basedOn: z.uuid().optional(),
  /** Refused when the family's current version is no longer this one (an edit made in another tab). */
  expectedCurrent: z.uuid().optional(),
  config: VisualConfigOverrides,
  notes: VisualProfileNotes.optional(),
});
export type NewVisualProfileVersionInput = z.infer<typeof NewVisualProfileVersionInput>;

/** A new visual profile from any version of another. */
export const DuplicateVisualProfileInput = z.object({
  fromVersionId: z.uuid().optional(),
  name: VisualProfileName,
  description: VisualProfileDescription.optional(),
  config: VisualConfigOverrides.optional(),
});
export type DuplicateVisualProfileInput = z.infer<typeof DuplicateVisualProfileInput>;

/** Rename, describe, archive or unarchive a visual profile, or make it the library default (its versions are not touched). */
export const UpdateVisualProfileFamilyInput = z
  .object({
    name: VisualProfileName.optional(),
    description: VisualProfileDescription.nullable().optional(),
    archived: z.boolean().optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to change' });
export type UpdateVisualProfileFamilyInput = z.infer<typeof UpdateVisualProfileFamilyInput>;

/** A project's choice of visual profile, and its overrides (never stored on the profile). Visuals are language-neutral: one choice per project. */
export const VisualSelectionInput = z
  .object({
    /** Null: the library default. */
    familyId: z.uuid().nullable(),
    /** Pinned to this version of the family (null or absent: follow its current version). */
    versionId: z.uuid().nullable().optional(),
    overrides: VisualConfigOverrides.default({}),
    /** The revision the editor saw (0: none yet); another revision is refused (changed in another tab). */
    revision: z.number().int().min(0),
  })
  .refine((v) => !v.versionId || !!v.familyId, { message: 'a pinned version needs its profile', path: ['versionId'] });
export type VisualSelectionInput = z.input<typeof VisualSelectionInput>;
