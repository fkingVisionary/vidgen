import { STORY_SCORE_KEYS, type StoryScoreKey } from './contracts/story.ts';
import type { ClaimVerdict, ConfidenceLevel, HistoricalStatus } from './enums.ts';

/**
 * Story ranking and evidence rules, shared by the story stage, the API and
 * the dashboard. All deterministic: the critic scores a story's appeal; how
 * far it can be trusted comes from the evidence it rests on.
 */

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Weights of the appeal components (they sum to 1). */
export const STORY_SCORE_WEIGHTS: Readonly<Record<StoryScoreKey, number>> = {
  intrigue: 0.2,
  humanDrama: 0.15,
  surprise: 0.13,
  stakes: 0.12,
  visualPotential: 0.12,
  escalation: 0.1,
  emotionalWeight: 0.1,
  financialStakes: 0.08,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Weighted appeal, 0–10. */
export function appealScore(scores: Readonly<Record<StoryScoreKey, number>>): number {
  let sum = 0;
  for (const key of STORY_SCORE_KEYS) sum += STORY_SCORE_WEIGHTS[key] * scores[key];
  return round2(sum);
}

/** Appeal multiplier at historical confidence 0; it rises linearly to 1 at confidence 10. */
export const CONFIDENCE_FLOOR = 0.55;

export function confidenceMultiplier(historicalConfidence: number): number {
  const c = Math.min(10, Math.max(0, historicalConfidence));
  return CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * (c / 10);
}

/**
 * Overall rank: appeal discounted by weak evidence, so a sensational but
 * poorly supported story does not automatically beat a fascinating,
 * well-supported one.
 */
export function rankScore(appeal: number, historicalConfidence: number): number {
  return round2(appeal * confidenceMultiplier(historicalConfidence));
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** A dossier claim as the story rules see it. */
export interface StoryEvidenceClaim {
  key: string;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  /** Retrieved, non-duplicate sources citing the claim with a verified quote. */
  sourceIds: readonly string[];
}

/** A story's status is set by the weakest kind of claim it rests on. */
export function historicalStatusOf(verdicts: readonly ClaimVerdict[]): HistoricalStatus {
  if (verdicts.length === 0) return 'UNCERTAIN';
  if (verdicts.includes('MYTH')) return 'MYTH_INVESTIGATION';
  if (verdicts.includes('DISPUTED')) return 'CONTESTED';
  if (verdicts.includes('UNVERIFIED')) return 'UNCERTAIN';
  if (verdicts.includes('PROBABLE')) return 'PROBABLE';
  return 'ESTABLISHED';
}

/** Verdicts whose claims must never be told as plain fact. */
export const CAVEAT_VERDICTS: readonly ClaimVerdict[] = ['DISPUTED', 'UNVERIFIED', 'MYTH'];

const VERDICT_STRENGTH: Record<ClaimVerdict, number> = {
  ESTABLISHED: 10,
  PROBABLE: 7,
  // The evidence shows the popular story is wrong: solid ground for telling it as a myth.
  MYTH: 8,
  DISPUTED: 4,
  UNVERIFIED: 2,
};

const CONFIDENCE_FACTOR: Record<ConfidenceLevel, number> = { HIGH: 1, MEDIUM: 0.85, LOW: 0.65 };

/**
 * 0–10: how well the evidence carries a story. Mixes the average and the
 * weakest of its claims (a story is only as strong as what it rests on) and
 * discounts stories resting on one or two sources.
 */
export function historicalConfidenceOf(claims: readonly StoryEvidenceClaim[]): number {
  if (claims.length === 0) return 0;
  const strengths = claims.map((c) => VERDICT_STRENGTH[c.verdict] * CONFIDENCE_FACTOR[c.confidence]);
  const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  const weakest = Math.min(...strengths);
  const sources = new Set(claims.flatMap((c) => c.sourceIds)).size;
  const breadth = sources >= 3 ? 1 : sources === 2 ? 0.95 : sources === 1 ? 0.85 : 0.6;
  return Math.max(0, Math.min(10, Math.round((0.6 * mean + 0.4 * weakest) * breadth)));
}

// ---------------------------------------------------------------------------
// Pack and selection size
// ---------------------------------------------------------------------------

export const STORY_LIMITS = {
  /** Candidates in a mined pack: fewer than `fail` fails the mining gate, fewer than `min` warns. */
  candidates: { fail: 10, min: 15, max: 30 },
  /** Primary story units selected for one documentary. */
  selection: { min: 5, max: 10 },
} as const;

/** Why a selection of `count` units cannot be architected, or null if it can. */
export function selectionProblem(count: number): string | null {
  const { min, max } = STORY_LIMITS.selection;
  if (count < min) return `Select at least ${min} story units (${count} selected)`;
  if (count > max) return `Select at most ${max} story units (${count} selected)`;
  return null;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeTarget {
  minSec: number;
  maxSec: number;
  /** The middle of the range: what the architect aims for. */
  targetSec: number;
}

export function runtimeTarget(p: { targetMinutesMin: number; targetMinutesMax: number }): RuntimeTarget {
  return { minSec: p.targetMinutesMin * 60, maxSec: p.targetMinutesMax * 60, targetSec: Math.round((p.targetMinutesMin + p.targetMinutesMax) * 30) };
}

/** Outside the target range by up to this share of the range's bound: a warning; further: a failure. */
export const RUNTIME_TOLERANCE = 0.2;

export function runtimeFit(estimatedSec: number, target: RuntimeTarget): 'WITHIN' | 'NEAR' | 'OFF' {
  if (estimatedSec >= target.minSec && estimatedSec <= target.maxSec) return 'WITHIN';
  if (estimatedSec >= target.minSec * (1 - RUNTIME_TOLERANCE) && estimatedSec <= target.maxSec * (1 + RUNTIME_TOLERANCE)) return 'NEAR';
  return 'OFF';
}

/** Seconds of narration per structural element (~150 spoken words a minute). */
export const DURATION_MODEL = { hookSec: 20, perEventSec: 30, revealSec: 15, perCaveatSec: 12, endingSec: 10 } as const;

/**
 * Narration time a sequence needs judging by its structure alone: an opening
 * hook, each key event, landing a reveal, explaining each disputed or
 * mythical point, and an ending beat. A sanity check on the architect's own
 * estimate, which knows the material better.
 */
export function structuralDurationSec(seq: { keyEvents: readonly unknown[]; caveats: readonly unknown[]; reveal: string }): number {
  const m = DURATION_MODEL;
  return m.hookSec + m.perEventSec * seq.keyEvents.length + (seq.reveal.trim() ? m.revealSec : 0) + m.perCaveatSec * seq.caveats.length + m.endingSec;
}
