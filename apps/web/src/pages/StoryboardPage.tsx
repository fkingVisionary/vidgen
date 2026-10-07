import type { StoryboardView } from '@docengine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { ProjectNav } from '../components/ProjectNav.tsx';
import { StoryboardStatusBadge, type EditContext } from '../components/storyboard.tsx';
import { InputsStrip, StoryboardActions } from '../components/storyboard-actions.tsx';
import { CostsTab } from '../components/storyboard-costs.tsx';
import { ContinuityTab, EvidenceTab, QaTab } from '../components/storyboard-evidence.tsx';
import { OverviewTab } from '../components/storyboard-overview.tsx';
import { ShotsTab } from '../components/storyboard-shots.tsx';
import { TimelineTab } from '../components/storyboard-timeline.tsx';
import { findingCounts, versionLabel } from '../storyboard-plan.ts';

const TABS = ['overview', 'timeline', 'shots', 'costs', 'evidence', 'continuity', 'qa'] as const;
type Tab = (typeof TABS)[number];
const isTab = (t: string | null): t is Tab => (TABS as readonly string[]).includes(t ?? '');

/** The queries a change on this page can make stale. */
const KEYS = ['storyboard', 'storyboard-inputs', 'project', 'projects', 'visual-selection', 'visual-profiles', 'visual-profile'];

/**
 * The storyboard: what the viewer sees, when, why, and how it would be
 * produced, timed on the narration's real audio. Every version is kept
 * as it was saved — a plan, a re-plan, an edit, a re-timing or a restore
 * makes a new one — and is approved by a person, version by version,
 * never automatically. Nothing is generated here: no picture, video,
 * voice or render; every cost is a forecast. /projects/:id/storyboard?v=N&tab=…
 */
export function StoryboardPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requested = params.get('v') ? Number(params.get('v')) : undefined;
  const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'overview';
  const [focus, setFocus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 1_500 : 10_000),
  });
  const running = project.data?.jobs.some((j) => (j.type === 'VISUAL_PLAN' || j.type === 'STORYBOARD_PREVIEW') && (j.status === 'QUEUED' || j.status === 'RUNNING')) ?? false;
  const storyboard = useQuery({ queryKey: ['storyboard', id, requested], queryFn: () => api.storyboard(id, requested), refetchInterval: running ? 2_000 : false });
  const inputs = useQuery({ queryKey: ['storyboard-inputs', id], queryFn: () => api.storyboardInputs(id) });
  // A storyboard job started or finished: read the page again (a new version appears when it is saved).
  const stamp = project.data ? `${project.data.status}|${project.data.jobs.filter((j) => j.type === 'VISUAL_PLAN' || j.type === 'STORYBOARD_PREVIEW').map((j) => `${j.id}:${j.status}`).join(',')}` : null;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (stamp !== null && last.current !== null && last.current !== stamp) for (const key of ['storyboard', 'storyboard-inputs']) void queryClient.invalidateQueries({ queryKey: [key] });
    last.current = stamp;
  }, [stamp, queryClient]);

  if (project.isPending || storyboard.isPending || inputs.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (project.isError) return <p className="text-sm text-red-700">Could not load the project: {project.error.message}</p>;
  if (storyboard.isError)
    return (
      <p className="text-sm text-red-700">
        Could not load the storyboard: {storyboard.error.message}{' '}
        {requested && (
          <Link to={`/projects/${id}/storyboard`} className="underline">
            Open the newest version
          </Link>
        )}
      </p>
    );
  if (inputs.isError) return <p className="text-sm text-red-700">Could not load what a storyboard is planned from: {inputs.error.message}</p>;
  const p = project.data;
  const view = storyboard.data;
  const v = view.storyboard;
  const newest = view.versions[0]?.version ?? 0;

  const go = (change: { v?: number | null; tab?: Tab }) => {
    const next = new URLSearchParams(params);
    if (change.v !== undefined) {
      if (change.v === null) next.delete('v');
      else next.set('v', String(change.v));
    }
    if (change.tab) next.set('tab', change.tab);
    setParams(next);
  };
  const reload = () => {
    go({ v: null });
    for (const key of KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const saved = (next: StoryboardView) => {
    if (!next.storyboard) return;
    queryClient.setQueryData(['storyboard', id, next.storyboard.version], next);
    go({ v: next.storyboard.version });
  };
  const openShot = (key: string) => {
    setFocus(key);
    go({ tab: 'shots' });
  };
  const ctx: EditContext | null = v ? { storyboardId: v.id, version: v.version, newest, allowed: view.editorial.edit, onSaved: saved, onReload: reload } : null;
  const live = v ? findingCounts(v.qa.live) : null;
  const labels: Record<Tab, string> = {
    overview: 'Overview',
    timeline: 'Timeline',
    shots: v ? `Shots (${v.shotCount})` : 'Shots',
    costs: 'Costs',
    evidence: 'Evidence',
    continuity: v ? `Continuity (${v.continuity.length})` : 'Continuity',
    qa: live ? `QA (${live.blocking} blocking, ${live.warnings} to check)` : 'QA',
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">
          ← {p.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Storyboard</h1>
          {v && <StoryboardStatusBadge status={v.status} />}
          <StatusBadge status={p.status} />
          {view.versions.length > 0 && (
            <select value={v?.version ?? ''} onChange={(e) => go({ v: Number(e.target.value) })} className="max-w-full min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Storyboard version">
              {view.versions.map((x) => (
                <option key={x.id} value={x.version}>
                  {versionLabel(x)}
                </option>
              ))}
            </select>
          )}
        </div>
        <ProjectNav project={p} />
        <p className="mt-2 text-xs text-stone-500">
          What the viewer sees, when, why, and how it would be produced: visual beats and shots on the narration's real audio, each traced to the words, script, architecture and evidence it serves, with the asset it needs and a forecast of its cost. Treatment comes before provider: a provider is only a recommendation for a later milestone.
        </p>
      </div>

      <InputsStrip project={p} inputs={inputs.data} version={v} ctx={ctx} />
      <StoryboardActions project={p} view={view} inputs={inputs.data} onQueued={() => go({ v: null })} onSaved={saved} onReload={reload} />

      {v && ctx ? (
        <>
          <div role="tablist" aria-label="Storyboard" className="flex flex-wrap gap-1 border-b border-stone-200">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`storyboard-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="storyboard-panel"
                onClick={() => go({ tab: t })}
                className={`-mb-px min-h-6 border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}
              >
                {labels[t]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="storyboard-panel" aria-labelledby={`storyboard-tab-${tab}`} data-version={v.version}>
            {tab === 'overview' && <OverviewTab version={v} versions={view.versions} approach={view.editorial.approach} onVersion={(n) => go({ v: n })} />}
            {tab === 'timeline' && <TimelineTab key={v.version} version={v} onOpenShot={openShot} />}
            {tab === 'shots' && <ShotsTab version={v} ctx={ctx} decideShots={view.editorial.decideShots} replan={view.editorial.regenerateBeats} focus={focus} />}
            {tab === 'costs' && <CostsTab key={v.version} version={v} ctx={ctx} />}
            {tab === 'evidence' && <EvidenceTab version={v} onOpenShot={openShot} />}
            {tab === 'continuity' && <ContinuityTab key={v.version} version={v} ctx={ctx} onOpenShot={openShot} />}
            {tab === 'qa' && <QaTab version={v} />}
          </div>
        </>
      ) : (
        <p className="text-sm text-stone-500">No storyboard yet.</p>
      )}
    </div>
  );
}
