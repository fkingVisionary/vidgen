import {
  VISUAL_CONFIG_SOURCE_LABELS,
  VISUAL_SELECTION_MODE_LABELS,
  type ProductionMethod,
  type ProviderPreference,
  type VisualCatalogView,
  type VisualConfigOverrides,
  type VisualConfigProvenance,
  type VisualProductionView,
  type VisualProfileFamilyView,
  type VisualProfileHistoryView,
  type VisualProfileLibraryView,
  type VisualProfileView,
  type VisualStyleProfileConfig,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api.ts';
import {
  METHOD_CHOICES,
  VISUAL_FIELDS,
  configChanges,
  describeVisualOverrides,
  overridePaths,
  overridesFrom,
  productionText,
  sameSettings,
  shareOf,
  usdOf,
  valueAt,
  visualConfigRows,
  withValue,
  wordsOf,
  type VisualField,
} from '../storyboard-plan.ts';
import { useStoryboardRequest } from './storyboard.tsx';
import { input, link, pill, primary, secondary } from './ui.ts';

/**
 * Visual style profiles in the dashboard: a profile's settings as a table
 * (each marked where a project overrode it), the profile form (a new
 * profile, an edit — always a new version — or a duplicate), a project's
 * overrides, and a project's choice of profile. The library page and the
 * Storyboard page's header build on these. Profiles are provider-neutral:
 * provider and model preferences are free text checked against the
 * catalog, and the presets name none.
 */

/** A refusal because what was shown changed elsewhere (409): the form is kept until the page is read again. */
export const isConflict = (e: Error | null) => e instanceof ApiError && e.status === 409;

/** Read the library, a profile's history and the project's choice again (a refusal keeps the forms). */
function useVisualReload() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['visual-profiles', 'visual-profile', 'visual-selection', 'storyboard-inputs', 'storyboard']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

// ── A profile's settings ─────────────────────────────────────────────────────

/** Every setting of a profile, its value, and where it came from when a project overrode it. */
export function VisualConfigTable({ config, provenance = {} }: { config: VisualStyleProfileConfig; provenance?: VisualConfigProvenance }) {
  return (
    <dl className="divide-y divide-stone-100 text-sm" data-visual-config>
      {visualConfigRows(config, provenance).map((r) => (
        <div key={r.path} className="grid grid-cols-1 gap-x-3 py-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]" data-config-row={r.path}>
          <dt className="text-xs text-stone-500 sm:text-sm">{r.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-stone-900">
            <span className="min-w-0 break-words">{r.value}</span>
            {r.source === 'PROJECT' && <span className={`${pill} bg-sky-100 text-sky-800`}>{VISUAL_CONFIG_SOURCE_LABELS.PROJECT}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Inputs ───────────────────────────────────────────────────────────────────

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block min-w-0 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

/** Text that sets a value only when it reads as one (kept as typed meanwhile, with what is wrong). */
function TypedValue({ text: initial, parse, onValue, onBad, problem, label, inputMode }: { text: string; parse: (t: string) => unknown; onValue: (v: unknown) => void; onBad: (bad: boolean) => void; problem: string; label: string; inputMode?: 'decimal' }) {
  const [text, setText] = useState(initial);
  const bad = parse(text) === undefined;
  return (
    <>
      <input
        value={text}
        inputMode={inputMode}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          const v = parse(e.target.value);
          onBad(v === undefined);
          if (v !== undefined) onValue(v);
        }}
        className={input}
      />
      {bad && <span className="mt-1 block text-xs text-red-700">{problem}</span>}
    </>
  );
}

/** One setting as its kind is entered. */
function FieldInput({ field: f, value, onChange, onBad }: { field: VisualField; value: unknown; onChange: (v: unknown) => void; onBad: (bad: boolean) => void }) {
  switch (f.kind) {
    case 'choice':
      return (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label={f.label} className={input}>
          {f.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'flag':
      return (
        <span className="mt-1 flex min-h-6 items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} aria-label={f.label} /> {value === true ? 'yes' : 'no'}
        </span>
      );
    case 'long':
      return <textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} maxLength={1000} rows={2} aria-label={f.label} className={input} />;
    case 'words':
      return <TypedValue label={f.label} text={(value as string[]).join(', ')} parse={(t) => (wordsOf(t).length <= 8 && wordsOf(t).every((w) => w.length <= 60) ? wordsOf(t) : undefined)} onValue={onChange} onBad={onBad} problem="At most 8 items, each at most 60 characters" />;
    case 'share':
      return <TypedValue label={f.label} inputMode="decimal" text={String(Math.round((value as number) * 1000) / 10)} parse={shareOf} onValue={onChange} onBad={onBad} problem="A number from 0 to 100" />;
    case 'usd':
      return <TypedValue label={f.label} inputMode="decimal" text={value === null || value === undefined ? '' : String(value)} parse={usdOf} onValue={onChange} onBad={onBad} problem="Dollars (0 or more), or empty for no ceiling" />;
    default:
      return <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} maxLength={200} aria-label={f.label} className={input} />;
  }
}

type Rerolls = VisualStyleProfileConfig['generation']['rerolls'];
type Preferences = VisualStyleProfileConfig['providerPreferences'];

/** Reroll allowances per method, over the defaults (a person sets how many extra generations a forecast allows). */
function RerollRows({ value, onChange }: { value: Rerolls; onChange: (v: Rerolls) => void }) {
  const rows = Object.entries(value) as [ProductionMethod, number][];
  const set = (next: [ProductionMethod, number][]) => onChange(Object.fromEntries(next) as Rerolls);
  const free = METHOD_CHOICES.find((m) => !(m.value in value));
  return (
    <fieldset className="min-w-0 space-y-1" data-rerolls>
      <legend className="text-xs text-stone-500">Reroll allowances (extra generations a forecast allows, over the defaults)</legend>
      {rows.map(([method, n], i) => (
        <div key={method} className="flex flex-wrap items-center gap-1">
          <select value={method} onChange={(e) => set(rows.map((r, j) => (j === i ? [e.target.value as ProductionMethod, r[1]] : r)))} aria-label={`Reroll method ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
            {METHOD_CHOICES.filter((m) => m.value === method || !(m.value in value)).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <input type="number" min={0} max={10} step={0.1} value={n} onChange={(e) => set(rows.map((r, j) => (j === i ? [r[0], Math.min(10, Math.max(0, Number(e.target.value) || 0))] : r)))} aria-label={`Rerolls for ${method}`} className="w-20 rounded-md border border-stone-300 px-2 py-1 text-xs" />
          <button type="button" onClick={() => set(rows.filter((_, j) => j !== i))} className={link}>
            Remove
          </button>
        </div>
      ))}
      {free && (
        <button type="button" onClick={() => set([...rows, [free.value, 1]])} className={link}>
          Add a reroll allowance
        </button>
      )}
    </fieldset>
  );
}

/** Providers (and models) to recommend first for a method, in order: free text, checked against the catalog (an unknown one is only a warning). */
function PreferenceRows({ value, onChange, catalog }: { value: Preferences; onChange: (v: Preferences) => void; catalog: VisualCatalogView | null }) {
  const ids = useId();
  const rows = (Object.entries(value) as [ProductionMethod, ProviderPreference[]][]).flatMap(([method, list]) => list.map((p) => ({ method, provider: p.provider, model: p.model ?? '' })));
  const set = (next: typeof rows) => {
    const out: Preferences = {};
    for (const r of next) (out[r.method] ??= []).push({ provider: r.provider, ...(r.model.trim() ? { model: r.model.trim() } : {}) });
    onChange(out);
  };
  const providers = catalog?.cards.map((c) => c.provider) ?? [];
  const models = catalog?.cards.flatMap((c) => c.models.map((m) => m.model)) ?? [];
  return (
    <fieldset className="min-w-0 space-y-1" data-preferences>
      <legend className="text-xs text-stone-500">Provider preferences (recommended first for a method; the treatment still comes first, and nothing is generated now)</legend>
      <datalist id={`${ids}-providers`}>
        {providers.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id={`${ids}-models`}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="grid gap-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <select value={r.method} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, method: e.target.value as ProductionMethod } : x)))} aria-label={`Preference ${i + 1} method`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
            {METHOD_CHOICES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <input value={r.provider} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, provider: e.target.value } : x)))} list={`${ids}-providers`} maxLength={60} placeholder="Provider" aria-label={`Preference ${i + 1} provider`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
          <input value={r.model} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} list={`${ids}-models`} maxLength={100} placeholder="Model (optional)" aria-label={`Preference ${i + 1} model`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
          <button type="button" onClick={() => set(rows.filter((_, j) => j !== i))} className={link}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => set([...rows, { method: 'GENERATIVE_VIDEO', provider: '', model: '' }])} className={link}>
        Add a provider preference
      </button>
    </fieldset>
  );
}

/** Problems a form must clear before it saves: inputs that do not read, and preferences without a provider. */
function formProblems(bad: ReadonlySet<string>, prefs: Preferences | undefined): string[] {
  const empty = Object.values(prefs ?? {}).some((list) => list?.some((p) => !p.provider.trim()));
  return [...[...bad].map((p) => `${VISUAL_FIELDS.find((f) => f.path === p)?.label ?? p}: not a valid value`), ...(empty ? ['a provider preference needs a provider'] : [])];
}

// ── The profile form ─────────────────────────────────────────────────────────

export type VisualProfileFormMode = 'new' | 'edit' | 'duplicate';

/**
 * A profile version's settings as a form: a new profile (from the
 * defaults), an edit (always a new version, from the current version or an
 * older one), or a duplicate (a new profile from any version). Only what
 * changed is sent. An edit opened before another version was saved is
 * refused until the editor has seen it, then can be saved on purpose.
 */
export function VisualProfileForm({
  library,
  mode,
  family,
  base,
  catalog,
  onSaved,
  onCancel,
}: {
  library: Pick<VisualProfileLibraryView, 'defaults'>;
  mode: VisualProfileFormMode;
  /** The profile edited or duplicated (null for a new one). */
  family: VisualProfileFamilyView | null;
  /** The version the form starts from (null: the defaults). */
  base: VisualProfileView | null;
  catalog: VisualCatalogView | null;
  onSaved: (profile: VisualProfileHistoryView) => void;
  onCancel: () => void;
}) {
  const start = base?.config ?? library.defaults;
  const [config, setConfig] = useState<VisualStyleProfileConfig>(start);
  const [name, setName] = useState(mode === 'duplicate' && family ? `${family.name} copy` : '');
  const [description, setDescription] = useState(mode === 'duplicate' ? (family?.description ?? '') : '');
  const [notes, setNotes] = useState('');
  const [bad, setBad] = useState<Set<string>>(new Set());
  // The current version the edit was opened against: one saved since (in another tab) refuses the save until the editor has seen it.
  const [expected, setExpected] = useState(family?.current?.id ?? null);
  const since = mode === 'edit' && family?.current && expected && family.current.id !== expected ? family.current : null;
  const changes = configChanges(start, config);
  const problems = [...(mode !== 'edit' && !name.trim() ? ['a name is needed'] : []), ...formProblems(bad, config.providerPreferences), ...(mode === 'edit' && !Object.keys(changes).length ? ['nothing changed yet'] : [])];
  const reload = useVisualReload();
  const save = useMutation<VisualProfileHistoryView, Error, string | null>({
    mutationFn: (expectedCurrent) => {
      const more = description.trim() ? { description: description.trim() } : {};
      if (mode === 'new') return api.createVisualProfileFamily({ name: name.trim(), ...more, config: configChanges(library.defaults, config), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      if (mode === 'duplicate') return api.duplicateVisualProfile(family!.id, { name: name.trim(), ...more, ...(base ? { fromVersionId: base.id } : {}), config: changes });
      return api.newVisualProfileVersion(family!.id, { ...(base ? { basedOn: base.id } : {}), ...(expectedCurrent ? { expectedCurrent } : {}), config: changes, ...(notes.trim() ? { notes: notes.trim() } : {}) });
    },
    onSuccess: (h) => {
      reload();
      onSaved(h);
    },
    // A version saved since is read, so the form can say so; what the editor set stays.
    onError: (e) => {
      if (isConflict(e)) reload();
    },
  });
  const set = (path: string, v: unknown) => setConfig((c) => withValue(c, path, v));
  const flag = (path: string) => (isBad: boolean) =>
    setBad((b) => {
      const n = new Set(b);
      if (isBad) n.add(path);
      else n.delete(path);
      return n;
    });
  const next = (family?.current?.version ?? base?.version ?? 0) + 1;
  const following = family?.usedBy.filter((u) => u.mode === 'FOLLOW').length ?? 0;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problems.length && !since) save.mutate(expected);
      }}
      data-profile-form={mode}
    >
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
        {VISUAL_FIELDS.map((f) => (
          <Field key={f.path} label={f.label} wide={f.kind === 'long'}>
            <FieldInput field={f} value={valueAt(config, f.path)} onChange={(v) => set(f.path, v)} onBad={flag(f.path)} />
          </Field>
        ))}
      </div>
      <RerollRows value={config.generation.rerolls} onChange={(v) => set('generation.rerolls', v)} />
      <PreferenceRows value={config.providerPreferences} onChange={(v) => set('providerPreferences', v)} catalog={catalog} />
      {mode !== 'duplicate' && (
        <Field label="Notes on this version (optional)" wide>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className={input} />
        </Field>
      )}
      {mode === 'edit' && family && (
        <p className="text-xs text-stone-600" data-edit-note>
          Saves v{next}
          {base && family.current && base.id !== family.current.id ? ` from v${base.version} (the current version is v${family.current.version})` : ''}. {following} project{following === 1 ? '' : 's'} follow{following === 1 ? 's' : ''} this profile: their next storyboards use the new version; versions already planned keep theirs.
        </p>
      )}
      {since && (
        <div className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900" data-edit-since>
          <p>v{since.version} was saved since this form opened (see the history). Your changes are still here: saving them makes v{since.version + 1} with what this form changed, over what v{since.version} changed.</p>
          <button
            type="button"
            disabled={save.isPending || problems.length > 0}
            onClick={() => {
              setExpected(since.id);
              save.mutate(since.id);
            }}
            className={`${primary} bg-amber-700 hover:bg-amber-800`}
          >
            Save v{since.version + 1} anyway
          </button>
        </div>
      )}
      {problems.length > 0 && <p className="text-xs text-red-700">To fix: {problems.join('; ')}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={save.isPending || problems.length > 0 || !!since} className={primary}>
          {mode === 'new' ? 'Create the profile' : mode === 'duplicate' ? 'Create the copy' : `Save v${next}`}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
      {save.error && !since && <p className="text-sm break-words text-red-700">{save.error.message}</p>}
    </form>
  );
}

// ── A project's overrides ────────────────────────────────────────────────────

function OverrideRow({ label, on, onToggle, shown, children }: { label: string; on: boolean; onToggle: (on: boolean) => void; shown: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 rounded-md border p-2 ${on ? 'border-sky-300 bg-sky-50/40' : 'border-stone-200'}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <span className="text-sm text-stone-800">{label}</span>
        <label className="inline-flex min-h-6 items-center gap-1 text-xs text-stone-600">
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} aria-label={`Override for this project: ${label}`} /> Override for this project
        </label>
      </div>
      {on ? <div className="mt-1">{children}</div> : <p className="text-xs break-words text-stone-500">profile: {shown}</p>}
    </div>
  );
}

/**
 * Settings a project sets over its profile without changing it. Each row
 * is ticked to override it; an unticked row shows the profile's value and
 * sends nothing.
 */
export function VisualOverridesEditor({ base, value, onChange, onBad, catalog }: { base: VisualStyleProfileConfig; value: Readonly<Record<string, unknown>>; onChange: (v: Record<string, unknown>) => void; onBad: (path: string, bad: boolean) => void; catalog: VisualCatalogView | null }) {
  const rows = visualConfigRows(base);
  const shown = (path: string) => rows.find((r) => path === r.path || path.startsWith(`${r.path}.`))?.value ?? String(valueAt(base, path));
  const toggle = (path: string, on: boolean) => {
    const next = { ...value };
    if (on) next[path] = valueAt(base, path);
    else {
      delete next[path];
      onBad(path, false);
    }
    onChange(next);
  };
  const set = (path: string, v: unknown) => onChange({ ...value, [path]: v });
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-visual-overrides>
      {VISUAL_FIELDS.map((f) => (
        <OverrideRow key={f.path} label={f.label} on={f.path in value} onToggle={(on) => toggle(f.path, on)} shown={f.kind === 'choice' ? (f.options!.find((o) => o.value === valueAt(base, f.path))?.label ?? String(valueAt(base, f.path))) : shown(f.path)}>
          <FieldInput field={f} value={value[f.path]} onChange={(v) => set(f.path, v)} onBad={(b) => onBad(f.path, b)} />
        </OverrideRow>
      ))}
      <OverrideRow label="Reroll allowances" on={'generation.rerolls' in value} onToggle={(on) => toggle('generation.rerolls', on)} shown={shown('generation')}>
        <RerollRows value={(value['generation.rerolls'] as Rerolls | undefined) ?? {}} onChange={(v) => set('generation.rerolls', v)} />
      </OverrideRow>
      <OverrideRow label="Provider preferences" on={'providerPreferences' in value} onToggle={(on) => toggle('providerPreferences', on)} shown={shown('providerPreferences')}>
        <PreferenceRows value={(value.providerPreferences as Preferences | undefined) ?? {}} onChange={(v) => set('providerPreferences', v)} catalog={catalog} />
      </OverrideRow>
    </div>
  );
}

// ── A project's choice ───────────────────────────────────────────────────────

/** "Cinematic History v1 · the library default" with how it is chosen and the project's overrides. */
export function ProductionLine({ production: p }: { production: VisualProductionView }) {
  return (
    <span data-visual-production={p.mode}>
      {productionText(p)}
      {Object.keys(p.overrides).length ? ` · overrides: ${describeVisualOverrides(p.overrides)}` : ''}
    </span>
  );
}

/**
 * Choose the project's visual profile — a saved profile following its
 * current version or pinned to one, or the library default — and the
 * project's overrides. Saved at the revision shown: a change made in
 * another tab since is refused, and the form stays as it was until Reload.
 * Storyboard versions already planned keep the profile they were planned
 * with (re-costing one with the new profile is an edit, a new version).
 */
export function VisualSelectionForm({ projectId, production: p, onSaved }: { projectId: string; production: VisualProductionView; onSaved?: () => void }) {
  const library = useQuery({ queryKey: ['visual-profiles', false], queryFn: () => api.visualProfiles(false) });
  const catalog = useQuery({ queryKey: ['visual-catalog'], queryFn: api.visualCatalog, staleTime: 300_000 });
  const [familyId, setFamilyId] = useState(p.mode === 'DEFAULT' ? '' : (p.family?.id ?? ''));
  const [pin, setPin] = useState(p.mode === 'PIN');
  const [versionId, setVersionId] = useState(p.mode === 'PIN' ? (p.profile?.id ?? '') : '');
  const [paths, setPaths] = useState<Record<string, unknown>>(() => overridePaths(p.overrides));
  const [bad, setBad] = useState<Set<string>>(new Set());
  const history = useQuery({ queryKey: ['visual-profile', familyId], queryFn: () => api.visualProfile(familyId), enabled: !!familyId && pin });
  const reload = useVisualReload();
  const families = library.data?.families ?? [];
  const family = families.find((f) => f.id === familyId) ?? (p.family && p.family.id === familyId ? { id: p.family.id, name: p.family.name, current: p.mode === 'FOLLOW' ? p.profile : null } : null);
  const libraryDefault = families.find((f) => f.isDefault) ?? null;
  const version: VisualProfileView | null = familyId ? (pin ? (history.data?.history.find((x) => x.id === versionId) ?? (versionId === p.profile?.id ? p.profile : null)) : (family?.current ?? null)) : (libraryDefault?.current ?? (p.mode === 'DEFAULT' ? p.profile : null));
  const overrides: VisualConfigOverrides = overridesFrom(paths);
  const next = { familyId: familyId || null, versionId: familyId && pin ? versionId || null : null };
  const unchanged = next.familyId === (p.mode === 'DEFAULT' ? null : (p.family?.id ?? null)) && next.versionId === (p.mode === 'PIN' ? (p.profile?.id ?? null) : null) && sameSettings(overrides, p.overrides);
  const problems = formProblems(bad, paths.providerPreferences as Preferences | undefined);
  const save = useStoryboardRequest(() => api.setVisualSelection(projectId, { ...next, overrides, revision: p.revision }), onSaved);
  return (
    <div className="space-y-3 text-sm" data-visual-selection>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Visual profile</span>
          <select
            value={familyId}
            onChange={(e) => {
              setFamilyId(e.target.value);
              setVersionId('');
            }}
            aria-label="Visual profile"
            className={input}
          >
            <option value="">The library default{libraryDefault?.current ? ` (${libraryDefault.name} v${libraryDefault.current.version})` : ''}</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.current ? ` (v${f.current.version})` : ''}
              </option>
            ))}
            {p.family && !families.some((f) => f.id === p.family!.id) && <option value={p.family.id}>{p.family.name}{p.family.archived ? ' (archived)' : ''}</option>}
          </select>
          <span className="mt-1 block text-xs text-stone-500">
            Make or edit profiles in the{' '}
            <Link to="/visual-profiles" className="underline">
              visual profile library
            </Link>
            .
          </span>
        </label>
        {familyId && (
          <fieldset className="min-w-0">
            <legend className="text-xs text-stone-500">Version</legend>
            <label className="flex min-h-6 items-center gap-2">
              <input type="radio" name={`visual-version-${projectId}`} checked={!pin} onChange={() => setPin(false)} /> Follow the current version{family?.current ? ` (now v${family.current.version})` : ''}
            </label>
            <label className="flex min-h-6 items-center gap-2">
              <input type="radio" name={`visual-version-${projectId}`} checked={pin} onChange={() => setPin(true)} /> Pin a version
            </label>
            {pin && (
              <select value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-label="Pinned version" className={input}>
                <option value="">{history.isPending ? 'Loading versions…' : 'Choose a version'}</option>
                {(history.data?.history ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    v{x.version}
                    {x.current ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
        )}
      </div>
      <details>
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Project overrides ({describeVisualOverrides(overrides)})</summary>
        <p className="mt-1 text-xs text-stone-500">Overrides apply to this project's next storyboards only; the saved profile is unchanged.</p>
        <div className="mt-2">
          {version ? (
            <VisualOverridesEditor
              base={version.config}
              value={paths}
              onChange={setPaths}
              onBad={(path, isBad) =>
                setBad((b) => {
                  const n = new Set(b);
                  if (isBad) n.add(path);
                  else n.delete(path);
                  return n;
                })
              }
              catalog={catalog.data ?? null}
            />
          ) : (
            <p className="text-xs text-stone-500">{pin ? 'Choose the version to pin.' : 'Loading the profile…'}</p>
          )}
        </div>
      </details>
      {problems.length > 0 && <p className="text-xs text-red-700">To fix: {problems.join('; ')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={save.isPending || unchanged || !!problems.length || (!!familyId && pin && !versionId)} onClick={() => save.mutate(undefined)} className={primary}>
          Use for this project
        </button>
        <span className="text-xs text-stone-500">
          {VISUAL_SELECTION_MODE_LABELS[p.mode]} · revision {p.revision}
        </span>
      </div>
      {save.error && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-700" data-selection-error>
          <span className="min-w-0 break-words">{save.error.message}</span>
          {isConflict(save.error) && (
            <button type="button" onClick={reload} className={secondary}>
              Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}
