import { STORY_LIMITS } from '@docengine/core';
import type { ReasoningEffort } from '@docengine/providers';

/**
 * Story stage settings. Every limit is explicit so cost and depth are
 * predictable.
 */
export interface StoryConfig {
  /** Candidates asked for in the first mining call (removals by the rules leave headroom above the minimum). */
  mineCount: number;
  /** Asked for on top of the shortfall when a second mining call is needed. */
  topUpExtra: number;
  limits: typeof STORY_LIMITS;
  /** Abort a job if its recorded provider cost exceeds this (USD, estimated). */
  maxCostUsd: { mining: number; architecture: number; angles: number };
  /** `review` covers both architecture reviewers (story editor and fact checker). */
  effort: { mine: ReasoningEffort; critic: ReasoningEffort; select: ReasoningEffort; architect: ReasoningEffort; review: ReasoningEffort; opportunities: ReasoningEffort; angles: ReasoningEffort };
  maxTokens: { mine: number; critic: number; select: number; architect: number; review: number; opportunities: number; angles: number };
}

export const DEFAULT_STORY_CONFIG: StoryConfig = {
  mineCount: 24,
  topUpExtra: 4,
  limits: STORY_LIMITS,
  maxCostUsd: { mining: 15, architecture: 10, angles: 5 },
  effort: { mine: 'high', critic: 'high', select: 'high', architect: 'high', review: 'high', opportunities: 'high', angles: 'high' },
  maxTokens: { mine: 64_000, critic: 32_000, select: 16_000, architect: 64_000, review: 64_000, opportunities: 32_000, angles: 32_000 },
};
