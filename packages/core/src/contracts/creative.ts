import { z } from 'zod';
import { QA_CATEGORIES } from '../enums.ts';

/**
 * Shapes of the JSON documents stored on creative artifacts. The database
 * stores them as JSONB (their structure will evolve quickly); these schemas
 * are what code must validate against when reading or writing them.
 */

/**
 * LanguageVersion.voiceConfig — provider-neutral narration settings. Voice IDs
 * are data chosen per project/language, never hard-coded.
 */
export const VoiceSettings = z.object({
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  model: z.string().min(1),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speed: z.number().min(0.5).max(2),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

/** Shot.direction — cinematography fields of a storyboard shot that are not queried directly. */
export const ShotDirection = z.object({
  lens: z.string().optional(),
  composition: z.string().optional(),
  environment: z.string().optional(),
  period: z.string().optional(),
  characters: z.array(z.string()).default([]),
  props: z.array(z.string()).default([]),
  lighting: z.string().optional(),
  colour: z.string().optional(),
  action: z.string().optional(),
  continuityNotes: z.string().optional(),
});
export type ShotDirection = z.infer<typeof ShotDirection>;

const Score = z.number().min(0).max(100);

const QaFinding = z.object({
  category: z.enum(QA_CATEGORIES),
  message: z.string().min(1),
  /** Optional pointer, e.g. a scene key or asset id. */
  ref: z.string().optional(),
});

/** QaReport.findings — automated QA output. Human approval is still required. */
export const QaFindings = z.object({
  overallScore: Score,
  categoryScores: z.partialRecord(z.enum(QA_CATEGORIES), Score),
  warnings: z.array(QaFinding),
  blockingErrors: z.array(QaFinding),
});
export type QaFindings = z.infer<typeof QaFindings>;
