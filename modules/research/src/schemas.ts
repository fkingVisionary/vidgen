import {
  CLAIM_IMPORTANCES,
  CLAIM_TYPES,
  CLAIM_VERDICTS,
  CONFIDENCE_LEVELS,
  ResearchDossierContent,
  SOURCE_TYPES,
} from '@docengine/core';
import { z } from 'zod';

/**
 * Output schemas for each model call. Deliberately plain (all fields
 * required, nullable instead of optional, no numeric bounds) so they map
 * cleanly onto structured outputs; strict rules are enforced afterwards in
 * code (normalize.ts, quality.ts), where they can be tested.
 */

export const PlanOutput = z.object({
  questions: z.array(
    z.object({
      id: z.string().describe('Q1, Q2, …'),
      category: z.string().describe('short snake_case theme, e.g. chronology, price_evidence, historiography'),
      question: z.string(),
      rationale: z.string().describe('why the documentary needs this answered'),
      queries: z.array(z.string()).describe('2–4 distinct web search queries'),
    }),
  ),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const TriageOutput = z.object({
  selected: z.array(
    z.object({
      candidateId: z.string(),
      likelySourceType: z.enum(SOURCE_TYPES),
      priority: z.enum(['ESSENTIAL', 'USEFUL', 'BACKUP']),
      reason: z.string(),
    }),
  ),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const EVIDENCE_KINDS = ['FACT', 'NUMBER', 'DATE', 'INTERPRETATION', 'POPULAR_CLAIM', 'PRIMARY_TEXT'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const ReadOutput = z.object({
  assessment: z.object({
    title: z.string(),
    author: z.string().nullable(),
    publisher: z.string().nullable(),
    publishedDate: z.string().nullable(),
    sourceType: z.enum(SOURCE_TYPES),
    isPrimarySource: z.boolean(),
    reliability: z.enum(CONFIDENCE_LEVELS),
    reliabilityNotes: z.string(),
    relevance: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']),
    summary: z.string(),
    repeatsPopularMyths: z.boolean(),
  }),
  evidence: z.array(
    z.object({
      focusAreas: z.array(z.string()).describe('focus area IDs this evidence bears on, e.g. ["F2","F7"]'),
      statement: z.string().describe('what this passage establishes, in your words'),
      quote: z.string().describe('VERBATIM excerpt from the document supporting the statement'),
      locator: z.string().nullable().describe('section heading, page or paragraph, if visible'),
      kind: z.enum(EVIDENCE_KINDS),
      attribution: z.string().describe('who makes this claim: the author, or someone they report (e.g. "Mackay (1841), as quoted")'),
    }),
  ),
});
export type ReadOutput = z.infer<typeof ReadOutput>;

const S = ResearchDossierContent.shape;

export const SynthesisOutput = z.object({
  summary: z.string(),
  questionAnswers: z.array(z.object({ questionId: z.string(), answerSummary: z.string(), confidence: z.enum(CONFIDENCE_LEVELS) })),
  claims: z.array(
    z.object({
      key: z.string().describe('C001, C002, …'),
      statement: z.string(),
      claimType: z.enum(CLAIM_TYPES),
      questionId: z.string(),
      importance: z.enum(CLAIM_IMPORTANCES),
      verdict: z.enum(CLAIM_VERDICTS),
      confidence: z.enum(CONFIDENCE_LEVELS),
      popularVersion: z.string().nullable(),
      notes: z.string(),
      needsVerification: z.boolean(),
      supportingEvidence: z.array(z.string()),
      contradictingEvidence: z.array(z.string()),
      contextEvidence: z.array(z.string()),
    }),
  ),
  timeline: S.timeline,
  keyFigures: S.keyFigures,
  priceEvidence: S.priceEvidence,
  myths: S.myths,
  interpretations: S.interpretations,
  bubbleAssessment: S.bubbleAssessment,
  narrativeHistory: S.narrativeHistory,
  openQuestions: S.openQuestions,
  missingEvidence: S.missingEvidence,
});
export type SynthesisOutput = z.infer<typeof SynthesisOutput>;

export const ReviewOutput = z.object({
  issues: z.array(
    z.object({
      severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
      description: z.string(),
      claimKeys: z.array(z.string()),
      fix: z.object({
        action: z.enum(['NONE', 'SET_VERDICT', 'SET_CONFIDENCE', 'SET_NEEDS_VERIFICATION', 'REMOVE_CLAIM']),
        verdict: z.enum(CLAIM_VERDICTS).nullable(),
        confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
        rationale: z.string(),
      }),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
