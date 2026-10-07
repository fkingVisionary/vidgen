import { PRODUCTION_METHOD_LABELS, PRICE_CONFIDENCE_LABELS, type VisualCatalogView, type VisualProfileFamilyView, type VisualProfileHistoryView, type VisualProfileView } from '@docengine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.ts';
import { Section } from '../components/evidence.tsx';
import { useStoryboardRequest } from '../components/storyboard.tsx';
import { link, pill, primary, secondary } from '../components/ui.ts';
import { VisualConfigTable, VisualProfileForm, type VisualProfileFormMode } from '../components/visual-profiles.tsx';
import { formatDate } from '../format.ts';
import { profileLine, rateText, visualOriginText } from '../storyboard-plan.ts';

/** The form open on the page: a new profile, an edit (from a version), or a duplicate (of a version). */
interface Editing {
  mode: VisualProfileFormMode;
  family: VisualProfileFamilyView | null;
  base: VisualProfileView | null;
}

const formTitle = (e: Editing) => (e.mode === 'new' ? 'New visual profile' : e.mode === 'edit' ? `Edit ${e.family!.name} — from v${e.base!.version}` : `Duplicate ${e.family!.name} v${e.base!.version}`);

/**
 * The visual profile library: the look of a documentary, saved and reused,
 * each profile a family of immutable versions (an edit is a new version;
 * storyboards keep the version they were planned with). The five presets
 * are made when the library is first opened, provider-neutral and with no
 * provider preference; a project chooses one on its Storyboard page and may
 * override settings there without changing it. /visual-profiles/:id shows
 * one profile and its history. The catalog below is what forecasts are
 * priced from: nothing in it is called or bought.
 */
export function VisualProfilesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const library = useQuery({ queryKey: ['visual-profiles', archived], queryFn: () => api.visualProfiles(archived) });
  const catalog = useQuery({ queryKey: ['visual-catalog'], queryFn: api.visualCatalog, staleTime: 300_000 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const open = (e: Editing) => {
    setEditing(e);
    window.scrollTo(0, 0);
  };
  const saved = (h: VisualProfileHistoryView) => {
    setEditing(null);
    navigate(`/visual-profiles/${h.id}`);
    window.scrollTo(0, 0);
  };
  if (library.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (library.isError) return <p className="text-sm text-red-700">Could not load the visual profiles: {library.error.message}</p>;
  const lib = library.data;
  // The family as last read, so an edit sees a version saved since it opened (the form keeps the one it was opened against).
  const family = editing?.family ? (lib.families.find((f) => f.id === editing.family!.id) ?? editing.family) : null;
  return (
    <div className="space-y-6">
      <div>
        {id ? (
          <Link to="/visual-profiles" className="text-sm text-stone-500 hover:underline">
            ← Visual profiles
          </Link>
        ) : (
          <Link to="/" className="text-sm text-stone-500 hover:underline">
            ← Projects
          </Link>
        )}
        <h1 className="mt-2 text-2xl font-semibold">Visual profiles</h1>
        <p className="mt-2 text-xs text-stone-500">
          A visual profile is the look of a documentary, provider-neutral: realism, camera language, lenses, colour, lighting, film grain, frame, motion, density, archival and graphics preferences, how much generated video, the approach planned in full, provider preferences and a cost ceiling. Every edit is a new version, so storyboards keep exactly what they were planned with. A project chooses its profile on its Storyboard page (until then it plans with the library default) and may override settings there without changing the profile.
        </p>
      </div>
      {editing && (
        <Section title={formTitle(editing)}>
          <VisualProfileForm key={`${editing.mode}:${editing.base?.id ?? 'new'}`} library={lib} mode={editing.mode} family={family} base={editing.base} catalog={catalog.data ?? null} onSaved={saved} onCancel={() => setEditing(null)} />
        </Section>
      )}
      {id ? (
        <ProfileHistory id={id} onEdit={open} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => open({ mode: 'new', family: null, base: null })} className={primary}>
              New profile
            </button>
            <label className="inline-flex min-h-6 items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
            </label>
          </div>
          {lib.families.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {lib.families.map((f) => (
                <ProfileCard key={f.id} family={f} onEdit={open} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-stone-500">No visual profile{archived ? '' : ' (archived ones are hidden)'}.</p>
          )}
          {catalog.data && <CatalogSection catalog={catalog.data} />}
        </>
      )}
    </div>
  );
}

/** One profile: its current version, who uses it, and what can be done with it. */
function ProfileCard({ family: f, onEdit, detail = false }: { family: VisualProfileFamilyView; onEdit: (e: Editing) => void; detail?: boolean }) {
  const update = useStoryboardRequest((change: { archived?: boolean; isDefault?: true }) => api.updateVisualProfileFamily(f.id, change));
  const [renaming, setRenaming] = useState(false);
  const c = f.current;
  return (
    <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-3" data-profile={f.name}>
      <header className="flex flex-wrap items-center gap-2">
        {detail ? (
          <h2 className="text-lg font-semibold break-words text-stone-900">{f.name}</h2>
        ) : (
          <Link to={`/visual-profiles/${f.id}`} className="font-semibold break-words text-stone-900 hover:underline">
            {f.name}
          </Link>
        )}
        {f.isDefault && <span className={`${pill} bg-emerald-100 text-emerald-800`}>library default</span>}
        {f.archived && <span className={`${pill} bg-stone-200 text-stone-700`}>archived</span>}
        {f.preset && <span className={`${pill} bg-sky-100 text-sky-800`}>preset</span>}
        {c && <span className={`${pill} bg-stone-100 text-stone-700`}>current v{c.version}</span>}
      </header>
      {f.description && <p className="mt-1 text-sm break-words text-stone-600">{f.description}</p>}
      {c ? <p className="mt-2 text-xs break-words text-stone-600">{profileLine(c.config)}</p> : <p className="mt-2 text-xs text-stone-500">No version.</p>}
      {c && c.unknownPreferences.length > 0 && <p className="mt-1 text-xs break-words text-amber-900">Not in the catalog (a warning only): {c.unknownPreferences.join(', ')}</p>}
      <p className="mt-2 text-xs text-stone-600">
        {f.versions} version{f.versions === 1 ? '' : 's'} · {f.storyboards} storyboard version{f.storyboards === 1 ? '' : 's'} planned with it
      </p>
      <div className="mt-1 text-xs text-stone-600" data-used-by>
        {f.usedBy.length ? (
          <>
            Used by:{' '}
            {f.usedBy.map((u, i) => (
              <span key={u.projectId}>
                {i ? ', ' : ''}
                <Link to={`/projects/${u.slug}/storyboard`} className="underline">
                  {u.title}
                </Link>{' '}
                ({u.mode === 'PIN' ? `pinned to v${u.pinnedVersion}` : 'follows'})
              </span>
            ))}
          </>
        ) : (
          'Not chosen by any project'
        )}
        {f.isDefault ? '; and every project that has chosen none.' : ''}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!detail && (
          <Link to={`/visual-profiles/${f.id}`} className={link}>
            History
          </Link>
        )}
        {c && (
          <button type="button" disabled={f.archived} title={f.archived ? 'Unarchive it to edit it' : undefined} onClick={() => onEdit({ mode: 'edit', family: f, base: c })} className={secondary}>
            Edit
          </button>
        )}
        {c && (
          <button type="button" onClick={() => onEdit({ mode: 'duplicate', family: f, base: c })} className={secondary}>
            Duplicate
          </button>
        )}
        <button type="button" onClick={() => setRenaming((x) => !x)} aria-expanded={renaming} className={secondary}>
          Rename
        </button>
        <button type="button" disabled={update.isPending || (f.isDefault && !f.archived)} title={f.isDefault && !f.archived ? 'The library default: make another profile the library default first' : undefined} onClick={() => update.mutate({ archived: !f.archived })} className={secondary}>
          {f.archived ? 'Unarchive' : 'Archive'}
        </button>
        {!f.isDefault && !f.archived && (
          <button type="button" disabled={update.isPending} onClick={() => update.mutate({ isDefault: true })} className={secondary}>
            Make library default
          </button>
        )}
      </div>
      {update.error && <p className="mt-1 text-xs break-words text-red-700">{update.error.message}</p>}
      {renaming && <RenameProfile family={f} onClose={() => setRenaming(false)} />}
    </article>
  );
}

/** A profile's name and description: the family's, not a version's (versions keep the name they were made with). */
function RenameProfile({ family: f, onClose }: { family: VisualProfileFamilyView; onClose: () => void }) {
  const [name, setName] = useState(f.name);
  const [description, setDescription] = useState(f.description ?? '');
  const change = { ...(name.trim() !== f.name ? { name: name.trim() } : {}), ...(description.trim() !== (f.description ?? '') ? { description: description.trim() || null } : {}) };
  const save = useStoryboardRequest(() => api.updateVisualProfileFamily(f.id, change), onClose);
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
      <p className="text-xs text-stone-500">No version is changed: storyboards and versions keep the name they were made with.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={save.isPending || !ready} className={primary}>
          Save the name
        </button>
        <button type="button" onClick={onClose} className={secondary}>
          Cancel
        </button>
      </div>
      {save.error && <p className="text-xs break-words text-red-700">{save.error.message}</p>}
    </form>
  );
}

/** One profile and every version, newest first: how each was made, what changed, and Edit or Duplicate from it (going back is an edit from an older version). */
function ProfileHistory({ id, onEdit }: { id: string; onEdit: (e: Editing) => void }) {
  const history = useQuery({ queryKey: ['visual-profile', id], queryFn: () => api.visualProfile(id) });
  if (history.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (history.isError) return <p className="text-sm text-red-700">Could not load the profile: {history.error.message}</p>;
  const h = history.data;
  return (
    <div className="space-y-4">
      <ProfileCard family={h} onEdit={onEdit} detail />
      <Section title={`History — ${h.history.length} version${h.history.length === 1 ? '' : 's'}`}>
        <ol className="space-y-3">
          {h.history.map((x) => (
            <li key={x.id} className="min-w-0 rounded-md border border-stone-200 p-2 text-sm" data-version={x.version}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-stone-900">v{x.version}</span>
                {x.current && <span className={`${pill} bg-stone-900 text-white`}>current</span>}
                <span className="text-xs text-stone-600">{visualOriginText(x.origin)}</span>
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
              <p className="mt-1 text-xs break-words text-stone-500">{profileLine(x.config)}</p>
              <p className="text-xs text-stone-500">
                {x.createdBy ? `by ${x.createdBy}, ` : ''}
                {formatDate(x.createdAt)} · {x.storyboards} storyboard version{x.storyboards === 1 ? '' : 's'}
                {x.name !== h.name ? ` · made as ${x.name}` : ''}
              </p>
              {x.notes && <p className="mt-1 text-xs break-words text-stone-600">Notes: {x.notes}</p>}
              {x.unknownPreferences.length > 0 && <p className="mt-1 text-xs break-words text-amber-900">Not in the catalog (a warning only): {x.unknownPreferences.join(', ')}</p>}
              <details className="mt-1">
                <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Settings</summary>
                <div className="mt-1">
                  <VisualConfigTable config={x.config} />
                </div>
              </details>
              <div className="mt-1 flex flex-wrap gap-x-3">
                <button type="button" disabled={h.archived} title={h.archived ? 'Unarchive it to edit it' : undefined} onClick={() => onEdit({ mode: 'edit', family: h, base: x })} className={link}>
                  Edit from this version
                </button>
                <button type="button" onClick={() => onEdit({ mode: 'duplicate', family: h, base: x })} className={link}>
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

/** The catalog forecasts are priced from: each card's models and rates, with their sources, check dates and confidence. Nothing in it is called or bought. */
function CatalogSection({ catalog: c }: { catalog: VisualCatalogView }) {
  return (
    <details className="rounded-lg border border-stone-200 bg-white p-4" data-catalog>
      <summary className="inline-flex min-h-6 cursor-pointer items-center text-sm font-semibold text-stone-700">The visual catalog (catalog {c.version}): what forecasts are priced from</summary>
      <p className="mt-2 text-xs text-stone-500">Providers and models that could produce each method, with prices for forecasts only. A card with no price is unpriced: its shots are never counted as $0. Nothing here is called, configured or bought.</p>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        {c.cards.map((card) => (
          <article key={card.provider} className="min-w-0 rounded-md border border-stone-200 p-2 text-xs" data-catalog-card={card.provider}>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold break-words text-stone-900">{card.label}</span>
              <span className="text-stone-500">{card.provider}</span>
              {!card.implemented && <span className={`${pill} bg-stone-100 text-stone-600`}>no adapter yet</span>}
            </p>
            <p className="mt-1 break-words text-stone-600">
              {card.rates.length ? `${PRICE_CONFIDENCE_LABELS[card.pricing.confidence]}, checked ${card.pricing.checkedAt}` : 'not priced'} · {card.pricing.source}
            </p>
            <ul className="mt-1 space-y-0.5">
              {card.models.map((m) => (
                <li key={m.model} className="break-words">
                  <span className="font-medium text-stone-800">{m.label}</span> — {m.methods.map((x) => PRODUCTION_METHOD_LABELS[x]).join(', ')}
                  {m.resolutions.length ? ` · ${m.resolutions.join(', ')}` : ''}
                </li>
              ))}
            </ul>
            {card.rates.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-stone-600">
                {card.rates.map((r, i) => (
                  <li key={i} className="break-words">
                    {r.model ?? 'every model'}: {rateText(r)}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}

