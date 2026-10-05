import type { ReasoningEffort } from '@docengine/providers';

/** The paid steps of a script job, in order. */
export const SCRIPT_STEPS = ['plan', 'write', 'narrate', 'edit', 'factCheck', 'perform'] as const;
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
  /** The modes the Human Narration Pass runs in (Writing Engine 2). A narration pass on its own (NARRATION) always runs it. */
  narration: readonly ScriptMode[];
}

/** How a script job makes its version. */
export const SCRIPT_MODES = ['DRAFT', 'SECTIONS', 'REVISION', 'REFINEMENT', 'NARRATION'] as const;
export type ScriptMode = (typeof SCRIPT_MODES)[number];

/** "DRAFT,REFINEMENT" → the modes; "all" or empty → every mode; "none" → only a narration pass on its own. */
export function parseNarrationModes(spec: string | undefined): ScriptMode[] {
  const s = (spec ?? '').trim();
  if (!s || s === 'all') return [...SCRIPT_MODES];
  if (s === 'none') return ['NARRATION'];
  const modes = s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const bad = modes.filter((m) => !(SCRIPT_MODES as readonly string[]).includes(m));
  if (bad.length) throw new Error(`SCRIPT_NARRATION_MODES: ${bad.join(', ')} not a mode (${SCRIPT_MODES.join(', ')}, all, none)`);
  return [...new Set([...modes, 'NARRATION'])] as ScriptMode[];
}

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  maxCostUsd: 15,
  effort: { plan: 'high', write: 'high', narrate: 'high', edit: 'high', factCheck: 'high', perform: 'medium' },
  // The writer returns the whole script (a refinement also reads one): a 12–15 minute script took about 46k
  // output tokens with thinking, so it gets the model's full output budget rather than risk a truncated job.
  // The narration pass returns edits to the blocks that need them, not the script: the editor's budget.
  maxTokens: { plan: 24_000, write: 128_000, narrate: 48_000, edit: 48_000, factCheck: 48_000, perform: 32_000 },
  models: {},
  narration: SCRIPT_MODES,
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
