import { z } from 'zod';
import { CONFIDENCE_LEVELS } from '../enums.ts';

/**
 * ResearchDossier.content — everything in a dossier besides the claims,
 * sources and citations (which are relational). Written so a later Story
 * stage can build the documentary without rediscovering the history.
 *
 * Sections reference claims by `claimKeys` ("C014"), never by free text, so
 * every narrative fact traces back to a claim with a verdict and citations.
 */

const ClaimKeys = z.array(z.string());

export const ResearchQuestion = z.object({
  id: z.string(),
  category: z.string(),
  question: z.string(),
  rationale: z.string().nullable(),
  queries: z.array(z.string()),
  /** Short answer from the synthesis, with its confidence. */
  answerSummary: z.string().nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
});
export type ResearchQuestion = z.infer<typeof ResearchQuestion>;

export const ResearchDossierContent = z.object({
  questions: z.array(ResearchQuestion),
  timeline: z.array(z.object({ date: z.string(), event: z.string(), approximate: z.boolean(), claimKeys: ClaimKeys })),
  keyFigures: z.array(z.object({ name: z.string(), role: z.string(), description: z.string(), claimKeys: ClaimKeys })),
  priceEvidence: z.array(
    z.object({
      item: z.string(),
      price: z.string(),
      currency: z.string(),
      date: z.string(),
      context: z.string(),
      reliability: z.string(),
      claimKeys: ClaimKeys,
    }),
  ),
  myths: z.array(
    z.object({ popularVersion: z.string(), whatTheEvidenceShows: z.string(), origin: z.string(), claimKeys: ClaimKeys }),
  ),
  interpretations: z.array(
    z.object({ position: z.string(), proponents: z.array(z.string()), summary: z.string(), claimKeys: ClaimKeys }),
  ),
  bubbleAssessment: z.object({
    summary: z.string(),
    argumentsFor: z.array(z.string()),
    argumentsAgainst: z.array(z.string()),
    claimKeys: ClaimKeys,
  }),
  narrativeHistory: z.object({
    summary: z.string(),
    milestones: z.array(z.object({ date: z.string(), work: z.string(), contribution: z.string() })),
    claimKeys: ClaimKeys,
  }),
  openQuestions: z.array(
    z.object({ question: z.string(), whyUnresolved: z.string(), whatWouldResolveIt: z.string(), claimKeys: ClaimKeys }),
  ),
  missingEvidence: z.array(z.object({ topic: z.string(), description: z.string() })),
});
export type ResearchDossierContent = z.infer<typeof ResearchDossierContent>;

export const QUALITY_CHECK_STATUSES = ['PASS', 'WARN', 'FAIL'] as const;
export type QualityCheckStatus = (typeof QUALITY_CHECK_STATUSES)[number];

export const QualityCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(QUALITY_CHECK_STATUSES),
  detail: z.string(),
  metric: z.number().nullable(),
  threshold: z.number().nullable(),
});
export type QualityCheck = z.infer<typeof QualityCheck>;

export const CoherenceIssue = z.object({
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  description: z.string(),
  claimKeys: ClaimKeys,
  /** What was done about it: an automatic fix that was applied, or "left for human review". */
  resolution: z.string(),
});
export type CoherenceIssue = z.infer<typeof CoherenceIssue>;

/** ResearchDossier.qualityReport — the automated gate run before human review. */
export const QualityReport = z.object({
  passed: z.boolean(),
  generatedAt: z.string(),
  checks: z.array(QualityCheck),
  /** Deterministic adjustments made before the checks (e.g. "C031 demoted to UNVERIFIED: no verified citation"). */
  normalizations: z.array(z.string()),
  coherenceIssues: z.array(CoherenceIssue),
});
export type QualityReport = z.infer<typeof QualityReport>;
