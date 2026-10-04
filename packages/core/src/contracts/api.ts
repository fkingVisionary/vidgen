import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_GATES,
  CANDIDATE_PRIORITIES,
  CANDIDATE_STATUSES,
  JOB_TYPES,
  PROJECT_STATUSES,
} from '../enums.ts';
import { DEFAULT_MASTER_LANGUAGE, LANGUAGE_CODES } from '../languages.ts';

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
export const UpdateStoryCandidateInput = z
  .object({
    status: z.enum(CANDIDATE_STATUSES).optional(),
    selected: z.boolean().optional(),
    priority: z.enum(CANDIDATE_PRIORITIES).optional(),
    editorNotes: z.string().trim().max(5000).nullable().optional(),
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
});
export type StoryJobInput = z.infer<typeof StoryJobInput>;
