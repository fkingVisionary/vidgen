import {
  NARRATIVE_MODE_LABELS,
  POV_STRATEGY_LABELS,
  type ProjectDetailView,
  type StoryAngle,
  type StoryExplorationView,
  type StoryView,
} from '@docengine/core';
import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { formatDate, formatUsd } from '../format.ts';
import { HistoricalBadge } from './badges.tsx';
import { ClaimCard, ClaimRefs, QualityReportView, Section, type SourceLike } from './evidence.tsx';
import { useStoryRequest } from './revision.tsx';
import { ClassBadge, Field } from './story-v2.tsx';

/**
 * Explore alternative angles: 2–3 materially different ways to tell the same
 * curated story units, to compare before committing to an architecture. An
 * angle uses only units of the story pack and their approved claims — no new
 * research — and commits to nothing until the editor develops it.
 */

const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

interface Navigation {
  onExploration: (version: number) => void;
  onVersion: (version: number) => void;
  /** A new exploration was requested: show the newest. */
  onExplorationQueued: () => void;
  /** A new architecture version was requested: show the newest. */
  onArchitectureQueued: () => void;
}

export function AnglesTab({ project: p, view: v, nav }: { project: ProjectDetailView; view: StoryView; nav: Navigation }) {
  // Jobs are newest first: the latest STORY_ANGLES job tells whether one is running or failed.
  const job = p.jobs.find((j) => j.type === 'STORY_ANGLES');
  const running = job !== undefined && (job.status === 'QUEUED' || job.status === 'RUNNING');
  const retry = useStoryRequest((jobId: string) => api.retryJob(jobId));
  const progress = p.events.find((e) => e.type === 'JOB_PROGRESS');
  return (
    <div className="space-y-4">
      <ExploreForm project={p} view={v} running={running} onQueued={nav.onExplorationQueued} />
      {running && (
        <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">
          <p className="font-medium">Exploring alternative angles… The project's status does not change.</p>
          {progress && <p className="mt-1 text-xs">Latest: {progress.message}</p>}
        </div>
      )}
      {job?.status === 'FAILED' && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          <p>The last angle exploration failed. The project is unaffected.</p>
          {job.error && <p className="mt-1 text-xs break-words">{job.error}</p>}
          <button disabled={retry.isPending || !v.editorial.angles.allowed} onClick={() => retry.mutate(job.id)} className={`${button} mt-2 bg-red-700 text-white hover:bg-red-600`}>
            Retry
          </button>
          <p className="mt-1 text-xs">Retry reuses completed model calls (they are not paid again) and checks their output again with the current rules.</p>
          {retry.error && <p className="mt-1 text-sm text-red-700">{retry.error.message}</p>}
        </div>
      )}
      {v.exploration ? (
        <Exploration project={p} view={v} exploration={v.exploration} nav={nav} />
      ) : (
        <p className="text-sm text-stone-500">No angles explored yet.</p>
      )}
    </div>
  );
}

function ExploreForm({ project: p, view: v, running, onQueued }: { project: ProjectDetailView; view: StoryView; running: boolean; onQueued: () => void }) {
  const current = v.packs[0]?.version;
  const ofPack = v.architectures.filter((a) => a.packVersion === current);
  const [count, setCount] = useState<2 | 3>(3);
  const [notes, setNotes] = useState('');
  const [basedOn, setBasedOn] = useState<string>('latest');
  const basedOnVersion = basedOn === 'none' ? undefined : basedOn === 'latest' ? ofPack[0]?.version : Number(basedOn);
  const explore = useStoryRequest(
    () => api.exploreAngles(p.id, { count, ...(notes.trim() ? { notes: notes.trim() } : {}), ...(basedOnVersion ? { basedOnVersion } : {}) }),
    () => {
      setNotes('');
      onQueued();
    },
  );
  const blocked = v.editorial.angles.reason;
  return (
    <section className="space-y-2 rounded-lg border border-stone-200 bg-white p-4 text-sm">
      <h2 className="font-semibold">Explore Alternative Angles</h2>
      <p className="text-stone-700">
        Before committing to one approach, compare 2–3 materially different ways to tell the same story units — a different narrative mode, point of view, opening, human anchor or central question. Angles use only the story pack (the units you selected, plus units you approved but did not
        select) and their approved claims: no new research, no new facts. The rules remove an angle that brings in anything else, or that is the same film in other words. Nothing is committed and the project's status does not change; develop the angle you choose into an architecture.
      </p>
      {blocked ? (
        <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{blocked}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2">
              {([2, 3] as const).map((n) => (
                <label key={n} className="flex items-center gap-1">
                  <input type="radio" name="angle-count" checked={count === n} onChange={() => setCount(n)} />
                  {n} angles
                </label>
              ))}
            </span>
            {ofPack.length > 0 && (
              <select value={basedOn} onChange={(e) => setBasedOn(e.target.value)} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Alternatives to">
                <option value="latest">As alternatives to the current architecture (v{ofPack[0]!.version})</option>
                {ofPack.slice(1).map((a) => (
                  <option key={a.id} value={a.version}>
                    As alternatives to v{a.version}
                  </option>
                ))}
                <option value="none">From the story pack only</option>
              </select>
            )}
          </div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Brief for the exploration (optional) — e.g. one angle should follow the buyers, another the courts" className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
          <button disabled={explore.isPending || running} onClick={() => explore.mutate(undefined)} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
            Explore Alternative Angles
          </button>
        </>
      )}
      {explore.error && <p className="text-sm text-red-700">{explore.error.message}</p>}
    </section>
  );
}

function Exploration({ project: p, view: v, exploration: e, nav }: { project: ProjectDetailView; view: StoryView; exploration: StoryExplorationView; nav: Navigation }) {
  const c = e.content;
  const sources = useMemo(() => new Map<string, SourceLike>(e.evidence.sources.map((s) => [s.id, s])), [e.evidence.sources]);
  // Unit titles, when the shown pack is the one the angles were explored from.
  const titles = useMemo(() => new Map(v.pack && v.pack.version === e.packVersion ? v.pack.candidates.map((x) => [x.key, x.title]) : []), [v.pack, e.packVersion]);
  const stale = e.packVersion !== v.packs[0]?.version;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {v.explorations.length > 1 ? (
          <select value={e.version} onChange={(x) => nav.onExploration(Number(x.target.value))} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Angle exploration">
            {v.explorations.map((x) => (
              <option key={x.id} value={x.version}>
                Exploration {x.version} — pack v{x.packVersion} — {x.angleCount} angles{x.basedOnVersion ? ` — alternatives to v${x.basedOnVersion}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-medium">Exploration {e.version}</span>
        )}
        <span className={`${pill} font-semibold ${e.qualityPassed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>Angles gate {e.qualityPassed ? 'passed' : 'FAILED'}</span>
        <span className="text-stone-600">
          from pack v{e.packVersion}
          {c && ` · ${c.poolKeys.length - c.reserveKeys.length} selected units${c.reserveKeys.length ? ` + ${c.reserveKeys.length} approved in reserve` : ''}`}
          {e.basedOnVersion && ` · alternatives to v${e.basedOnVersion}`} · {formatUsd(e.cost.totalUsd)}
          {e.cost.includesEstimates && ' (estimated)'} · {formatDate(e.createdAt)}
        </span>
      </div>
      {c?.editorNotes && <p className="text-sm text-stone-600">Brief: “{c.editorNotes}”</p>}
      {stale && <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">Explored from story pack v{e.packVersion}; a newer mining pass replaced it. Its angles can be read, not developed: explore again for angles of the current pack.</p>}
      {!stale && e.poolChanged && (
        <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">
          The selection has changed since these angles were explored. Developing one uses the current selection (and approved units): units that left it are no longer available to the architect.
        </p>
      )}
      {!c ? (
        <p className="text-sm text-red-700">The stored exploration could not be read.</p>
      ) : (
        <>
          {c.angles.length === 0 && <p className="text-sm text-stone-500">No angle survived the rules (see below).</p>}
          <div className="grid gap-4 xl:grid-cols-2">
            {c.angles.map((a) => (
              <AngleCard
                key={a.key}
                project={p}
                view={v}
                exploration={e}
                angle={a}
                reserve={c.reserveKeys}
                titles={titles}
                claims={e.evidence.claims}
                sources={sources}
                developed={e.developed.filter((d) => d.key === a.key).map((d) => d.architectureVersion)}
                stale={stale}
                nav={nav}
              />
            ))}
          </div>
          {c.comparisons.length > 0 && (
            <Section title="How the angles differ (computed)">
              <ul className="space-y-1 text-sm">
                {c.comparisons.map((x) => (
                  <li key={`${x.a}-${x.b}`}>
                    <span className="font-mono text-xs font-semibold">
                      {x.a} ↔ {x.b}
                    </span>{' '}
                    — {x.differences.length ? x.differences.join(', ') : 'wording only'}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {c.removed.length > 0 && (
            <Section title={`Removed by the rules (${c.removed.length})`}>
              <ul className="space-y-1 text-sm">
                {c.removed.map((r, i) => (
                  <li key={i}>
                    <span className="font-medium">{r.title}</span> — <span className="text-stone-600">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {e.qualityReport && (
            <details className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
              <summary className="cursor-pointer font-medium text-stone-700">Angles gate report</summary>
              <div className="mt-2">
                <QualityReportView report={e.qualityReport} claims={e.evidence.claims} reviewTitle="Review" />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function UnitChip({ unitKey, reserve, titles }: { unitKey: string; reserve: boolean; titles: Map<string, string> }) {
  return (
    <span className={`rounded px-1 font-mono text-xs ${reserve ? 'bg-amber-100 text-amber-900' : 'bg-stone-100'}`} title={`${titles.get(unitKey) ?? unitKey}${reserve ? ' — approved by the editor, not selected' : ''}`}>
      {unitKey}
    </span>
  );
}

function AngleCard({
  project: p,
  view: v,
  exploration: e,
  angle: a,
  reserve,
  titles,
  claims,
  sources,
  developed,
  stale,
  nav,
}: {
  project: ProjectDetailView;
  view: StoryView;
  exploration: StoryExplorationView;
  angle: StoryAngle;
  reserve: string[];
  titles: Map<string, string>;
  claims: StoryExplorationView['evidence']['claims'];
  sources: Map<string, SourceLike>;
  developed: number[];
  stale: boolean;
  nav: Navigation;
}) {
  const own = claims.filter((c) => a.claimKeys.includes(c.key));
  return (
    <article className="min-w-0 space-y-3 rounded-lg border border-stone-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-stone-900 px-1.5 py-0.5 font-mono text-xs font-semibold text-white">{a.key}</span>
        <h3 className="text-base font-semibold">{a.title}</h3>
        <HistoricalBadge status={a.historicalStatus} confidence={a.historicalConfidence} />
      </div>
      <p className="text-base">{a.logline}</p>
      <p className="text-lg font-semibold text-violet-900">{a.centralQuestion}</p>
      <dl className="space-y-1">
        <Field label="Emotional centre">{a.emotionalCentre || '—'}</Field>
        <Field label="Human anchor">{a.humanAnchor || '—'}</Field>
        <Field label="Told as">
          <span className="font-medium">{NARRATIVE_MODE_LABELS[a.narrativeMode]}</span>
          {a.secondaryModes.length > 0 && <span className="text-stone-600"> with {a.secondaryModes.map((m) => NARRATIVE_MODE_LABELS[m].toLowerCase()).join(', ')}</span>}
        </Field>
        <Field label="Point of view">
          <span className="font-medium">{POV_STRATEGY_LABELS[a.povStrategy.type]}</span>
          {a.povStrategy.description && <span className="text-stone-600"> — {a.povStrategy.description}</span>}
        </Field>
        <Field label="Opening">
          <span className="mr-1">
            <ClassBadge basis={a.opening.basis} />
          </span>
          {a.opening.concept}
          {a.opening.unitKey && (
            <span className="ml-1">
              <UnitChip unitKey={a.opening.unitKey} reserve={reserve.includes(a.opening.unitKey)} titles={titles} />
            </span>
          )}
        </Field>
        <Field label="Resolution">{a.resolution || '—'}</Field>
      </dl>
      <div>
        <p className="text-xs font-medium text-stone-500 uppercase">Movements</p>
        <ol className="mt-1 space-y-1.5">
          {a.movements.map((m, i) => (
            <li key={i} className="border-l-2 border-sky-300 pl-2">
              <span className="font-medium">
                {i + 1}. {m.title}
              </span>{' '}
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {m.unitKeys.map((k) => (
                  <UnitChip key={k} unitKey={k} reserve={reserve.includes(k)} titles={titles} />
                ))}
              </span>
              {m.what && <p className="text-stone-700">{m.what}</p>}
            </li>
          ))}
        </ol>
      </div>
      <div className="space-y-1">
        <p>
          <span className="text-xs font-medium text-stone-500 uppercase">Units told </span>
          <span className="inline-flex flex-wrap gap-1 align-middle">
            {a.unitKeys.map((k) => (
              <UnitChip key={k} unitKey={k} reserve={reserve.includes(k)} titles={titles} />
            ))}
          </span>
        </p>
        {a.unusedUnits.length > 0 && (
          <div>
            <p className="text-xs font-medium text-stone-500 uppercase">Selected units left out</p>
            <ul className="mt-0.5 space-y-0.5">
              {a.unusedUnits.map((u) => (
                <li key={u.unitKey}>
                  <span className="font-mono text-xs">{u.unitKey}</span> {titles.get(u.unitKey) && <span className="text-stone-500">{titles.get(u.unitKey)}</span>} — {u.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p>
          <span className="text-xs font-medium text-stone-500 uppercase">Evidence </span>
          {a.claimKeys.length} claims of these units
          <ClaimRefs keys={a.claimKeys} claims={claims} link={false} />
        </p>
      </div>
      {a.differs && (
        <p>
          <span className="text-xs font-medium text-stone-500 uppercase">How it differs </span>
          {a.differs}
        </p>
      )}
      {(a.strengths.length > 0 || a.risks.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-emerald-800 uppercase">Strengths</p>
            <ul className="list-disc pl-5">
              {a.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium text-red-800 uppercase">Risks</p>
            <ul className="list-disc pl-5">
              {a.risks.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {a.warnings.map((w, i) => (
        <p key={i} className="rounded bg-amber-50 px-2 py-1 text-amber-900">
          {w}
        </p>
      ))}
      {a.notes.length > 0 && <p className="text-xs text-stone-500">Adjusted by the rules: {a.notes.join('; ')}.</p>}
      {own.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-stone-600">The claims behind this angle ({own.length})</summary>
          <div className="mt-2 space-y-2">
            {own.map((c) => (
              <ClaimCard key={c.key} claim={c} sources={sources} anchor={false} />
            ))}
          </div>
        </details>
      )}
      {developed.length > 0 && (
        <p className="text-sm">
          Developed as{' '}
          {developed.map((n, i) => (
            <span key={n}>
              {i > 0 && ', '}
              <button onClick={() => nav.onVersion(n)} className="font-medium text-sky-800 underline decoration-dotted">
                architecture v{n}
              </button>
            </span>
          ))}
          .
        </p>
      )}
      {!stale && <DevelopAngle project={p} view={v} exploration={e} angle={a} onQueued={nav.onArchitectureQueued} />}
    </article>
  );
}

/**
 * Commit to an angle: during story selection, build an architecture on it;
 * once an architecture exists (in review, approved, or after a failed run),
 * revise a version toward it — a new version, the old one kept.
 */
function DevelopAngle({ project: p, view: v, exploration: e, angle: a, onQueued }: { project: ProjectDetailView; view: StoryView; exploration: StoryExplorationView; angle: StoryAngle; onQueued: () => void }) {
  const fresh = p.status === 'STORY_SELECTION';
  const ofPack = v.architectures.filter((x) => x.packVersion === v.packs[0]?.version);
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState<number | null>(null);
  const [brief, setBrief] = useState(`Develop angle ${a.key} “${a.title}”: ${a.logline}`);
  const baseVersion = base ?? ofPack[0]?.version ?? null;
  const ref = { exploration: e.version, key: a.key };
  const develop = useStoryRequest(
    () => (fresh ? api.buildArchitecture(p.id, { angle: ref, ...(brief.trim() ? { notes: brief.trim() } : {}) }) : api.reviseArchitecture(p.id, { baseVersion: baseVersion!, brief: brief.trim(), aspects: ['ANGLE'], angle: ref })),
    () => {
      setOpen(false);
      onQueued();
    },
  );
  const blocked = fresh ? (v.editorial.angles.allowed ? null : v.editorial.angles.reason) : v.editorial.revise.reason;
  const short = !fresh && brief.trim().length < 10;
  if (!open) {
    return (
      <div className="border-t border-stone-100 pt-3">
        <button disabled={blocked !== null} onClick={() => setOpen(true)} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
          Develop this angle…
        </button>
        {blocked && <span className="ml-2 text-xs text-amber-700">{blocked}</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t border-stone-100 pt-3">
      <p className="text-xs text-stone-600">
        {fresh
          ? `Builds a new architecture on angle ${a.key} from the current selection: the architect follows the angle and may also use units you approved but did not select. Every earlier version is kept.`
          : `Revises v${baseVersion} toward angle ${a.key}: a new version from the same story pack, reviewed again by the Story Editor and the Fact Checker. v${baseVersion} is kept unchanged.`}
      </p>
      {!fresh && ofPack.length > 1 && (
        <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center">
          <span className="text-stone-600">Revise from</span>
          <select value={baseVersion ?? ''} onChange={(x) => setBase(Number(x.target.value))} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm">
            {ofPack.map((x) => (
              <option key={x.id} value={x.version}>
                v{x.version} ({x.status.toLowerCase().replace('_', ' ')})
              </option>
            ))}
          </select>
        </label>
      )}
      <textarea value={brief} onChange={(x) => setBrief(x.target.value)} rows={3} aria-label={fresh ? 'Instructions for the architect' : 'Editorial brief'} className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
      <div className="flex flex-wrap gap-2">
        <button disabled={develop.isPending || short || (!fresh && baseVersion === null)} onClick={() => develop.mutate(undefined)} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
          {fresh ? 'Build an architecture on this angle' : `Revise v${baseVersion} toward ${a.key}`}
        </button>
        <button onClick={() => setOpen(false)} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
          Cancel
        </button>
      </div>
      {short && <p className="text-xs text-stone-500">The brief needs at least a sentence.</p>}
      {develop.error && <p className="text-sm text-red-700">{develop.error.message}</p>}
    </div>
  );
}
