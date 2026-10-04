import {
  CANDIDATE_PRIORITIES,
  CANDIDATE_PRIORITY_LABELS,
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  CONFIDENCE_FLOOR,
  HISTORICAL_STATUSES,
  HISTORICAL_STATUS_LABELS,
  STATUS_LABELS,
  STORY_SCORE_KEYS,
  STORY_SCORE_LABELS,
  STORY_SCORE_WEIGHTS,
  STORY_TYPES,
  STORY_TYPE_LABELS,
  confidenceMultiplier,
  type ApprovalDecision,
  type CandidatePriority,
  type CandidateStatus,
  type ClaimView,
  type HistoricalStatus,
  type ProjectDetailView,
  type StoryArchitectureView,
  type StoryCandidateView,
  type StoryEvidenceView,
  type StoryPackView,
  type StorySequence,
  type StoryType,
  type StoryView,
  type UpdateStoryCandidateInput,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { CandidateStatusBadge, HistoricalBadge, PriorityBadge, SourceTypeBadge, StatusBadge, StoryTypeBadge } from '../components/badges.tsx';
import { ClaimCard, ClaimRefs, QualityReportView, Section, type SourceLike } from '../components/evidence.tsx';
import { ProjectNav } from '../components/ProjectNav.tsx';
import { formatDate, formatUsd } from '../format.ts';

type Tab = 'candidates' | 'selection' | 'architecture' | 'quality' | 'runs';

const STORY_JOBS = ['STORY_MINING', 'STORY_ARCHITECTURE'] as const;
const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
const mmss = (sec: number | null) => (sec === null ? '—' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);

export function StoryPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const packVersion = params.get('pack') ? Number(params.get('pack')) : undefined;
  const archVersion = params.get('arch') ? Number(params.get('arch')) : undefined;
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 1_500 : 10_000),
  });
  const running = project.data?.jobs.some((j) => (STORY_JOBS as readonly string[]).includes(j.type) && (j.status === 'QUEUED' || j.status === 'RUNNING')) ?? false;
  const story = useQuery({
    queryKey: ['story', id, packVersion, archVersion],
    queryFn: () => api.story(id, { pack: packVersion, architecture: archVersion }),
    refetchInterval: running ? 3_000 : false,
  });
  const [tab, setTab] = useState<Tab | null>(null);

  if (story.isPending || project.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (project.isError) return <p className="text-sm text-red-700">Could not load the project: {project.error.message}</p>;
  if (story.isError) return <p className="text-sm text-red-700">Could not load the story: {story.error.message}</p>;
  const p = project.data;
  const v = story.data;
  const architectureFirst = ['STORY_ARCHITECTING', 'STORY_REVIEW', 'STORY_APPROVED'].includes(p.status) && v.architecture;
  const current: Tab = tab ?? (architectureFirst ? 'architecture' : 'candidates');
  const setVersion = (key: 'pack' | 'arch', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const tabs: [Tab, string][] = [
    ['candidates', `Candidates (${v.pack?.candidates.length ?? 0})`],
    ['selection', `Selection (${v.selection.count})`],
    ['architecture', `Architecture${v.architecture ? ` v${v.architecture.version}` : ''}`],
    ['quality', 'Quality gates'],
    ['runs', 'Runs & cost'],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">
          ← {p.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Story</h1>
          <StatusBadge status={p.status} />
          {v.packs.length > 0 && (
            <select value={v.pack?.version ?? ''} onChange={(e) => setVersion('pack', e.target.value)} className="rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Story pack version">
              {v.packs.map((x) => (
                <option key={x.id} value={x.version}>
                  Pack v{x.version} — {x.status.toLowerCase().replace('_', ' ')} — {x.candidateCount} candidates
                </option>
              ))}
            </select>
          )}
          {v.architectures.length > 0 && (
            <select value={v.architecture?.version ?? ''} onChange={(e) => setVersion('arch', e.target.value)} className="rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Architecture version">
              {v.architectures.map((x) => (
                <option key={x.id} value={x.version}>
                  Architecture v{x.version} — {x.status.toLowerCase().replace('_', ' ')}
                </option>
              ))}
            </select>
          )}
        </div>
        <ProjectNav project={p} />
        <p className="mt-2 text-xs text-stone-500">
          Story units mined from the approved research dossier{v.pack ? ` v${v.pack.dossierVersion}` : ''}. Every unit and sequence traces to dossier claims and their sources; historical status and confidence are computed from the claims' verdicts. Nothing here is approved automatically.
        </p>
      </div>

      <StoryActions project={p} view={v} running={running} />

      {v.pack && <PackSummary pack={v.pack} />}

      <div className="flex flex-wrap gap-1 border-b border-stone-200">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${current === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {current === 'candidates' && (v.pack ? <CandidatesTab view={v} pack={v.pack} storyKey={['story', id, packVersion, archVersion]} /> : <Empty>No story candidates yet.</Empty>)}
      {current === 'selection' && (v.pack ? <SelectionTab view={v} pack={v.pack} /> : <Empty>No story pack yet.</Empty>)}
      {current === 'architecture' && (v.architecture ? <ArchitectureTab architecture={v.architecture} /> : <Empty>No story architecture yet. Curate the candidates, then generate the architecture.</Empty>)}
      {current === 'quality' && <QualityTab view={v} />}
      {current === 'runs' && <RunsTab view={v} />}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-stone-500">{children}</p>;
}

// ── Actions ──────────────────────────────────────────────────────────────────

function useStoryMutation<T>(fn: (arg: T) => Promise<unknown>, onDone?: () => void) {
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

function StoryActions({ project: p, view: v, running }: { project: ProjectDetailView; view: StoryView; running: boolean }) {
  const [brief, setBrief] = useState('');
  const [archNotes, setArchNotes] = useState('');
  const [gateNotes, setGateNotes] = useState('');
  const mine = useStoryMutation(() => api.mineStory(p.id, brief.trim() || undefined), () => setBrief(''));
  const build = useStoryMutation(() => api.buildArchitecture(p.id, archNotes.trim() || undefined), () => setArchNotes(''));
  const decide = useStoryMutation((decision: ApprovalDecision) => api.approve(p.id, { gate: 'STORY', decision, notes: gateNotes.trim() || undefined }), () => setGateNotes(''));
  const error = mine.error ?? build.error ?? decide.error;
  const progress = p.events.find((e) => e.type === 'JOB_PROGRESS');
  const failedStory = p.status === 'FAILED' && p.failedFromStatus?.startsWith('STORY');
  const failedJob = p.jobs.find((j) => (STORY_JOBS as readonly string[]).includes(j.type) && j.status === 'FAILED');
  const canRemine = ['STORY_SELECTION', 'STORY_REVIEW', 'STORY_APPROVED'].includes(p.status) || (failedStory && p.failedFromStatus !== 'STORY_MINING');

  const remine = (
    <details className="text-sm">
      <summary className="cursor-pointer text-stone-600">Request another mining pass…</summary>
      <p className="mt-1 text-xs text-stone-500">
        Mines the dossier again with your brief. Candidates you approved or flagged are carried over; rejected ones are not proposed again. Any architecture under review is superseded.
      </p>
      <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} placeholder="Brief for the pass (optional) — e.g. find more stories about the courts and the contracts" className="mt-2 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
      <button disabled={mine.isPending} onClick={() => mine.mutate(undefined)} className={`${button} mt-1 bg-stone-800 text-white`}>
        Run another mining pass
      </button>
    </details>
  );

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      {p.status === 'RESEARCH_COMPLETE' && (
        <div>
          <p className="text-sm">The research dossier is approved. Story mining looks for story units — people, deals, reversals, myths — not facts.</p>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} placeholder="Brief for the mining pass (optional)" className="mt-2 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
          <button disabled={mine.isPending} onClick={() => mine.mutate(undefined)} className={`${button} mt-1 bg-sky-700 text-white hover:bg-sky-600`}>
            Run Story Mining
          </button>
        </div>
      )}

      {running && (
        <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">
          <p className="font-medium">{p.status === 'STORY_ARCHITECTING' ? 'Generating the story architecture…' : 'Story mining is running…'}</p>
          {progress && <p className="mt-1 text-xs">Latest: {progress.message}</p>}
        </div>
      )}

      {p.status === 'STORY_SELECTION' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <SelectionMeter selection={v.selection} />
            <span className="text-sm text-stone-600">Approve, reject or flag candidates, choose what goes in the documentary and set priorities, then generate the architecture.</span>
          </div>
          <div>
            <textarea value={archNotes} onChange={(e) => setArchNotes(e.target.value)} rows={2} placeholder="Instructions for the architect (optional) — e.g. open with the auction, end on the legend" className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
            <button disabled={build.isPending || v.selection.problem !== null} onClick={() => build.mutate(undefined)} className={`${button} mt-1 bg-sky-700 text-white hover:bg-sky-600`}>
              Generate Story Architecture
            </button>
            {v.selection.problem && <span className="ml-2 text-xs text-amber-700">{v.selection.problem}</span>}
          </div>
        </div>
      )}

      {p.status === 'STORY_REVIEW' && v.architecture && (
        <div className="rounded-md border-2 border-violet-300 bg-violet-50 p-3">
          <p className="font-semibold text-violet-900">Human approval required — story architecture v{v.architecture.version}</p>
          <p className="text-sm text-violet-800">
            The automated gate is not an approval. Check the central question, the sequences and how disputed and myth material is framed before deciding. Approving does not start the script.
          </p>
          <textarea value={gateNotes} onChange={(e) => setGateNotes(e.target.value)} rows={2} placeholder="Notes — what works, what to change (used when reworking)" className="mt-2 w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
              Approve Story Architecture
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
              Reject → Rework
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('FLAGGED')} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
              Flag (no status change)
            </button>
          </div>
        </div>
      )}

      {p.status === 'STORY_APPROVED' && (
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
          Story architecture approved. Nothing proceeds automatically: the script stage starts only when it is started from the project page.
        </p>
      )}

      {failedStory && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          <p>
            Failed during <strong>{STATUS_LABELS[p.failedFromStatus!]}</strong>. Retry the job from the <Link className="underline" to={`/projects/${p.slug}`}>project page</Link> (completed model calls are reused), or run another mining pass.
          </p>
          {failedJob?.error && <p className="mt-1 text-xs break-words">{failedJob.error}</p>}
        </div>
      )}

      {canRemine && remine}
      {!running && !['RESEARCH_COMPLETE', 'STORY_SELECTION', 'STORY_REVIEW', 'STORY_APPROVED'].includes(p.status) && !failedStory && !v.pack && (
        <p className="text-sm text-stone-500">Story mining starts once the research dossier is approved (project status: {STATUS_LABELS[p.status]}).</p>
      )}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
    </section>
  );
}

function SelectionMeter({ selection: s }: { selection: StoryView['selection'] }) {
  const ok = s.problem === null;
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${ok ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`} title={s.problem ?? 'Ready for the architecture'}>
      {s.count} selected <span className="font-normal">(need {s.min}–{s.max})</span>
    </span>
  );
}

function PackSummary({ pack }: { pack: StoryPackView }) {
  const by = <K extends string>(get: (c: StoryCandidateView) => K) =>
    pack.candidates.reduce<Partial<Record<K, number>>>((acc, c) => ({ ...acc, [get(c)]: (acc[get(c)] ?? 0) + 1 }), {});
  const statuses = by((c) => c.historicalStatus);
  const decisions = by((c) => c.status);
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <div className="text-2xl font-semibold tabular-nums">{pack.candidates.length}</div>
        <div className="text-stone-500">
          candidates in pack v{pack.version} ·{' '}
          <span className={pack.qualityPassed ? 'text-emerald-700' : 'text-red-700'}>mining gate {pack.qualityPassed ? 'passed' : 'FAILED'}</span>
        </div>
        <div className="text-xs text-stone-400">
          {pack.content.removed.length} removed by the evidence rules or the critic · {formatDate(pack.createdAt)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-white p-3">
        {HISTORICAL_STATUSES.filter((s) => statuses[s]).map((s) => (
          <span key={s} className="flex items-center gap-1 text-sm">
            <HistoricalBadge status={s} /> <span className="tabular-nums">{statuses[s]}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-white p-3">
        {CANDIDATE_STATUSES.filter((s) => decisions[s]).map((s) => (
          <span key={s} className="flex items-center gap-1 text-sm">
            <CandidateStatusBadge status={s} /> <span className="tabular-nums">{decisions[s]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Candidates ───────────────────────────────────────────────────────────────

type StoryKey = readonly ['story', string, number | undefined, number | undefined];

function CandidatesTab({ view, pack, storyKey }: { view: StoryView; pack: StoryPackView; storyKey: StoryKey }) {
  const [statuses, setStatuses] = useState<Set<CandidateStatus>>(new Set());
  const [type, setType] = useState<StoryType | ''>('');
  const [historical, setHistorical] = useState<HistoricalStatus | ''>('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [text, setText] = useState('');
  const toggle = (s: CandidateStatus) => setStatuses((x) => (x.has(s) ? new Set([...x].filter((y) => y !== s)) : new Set([...x, s])));
  const shown = pack.candidates.filter(
    (c) =>
      (statuses.size === 0 || statuses.has(c.status)) &&
      (!type || c.storyType === type) &&
      (!historical || c.historicalStatus === historical) &&
      (!onlySelected || c.selected) &&
      (!text || `${c.title} ${c.hook} ${c.characters.map((x) => x.name).join(' ')}`.toLowerCase().includes(text.toLowerCase())),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {CANDIDATE_STATUSES.map((s) => (
          <button key={s} onClick={() => toggle(s)} className={`rounded-full ${statuses.has(s) ? 'ring-2 ring-stone-900' : 'opacity-70 hover:opacity-100'}`}>
            <CandidateStatusBadge status={s} />
          </button>
        ))}
        <select value={type} onChange={(e) => setType(e.target.value as StoryType | '')} className="rounded-md border border-stone-300 px-2 py-1">
          <option value="">All types</option>
          {STORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {STORY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select value={historical} onChange={(e) => setHistorical(e.target.value as HistoricalStatus | '')} className="rounded-md border border-stone-300 px-2 py-1">
          <option value="">Any historical status</option>
          {HISTORICAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {HISTORICAL_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> in the documentary
        </label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search" className="rounded-md border border-stone-300 px-2 py-1" />
        <span className="text-stone-500">{shown.length} shown · ranked by appeal × historical confidence</span>
      </div>
      {!view.editable && <p className="text-xs text-stone-500">Read only: candidates can be changed while the project is in Story selection and this is the current pack.</p>}
      {shown.map((c) => (
        <CandidateCard key={c.id} candidate={c} evidence={pack.evidence} editable={view.editable} storyKey={storyKey} />
      ))}
    </div>
  );
}

function CandidateCard({ candidate: c, evidence, editable, storyKey }: { candidate: StoryCandidateView; evidence: StoryEvidenceView; editable: boolean; storyKey: StoryKey }) {
  const [notes, setNotes] = useState(c.editorNotes ?? '');
  // A controlled input must change at once: show the editor's choice until the saved view arrives.
  const [optimistic, setOptimistic] = useState<{ selected?: boolean; priority?: CandidatePriority }>({});
  useEffect(() => setOptimistic({}), [c.selected, c.priority]);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: UpdateStoryCandidateInput) => api.updateCandidate(c.id, input),
    onSuccess: (view) => {
      // The response is the current story view: use it directly when that is what this page shows.
      if (storyKey[3] === undefined && (storyKey[2] === undefined || storyKey[2] === view.pack?.version)) queryClient.setQueryData(storyKey, view);
      else void queryClient.invalidateQueries({ queryKey: ['story'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
    onError: () => setOptimistic({}),
  });
  const selected = optimistic.selected ?? c.selected;
  const priority = optimistic.priority ?? c.priority;
  const claims = evidence.claims.filter((x) => c.claimKeys.includes(x.key));
  const sources = useMemo(() => new Map<string, SourceLike>(evidence.sources.map((s) => [s.id, s])), [evidence.sources]);
  const decide = (status: CandidateStatus) => update.mutate({ status });

  return (
    <article data-candidate={c.key} className={`rounded-lg border bg-white p-4 ${c.selected ? 'border-sky-400 ring-1 ring-sky-200' : 'border-stone-200'} ${c.status === 'REJECTED' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-stone-500">{c.key}</span>
            <span className="text-stone-400">#{c.rank}</span>
            <StoryTypeBadge type={c.storyType} />
            <HistoricalBadge status={c.historicalStatus} confidence={c.historicalConfidence} />
            <CandidateStatusBadge status={c.status} />
            <PriorityBadge priority={c.priority} />
            {c.aiSelected && <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-800" title={c.aiSelectionReason ?? ''}>AI-proposed</span>}
            {c.selected && <span className="rounded-full bg-sky-700 px-2 py-0.5 font-medium text-white">in the documentary</span>}
          </div>
          <h3 className="mt-1 text-lg font-semibold">{c.title}</h3>
          <p className="text-stone-800 italic">{c.hook}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{c.rankScore.toFixed(2)}</div>
          <div className="text-xs text-stone-500">rank score</div>
        </div>
      </div>

      <p className="mt-2 text-sm">
        <span className="font-semibold text-violet-800">The viewer wants to know: </span>
        {c.viewerQuestion}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
        {c.characters.map((ch, i) => (
          <span key={i} className="rounded-full bg-stone-100 px-2 py-0.5" title={ch.role}>
            {ch.name} <span className="text-stone-400">({ch.kind === 'NAMED_PERSON' ? 'person' : ch.kind.toLowerCase()})</span>
          </span>
        ))}
      </div>
      <p className="mt-1 text-sm text-stone-700">
        <span className="font-medium">Stakes: </span>
        {c.stakes}
      </p>
      {c.notes && <p className="mt-1 rounded bg-orange-50 px-2 py-1 text-sm text-orange-900">Caveat: {c.notes}</p>}

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-stone-600">Story arc, scores and why</summary>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <dl className="space-y-1">
            <Arc label="Setting">
              {c.setting} · {c.timePeriod}
            </Arc>
            <Arc label="Desire">{c.desire}</Arc>
            <Arc label="Conflict">{c.conflict}</Arc>
            <Arc label="Escalation">{c.escalation}</Arc>
            <Arc label="Turning point">{c.turningPoint}</Arc>
            <Arc label="Payoff">{c.payoff}</Arc>
            <Arc label="Why it holds">{c.whyInteresting}</Arc>
            {c.aiSelectionReason && <Arc label="Selection">{c.aiSelectionReason}</Arc>}
          </dl>
          <div>
            {c.scores ? <ScoreBars candidate={c} /> : <p className="text-xs text-red-700">Scores unavailable.</p>}
          </div>
        </div>
        {c.mythThread && (
          <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Myth investigation</p>
            <dl className="mt-1 space-y-0.5">
              <Arc label="The popular story">{c.mythThread.popularStory}</Arc>
              <Arc label="Where it came from">{c.mythThread.origin}</Arc>
              <Arc label="Who spread it">{c.mythThread.whoSpreadIt}</Arc>
              <Arc label="What happened">{c.mythThread.whatHappened}</Arc>
              <Arc label="Why it survived">{c.mythThread.whyItSurvived}</Arc>
            </dl>
          </div>
        )}
      </details>

      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-stone-600">
          Evidence: {c.claimKeys.length} claim(s), {c.sourceIds.length} source(s) <ClaimRefs keys={c.claimKeys} claims={evidence.claims} link={false} />
        </summary>
        <div className="mt-2 space-y-2">
          {claims.map((x) => (
            <ClaimCard key={x.id} claim={x} sources={sources} anchor={false} />
          ))}
        </div>
      </details>

      {editable && (
        <div className="mt-3 space-y-2 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={update.isPending || c.status === 'APPROVED'} onClick={() => decide('APPROVED')} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
              Approve
            </button>
            <button disabled={update.isPending || c.status === 'REJECTED'} onClick={() => decide('REJECTED')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
              Reject
            </button>
            <button disabled={update.isPending || c.status === 'FLAGGED'} onClick={() => decide('FLAGGED')} className={`${button} bg-white text-amber-800 ring-1 ring-amber-300 hover:bg-amber-50`}>
              Flag
            </button>
            {c.status !== 'PROPOSED' && (
              <button disabled={update.isPending} onClick={() => decide('PROPOSED')} className={`${button} text-stone-500 hover:text-stone-800`}>
                Undo decision
              </button>
            )}
            <label className="ml-2 flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={selected}
                disabled={update.isPending || c.status === 'REJECTED'}
                onChange={(e) => {
                  setOptimistic((o) => ({ ...o, selected: e.target.checked }));
                  update.mutate({ selected: e.target.checked });
                }}
              />
              In the documentary
            </label>
            <select
              value={priority}
              disabled={update.isPending}
              onChange={(e) => {
                const next = e.target.value as CandidatePriority;
                setOptimistic((o) => ({ ...o, priority: next }));
                update.mutate({ priority: next });
              }}
              className="rounded-md border border-stone-300 px-2 py-1 text-sm"
              aria-label="Priority"
            >
              {CANDIDATE_PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {CANDIDATE_PRIORITY_LABELS[x]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Editor's notes (passed to the architect)" className="flex-1 rounded-md border border-stone-300 px-2 py-1 text-sm" />
            <button disabled={update.isPending || notes === (c.editorNotes ?? '')} onClick={() => update.mutate({ editorNotes: notes.trim() || null })} className={`${button} bg-stone-800 text-white`}>
              Save notes
            </button>
          </div>
          {update.error && <p className="text-sm text-red-700">{update.error.message}</p>}
        </div>
      )}
      {!editable && c.editorNotes && <p className="mt-2 text-xs text-stone-600">Editor: “{c.editorNotes}”</p>}
    </article>
  );
}

function Arc({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-xs font-medium text-stone-500 uppercase">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ScoreBars({ candidate: c }: { candidate: StoryCandidateView }) {
  const s = c.scores!;
  const mult = confidenceMultiplier(c.historicalConfidence);
  return (
    <div>
      <table className="w-full text-xs">
        <tbody>
          {STORY_SCORE_KEYS.map((k) => (
            <tr key={k}>
              <td className="w-36 py-0.5 text-stone-600">
                {STORY_SCORE_LABELS[k]} <span className="text-stone-400">×{STORY_SCORE_WEIGHTS[k]}</span>
              </td>
              <td className="py-0.5">
                <div className="h-2 rounded bg-stone-100">
                  <div className="h-2 rounded bg-sky-600" style={{ width: `${s[k] * 10}%` }} />
                </div>
              </td>
              <td className="w-8 py-0.5 text-right tabular-nums">{s[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-stone-600">
        Appeal {s.appeal.toFixed(2)} × evidence factor {mult.toFixed(2)} (historical confidence {c.historicalConfidence}/10; {CONFIDENCE_FLOOR} at 0 → 1 at 10) = <strong>{c.rankScore.toFixed(2)}</strong>
      </p>
      {s.rationale && <p className="mt-1 text-xs text-stone-500 italic">Critic: {s.rationale}</p>}
    </div>
  );
}

// ── Selection ────────────────────────────────────────────────────────────────

function SelectionTab({ view, pack }: { view: StoryView; pack: StoryPackView }) {
  const byKey = new Map(pack.candidates.map((c) => [c.key, c]));
  const order: Record<CandidatePriority, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
  const selected = pack.candidates.filter((c) => c.selected && c.status !== 'REJECTED').sort((a, b) => order[a.priority] - order[b.priority] || a.rank - b.rank);
  const proposed = pack.content.selection.candidateKeys;
  const dropped = proposed.filter((k) => !byKey.get(k)?.selected);
  const added = selected.filter((c) => !c.aiSelected);
  return (
    <div className="space-y-4">
      <Section title="The documentary these units add up to (AI proposal)">
        <p className="text-sm font-medium">{pack.content.selection.workingPremise || '—'}</p>
        <p className="mt-1 text-sm text-stone-600">{pack.content.selection.rationale}</p>
        <p className="mt-2 text-xs text-stone-500">
          Proposed: {proposed.join(', ') || '—'} · alternates: {pack.content.selection.alternates.join(', ') || '—'}. A proposal only: the editor's selection below is what the architect uses.
        </p>
      </Section>
      <Section title={<span className="flex items-center gap-2">Editor's selection <SelectionMeter selection={view.selection} /></span>}>
        {selected.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing selected.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {selected.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-stone-500">{c.key}</span>
                <span className="font-medium">{c.title}</span>
                <StoryTypeBadge type={c.storyType} />
                <HistoricalBadge status={c.historicalStatus} confidence={c.historicalConfidence} />
                <CandidateStatusBadge status={c.status} />
                <PriorityBadge priority={c.priority} />
                {c.aiSelectionReason && <span className="text-xs text-stone-500">— {c.aiSelectionReason}</span>}
              </li>
            ))}
          </ol>
        )}
        {(dropped.length > 0 || added.length > 0) && (
          <p className="mt-3 text-xs text-stone-600">
            {added.length > 0 && <>Added by the editor: {added.map((c) => c.key).join(', ')}. </>}
            {dropped.length > 0 && <>Proposed but not selected: {dropped.join(', ')}.</>}
          </p>
        )}
      </Section>
      {pack.content.carriedOver.length > 0 && (
        <Section title="Carried over from the previous pass">
          <ul className="text-sm">
            {pack.content.carriedOver.map((x) => (
              <li key={x.key}>
                {x.key} ← pack v{x.fromPackVersion} {x.fromKey}: {byKey.get(x.key)?.title}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ── Architecture ─────────────────────────────────────────────────────────────

function ArchitectureTab({ architecture: a }: { architecture: StoryArchitectureView }) {
  const sources = useMemo(() => new Map<string, SourceLike>(a.evidence.sources.map((s) => [s.id, s])), [a.evidence.sources]);
  if (!a.content) return <p className="text-sm text-red-700">The stored architecture could not be read.</p>;
  const c = a.content;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium">{a.status.replace('_', ' ')}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${a.qualityPassed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>Architecture gate {a.qualityPassed ? 'passed' : 'FAILED'}</span>
        <span className="text-stone-600">
          {c.sequences.length} sequences · estimated {mmss(a.estimatedDurationSec)} (target {mmss(a.targetDurationSec)}) · from pack v{a.packVersion ?? '—'} · dossier v{a.dossierVersion ?? '—'}
        </span>
      </div>
      {a.notes && <p className="text-sm text-stone-600">Editor's instructions for this version: “{a.notes}”</p>}

      <Section title="Premise">
        <p className="text-sm">{c.premise}</p>
        <p className="mt-3 text-xl font-semibold text-violet-900">{c.centralQuestion}</p>
        <p className="text-xs text-stone-500">Central question</p>
        <p className="mt-3 text-sm whitespace-pre-line">{c.narrativeSpine}</p>
        <p className="text-xs text-stone-500">Narrative spine</p>
        {c.resolution && (
          <>
            <p className="mt-3 text-sm">{c.resolution}</p>
            <p className="text-xs text-stone-500">How the film answers it</p>
          </>
        )}
      </Section>

      <Runtime sequences={c.sequences} target={a.targetDurationSec} />

      {c.sequences.map((s) => (
        <SequenceCard key={s.number} sequence={s} claims={a.evidence.claims} sources={sources} />
      ))}

      {c.unusedCandidates.length > 0 && (
        <Section title="Selected units left out">
          <ul className="space-y-1 text-sm">
            {c.unusedCandidates.map((u) => (
              <li key={u.candidateKey}>
                <span className="font-mono text-xs">{u.candidateKey}</span> — {u.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Decisions on this version">
        {a.approvals.length === 0 ? (
          <p className="text-sm text-stone-500">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {a.approvals.map((x) => (
              <li key={x.id}>
                <span className="font-medium">{x.decision.toLowerCase()}</span> by {x.decidedBy ?? 'unknown'} · {formatDate(x.createdAt)}
                {x.notes && <span className="text-stone-600"> — “{x.notes}”</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Runtime({ sequences, target }: { sequences: StorySequence[]; target: number | null }) {
  const total = sequences.reduce((n, s) => n + s.estimatedDurationSec, 0) || 1;
  return (
    <div>
      <div className="flex h-6 overflow-hidden rounded-md border border-stone-200 text-[10px]">
        {sequences.map((s, i) => (
          <div key={s.number} className={`flex items-center justify-center truncate px-1 text-white ${i % 2 ? 'bg-sky-700' : 'bg-sky-600'}`} style={{ width: `${(s.estimatedDurationSec / total) * 100}%` }} title={`${s.number}. ${s.title} — ${mmss(s.estimatedDurationSec)}`}>
            {s.number}
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Running order and estimated narration time per sequence (total {mmss(total)}{target ? `, target ${mmss(target)}` : ''}).
      </p>
    </div>
  );
}

function SequenceCard({ sequence: s, claims, sources }: { sequence: StorySequence; claims: ClaimView[]; sources: Map<string, SourceLike> }) {
  const seqClaims = claims.filter((x) => s.claimKeys.includes(x.key));
  const contextKeys = s.contextClaims.map((c) => c.claimKey);
  const contextClaims = claims.filter((x) => contextKeys.includes(x.key));
  return (
    <article data-sequence={s.number} className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-white">{s.number}</span>
        <h3 className="text-lg font-semibold">{s.title}</h3>
        <span className="text-sm tabular-nums text-stone-500">{mmss(s.estimatedDurationSec)}</span>
        <HistoricalBadge status={s.historicalStatus} confidence={s.historicalConfidence} />
        {s.candidateKeys.map((k) => (
          <span key={k} className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-xs text-sky-900">
            {k}
          </span>
        ))}
      </div>
      <p className="mt-1 text-sm text-stone-600">{s.purpose}</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <dl className="space-y-1 text-sm">
          <Arc label="Opening hook">{s.openingHook}</Arc>
          <Arc label="Question">{s.narrativeQuestion}</Arc>
          <Arc label="Conflict">{s.conflict || '—'}</Arc>
          <Arc label="Escalation">{s.escalation || '—'}</Arc>
          <Arc label="Reveal">{s.reveal || '—'}</Arc>
          <Arc label="Ending beat">{s.endingBeat}</Arc>
          <Arc label="Characters">{s.characters.join(', ') || '—'}</Arc>
        </dl>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Key events</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
            {s.keyEvents.map((e, i) => (
              <li key={i}>
                {e.event}
                <ClaimRefs keys={e.claimKeys} claims={claims} link={false} />
              </li>
            ))}
          </ol>
        </div>
      </div>
      {s.caveats.length > 0 && (
        <div className="mt-3 rounded border border-orange-200 bg-orange-50 p-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-800">How to present uncertain material</p>
          <ul className="mt-1 space-y-0.5">
            {s.caveats.map((x) => (
              <li key={x.claimKey}>
                <ClaimRefs keys={[x.claimKey]} claims={claims} link={false} /> {x.framing}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.contextClaims.length > 0 && (
        <div className="mt-3 rounded border border-dashed border-stone-300 bg-stone-50 p-2 text-sm" data-context-claims>
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Background only — other dossier claims, not story evidence</p>
          <ul className="mt-1 space-y-0.5 text-stone-600">
            {s.contextClaims.map((x) => (
              <li key={x.claimKey}>
                <ClaimRefs keys={[x.claimKey]} claims={claims} link={false} /> {x.purpose}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-stone-600">
          Story evidence: {s.claimKeys.length} claim(s) of the selected units, {s.sourceIds.length} source(s) <ClaimRefs keys={s.claimKeys} claims={claims} link={false} />
        </summary>
        <SourceList ids={s.sourceIds} sources={sources} />
        <div className="mt-2 space-y-2">
          {seqClaims.map((x) => (
            <ClaimCard key={x.id} claim={x} sources={sources} anchor={false} />
          ))}
        </div>
      </details>
      {s.contextClaims.length > 0 && (
        <details className="mt-1 text-sm">
          <summary className="cursor-pointer text-stone-500">
            Background claims: {s.contextClaims.length} claim(s), {s.contextSourceIds.length} more source(s)
          </summary>
          <SourceList ids={s.contextSourceIds} sources={sources} />
          <div className="mt-2 space-y-2">
            {contextClaims.map((x) => (
              <ClaimCard key={x.id} claim={x} sources={sources} anchor={false} />
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

function SourceList({ ids, sources }: { ids: string[]; sources: Map<string, SourceLike> }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {ids.map((id) => {
        const src = sources.get(id);
        return (
          <li key={id} className="flex flex-wrap items-center gap-1">
            {src && <SourceTypeBadge type={src.sourceType} />}
            {src?.url ? (
              <a href={src.url} target="_blank" rel="noreferrer" className="hover:underline">
                {src.title}
              </a>
            ) : (
              <span>{src?.title ?? id}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Quality and runs ─────────────────────────────────────────────────────────

function QualityTab({ view: v }: { view: StoryView }) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h2 className="font-semibold">Mining gate{v.pack ? ` — pack v${v.pack.version}` : ''}</h2>
        {v.pack?.qualityReport ? <QualityReportView report={v.pack.qualityReport} claims={v.pack.evidence.claims} /> : <Empty>No mining report.</Empty>}
        {v.pack && v.pack.content.removed.length > 0 && (
          <Section title={`Removed candidates (${v.pack.content.removed.length})`}>
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-stone-100 align-top">
                {v.pack.content.removed.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-medium">{r.title}</td>
                    <td className="py-1 pr-3 text-xs text-stone-500">{r.storyType}</td>
                    <td className="py-1 text-stone-600">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
      </div>
      <div className="space-y-3">
        <h2 className="font-semibold">Architecture gate{v.architecture ? ` — v${v.architecture.version}` : ''}</h2>
        {v.architecture?.qualityReport ? <QualityReportView report={v.architecture.qualityReport} claims={v.architecture.evidence.claims} reviewTitle="Editorial review" /> : <Empty>No architecture report.</Empty>}
      </div>
    </div>
  );
}

function RunsTab({ view: v }: { view: StoryView }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {v.pack && (
        <Section title={`Story mining — pack v${v.pack.version}`}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatUsd(v.pack.cost.totalUsd)}
            {v.pack.cost.includesEstimates && <span className="ml-2 align-middle text-xs font-normal text-amber-700">estimated</span>}
          </p>
          <p className="text-xs text-stone-500">{v.pack.cost.calls} provider call(s) by the job that produced this pack (failed attempts included)</p>
          {v.pack.notes && <p className="mt-2 text-sm">Brief: “{v.pack.notes}”</p>}
          <pre className="mt-2 overflow-x-auto text-xs text-stone-600">{JSON.stringify(v.pack.stats, null, 2)}</pre>
        </Section>
      )}
      {v.architecture && (
        <Section title={`Story architecture — v${v.architecture.version}`}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatUsd(v.architecture.cost.totalUsd)}
            {v.architecture.cost.includesEstimates && <span className="ml-2 align-middle text-xs font-normal text-amber-700">estimated</span>}
          </p>
          <p className="text-xs text-stone-500">{v.architecture.cost.calls} provider call(s)</p>
          <pre className="mt-2 overflow-x-auto text-xs text-stone-600">{JSON.stringify(v.architecture.stats, null, 2)}</pre>
        </Section>
      )}
      {!v.pack && !v.architecture && <Empty>No story runs yet.</Empty>}
    </div>
  );
}
