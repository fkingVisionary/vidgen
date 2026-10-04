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
  maxCostUsd: { mining: number; architecture: number };
  effort: { mine: ReasoningEffort; critic: ReasoningEffort; select: ReasoningEffort; architect: ReasoningEffort; review: ReasoningEffort };
  maxTokens: { mine: number; critic: number; select: number; architect: number; review: number };
}

export const DEFAULT_STORY_CONFIG: StoryConfig = {
  mineCount: 24,
  topUpExtra: 4,
  limits: STORY_LIMITS,
  maxCostUsd: { mining: 15, architecture: 10 },
  effort: { mine: 'high', critic: 'high', select: 'high', architect: 'high', review: 'high' },
  maxTokens: { mine: 64_000, critic: 32_000, select: 16_000, architect: 48_000, review: 64_000 },
};
