import {
  CONFIG_SOURCE_LABELS,
  DEFAULT_MASTER_LANGUAGE,
  PERFORMANCE_RULE_LABELS,
  PERFORMANCE_STRATEGIES,
  PERFORMANCE_STRATEGY_HELP,
  PERFORMANCE_STRATEGY_LABELS,
  PRONUNCIATION_METHOD_LABELS,
  VoiceProfileFieldsInput,
  type ChunkingSettings,
  type ConfigProvenance,
  type ConfigSource,
  type ContextSettings,
  type EffectiveVoiceConfig,
  type PerformanceRules,
  type PerformanceStrategy,
  type PronunciationConfig,
  type ProviderSettingValues,
  type VoiceConfigOverrides,
  type VoiceProductionView,
  type VoiceProfileFamilyView,
  type VoiceProfileHistoryView,
  type VoiceProfileLibraryView,
  type VoiceProfileView,
  type VoiceSettingDescriptor,
  type VoiceSettingValue,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api.ts';
import { CHUNK_SIZES, configRows, contextLabel, describeOverrides, isEmptyOverrides, notSentTo, overrideProblems, settingProblem, sizeLabel, type EditedOverrides } from '../voice-plan.ts';

/**
 * Saved voice profiles in the dashboard: the profile form (its provider
 * settings built from the provider's own descriptions), a project's or a
 * take's overrides, a configuration with where each setting came from, and
 * "save this run's configuration as a voice profile". The Voice page and the
 * profile library both build on these, and on the shared styles and request
 * hook below (components/voice.tsx re-exports them).
 */

export const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
export const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
export const secondary = `${button} bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50`;
/** A text-styled button that is still at least 24 px tall to tap. */
export const link = 'inline-flex min-h-6 items-center text-xs text-stone-600 underline disabled:cursor-not-allowed disabled:opacity-40';
const input = 'mt-1 w-full rounded-md border border-stone-300 px-2 py-1 disabled:bg-stone-50';

/** Invalidate the voice views, the profile library and the project after a change. */
export function useVoiceRequest<T, R = unknown>(fn: (arg: T) => Promise<R>, onDone?: (result: R) => void) {
  const queryClient = useQueryClient();
  return useMutation<R, Error, T>({
    mutationFn: fn,
    onSuccess: (result) => onDone?.(result),
    onSettled: () => {
      for (const key of ['voice', 'voice-profiles', 'voice-profile', 'project']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** A refusal because what was shown changed elsewhere (409): the page must be read again. */
export const isConflict = (e: Error | null) => e instanceof ApiError && e.status === 409;

// ── A configuration and where each setting came from ─────────────────────────

const SOURCE_TONE: Record<ConfigSource, string> = {
  PROFILE: 'bg-stone-100 text-stone-600',
  PROJECT: 'bg-sky-100 text-sky-800',
  RUN: 'bg-violet-100 text-violet-800',
  TAKE: 'bg-amber-100 text-amber-900',
};

export function SourceChip({ source }: { source: ConfigSource }) {
  return (
    <span className={`${pill} ${SOURCE_TONE[source]}`} data-source={source}>
      {CONFIG_SOURCE_LABELS[source]}
    </span>
  );
}

/** Every setting of a configuration, its value, a chip for where it came from, and "not sent to {model}" for provider settings the model does not take. */
export function ConfigTable({ config, provenance, settings, ignored }: { config: EffectiveVoiceConfig; provenance: ConfigProvenance; settings: readonly VoiceSettingDescriptor[]; ignored?: readonly string[] }) {
  return (
    <dl className="divide-y divide-stone-100 text-sm" data-config>
      {configRows(config, provenance, settings, ignored).map((r) => (
        <div key={r.path} className="grid grid-cols-1 gap-x-3 py-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]" data-config-row={r.path}>
          <dt className="text-xs text-stone-500 sm:text-sm">{r.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-stone-900">
            <span className={r.path === 'voiceId' ? 'break-all' : 'break-words'}>{r.value}</span>
            <SourceChip source={r.source} />
            {r.note && <span className="text-xs text-amber-800">{r.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Provider settings, from the provider's descriptions ──────────────────────

/** One provider setting as its descriptor says: a number (slider and field), a flag, or a choice (unset: its default shown); its help, and whether the model is sent it. */
export function SettingInput({ setting: d, value, onChange, model, disabled = false }: { setting: VoiceSettingDescriptor; value: VoiceSettingValue | undefined; onChange: (v: VoiceSettingValue) => void; model: string | null; disabled?: boolean }) {
  const id = useId();
  const problem = settingProblem(d, value);
  const off = model !== null && notSentTo(d, model);
  const number = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return (
    <div className="min-w-0 text-sm" data-setting={d.key}>
      <label htmlFor={id} className="block text-xs text-stone-500">
        {d.label}
      </label>
      {d.kind === 'NUMBER' ? (
        <div className="mt-1 flex items-center gap-2">
          <input type="range" min={d.min} max={d.max} step={d.step ?? 'any'} value={number ?? Number(d.default)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${d.label} (slider)`} className="min-w-0 flex-1" />
          <input id={id} type="number" min={d.min} max={d.max} step={d.step ?? 'any'} value={number ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} className="w-24 rounded-md border border-stone-300 px-2 py-1 disabled:bg-stone-50" />
        </div>
      ) : d.kind === 'BOOLEAN' ? (
        <label className="mt-1 inline-flex min-h-6 items-center gap-2 text-stone-700">
          <input id={id} type="checkbox" checked={value === undefined ? d.default === true : value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> On
        </label>
      ) : (
        <select id={id} value={typeof value === 'string' ? value : String(d.default)} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={input}>
          {(d.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <span className="mt-1 block text-xs text-stone-500">{d.help}</span>
      {off && <span className="block text-xs text-amber-800">not sent to {model}</span>}
      {problem && <span className="block text-xs text-red-700">{problem}</span>}
    </div>
  );
}

/** The provider's settings as a form, built from its descriptors (the dashboard knows no provider's keys). */
export function ProviderSettingsForm({ settings, values, onChange, model, disabled = false }: { settings: readonly VoiceSettingDescriptor[]; values: ProviderSettingValues; onChange: (v: ProviderSettingValues) => void; model: string; disabled?: boolean }) {
  if (!settings.length) return <p className="text-xs text-stone-500">The voice provider describes no settings.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {settings.map((d) => (
        <SettingInput key={d.key} setting={d} value={values[d.key]} onChange={(v) => onChange({ ...values, [d.key]: v })} model={model} disabled={disabled} />
      ))}
    </div>
  );
}

// ── Pieces of the profile form ───────────────────────────────────────────────

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block min-w-0 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

function StrategySelect({ value, onChange, label = 'Performance', disabled = false }: { value: PerformanceStrategy; onChange: (s: PerformanceStrategy) => void; label?: string; disabled?: boolean }) {
  return (
    <Field label={label}>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as PerformanceStrategy)} className={input}>
        {PERFORMANCE_STRATEGIES.map((s) => (
          <option key={s} value={s}>
            {PERFORMANCE_STRATEGY_LABELS[s]}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-stone-500">{PERFORMANCE_STRATEGY_HELP[value]}</span>
    </Field>
  );
}

/** Chunk size in spoken words, with the presets in seconds. */
export function ChunkingFields({ value, onChange, disabled = false }: { value: ChunkingSettings; onChange: (c: ChunkingSettings) => void; disabled?: boolean }) {
  return (
    <fieldset className="min-w-0 text-sm" disabled={disabled}>
      <legend className="text-xs text-stone-500">Chunk size in spoken words</legend>
      <div className="mt-1 flex items-center gap-2">
        <input type="number" min={5} max={200} value={value.minWords} onChange={(e) => onChange({ ...value, minWords: Number(e.target.value) })} aria-label="Fewest words in a chunk" className="w-20 rounded-md border border-stone-300 px-2 py-1" />
        <span className="text-stone-500">to</span>
        <input type="number" min={10} max={300} value={value.maxWords} onChange={(e) => onChange({ ...value, maxWords: Number(e.target.value) })} aria-label="Most words in a chunk" className="w-20 rounded-md border border-stone-300 px-2 py-1" />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3">
        {CHUNK_SIZES.map((s) => (
          <button key={s.label} type="button" aria-pressed={value.minWords === s.chunking.minWords && value.maxWords === s.chunking.maxWords} onClick={() => onChange(s.chunking)} className={link}>
            {s.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Neighbouring narration sent as context, and stitching. */
export function ContextFields({ value, onChange, disabled = false }: { value: ContextSettings; onChange: (c: ContextSettings) => void; disabled?: boolean }) {
  return (
    <fieldset className="min-w-0 text-sm" disabled={disabled}>
      <legend className="text-xs text-stone-500">Continuity: neighbouring narration sent as context (characters before / after; never generated)</legend>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input type="number" min={0} max={1000} value={value.previousChars} onChange={(e) => onChange({ ...value, previousChars: Number(e.target.value) })} aria-label="Characters of the previous text" className="w-24 rounded-md border border-stone-300 px-2 py-1" />
        <input type="number" min={0} max={1000} value={value.nextChars} onChange={(e) => onChange({ ...value, nextChars: Number(e.target.value) })} aria-label="Characters of the next text" className="w-24 rounded-md border border-stone-300 px-2 py-1" />
        <label className="inline-flex min-h-6 items-center gap-1 text-xs text-stone-600">
          <input type="checkbox" checked={value.stitch} onChange={(e) => onChange({ ...value, stitch: e.target.checked })} /> Stitch to the previous take (takes one after another)
        </label>
      </div>
    </fieldset>
  );
}

function NumberStyleSelect({ value, onChange, disabled = false }: { value: 'UK' | 'US'; onChange: (v: 'UK' | 'US') => void; disabled?: boolean }) {
  return (
    <Field label="Number style">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as 'UK' | 'US')} className={input}>
        <option value="UK">UK: “one hundred and twenty”</option>
        <option value="US">US: “one hundred twenty”</option>
      </select>
    </Field>
  );
}

type ProfileRule = PronunciationConfig['rules'][number];
const RULE_METHODS = ['ALIAS', 'IPA', 'CMU'] as const;

/** The profile's own pronunciation rules (rows); the project's approved list always applies too. */
export function PronunciationRulesEditor({ rules, onChange, disabled = false }: { rules: ProfileRule[]; onChange: (r: ProfileRule[]) => void; disabled?: boolean }) {
  const set = (i: number, r: Partial<ProfileRule>) => onChange(rules.map((x, j) => (j === i ? { ...x, ...r } : x)));
  return (
    <fieldset className="min-w-0 space-y-2 text-sm" disabled={disabled}>
      <legend className="text-xs text-stone-500">Pronunciation rules of this voice</legend>
      <p className="text-xs text-stone-500">The project's approved pronunciations always apply and win for a term they cover; these are the voice's own (a word it is known to misread).</p>
      {rules.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,1fr)_auto]" data-rule={i + 1}>
          <input value={r.term} onChange={(e) => set(i, { term: e.target.value })} placeholder="Haarlem" aria-label={`Term ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1" />
          <select value={r.method} onChange={(e) => set(i, { method: e.target.value as ProfileRule['method'] })} aria-label={`How term ${i + 1} is given`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1">
            {RULE_METHODS.map((m) => (
              <option key={m} value={m}>
                {PRONUNCIATION_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
          <input value={r.pronunciation} onChange={(e) => set(i, { pronunciation: e.target.value })} placeholder={r.method === 'ALIAS' ? 'Harlem' : r.method === 'IPA' ? 'ˈɦaːrlɛm' : 'HH AA1 R L EH0 M'} aria-label={`Pronunciation ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 font-mono" />
          <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className={link}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, { term: '', method: 'ALIAS', pronunciation: '' }])} className={link}>
        Add a rule
      </button>
    </fieldset>
  );
}

const WORD = 'w-full min-w-0 rounded-md border border-stone-300 px-2 py-1';

/** The house style's limits (numbers) and words (folded): what a profile tunes of the performance. */
export function PerformanceRulesEditor({ rules, onChange, disabled = false }: { rules: PerformanceRules; onChange: (r: PerformanceRules) => void; disabled?: boolean }) {
  const num = (key: 'maxMarksPerChunk' | 'minWordsBetweenMarks' | 'directorWordsPerMark', min: number, max: number) => (
    <Field label={PERFORMANCE_RULE_LABELS[key]}>
      <input type="number" min={min} max={max} value={rules[key]} onChange={(e) => onChange({ ...rules, [key]: Number(e.target.value) })} className={input} />
    </Field>
  );
  return (
    <fieldset className="min-w-0 space-y-3 text-sm" disabled={disabled}>
      <legend className="text-xs text-stone-500">Performance rules</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {num('maxMarksPerChunk', 0, 6)}
        {num('minWordsBetweenMarks', 0, 40)}
        {num('directorWordsPerMark', 1, 100)}
        <Field label={`${PERFORMANCE_RULE_LABELS.paceSpeed}: slow`}>
          <input type="number" min={0.7} max={1} step={0.01} value={rules.paceSpeed.SLOW} onChange={(e) => onChange({ ...rules, paceSpeed: { ...rules.paceSpeed, SLOW: Number(e.target.value) } })} className={input} />
        </Field>
        <Field label={`${PERFORMANCE_RULE_LABELS.paceSpeed}: fast`}>
          <input type="number" min={1} max={1.3} step={0.01} value={rules.paceSpeed.FAST} onChange={(e) => onChange({ ...rules, paceSpeed: { ...rules.paceSpeed, FAST: Number(e.target.value) } })} className={input} />
        </Field>
      </div>
      <details>
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">The words of the house style</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {(Object.keys(rules.emotionWords) as (keyof PerformanceRules['emotionWords'])[]).map((k) => (
            <Field key={k} label={`Feeling ${k.toLowerCase()} (empty: no direction)`}>
              <input value={rules.emotionWords[k] ?? ''} onChange={(e) => onChange({ ...rules, emotionWords: { ...rules.emotionWords, [k]: e.target.value.trim() ? e.target.value : null } })} className={`mt-1 ${WORD}`} />
            </Field>
          ))}
          {(Object.keys(rules.deliveryWords) as (keyof PerformanceRules['deliveryWords'])[]).map((k) => (
            <Field key={k} label={`Manner: ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`}>
              <input value={rules.deliveryWords[k]} onChange={(e) => onChange({ ...rules, deliveryWords: { ...rules.deliveryWords, [k]: e.target.value } })} className={`mt-1 ${WORD}`} />
            </Field>
          ))}
          <Field label={PERFORMANCE_RULE_LABELS.resetWord}>
            <input value={rules.resetWord} onChange={(e) => onChange({ ...rules, resetWord: e.target.value })} className={`mt-1 ${WORD}`} />
          </Field>
        </div>
      </details>
    </fieldset>
  );
}

// ── The profile form ─────────────────────────────────────────────────────────

export type ProfileFormMode = 'new' | 'edit' | 'duplicate';

/** Profiles of another provider are kept and listed, but not usable or editable while it is not the configured one. */
export const otherProvider = (provider: string | null, configured: string) => (provider && provider !== configured ? `for ${provider}: not usable while ${configured} is the voice provider` : null);

/**
 * A profile version's whole configuration as a form: a new profile (from the
 * house default and the provider's defaults), an edit (always a new version,
 * from the current version or an older one), or a duplicate (a new profile
 * from any version; another language allowed).
 */
export function ProfileForm({
  library,
  mode,
  family,
  base,
  onSaved,
  onCancel,
}: {
  library: Pick<VoiceProfileLibraryView, 'provider' | 'settings' | 'defaults'>;
  mode: ProfileFormMode;
  /** The profile edited or duplicated (null for a new one). */
  family: VoiceProfileFamilyView | null;
  /** The version the form starts from (null: the house default). */
  base: VoiceProfileView | null;
  onSaved: (profile: VoiceProfileHistoryView) => void;
  onCancel: () => void;
}) {
  const start = base?.config ?? library.defaults;
  const voices = useQuery({ queryKey: ['voice-voices'], queryFn: api.voices, staleTime: 300_000 });
  const [name, setName] = useState(mode === 'duplicate' && family ? `${family.name} copy` : '');
  const [description, setDescription] = useState(mode === 'duplicate' ? (family?.description ?? '') : '');
  const [voiceId, setVoiceId] = useState(base?.voiceId ?? library.provider.defaultVoiceId ?? '');
  const [modelId, setModelId] = useState(base?.modelId ?? library.provider.defaultModel);
  const [language, setLanguage] = useState(base?.language ?? DEFAULT_MASTER_LANGUAGE);
  const [outputFormat, setOutputFormat] = useState(base?.outputFormat ?? library.provider.defaultOutputFormat);
  const [strategy, setStrategy] = useState(start.strategy);
  const [chunking, setChunking] = useState(start.chunking);
  const [context, setContext] = useState(start.context);
  const [numberStyle, setNumberStyle] = useState(start.numberStyle);
  const [rules, setRules] = useState(start.pronunciation.rules);
  const [performanceRules, setPerformanceRules] = useState(start.performanceRules);
  const [settings, setSettings] = useState<ProviderSettingValues>(start.providerSettings);
  const [notes, setNotes] = useState('');
  const readOnly = otherProvider(base?.provider ?? null, library.provider.name);
  const ids = useId();
  // The current version the edit was opened against: a version saved since (in another tab) refuses the save until the editor has seen it.
  const [expected, setExpected] = useState(family?.current?.id ?? null);
  const since = mode === 'edit' && family?.current && expected && family.current.id !== expected ? family.current : null;
  const fields = { voiceId, modelId, outputFormat, strategy, chunking, context, numberStyle, pronunciation: { rules }, performanceRules, providerSettings: settings };
  const parsed = mode === 'edit' ? VoiceProfileFieldsInput.omit({ language: true }).safeParse(fields) : VoiceProfileFieldsInput.safeParse({ ...fields, language });
  const problems = [
    ...(mode !== 'edit' && !name.trim() ? ['a name is needed'] : []),
    ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...library.settings.map((d) => settingProblem(d, settings[d.key])).filter((p): p is string => !!p),
  ];
  const save = useVoiceRequest(async (expectedCurrent: string | null) => {
    if (!parsed.success) throw new Error(problems.join('; '));
    const more = { ...(description.trim() ? { description: description.trim() } : {}) };
    if (mode === 'new') return api.createVoiceProfileFamily({ name: name.trim(), ...more, fields: parsed.data, ...(notes.trim() ? { notes: notes.trim() } : {}) });
    if (mode === 'duplicate') return api.duplicateVoiceProfile(family!.id, { name: name.trim(), ...more, ...(base ? { fromVersionId: base.id } : {}), fields: parsed.data });
    return api.newVoiceProfileVersion(family!.id, { ...(base ? { basedOn: base.id } : {}), ...(expectedCurrent ? { expectedCurrent } : {}), fields: parsed.data, ...(notes.trim() ? { notes: notes.trim() } : {}) });
  }, onSaved);
  const following = family?.usedBy.filter((u) => u.mode === 'FOLLOW').length ?? 0;
  const next = (family?.current?.version ?? base?.version ?? 0) + 1;
  const voiceName = voices.data?.find((x) => x.id === voiceId)?.name;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly && !problems.length && !since) save.mutate(expected);
      }}
      data-profile-form={mode}
    >
      {readOnly && <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">This profile is {readOnly}: shown as it is, not editable here.</p>}
      <fieldset disabled={!!readOnly} className="min-w-0 space-y-4">
        {mode !== 'edit' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={input} />
            </Field>
            <Field label="Description (optional)">
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} className={input} />
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Voice id">
            <input value={voiceId} onChange={(e) => setVoiceId(e.target.value)} list={`${ids}-voices`} className={`${input} font-mono`} />
            <datalist id={`${ids}-voices`}>
              {(voices.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </datalist>
            <span className="mt-1 block text-xs break-all text-stone-500">{voiceName ?? (voices.isError ? 'The provider’s voices could not be listed: type a voice id.' : 'Choose one of the provider’s voices, or type a voice id.')}</span>
          </Field>
          <Field label="Model">
            <input value={modelId} onChange={(e) => setModelId(e.target.value)} list={`${ids}-models`} className={`${input} font-mono`} />
            <datalist id={`${ids}-models`}>
              {library.provider.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          {mode !== 'edit' ? (
            <Field label="Language">
              <input value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={10} className={input} />
            </Field>
          ) : (
            <p className="text-sm">
              <span className="block text-xs text-stone-500">Language</span>
              {language} <span className="text-xs text-stone-500">(another language is a duplicate)</span>
            </p>
          )}
          <Field label="Output format">
            <input value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} className={`${input} font-mono`} />
            <span className="mt-1 block text-xs text-stone-500">mp3_*, wav_* or pcm_* (e.g. mp3_44100_128): what can be measured and joined.</span>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <StrategySelect value={strategy} onChange={setStrategy} />
          <NumberStyleSelect value={numberStyle} onChange={setNumberStyle} />
          <ChunkingFields value={chunking} onChange={setChunking} />
          <ContextFields value={context} onChange={setContext} />
        </div>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-xs text-stone-500">Voice settings of {library.provider.name} (as the provider describes them)</legend>
          <ProviderSettingsForm settings={library.settings} values={settings} onChange={setSettings} model={modelId} />
        </fieldset>
        <PronunciationRulesEditor rules={rules} onChange={setRules} />
        <PerformanceRulesEditor rules={performanceRules} onChange={setPerformanceRules} />
        {mode !== 'duplicate' && (
          <Field label="Notes on this version (optional)" wide>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className={input} />
          </Field>
        )}
      </fieldset>
      {mode === 'edit' && family && (
        <p className="text-xs text-stone-600" data-edit-note>
          Saves v{next}
          {base && family.current && base.id !== family.current.id ? ` from v${base.version} (the current version is v${family.current.version})` : ''}. {following} project{following === 1 ? '' : 's'} follow{following === 1 ? 's' : ''} this profile: their next runs use the new version; runs already made keep theirs.
        </p>
      )}
      {since && (
        <div className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900" data-edit-since>
          <p>
            v{since.version} was saved since this form opened (see the history). Your changes are still here: saving them makes v{since.version + 1} with what this form shows, over what v{since.version} changed.
          </p>
          <button
            type="button"
            disabled={save.isPending || problems.length > 0}
            onClick={() => {
              setExpected(since.id);
              save.mutate(since.id);
            }}
            className={`${button} bg-amber-700 text-white hover:bg-amber-800`}
          >
            Save v{since.version + 1} anyway
          </button>
        </div>
      )}
      {problems.length > 0 && !readOnly && <p className="text-xs text-red-700">To fix: {problems.join('; ')}</p>}
      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <button type="submit" disabled={save.isPending || problems.length > 0 || !!since} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
            {mode === 'new' ? 'Create the profile' : mode === 'duplicate' ? 'Create the copy' : `Save v${next}`}
          </button>
        )}
        <button type="button" onClick={onCancel} className={secondary}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
      </div>
      {save.error && <p className="text-sm text-red-700">{save.error.message}</p>}
    </form>
  );
}

// ── Overrides ────────────────────────────────────────────────────────────────

/** What an overrides editor offers: whole settings, the main performance rules, and the provider's overridable settings. */
export type OverrideField = 'strategy' | 'chunking' | 'context' | 'numberStyle' | 'rules' | 'settings';
type MainRule = 'maxMarksPerChunk' | 'minWordsBetweenMarks' | 'resetWord';
const MAIN_RULES: MainRule[] = ['maxMarksPerChunk', 'minWordsBetweenMarks', 'resetWord'];

const SCOPE_WORDS = {
  PROJECT: { toggle: 'Override for this project', base: 'profile' },
  RUN: { toggle: 'Set for this run', base: 'profile' },
  TAKE: { toggle: 'Override for this take', base: 'run' },
} as const;

function OverrideRow({ id, label, on, onToggle, shown, scope, children }: { id: string; label: string; on: boolean; onToggle: (on: boolean) => void; shown: string; scope: keyof typeof SCOPE_WORDS; children: ReactNode }) {
  const words = SCOPE_WORDS[scope];
  return (
    <div className={`min-w-0 rounded-md border p-2 ${on ? 'border-sky-300 bg-sky-50/40' : 'border-stone-200'}`} data-override={id}>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <span className="text-sm text-stone-800">{label}</span>
        <label className="inline-flex min-h-6 items-center gap-1 text-xs text-stone-600">
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} aria-label={`${words.toggle}: ${label}`} /> {words.toggle}
        </label>
      </div>
      {on ? <div className="mt-1">{children}</div> : <p className="text-xs break-words text-stone-500">{`${words.base}: ${shown}`}</p>}
    </div>
  );
}

/**
 * Settings set over a configuration without changing it: for a project (its
 * production profile), a run, or a take. Each row is ticked to override it;
 * an unticked row shows what applies and sends nothing. Provider settings
 * only where the provider lets them be overridden.
 */
export function OverridesEditor({
  base,
  value,
  onChange,
  settings,
  scope,
  fields,
}: {
  /** What the overrides are laid over (shown where a row is not overridden). */
  base: EffectiveVoiceConfig;
  value: EditedOverrides;
  onChange: (o: EditedOverrides) => void;
  settings: readonly VoiceSettingDescriptor[];
  scope: 'PROJECT' | 'RUN' | 'TAKE';
  fields: readonly OverrideField[];
}) {
  const has = (f: OverrideField) => fields.includes(f) && (f !== 'chunking' || scope !== 'TAKE');
  const set = <K extends keyof EditedOverrides>(key: K, v: EditedOverrides[K] | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const setRule = <K extends MainRule>(key: K, v: PerformanceRules[K] | undefined) => {
    const rules = { ...value.performanceRules };
    if (v === undefined) delete rules[key];
    else rules[key] = v;
    set('performanceRules', Object.keys(rules).length ? rules : undefined);
  };
  const setSetting = (key: string, v: VoiceSettingValue | undefined) => {
    const s = { ...value.providerSettings };
    if (v === undefined) delete s[key];
    else s[key] = v;
    set('providerSettings', Object.keys(s).length ? s : undefined);
  };
  const problems = overrideProblems(value, settings, scope);
  return (
    <div className="space-y-2" data-overrides={scope}>
      <div className="grid gap-2 sm:grid-cols-2">
        {has('strategy') && (
          <OverrideRow id="strategy" label="Performance" scope={scope} on={value.strategy !== undefined} onToggle={(on) => set('strategy', on ? base.strategy : undefined)} shown={PERFORMANCE_STRATEGY_LABELS[base.strategy]}>
            {value.strategy && <StrategySelect label="Performance" value={value.strategy} onChange={(s) => set('strategy', s)} />}
          </OverrideRow>
        )}
        {has('chunking') && (
          <OverrideRow id="chunking" label="Chunk size" scope={scope} on={value.chunking !== undefined} onToggle={(on) => set('chunking', on ? base.chunking : undefined)} shown={sizeLabel(base.chunking)}>
            {value.chunking && <ChunkingFields value={value.chunking} onChange={(c) => set('chunking', c)} />}
          </OverrideRow>
        )}
        {has('context') && (
          <OverrideRow id="context" label="Continuity" scope={scope} on={value.context !== undefined} onToggle={(on) => set('context', on ? base.context : undefined)} shown={contextLabel(base.context)}>
            {value.context && <ContextFields value={value.context} onChange={(c) => set('context', c)} />}
          </OverrideRow>
        )}
        {has('numberStyle') && (
          <OverrideRow id="numberStyle" label="Number style" scope={scope} on={value.numberStyle !== undefined} onToggle={(on) => set('numberStyle', on ? base.numberStyle : undefined)} shown={base.numberStyle}>
            {value.numberStyle && <NumberStyleSelect value={value.numberStyle} onChange={(v) => set('numberStyle', v)} />}
          </OverrideRow>
        )}
        {has('rules') &&
          MAIN_RULES.map((key) => {
            const v = value.performanceRules?.[key];
            return (
              <OverrideRow key={key} id={`performanceRules.${key}`} label={PERFORMANCE_RULE_LABELS[key]} scope={scope} on={v !== undefined} onToggle={(on) => setRule(key, on ? base.performanceRules[key] : undefined)} shown={String(base.performanceRules[key])}>
                {typeof v === 'number' ? (
                  <input type="number" min={0} max={key === 'maxMarksPerChunk' ? 6 : 40} value={v} onChange={(e) => setRule(key, Number(e.target.value) as PerformanceRules[typeof key])} aria-label={PERFORMANCE_RULE_LABELS[key]} className={input} />
                ) : typeof v === 'string' ? (
                  <input value={v} onChange={(e) => setRule(key, e.target.value as PerformanceRules[typeof key])} aria-label={PERFORMANCE_RULE_LABELS[key]} className={input} />
                ) : null}
              </OverrideRow>
            );
          })}
        {has('settings') &&
          settings
            .filter((d) => d.overridable)
            .map((d) => {
              const v = value.providerSettings?.[d.key];
              return (
                <OverrideRow key={d.key} id={`providerSettings.${d.key}`} label={d.label} scope={scope} on={v !== undefined} onToggle={(on) => setSetting(d.key, on ? (base.providerSettings[d.key] ?? d.default) : undefined)} shown={`${String(base.providerSettings[d.key] ?? d.default)}${notSentTo(d, base.model) ? ` (not sent to ${base.model})` : ''}`}>
                  <SettingInput setting={d} value={v} onChange={(x) => setSetting(d.key, x)} model={base.model} />
                </OverrideRow>
              );
            })}
      </div>
      {problems.length > 0 && <p className="text-xs text-red-700">To fix: {problems.join('; ')}</p>}
    </div>
  );
}

// ── Save a run's configuration as a profile ──────────────────────────────────

/**
 * "Save this run's configuration as a voice profile": a name (offered from
 * the project's title), then "Save profile" (a new profile, v1, with exactly
 * what the run — or the take — was made with), then "Use for this project".
 * Using it makes the project follow it and clears the project's overrides,
 * said before and shown after; nothing else changes.
 */
export function SaveAsProfile({ runId, generationId, projectId, production, defaultName, what = 'run' }: { runId: string; generationId?: string; projectId: string; production: VoiceProductionView; defaultName: string; what?: 'run' | 'take' }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [saved, setSaved] = useState<{ familyId: string; name: string; version: number } | null>(null);
  const [cleared, setCleared] = useState<VoiceConfigOverrides | null>(null);
  const save = useVoiceRequest(
    () => api.saveRunAsProfile(runId, { name: name.trim(), ...(generationId ? { generationId } : {}), ...(description.trim() ? { description: description.trim() } : {}) }),
    (r) => setSaved({ familyId: r.profile.id, name: r.profile.name, version: r.profile.current?.version ?? 1 }),
  );
  const use = useVoiceRequest(
    async (before: VoiceConfigOverrides) => {
      await api.setVoiceSelection(projectId, { familyId: saved!.familyId, versionId: null, overrides: {}, revision: production.revision });
      return before;
    },
    (before) => setCleared(isEmptyOverrides(before) ? null : before),
  );
  const inUse = !!saved && production.family?.id === saved.familyId && production.mode === 'FOLLOW';
  const label = what === 'take' ? "Save this take's configuration as a voice profile" : "Save this run's configuration as a voice profile";
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={link} data-save-profile={what}>
        {label}
      </button>
    );
  return (
    <div className="mt-1 min-w-0 space-y-2 rounded-md border border-stone-200 bg-stone-50 p-2 text-sm" data-save-profile={what}>
      {!saved ? (
        <>
          <p className="text-xs text-stone-600">A new saved profile (v1) with exactly what this {what} was made with. Nothing changes for the project until you use it.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Profile name">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={`${input} bg-white`} />
            </Field>
            <Field label="Description (optional)">
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} className={`${input} bg-white`} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={save.isPending || !name.trim()} onClick={() => save.mutate(undefined)} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
              Save profile
            </button>
            <button type="button" onClick={() => setOpen(false)} className={secondary}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-emerald-800">
              Saved {saved.name} v{saved.version}
            </span>
            <Link to={`/voice-profiles/${saved.familyId}`} className={link}>
              Open in the library
            </Link>
          </p>
          {inUse ? (
            <span className={`${pill} bg-emerald-100 text-emerald-800`}>In use for this project</span>
          ) : (
            <>
              {!isEmptyOverrides(production.overrides) && <p className="text-xs text-amber-900">Replaces this project's overrides ({describeOverrides(production.overrides)}): the project then narrates with exactly what was saved.</p>}
              <button type="button" disabled={use.isPending} onClick={() => use.mutate(production.overrides)} className={`${button} bg-sky-700 text-white hover:bg-sky-800`}>
                Use for this project
              </button>
            </>
          )}
          {cleared && <p className="text-xs text-stone-600">Project overrides cleared: {describeOverrides(cleared)}.</p>}
        </>
      )}
      {(save.error ?? use.error) && <p className="text-xs text-red-700">{(save.error ?? use.error)!.message}</p>}
    </div>
  );
}

