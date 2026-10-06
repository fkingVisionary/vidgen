import { PERFORMANCE_STRATEGY_LABELS, type VoiceProfileFamilyView, type VoiceProfileHistoryView, type VoiceProfileLibraryView, type VoiceProfileView } from '@docengine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.ts';
import { Section } from '../components/evidence.tsx';
import { button, ConfigTable, link, otherProvider, pill, ProfileForm, secondary, useVoiceRequest, type ProfileFormMode } from '../components/voice-profiles.tsx';
import { formatDate } from '../format.ts';
import { contextLabel, originText, sizeLabel, versionEffective } from '../voice-plan.ts';

/** The form open on the page: a new profile, an edit (from a version), or a duplicate (of a version). */
interface Editing {
  mode: ProfileFormMode;
  family: VoiceProfileFamilyView | null;
  base: VoiceProfileView | null;
}

const formTitle = (e: Editing) => (e.mode === 'new' ? 'New profile' : e.mode === 'edit' ? `Edit ${e.family!.name} — from v${e.base!.version}` : `Duplicate ${e.family!.name} v${e.base!.version}`);

/**
 * The voice profile library: saved profiles, each a family of immutable
 * versions (an edit is a new version; runs and takes keep the version they
 * used). Profiles are global; a project chooses one on its Voice page and
 * may override settings there without changing it. /voice-profiles/:id
 * shows one profile and its history.
 */
export function VoiceProfilesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const library = useQuery({ queryKey: ['voice-profiles', archived], queryFn: () => api.voiceProfiles(archived) });
  const [editing, setEditing] = useState<Editing | null>(null);
  const open = (e: Editing) => {
    setEditing(e);
    window.scrollTo(0, 0);
  };
  const saved = (h: VoiceProfileHistoryView) => {
    setEditing(null);
    navigate(`/voice-profiles/${h.id}`);
    window.scrollTo(0, 0);
  };
  if (library.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (library.isError) return <p className="text-sm text-red-700">Could not load the voice profiles: {library.error.message}</p>;
  const lib = library.data;
  // The family as last read, so an edit sees a version saved since it opened (the form keeps the one it was opened against).
  const family = editing?.family ? (lib.families.find((f) => f.id === editing.family!.id) ?? editing.family) : null;
  return (
    <div className="space-y-6">
      <div>
        {id ? (
          <Link to="/voice-profiles" className="text-sm text-stone-500 hover:underline">
            ← Voice profiles
          </Link>
        ) : (
          <Link to="/" className="text-sm text-stone-500 hover:underline">
            ← Projects
          </Link>
        )}
        <h1 className="mt-2 text-2xl font-semibold">Voice profiles</h1>
        <p className="mt-2 text-xs text-stone-500">
          A saved profile is a voice and how it narrates: provider, voice, model, language and output format, performance, chunk size, context, number style, pronunciation rules, performance rules and the provider's own settings. Every edit is a new version, so runs and takes keep exactly what made them. A project chooses its production profile on its Voice page, and may override settings there without changing the profile.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-600">
        <span className="font-semibold text-stone-800">{lib.provider.name}</span>
        {lib.provider.mock && <span className={`${pill} bg-amber-100 text-amber-900`}>MOCK voice</span>}
        <span>default model {lib.provider.defaultModel}</span>
        <span className="break-all">default voice {lib.provider.defaultVoiceId ?? 'not set'}</span>
        <span>output {lib.provider.defaultOutputFormat}</span>
        <span>{lib.settings.length} provider settings</span>
      </div>
      {editing && (
        <Section title={formTitle(editing)}>
          <ProfileForm key={`${editing.mode}:${editing.base?.id ?? 'new'}`} library={lib} mode={editing.mode} family={family} base={editing.base} onSaved={saved} onCancel={() => setEditing(null)} />
        </Section>
      )}
      {id ? (
        <ProfileHistory id={id} library={lib} onEdit={open} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => open({ mode: 'new', family: null, base: null })} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
              New profile
            </button>
            <label className="inline-flex min-h-6 items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
            </label>
          </div>
          {lib.families.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {lib.families.map((f) => (
                <ProfileCard key={f.id} family={f} library={lib} onEdit={open} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-stone-500">No saved profile yet: the house profile is made at a project's first plan, or make one with “New profile”.</p>
          )}
        </>
      )}
    </div>
  );
}

/** "mock · mock · voice mock-narrator-deep · en · wav_22050" (only the voice id may break anywhere on a phone). */
function VoiceLine({ version: v, className }: { version: VoiceProfileView; className: string }) {
  return (
    <p className={`break-words ${className}`}>
      {v.provider} · {v.modelId} · voice <span className="break-all">{v.voiceId}</span> · {v.language} · {v.outputFormat}
    </p>
  );
}

/** One saved profile: its current version, who uses it, its runs, and what can be done with it. */
function ProfileCard({ family: f, library, onEdit, detail = false }: { family: VoiceProfileFamilyView; library: VoiceProfileLibraryView; onEdit: (e: Editing) => void; detail?: boolean }) {
  const update = useVoiceRequest((change: { archived?: boolean; isDefault?: true }) => api.updateVoiceProfileFamily(f.id, change));
  const [renaming, setRenaming] = useState(false);
  const elsewhere = otherProvider(f.provider, library.provider.name);
  const c = f.current;
  return (
    <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-3" data-profile={f.name}>
      <header className="flex flex-wrap items-center gap-2">
        {detail ? (
          <h2 className="text-lg font-semibold break-words text-stone-900">{f.name}</h2>
        ) : (
          <Link to={`/voice-profiles/${f.id}`} className="font-semibold break-words text-stone-900 hover:underline">
            {f.name}
          </Link>
        )}
        {f.isDefault && <span className={`${pill} bg-emerald-100 text-emerald-800`}>library default</span>}
        {f.archived && <span className={`${pill} bg-stone-200 text-stone-700`}>archived</span>}
        {c && <span className={`${pill} bg-stone-100 text-stone-700`}>current v{c.version}</span>}
      </header>
      {elsewhere && <p className="mt-1 text-xs text-amber-900">{elsewhere}</p>}
      {f.description && <p className="mt-1 text-sm text-stone-600">{f.description}</p>}
      {c ? (
        <div className="mt-2 space-y-0.5 text-xs text-stone-600">
          <VoiceLine version={c} className="" />
          <p>
            {PERFORMANCE_STRATEGY_LABELS[c.config.strategy]} · {sizeLabel(c.config.chunking)} · {contextLabel(c.config.context)}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-stone-500">No version.</p>
      )}
      <p className="mt-2 text-xs text-stone-600">
        {f.versions} version{f.versions === 1 ? '' : 's'} · {f.runs} run{f.runs === 1 ? '' : 's'}
      </p>
      <div className="mt-1 text-xs text-stone-600" data-used-by>
        {f.usedBy.length ? (
          <>
            Used by:{' '}
            {f.usedBy.map((u, i) => (
              <span key={`${u.projectId}:${u.language}`}>
                {i ? ', ' : ''}
                <Link to={`/projects/${u.slug}/voice`} className="underline">
                  {u.title}
                </Link>{' '}
                ({u.language}, {u.mode === 'PIN' ? `pinned to v${u.pinnedVersion}` : 'follows'})
              </span>
            ))}
          </>
        ) : (
          'Not chosen by any project'
        )}
        {f.isDefault ? '; and every project that narrates with the library default.' : ''}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!detail && (
          <Link to={`/voice-profiles/${f.id}`} className={link}>
            History
          </Link>
        )}
        {c && (
          <button disabled={!!elsewhere || f.archived} title={elsewhere ?? (f.archived ? 'Unarchive it to edit it' : undefined)} onClick={() => onEdit({ mode: 'edit', family: f, base: c })} className={secondary}>
            Edit
          </button>
        )}
        {c && (
          <button disabled={!!elsewhere} title={elsewhere ?? undefined} onClick={() => onEdit({ mode: 'duplicate', family: f, base: c })} className={secondary}>
            Duplicate
          </button>
        )}
        <button onClick={() => setRenaming((x) => !x)} aria-expanded={renaming} className={secondary}>
          Rename
        </button>
        <button disabled={update.isPending || (f.isDefault && !f.archived)} title={f.isDefault && !f.archived ? 'The library default: make another profile the library default first' : undefined} onClick={() => update.mutate({ archived: !f.archived })} className={secondary}>
          {f.archived ? 'Unarchive' : 'Archive'}
        </button>
        {!f.isDefault && !f.archived && !elsewhere && (
          <button disabled={update.isPending} onClick={() => update.mutate({ isDefault: true })} className={secondary}>
            Make library default
          </button>
        )}
      </div>
      {update.error && <p className="mt-1 text-xs text-red-700">{update.error.message}</p>}
      {renaming && <RenameProfile family={f} onClose={() => setRenaming(false)} />}
    </article>
  );
}

/** A profile's name and description: the family's, not a version's (versions keep the name they were made with). */
function RenameProfile({ family: f, onClose }: { family: VoiceProfileFamilyView; onClose: () => void }) {
  const [name, setName] = useState(f.name);
  const [description, setDescription] = useState(f.description ?? '');
  const change = { ...(name.trim() !== f.name ? { name: name.trim() } : {}), ...(description.trim() !== (f.description ?? '') ? { description: description.trim() || null } : {}) };
  const save = useVoiceRequest(() => api.updateVoiceProfileFamily(f.id, change), onClose);
  const ready = !!name.trim() && Object.keys(change).length > 0;
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-stone-200 bg-stone-50 p-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate(undefined);
      }}
      data-rename
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1" />
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1" />
        </label>
      </div>
      <p className="text-xs text-stone-500">No version is changed: runs and versions keep the name they were made with and read “(now {name.trim() || f.name})”.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={save.isPending || !ready} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
          Save the name
        </button>
        <button type="button" onClick={onClose} className={secondary}>
          Cancel
        </button>
      </div>
      {save.error && <p className="text-xs text-red-700">{save.error.message}</p>}
    </form>
  );
}

/** One profile and every version, newest first: how each was made, what changed, and Edit or Duplicate from it (going back is an edit from an older version). */
function ProfileHistory({ id, library, onEdit }: { id: string; library: VoiceProfileLibraryView; onEdit: (e: Editing) => void }) {
  const history = useQuery({ queryKey: ['voice-profile', id], queryFn: () => api.voiceProfile(id) });
  if (history.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (history.isError) return <p className="text-sm text-red-700">Could not load the profile: {history.error.message}</p>;
  const h = history.data;
  const elsewhere = otherProvider(h.provider, library.provider.name);
  return (
    <div className="space-y-4">
      <ProfileCard family={h} library={library} onEdit={onEdit} detail />
      <Section title={`History — ${h.history.length} version${h.history.length === 1 ? '' : 's'}`}>
        <ol className="space-y-3">
          {h.history.map((x) => (
            <li key={x.id} className="min-w-0 rounded-md border border-stone-200 p-2 text-sm" data-version={x.version}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-stone-900">v{x.version}</span>
                {x.current && <span className={`${pill} bg-stone-900 text-white`}>current</span>}
                <span className="text-xs text-stone-600">{originText(x.origin)}</span>
              </p>
              {x.changes.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-stone-700" data-changes>
                  {x.changes.map((ch) => (
                    <li key={ch} className="break-words">
                      {ch}
                    </li>
                  ))}
                </ul>
              )}
              <VoiceLine version={x} className="mt-1 text-xs text-stone-500" />
              <p className="text-xs text-stone-500">
                {x.createdBy ? `by ${x.createdBy}, ` : ''}
                {formatDate(x.createdAt)} · {x.runs} run{x.runs === 1 ? '' : 's'}
                {x.name !== h.name ? ` · made as ${x.name}` : ''}
              </p>
              {x.notes && <p className="mt-1 text-xs text-stone-600">Notes: {x.notes}</p>}
              <details className="mt-1">
                <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Configuration</summary>
                <div className="mt-1">
                  <ConfigTable config={versionEffective(x)} provenance={{}} settings={x.provider === library.provider.name ? library.settings : []} />
                </div>
              </details>
              <div className="mt-1 flex flex-wrap gap-x-3">
                <button disabled={!!elsewhere || h.archived} title={elsewhere ?? (h.archived ? 'Unarchive it to edit it' : undefined)} onClick={() => onEdit({ mode: 'edit', family: h, base: x })} className={link}>
                  Edit from this version
                </button>
                <button disabled={!!elsewhere} title={elsewhere ?? undefined} onClick={() => onEdit({ mode: 'duplicate', family: h, base: x })} className={link}>
                  Duplicate this version
                </button>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
