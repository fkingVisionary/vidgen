import {
  GATE_LABELS,
  JOB_TYPE_LABELS,
  STATUS_LABELS,
  SUPPORTED_LANGUAGES,
  isLanguageCode,
  type ApprovalDecision,
  type JobType,
  type ProjectDetailView,
  type ProjectStatus,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { JobStatusBadge, MockBadge, StatusBadge } from '../components/badges.tsx';
import { ProgressBar, StagePipeline } from '../components/StagePipeline.tsx';
import { formatDate, formatDuration, formatRuntime, formatUsd } from '../format.ts';

export function ProjectPage() {
  const { id = '' } = useParams();
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    // Poll quickly while work is in flight so status changes appear without a reload.
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 1_500 : 10_000),
  });

  if (project.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (project.isError) return <p className="text-sm text-red-700">Could not load project: {project.error.message}</p>;
  const p = project.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-stone-500 hover:underline">
          ← Projects
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{p.title}</h1>
          <StatusBadge status={p.status} />
          <ProgressBar value={p.progress} />
        </div>
        {p.workingTitle && <p className="text-stone-600 italic">{p.workingTitle}</p>}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm text-stone-600 sm:grid-cols-2">
          <Meta label="Topic">{p.topic}</Meta>
          <Meta label="Category">{p.category ?? '—'}</Meta>
          <Meta label="Style">{p.style ?? '—'}</Meta>
          <Meta label="Runtime">{formatRuntime(p)}</Meta>
          <Meta label="Languages">
            {p.languageVersions.map((lv) => `${isLanguageCode(lv.language) ? SUPPORTED_LANGUAGES[lv.language] : lv.language}${lv.isMaster ? ' (master)' : ''}`).join(', ')}
          </Meta>
          <Meta label="Created">{formatDate(p.createdAt)}</Meta>
        </dl>
        {p.description && <p className="mt-2 max-w-3xl text-sm text-stone-600">{p.description}</p>}
      </div>

      <StagePipeline stages={p.stages} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <NextActions project={p} />
          <JobsTable project={p} />
        </div>
        <div className="space-y-6">
          {(p.story.pack || p.story.architecture || p.status === 'RESEARCH_COMPLETE') && <StoryCard project={p} />}
          {p.research && (
            <Card title="Research dossier">
              <p className="text-sm">
                Version {p.research.version} · {p.research.status.replace('_', ' ').toLowerCase()} · {p.research.claimCount} claims
              </p>
              <p className={`text-xs ${p.research.qualityPassed ? 'text-emerald-700' : 'text-red-700'}`}>
                Quality gate {p.research.qualityPassed ? 'passed' : 'failed'}
              </p>
              <Link to={`/projects/${p.slug}/research`} className="mt-2 inline-block rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
                Open dossier →
              </Link>
            </Card>
          )}
          <Card title="Cost">
            <p className="text-2xl font-semibold tabular-nums">
              {formatUsd(p.costs.totalUsd)}
              {p.costs.includesEstimates && <span className="ml-2 align-middle text-xs font-normal text-amber-700">estimated</span>}
            </p>
            <p className="text-xs text-stone-500">
              {p.costs.providerCalls} provider call(s) · {p.costs.mockCalls} MOCK · {p.costs.failedCalls} failed
              {p.costs.unpricedCalls > 0 && <span className="text-red-700"> · {p.costs.unpricedCalls} unpriced (missing from total)</span>}
            </p>
            {p.costs.byProvider.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {p.costs.byProvider.map((b) => (
                    <tr key={b.provider}>
                      <td className="py-0.5 text-stone-600">{b.provider}</td>
                      <td className="py-0.5 text-right tabular-nums">{b.calls} calls</td>
                      <td className="py-0.5 text-right tabular-nums">{formatUsd(b.totalUsd)}</td>
                      <td className="py-0.5 pl-2 text-right text-stone-400">{b.costBases.map((x) => x.toLowerCase().replace('_', ' ')).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-1 text-[11px] text-stone-400">
              Estimates = reported usage × configured list prices. Vendor-reported amounts are used when a provider returns them.
            </p>
          </Card>
          <Card title="Approvals">
            {p.approvals.length === 0 ? (
              <p className="text-sm text-stone-500">None yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {p.approvals.map((a) => (
                  <li key={a.id}>
                    <span className="font-medium">{GATE_LABELS[a.gate]}</span> — {a.decision.toLowerCase()} by {a.decidedBy ?? 'unknown'}
                    <div className="text-xs text-stone-500">{formatDate(a.createdAt)}</div>
                    {a.notes && <div className="text-xs text-stone-600">“{a.notes}”</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Activity">
            <ul className="max-h-96 space-y-2 overflow-y-auto text-xs">
              {p.events.map((e) => (
                <li key={e.id}>
                  <span className="text-stone-400">{formatDate(e.createdAt)}</span>
                  <div className="text-stone-700">{e.message}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-stone-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
      {children}
    </section>
  );
}

const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';

/** Button text for starting a job, where "Run <job>" is not the clearest. */
const ACTION_LABELS: Partial<Record<JobType, string>> = {
  STORY_MINING: 'Run Story Mining',
  STORY_ARCHITECTURE: 'Generate Story Architecture',
};

function StoryCard({ project: p }: { project: ProjectDetailView }) {
  const { pack, architecture: a } = p.story;
  return (
    <Card title="Story">
      {pack ? (
        <p className="text-sm">
          Pack v{pack.version} · {pack.status.replace('_', ' ').toLowerCase()} · {pack.candidateCount} candidates · {pack.selectedCount} selected
        </p>
      ) : (
        <p className="text-sm text-stone-500">No story candidates yet.</p>
      )}
      {pack && <p className={`text-xs ${pack.qualityPassed ? 'text-emerald-700' : 'text-red-700'}`}>Mining gate {pack.qualityPassed ? 'passed' : 'failed'}</p>}
      {a && (
        <p className="mt-1 text-sm">
          Architecture v{a.version} · {a.status.replace('_', ' ').toLowerCase()} · {a.sequenceCount} sequences
          {a.estimatedDurationSec !== null && ` · ~${Math.round(a.estimatedDurationSec / 60)} min`}
        </p>
      )}
      <Link to={`/projects/${p.slug}/story`} className="mt-2 inline-block rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
        Open story →
      </Link>
    </Card>
  );
}

function useProjectMutation<T>(project: ProjectDetailView, fn: (arg: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

function NextActions({ project: p }: { project: ProjectDetailView }) {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const realStages = health.data?.realStages ?? [];
  const [notes, setNotes] = useState('');
  const [rewindTo, setRewindTo] = useState<ProjectStatus | ''>('');
  const [reason, setReason] = useState('');
  const enqueue = useProjectMutation(p, (type: JobType) => api.enqueueJob(p.id, { type }));
  const decide = useProjectMutation(p, (decision: ApprovalDecision) =>
    api.approve(p.id, { gate: p.actions.gate!.gate, decision, notes: notes || undefined }).then(() => setNotes('')),
  );
  const rewind = useProjectMutation(p, () => api.rewind(p.id, { to: rewindTo as ProjectStatus, reason }));
  const active = p.jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
  const error = enqueue.error ?? decide.error ?? rewind.error;

  return (
    <Card title="Next actions">
      <div className="space-y-4">
        {p.status === 'FAILED' && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            Failed during <strong>{p.failedFromStatus ? STATUS_LABELS[p.failedFromStatus] : 'an unknown phase'}</strong>. Retry the failed job below, or rewind.
          </p>
        )}

        {p.status === 'STORY_SELECTION' && (
          <p className="text-sm">
            Curate the story candidates on the <Link className="font-medium underline" to={`/projects/${p.slug}/story`}>Story page</Link>: approve, reject or flag them, choose 5–10 for the documentary, then generate the architecture.
          </p>
        )}

        {p.actions.runnableJobs.length > 0 && (
          <div>
            <div className="flex flex-wrap gap-2">
              {p.actions.runnableJobs.map((type) => {
                const busy = active.some((j) => j.type === type);
                return (
                  <button
                    key={type}
                    disabled={busy || enqueue.isPending}
                    onClick={() => enqueue.mutate(type)}
                    className={`${button} bg-sky-700 text-white hover:bg-sky-600`}
                  >
                    {busy ? `${JOB_TYPE_LABELS[type]}: running…` : (ACTION_LABELS[type] ?? `Run ${JOB_TYPE_LABELS[type]}`)}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-stone-500">
              {p.actions.startsPhase ? `Starts the “${STATUS_LABELS[p.actions.startsPhase]}” phase. ` : ''}
              {p.actions.runnableJobs.map((t) => `${JOB_TYPE_LABELS[t]}: ${realStages.includes(t) ? 'real' : 'MOCK placeholder'}`).join(' · ')}
            </p>
          </div>
        )}

        {p.actions.gate && (
          <div className="rounded-md border border-violet-200 bg-violet-50 p-3">
            <p className="text-sm font-medium text-violet-900">Human approval required: {GATE_LABELS[p.actions.gate.gate]}</p>
            {p.actions.gate.gate === 'RESEARCH' && p.research && (
              <p className="text-xs text-violet-800">
                Review <Link className="underline" to={`/projects/${p.slug}/research`}>research dossier v{p.research.version}</Link> before deciding.
              </p>
            )}
            {p.actions.gate.gate === 'STORY' && p.story.architecture && (
              <p className="text-xs text-violet-800">
                Review <Link className="underline" to={`/projects/${p.slug}/story`}>story architecture v{p.story.architecture.version}</Link> before deciding.
              </p>
            )}
            {!p.actions.canApprove && <p className="text-xs text-violet-800">Approval unlocks once the automated jobs for this step have succeeded.</p>}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional) — what you checked, what to change"
              className="mt-2 w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm"
              rows={2}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button disabled={!p.actions.canApprove || decide.isPending} onClick={() => decide.mutate('APPROVED')} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
                Approve → {STATUS_LABELS[p.actions.gate.onApprove]}
              </button>
              <button disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
                Reject → {STATUS_LABELS[p.actions.gate.onReject]}
              </button>
              <button disabled={decide.isPending} onClick={() => decide.mutate('FLAGGED')} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
                Flag (no status change)
              </button>
            </div>
          </div>
        )}

        {p.actions.runnableJobs.length === 0 && !p.actions.gate && p.status !== 'FAILED' && (
          <p className="text-sm text-stone-500">{p.status === 'PUBLISHED' ? 'Published. Nothing left to do.' : 'No actions available in this status.'}</p>
        )}

        {p.actions.rewindTargets.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-stone-500">Rewind to an earlier status…</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select value={rewindTo} onChange={(e) => setRewindTo(e.target.value as ProjectStatus)} className="rounded-md border border-stone-300 px-2 py-1.5">
                <option value="">Choose status</option>
                {p.actions.rewindTargets.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="min-w-48 flex-1 rounded-md border border-stone-300 px-2 py-1.5" />
              <button disabled={!rewindTo || !reason.trim() || rewind.isPending} onClick={() => rewind.mutate(undefined)} className={`${button} bg-stone-800 text-white`}>
                Rewind
              </button>
            </div>
          </details>
        )}

        {error && <p className="text-sm text-red-700">{error.message}</p>}
      </div>
    </Card>
  );
}

function JobsTable({ project: p }: { project: ProjectDetailView }) {
  const retry = useProjectMutation(p, (jobId: string) => api.retryJob(jobId));
  return (
    <Card title="Jobs">
      {p.jobs.length === 0 ? (
        <p className="text-sm text-stone-500">No jobs yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Job</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Attempts</th>
                <th className="py-1 pr-3 font-medium">Duration</th>
                <th className="py-1 pr-3 font-medium">Created</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 align-top">
              {p.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5">
                      {JOB_TYPE_LABELS[j.type]} {j.isMock && <MockBadge />}
                    </div>
                    {j.error && <div className="mt-1 max-w-md text-xs break-words text-red-700">{j.error}</div>}
                    {j.result !== null && (
                      <details className="mt-1 text-xs text-stone-500">
                        <summary className="cursor-pointer">Result</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-stone-50 p-2">{JSON.stringify(j.result, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-stone-600">{formatDuration(j.startedAt, j.completedAt)}</td>
                  <td className="py-2 pr-3 text-stone-600">{formatDate(j.createdAt)}</td>
                  <td className="py-2 text-right">
                    {(j.status === 'FAILED' || j.status === 'CANCELLED') && (
                      <button disabled={retry.isPending} onClick={() => retry.mutate(j.id)} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retry.error && <p className="mt-2 text-sm text-red-700">{retry.error.message}</p>}
    </Card>
  );
}
