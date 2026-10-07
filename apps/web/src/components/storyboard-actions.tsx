import {
  JOB_TYPE_LABELS,
  VISUAL_APPROACH_LABELS,
  VISUAL_APPROACHES,
  type JobView,
  type ProjectDetailView,
  type StoryboardInputsView,
  type StoryboardView,
  type StoryboardVersionView,
  type VisualApproach,
} from '@docengine/core';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { approvalNeeds, assemblyText, blockRange, inputsStrip, planDefaults, planKind, productionText, sameSettings, statusWords } from '../storyboard-plan.ts';
import { ReplanBeats } from './storyboard-shots.tsx';
import { RaceNotice, Why, useEdits, useStoryboardRequest, versionRace, type EditContext } from './storyboard.tsx';
import { ProductionLine, VisualSelectionForm } from './visual-profiles.tsx';
import { approve, danger, input, link, primary, secondary, summary } from './ui.ts';

/**
 * The Storyboard page's header strip and actions: what a version was
 * planned from (and the visual profile the next plan would use, with a
 * Change control), planning one — a paid job, confirmed with the request it
 * belongs to — the running job and its latest progress, a failed job's
 * retry, re-planning, re-timing and restoring, and a person's decision on
 * the version (a whole-script version under review is decided at the
 * STORYBOARD gate). Nothing here generates a picture.
 */

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The storyboard jobs of the project, newest first. */
const storyboardJobs = (p: ProjectDetailView) => p.jobs.filter((j) => j.type === 'VISUAL_PLAN' || j.type === 'STORYBOARD_PREVIEW');

// ── The inputs strip ─────────────────────────────────────────────────────────

/**
 * "Script v5 · Architecture v3 · Voice run 3 (audition, blocks 1.1–1.10) ·
 * assembly v1 · takes 0/11 approved, provisional timing · Visual profile …
 * · engine v1 · Nothing is generated in this milestone", then the visual
 * profile the next plan would use, with Change.
 */
export function InputsStrip({ project: p, inputs, version: v, ctx }: { project: ProjectDetailView; inputs: StoryboardInputsView; version: StoryboardVersionView | null; ctx: EditContext | null }) {
  const [changing, setChanging] = useState(false);
  const production = inputs.profile;
  const parts = v
    ? inputsStrip(v)
    : [inputs.script ? `Script v${inputs.script.version}` : 'No approved script', inputs.architecture ? `Architecture v${inputs.architecture.version}` : null, production.profile && production.family ? `Visual profile ${production.family.name} v${production.profile.version}` : null, 'engine v1'].filter((x): x is string => !!x);
  const planned = v?.inputs.profile;
  const moved = !!v && !!production.profile && (planned!.profileId !== production.profile.id || !sameSettings(planned!.overrides, production.overrides));
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-600" data-inputs-strip>
      <p className="break-words">
        {parts.join(' · ')} · <strong className="text-stone-800">Nothing is generated in this milestone</strong>
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-profile-control>
        <span className="text-stone-500">Visual profile for the next plan:</span>
        <span className="min-w-0 break-words text-stone-800">
          <ProductionLine production={production} />
        </span>
        <button type="button" onClick={() => setChanging((x) => !x)} aria-expanded={changing} className={link}>
          {changing ? 'Close' : 'Change'}
        </button>
        <Link to="/visual-profiles" className={link}>
          Visual profiles
        </Link>
      </div>
      {production.notices.map((n) => (
        <p key={n} className="text-amber-900">
          {n}
        </p>
      ))}
      {changing && (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-2">
          <VisualSelectionForm key={`${production.revision}:${production.profile?.id ?? ''}`} projectId={p.id} production={production} onSaved={() => setChanging(false)} />
        </div>
      )}
      {moved && v && ctx && <Recost version={v} production={production} ctx={ctx} />}
    </div>
  );
}

/** The project's profile changed since a version was planned: re-cost it with the new one, as a new version (no model call). */
function Recost({ version: v, production, ctx }: { version: StoryboardVersionView; production: StoryboardInputsView['profile']; ctx: EditContext }) {
  const edits = useEdits(ctx);
  return (
    <div className="space-y-1 rounded-md bg-amber-50 p-2 text-amber-900" data-recost>
      <p className="break-words">
        v{v.version} was planned with {v.inputs.profile.familyName} v{v.inputs.profile.version}; the project now plans with {productionText(production)}. The shots keep their treatments; re-costing applies the new profile's frame, rerolls and preferences to the forecast.
      </p>
      {ctx.allowed.allowed ? (
        <button type="button" disabled={edits.pending || edits.race !== null} onClick={() => edits.submit([{ op: 'setProfile', selectionRevision: production.revision }], 'Re-costed with the project\'s visual profile')} className={secondary}>
          Re-cost v{v.version} with it (a new version, no model call)
        </button>
      ) : (
        <Why action={ctx.allowed} />
      )}
      {edits.race !== null && <RaceNotice race={edits.race} pending={edits.pending} onSaveAnyway={edits.saveAnyway} onReload={ctx.onReload} what="the re-costing" />}
      {edits.error && <p className="break-words text-red-700">{edits.error.message}</p>}
    </div>
  );
}

// ── Actions ──────────────────────────────────────────────────────────────────

export function StoryboardActions({ project: p, view, inputs, onQueued, onSaved, onReload }: { project: ProjectDetailView; view: StoryboardView; inputs: StoryboardInputsView; onQueued: () => void; onSaved: (view: StoryboardView) => void; onReload: () => void }) {
  const v = view.storyboard;
  const jobs = storyboardJobs(p);
  const active = view.activeJob;
  const latest = jobs[0] ?? null;
  const progress = active ? p.events.find((e) => e.type === 'JOB_PROGRESS') : null;
  const sentBack = !active && p.status === 'VISUAL_PLANNING' && v?.scope === 'FULL';
  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4" data-storyboard-actions>
      {!view.realStage && <p className="text-sm text-amber-800">The storyboard is planned by the model, which is not configured here (MOCK): nothing would be planned.</p>}
      {active && (
        <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900" role="status" data-running>
          <p className="font-medium">
            Planning the storyboard{active.type === 'STORYBOARD_PREVIEW' ? ' (a preview)' : ''} — the visual beats, then each section's shots, then the checks… this page updates when the version is saved.
          </p>
          {progress && <p className="mt-1 text-xs">Latest: {progress.message}</p>}
        </div>
      )}
      {!active && latest && (latest.status === 'FAILED' || latest.status === 'CANCELLED') && <FailedJob job={latest} />}
      {sentBack && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900" data-sent-back>
          The STORYBOARD gate sent the storyboard back for re-planning (the project is “{statusWords(p.status)}”). Plan it again — a paid job, below — to bring it back to review: an edit saved meanwhile is decided only after that re-plan.
        </p>
      )}
      {!v ? (
        <PlanForm project={p} inputs={inputs} allowed={view.editorial.generate} onQueued={onQueued} />
      ) : (
        <>
          <DecisionPanel project={p} view={view} version={v} onReload={onReload} />
          <details className="text-sm" data-more>
            <summary className={summary}>Plan again, re-plan beats, switch approach, re-time or restore…</summary>
            <div className="mt-2 space-y-4">
              <MoreAction title={`Re-plan beats of v${v.version}`} allowed={view.editorial.regenerateBeats}>
                <ReplanBeats version={v} />
              </MoreAction>
              <MoreAction title="Switch approach" allowed={view.editorial.approach}>
                <SwitchApproach version={v} />
              </MoreAction>
              <MoreAction title="Re-time onto newer narration" allowed={view.editorial.retime}>
                <Retime version={v} inputs={inputs} newest={view.versions[0]!.version} onSaved={onSaved} />
              </MoreAction>
              <MoreAction title={`Restore v${v.version}`} allowed={view.editorial.restore}>
                <Restore version={v} newest={view.versions[0]!.version} onSaved={onSaved} onReload={onReload} />
              </MoreAction>
              <MoreAction title="Plan a new storyboard" allowed={view.editorial.generate}>
                <PlanForm project={p} inputs={inputs} allowed={view.editorial.generate} onQueued={onQueued} again />
              </MoreAction>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function MoreAction({ title, allowed, children }: { title: string; allowed: { allowed: boolean; reason: string | null }; children: ReactNode }) {
  return (
    <div className="border-t border-stone-100 pt-2" data-action={title}>
      <h3 className="text-sm font-medium text-stone-800">{title}</h3>
      {allowed.allowed ? children : <p className="text-xs text-stone-500">{allowed.reason ?? 'Not available now.'}</p>}
    </div>
  );
}

/** The last planning job failed (or was cancelled): why, and Retry, which reuses the model calls that completed. */
function FailedJob({ job }: { job: JobView }) {
  const retry = useStoryboardRequest(() => api.retryJob(job.id));
  return (
    <div className="rounded-md bg-red-50 p-3 text-sm text-red-800" data-failed-job>
      <p>
        The last planning job ({JOB_TYPE_LABELS[job.type]}) {job.status === 'CANCELLED' ? 'was cancelled' : 'failed'}.
      </p>
      {job.error && <p className="mt-1 text-xs break-words">{job.error}</p>}
      <button type="button" disabled={retry.isPending} onClick={() => retry.mutate(undefined)} className={`${primary} mt-2 bg-red-700 hover:bg-red-600`}>
        Retry
      </button>
      <p className="mt-1 text-xs">Retry continues from the last completed model call: completed calls are reused, not paid again.</p>
      {retry.error && <p className="mt-1 text-xs break-words">{retry.error.message}</p>}
    </div>
  );
}

/**
 * Plan a storyboard of a voice run's narration: a preview while the
 * narration is reviewed, the phase job on the narration the VOICE gate
 * approved. A paid planning job, so the confirmation belongs to exactly
 * this request: any change of narration, approach or profile asks again.
 */
function PlanForm({ project: p, inputs, allowed, onQueued, again = false }: { project: ProjectDetailView; inputs: StoryboardInputsView; allowed: { allowed: boolean; reason: string | null }; onQueued: () => void; again?: boolean }) {
  const defaults = planDefaults(p, inputs);
  const [runId, setRunId] = useState(defaults?.runId ?? '');
  const run = inputs.runs.find((r) => r.id === runId) ?? null;
  const [assemblyId, setAssemblyId] = useState(defaults?.assemblyId ?? '');
  const assembly = run?.assemblies.find((a) => a.id === assemblyId) ?? null;
  const [approach, setApproach] = useState<VisualApproach | ''>('');
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const kind = assembly ? planKind(p, assembly) : { kind: null, reason: 'Choose the narration to time it on' };
  const request = { narration: { runId, assemblyId }, ...(approach ? { approach } : {}), selectionRevision: inputs.profile.revision };
  // A preview or the phase job: the same request may become the other when the project's status moves, so the tick names it too.
  const key = JSON.stringify({ ...request, kind: kind.kind });
  const send = useStoryboardRequest(() => api.generateStoryboard(p.id, { ...request, confirm: true }), () => {
    setConfirmed(null);
    onQueued();
  });
  const blocked = inputs.blocked ?? (allowed.allowed ? null : allowed.reason);
  const profileApproach = inputs.profile.effective?.approach ?? null;
  if (blocked) return <p className="text-sm text-stone-600" data-plan-blocked>{blocked}</p>;
  return (
    <div className="space-y-3 text-sm" data-plan-form>
      {!again && (
        <p className="text-stone-700">
          The Storyboard Engine turns the narration's real audio into visual beats and shots: what is on screen, when, why, and how it would be produced, with a forecast of its cost. It is planned by the model (a paid job, within the ceiling below) and stops for your review. Nothing is generated: no picture, video, voice or render.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Narration (voice run)</span>
          <select
            value={runId}
            onChange={(e) => {
              const r = inputs.runs.find((x) => x.id === e.target.value);
              setRunId(e.target.value);
              setAssemblyId(r?.assemblies.find((a) => a.gateApproved)?.id ?? r?.assemblies[0]?.id ?? '');
            }}
            aria-label="Voice run"
            className={input}
          >
            {!runId && <option value="">Choose a voice run</option>}
            {inputs.runs.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.current || !r.assemblies.length}>
                {r.label} · blocks {blockRange(r.scopeBlockKeys)}
                {!r.current ? ' (another script)' : !r.assemblies.length ? ' (not assembled)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Assembled narration</span>
          <select value={assemblyId} onChange={(e) => setAssemblyId(e.target.value)} aria-label="Assembly" className={input}>
            {(run?.assemblies ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {assemblyText(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-stone-500">Approach planned in full (the others are costed beside it)</span>
          <select value={approach} onChange={(e) => setApproach(e.target.value as VisualApproach | '')} aria-label="Approach" className={input}>
            <option value="">{profileApproach ? `The visual profile's (${profileApproach} — ${VISUAL_APPROACH_LABELS[profileApproach]})` : "The visual profile's"}</option>
            {VISUAL_APPROACHES.map((a) => (
              <option key={a} value={a}>
                {a} — {VISUAL_APPROACH_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <p className="min-w-0 self-end text-xs break-words text-stone-500">
          Visual profile: {productionText(inputs.profile)} (revision {inputs.profile.revision})
        </p>
      </div>
      {assembly && assembly.takes.approved < assembly.takes.total && (
        <p className="text-xs text-amber-900">
          Takes {assembly.takes.approved}/{assembly.takes.total} approved: the timing is real audio but provisional, and approving the storyboard needs every take approved (on the Voice page; approving a take changes no timing, so nothing is planned again).
        </p>
      )}
      {assembly?.mock && <p className="text-xs text-amber-900">Mock audio: the version will carry a blocking “mock narration” finding until it is timed on real narration.</p>}
      {kind.reason && <p className="text-xs text-red-700">{kind.reason}</p>}
      {kind.kind && (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed === key} onChange={(e) => setConfirmed(e.target.checked ? key : null)} />
            <span>
              I confirm a paid planning job{kind.kind === 'PREVIEW' ? ' (a preview: the project status does not change)' : ''}: model calls only, at most {usd(inputs.planningCeilingUsd)} (the planning ceiling). Nothing is generated: no picture, video, voice or render.
            </span>
          </label>
          <button type="button" disabled={send.isPending || confirmed !== key} onClick={() => send.mutate(undefined)} className={primary}>
            {kind.kind === 'PREVIEW' ? 'Plan the storyboard (preview)' : 'Plan the storyboard'}
          </button>
        </>
      )}
      {send.error && <p className="text-sm break-words text-red-700">{send.error.message}</p>}
    </div>
  );
}

/** Plan another approach from this version: a paid re-plan of the beats whose treatment changes. */
function SwitchApproach({ version: v }: { version: StoryboardVersionView }) {
  const others = VISUAL_APPROACHES.filter((a) => a !== v.approach);
  const [approach, setApproach] = useState<VisualApproach>(others[0]!);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  // The tick belongs to this approach from this version: another version shown asks again.
  const key = `${v.id}:${approach}`;
  const send = useStoryboardRequest(() => api.switchApproach(v.id, { approach, expectedVersion: v.version, confirm: true }), () => setConfirmed(null));
  const summary = v.approaches.find((a) => a.approach === approach);
  return (
    <div className="space-y-2 text-sm" data-switch-approach>
      <label className="block max-w-sm">
        <span className="block text-xs text-stone-500">Approach (v{v.version} plans {v.approach})</span>
        <select value={approach} onChange={(e) => setApproach(e.target.value as VisualApproach)} aria-label="Approach to switch to" className={input}>
          {others.map((a) => (
            <option key={a} value={a}>
              {a} — {VISUAL_APPROACH_LABELS[a]}
            </option>
          ))}
        </select>
      </label>
      {summary && <p className="text-xs text-stone-500">About {summary.estimatedShots} shots; generated video {Math.round(summary.generatedVideoShare * 100)}% of the runtime (see the Overview for its forecast).</p>}
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={confirmed === key} onChange={(e) => setConfirmed(e.target.checked ? key : null)} />
        <span>I confirm a paid planning job for the beats whose treatment changes: model calls only, within the planning ceiling. Nothing is generated; v{v.version} is kept.</span>
      </label>
      <button type="button" disabled={confirmed !== key || send.isPending} onClick={() => send.mutate(undefined)} className={primary}>
        Plan approach {approach}
      </button>
      {send.error && <p className="text-xs break-words text-red-700">{send.error.message}</p>}
      {send.isSuccess && <p className="text-xs text-sky-800">Queued: the page updates when the new version is saved.</p>}
    </div>
  );
}

/** The same plan on a newer assembly of its voice run (a take regenerated or restored): times from the word anchors, no model call. */
function Retime({ version: v, inputs, newest, onSaved }: { version: StoryboardVersionView; inputs: StoryboardInputsView; newest: number; onSaved: (view: StoryboardView) => void }) {
  const newer = (inputs.runs.find((r) => r.id === v.narration.runId)?.assemblies ?? []).filter((a) => a.version > v.narration.assemblyVersion);
  const [assemblyId, setAssemblyId] = useState(newer[0]?.id ?? '');
  const send = useStoryboardRequest(() => api.retimeStoryboard(v.id, { assemblyId, expectedVersion: newest }), onSaved);
  if (!newer.length) return <p className="text-xs text-stone-500">Run {v.narration.runNumber} has no assembly newer than v{v.narration.assemblyVersion}.</p>;
  return (
    <div className="space-y-2 text-sm" data-retime>
      <label className="block max-w-md">
        <span className="block text-xs text-stone-500">Re-time v{v.version} onto</span>
        <select value={assemblyId} onChange={(e) => setAssemblyId(e.target.value)} aria-label="Assembly to re-time onto" className={input}>
          {newer.map((a) => (
            <option key={a.id} value={a.id}>
              {assemblyText(a)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-stone-500">Every cut stays on the same words; only the times move. Refused if a cut no longer falls on a cut point of the new audio.</p>
      <button type="button" disabled={!assemblyId || send.isPending} onClick={() => send.mutate(undefined)} className={secondary}>
        Re-time (a new version, no model call)
      </button>
      {send.error && <p className="text-xs break-words text-red-700">{send.error.message}</p>}
    </div>
  );
}

/** An older version made the newest again, as a copy: the history is kept. */
function Restore({ version: v, newest, onSaved, onReload }: { version: StoryboardVersionView; newest: number; onSaved: (view: StoryboardView) => void; onReload: () => void }) {
  const send = useStoryboardRequest(() => api.restoreStoryboard(v.id, { expectedVersion: newest }), onSaved);
  const race = versionRace(send.error);
  return (
    <div className="space-y-2 text-sm" data-restore>
      <p className="text-xs text-stone-500">
        Saves a copy of v{v.version} as v{newest + 1}; v{newest} and every other version are kept. Decisions on unchanged shots are carried; the version-level decision is not.
      </p>
      <button type="button" disabled={send.isPending} onClick={() => send.mutate(undefined)} className={secondary}>
        Restore v{v.version} as v{newest + 1} (no model call)
      </button>
      {send.error && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-red-700">
          <span className="min-w-0 break-words">{send.error.message}</span>
          {race !== null && (
            <button type="button" onClick={onReload} className={secondary}>
              Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * A person's decision on the version shown: Approve, Request changes or
 * Reject, with what blocks approval. A preview is decided at version level
 * (it never passes the project's gate); a whole-script version under
 * review is decided at the STORYBOARD gate, where Reject sends the project
 * back to planning. Nothing is ever approved by itself, and approving
 * starts nothing.
 */
function DecisionPanel({ project: p, view, version: v, onReload }: { project: ProjectDetailView; view: StoryboardView; version: StoryboardVersionView; onReload: () => void }) {
  const [note, setNote] = useState('');
  const newest = view.versions[0]!.version;
  const decide = useStoryboardRequest((decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') => api.decideStoryboard(v.id, { decision, ...(note.trim() ? { note: note.trim() } : {}), expectedVersion: newest }), () => setNote(''));
  const allowed = view.editorial.decide;
  const gate = v.scope === 'FULL';
  const needs = approvalNeeds(v);
  const race = versionRace(decide.error);
  return (
    <div className={`rounded-md border-2 p-3 ${allowed.allowed ? 'border-violet-300 bg-violet-50' : 'border-stone-200 bg-stone-50'}`} data-decision>
      <p className="font-semibold text-violet-900">{gate ? `STORYBOARD gate — v${v.version} (the whole script)` : `Your decision on v${v.version} (a preview)`}</p>
      {!allowed.allowed ? (
        <p className="mt-1 text-sm text-stone-600">{allowed.reason}</p>
      ) : (
        <div className="mt-1 space-y-2">
          <p className="text-sm text-violet-900">
            {gate
              ? `Approve → ${statusWords('STORYBOARD_APPROVED')}: nothing is generated or queued (visual generation is the next milestone). Request changes keeps it in review for edits; Reject sends the project back to planning — a paid re-plan.`
              : 'A preview is approved at version level: it never passes the project’s STORYBOARD gate, and approving it starts nothing. Request changes keeps it open for edits; Reject is final for this version.'}
          </p>
          {needs.length > 0 && (
            <div className="text-sm text-red-800" data-approval-needs>
              <p>Approval needs:</p>
              <ul className="list-disc pl-5">
                {needs.map((n) => (
                  <li key={n} className="break-words">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} placeholder="Note (optional) — what you checked, what to change" aria-label="Decision note" className="w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={decide.isPending || needs.length > 0} onClick={() => decide.mutate('APPROVED')} className={approve}>
              Approve v{v.version}
            </button>
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('CHANGES_REQUESTED')} className={secondary}>
              Request changes
            </button>
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={danger}>
              {gate ? 'Reject (re-plan)' : 'Reject'}
            </button>
          </div>
        </div>
      )}
      {decide.error && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-700">
          <span className="min-w-0 break-words">{decide.error.message}</span>
          {race !== null && (
            <button type="button" onClick={onReload} className={secondary}>
              Reload
            </button>
          )}
        </div>
      )}
      {p.status === 'STORYBOARD_APPROVED' && gate && <p className="mt-2 text-sm text-emerald-800">The storyboard is approved at the STORYBOARD gate. Visual generation is the next milestone: it starts only after the storyboard is reviewed and accepted.</p>}
    </div>
  );
}
