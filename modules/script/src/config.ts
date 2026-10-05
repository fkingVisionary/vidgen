import type { ReasoningEffort } from '@docengine/providers';

/** The paid steps of a script job, in order. */
export const SCRIPT_STEPS = ['plan', 'write', 'edit', 'factCheck', 'perform'] as const;
export type ScriptStep = (typeof SCRIPT_STEPS)[number];

/**
 * Script stage settings. Every limit is explicit so cost and depth are
 * predictable; the model is the AI provider's default (AI_MODEL) unless a
 * step names another (SCRIPT_MODELS).
 */
export interface ScriptConfig {
  /** Abort a job if its recorded provider cost exceeds this (USD, estimated). */
  maxCostUsd: number;
  effort: Record<ScriptStep, ReasoningEffort>;
  maxTokens: Record<ScriptStep, number>;
  /** Per-step model overrides (provider model ids); unset steps use the provider's default. */
  models: Partial<Record<ScriptStep, string>>;
}

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  maxCostUsd: 15,
  effort: { plan: 'high', write: 'high', edit: 'high', factCheck: 'high', perform: 'medium' },
  // The writer returns the whole script (a refinement also reads one): a 12–15 minute script took about 46k
  // output tokens with thinking, so it gets the model's full output budget rather than risk a truncated job.
  maxTokens: { plan: 24_000, write: 128_000, edit: 48_000, factCheck: 48_000, perform: 32_000 },
  models: {},
};

/** Parse "perform=model-a,edit=model-b" into per-step overrides; unknown steps are an error. */
export function parseScriptModels(spec: string | undefined): Partial<Record<ScriptStep, string>> {
  const out: Partial<Record<ScriptStep, string>> = {};
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [step, model] = part.split('=').map((x) => x?.trim());
    if (!step || !model || !(SCRIPT_STEPS as readonly string[]).includes(step)) throw new Error(`SCRIPT_MODELS: "${part}" is not step=model (steps: ${SCRIPT_STEPS.join(', ')})`);
    out[step as ScriptStep] = model;
  }
  return out;
}
