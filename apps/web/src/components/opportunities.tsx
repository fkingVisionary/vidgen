import {
  CONTENT_FORMAT_LABELS,
  OPPORTUNITY_SCORE_KEYS,
  OPPORTUNITY_SCORE_LABELS,
  OPPORTUNITY_SCORE_WEIGHTS,
  OPPORTUNITY_STATUS_LABELS,
  type ContentFormat,
  type ContentOpportunityView,
  type ContentPackageView,
  type OpportunityStatus,
  type StoryArchitectureView,
} from '@docengine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { HistoricalBadge } from './badges.tsx';
import { ClaimRefs, Section, type SourceLike } from './evidence.tsx';
import { SourceList } from './architecture-v2.tsx';
import { Field, PresentationBadge } from './story-v2.tsx';

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
const mmss = (sec: number | null) => (sec === null ? 'open' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);

const FORMAT_TONE: Record<ContentFormat, string> = {
  SHORT: 'bg-pink-600 text-white',
  BOTH: 'bg-indigo-600 text-white',
  LONG_FORM: 'bg-stone-700 text-white',
};
const STATUS_TONE: Record<OpportunityStatus, string> = {
  PROPOSED: 'bg-stone-100 text-stone-600',
  APPROVED: 'bg-emerald-600 text-white',
  REJECTED: 'bg-red-600 text-white',
};

type Shown = 'all' | 'shorts' | 'long';

/**
 * Content opportunities identified in an architecture: shorts (and long-form
 * threads) ranked by short-form potential, each traced to architecture beats
 * and through them to the approved dossier. The editor approves or rejects
 * each one; nothing is generated.
 */
export function OpportunitiesTab({ projectId, architecture: a, latest }: { projectId: string; architecture: StoryArchitectureView; latest: boolean }) {
  const [shown, setShown] = useState<Shown>('all');
  const [top, setTop] = useState<number | 'all'>('all');
  const [hideRejected, setHideRejected] = useState(false);
  const sources = useMemo(() => new Map<string, SourceLike>(a.evidence.sources.map((s) => [s.id, s])), [a.evidence.sources]);
  const decidable = latest && (a.status === 'IN_REVIEW' || a.status === 'APPROVED');
  const all = a.opportunityList;
  const shorts = all.filter((o) => o.format !== 'LONG_FORM');
  const longForm = all.filter((o) => o.format === 'LONG_FORM');
  const list = [...(shown === 'long' ? [] : top === 'all' ? shorts : shorts.slice(0, top)), ...(shown === 'shorts' ? [] : longForm)].filter((o) => !hideRejected || o.status !== 'REJECTED');

  if (a.engineVersion !== 2) return <p className="text-sm text-stone-500">Architecture v{a.version} was built by story engine 1, which does not identify content opportunities. Generate a new architecture to find them.</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        {shorts.length} short-form and {longForm.length} long-form opportunities identified in architecture v{a.version}, ranked by short-form potential. Each one is built from the architecture's beats and the approved claims behind them, and keeps their presentation. Approve or reject each one: only approved opportunities on an approved architecture are eligible for a content package. Nothing is generated here — no scripts, voice, video, captions or exports.
      </p>
      {all.length === 0 && <p className="text-sm text-stone-500">No opportunities were identified{a.qualityPassed ? '' : ' (they are identified only when the architecture passes its gate)'}.</p>}
      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {(['all', 'shorts', 'long'] as const).map((x) => (
            <button key={x} onClick={() => setShown(x)} className={`rounded-full px-3 py-1 ${shown === x ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'}`}>
              {x === 'all' ? 'All' : x === 'shorts' ? `Shorts (${shorts.length})` : `Long-form (${longForm.length})`}
            </button>
          ))}
          <label className="flex items-center gap-1">
            Top
            <select value={String(top)} onChange={(e) => setTop(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="rounded-md border border-stone-300 px-2 py-1">
              {[3, 6, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="all">all</option>
            </select>
            shorts
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={hideRejected} onChange={(e) => setHideRejected(e.target.checked)} /> hide rejected
          </label>
        </div>
      )}
      {!decidable && all.length > 0 && <p className="text-xs text-stone-500">Read only: opportunities are decided on the latest architecture that passed its gate, while it is in review or approved.</p>}
      {list.map((o) => (
        <OpportunityCard key={o.id} opportunity={o} architecture={a} sources={sources} decidable={decidable} />
      ))}
      {all.length > 0 && <PackagePreview projectId={projectId} />}
    </div>
  );
}

function OpportunityCard({ opportunity: o, architecture: a, sources, decidable }: { opportunity: ContentOpportunityView; architecture: StoryArchitectureView; sources: Map<string, SourceLike>; decidable: boolean }) {
  const [notes, setNotes] = useState(o.editorNotes ?? '');
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: { status?: OpportunityStatus; editorNotes?: string | null }) => api.updateOpportunity(o.id, input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['story'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
  const c = o.content;
  const units = c?.candidateKeys ?? [];
  return (
    <article data-opportunity={o.key} className={`rounded-lg border bg-white p-4 ${o.status === 'APPROVED' ? 'border-emerald-400 ring-1 ring-emerald-200' : 'border-stone-200'} ${o.status === 'REJECTED' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-stone-500">{o.key}</span>
            {o.rank !== null && <span className="font-semibold text-stone-700">#{o.rank}</span>}
            <span className={`${pill} ${FORMAT_TONE[o.format]}`}>{CONTENT_FORMAT_LABELS[o.format]}</span>
            <span className={`${pill} ${STATUS_TONE[o.status]}`}>{OPPORTUNITY_STATUS_LABELS[o.status]}</span>
            <HistoricalBadge status={o.historicalStatus} confidence={o.historicalConfidence} />
            {o.eligible && <span className={`${pill} bg-emerald-100 text-emerald-800`}>eligible for a package</span>}
            <span className="text-stone-500">{mmss(o.targetDurationSec)}</span>
            <span className="text-stone-500">{o.independent ? 'stands alone' : 'needs the documentary'}</span>
          </div>
          <h3 className="mt-1 text-lg font-semibold">{o.title}</h3>
          <p className="text-stone-800 italic">{o.hook}</p>
          <p className="mt-1 text-sm">
            <span className="font-semibold text-violet-800">Central question: </span>
            {o.centralQuestion}
          </p>
        </div>
        {o.shortScore !== null && (
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{o.shortScore.toFixed(1)}</div>
            <div className="text-xs text-stone-500">short-form potential</div>
          </div>
        )}
      </div>

      {c && (
        <>
          <dl className="mt-2 space-y-0.5 text-sm">
            <Field label="Premise">{c.standalonePremise}</Field>
            <Field label="Angle">{c.angle || '—'}</Field>
            <Field label="Escalation">{c.escalation || '—'}</Field>
            <Field label="Payoff">{c.payoff || '—'}</Field>
            <Field label="Ending">{c.suggestedEnding || '—'}</Field>
            <Field label="Visual">{c.visualConcept || '—'}</Field>
            {o.requiresContext && <Field label="Needs first">{c.contextNote || 'The long-form documentary'}</Field>}
            {c.whyItWorks && <Field label="Why it works">{c.whyItWorks}</Field>}
          </dl>
          {c.presentation.length > 0 && (
            <div className="mt-2 rounded border border-orange-200 bg-orange-50 p-2 text-sm">
              <p className="text-xs font-semibold tracking-wide text-orange-800 uppercase">Presentation (from the architecture)</p>
              <ul className="mt-1 space-y-1">
                {c.presentation.map((x) => (
                  <li key={x.claimKey} className="flex flex-wrap items-center gap-1.5">
                    <ClaimRefs keys={[x.claimKey]} claims={a.evidence.claims} link={false} /> <PresentationBadge presentation={x.presentation} /> {x.instruction}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-stone-600">
              Traced to beats {c.beatIds.join(', ')} (sequence {c.sequenceNumbers.join(', ')}{units.length ? `; units ${units.join(', ')}` : ''}) · {c.claimKeys.length} claim(s), {c.sourceIds.length} source(s) <ClaimRefs keys={c.claimKeys} claims={a.evidence.claims} link={false} />
            </summary>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              {o.format !== 'LONG_FORM' && (
                <table className="w-full text-xs">
                  <tbody>
                    {OPPORTUNITY_SCORE_KEYS.map((k) => (
                      <tr key={k}>
                        <td className="w-40 py-0.5 text-stone-600">
                          {OPPORTUNITY_SCORE_LABELS[k]} <span className="text-stone-400">×{OPPORTUNITY_SCORE_WEIGHTS[k]}</span>
                        </td>
                        <td className="py-0.5">
                          <div className="h-2 rounded bg-stone-100">
                            <div className="h-2 rounded bg-pink-600" style={{ width: `${c.scores[k] * 10}%` }} />
                          </div>
                        </td>
                        <td className="w-8 py-0.5 text-right tabular-nums">{c.scores[k]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <SourceList ids={c.sourceIds} sources={sources} />
            </div>
            {c.notes.length > 0 && <p className="mt-2 text-xs text-stone-500">Rules applied: {c.notes.join('; ')}</p>}
          </details>
        </>
      )}

      {decidable ? (
        <div className="mt-3 space-y-2 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={update.isPending || o.status === 'APPROVED'} onClick={() => update.mutate({ status: 'APPROVED' })} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
              Approve
            </button>
            <button disabled={update.isPending || o.status === 'REJECTED'} onClick={() => update.mutate({ status: 'REJECTED' })} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
              Reject
            </button>
            {o.status !== 'PROPOSED' && (
              <button disabled={update.isPending} onClick={() => update.mutate({ status: 'PROPOSED' })} className={`${button} text-stone-500 hover:text-stone-800`}>
                Undo decision
              </button>
            )}
            {o.decidedBy && <span className="text-xs text-stone-500">decided by {o.decidedBy}</span>}
          </div>
          <div className="flex gap-2">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Editor's notes" className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1 text-sm" />
            <button disabled={update.isPending || notes === (o.editorNotes ?? '')} onClick={() => update.mutate({ editorNotes: notes.trim() || null })} className={`${button} bg-stone-800 text-white`}>
              Save notes
            </button>
          </div>
          {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
        </div>
      ) : (
        o.editorNotes && <p className="mt-2 text-xs text-stone-600">Editor: “{o.editorNotes}”</p>
      )}
    </article>
  );
}

/** What a production request would receive today (API-first: the same request works over HTTP). */
function PackagePreview({ projectId }: { projectId: string }) {
  const [documentary, setDocumentary] = useState(true);
  const [shorts, setShorts] = useState<number | 'all'>(6);
  const [languages, setLanguages] = useState('en');
  const codes = languages
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const request = { documentary, shorts, languages: codes };
  const preview = useMutation({ mutationFn: () => api.contentPackage(projectId, request) });
  const pkg: ContentPackageView | undefined = preview.data;
  return (
    <Section title="Content package preview">
      <p className="text-sm text-stone-600">Resolves which approved outputs a production request would use. Read only: nothing is generated, and languages are only recorded (localization is not built yet).</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={documentary} onChange={(e) => setDocumentary(e.target.checked)} /> documentary
        </label>
        <label className="flex items-center gap-1">
          shorts
          <select value={String(shorts)} onChange={(e) => setShorts(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="rounded-md border border-stone-300 px-2 py-1">
            {[0, 3, 6, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="all">all eligible</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          languages
          <input value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="en,es,de" className="w-28 rounded-md border border-stone-300 px-2 py-1" />
        </label>
        <button disabled={preview.isPending} onClick={() => preview.mutate()} className={`${button} bg-stone-800 text-white`}>
          Preview
        </button>
      </div>
      <p className="mt-2 font-mono text-xs break-all text-stone-500">
        POST /api/projects/{projectId}/content-package {JSON.stringify(request)}
      </p>
      {preview.error && <p className="mt-2 text-sm text-red-700">{preview.error.message}</p>}
      {pkg && (
        <div className="mt-3 space-y-1 text-sm">
          <p>
            Documentary: {pkg.documentary.included ? `included (architecture v${pkg.architecture?.version})` : pkg.documentary.eligible ? 'not requested' : pkg.documentary.reason}
          </p>
          <p>
            Shorts: {pkg.shorts.returned} of {pkg.shorts.available} eligible{pkg.shorts.items.length > 0 && ` — ${pkg.shorts.items.map((o) => `${o.key} ${o.title}`).join('; ')}`}
          </p>
          {pkg.longForm.length > 0 && <p>Long-form threads: {pkg.longForm.map((o) => `${o.key} ${o.title}`).join('; ')}</p>}
          <p className="text-xs text-stone-500">{pkg.languages.note}</p>
          {pkg.notes.map((n, i) => (
            <p key={i} className="text-xs text-stone-500">
              {n}
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}
