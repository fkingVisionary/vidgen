import {
  GATE_LABELS,
  JOB_TYPE_LABELS,
  STATUS_LABELS,
  SUPPORTED_LANGUAGES,
  fmtClock,
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
import { NextStepCard } from '../components/NextStep.tsx';
import { ProjectNav, hasScriptPage, hasStoryPage, hasVoicePage } from '../components/ProjectNav.tsx';
import { ProgressBar, StagePipeline } from '../components/StagePipeline.tsx';
import { StoryboardStatusBadge } from '../components/storyboard.tsx';
import { formatDate, formatDuration, formatRuntime, formatUsd } from '../format.ts';
import { ANCHORS, nextStep } from '../next-step.ts';
import { generationHeld, hasStoryboardPage, rollupText, summaryLine } from '../storyboard-plan.ts';

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
        <ProjectNav project={p} />
        <NextStepCard project={p} />
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

      <StagePipeline
        stages={p.stages}
        links={{
          RESEARCH: p.research ? `/projects/${p.slug}/research` : undefined,
          STORY: hasStoryPage(p) ? `/projects/${p.slug}/story` : undefined,
          SCRIPT: hasScriptPage(p) ? `/projects/${p.slug}/script` : undefined,
          VOICE: hasVoicePage(p) ? `/projects/${p.slug}/voice` : undefined,
          STORYBOARD: hasStoryboardPage(p) ? `/projects/${p.slug}/storyboard` : undefined,
        }}
      />

      {/* min-w-0: without it a grid column grows to its widest content (the jobs table) and the page overflows on phones. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <NextActions project={p} />
          <JobsTable project={p} />
        </div>
        <div className="min-w-0 space-y-6">
          {hasStoryboardPage(p) && <StoryboardCard project={p} />}
          {p.script && <ScriptCard project={p} />}
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

function ScriptCard({ project: p }: { project: ProjectDetailView }) {
  const s = p.script!;
  return (
    <Card title="Script">
      <p className="text-sm">
        Version {s.version} · {s.status.replace('_', ' ').toLowerCase()} · {s.wordCount.toLocaleString()} words · {fmtClock(s.estimatedDurationSec)}
        {s.targetDurationSec ? ` (target ${fmtClock(s.targetDurationSec)})` : ''}
      </p>
      <p className={`text-xs ${s.qualityPassed ? 'text-emerald-700' : 'text-red-700'}`}>Script gate {s.qualityPassed ? 'passed' : 'has blocking findings'}</p>
      <Link to={`/projects/${p.slug}/script`} className="mt-2 inline-block rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
        Open script →
      </Link>
    </Card>
  );
}

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
      {a && a.engineVersion === 2 && (
        <p className="text-xs text-stone-600">
          Content opportunities: {a.opportunities.shorts} short-form, {a.opportunities.longForm} long-form · {a.opportunities.approved} approved
        </p>
      )}
      <Link to={`/projects/${p.slug}/story`} className="mt-2 inline-block rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
        Open story →
      </Link>
    </Card>
  );
}

/** The newest storyboard version (a preview included): its forecast, QA and narration, or that one can be planned. */
function StoryboardCard({ project: p }: { project: ProjectDetailView }) {
  const s = p.storyboard;
  return (
    <Card title="Storyboard">
      {s ? (
        <div className="space-y-1" data-storyboard-card>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-words">{summaryLine(s)}</span>
            <StoryboardStatusBadge status={s.status} />
            {s.stale && <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">stale</span>}
          </p>
          <p className="text-xs text-stone-600">Visual cost forecast: {rollupText({ totalUsd: s.estimatedCostUsd, basis: s.costBasis, unpricedShots: s.unpricedShotCount })} (an estimate; nothing is generated)</p>
          <p className={`text-xs ${s.blocking ? 'text-red-700' : 'text-emerald-700'}`}>
            QA as saved: {s.blocking} blocking, {s.warnings} to check · narration run {s.narration.runNumber}, assembly v{s.narration.assemblyVersion}
          </p>
        </div>
      ) : (
        <p className="text-sm text-stone-500">No storyboard yet: it is planned on the narration's real audio.</p>
      )}
      <Link to={`/projects/${p.slug}/storyboard`} className="mt-2 inline-block rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
        {s ? 'Open storyboard →' : 'Plan the storyboard →'}
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
  // The architecture is generated from the Story page, where the selection it is built from is visible;
  // the real script is written from the Script page, where the approved architecture and every version are.
  const scriptOnItsPage = realStages.includes('SCRIPT');
  // Real narration is planned, confirmed and reviewed chunk by chunk on the Voice page.
  const voiceOnItsPage = realStages.includes('VOICE');
  // A real storyboard is planned, edited and decided on the Storyboard page; while it is real, visual generation is held (the server refuses it too).
  const storyboardOnItsPage = realStages.includes('VISUAL_PLAN');
  const held = (t: JobType) => generationHeld(realStages, t);
  const runnableJobs = p.actions.runnableJobs.filter(
    (t) => !(p.status === 'STORY_SELECTION' && t === 'STORY_ARCHITECTURE') && !(scriptOnItsPage && t === 'SCRIPT') && !(voiceOnItsPage && t === 'VOICE') && !(storyboardOnItsPage && (t === 'VISUAL_PLAN' || t === 'STORYBOARD_PREVIEW')) && !held(t),
  );
  const heldJobs = p.actions.runnableJobs.filter(held);
  const storyPage = `/projects/${p.slug}/story`;
  const scriptPage = `/projects/${p.slug}/script`;
  const storyboardPage = `/projects/${p.slug}/storyboard`;
  const storyboardGate = p.actions.gate?.gate === 'STORYBOARD' && storyboardOnItsPage;
  // Real narration is approved on the Voice page, where what stops it is said (an audition is never the narration).
  const voiceGate = p.actions.gate?.gate === 'VOICE' && voiceOnItsPage;
  const guided = health.data ? nextStep(p, realStages) : null;

  return (
    <Card title="Next actions">
      <div className="space-y-4">
        {p.status === 'FAILED' && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            Failed during <strong>{p.failedFromStatus ? STATUS_LABELS[p.failedFromStatus] : 'an unknown phase'}</strong>. {guided ? 'Start it again from its page (the next step above), or rewind.' : 'Retry the failed job below, or rewind.'}
          </p>
        )}

        {p.status === 'STORY_SELECTION' && (
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
            <p className="text-sm font-medium text-sky-950">Your turn: choose the stories</p>
            <p className="mt-1 text-sm text-sky-900">
              Story mining found {p.story.pack?.candidateCount ?? 0} story candidates; {p.story.pack?.selectedCount ?? 0} are selected for the documentary so far. On the Story page,
              read them, approve, reject or flag each one, keep 5–10 selected, then generate the story architecture there.
            </p>
            <Link to={storyPage} className={`${button} mt-2 inline-block bg-sky-700 text-white hover:bg-sky-600`}>
              Review story candidates →
            </Link>
          </div>
        )}

        {(p.status === 'STORY_MINING' || p.status === 'STORY_ARCHITECTING') && (
          <p className="text-sm">
            {p.status === 'STORY_MINING' ? 'Story mining is running.' : 'The story architecture is being generated.'}{' '}
            <Link className="font-medium underline" to={storyPage}>
              Follow it on the Story page →
            </Link>
          </p>
        )}

        {scriptOnItsPage && (p.status === 'STORY_APPROVED' || p.status === 'SCRIPT_DRAFT') && (
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
            <p className="text-sm font-medium text-sky-950">{p.status === 'STORY_APPROVED' ? 'Your turn: write the script' : active.some((j) => j.type === 'SCRIPT') ? 'The script is being written' : 'The script is back with you'}</p>
            <p className="mt-1 text-sm text-sky-900">The Script Engine turns the approved story architecture into narration, section by section, and stops for your review. No voice is generated.</p>
            <Link to={scriptPage} className={`${button} mt-2 inline-block bg-sky-700 text-white hover:bg-sky-600`}>
              Open the Script page →
            </Link>
          </div>
        )}

        {/* Narration and the storyboard: the Next step card under the title says what to do and goes there. */}
        {guided && (
          <p className="text-sm text-stone-600" data-next-step-pointer>
            Next: {guided.text}
          </p>
        )}

        {heldJobs.length > 0 && (
          <p className="rounded-md bg-stone-100 p-3 text-sm text-stone-700" data-generation-held>
            Visual generation is the next milestone: it starts only after the storyboard is reviewed and accepted.
          </p>
        )}

        {runnableJobs.length > 0 && (
          <div>
            <div className="flex flex-wrap gap-2">
              {runnableJobs.map((type) => {
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
              {runnableJobs.map((t) => `${JOB_TYPE_LABELS[t]}: ${realStages.includes(t) ? 'real' : 'MOCK placeholder'}`).join(' · ')}
            </p>
          </div>
        )}

        {/* The film's final narration is decided on the Voice page: a note here, not a second call to action beside the next step. */}
        {voiceGate && (
          <p className="rounded-md bg-stone-100 p-3 text-sm text-stone-700" data-voice-gate-note>
            The film's final narration is approved on the Voice page, once the whole script is narrated and every take is approved: an audition is never the final narration.{' '}
            <Link to={`/projects/${p.slug}/voice#${ANCHORS.gate}`} className="font-medium underline">
              Final narration approval
            </Link>
          </p>
        )}

        {p.actions.gate && !voiceGate && (
          <div className="rounded-md border border-violet-200 bg-violet-50 p-3">
            <p className="text-sm font-medium text-violet-900">Human approval required: {GATE_LABELS[p.actions.gate.gate]}</p>
            {p.actions.gate.gate === 'RESEARCH' && p.research && (
              <div className="mt-1">
                <p className="text-xs text-violet-800">Read the dossier before deciding.</p>
                <Link to={`/projects/${p.slug}/research`} className={`${button} mt-1 inline-block bg-violet-700 text-white hover:bg-violet-600`}>
                  Open research dossier v{p.research.version} →
                </Link>
              </div>
            )}
            {p.actions.gate.gate === 'STORY' && p.story.architecture && (
              <div className="mt-1">
                <p className="text-xs text-violet-800">Read the story architecture before deciding.</p>
                <Link to={storyPage} className={`${button} mt-1 inline-block bg-violet-700 text-white hover:bg-violet-600`}>
                  Open story architecture v{p.story.architecture.version} →
                </Link>
              </div>
            )}
            {p.actions.gate.gate === 'SCRIPT' && p.script && (
              <div className="mt-1">
                <p className="text-xs text-violet-800">Read the script before deciding: blocking findings and rejected sections stop approval.</p>
                <Link to={scriptPage} className={`${button} mt-1 inline-block bg-violet-700 text-white hover:bg-violet-600`}>
                  Open script v{p.script.version} →
                </Link>
              </div>
            )}
            {storyboardGate && (
              <div className="mt-1">
                <p className="text-xs text-violet-800">Decide on the Storyboard page: the decision names the version you reviewed, and blocking findings, rejected shots and unapproved narration stop approval there.</p>
                <Link to={storyboardPage} className={`${button} mt-1 inline-block bg-violet-700 text-white hover:bg-violet-600`}>
                  Open the storyboard →
                </Link>
              </div>
            )}
            {!storyboardGate && !p.actions.canApprove && <p className="text-xs text-violet-800">Approval unlocks once the automated jobs for this step have succeeded.</p>}
            {!storyboardGate && (
              <>
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
              </>
            )}
          </div>
        )}

        {runnableJobs.length === 0 && heldJobs.length === 0 && !p.actions.gate && !guided && p.status !== 'FAILED' && p.status !== 'STORY_SELECTION' && (
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
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const realStages = health.data?.realStages ?? [];
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
                    {(j.status === 'FAILED' || j.status === 'CANCELLED') &&
                      (generationHeld(realStages, j.type) ? (
                        <span className="text-xs text-stone-500" data-retry-held title="Visual generation is the next milestone: it starts only after the storyboard is reviewed and accepted.">
                          held: the next milestone
                        </span>
                      ) : (
                        <button disabled={retry.isPending} onClick={() => retry.mutate(j.id)} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
                          Retry
                        </button>
                      ))}
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
