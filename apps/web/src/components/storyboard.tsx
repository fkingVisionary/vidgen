import {
  DEPICTION_LABELS,
  DEPICTION_TONES,
  NARRATION_APPROVAL_LABELS,
  NARRATION_APPROVAL_TONES,
  SHOT_REVIEW_STATE_LABELS,
  SHOT_REVIEW_STATE_TONES,
  STORYBOARD_FINDING_LABELS,
  STORYBOARD_STATUS_LABELS,
  STORYBOARD_STATUS_TONES,
  VISUAL_TREATMENT_HELP,
  VISUAL_TREATMENT_LABELS,
  VISUAL_TREATMENT_TONES,
  type Depiction,
  type EditorialAction,
  type LabelTone,
  type NarrationApproval,
  type ShotReviewState,
  type ShotView,
  type StoryboardEditOp,
  type StoryboardQaFinding,
  type StoryboardStatus,
  type StoryboardView,
  type VisualTreatment,
} from '@docengine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { TONE_PILL, whyChain } from '../storyboard-plan.ts';
import { pill, primary, secondary, summary, tag } from './ui.ts';

/**
 * The Storyboard page's shared pieces: badges in core's tones, findings,
 * the "why is this visual here?" chain, and the request hooks — every
 * change is a request that makes a new version or a new decision, never a
 * change of one already saved; a version saved elsewhere in the meantime
 * is a 409 that keeps what the editor wrote.
 */

/** Read the storyboard views, the project and the visual profiles again after a change. */
export function useStoryboardRequest<T, R = unknown>(fn: (arg: T) => Promise<R>, onDone?: (result: R) => void) {
  const queryClient = useQueryClient();
  return useMutation<R, Error, T>({
    mutationFn: fn,
    onSuccess: (result) => {
      for (const key of ['storyboard', 'storyboard-inputs', 'project', 'projects', 'visual-selection', 'visual-profiles', 'visual-profile']) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone?.(result);
    },
  });
}

/** The newest version when a request was refused because another version was saved since (409 with `latestVersion`), else null. */
export function versionRace(e: Error | null): number | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const latest = (e.body as { latestVersion?: unknown } | null)?.latestVersion;
  return typeof latest === 'number' ? latest : null;
}

/** What an edit needs: the version edited, the newest version the editor saw, whether edits are allowed, where to go once saved, and how to read the page again. */
export interface EditContext {
  storyboardId: string;
  /** The version edited (it is never changed: an edit saves a new one). */
  version: number;
  /** The newest version on the page when it was read (an edit is refused if another was saved since). */
  newest: number;
  allowed: EditorialAction;
  onSaved: (view: StoryboardView) => void;
  /** Reads the page again, dropping what the forms hold. */
  onReload: () => void;
}

/**
 * Edits of a version as one request: a new version, no model call. When
 * another version was saved since, the form stays as it is, and the editor
 * may save it as the next version anyway or reload.
 */
export function useEdits(ctx: EditContext, onDone?: () => void) {
  const [race, setRace] = useState<number | null>(null);
  const send = useStoryboardRequest(
    (a: { ops: StoryboardEditOp[]; note?: string; expectedVersion: number }) => api.editStoryboard(ctx.storyboardId, { expectedVersion: a.expectedVersion, ops: a.ops, ...(a.note?.trim() ? { note: a.note.trim() } : {}) }),
    (view) => {
      setRace(null);
      onDone?.();
      ctx.onSaved(view);
    },
  );
  const [last, setLast] = useState<{ ops: StoryboardEditOp[]; note?: string } | null>(null);
  const submit = (ops: StoryboardEditOp[], note?: string) => {
    setLast({ ops, note });
    send.mutate({ ops, note, expectedVersion: ctx.newest }, { onError: (e) => setRace(versionRace(e)) });
  };
  const saveAnyway = () => {
    if (last && race !== null) send.mutate({ ...last, expectedVersion: race }, { onError: (e) => setRace(versionRace(e)) });
  };
  return { submit, saveAnyway, race, pending: send.isPending, error: race === null ? send.error : null };
}

/** A refusal because another version was saved since: save as the next one anyway, or reload (which drops the form). */
export function RaceNotice({ race, pending, onSaveAnyway, onReload, what = 'your changes' }: { race: number; pending: boolean; onSaveAnyway: () => void; onReload: () => void; what?: string }) {
  return (
    <div className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900" data-race>
      <p>
        v{race} was saved since this page was read. {what[0]!.toUpperCase() + what.slice(1)} are still here: saving them makes v{race + 1} from the version you edited, over what v{race} changed.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={onSaveAnyway} className={`${primary} bg-amber-700 hover:bg-amber-800`}>
          Save as v{race + 1} anyway
        </button>
        <button type="button" onClick={onReload} className={secondary}>
          Reload
        </button>
      </div>
    </div>
  );
}

// ── Badges ───────────────────────────────────────────────────────────────────

export function ToneChip({ tone, children, title }: { tone: LabelTone; children: ReactNode; title?: string }) {
  return (
    <span className={`${pill} ${TONE_PILL[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function StoryboardStatusBadge({ status }: { status: StoryboardStatus }) {
  return (
    <span className={`${pill} ${TONE_PILL[STORYBOARD_STATUS_TONES[status]]}`} data-storyboard-status={status}>
      {STORYBOARD_STATUS_LABELS[status]}
    </span>
  );
}

export function TreatmentBadge({ treatment }: { treatment: VisualTreatment | null }) {
  if (!treatment) return <span className={`${pill} bg-red-100 text-red-800`}>Not planned</span>;
  return (
    <span className={`${tag} ${TONE_PILL[VISUAL_TREATMENT_TONES[treatment]]}`} title={VISUAL_TREATMENT_HELP[treatment]} data-treatment={treatment}>
      {VISUAL_TREATMENT_LABELS[treatment]}
    </span>
  );
}

export function DepictionBadge({ depiction }: { depiction: Depiction }) {
  return <ToneChip tone={DEPICTION_TONES[depiction]}>{DEPICTION_LABELS[depiction]}</ToneChip>;
}

export function ReviewBadge({ review, carried }: { review: ShotReviewState; carried?: number | null }) {
  return (
    <ToneChip tone={SHOT_REVIEW_STATE_TONES[review]}>
      {SHOT_REVIEW_STATE_LABELS[review]}
      {carried ? ` (carried from v${carried})` : ''}
    </ToneChip>
  );
}

export function NarrationApprovalBadge({ approval }: { approval: NarrationApproval }) {
  return <ToneChip tone={NARRATION_APPROVAL_TONES[approval]}>{NARRATION_APPROVAL_LABELS[approval]}</ToneChip>;
}

// ── Findings ─────────────────────────────────────────────────────────────────

/** QA findings: blocking ones stop approval, warnings are for a person to check; each with what it is about. */
export function StoryboardFindings({ findings, empty = 'Nothing flagged.' }: { findings: readonly StoryboardQaFinding[]; empty?: string }) {
  if (!findings.length) return <p className="text-xs text-emerald-700">{empty}</p>;
  return (
    <ul className="space-y-1 text-xs" data-findings>
      {findings.map((f, i) => (
        <li key={i} className={`break-words ${f.severity === 'BLOCKING' ? 'text-red-800' : 'text-amber-900'}`} data-finding={f.kind}>
          <span className="font-semibold">{f.severity === 'BLOCKING' ? 'Blocks approval' : 'Check'}</span>
          {f.ref ? ` · ${f.ref}` : ''} · {STORYBOARD_FINDING_LABELS[f.kind]} — {f.detail}
        </li>
      ))}
    </ul>
  );
}

// ── Why is this visual here? ─────────────────────────────────────────────────

/** Shot → visual beat → narration → script block → architecture → claims → sources, folded under the shot. */
export function WhyChain({ shot }: { shot: Pick<ShotView, 'key' | 'why'> }) {
  const steps = whyChain(shot);
  return (
    <details className="mt-2" data-why={shot.key}>
      <summary className={summary}>Why is this visual here?</summary>
      <ol className="mt-1 space-y-1 border-l-2 border-stone-200 pl-3 text-xs">
        {steps.map((s, i) => (
          <li key={i} className="min-w-0" data-why-step={s.level}>
            <span className="font-semibold text-stone-500">{s.level}</span> <span className="break-words text-stone-900">{s.label}</span>
            {s.detail && <span className="block break-words text-stone-600">{s.detail}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** A label and a value in a stats grid. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="break-words text-stone-900">{value}</dd>
      {hint && <dd className="text-xs break-words text-stone-500">{hint}</dd>}
    </div>
  );
}

/** "Allowed, or why not" beside a control. */
export function Why({ action }: { action: EditorialAction }) {
  return action.allowed || !action.reason ? null : <p className="text-xs text-stone-500">{action.reason}</p>;
}
