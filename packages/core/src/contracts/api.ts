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
} from '../enums.ts';
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

/** Input of a STORY_MINING or STORY_ARCHITECTURE job: the editor's instructions for the pass. */
export const StoryJobInput = z.object({
  notes: z.string().trim().max(5000).optional(),
  /** STORY_ARCHITECTURE only: the editor's preferences for the documentary (the architect follows them or explains why not). */
  preferences: z
    .object({
      narrativeMode: z.enum(NARRATIVE_MODES).optional(),
      povStrategy: PovChoiceInput.optional(),
      centralQuestion: z.string().trim().min(1).max(500).optional(),
    })
    .optional(),
});
export type StoryJobInput = z.infer<typeof StoryJobInput>;

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
