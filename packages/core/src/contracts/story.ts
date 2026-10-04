import { z } from 'zod';
import { CHARACTER_KINDS, HISTORICAL_STATUSES } from '../enums.ts';

/**
 * Shapes of the story stage's JSON documents: story candidates (mined from an
 * approved research dossier) and the story architecture built from the
 * editor's selection.
 *
 * Like the dossier sections, everything references claims by `claimKeys`
 * ("C014"), so every story beat traces back to a claim with a verdict and
 * citations. Sources are derived from those claims, never chosen by a model.
 */

const ClaimKeys = z.array(z.string());

/** StoryCandidate.characters[] — only people, groups and roles that appear in the evidence. */
export const StoryCharacter = z.object({
  name: z.string().min(1),
  kind: z.enum(CHARACTER_KINDS),
  /** What they want or do in this story. */
  role: z.string().min(1),
  claimKeys: ClaimKeys,
});
export type StoryCharacter = z.infer<typeof StoryCharacter>;

/**
 * StoryCandidate.mythThread — a myth told as an investigation, not a lecture:
 * the popular story → where it came from → who created or repeated it → what
 * actually happened → why it survived.
 */
export const MythThread = z.object({
  popularStory: z.string().min(1),
  origin: z.string().min(1),
  whoSpreadIt: z.string().min(1),
  whatHappened: z.string().min(1),
  whyItSurvived: z.string().min(1),
  claimKeys: ClaimKeys,
});
export type MythThread = z.infer<typeof MythThread>;

/** Appeal components scored by the critic. Historical confidence is computed from the evidence instead. */
export const STORY_SCORE_KEYS = [
  'intrigue',
  'humanDrama',
  'stakes',
  'surprise',
  'escalation',
  'visualPotential',
  'financialStakes',
  'emotionalWeight',
] as const;
export type StoryScoreKey = (typeof STORY_SCORE_KEYS)[number];

const Score = z.number().int().min(0).max(10);

/** StoryCandidate.scores — the critic's component scores (0–10), the weighted appeal and the critic's reasoning. */
export const StoryScores = z.object({
  intrigue: Score,
  humanDrama: Score,
  stakes: Score,
  surprise: Score,
  escalation: Score,
  visualPotential: Score,
  /** Financial or economic significance. */
  financialStakes: Score,
  emotionalWeight: Score,
  /** Weighted appeal before the historical-confidence adjustment (0–10). */
  appeal: z.number().min(0).max(10),
  rationale: z.string(),
});
export type StoryScores = z.infer<typeof StoryScores>;

/** StoryPack.content — what the pack holds besides its candidates. */
export const StoryPackContent = z.object({
  /** The AI's proposed selection for the documentary: a suggestion for the editor, never a decision. */
  selection: z.object({
    candidateKeys: z.array(z.string()),
    workingPremise: z.string(),
    rationale: z.string(),
    /** Candidates that could replace a selected one. */
    alternates: z.array(z.string()),
  }),
  /** Candidates the rules or the critic removed, and why (kept for transparency). */
  removed: z.array(z.object({ title: z.string(), storyType: z.string(), reason: z.string(), claimKeys: ClaimKeys })),
  /** Candidates the editor approved or flagged in the previous pass, carried into this one. */
  carriedOver: z.array(z.object({ fromPackVersion: z.number().int(), fromKey: z.string(), key: z.string() })),
  /** The editor's brief for this pass, if any. */
  editorNotes: z.string().nullable(),
});
export type StoryPackContent = z.infer<typeof StoryPackContent>;

/**
 * One sequence of the documentary blueprint. Text fields may be empty: the
 * architecture gate reports what is missing rather than the parser.
 */
export const StorySequence = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  /** What the sequence does for the documentary. */
  purpose: z.string(),
  /** Story candidates it is built from (ids and their keys in the pack). */
  candidateIds: z.array(z.string()),
  candidateKeys: z.array(z.string()),
  openingHook: z.string(),
  /** The question that keeps the viewer watching through the sequence. */
  narrativeQuestion: z.string(),
  keyEvents: z.array(z.object({ event: z.string().min(1), claimKeys: ClaimKeys })),
  characters: z.array(z.string()),
  conflict: z.string(),
  escalation: z.string(),
  reveal: z.string(),
  endingBeat: z.string(),
  /** Every claim the sequence relies on. */
  claimKeys: ClaimKeys,
  /** Retrieved sources cited by those claims (derived from the dossier). */
  sourceIds: z.array(z.string()),
  /** How each disputed, unverified or myth claim must be told on screen. */
  caveats: z.array(z.object({ claimKey: z.string(), framing: z.string().min(1) })),
  /** Computed from the verdicts of the sequence's claims. */
  historicalStatus: z.enum(HISTORICAL_STATUSES),
  historicalConfidence: z.number().int().min(0).max(10),
  estimatedDurationSec: z.number().int().min(0),
});
export type StorySequence = z.infer<typeof StorySequence>;

/** StoryArchitecture.content — the documentary blueprint (not a script). */
export const StoryArchitectureContent = z.object({
  premise: z.string(),
  centralQuestion: z.string(),
  narrativeSpine: z.string(),
  /** How the documentary answers its central question. */
  resolution: z.string(),
  sequences: z.array(StorySequence),
  /** Selected candidates the architect left out, and why. */
  unusedCandidates: z.array(z.object({ candidateKey: z.string(), reason: z.string() })),
});
export type StoryArchitectureContent = z.infer<typeof StoryArchitectureContent>;
