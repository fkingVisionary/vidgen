import {
  EARLIER_PERFORMANCE_RULES,
  ChunkingSettings,
  ContextSettings,
  PerformanceRules,
  VoiceConfigOverrides,
  VoiceRunConfig,
  VoiceTakeConfig,
  VoiceTakeOverride,
  readProfileConfig,
  type ConfigProvenance,
  type EffectiveVoiceConfig,
  type PerformanceStrategy,
  type ProviderSettingValues,
  type SelectionMode,
  type VoiceProfileConfig,
  type VoiceProfileRef,
} from '@docengine/core';
import type { VoiceGeneration, VoiceProfile, VoiceProfileFamily, VoiceRun } from '@docengine/database';
import { checkVoiceOverrides, type VoiceProvider } from '@docengine/providers';

/**
 * A take's configuration, layer by layer: the profile version, then the
 * project's overrides, the run's options and a take's temporary override,
 * with where each setting came from. A run stores what it was made with
 * (`voice_runs.config`), and so does each take (`voice_generations.config`);
 * runs and takes made before saved profiles are read back reconstructed
 * from their profile version and the `strategy` and `settings` columns,
 * exactly as the engine then made them. Pure: nothing here reads the
 * database or calls a voice.
 */

/** What the configuration needs of a provider: its name, its settings' descriptions, and how it checks them and filters them per model. */
export type ConfigProvider = Pick<VoiceProvider, 'info' | 'settings' | 'normalizeSettings' | 'sentSettings'>;

/** A profile version with its family (null: made before saved profiles and not yet adopted). */
export type ProfileRow = VoiceProfile & { family: VoiceProfileFamily | null };

export interface ConfigLayer {
  source: 'PROJECT' | 'RUN' | 'TAKE';
  overrides: VoiceConfigOverrides;
}

/** Overrides as a later version of this code may have stored them: a key this one does not know is kept, not refused. */
const StoredOverrides = VoiceConfigOverrides.loose();
const StoredRunConfig = VoiceRunConfig.extend({ projectOverrides: StoredOverrides, runOptions: StoredOverrides });
const StoredTakeConfig = VoiceTakeConfig.extend({ override: VoiceTakeOverride.loose().nullable() });

/** JSON with every object's keys in order, so equal settings compare equal whatever order they were written in. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** A version as runs and takes name it. */
export const profileRef = (v: ProfileRow): VoiceProfileRef => ({ familyId: v.familyId, familyName: v.family?.name ?? null, versionId: v.id, version: v.version, name: v.name });

/** "Tulip narrator v2", or "House narrator v1 (now Classic narrator)" after the family was renamed. */
export const profileLabel = (ref: VoiceProfileRef): string => `${ref.name} v${ref.version}${ref.familyName && ref.familyName !== ref.name ? ` (now ${ref.familyName})` : ''}`;

/**
 * A version's config, read in either shape and normalised by the provider:
 * every setting it describes, defaults filled in, and what did not fit in
 * `problems`. Stored values are never changed; a provider that is not this
 * version's leaves them raw.
 */
export function versionConfig(v: Pick<VoiceProfile, 'provider' | 'config'>, provider: ConfigProvider): { config: VoiceProfileConfig; legacy: boolean; problems: string[] } {
  const { config, legacy } = readProfileConfig(v.config);
  if (v.provider !== provider.info.name) return { config, legacy, problems: [] };
  const n = provider.normalizeSettings(config.providerSettings);
  return { config: { ...config, providerSettings: n.settings }, legacy, problems: n.problems };
}

/** A version as an effective configuration (no layers): its columns and config. */
export function versionFields(v: VoiceProfile, provider: ConfigProvider): EffectiveVoiceConfig {
  return { ...versionConfig(v, provider).config, provider: v.provider, voiceId: v.voiceId, model: v.modelId, language: v.language, outputFormat: v.outputFormat };
}

/** Each layer laid over a configuration in order: whole values replaced, performance rules and provider settings merged key by key; every path a layer sets is recorded, even at the value it already had. */
function overlay(base: EffectiveVoiceConfig, provenance: ConfigProvenance, layers: readonly ConfigLayer[]): { effective: EffectiveVoiceConfig; provenance: ConfigProvenance } {
  const out = structuredClone(base);
  const prov: ConfigProvenance = { ...provenance };
  const rules: Record<string, unknown> = { ...out.performanceRules };
  for (const { source, overrides: o } of layers) {
    if (o.strategy !== undefined) {
      out.strategy = o.strategy;
      prov.strategy = source;
    }
    if (o.chunking !== undefined) {
      out.chunking = { ...o.chunking };
      prov.chunking = source;
    }
    if (o.context !== undefined) {
      out.context = { ...o.context };
      prov.context = source;
    }
    if (o.numberStyle !== undefined) {
      out.numberStyle = o.numberStyle;
      prov.numberStyle = source;
    }
    for (const [key, value] of Object.entries(o.performanceRules ?? {})) {
      if (value === undefined) continue;
      rules[key] = structuredClone(value);
      prov[`performanceRules.${key}`] = source;
    }
    for (const [key, value] of Object.entries(o.providerSettings ?? {})) {
      out.providerSettings[key] = value;
      prov[`providerSettings.${key}`] = source;
    }
  }
  // Each override was checked on its own; the merged rules are checked whole (a rule that does not fit keeps the configuration's).
  out.performanceRules = PerformanceRules.catch(out.performanceRules).parse(rules);
  return { effective: out, provenance: prov };
}

/** The version with each layer laid over it in order, with the provenance of every setting a layer set. */
export function effectiveConfig(v: VoiceProfile, layers: readonly ConfigLayer[], provider: ConfigProvider): { effective: EffectiveVoiceConfig; provenance: ConfigProvenance } {
  return overlay(versionFields(v, provider), {}, layers);
}

/** Problems with overrides before they are stored or used: provider keys it does not describe or does not let be overridden, invalid values, and chunking for a take (its chunk is the run's). */
export function checkOverrides(o: VoiceConfigOverrides, provider: Pick<VoiceProvider, 'settings'>, scope: ConfigLayer['source']): string[] {
  const problems: string[] = [];
  const parsed = (scope === 'TAKE' ? VoiceTakeOverride : VoiceConfigOverrides).safeParse(o);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys' && issue.keys.includes('chunking') && scope === 'TAKE') {
        problems.push("chunking: a take is made of its run's chunk (start a new run for another chunk size)");
        const others = issue.keys.filter((k) => k !== 'chunking');
        if (others.length) problems.push(`${issue.path.join('.') || others.join(', ')}: Unrecognized key${others.length > 1 ? 's' : ''}: ${others.map((k) => `"${k}"`).join(', ')}`);
      } else problems.push(`${issue.path.join('.') || (issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : 'overrides')}: ${issue.message}`);
    }
  }
  if (o.providerSettings) problems.push(...checkVoiceOverrides(provider.settings, o.providerSettings));
  return problems;
}

/** Nothing set (performance rules and provider settings with no key count as unset). */
export const isEmptyOverride = (o: VoiceConfigOverrides | null | undefined): boolean =>
  !o || Object.entries(o).every(([key, v]) => v === undefined || ((key === 'performanceRules' || key === 'providerSettings') && Object.values(v as object).every((x) => x === undefined)));

/** Two override sets as one (the second wins; performance rules and provider settings key by key). */
export function mergeOverrides(a: VoiceConfigOverrides, b: VoiceConfigOverrides): VoiceConfigOverrides {
  const out: VoiceConfigOverrides = { ...a, ...b };
  if (a.performanceRules || b.performanceRules) out.performanceRules = { ...a.performanceRules, ...b.performanceRules };
  if (a.providerSettings || b.providerSettings) out.providerSettings = { ...a.providerSettings, ...b.providerSettings };
  return out;
}

/** What the model is sent of the settings and what it does not take; raw when the configured provider is not the configuration's (it cannot say). */
function sentOf(effective: EffectiveVoiceConfig, provider: ConfigProvider): { sent: ProviderSettingValues; ignored: string[] } {
  if (effective.provider !== provider.info.name) return { sent: { ...effective.providerSettings }, ignored: [] };
  return provider.sentSettings(effective.providerSettings, effective.model);
}

/** A new run's configuration, frozen when it is created: the version, the project's overrides (production's family only: the caller decides) and the run's options. */
export function newRunConfig(args: { version: ProfileRow; selection: { mode: SelectionMode; revision: number }; projectOverrides: VoiceConfigOverrides; runOptions: VoiceConfigOverrides }, provider: ConfigProvider): VoiceRunConfig {
  const layers: ConfigLayer[] = [];
  if (!isEmptyOverride(args.projectOverrides)) layers.push({ source: 'PROJECT', overrides: args.projectOverrides });
  if (!isEmptyOverride(args.runOptions)) layers.push({ source: 'RUN', overrides: args.runOptions });
  const { effective, provenance } = effectiveConfig(args.version, layers, provider);
  return { reconstructed: false, profile: profileRef(args.version), selection: args.selection, projectOverrides: args.projectOverrides, runOptions: args.runOptions, effective, provenance, ...sentOf(effective, provider) };
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * A run's stored snapshot, verbatim; or, for a run made before saved
 * profiles, one rebuilt from its version, strategy and settings (marked
 * reconstructed). The rebuild is what the engine then did: the version's
 * voice, model, output format, number style and settings, the run's
 * strategy, chunking and context (read as the stage read them), the project
 * lexicon only (no profile rules) and EARLIER_PERFORMANCE_RULES.
 */
export function runConfig(run: Pick<VoiceRun, 'config' | 'strategy' | 'settings'> & { profile: ProfileRow }, provider: ConfigProvider): VoiceRunConfig {
  if (run.config !== null && run.config !== undefined) {
    const stored = StoredRunConfig.safeParse(run.config);
    if (stored.success) return stored.data as VoiceRunConfig;
  }
  const fields = versionFields(run.profile, provider);
  const settings = record(run.settings);
  const context = record(settings.context);
  const chunking = ChunkingSettings.safeParse(settings.chunking);
  const effective: EffectiveVoiceConfig = {
    ...fields,
    strategy: run.strategy,
    chunking: chunking.success ? chunking.data : fields.chunking,
    // As the stage read them: a missing figure was no context.
    context: ContextSettings.safeParse(context).data ?? { previousChars: count(context.previousChars), nextChars: count(context.nextChars), stitch: context.stitch === true },
    pronunciation: { rules: [] },
    performanceRules: structuredClone(EARLIER_PERFORMANCE_RULES) as PerformanceRules,
  };
  const runOptions: VoiceConfigOverrides = {};
  const provenance: ConfigProvenance = {};
  if (effective.strategy !== fields.strategy) runOptions.strategy = effective.strategy;
  if (!same(effective.chunking, fields.chunking)) runOptions.chunking = effective.chunking;
  if (!same(effective.context, fields.context)) runOptions.context = effective.context;
  for (const key of Object.keys(runOptions)) provenance[key] = 'RUN';
  return { reconstructed: true, profile: profileRef(run.profile), selection: null, projectOverrides: {}, runOptions, effective, provenance, ...sentOf(effective, provider) };
}

/** A take's stored configuration, verbatim; or, for a take made before saved profiles, the run's with the take's strategy (marked reconstructed). */
export function takeConfig(take: Pick<VoiceGeneration, 'config' | 'strategy'> & { profile: ProfileRow }, run: VoiceRunConfig): VoiceTakeConfig {
  if (take.config !== null && take.config !== undefined) {
    const stored = StoredTakeConfig.safeParse(take.config);
    if (stored.success) return stored.data as VoiceTakeConfig;
  }
  const differs = take.strategy !== run.effective.strategy;
  const effective: EffectiveVoiceConfig = { ...structuredClone(run.effective), strategy: take.strategy };
  return {
    reconstructed: true,
    base: 'RUN',
    override: differs ? { strategy: take.strategy } : null,
    profile: profileRef(take.profile),
    effective,
    provenance: differs ? { ...run.provenance, strategy: 'TAKE' } : { ...run.provenance },
    differs: differs ? [strategyDifference(run.effective.strategy, take.strategy)] : [],
    identityDiffers: false,
  };
}

const strategyDifference = (run: PerformanceStrategy, take: PerformanceStrategy) => `performance: ${take.toLowerCase()} (run: ${run.toLowerCase()})`;

/**
 * A new take's configuration. RUN: the TAKE layer over the run's stored
 * effective configuration as it is (never re-read from the version or
 * re-normalised, so a later descriptor cannot change it). PRODUCTION:
 * production's version with the project's overrides and the TAKE layer,
 * and the run's chunking (the chunk is the run's). How it differs from the
 * run is worked out here, where the provider is at hand, and stored.
 */
export function newTakeConfig(args: { run: VoiceRunConfig; base: 'RUN' | 'PRODUCTION'; production?: { version: ProfileRow; overrides: VoiceConfigOverrides }; override: VoiceTakeOverride | null }, provider: ConfigProvider): VoiceTakeConfig {
  const override = isEmptyOverride(args.override) ? null : args.override;
  const take: ConfigLayer[] = override ? [{ source: 'TAKE', overrides: override }] : [];
  let effective: EffectiveVoiceConfig;
  let provenance: ConfigProvenance;
  let profile: VoiceProfileRef;
  if (args.base === 'PRODUCTION') {
    if (!args.production) throw new Error('newTakeConfig: a PRODUCTION take needs the production profile');
    const { version, overrides } = args.production;
    const project: ConfigLayer[] = isEmptyOverride(overrides) ? [] : [{ source: 'PROJECT', overrides }];
    ({ effective, provenance } = effectiveConfig(version, [...project, ...take], provider));
    const own = versionFields(version, provider).chunking;
    effective.chunking = { ...args.run.effective.chunking };
    delete provenance.chunking;
    if (!same(effective.chunking, own)) provenance.chunking = 'RUN';
    profile = profileRef(version);
  } else {
    ({ effective, provenance } = overlay(args.run.effective, args.run.provenance, take));
    profile = args.run.profile;
  }
  // What is heard: the provider settings each model is sent (a setting the model does not take changes nothing heard; it is still listed in `differs`).
  const heard = (c: EffectiveVoiceConfig): EffectiveVoiceConfig => ({ ...c, providerSettings: sentOf(c, provider).sent });
  return {
    reconstructed: false,
    base: args.base,
    override,
    profile,
    effective,
    provenance,
    differs: configDifferences(args.run.effective, effective, 'RUN'),
    identityDiffers: voiceIdentityDiffers(heard(args.run.effective), heard(effective)),
  };
}

// ── Differences and descriptions ─────────────────────────────────────────────

const RULE_WORDS: Record<string, string> = {
  maxMarksPerChunk: 'directions per chunk',
  minWordsBetweenMarks: 'words between directions',
  directorWordsPerMark: "director's words per direction",
  resetWord: 'reset word',
  'emotionWords.REFLECTIVE': 'word for reflective',
  'emotionWords.CURIOUS': 'word for curious',
  'emotionWords.TENSE': 'word for tense',
  'emotionWords.SOMBER': 'word for somber',
  'emotionWords.EXCITED': 'word for excited',
  'deliveryWords.lowEnergy': 'word for low energy',
  'deliveryWords.slowPace': 'word for slow pace',
  'deliveryWords.highEnergy': 'word for high energy',
  'deliveryWords.fastPace': 'word for fast pace',
  'paceSpeed.SLOW': 'slow pace speed',
  'paceSpeed.FAST': 'fast pace speed',
};

const shown = (v: unknown): string => (v === null || v === undefined ? 'none' : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));
const chunkingText = (c: ChunkingSettings) => `${c.minWords}–${c.maxWords} words`;
/** "previous 200 / next 120 chars", "none", "stitched". */
export const contextText = (c: ContextSettings): string => [c.previousChars || c.nextChars ? `previous ${c.previousChars} / next ${c.nextChars} chars` : c.stitch ? '' : 'none', c.stitch ? 'stitched' : ''].filter(Boolean).join(', ');
const rulesText = (r: VoiceProfileConfig['pronunciation']['rules']) => (r.length ? r.map((x) => `${x.term} (${x.method.toLowerCase()} ${x.pronunciation})`).join(', ') : 'none');

/** Every rule as a flat path → value ("paceSpeed.SLOW" → 0.94). */
function flatRules(r: Partial<PerformanceRules>): [string, unknown][] {
  return Object.entries(r).flatMap(([key, value]) => (value && typeof value === 'object' ? Object.entries(value).map(([k, v]) => [`${key}.${k}`, v] as [string, unknown]) : [[key, value] as [string, unknown]]));
}

/** What differs between two configurations, b against a: a label and both values. */
export function configChanges(a: EffectiveVoiceConfig, b: EffectiveVoiceConfig): { label: string; before: string; after: string }[] {
  const out: { label: string; before: string; after: string }[] = [];
  const add = (label: string, before: string, after: string) => {
    if (before !== after) out.push({ label, before, after });
  };
  add('provider', a.provider, b.provider);
  add('voice', a.voiceId, b.voiceId);
  add('model', a.model, b.model);
  add('language', a.language, b.language);
  add('output format', a.outputFormat, b.outputFormat);
  add('performance', a.strategy.toLowerCase(), b.strategy.toLowerCase());
  add('chunk size', chunkingText(a.chunking), chunkingText(b.chunking));
  add('context', contextText(a.context), contextText(b.context));
  add('number style', a.numberStyle, b.numberStyle);
  if (!same(a.pronunciation.rules, b.pronunciation.rules)) out.push({ label: 'pronunciation rules', before: rulesText(a.pronunciation.rules), after: rulesText(b.pronunciation.rules) });
  const before = new Map(flatRules(a.performanceRules));
  for (const [path, value] of flatRules(b.performanceRules)) add(RULE_WORDS[path] ?? path, shown(before.get(path)), shown(value));
  for (const key of [...new Set([...Object.keys(a.providerSettings), ...Object.keys(b.providerSettings)])]) add(key, shown(a.providerSettings[key]), shown(b.providerSettings[key]));
  return out;
}

/**
 * Readable differences, b against a: "performance: expressive (was
 * restrained)"; a take against its run: "stability: 0.3 (run: 0.5)"; a
 * version against the one before it: "performance: restrained → expressive".
 * Empty when equal.
 */
export function configDifferences(a: EffectiveVoiceConfig, b: EffectiveVoiceConfig, form: 'WAS' | 'RUN' | 'ARROW' = 'WAS'): string[] {
  return configChanges(a, b).map((c) => (form === 'ARROW' ? `${c.label}: ${c.before} → ${c.after}` : `${c.label}: ${c.after} (${form === 'RUN' ? 'run: ' : 'was '}${c.before})`));
}

/** The settings that decide what the voice sounds like differ: provider, voice, model, language, output format, provider settings, number style or pronunciation rules. */
export function voiceIdentityDiffers(a: EffectiveVoiceConfig, b: EffectiveVoiceConfig): boolean {
  const identity = (c: EffectiveVoiceConfig) => [c.provider, c.voiceId, c.model, c.language, c.outputFormat, c.providerSettings, c.numberStyle, c.pronunciation.rules];
  return !same(identity(a), identity(b));
}

/** "performance expressive, stability 0.3, context none" (logs, events, labels); "none" when nothing is set. */
export function describeOverrides(o: VoiceConfigOverrides | null | undefined): string {
  if (!o) return 'none';
  const parts: string[] = [];
  if (o.strategy) parts.push(`performance ${o.strategy.toLowerCase()}`);
  if (o.chunking) parts.push(`chunk size ${chunkingText(o.chunking)}`);
  if (o.context) parts.push(`context ${contextText(o.context)}`);
  if (o.numberStyle) parts.push(`number style ${o.numberStyle}`);
  for (const [path, value] of flatRules(o.performanceRules ?? {})) parts.push(`${RULE_WORDS[path] ?? path} ${shown(value)}`);
  for (const [key, value] of Object.entries(o.providerSettings ?? {})) parts.push(`${key} ${shown(value)}`);
  return parts.join(', ') || 'none';
}

/** Where a take's configuration came from, in a few words ("production profile", "temporary override", "run configuration"). */
export const takeSource = (c: Pick<VoiceTakeConfig, 'base' | 'override'>): 'run configuration' | 'production profile' | 'temporary override' => (c.override ? 'temporary override' : c.base === 'PRODUCTION' ? 'production profile' : 'run configuration');
