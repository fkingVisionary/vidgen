import {
  STORYBOARD_FINDING_LABELS,
  STORYBOARD_SCOPE_LABELS,
  VISUAL_APPROACH_HELP,
  VISUAL_APPROACH_LABELS,
  VISUAL_COST_BASIS_LABELS,
  VISUAL_TREATMENT_LABELS,
  VISUAL_TREATMENT_TONES,
  type ApproachSummaryView,
  type EditorialAction,
  type StoryboardSummaryView,
  type StoryboardVersionView,
} from '@docengine/core';
import { useState } from 'react';
import { api } from '../api.ts';
import { formatDate } from '../format.ts';
import { TONE_BAR, blockRange, changesLines, clock, decidedText, decisionText, findingCounts, mixShares, percent, rollupText, secondsText, staleFindings, takesApproved, treatmentMix, versionLabel } from '../storyboard-plan.ts';
import { NarrationApprovalBadge, Stat, StoryboardStatusBadge, ToneChip, Why, useStoryboardRequest } from './storyboard.tsx';
import { link, pill, primary, secondary } from './ui.ts';

/**
 * The Overview tab: the version at a glance (status and approval, runtime,
 * shots and beats, the treatment breakdown, the forecast — an estimate,
 * never spend — QA, evidence and the narration it is timed on), the three
 * approaches costed side by side, and every version with how it came
 * about. Nothing here has been generated or spent.
 */
export function OverviewTab({ version: v, versions, approach, onVersion }: { version: StoryboardVersionView; versions: readonly StoryboardSummaryView[]; approach: EditorialAction; onVersion: (version: number) => void }) {
  const live = findingCounts(v.qa.live);
  const stale = staleFindings(v.qa.live);
  const takes = takesApproved(v.narrationLane);
  const mix = treatmentMix(v.shots);
  const needingReference = v.continuity.filter((c) => c.requirement).length;
  return (
    <div className="space-y-6">
      {(v.statusNote || v.newer) && (
        <div className="space-y-1 rounded-md bg-stone-100 p-3 text-sm text-stone-800" data-status-note>
          {v.statusNote && <p>{v.statusNote}.</p>}
          {v.newer && v.status !== 'APPROVED' && (
            <p>
              v{v.newer.version} ({v.newer.status.toLowerCase().replace(/_/g, ' ')}) is newer: it differs in {v.newer.changedShots} shot{v.newer.changedShots === 1 ? '' : 's'}.{' '}
              <button type="button" onClick={() => onVersion(v.newer!.version)} className={link}>
                Open v{v.newer.version}
              </button>
            </p>
          )}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4" data-overview>
        <Stat label="Version" value={<span className="inline-flex flex-wrap items-center gap-1">v{v.version} <StoryboardStatusBadge status={v.status} /></span>} hint={`${STORYBOARD_SCOPE_LABELS[v.scope]} · blocks ${blockRange(v.scopeInfo.blockKeys)}${v.scopeInfo.outOfScopeBlocks ? ` · ${v.scopeInfo.outOfScopeBlocks} blocks out of scope (no audio yet)` : ''}`} />
        <Stat label="Runtime" value={v.runtimeMs !== null ? clock(v.runtimeMs) : '—'} hint="the narration's real audio" />
        <Stat label="Shots" value={String(v.shotCount)} hint={`average ${secondsText(v.rhythm.averageShotMs)}`} />
        <Stat label="Beats" value={String(v.beatCount)} />
        <Stat label="Estimated visual cost" value={<span data-overview-cost>{rollupText(v.costs)}</span>} hint={`${v.costs.basis ? VISUAL_COST_BASIS_LABELS[v.costs.basis] : '—'} · a forecast, never spend · actual cost: none yet, no assets`} />
        <Stat label="QA" value={`${live.blocking} blocking · ${live.warnings} to check`} hint={live.blocking ? 'Blocking findings stop approval' : 'Nothing blocks approval'} />
        <Stat
          label="Approval"
          value={
            <span className="inline-flex flex-wrap items-center gap-1">
              <StoryboardStatusBadge status={v.status} />
              {stale.map((f) => (
                <ToneChip key={`${f.kind}:${f.ref ?? ''}`} tone={f.severity === 'BLOCKING' ? 'DANGER' : 'WARNING'} title={f.detail}>
                  {STORYBOARD_FINDING_LABELS[f.kind]}
                </ToneChip>
              ))}
            </span>
          }
          hint={decidedText(v) ? `${decidedText(v)}${v.decidedAt ? ` · ${formatDate(v.decidedAt)}` : ''}` : 'never approved automatically'}
        />
        <Stat label="Evidence" value={`${v.evidenceCoverage.traced}/${v.evidenceCoverage.factualShots} factual shots traced`} hint={v.evidenceCoverage.untraced.length ? `untraced: ${v.evidenceCoverage.untraced.join(', ')}` : 'every factual shot traceable to a source'} />
        <Stat label="Narration" value={<NarrationApprovalBadge approval={v.narration.approval} />} hint={`run ${v.narration.runNumber}, assembly v${v.narration.assemblyVersion} · takes ${takes.approved}/${takes.total} approved`} />
        <Stat label="Approach" value={`${v.approach} — ${VISUAL_APPROACH_LABELS[v.approach]}`} />
        <Stat label="Continuity" value={`${v.continuity.length} subject${v.continuity.length === 1 ? '' : 's'}`} hint={needingReference ? `${needingReference} need a reference asset` : undefined} />
        <Stat label="Planned with" value={`${v.inputs.profile.familyName} v${v.inputs.profile.version}`} hint={`engine v1 · created ${formatDate(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}`} />
      </dl>

      <section className="space-y-2" data-treatment-mix>
        <h3 className="text-sm font-medium text-stone-800">Treatments by runtime</h3>
        <div className="flex h-4 w-full overflow-hidden rounded-sm border border-stone-200" aria-hidden="true">
          {mix.map((m) => (
            <div key={m.treatment ?? 'none'} className={`h-full border-r ${m.treatment ? TONE_BAR[VISUAL_TREATMENT_TONES[m.treatment]] : 'border-red-500 bg-red-200'}`} style={{ width: `${m.share * 100}%` }} title={`${m.treatment ? VISUAL_TREATMENT_LABELS[m.treatment] : 'Not planned'} ${percent(m.share)}`} />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-700">
          {mix.map((m) => (
            <li key={m.treatment ?? 'none'} className="inline-flex items-center gap-1">
              <span className={`inline-block h-3 w-3 rounded-sm border ${m.treatment ? TONE_BAR[VISUAL_TREATMENT_TONES[m.treatment]] : 'border-red-500 bg-red-200'}`} />
              {m.treatment ? VISUAL_TREATMENT_LABELS[m.treatment] : 'Not planned'} {percent(m.share)} ({secondsText(m.ms)})
            </li>
          ))}
        </ul>
      </section>

      <Approaches version={v} allowed={approach} />

      <Versions version={v} versions={versions} onVersion={onVersion} />
    </div>
  );
}

/** The three approaches costed and measured on this version's beats; another one is a paid re-plan of the beats whose treatment changes. */
function Approaches({ version: v, allowed }: { version: StoryboardVersionView; allowed: EditorialAction }) {
  return (
    <section className="space-y-2" data-approaches>
      <h3 className="text-sm font-medium text-stone-800">Approaches A, B and C</h3>
      <p className="text-xs text-stone-500">Each beat has an option in every approach; this version plans {v.approach} in full and costs the others from the same beats. Switching re-plans only the beats whose treatment changes (a paid planning job); this version is kept.</p>
      <div className="grid gap-2 lg:grid-cols-3">
        {v.approaches.map((a) => (
          <ApproachCard key={a.approach} approach={a} version={v} allowed={allowed} />
        ))}
      </div>
      <Why action={allowed} />
    </section>
  );
}

function ApproachCard({ approach: a, version: v, allowed }: { approach: ApproachSummaryView; version: StoryboardVersionView; allowed: EditorialAction }) {
  const [open, setOpen] = useState(false);
  // The tick belongs to this approach from this version: another version shown asks again.
  const key = `${v.id}:${a.approach}`;
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const send = useStoryboardRequest(() => api.switchApproach(v.id, { approach: a.approach, expectedVersion: v.version, confirm: true }), () => {
    setOpen(false);
    setConfirmed(null);
  });
  return (
    <article className={`min-w-0 rounded-md border p-2 text-xs ${a.chosen ? 'border-stone-900' : 'border-stone-200'}`} data-approach={a.approach}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-stone-900">
          {a.approach} — {a.label}
        </span>
        {a.chosen && <span className={`${pill} bg-stone-900 text-white`}>planned</span>}
      </p>
      <p className="mt-1 text-stone-500">{VISUAL_APPROACH_HELP[a.approach]}</p>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Stat label="Forecast" value={rollupText({ totalUsd: a.estimatedCostUsd, basis: a.costBasis, unpricedShots: a.unpricedShots })} />
        <Stat label="Generated video" value={percent(a.generatedVideoShare)} />
        <Stat label="About" value={`${a.estimatedShots} shots`} />
        <Stat label="Beats on evidence" value={percent(a.evidenceShare)} />
      </dl>
      <p className="mt-1 break-words text-stone-600">
        {mixShares(a.treatmentMix)
          .slice(0, 4)
          .map((m) => `${VISUAL_TREATMENT_LABELS[m.treatment]} ${percent(m.share)}`)
          .join(' · ')}
      </p>
      {a.replacedOptions > 0 && <p className="mt-1 text-amber-900">{a.replacedOptions} option(s) outside what the evidence allows were replaced by the beat's own treatment.</p>}
      {!a.chosen && allowed.allowed && (
        <div className="mt-2 space-y-1">
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className={secondary}>
              Switch to {a.approach}…
            </button>
          ) : (
            <>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={confirmed === key} onChange={(e) => setConfirmed(e.target.checked ? key : null)} />
                <span>I confirm a paid planning job: model calls only, within the planning ceiling, for the beats whose treatment changes. Nothing is generated; v{v.version} is kept.</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={confirmed !== key || send.isPending} onClick={() => send.mutate(undefined)} className={primary}>
                  Plan approach {a.approach}
                </button>
                <button type="button" onClick={() => setOpen(false)} className={secondary}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {send.error && <p className="break-words text-red-700">{send.error.message}</p>}
          {send.isSuccess && <p className="text-sky-800">Queued: the page updates when the new version is saved.</p>}
        </div>
      )}
    </article>
  );
}

/** Every version, newest first: how it came about, its forecast, QA and decision; the one shown with what it changed and every decision on it. */
function Versions({ version: v, versions, onVersion }: { version: StoryboardVersionView; versions: readonly StoryboardSummaryView[]; onVersion: (version: number) => void }) {
  return (
    <section className="space-y-2" data-versions>
      <h3 className="text-sm font-medium text-stone-800">Versions</h3>
      <p className="text-xs text-stone-500">Every version is kept as it was saved: an edit, a re-plan, a re-timing or a restore makes a new one. Approval is for one version; a newer version is reviewed on its own.</p>
      <ol className="space-y-2">
        {versions.map((x) => (
          <li key={x.id} className={`min-w-0 rounded-md border p-2 text-xs ${x.version === v.version ? 'border-stone-900 bg-white' : 'border-stone-200'}`} data-version-row={x.version}>
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-stone-900">{versionLabel(x)}</span>
              <StoryboardStatusBadge status={x.status} />
              {x.version !== v.version && (
                <button type="button" onClick={() => onVersion(x.version)} className={link}>
                  Open v{x.version}
                </button>
              )}
            </p>
            <p className="mt-0.5 break-words text-stone-600">
              {formatDate(x.createdAt)}
              {x.createdBy ? ` by ${x.createdBy}` : ''} · {x.shotCount} shots, {x.beatCount} beats · {rollupText({ totalUsd: x.estimatedCostUsd, basis: x.costBasis, unpricedShots: x.unpricedShotCount })} · QA as saved {x.blocking} blocking, {x.warnings} to check
              {decidedText(x) ? ` · ${decidedText(x)}` : ''}
            </p>
            {x.version === v.version && (
              <div className="mt-1 space-y-1">
                {v.baseVersion && v.changes && (
                  <ul className="list-disc pl-5 text-stone-700" data-changes>
                    {changesLines(v.changes).map((l) => (
                      <li key={l} className="break-words">
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
                {v.decisions.length > 0 && (
                  <ul className="space-y-0.5 text-stone-700" data-version-decisions>
                    {v.decisions.map((d) => (
                      <li key={d.id} className="break-words">
                        {decisionText(d)} · {formatDate(d.createdAt)}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-stone-500">Actual cost: none yet, no assets (nothing is generated in this milestone).</p>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
