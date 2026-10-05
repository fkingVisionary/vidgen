import {
  ARCHITECTURE_ORIGIN_LABELS,
  CHANGE_AREA_LABELS,
  NARRATIVE_MODES,
  NARRATIVE_MODE_LABELS,
  POV_STRATEGIES,
  POV_STRATEGY_LABELS,
  REVISION_ASPECTS,
  REVISION_ASPECT_LABELS,
  type ArchitectureDiff,
  type ArchitectureProvenance,
  type NarrativeMode,
  type PovStrategy,
  type ProjectDetailView,
  type RevisionAspect,
  type StoryArchitectureView,
  type StoryView,
} from '@docengine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { formatDate } from '../format.ts';
import { Section } from './evidence.tsx';

/**
 * The editorial revision loop: reconsider an architecture version from the
 * editor's brief, see what the revision changed and why, and every version
 * kept. A revision is a new version built from the same story pack and the
 * approved dossier — never new research — and the version it revised is
 * never changed.
 */

const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const lower = (s: string) => s.toLowerCase().replace('_', ' ');

/** A story request (a job or an edit): reload the project and the story view when it settles. */
export function useStoryRequest<T>(fn: (arg: T) => Promise<unknown>, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => onDone?.(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['story'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ── Preferences (shared with a new architecture) ─────────────────────────────

export interface PreferenceState {
  mode: NarrativeMode | '';
  pov: PovStrategy | '';
  povText: string;
  question: string;
}
export const NO_PREFERENCES: PreferenceState = { mode: '', pov: '', povText: '', question: '' };

/** The preferences as the API takes them, or undefined when none is set. */
export function preferencesInput(s: PreferenceState) {
  const out = {
    ...(s.mode ? { narrativeMode: s.mode } : {}),
    ...(s.pov ? { povStrategy: { type: s.pov, description: s.povText.trim() } } : {}),
    ...(s.question.trim() ? { centralQuestion: s.question.trim() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export function PreferenceFields({ value: s, onChange, summary }: { value: PreferenceState; onChange: (s: PreferenceState) => void; summary: string }) {
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-stone-600">{summary}</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select value={s.mode} onChange={(e) => onChange({ ...s, mode: e.target.value as NarrativeMode | '' })} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Preferred narrative mode">
          <option value="">Narrative mode: the architect's choice</option>
          {NARRATIVE_MODES.map((m) => (
            <option key={m} value={m}>
              {NARRATIVE_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <select value={s.pov} onChange={(e) => onChange({ ...s, pov: e.target.value as PovStrategy | '' })} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Preferred POV strategy">
          <option value="">POV: the architect's choice</option>
          {POV_STRATEGIES.map((m) => (
            <option key={m} value={m}>
              {POV_STRATEGY_LABELS[m]}
            </option>
          ))}
        </select>
        {s.pov && <input value={s.povText} onChange={(e) => onChange({ ...s, povText: e.target.value })} placeholder="How the POV is used (optional)" className="rounded-md border border-stone-300 px-2 py-1 text-sm sm:col-span-2" />}
        <input value={s.question} onChange={(e) => onChange({ ...s, question: e.target.value })} placeholder="Central question (optional)" className="rounded-md border border-stone-300 px-2 py-1 text-sm sm:col-span-2" />
      </div>
      <p className="mt-1 text-xs text-stone-500">The architect follows these or says why not. They change how the story is told, never the evidence.</p>
    </details>
  );
}

// ── Reconsider / revise ──────────────────────────────────────────────────────

/** Why this architecture version cannot be revised now, or null. */
export function reviseBlocked(view: StoryView, a: StoryArchitectureView): string | null {
  if (!view.editorial.revise.allowed) return view.editorial.revise.reason;
  const current = view.packs[0]?.version;
  if (a.packVersion !== current) return `Architecture v${a.version} was built from story pack v${a.packVersion ?? '—'}; only versions of the current pack (v${current}) can be revised`;
  return null;
}

/**
 * "Reconsider / Revise Architecture": the editor says what is not working —
 * a checklist and a freeform brief — and the architect revises the shown
 * version into a new one. The shown version is kept unchanged.
 */
export function RevisePanel({ project: p, view: v, architecture: a, onQueued }: { project: ProjectDetailView; view: StoryView; architecture: StoryArchitectureView; onQueued?: () => void }) {
  const [aspects, setAspects] = useState<RevisionAspect[]>([]);
  const [brief, setBrief] = useState('');
  const [prefs, setPrefs] = useState<PreferenceState>(NO_PREFERENCES);
  const [angle, setAngle] = useState('');
  const revise = useStoryRequest(
    () => {
      const [exploration, key] = angle.split(':');
      const preferences = preferencesInput(prefs);
      return api.reviseArchitecture(p.id, {
        baseVersion: a.version,
        brief: brief.trim(),
        aspects,
        ...(preferences ? { preferences } : {}),
        ...(exploration && key ? { angle: { exploration: Number(exploration), key } } : {}),
      });
    },
    () => {
      setAspects([]);
      setBrief('');
      setPrefs(NO_PREFERENCES);
      setAngle('');
      onQueued?.();
    },
  );
  const blocked = reviseBlocked(v, a);
  const next = (v.architectures[0]?.version ?? 0) + 1;
  const angles = v.exploration && v.exploration.packVersion === v.packs[0]?.version ? (v.exploration.content?.angles ?? []) : [];
  const short = brief.trim().length < 10;
  const toggle = (x: RevisionAspect) => setAspects((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x]));

  return (
    <details className="rounded-md border border-sky-200 bg-sky-50/50 p-3" open={revise.isPending || undefined}>
      <summary className="cursor-pointer font-medium text-sky-900">Reconsider / Revise Architecture v{a.version}…</summary>
      <div className="mt-2 space-y-3 text-sm">
        <p className="text-stone-700">
          Say what is not working. The architect reconsiders v{a.version} using only the story pack — the units you selected, plus units you approved but did not select — and the approved dossier: no new research, no new facts. It may restructure substantially: reorder, merge, remove or replace sequences, change the narrative mode or point of view, strengthen the human stakes, change the central question, rethink the opening — and must say what it changed and why.
        </p>
        <p className="text-xs text-stone-600">
          The revision becomes v{next}; v{a.version} is kept unchanged. The Story Editor and the Fact Checker review the revision and the architecture gate checks it again. It replaces the version under review only if it passes, and it always needs your approval.
          {a.status === 'APPROVED' && ` v${a.version} is approved: the project goes back to story review for the revision, and v${a.version} stays approved until you approve another version.`}
        </p>
        {blocked ? (
          <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{blocked}</p>
        ) : (
          <>
            <fieldset>
              <legend className="text-xs font-medium text-stone-500 uppercase">What is not working (optional)</legend>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {REVISION_ASPECTS.map((x) => (
                  <label key={x} className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-xs ring-1 ${aspects.includes(x) ? 'bg-sky-700 text-white ring-sky-700' : 'bg-white text-stone-700 ring-stone-300'}`}>
                    <input type="checkbox" className="sr-only" checked={aspects.includes(x)} onChange={() => toggle(x)} />
                    {REVISION_ASPECT_LABELS[x]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label className="text-xs font-medium text-stone-500 uppercase" htmlFor={`brief-${a.id}`}>
                Editorial brief
              </label>
              <textarea
                id={`brief-${a.id}`}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={4}
                placeholder="What is not working and what you want instead — e.g. the opening explains instead of dropping us into a moment; the film has no one to follow; the central question is answered too early"
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
              />
            </div>
            <PreferenceFields value={prefs} onChange={setPrefs} summary="Preferences for the revision (optional): narrative mode, POV, central question" />
            {angles.length > 0 && (
              <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center">
                <span className="text-stone-600">Toward an explored angle (optional)</span>
                <select value={angle} onChange={(e) => setAngle(e.target.value)} className="min-w-0 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm">
                  <option value="">No angle</option>
                  {angles.map((x) => (
                    <option key={x.key} value={`${v.exploration!.version}:${x.key}`}>
                      {x.key} — {x.title} (exploration {v.exploration!.version})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={revise.isPending || short} onClick={() => revise.mutate(undefined)} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
                Revise v{a.version} → new version v{next}
              </button>
              {short && <span className="text-xs text-stone-500">The brief needs at least a sentence.</span>}
            </div>
          </>
        )}
        {revise.error && <p className="text-sm text-red-700">{revise.error.message}</p>}
      </div>
    </details>
  );
}

// ── How a version came about ─────────────────────────────────────────────────

interface RevisionStats {
  revision?: { baseVersion: number; aspects: RevisionAspect[]; unaddressed: RevisionAspect[]; substantial: boolean } | null;
  storyIssues?: number;
  factIssues?: number;
  revisedByStoryEditor?: boolean;
  revisedByFactChecker?: boolean;
}

/**
 * How an architecture version came about: built from the selection (maybe
 * on an explored angle), or a revision — the editor's brief, the architect's
 * account of what it changed and why, what code measured as changed, and the
 * reviewers who checked it again.
 */
export function VersionRecord({ architecture: a, provenance: pv, view: v, onVersion, onExploration }: { architecture: StoryArchitectureView; provenance: ArchitectureProvenance; view: StoryView; onVersion: (version: number) => void; onExploration: (version: number) => void }) {
  const stats = a.stats as RevisionStats;
  const base = pv.baseVersion !== null ? v.architectures.find((x) => x.version === pv.baseVersion) : undefined;
  const angle = pv.angle && (
    <p>
      {pv.kind === 'REVISION' ? 'Revised toward' : 'Built on'} angle{' '}
      <button onClick={() => onExploration(pv.angle!.explorationVersion)} className="font-medium text-sky-800 underline decoration-dotted">
        {pv.angle.key} “{pv.angle.title}”
      </button>{' '}
      of exploration {pv.angle.explorationVersion}.
    </p>
  );
  const reserve = pv.reserveKeys.length > 0 && <p className="text-xs text-stone-500">Units it could use beyond the selection (approved, not selected): {pv.reserveKeys.join(', ')}.</p>;
  if (pv.kind === 'NEW') {
    if (!pv.angle) return null;
    return (
      <Section title="How this version came about">
        <div className="space-y-1 text-sm">
          {angle}
          {reserve}
        </div>
      </Section>
    );
  }
  const unaddressed = stats.revision?.unaddressed ?? [];
  return (
    <Section title={`Revision of v${pv.baseVersion}`}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            A new version revised from{' '}
            <button onClick={() => onVersion(pv.baseVersion!)} className="font-medium text-sky-800 underline decoration-dotted">
              v{pv.baseVersion}
            </button>
            {base && <span className="text-stone-500"> (now {lower(base.status)}, kept unchanged)</span>}.
          </span>
          {pv.diff && (pv.diff.substantial ? <span className={`${pill} bg-emerald-100 text-emerald-800`}>Substantial restructuring</span> : <span className={`${pill} bg-amber-100 text-amber-900`}>No structural change</span>)}
        </div>
        {angle}
        <div>
          <p className="text-xs font-medium text-stone-500 uppercase">The editor's brief</p>
          {pv.aspects.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {pv.aspects.map((x) => (
                <span key={x} className={`${pill} bg-sky-100 text-sky-900`}>
                  {REVISION_ASPECT_LABELS[x]}
                </span>
              ))}
            </div>
          )}
          <p className="mt-1 whitespace-pre-line">“{pv.brief}”</p>
        </div>

        {pv.changeLog && (
          <div>
            <p className="text-xs font-medium text-stone-500 uppercase">What the architect changed, and why</p>
            {pv.changeLog.summary && <p className="mt-1 font-medium">{pv.changeLog.summary}</p>}
            {pv.changeLog.changes.length > 0 && (
              <ul className="mt-2 space-y-2">
                {pv.changeLog.changes.map((c, i) => (
                  <li key={i} className="rounded border border-stone-200 p-2">
                    <span className={`${pill} bg-stone-800 text-white`}>{CHANGE_AREA_LABELS[c.area]}</span>
                    <p className="mt-1">{c.what}</p>
                    {c.why && <p className="text-stone-600">Why: {c.why}</p>}
                  </li>
                ))}
              </ul>
            )}
            {pv.changeLog.kept.length > 0 && (
              <p className="mt-2 text-stone-600">
                <span className="font-medium text-stone-700">Kept: </span>
                {pv.changeLog.kept.join('; ')}
              </p>
            )}
          </div>
        )}

        {pv.diff && (
          <div>
            <p className="text-xs font-medium text-stone-500 uppercase">What changed against v{pv.baseVersion} (measured, not the architect's account)</p>
            <MeasuredChanges diff={pv.diff} />
          </div>
        )}
        {unaddressed.length > 0 && (
          <p className="rounded bg-amber-50 px-2 py-1 text-amber-900">
            You flagged {unaddressed.map((x) => REVISION_ASPECT_LABELS[x].toLowerCase()).join(', ')}, but nothing measurable changed there. The architect's account above may explain a subtler change; check it before deciding.
          </p>
        )}
        {reserve}
        <p className="text-xs text-stone-600">
          Reviewed again on this revision: the Story Editor ({stats.storyIssues ?? 0} issue{stats.storyIssues === 1 ? '' : 's'}; {stats.revisedByStoryEditor ? 'its revision was kept' : 'no revision applied'}) and the Fact Checker ({stats.factIssues ?? 0} issue{stats.factIssues === 1 ? '' : 's'}; {stats.revisedByFactChecker ? 'its revision was kept' : 'no revision applied'}), then the architecture gate.
        </p>
      </div>
    </Section>
  );
}

const povLabel = (s: string) => {
  if (!s) return '—';
  const [type, ...rest] = s.split(': ');
  const label = POV_STRATEGY_LABELS[type as PovStrategy] ?? type;
  return rest.length ? `${label}: ${rest.join(': ')}` : label;
};
const modeLabel = (s: string) => (s ? (NARRATIVE_MODE_LABELS[s as NarrativeMode] ?? s) : '—');

function Changed({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <li className="rounded border border-stone-200 p-2">
      <p className="text-xs font-medium text-stone-500 uppercase">{label}</p>
      <p className="mt-1 text-stone-500">
        <span className="text-[10px] font-semibold uppercase">Before </span>
        {before || '—'}
      </p>
      <p>
        <span className="text-[10px] font-semibold text-sky-800 uppercase">After </span>
        {after || '—'}
      </p>
    </li>
  );
}

function Keys({ keys, tone }: { keys: string[]; tone: string }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {keys.map((k) => (
        <span key={k} className={`rounded px-1 font-mono text-xs ${tone}`}>
          {k}
        </span>
      ))}
    </span>
  );
}

/** The diff code computed between a revision and its base. */
export function MeasuredChanges({ diff: d }: { diff: ArchitectureDiff }) {
  const units: ReactNode[] = [];
  if (d.unitsAdded.length) units.push(<span key="add">added <Keys keys={d.unitsAdded} tone="bg-emerald-100 text-emerald-900" /></span>);
  if (d.unitsRemoved.length) units.push(<span key="rm">removed <Keys keys={d.unitsRemoved} tone="bg-red-100 text-red-900" /></span>);
  if (d.reordered) units.push(<span key="order">told in a different order</span>);
  for (const g of d.merged) units.push(<span key={`m${g.join()}`}>now told together: <Keys keys={g} tone="bg-stone-100" /></span>);
  for (const g of d.split) units.push(<span key={`s${g.join()}`}>now told apart: <Keys keys={g} tone="bg-stone-100" /></span>);
  const rows: [string, ArchitectureDiff['opening'], (s: string) => string][] = [
    ['Opening', d.opening, (s) => s],
    ['Central question', d.centralQuestion, (s) => s],
    ['Narrative mode', d.narrativeMode, modeLabel],
    ['Point of view', d.pov, povLabel],
    ['Logline', d.logline, (s) => s],
    ['Human stakes', d.humanStakes, (s) => s],
  ];
  const unchanged = rows.filter(([, c]) => !c.changed).map(([l]) => l.toLowerCase());
  return (
    <div className="mt-1 space-y-2">
      <p>
        <span className="font-medium">Structure:</span> {d.sequences.before} → {d.sequences.after} sequences · runtime {mmss(d.durationSec.before)} → {mmss(d.durationSec.after)} · {d.beats.before} → {d.beats.after} beats
        {d.reconstruction.before !== d.reconstruction.after && ` · reconstruction ${lower(d.reconstruction.before)} → ${lower(d.reconstruction.after)}`}
      </p>
      <p>
        <span className="font-medium">Story units:</span>{' '}
        {units.length === 0
          ? 'the same units, in the same order and grouping'
          : units.map((u, i) => (
              <span key={i}>
                {i > 0 && '; '}
                {u}
              </span>
            ))}
      </p>
      {(d.castAdded.length > 0 || d.castRemoved.length > 0) && (
        <p>
          <span className="font-medium">Cast:</span> {d.castAdded.length > 0 && `added ${d.castAdded.join(', ')}`}
          {d.castAdded.length > 0 && d.castRemoved.length > 0 && '; '}
          {d.castRemoved.length > 0 && `removed ${d.castRemoved.join(', ')}`}
        </p>
      )}
      <ul className="grid gap-2 md:grid-cols-2">
        {rows
          .filter(([, c]) => c.changed)
          .map(([label, c, show]) => (
            <Changed key={label} label={label} before={show(c.before)} after={show(c.after)} />
          ))}
      </ul>
      {unchanged.length > 0 && <p className="text-xs text-stone-500">Unchanged: {unchanged.join(', ')}.</p>}
      <details className="text-xs text-stone-600">
        <summary className="cursor-pointer">Sequences before and after</summary>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <ol className="list-decimal pl-5">
            {d.sequences.titlesBefore.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
          <ol className="list-decimal pl-5 text-stone-900">
            {d.sequences.titlesAfter.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </div>
      </details>
    </div>
  );
}

// ── Version history ──────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = {
  IN_REVIEW: 'bg-violet-100 text-violet-900',
  APPROVED: 'bg-emerald-600 text-white',
  REJECTED: 'bg-red-100 text-red-800',
  SUPERSEDED: 'bg-stone-100 text-stone-600',
  DRAFT: 'bg-amber-100 text-amber-900',
};

/** Every architecture version, kept: how each came about, and which one is shown. */
export function VersionHistory({ view: v, shown, onVersion }: { view: StoryView; shown: number | null; onVersion: (version: number) => void }) {
  if (v.architectures.length < 2) return null;
  return (
    <details className="rounded-lg border border-stone-200 bg-white p-3 text-sm" open>
      <summary className="cursor-pointer font-medium text-stone-700">All versions ({v.architectures.length}) — every version is kept</summary>
      <ul className="mt-2 divide-y divide-stone-100">
        {v.architectures.map((x) => (
          <li key={x.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ${x.version === shown ? 'font-medium' : ''}`}>
            <button onClick={() => onVersion(x.version)} disabled={x.version === shown} className="font-mono text-sky-800 underline decoration-dotted disabled:text-stone-900 disabled:no-underline">
              v{x.version}
            </button>
            <span className={`${pill} ${STATUS_TONE[x.status] ?? 'bg-stone-100'}`}>{lower(x.status)}</span>
            {!x.qualityPassed && <span className={`${pill} bg-red-100 text-red-800`}>gate failed</span>}
            <span className="text-stone-600">
              {x.origin === 'REVISION' ? `revision of v${x.revisionOfVersion ?? '?'}` : ARCHITECTURE_ORIGIN_LABELS.NEW.toLowerCase()}
              {x.angle && ` · angle ${x.angle.key}${x.angle.title ? ` “${x.angle.title}”` : ''} (exploration ${x.angle.explorationVersion})`}
              {` · pack v${x.packVersion ?? '—'} · ${x.sequenceCount} sequences`}
            </span>
            <span className="text-xs text-stone-400">{formatDate(x.createdAt)}</span>
            {x.version === shown && <span className="text-xs text-stone-500">(shown)</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-stone-500">A revision replaces the version under review only when it passes its gate. Approving a version supersedes an earlier approved one; nothing is deleted or overwritten.</p>
    </details>
  );
}
