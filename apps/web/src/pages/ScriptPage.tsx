import { SCRIPT_ORIGIN_LABELS, SCRIPT_SCORES, SCRIPT_SCORE_LABELS, STATUS_LABELS, fmtClock, type ApprovalDecision, type ProjectDetailView, type ScriptView } from '@docengine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { QualityReportView, Section } from '../components/evidence.tsx';
import { ProjectNav } from '../components/ProjectNav.tsx';
import { AssessmentList, JudgmentsSection, MeasurementsSection, ReviewChangesSection, SectionCard, TimingSummary, VersionsTab, VoiceTab, button, useScriptRequest } from '../components/script.tsx';
import { formatDate, formatUsd } from '../format.ts';

type Tab = 'script' | 'quality' | 'voice' | 'versions' | 'runs';

/**
 * The script: the documentary as it will be spoken, section by section — the
 * editor reads it, edits it, approves or rejects sections, asks for rewrites
 * and approves the whole script at the SCRIPT gate. Nothing is voiced here.
 */
export function ScriptPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const version = params.get('v') ? Number(params.get('v')) : undefined;
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 1_500 : 10_000),
  });
  const running = project.data?.jobs.some((j) => j.type === 'SCRIPT' && (j.status === 'QUEUED' || j.status === 'RUNNING')) ?? false;
  const script = useQuery({ queryKey: ['script', id, version], queryFn: () => api.script(id, version), refetchInterval: running ? 3_000 : false });
  // Reload the script whenever the project's status or a script job's state changes.
  const queryClient = useQueryClient();
  const stamp = project.data ? `${project.data.status}|${project.data.jobs.filter((j) => j.type === 'SCRIPT').map((j) => `${j.id}:${j.status}`).join(',')}` : null;
  const lastStamp = useRef<string | null>(null);
  useEffect(() => {
    if (stamp === null) return;
    if (lastStamp.current !== null && lastStamp.current !== stamp) void queryClient.invalidateQueries({ queryKey: ['script', id] });
    lastStamp.current = stamp;
  }, [stamp, id, queryClient]);
  const [tab, setTab] = useState<Tab>('script');

  if (project.isPending || script.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (project.isError) return <p className="text-sm text-red-700">Could not load the project: {project.error.message}</p>;
  if (script.isError) return <p className="text-sm text-red-700">Could not load the script: {script.error.message}</p>;
  const p = project.data;
  const v = script.data;
  const s = v.script;
  const showVersion = (n: number) => {
    const next = new URLSearchParams(params);
    next.set('v', String(n));
    setParams(next);
    setTab('script');
  };
  const showLatest = () => {
    const next = new URLSearchParams(params);
    next.delete('v');
    setParams(next);
    setTab('script');
  };
  const tabs: [Tab, string][] = [
    ['script', s ? `Script v${s.version}` : 'Script'],
    ['quality', s ? `Quality gate${s.qualityPassed ? '' : ' ⚠'}` : 'Quality gate'],
    ['voice', 'Pronunciation & voice'],
    ['versions', `Versions (${v.scripts.length})`],
    ['runs', 'Runs & cost'],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">
          ← {p.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Script</h1>
          <StatusBadge status={p.status} />
          {v.scripts.length > 0 && (
            <select value={s?.version ?? ''} onChange={(e) => showVersion(Number(e.target.value))} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Script version">
              {v.scripts.map((x) => (
                <option key={x.id} value={x.version}>
                  v{x.version} — {x.status.toLowerCase().replace('_', ' ')} — {SCRIPT_ORIGIN_LABELS[x.origin].toLowerCase()}
                </option>
              ))}
            </select>
          )}
        </div>
        <ProjectNav project={p} />
        <p className="mt-2 text-xs text-stone-500">
          The approved story architecture{v.architecture ? ` (v${v.architecture.version})` : ''} as it will be spoken. Every block keeps the information class of the beats it tells and cites the claims behind it; fiction stays labelled; nothing is approved automatically and nothing is voiced here.
        </p>
      </div>

      <ScriptActions project={p} view={v} running={running} onQueued={showLatest} />

      {s && <Header view={v} />}

      {s && (
        <>
          <div className="flex flex-wrap gap-1 border-b border-stone-200">
            {tabs.map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'script' && <ScriptTab projectId={p.id} view={v} />}
          {tab === 'quality' && <QualityTab view={v} />}
          {tab === 'voice' && <VoiceTab projectId={p.id} script={s} />}
          {tab === 'versions' && <VersionsTab projectId={p.id} view={v} onVersion={showVersion} />}
          {tab === 'runs' && <RunsTab view={v} />}
        </>
      )}
    </div>
  );
}

function Header({ view: v }: { view: ScriptView }) {
  const s = v.script!;
  const fails = s.qualityReport?.checks.filter((c) => c.status === 'FAIL').length ?? 0;
  const warns = s.qualityReport?.checks.filter((c) => c.status === 'WARN').length ?? 0;
  const blocks = s.sections.reduce((n, x) => n + x.blocks.length, 0);
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <p className="font-semibold">
          Script v{s.version} <span className="font-normal text-stone-500">· {s.status.toLowerCase().replace('_', ' ')}</span>
        </p>
        <p className="text-stone-600">
          {SCRIPT_ORIGIN_LABELS[s.origin]}
          {s.revisionOfVersion ? ` of v${s.revisionOfVersion}` : ''} · architecture v{s.architectureVersion ?? '—'}
        </p>
        <p className="text-stone-600">
          {s.sections.length} sections · {blocks} blocks · {s.wordCount.toLocaleString()} words
        </p>
        {s.content?.narrator.persona && <p className="mt-1 text-xs text-stone-500">Narrator: {s.content.narrator.persona} — {s.content.narrator.tone}</p>}
      </div>
      <div className="rounded-lg border border-stone-200 bg-white p-3">
        <TimingSummary script={s} />
      </div>
      <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${fails ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>{fails ? `Gate: ${fails} blocking` : 'Gate passed'}</span>
          {warns > 0 && <span className="ml-1 text-xs text-amber-800">{warns} warning(s)</span>}
        </p>
        <p className="mt-1 text-stone-600">
          Generation cost {formatUsd(s.cost.totalUsd)}
          {s.cost.includesEstimates && ' (estimated)'} · {s.cost.calls} model call(s)
        </p>
        <p className="text-stone-600">
          Voice: {s.voice.characters.toLocaleString()} characters for {s.voice.provider}
        </p>
      </div>
    </div>
  );
}

function ScriptActions({ project: p, view: v, running, onQueued }: { project: ProjectDetailView; view: ScriptView; running: boolean; onQueued: () => void }) {
  const [notes, setNotes] = useState('');
  const [brief, setBrief] = useState('');
  const [gateNotes, setGateNotes] = useState('');
  const s = v.script;
  // Off by default: the performance pass stays within the runtime maximum unless the user says otherwise.
  const [overMax, setOverMax] = useState(false);
  const over = overMax ? { allowPerformanceOverMax: true } : {};
  const generate = useScriptRequest(() => api.generateScript(p.id, { ...(notes.trim() ? { notes: notes.trim() } : {}), ...over }), () => {
    setNotes('');
    onQueued();
  });
  const revise = useScriptRequest(() => api.reviseScript(p.id, { baseVersion: s!.version, brief: brief.trim(), ...over }), () => {
    setBrief('');
    onQueued();
  });
  const [direction, setDirection] = useState('');
  const refine = useScriptRequest(() => api.refineScript(p.id, { baseVersion: s!.version, ...(direction.trim() ? { instructions: direction.trim() } : {}), ...over }), () => {
    setDirection('');
    onQueued();
  });
  const overMaxToggle = (id: string) => (
    <label htmlFor={id} className="mt-2 flex items-start gap-2 text-xs text-stone-600">
      <input id={id} type="checkbox" checked={overMax} onChange={(e) => setOverMax(e.target.checked)} className="mt-0.5" />
      <span>
        Let pauses and slower delivery take it past the {fmtClock(p.targetMinutesMax * 60)} maximum. Off: the performance pass stays within it, giving up the least valuable timing first.
      </span>
    </label>
  );
  const decide = useScriptRequest((decision: ApprovalDecision) => api.approve(p.id, { gate: 'SCRIPT', decision, notes: gateNotes.trim() || undefined }), () => setGateNotes(''));
  const retry = useScriptRequest((jobId: string) => api.retryJob(jobId));
  const progress = p.events.find((e) => e.type === 'JOB_PROGRESS');
  const failed = p.status === 'FAILED' && p.failedFromStatus === 'SCRIPT_DRAFT';
  const failedJob = p.jobs.find((j) => j.type === 'SCRIPT' && j.status === 'FAILED');
  const underReview = v.scripts.find((x) => x.status === 'IN_REVIEW');
  const error = generate.error ?? revise.error ?? refine.error ?? decide.error ?? retry.error;

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      {!v.realStage && <p className="text-sm text-amber-800">The script stage is a MOCK here: writing a script needs the real AI provider.</p>}

      {running && (
        <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">
          <p className="font-medium">Working on the script — the writing, then the script editor, the fact checker and the performance pass…</p>
          {progress && <p className="mt-1 text-xs">Latest: {progress.message}</p>}
        </div>
      )}

      {!running && (p.status === 'STORY_APPROVED' || (p.status === 'SCRIPT_DRAFT' && !s)) && (
        <div>
          <p className="text-sm">
            The story architecture{v.architecture ? ` v${v.architecture.version}` : ''} is approved. The Script Engine plans the narration, writes it, has a script editor and a fact checker review it, and marks the performance — then stops for you. No voice is generated.
          </p>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Instructions for the writer (optional) — e.g. keep the opening under a minute" className="mt-2 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
          {overMaxToggle('over-max-draft')}
          <button disabled={generate.isPending || !v.editorial.generate.allowed} onClick={() => generate.mutate(undefined)} className={`${button} mt-1 bg-sky-700 text-white hover:bg-sky-600`}>
            Generate Script Draft
          </button>
          {v.editorial.generate.reason && <span className="ml-2 text-xs text-amber-700">{v.editorial.generate.reason}</span>}
        </div>
      )}

      {p.status === 'SCRIPT_REVIEW' && underReview && (
        <div className="rounded-md border-2 border-violet-300 bg-violet-50 p-3">
          <p className="font-semibold text-violet-900">Human approval required — script v{underReview.version}</p>
          {s && s.version !== underReview.version && <p className="text-sm text-violet-900">You are looking at v{s.version}; this decision applies to v{underReview.version}.</p>}
          <p className="text-sm text-violet-800">Read it as it will be heard. The gate's blocking findings and rejected sections must be dealt with before approval. Approving does not start the voice.</p>
          {s?.version === underReview.version && s.blocking.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm text-red-800">
              {s.blocking.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          <textarea value={gateNotes} onChange={(e) => setGateNotes(e.target.value)} rows={2} placeholder="Notes — what works, what to change" className="mt-2 w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={decide.isPending || !v.editorial.approve.allowed} onClick={() => decide.mutate('APPROVED')} title={v.editorial.approve.reason ?? undefined} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
              Approve Entire Script
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
              Reject
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('FLAGGED')} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
              Flag
            </button>
          </div>
          {v.editorial.approve.reason && <p className="mt-1 text-xs text-violet-900">{v.editorial.approve.reason}</p>}
        </div>
      )}

      {p.status === 'SCRIPT_APPROVED' && <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">Script approved. Nothing proceeds automatically: voice is the next milestone.</p>}

      {failed && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          <p>The script job failed.</p>
          {failedJob?.error && <p className="mt-1 text-xs break-words">{failedJob.error}</p>}
          {failedJob && (
            <button disabled={retry.isPending} onClick={() => retry.mutate(failedJob.id)} className={`${button} mt-2 bg-red-700 text-white hover:bg-red-600`}>
              Retry
            </button>
          )}
          <p className="mt-1 text-xs">Retry continues from the last completed model call: completed calls are reused, not paid again.</p>
        </div>
      )}

      {s && v.editorial.refine.allowed && !running && (
        <details className="rounded-md border border-violet-200 bg-violet-50/40 p-3 text-sm">
          <summary className="cursor-pointer font-medium text-violet-900">Refine the narration of v{s.version} (the writing only)…</summary>
          <p className="mt-2 text-stone-700">
            Rewrites how the whole script is told, for the ear: the same story, structure, information classes and evidence — no new facts. Strong lines are kept; signposting, restated explanations and essay-like passages go. The script editor then
            judges it against v{s.version} with a checklist, the fact checker checks it and the performance is marked again (four model calls). v{s.version} is kept; compare them in Versions.
          </p>
          <p className="mt-1 text-xs text-stone-500">The house style is built in — nothing needs to be written here. Director's instructions are optional: they can steer tone, emphasis, pacing and creative direction, never the facts, the architecture, quotations or the line between fiction and history.</p>
          <label className="mt-2 block text-xs font-medium text-stone-600" htmlFor="director-instructions">
            Director's instructions (optional)
          </label>
          <textarea id="director-instructions" value={direction} onChange={(e) => setDirection(e.target.value)} rows={3} placeholder="e.g. drier humour in the opening; let the court scene breathe; keep the companion out of section 5" className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm" />
          {overMaxToggle('over-max-refine')}
          <button disabled={refine.isPending} onClick={() => refine.mutate(undefined)} className={`${button} mt-1 bg-violet-700 text-white hover:bg-violet-600`}>
            Refine the narration
          </button>
        </details>
      )}

      {s && v.editorial.revise.allowed && !running && (
        <details className="rounded-md border border-sky-200 bg-sky-50/50 p-3 text-sm">
          <summary className="cursor-pointer font-medium text-sky-900">Generate Revision of v{s.version} (the whole script)…</summary>
          <p className="mt-2 text-stone-700">The writer rewrites the whole script from your brief — the plan is made again, then the script editor, the fact checker and the performance pass review it. v{s.version} is kept. To change one section only, use “Regenerate section” on it (cheaper: the others are copied unchanged).</p>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="What to change — e.g. the first 90 seconds are too slow; start closer to the collapse" className="mt-2 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm" />
          {overMaxToggle('over-max-revise')}
          <button disabled={revise.isPending || brief.trim().length < 10} onClick={() => revise.mutate(undefined)} className={`${button} mt-1 bg-sky-700 text-white hover:bg-sky-600`}>
            Generate Revision
          </button>
        </details>
      )}
      {s && !running && v.editorial.generate.allowed && p.status !== 'STORY_APPROVED' && (
        <details className="text-sm">
          <summary className="cursor-pointer text-stone-600">Write a fresh draft from the architecture…</summary>
          <p className="mt-1 text-xs text-stone-500">Starts again from the approved architecture (all five steps). Every earlier version is kept.</p>
          <button disabled={generate.isPending} onClick={() => generate.mutate(undefined)} className={`${button} mt-1 bg-stone-800 text-white`}>
            Write a fresh draft
          </button>
        </details>
      )}
      {!s && !running && !['STORY_APPROVED', 'SCRIPT_DRAFT'].includes(p.status) && !failed && <p className="text-sm text-stone-500">The script is written once the story architecture is approved (project status: {STATUS_LABELS[p.status]}).</p>}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
    </section>
  );
}

function ScriptTab({ projectId, view: v }: { projectId: string; view: ScriptView }) {
  const s = v.script!;
  const cast = useMemo(() => new Map(s.cast.map((c) => [c.id, { name: c.name, kind: c.kind }])), [s.cast]);
  const q = s.content?.centralQuestion;
  return (
    <div className="space-y-4">
      {q?.text && (
        <p className="text-sm text-stone-600">
          Central question: <span className="font-medium text-violet-900">{q.text}</span> — posed in {q.posedIn ?? '—'}, answered in {q.answeredIn ?? '—'}
        </p>
      )}
      {s.content?.provenance.brief && (
        <p className="text-sm text-stone-600">
          {s.origin === 'REFINEMENT' ? "Director's instructions" : 'Brief'} for v{s.version}: “{s.content.provenance.brief}”{s.content.provenance.requestedBy ? ` — ${s.content.provenance.requestedBy}` : ''}
        </p>
      )}
      {s.origin === 'REFINEMENT' && !s.content?.provenance.brief && <p className="text-sm text-stone-600">Refined with the house style (no director's instructions).</p>}
      {s.content?.provenance.changeLog && s.content.provenance.changeLog.changes.length > 0 && (
        <details className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
          <summary className="cursor-pointer font-medium text-stone-700">What changed in v{s.version}, and why</summary>
          <p className="mt-1">{s.content.provenance.changeLog.summary}</p>
          <ul className="mt-1 list-disc pl-5">
            {s.content.provenance.changeLog.changes.map((c, i) => (
              <li key={i}>
                {c.section ? `Section ${c.section}: ` : ''}
                {c.what} <span className="text-stone-500">— {c.why}</span>
              </li>
            ))}
          </ul>
          {(s.content.provenance.changeLog.kept ?? []).length > 0 && (
            <>
              <p className="mt-2 font-medium text-stone-700">Kept word for word</p>
              <ul className="mt-1 list-disc pl-5 text-stone-700">
                {s.content.provenance.changeLog.kept!.map((l, i) => (
                  <li key={i}>“{l}”</li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      {s.sections.map((sec) => (
        <SectionCard key={sec.id} projectId={projectId} view={v} script={s} section={sec} claims={s.evidence.claims} cast={cast} />
      ))}
    </div>
  );
}

function QualityTab({ view: v }: { view: ScriptView }) {
  const s = v.script!;
  const editor = s.content?.editor;
  const report = s.qualityReport;
  const changes = s.content?.reviewChanges ?? [];
  return (
    <div className="space-y-4">
      {report?.measurements && report.measurements.length > 0 && <MeasurementsSection items={report.measurements} />}
      {report ? <QualityReportView report={report} claims={s.evidence.claims} reviewTitle="Reviewers' issues (model judgments)" /> : <p className="text-sm text-stone-500">No quality report.</p>}
      {changes.length > 0 && <ReviewChangesSection changes={changes} />}
      {report?.judgments && report.judgments.length > 0 && <JudgmentsSection items={report.judgments} />}
      {editor?.assessment && editor.assessment.length > 0 && <AssessmentList items={editor.assessment} against={s.revisionOfVersion} />}
      {editor && (
        <Section title="Script editor's scores (model judgment — recorded, never blocking)">
          <p className="text-sm">{editor.verdict}</p>
          <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
            {SCRIPT_SCORES.map((k) =>
              editor.scores[k] ? (
                <li key={k}>
                  <span className="font-medium tabular-nums">{editor.scores[k]!.score}/10</span> {SCRIPT_SCORE_LABELS[k]} <span className="text-stone-500">— {editor.scores[k]!.why}</span>
                </li>
              ) : null,
            )}
          </ul>
        </Section>
      )}
    </div>
  );
}

function RunsTab({ view: v }: { view: ScriptView }) {
  const s = v.script!;
  return (
    <Section title={`Script v${s.version} — ${formatDate(s.createdAt)}`}>
      <p className="text-2xl font-semibold tabular-nums">
        {formatUsd(s.cost.totalUsd)}
        {s.cost.includesEstimates && <span className="ml-2 align-middle text-xs font-normal text-amber-700">estimated</span>}
      </p>
      <p className="text-xs text-stone-500">
        {s.cost.calls} provider call(s) by the job that wrote this version · {fmtClock(s.timing.totalSec)} of narration
      </p>
      <pre className="mt-2 overflow-x-auto text-xs text-stone-600">{JSON.stringify(s.stats, null, 2)}</pre>
    </Section>
  );
}
