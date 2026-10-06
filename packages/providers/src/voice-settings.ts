import type { ProviderSettingValues, VoiceSettingDescriptor, VoiceSettingValue } from '@docengine/core';

/**
 * Provider settings, generically: a provider describes its settings
 * (VoiceSettingDescriptor), and these helpers check, complete and filter a
 * record against the descriptions. Shared by the providers and test fakes,
 * so the engine never names a provider's keys. A value is checked, never
 * clamped; `step` is the form's, not a rule.
 */

/** Whether a setting is sent to a model: its list when it has one, else every model but its exceptions (so also a model the provider does not know). */
export const isSentTo = (d: Pick<VoiceSettingDescriptor, 'models' | 'except'>, model: string): boolean => (d.models ? d.models.includes(model) : !d.except?.includes(model));

const shown = (value: unknown) => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value));

/** Why a value does not fit its descriptor, or null when it does. */
export function settingProblem(d: VoiceSettingDescriptor, value: unknown): string | null {
  switch (d.kind) {
    case 'NUMBER': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${d.key}: a number is needed (got ${shown(value)})`;
      if ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max)) return `${d.key}: ${value} is outside ${d.min ?? '…'}–${d.max ?? '…'}`;
      return null;
    }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : `${d.key}: true or false is needed (got ${shown(value)})`;
    case 'CHOICE': {
      if (typeof value === 'string' && (!d.choices || d.choices.some((c) => c.value === value))) return null;
      return `${d.key}: ${shown(value)} is not one of ${(d.choices ?? []).map((c) => c.value).join(', ')}`;
    }
  }
}

/**
 * Settings checked and completed against the descriptors: every described
 * key present, its default where the input has no value or one that does
 * not fit; unknown keys and values that do not fit are left out and listed
 * in `problems` (never clamped).
 */
export function normalizeVoiceSettings(descriptors: readonly VoiceSettingDescriptor[], input: Readonly<Record<string, unknown>>): { settings: ProviderSettingValues; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(descriptors.map((d) => d.key));
  for (const key of Object.keys(input)) if (!known.has(key)) problems.push(`${key}: not a setting this provider has`);
  const settings: ProviderSettingValues = {};
  for (const d of descriptors) {
    const value = input[d.key];
    const problem = value === undefined ? null : settingProblem(d, value);
    if (problem) problems.push(problem);
    settings[d.key] = value === undefined || problem ? d.default : (value as VoiceSettingValue);
  }
  return { settings, problems };
}

/** What a model is sent of these settings (in the descriptors' order), and the keys it is not: settings it does not take, and keys the provider does not describe. */
export function sentVoiceSettings(descriptors: readonly VoiceSettingDescriptor[], settings: Readonly<ProviderSettingValues>, model: string): { sent: ProviderSettingValues; ignored: string[] } {
  const sent: ProviderSettingValues = {};
  const ignored: string[] = [];
  for (const d of descriptors) {
    const value = settings[d.key];
    if (value === undefined) continue;
    if (isSentTo(d, model)) sent[d.key] = value;
    else ignored.push(d.key);
  }
  const known = new Set(descriptors.map((d) => d.key));
  for (const key of Object.keys(settings)) if (!known.has(key)) ignored.push(key);
  return { sent, ignored };
}

/** Problems with provider settings a project, a run or a take sets over a profile: keys the provider does not describe or does not let be overridden, and values that do not fit. */
export function checkVoiceOverrides(descriptors: readonly VoiceSettingDescriptor[], partial: Readonly<Record<string, unknown>>): string[] {
  const byKey = new Map(descriptors.map((d) => [d.key, d]));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(partial)) {
    const d = byKey.get(key);
    if (!d) problems.push(`${key}: not a setting this provider has`);
    else if (!d.overridable) problems.push(`${key}: set by the profile only (it cannot be overridden)`);
    else {
      const problem = settingProblem(d, value);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}
