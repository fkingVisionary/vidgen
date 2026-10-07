import type { VisualCatalog } from '@docengine/core';
import { createVisualCatalog, type ReasoningEffort } from '@docengine/providers';

/** The kinds of paid step a storyboard job makes: the beats call, a shots call per section, one repair call. */
export const STORYBOARD_STEP_KINDS = ['beats', 'shots', 'repair'] as const;
export type StoryboardStepKind = (typeof STORYBOARD_STEP_KINDS)[number];

/** Above this many narrated blocks the beats call is made once per section (step "beats.<sequence>"). */
export const BEATS_BATCH_BLOCKS = 60;

/**
 * A job's steps, in the order a checkpoint keeps them: the beats call (or
 * one per section on a long scope), a shots call per section in scope, then
 * the repair call. Checkpoint steps must be declared before they are saved.
 */
export function storyboardSteps(sequences: readonly number[], beatsPerSection: boolean): string[] {
  return [...(beatsPerSection ? sequences.map((n) => `beats.${n}`) : ['beats']), ...sequences.map((n) => `shots.${n}`), 'repair'];
}

/** The kind of a step ("shots.3" → shots). */
export const stepKind = (step: string): StoryboardStepKind => step.split('.')[0] as StoryboardStepKind;

/**
 * Storyboard stage settings. Every limit is explicit so cost and depth are
 * predictable; the model is the AI provider's default unless a step kind
 * names another (STORYBOARD_MODELS). The catalog prices the forecasts; it is
 * built by the API from its settings and is never called.
 */
export interface StoryboardConfig {
  /** Abort a job when its recorded planning spend exceeds this (USD, estimated): the AI calls only. */
  maxCostUsd: number;
  effort: Record<StoryboardStepKind, ReasoningEffort>;
  maxTokens: Record<StoryboardStepKind, number>;
  /** Per-step-kind model overrides (provider model ids); unset kinds use the provider's default. */
  models: Partial<Record<StoryboardStepKind, string>>;
  catalog: VisualCatalog;
}

export const DEFAULT_STORYBOARD_CONFIG: StoryboardConfig = {
  maxCostUsd: 5,
  effort: { beats: 'high', shots: 'high', repair: 'medium' },
  // A section's shots carry the full structured spec of every shot (a dozen beats of several shots each).
  maxTokens: { beats: 32_000, shots: 64_000, repair: 32_000 },
  models: {},
  catalog: createVisualCatalog(),
};

/** Parse "shots=model-a,repair=model-b" into per-step-kind overrides; an unknown step kind is an error. */
export function parseStoryboardModels(spec: string | undefined): Partial<Record<StoryboardStepKind, string>> {
  const out: Partial<Record<StoryboardStepKind, string>> = {};
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [step, model] = part.split('=').map((x) => x?.trim());
    if (!step || !model || !(STORYBOARD_STEP_KINDS as readonly string[]).includes(step)) throw new Error(`STORYBOARD_MODELS: "${part}" is not step=model (steps: ${STORYBOARD_STEP_KINDS.join(', ')})`);
    out[step as StoryboardStepKind] = model;
  }
  return out;
}
