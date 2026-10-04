import {
  OPPORTUNITY_SCORE_KEYS,
  STORY_SCORE_KEYS,
  STORY_VALUE_KEYS,
  type HistoricalValueKey,
  type OpportunityScoreKey,
  type StoryScoreKey,
  type StoryValueKey,
} from './contracts/story.ts';
import type { BeatFunction, ClaimVerdict, ConfidenceLevel, HistoricalStatus, InformationClass, Presentation, ReconstructionLevel } from './enums.ts';

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

// ---------------------------------------------------------------------------
// Story Engine 2.0: story value, historical value, story appeal
// ---------------------------------------------------------------------------

/**
 * Weights of STORY VALUE (they sum to 1). Human stakes weigh most: a historical
 * event without people who stand to gain or lose something is not yet a story.
 * mythInvestigation only counts when the unit has uncertain or myth material;
 * otherwise the other weights are scaled up to fill its share.
 */
export const STORY_VALUE_WEIGHTS: Readonly<Record<StoryValueKey, number>> = {
  humanStakes: 0.16,
  conflict: 0.12,
  mystery: 0.12,
  characterPotential: 0.12,
  visualPotential: 0.12,
  escalation: 0.1,
  emotionalPotential: 0.1,
  revealPotential: 0.1,
  mythInvestigation: 0.06,
};

/** Weights of HISTORICAL VALUE (they sum to 1). evidenceQuality is the computed historical confidence. */
export const HISTORICAL_VALUE_WEIGHTS: Readonly<Record<HistoricalValueKey, number>> = {
  evidenceQuality: 0.4,
  significance: 0.25,
  relevance: 0.2,
  uniqueness: 0.15,
};

/** Story-value weights in force for a unit (mythInvestigation dropped and the rest rescaled when not applicable). */
export function storyValueWeights(mythApplicable: boolean): Record<StoryValueKey, number> {
  if (mythApplicable) return { ...STORY_VALUE_WEIGHTS };
  const scale = 1 / (1 - STORY_VALUE_WEIGHTS.mythInvestigation);
  const out = {} as Record<StoryValueKey, number>;
  for (const k of STORY_VALUE_KEYS) out[k] = k === 'mythInvestigation' ? 0 : STORY_VALUE_WEIGHTS[k] * scale;
  return out;
}

/** STORY VALUE, 0–10: how strong a story the unit is, whatever its evidence. */
export function storyValue(scores: Readonly<Record<StoryValueKey, number>>, mythApplicable: boolean): number {
  const w = storyValueWeights(mythApplicable);
  let sum = 0;
  for (const k of STORY_VALUE_KEYS) sum += w[k] * scores[k];
  return round2(sum);
}

/** HISTORICAL VALUE, 0–10: evidence quality, significance, relevance and uniqueness. */
export function historicalValue(scores: Readonly<Record<HistoricalValueKey, number>>): number {
  let sum = 0;
  for (const k of Object.keys(HISTORICAL_VALUE_WEIGHTS) as HistoricalValueKey[]) sum += HISTORICAL_VALUE_WEIGHTS[k] * scores[k];
  return round2(sum);
}

/** Story appeal multiplier at historical value 0; it rises linearly to 1 at historical value 10. */
export const APPEAL_HISTORY_FLOOR = 0.6;

/**
 * STORY APPEAL, 0–10 — the ranking score. Story value drives it; historical
 * value moderates it (×0.6 to ×1), so a smaller event with great narrative
 * potential can outrank an important event with none, while a sensational
 * but poorly evidenced story still does not beat a strong, well-evidenced one.
 */
export function storyAppeal(storyVal: number, historicalVal: number): number {
  const h = Math.min(10, Math.max(0, historicalVal));
  return round2(storyVal * (APPEAL_HISTORY_FLOOR + (1 - APPEAL_HISTORY_FLOOR) * (h / 10)));
}

/** The story dimensions that contributed most to a unit's story value: why the AI thinks it is compelling. */
export function strongestStoryDimensions(scores: Readonly<Record<StoryValueKey, number>>, mythApplicable: boolean, n = 3): { dimension: StoryValueKey; score: number; weight: number; contribution: number }[] {
  const w = storyValueWeights(mythApplicable);
  return STORY_VALUE_KEYS.filter((k) => w[k] > 0)
    .map((k) => ({ dimension: k, score: scores[k], weight: round2(w[k]), contribution: round2(w[k] * scores[k]) }))
    .sort((a, b) => b.contribution - a.contribution || b.score - a.score)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Story Engine 2.0: presentation of claims by verdict
// ---------------------------------------------------------------------------

/** The presentation each verdict requires. Everything but ESTABLISHED needs an instruction in the architecture. */
export const PRESENTATION_FOR_VERDICT: Readonly<Record<ClaimVerdict, Presentation>> = {
  ESTABLISHED: 'STATE',
  PROBABLE: 'HEDGE',
  DISPUTED: 'PRESENT_AS_DISPUTED',
  UNVERIFIED: 'PRESENT_AS_UNCONFIRMED',
  MYTH: 'INVESTIGATE_AS_MYTH',
};

/** Verdicts whose claims need a presentation instruction (Engine 2 adds PROBABLE to the caveat verdicts). */
export const PRESENTATION_VERDICTS: readonly ClaimVerdict[] = ['PROBABLE', 'DISPUTED', 'UNVERIFIED', 'MYTH'];

/** Wording that reflects a PROBABLE claim's status ("records suggest", "contemporary accounts indicate", …). */
export const HEDGE_PATTERN =
  /\b(records? (?:suggests?|indicates?|imply|implies)|(?:contemporary |surviving )?accounts? (?:suggests?|indicates?|imply|implies|say)|evidence (?:suggests?|indicates?|points)|(?:most )?likely|probably|apparently|appears? to|seems? to|reportedly|it is (?:thought|believed|likely)|according to|historians (?:think|believe|suggest)|suggests?|indicates?|may have|might have|perhaps)\b/i;

// ---------------------------------------------------------------------------
// Story Engine 2.0: reconstruction budget, fiction limits, duration
// ---------------------------------------------------------------------------

/**
 * Warn (never fail) when reconstruction and fiction together exceed 40% of
 * the beats, or fiction alone exceeds 25%. The editor decides.
 */
export const RECONSTRUCTION_BUDGET = { creative: 0.4, fiction: 0.25 } as const;

/** Fictional devices allowed before a warning: one viewer POV and up to two composites. */
export const FICTIONAL_CAST_LIMITS = { pov: 1, composites: 2 } as const;

/** Share of beats per information class. */
export function informationShares(bases: readonly InformationClass[]): Record<InformationClass, number> {
  const out: Record<InformationClass, number> = { DOCUMENTED: 0, RECONSTRUCTION: 0, UNCERTAIN: 0, FICTION: 0 };
  if (bases.length === 0) return out;
  for (const b of bases) out[b] += 1;
  for (const k of Object.keys(out) as InformationClass[]) out[k] = round2(out[k] / bases.length);
  return out;
}

/** NONE: no reconstruction or fiction; LOW: under 20% of beats; MEDIUM: up to 40%; HIGH: over 40%. */
export function reconstructionLevelOf(shares: Readonly<Record<InformationClass, number>>): ReconstructionLevel {
  const creative = shares.RECONSTRUCTION + shares.FICTION;
  if (creative === 0) return 'NONE';
  if (creative < 0.2) return 'LOW';
  if (creative <= RECONSTRUCTION_BUDGET.creative) return 'MEDIUM';
  return 'HIGH';
}

/** Seconds of narration per beat, by dramatic function (~150 spoken words a minute). */
export const BEAT_SECONDS: Readonly<Record<BeatFunction, number>> = {
  COLD_OPEN: 20,
  ORIENTATION: 15,
  STAKES: 15,
  CONFLICT: 20,
  ESCALATION: 20,
  TURN: 15,
  REVEAL: 20,
  CONSEQUENCE: 15,
  INVESTIGATION: 25,
  TRANSITION: 8,
};

/** Extra seconds for presenting a claim with a hedge, a dispute, an open question or a myth investigation. */
export const PRESENTATION_SECONDS = 8;

/** Narration time a v2 sequence needs judging by its beats: a sanity check on the architect's estimate. */
export function structuralDurationSecV2(seq: { beats: readonly { function: BeatFunction }[]; presentation: readonly unknown[] }): number {
  return seq.beats.reduce((sum, b) => sum + BEAT_SECONDS[b.function], 0) + PRESENTATION_SECONDS * seq.presentation.length;
}

// ---------------------------------------------------------------------------
// Content opportunities
// ---------------------------------------------------------------------------

/** Weights of SHORT-FORM POTENTIAL (they sum to 1): a short lives or dies by its hook and payoff. */
export const OPPORTUNITY_SCORE_WEIGHTS: Readonly<Record<OpportunityScoreKey, number>> = {
  hook: 0.25,
  payoff: 0.2,
  standalone: 0.2,
  visual: 0.15,
  emotion: 0.1,
  pace: 0.1,
};

/** SHORT-FORM POTENTIAL, 0–10: the score short opportunities are ranked by. */
export function shortPotential(scores: Readonly<Record<OpportunityScoreKey, number>>): number {
  let sum = 0;
  for (const k of OPPORTUNITY_SCORE_KEYS) sum += OPPORTUNITY_SCORE_WEIGHTS[k] * scores[k];
  return round2(sum);
}

export const CONTENT_LIMITS = {
  /** Short-form duration bounds (seconds). */
  short: { minSec: 15, maxSec: 180, defaultSec: 60 },
  /** A long-form opportunity is at least this long (seconds). */
  longFormMinSec: 300,
  /** At most this many opportunities per architecture (the strongest are kept). */
  maxOpportunities: 12,
  /** What a 10–15 minute documentary usually yields; a guide, never a quota. */
  typicalShorts: { min: 4, max: 8 },
} as const;
