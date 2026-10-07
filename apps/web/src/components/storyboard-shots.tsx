import {
  ASSET_SOURCING_LABELS,
  BEAT_IMPORTANCES,
  BEAT_IMPORTANCE_LABELS,
  CAMERA_MOTIONS,
  CAST_KIND_LABELS,
  CUT_POINT_KIND_LABELS,
  CUT_REASON_LABELS,
  CUT_OFFSET_MAX_MS,
  DETAIL_BASES,
  DETAIL_BASIS_LABELS,
  DETAIL_BASIS_TONES,
  EVIDENCE_RELATION_LABELS,
  GENERATION_COMPLEXITY_LABELS,
  LICENSING_STATUS_LABELS,
  LIKENESS_MODES,
  LIKENESS_MODE_LABELS,
  MOTION_INTENSITY_LABELS,
  OVERLAY_KINDS,
  OVERLAY_KIND_LABELS,
  PRODUCTION_METHOD_LABELS,
  REUSE_CATEGORY_LABELS,
  SCRIPT_BLOCK_CLASS_LABELS,
  SHOT_CLAIM_ROLES,
  SHOT_CLAIM_ROLE_LABELS,
  SHOT_TRANSITIONS,
  SHOT_TRANSITION_LABELS,
  SHOT_TYPES,
  SPECIFIC_KINDS,
  SPECIFIC_KIND_LABELS,
  STORYBOARD_LIMITS,
  SUBJECT_INTERACTIONS,
  SUBJECT_INTERACTION_LABELS,
  SUBJECT_ROLES,
  SUBJECT_ROLE_LABELS,
  TIMING_RELATION_HELP,
  TREATMENT_METHODS,
  UNCERTAINTY_DEVICES,
  UNCERTAINTY_DEVICE_HELP,
  UNCERTAINTY_DEVICE_LABELS,
  VISUAL_ASSET_TYPE_LABELS,
  VISUAL_TREATMENTS,
  VISUAL_TREATMENT_LABELS,
  type BeatImportance,
  type DetailBasis,
  type EditorialAction,
  type ShotView,
  type StoryboardVersionView,
  type VisualBeatView,
  type VisualTreatment,
} from '@docengine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { cutPointsBetween, decisionText, lowerClasses, moved, nextInBeat, nextShot, rangeText, recommendationText, relationText, secondsText, shotCostText, shotForm, shotFormProblems, shotPatch, estimateUsd, type ShotForm, type SubjectRow } from '../storyboard-plan.ts';
import { ClassBadge } from './script.tsx';
import { DepictionBadge, RaceNotice, ReviewBadge, StoryboardFindings, ToneChip, TreatmentBadge, WhyChain, useEdits, useStoryboardRequest, type EditContext } from './storyboard.tsx';
import { approve, danger, input, link, pill, primary, secondary, summary } from './ui.ts';

/**
 * The Shots tab: the version's visual beats in time order, each with its
 * shots as cards — when each is seen against its words, what it shows and
 * how, what it rests on, the asset it needs and its forecast — and a
 * person's controls: a decision on each shot (a new row; the content is
 * unchanged), and edits — change a shot, split it, merge it with the next,
 * move the cut after it, reorder a beat's shots, change a beat or the
 * recommended provider — each saved as a new version, the old one kept.
 */

const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function ShotsTab({ version: v, ctx, decideShots, replan, focus }: { version: StoryboardVersionView; ctx: EditContext; decideShots: EditorialAction; replan: EditorialAction; focus: string | null }) {
  const beats = [...v.beats].sort((a, b) => a.startMs - b.startMs || a.sortOrder - b.sortOrder);
  return (
    <div className="space-y-6">
      {!ctx.allowed.allowed && ctx.allowed.reason && <p className="rounded-md bg-stone-100 p-2 text-xs text-stone-700">Editing: {ctx.allowed.reason}</p>}
      {!decideShots.allowed && decideShots.reason && <p className="rounded-md bg-stone-100 p-2 text-xs text-stone-700">Shot decisions: {decideShots.reason}</p>}
      {beats.map((b) => (
        <section key={b.id} className="space-y-3" data-beat={b.key}>
          <BeatHeader beat={b} version={v} ctx={ctx} replan={replan} />
          {v.shots
            .filter((s) => s.beatKey === b.key)
            .sort((a, z) => a.startMs - z.startMs)
            .map((s) => (
              <ShotCard key={`${v.version}:${s.key}`} shot={s} beat={b} version={v} ctx={ctx} decideShots={decideShots} open={focus === s.key} />
            ))}
        </section>
      ))}
    </div>
  );
}

// ── Beats ────────────────────────────────────────────────────────────────────

function BeatHeader({ beat: b, version: v, ctx, replan }: { beat: VisualBeatView; version: StoryboardVersionView; ctx: EditContext; replan: EditorialAction }) {
  const [editing, setEditing] = useState(false);
  const c = b.content;
  return (
    <header className="rounded-lg border border-stone-300 bg-stone-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-stone-900">{b.key}</span>
        <span className="font-medium break-words text-stone-900">{c.title}</span>
        <span className="font-mono text-xs tabular-nums text-stone-500">
          {rangeText(b.startMs, b.endMs)} · {secondsText(b.durationMs)}
        </span>
        <TreatmentBadge treatment={b.treatment} />
        <ClassBadge cls={b.infoClass} />
        <span className={`${pill} bg-white text-stone-700 ring-1 ring-stone-200`}>{BEAT_IMPORTANCE_LABELS[c.importance]}</span>
        <span className="text-xs text-stone-500">approach {c.approach} · {GENERATION_COMPLEXITY_LABELS[c.complexity].toLowerCase()} to make</span>
      </div>
      <p className="mt-1 text-sm break-words text-stone-700">{c.concept}</p>
      <p className="mt-1 text-xs break-words text-stone-600">
        Purpose: {c.purpose || '—'} · narrative: {c.narrativePurpose || '—'} · evidence: {EVIDENCE_RELATION_LABELS[c.evidenceRelationship].toLowerCase()}
        {b.archBeatIds.length ? ` · architecture beats ${b.archBeatIds.join(', ')}` : ''}
        {b.blocks.length ? ` · blocks ${b.blocks.map((x) => x.blockKey).join(', ')}` : ''}
      </p>
      {c.informationCommunicated.length > 0 && <p className="mt-1 text-xs break-words text-stone-600">Tells the viewer: {c.informationCommunicated.join('; ')}</p>}
      {c.continuity.notes.length > 0 && <p className="mt-1 text-xs break-words text-stone-600">Continuity: {c.continuity.notes.join('; ')}</p>}
      <details className="mt-1">
        <summary className={summary}>Approaches A, B and C for this beat</summary>
        <ul className="mt-1 space-y-0.5 text-xs text-stone-700">
          {(['A', 'B', 'C'] as const).map((a) => (
            <li key={a} className="break-words">
              <span className="font-semibold">{a}</span> {VISUAL_TREATMENT_LABELS[c.options[a].treatment]}: {c.options[a].concept}
              {a === c.approach ? ' (planned)' : ''}
            </li>
          ))}
        </ul>
      </details>
      <div className="mt-1 flex flex-wrap gap-x-3">
        <button type="button" disabled={!ctx.allowed.allowed} title={ctx.allowed.reason ?? undefined} onClick={() => setEditing((x) => !x)} aria-expanded={editing} className={link}>
          {editing ? 'Close the beat form' : `Edit ${b.key}`}
        </button>
      </div>
      {editing && <BeatForm beat={b} ctx={ctx} onClose={() => setEditing(false)} />}
      {replan.allowed && <ReplanBeats version={v} preset={[b.key]} compact />}
    </header>
  );
}

function BeatForm({ beat: b, ctx, onClose }: { beat: VisualBeatView; ctx: EditContext; onClose: () => void }) {
  const c = b.content;
  const [title, setTitle] = useState(c.title);
  const [purpose, setPurpose] = useState(c.purpose);
  const [concept, setConcept] = useState(c.concept);
  const [importance, setImportance] = useState<BeatImportance>(c.importance);
  const [notes, setNotes] = useState(c.continuity.notes.join('\n'));
  const [note, setNote] = useState('');
  const edits = useEdits(ctx, onClose);
  const lines = notes
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const patch = {
    ...(title.trim() !== c.title ? { title: title.trim() } : {}),
    ...(purpose.trim() !== c.purpose ? { purpose: purpose.trim() } : {}),
    ...(concept.trim() !== c.concept ? { concept: concept.trim() } : {}),
    ...(importance !== c.importance ? { importance } : {}),
    ...(JSON.stringify(lines) !== JSON.stringify(c.continuity.notes) ? { continuityNotes: lines } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-stone-200 bg-white p-2 text-sm"
      data-beat-form={b.key}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && title.trim()) edits.submit([{ op: 'updateBeat', beatKey: b.key, patch }], note);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={STORYBOARD_LIMITS.title} className={input} />
        </Field>
        <Field label="Importance">
          <select value={importance} onChange={(e) => setImportance(e.target.value as BeatImportance)} className={input}>
            {BEAT_IMPORTANCES.map((x) => (
              <option key={x} value={x}>
                {BEAT_IMPORTANCE_LABELS[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Purpose" wide>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Concept" wide>
          <textarea value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={STORYBOARD_LIMITS.description} rows={2} className={input} />
        </Field>
        <Field label="Continuity notes (one a line)" wide>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={input} />
        </Field>
        <Field label="Note on this edit (optional)" wide>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={input} />
        </Field>
      </div>
      <SaveRow edits={edits} disabled={!changed || !title.trim()} label="Save as a new version" onReload={ctx.onReload} />
    </form>
  );
}

/** Re-plan chosen beats with instructions: a paid planning job (its other beats and shots are copied). */
export function ReplanBeats({ version: v, preset = [], compact = false }: { version: StoryboardVersionView; preset?: string[]; compact?: boolean }) {
  const [keys, setKeys] = useState<string[]>(preset);
  const [instructions, setInstructions] = useState('');
  const [confirmed, setConfirmed] = useState<string | null>(null);
  // The tick belongs to these beats of this version, with these instructions.
  const request = JSON.stringify({ id: v.id, keys, instructions });
  const send = useStoryboardRequest(
    () => api.regenerateBeats(v.id, { beatKeys: keys, ...(instructions.trim() ? { instructions: instructions.trim() } : {}), expectedVersion: v.version, confirm: true }),
    () => {
      setConfirmed(null);
      setInstructions('');
    },
  );
  const body = (
    <div className="mt-2 space-y-2 text-sm" data-replan>
      {!compact && (
        <fieldset className="min-w-0">
          <legend className="text-xs text-stone-500">Beats to re-plan (their ranges stay; everything else is copied unchanged)</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {v.beats.map((b) => (
              <label key={b.key} className="flex min-h-6 items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={keys.includes(b.key)} onChange={(e) => setKeys((k) => (e.target.checked ? [...k, b.key] : k.filter((x) => x !== b.key)))} />
                <span className="min-w-0 break-words">
                  {b.key} {b.content.title} ({rangeText(b.startMs, b.endMs)})
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="block text-xs text-stone-600">
        Instructions for the planner (optional)
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={STORYBOARD_LIMITS.instructions} rows={2} placeholder="e.g. show the ledger rather than the crowd" className={input} />
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={confirmed === request} onChange={(e) => setConfirmed(e.target.checked ? request : null)} />
        <span>I confirm a paid planning job for {keys.length ? keys.join(', ') : 'the beats chosen'}: model calls only, within the planning ceiling. Nothing is generated; a new version is saved and this one is kept.</span>
      </label>
      <button type="button" disabled={!keys.length || confirmed !== request || send.isPending} onClick={() => send.mutate(undefined)} className={primary}>
        Re-plan {keys.length === 1 ? keys[0] : `${keys.length} beats`}
      </button>
      {send.error && <p className="text-xs text-red-700">{send.error.message}</p>}
      {send.isSuccess && <p className="text-xs text-sky-800">Queued: the page updates when the new version is saved.</p>}
    </div>
  );
  return compact ? (
    <details className="mt-1">
      <summary className={summary}>Re-plan {preset.join(', ')}…</summary>
      {body}
    </details>
  ) : (
    body
  );
}

// ── Shots ────────────────────────────────────────────────────────────────────

type Panel = 'edit' | 'split' | 'cut' | 'provider' | null;

function ShotCard({ shot: s, beat, version: v, ctx, decideShots, open }: { shot: ShotView; beat: VisualBeatView; version: StoryboardVersionView; ctx: EditContext; decideShots: EditorialAction; open: boolean }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const decide = useStoryboardRequest((decision: 'APPROVED' | 'REJECTED' | 'CLEARED') => api.decideShot(s.id, { decision, ...(decisionNote.trim() ? { note: decisionNote.trim() } : {}) }), () => setDecisionNote(''));
  const edits = useEdits(ctx, () => setPanel(null));
  const spec = s.spec;
  const merge = nextInBeat(v.shots, s.key);
  const after = nextShot(v.shots, s.key);
  const order = v.shots.filter((x) => x.beatKey === s.beatKey).sort((a, z) => a.startMs - z.startMs).map((x) => x.key);
  const up = moved(order, s.key, -1);
  const down = moved(order, s.key, 1);
  const toggle = (p: Panel) => setPanel((x) => (x === p ? null : p));
  const asset = s.assetRequirement;
  const editable = ctx.allowed.allowed;
  const ref = useRef<HTMLElement>(null);
  // Opened from the timeline: brought into view.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'start' });
  }, [open]);
  return (
    <article ref={ref} id={`shot-${s.key}`} className={`min-w-0 rounded-lg border bg-white p-3 ${open ? 'border-stone-900 ring-2 ring-stone-900/20' : 'border-stone-200'}`} data-shot={s.key}>
      <header className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <span className="text-sm font-semibold text-stone-900">{s.key}</span>
        <span className="font-mono tabular-nums">
          {rangeText(s.startMs, s.endMs)} · {secondsText(s.durationMs)}
        </span>
        <span title={TIMING_RELATION_HELP[s.relation]}>{relationText(s)}</span>
        <TreatmentBadge treatment={s.treatment} />
        {s.method && <span className="break-words">{PRODUCTION_METHOD_LABELS[s.method]}</span>}
        {s.infoClass && <ClassBadge cls={s.infoClass} />}
        <DepictionBadge depiction={spec.depiction} />
        <ReviewBadge review={s.review} carried={s.decision?.carriedFromVersion} />
      </header>
      {s.unplanned && <p className="mt-1 rounded-md bg-red-50 p-2 text-xs text-red-800">A placeholder: the planner's answer for this beat could not be made valid. Edit it, or re-plan the beat.</p>}
      {s.narration.text && (
        <p className="mt-2 text-sm break-words text-stone-800" data-shot-narration>
          “{s.narration.text}” <span className="text-xs text-stone-500">({s.narrationAnchor ?? 'silence'})</span>
        </p>
      )}
      <p className="mt-2 text-sm break-words text-stone-900">{spec.description || '—'}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Row label="Purpose">{spec.purpose || '—'}</Row>
        <Row label="Composition">
          {spec.composition || '—'}
          {spec.shotType ? ` (${words(spec.shotType)})` : ''}
        </Row>
        <Row label="Camera">
          {spec.camera.angle || '—'}
          {spec.camera.lens ? `, ${spec.camera.lens}` : ''}
        </Row>
        <Row label="Movement">
          {spec.movement.motion ? words(spec.movement.motion) : 'none'} · {MOTION_INTENSITY_LABELS[spec.movement.intensity].toLowerCase()}
          {spec.movement.note ? ` — ${spec.movement.note}` : ''}
        </Row>
        <Row label="Environment">
          {spec.environment.description || '—'}
          {spec.environment.subjectKey ? ` (${spec.environment.subjectKey})` : ''}
        </Row>
        <Row label="Lighting · mood">
          {spec.lighting || '—'} · {spec.mood || '—'}
        </Row>
        <Row label="Transitions">
          in {SHOT_TRANSITION_LABELS[spec.transitionIn].toLowerCase()}, out {SHOT_TRANSITION_LABELS[spec.transitionOut].toLowerCase()} · cut in at {CUT_REASON_LABELS[s.timing.cutIn]}, out at {CUT_REASON_LABELS[s.timing.cutOut]}
        </Row>
        <Row label="Uncertainty device">
          <span title={UNCERTAINTY_DEVICE_HELP[spec.uncertaintyDevice]}>{UNCERTAINTY_DEVICE_LABELS[spec.uncertaintyDevice]}</span>
        </Row>
      </dl>
      {s.subjects.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-stone-700" data-shot-subjects>
          {s.subjects.map((x) => (
            <li key={x.subjectKey} className="break-words">
              <span className="font-semibold">{x.name}</span> ({x.subjectKey}
              {x.castKind ? `, ${CAST_KIND_LABELS[x.castKind].toLowerCase()}` : ''}) · {SUBJECT_ROLE_LABELS[x.detail.role].toLowerCase()} · {x.detail.action || 'no action'} · {LIKENESS_MODE_LABELS[x.detail.likeness].toLowerCase()}
              {x.detail.interactions.length ? ` · ${x.detail.interactions.map((i) => `${SUBJECT_INTERACTION_LABELS[i.kind].toLowerCase()} ${i.withSubjectKey}`).join(', ')}` : ''}
              {x.detail.speaks ? ` · speaks (${words(x.detail.speaks.kind)})` : ''}
            </li>
          ))}
        </ul>
      )}
      <Lines label="Objects" items={spec.objects.map((o) => ({ text: o.name, basis: o.basis, keys: o.claimKeys }))} />
      <Lines label="Specific details" items={spec.specifics.map((o) => ({ text: `${SPECIFIC_KIND_LABELS[o.kind]}: ${o.detail}`, basis: o.basis, keys: o.claimKeys }))} />
      {spec.mustShow.length > 0 && <p className="mt-1 text-xs break-words text-stone-700">Must show: {spec.mustShow.map((m) => `${m.detail}${m.claimKeys.length ? ` [${m.claimKeys.join(', ')}]` : ''} (${m.origin.toLowerCase()})`).join('; ')}</p>}
      {spec.mustAvoid.length > 0 && <p className="mt-1 text-xs break-words text-stone-700">Must avoid: {spec.mustAvoid.map((m) => `${m.text} (${m.origin.toLowerCase()})`).join('; ')}</p>}
      {spec.overlays.length > 0 && (
        <p className="mt-1 text-xs break-words text-stone-700">
          Overlays: {spec.overlays.map((o) => `${OVERLAY_KIND_LABELS[o.kind]} “${o.text}”${o.auto ? ' (automatic, internal label)' : ''}`).join('; ')}
        </p>
      )}
      {spec.dataSpec && (
        <p className="mt-1 text-xs break-words text-stone-700">
          Data: {words(spec.dataSpec.chartType)} “{spec.dataSpec.title}” — {spec.dataSpec.items.map((i) => [i.label, i.figure, i.date, i.place].filter(Boolean).join(' ') + ` [${i.claimKey}]`).join('; ')}
        </p>
      )}
      {(spec.continuity.subjectKeys.length > 0 || spec.continuity.notes.length > 0) && <p className="mt-1 text-xs break-words text-stone-700">Continuity: {[...spec.continuity.subjectKeys, ...spec.continuity.notes].join('; ')}</p>}
      {spec.notes.length > 0 && <p className="mt-1 text-xs break-words text-stone-600">Notes: {spec.notes.join('; ')}</p>}
      {s.claims.length > 0 && (
        <p className="mt-1 text-xs break-words text-stone-700" data-shot-claims>
          Claims: {s.claims.map((c) => `${c.key} ${c.role ? SHOT_CLAIM_ROLE_LABELS[c.role].toLowerCase() : ''} (${c.verdict.toLowerCase()}${c.sourceIds.length ? `, ${c.sourceIds.length} traceable source${c.sourceIds.length === 1 ? '' : 's'}` : ', no traceable source'})`).join('; ')}
        </p>
      )}
      {asset && (
        <div className="mt-2 rounded-md bg-stone-50 p-2 text-xs text-stone-700" data-asset>
          <p className="break-words">
            Needs: {VISUAL_ASSET_TYPE_LABELS[asset.assetType]} · {ASSET_SOURCING_LABELS[asset.sourcing].toLowerCase()} ({PRODUCTION_METHOD_LABELS[asset.method].toLowerCase()}) · {asset.durationSec.toFixed(1)} s · {asset.aspectRatio} {asset.resolution} · {LICENSING_STATUS_LABELS[asset.licensing.status].toLowerCase()}
            {asset.reuseOf ? ` · reuses ${asset.reuseOf}'s asset` : ''}
          </p>
          {asset.references.map((r) => (
            <p key={r.subjectKey} className="font-medium text-amber-900">
              Requires {v.continuity.find((c) => c.key === r.subjectKey)?.name ?? r.subjectKey} continuity asset
            </p>
          ))}
          <p className="break-words text-stone-500">
            Reuse: {asset.reuse.reusable ? `reusable as ${REUSE_CATEGORY_LABELS[asset.reuse.category].toLowerCase()}` : 'not reusable'}
            {asset.reuse.era ? ` · ${asset.reuse.era}` : ''}
            {asset.reuse.location ? ` · ${asset.reuse.location}` : ''}
          </p>
        </div>
      )}
      <div className="mt-2 text-xs text-stone-700" data-shot-cost>
        <span className="font-medium">Forecast:</span> {shotCostText(s.cost)} · <span className="break-words">{recommendationText(s.cost, asset?.reuseOf ?? null)}</span>
        {s.cost && s.cost.lines.length > 0 && (
          <details className="mt-1">
            <summary className={summary}>How it is costed</summary>
            <ul className="mt-1 space-y-0.5 break-words text-stone-600">
              {s.cost.lines.map((l, i) => (
                <li key={i}>
                  {l.what}
                  {l.rate ? ` — ${l.rate.source} (checked ${l.rate.checkedAt}, ${l.rate.confidence.toLowerCase().replace('_', ' ')})` : ' — no price'}
                </li>
              ))}
              <li>{s.cost.note}</li>
            </ul>
          </details>
        )}
      </div>
      {s.findings.length > 0 && (
        <div className="mt-2">
          <StoryboardFindings findings={s.findings} />
        </div>
      )}
      <WhyChain shot={s} />
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-2">
        {s.decision && <span className="text-xs break-words text-stone-600">{decisionText(s.decision)}</span>}
        {decideShots.allowed && (
          <>
            <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={1000} placeholder="Note (optional)" aria-label={`Note on ${s.key}`} className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1 text-xs sm:max-w-xs" />
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')} className={approve}>
              Approve {s.key}
            </button>
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={danger}>
              Reject
            </button>
            {s.decision && s.decision.decision !== 'CLEARED' && (
              <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('CLEARED')} className={secondary}>
                Clear
              </button>
            )}
          </>
        )}
      </div>
      {decide.error && <p className="mt-1 text-xs text-red-700">{decide.error.message}</p>}
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-shot-actions>
          <button type="button" onClick={() => toggle('edit')} aria-expanded={panel === 'edit'} className={secondary}>
            Edit
          </button>
          {s.timing.narration && (
            <button type="button" onClick={() => toggle('split')} aria-expanded={panel === 'split'} className={secondary}>
              Split…
            </button>
          )}
          {merge && (
            <button type="button" disabled={edits.pending} onClick={() => edits.submit([{ op: 'mergeShots', shotKeys: [s.key, merge.key] }])} className={secondary}>
              Merge with {merge.key}
            </button>
          )}
          {after && s.timing.narration && after.timing.narration && (
            <button type="button" onClick={() => toggle('cut')} aria-expanded={panel === 'cut'} className={secondary}>
              Move cut…
            </button>
          )}
          {s.cost && s.cost.candidates.length > 0 && (
            <button type="button" onClick={() => toggle('provider')} aria-expanded={panel === 'provider'} className={secondary}>
              Provider…
            </button>
          )}
          {up && (
            <button type="button" disabled={edits.pending} aria-label={`Move shot ${s.key} up`} onClick={() => edits.submit([{ op: 'reorderShots', beatKey: beat.key, order: up }])} className={secondary}>
              ▲
            </button>
          )}
          {down && (
            <button type="button" disabled={edits.pending} aria-label={`Move shot ${s.key} down`} onClick={() => edits.submit([{ op: 'reorderShots', beatKey: beat.key, order: down }])} className={secondary}>
              ▼
            </button>
          )}
        </div>
      )}
      {panel === null && <EditOutcome edits={edits} onReload={ctx.onReload} />}
      {panel === 'edit' && <ShotEditForm key={`${v.version}:${s.key}`} shot={s} ctx={ctx} onClose={() => setPanel(null)} />}
      {panel === 'split' && s.timing.narration && <SplitForm shot={s} version={v} edits={edits} onReload={ctx.onReload} />}
      {panel === 'cut' && after && <MoveCutForm left={s} right={after} version={v} edits={edits} onReload={ctx.onReload} />}
      {panel === 'provider' && s.cost && <ProviderForm shot={s} edits={edits} onReload={ctx.onReload} />}
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="inline text-stone-500">{label}: </dt>
      <dd className="inline break-words text-stone-800">{children}</dd>
    </div>
  );
}

function Lines({ label, items }: { label: string; items: { text: string; basis: keyof typeof DETAIL_BASIS_LABELS; keys: string[] }[] }) {
  if (!items.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-stone-700">
      <span>{label}:</span>
      {items.map((x, i) => (
        <span key={i} className="inline-flex max-w-full flex-wrap items-center gap-1">
          <span className="break-words">{x.text}</span>
          <ToneChip tone={DETAIL_BASIS_TONES[x.basis]}>{DETAIL_BASIS_LABELS[x.basis]}</ToneChip>
          {x.keys.length > 0 && <span className="text-stone-500">[{x.keys.join(', ')}]</span>}
        </span>
      ))}
    </p>
  );
}

type Edits = ReturnType<typeof useEdits>;

/** An edit's refusal (another version saved since: save anyway or reload; anything else: why). */
function EditOutcome({ edits, onReload }: { edits: Edits; onReload: () => void }) {
  if (edits.race !== null) return <div className="mt-2"><RaceNotice race={edits.race} pending={edits.pending} onSaveAnyway={edits.saveAnyway} onReload={onReload} /></div>;
  return edits.error ? <p className="mt-2 text-xs break-words text-red-700">{edits.error.message}</p> : null;
}

function SaveRow({ edits, disabled, label, onReload }: { edits: Edits; disabled: boolean; label: string; onReload: () => void }) {
  return (
    <div className="space-y-2">
      <button type="submit" disabled={disabled || edits.pending || edits.race !== null} className={primary}>
        {label}
      </button>
      <EditOutcome edits={edits} onReload={onReload} />
    </div>
  );
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block min-w-0 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

/**
 * A shot's edit form: what is seen and how, its treatment and method, a
 * lower class, overlays, must-avoid lines, claims, specific details and
 * objects with their bases, its subjects (role, action, likeness,
 * interactions, speech) and notes. Saving sends only what changed and
 * makes a new version (the class and the depiction are derived again;
 * this version is kept).
 */
function ShotEditForm({ shot: s, ctx, onClose }: { shot: ShotView; ctx: EditContext; onClose: () => void }) {
  const [f, setF] = useState<ShotForm>(() => shotForm(s));
  const [note, setNote] = useState('');
  const edits = useEdits(ctx, onClose);
  const set = <K extends keyof ShotForm>(k: K, v: ShotForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const patch = shotPatch(s, f);
  const problems = shotFormProblems(f);
  const setSubject = (key: string, detail: Partial<SubjectRow['detail']>) => set('subjects', f.subjects.map((x) => (x.subjectKey === key ? { ...x, detail: { ...x.detail, ...detail } } : x)));
  const methods = f.treatment ? TREATMENT_METHODS[f.treatment] : [];
  const lower = lowerClasses(s.infoClass);
  return (
    <form
      className="mt-2 space-y-3 rounded-md border border-stone-300 bg-stone-50 p-2 text-sm"
      data-shot-form={s.key}
      onSubmit={(e) => {
        e.preventDefault();
        if (patch) edits.submit([{ op: 'updateShot', shotKey: s.key, patch }], note);
      }}
    >
      <p className="text-xs text-stone-600">Saving makes a new version with this shot changed; v{ctx.version} is kept as it is. The class and depiction are derived again from what the shot shows.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Treatment">
          <select
            value={f.treatment ?? ''}
            onChange={(e) => {
              const t = e.target.value as VisualTreatment;
              setF((x) => ({ ...x, treatment: t, method: t === s.treatment ? s.method : null }));
            }}
            className={input}
          >
            {!f.treatment && <option value="">Choose a treatment</option>}
            {VISUAL_TREATMENTS.map((t) => (
              <option key={t} value={t}>
                {VISUAL_TREATMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Production method">
          <select value={f.method ?? ''} onChange={(e) => set('method', (e.target.value || null) as ShotForm['method'])} className={input}>
            <option value="">The usual one for the treatment</option>
            {methods.map((m) => (
              <option key={m} value={m}>
                {PRODUCTION_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        {lower.length > 0 && (
          <Field label="Information class (lower only)">
            <select value={f.infoClass ?? ''} onChange={(e) => set('infoClass', e.target.value as ShotForm['infoClass'])} className={input}>
              <option value={s.infoClass ?? ''}>{s.infoClass ? `${SCRIPT_BLOCK_CLASS_LABELS[s.infoClass]} (as it is)` : '—'}</option>
              {lower.map((c) => (
                <option key={c} value={c}>
                  {SCRIPT_BLOCK_CLASS_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Uncertainty device">
          <select value={f.uncertaintyDevice} onChange={(e) => set('uncertaintyDevice', e.target.value as ShotForm['uncertaintyDevice'])} className={input}>
            {UNCERTAINTY_DEVICES.map((d) => (
              <option key={d} value={d}>
                {UNCERTAINTY_DEVICE_LABELS[d]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-stone-500">{UNCERTAINTY_DEVICE_HELP[f.uncertaintyDevice]}</span>
        </Field>
        <Field label="Purpose" wide>
          <input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="What is seen" wide>
          <textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={STORYBOARD_LIMITS.description} rows={3} className={input} />
        </Field>
        <Field label="Composition">
          <input value={f.composition} onChange={(e) => set('composition', e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Shot size">
          <select value={f.shotType ?? ''} onChange={(e) => set('shotType', (e.target.value || null) as ShotForm['shotType'])} className={input}>
            <option value="">Not set</option>
            {SHOT_TYPES.map((t) => (
              <option key={t} value={t}>
                {words(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Camera angle">
          <input value={f.camera.angle} onChange={(e) => set('camera', { ...f.camera, angle: e.target.value })} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Lens (optional)">
          <input value={f.camera.lens ?? ''} onChange={(e) => set('camera', { ...f.camera, lens: e.target.value || null })} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Camera move">
          <select value={f.movement.motion ?? ''} onChange={(e) => set('movement', { ...f.movement, motion: (e.target.value || null) as ShotForm['movement']['motion'] })} className={input}>
            <option value="">None</option>
            {CAMERA_MOTIONS.map((m) => (
              <option key={m} value={m}>
                {words(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Motion intensity">
          <select value={f.movement.intensity} onChange={(e) => set('movement', { ...f.movement, intensity: e.target.value as ShotForm['movement']['intensity'] })} className={input}>
            {(['LOW', 'MEDIUM', 'HIGH'] as const).map((m) => (
              <option key={m} value={m}>
                {MOTION_INTENSITY_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Environment" wide>
          <input value={f.environment} onChange={(e) => set('environment', e.target.value)} maxLength={STORYBOARD_LIMITS.description} className={input} />
        </Field>
        <Field label="Lighting">
          <input value={f.lighting} onChange={(e) => set('lighting', e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Mood">
          <input value={f.mood} onChange={(e) => set('mood', e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </Field>
        <Field label="Transition in">
          <select value={f.transitionIn} onChange={(e) => set('transitionIn', e.target.value as ShotForm['transitionIn'])} className={input}>
            {SHOT_TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                {SHOT_TRANSITION_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Transition out">
          <select value={f.transitionOut} onChange={(e) => set('transitionOut', e.target.value as ShotForm['transitionOut'])} className={input}>
            {SHOT_TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                {SHOT_TRANSITION_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="min-w-0 space-y-1" data-overlays>
        <legend className="text-xs text-stone-500">Overlays (automatic labels are added by code)</legend>
        {f.overlays.map((o, i) => (
          <div key={i} className="grid gap-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,8rem)_auto]">
            <select value={o.kind} onChange={(e) => set('overlays', f.overlays.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof o.kind } : x)))} aria-label={`Overlay ${i + 1} kind`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
              {OVERLAY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {OVERLAY_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <input value={o.text} onChange={(e) => set('overlays', f.overlays.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="Text" aria-label={`Overlay ${i + 1} text`} maxLength={STORYBOARD_LIMITS.field} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
            <input value={o.reason} onChange={(e) => set('overlays', f.overlays.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} placeholder="Why" aria-label={`Overlay ${i + 1} reason`} maxLength={STORYBOARD_LIMITS.field} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
            <input
              value={o.claimKeys.join(', ')}
              onChange={(e) => set('overlays', f.overlays.map((x, j) => (j === i ? { ...x, claimKeys: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } : x)))}
              placeholder="Claims"
              aria-label={`Overlay ${i + 1} claims`}
              className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs"
            />
            <button type="button" onClick={() => set('overlays', f.overlays.filter((_, j) => j !== i))} className={link}>
              Remove
            </button>
          </div>
        ))}
        {f.overlays.length < STORYBOARD_LIMITS.overlays && (
          <button type="button" onClick={() => set('overlays', [...f.overlays, { kind: 'CAPTION', text: '', reason: '', claimKeys: [], auto: false }])} className={link}>
            Add an overlay
          </button>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-1" data-claims>
        <legend className="text-xs text-stone-500">Claims (keys of the approved evidence; checked when saved)</legend>
        {f.claims.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1">
            <input value={c.claimKey} onChange={(e) => set('claims', f.claims.map((x, j) => (j === i ? { ...x, claimKey: e.target.value } : x)))} aria-label={`Claim ${i + 1}`} className="w-28 min-w-0 rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
            <select value={c.role} onChange={(e) => set('claims', f.claims.map((x, j) => (j === i ? { ...x, role: e.target.value as typeof c.role } : x)))} aria-label={`Claim ${i + 1} role`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
              {SHOT_CLAIM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {SHOT_CLAIM_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => set('claims', f.claims.filter((_, j) => j !== i))} className={link}>
              Remove
            </button>
          </div>
        ))}
        {f.claims.length < STORYBOARD_LIMITS.claimsPerShot && (
          <button type="button" onClick={() => set('claims', [...f.claims, { claimKey: '', role: 'CONTEXT' }])} className={link}>
            Add a claim
          </button>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-1" data-specifics>
        <legend className="text-xs text-stone-500">Specific details (uniforms, documents, dates, places…), each with its basis: an invented one in a documented shot blocks approval</legend>
        {f.specifics.map((d, i) => (
          <div key={i} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,8rem)_minmax(0,10rem)_minmax(0,7rem)_auto]">
            <input value={d.detail} onChange={(e) => set('specifics', f.specifics.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))} maxLength={STORYBOARD_LIMITS.field} placeholder="Detail" aria-label={`Detail ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
            <select value={d.kind} onChange={(e) => set('specifics', f.specifics.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof d.kind } : x)))} aria-label={`Detail ${i + 1} kind`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
              {SPECIFIC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SPECIFIC_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <BasisSelect value={d.basis} label={`Detail ${i + 1} basis`} onChange={(basis) => set('specifics', f.specifics.map((x, j) => (j === i ? { ...x, basis } : x)))} />
            <input value={d.claimKeys} onChange={(e) => set('specifics', f.specifics.map((x, j) => (j === i ? { ...x, claimKeys: e.target.value } : x)))} placeholder="Claims" aria-label={`Detail ${i + 1} claims`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
            <button type="button" onClick={() => set('specifics', f.specifics.filter((_, j) => j !== i))} className={link}>
              Remove
            </button>
          </div>
        ))}
        {f.specifics.length < STORYBOARD_LIMITS.specifics && (
          <button type="button" onClick={() => set('specifics', [...f.specifics, { detail: '', kind: 'OBJECT', basis: 'PERIOD_GENERIC', claimKeys: '' }])} className={link}>
            Add a detail
          </button>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-1" data-objects>
        <legend className="text-xs text-stone-500">Objects in the frame, each with its basis</legend>
        {f.objects.map((o, i) => (
          <div key={i} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,7rem)_auto]">
            <input value={o.name} onChange={(e) => set('objects', f.objects.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={STORYBOARD_LIMITS.field} placeholder="Object" aria-label={`Object ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
            <BasisSelect value={o.basis} label={`Object ${i + 1} basis`} onChange={(basis) => set('objects', f.objects.map((x, j) => (j === i ? { ...x, basis } : x)))} />
            <input value={o.claimKeys} onChange={(e) => set('objects', f.objects.map((x, j) => (j === i ? { ...x, claimKeys: e.target.value } : x)))} placeholder="Claims" aria-label={`Object ${i + 1} claims`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
            <button type="button" onClick={() => set('objects', f.objects.filter((_, j) => j !== i))} className={link}>
              Remove
            </button>
          </div>
        ))}
        {f.objects.length < STORYBOARD_LIMITS.specifics && (
          <button type="button" onClick={() => set('objects', [...f.objects, { name: '', basis: 'PERIOD_GENERIC', claimKeys: '' }])} className={link}>
            Add an object
          </button>
        )}
      </fieldset>
      {s.subjects.length > 0 && (
        <fieldset className="min-w-0 space-y-2" data-subjects>
          <legend className="text-xs text-stone-500">Subjects in the shot: a real person appears only through a documented likeness, a silhouette or a period-generic figure; a fictional one only observes real people or stands near them</legend>
          {f.subjects.map((x) => {
            const subject = s.subjects.find((y) => y.subjectKey === x.subjectKey);
            return (
              <div key={x.subjectKey} className="min-w-0 space-y-1 rounded-md border border-stone-200 bg-white p-2" data-subject-row={x.subjectKey}>
                <p className="text-xs font-medium break-words text-stone-800">
                  {subject?.name ?? x.subjectKey} ({x.subjectKey}
                  {subject?.castKind ? `, ${CAST_KIND_LABELS[subject.castKind].toLowerCase()}` : ''})
                </p>
                <div className="grid gap-1 sm:grid-cols-3">
                  <select value={x.detail.role} onChange={(e) => setSubject(x.subjectKey, { role: e.target.value as SubjectRow['detail']['role'] })} aria-label={`${x.subjectKey} role`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
                    {SUBJECT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {SUBJECT_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <select value={x.detail.likeness} onChange={(e) => setSubject(x.subjectKey, { likeness: e.target.value as SubjectRow['detail']['likeness'] })} aria-label={`${x.subjectKey} likeness`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
                    {LIKENESS_MODES.map((m) => (
                      <option key={m} value={m}>
                        {LIKENESS_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  <input value={x.detail.action} onChange={(e) => setSubject(x.subjectKey, { action: e.target.value })} maxLength={STORYBOARD_LIMITS.field} placeholder="Action (none: still)" aria-label={`${x.subjectKey} action`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
                </div>
                {x.detail.interactions.map((it, j) => (
                  <label key={j} className="flex flex-wrap items-center gap-1 text-xs text-stone-700">
                    <span>With {it.withSubjectKey}:</span>
                    <select value={it.kind} onChange={(e) => setSubject(x.subjectKey, { interactions: x.detail.interactions.map((y, k) => (k === j ? { ...y, kind: e.target.value as typeof it.kind } : y)) })} aria-label={`${x.subjectKey} with ${it.withSubjectKey}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
                      {SUBJECT_INTERACTIONS.map((k) => (
                        <option key={k} value={k}>
                          {SUBJECT_INTERACTION_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {subject?.detail.speaks && (
                  <label className="flex min-h-6 items-center gap-2 text-xs text-stone-700">
                    <input type="checkbox" checked={!!x.detail.speaks} onChange={(e) => setSubject(x.subjectKey, { speaks: e.target.checked ? subject.detail.speaks : null })} /> Speaks ({words(subject.detail.speaks.kind)}
                    {subject.detail.speaks.claimKey ? `, ${subject.detail.speaks.claimKey}` : ''})
                  </label>
                )}
                <button type="button" onClick={() => set('subjects', f.subjects.filter((y) => y.subjectKey !== x.subjectKey))} className={link}>
                  Remove {x.subjectKey} from the shot
                </button>
              </div>
            );
          })}
          {f.subjects.length < s.subjects.length && (
            <button type="button" onClick={() => set('subjects', shotForm(s).subjects)} className={link}>
              Reset the subjects as they are
            </button>
          )}
        </fieldset>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Must avoid (lines to add)">
          <textarea value={f.addMustAvoid} onChange={(e) => set('addMustAvoid', e.target.value)} rows={2} className={input} />
        </Field>
        <Field label="Notes (one a line)">
          <textarea value={f.notes.join('\n')} onChange={(e) => set('notes', e.target.value.split('\n').slice(0, STORYBOARD_LIMITS.notes))} rows={2} className={input} />
        </Field>
        <Field label="Note on this edit (optional)" wide>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={input} />
        </Field>
      </div>
      {problems.map((p) => (
        <p key={p} className="text-xs break-words text-red-700">
          {p}
        </p>
      ))}
      <div className="flex flex-wrap items-start gap-2">
        <SaveRow edits={edits} disabled={!patch || problems.length > 0} label={`Save ${s.key} as a new version`} onReload={ctx.onReload} />
        <button type="button" onClick={onClose} className={secondary}>
          Cancel
        </button>
      </div>
      {!patch && <p className="text-xs text-stone-500">Nothing changed yet.</p>}
    </form>
  );
}

/** Where a detail comes from: a claim, the period in general, or invented (labelled so). */
function BasisSelect({ value, label, onChange }: { value: DetailBasis; label: string; onChange: (basis: DetailBasis) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as DetailBasis)} aria-label={label} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
      {DETAIL_BASES.map((b) => (
        <option key={b} value={b}>
          {DETAIL_BASIS_LABELS[b]}
        </option>
      ))}
    </select>
  );
}

/** A cut point inside the shot's words, where the second half starts as a new shot (same content). */
function SplitForm({ shot: s, version: v, edits, onReload }: { shot: ShotView; version: StoryboardVersionView; edits: Edits; onReload: () => void }) {
  const points = cutPointsBetween(v.cutPoints, s.timing.narrationStartMs ?? s.startMs, s.timing.narrationEndMs ?? s.endMs);
  const [at, setAt] = useState(points[0]?.id ?? '');
  if (!points.length) return <p className="mt-2 text-xs text-stone-500">There is no cut point inside {s.key}'s words: it cannot be split.</p>;
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-stone-200 p-2 text-sm"
      data-split={s.key}
      onSubmit={(e) => {
        e.preventDefault();
        if (at) edits.submit([{ op: 'splitShot', shotKey: s.key, at }]);
      }}
    >
      <Field label={`Split ${s.key} at`}>
        <CutPointSelect points={points} value={at} onChange={setAt} />
      </Field>
      <SaveRow edits={edits} disabled={!at} label="Split (new version)" onReload={onReload} />
    </form>
  );
}

function CutPointSelect({ points, value, onChange }: { points: StoryboardVersionView['cutPoints']; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={input}>
      {points.map((p) => (
        <option key={p.id} value={p.id}>
          {p.id} · {rangeText(p.atMs, p.atMs).split('–')[0]} · {CUT_POINT_KIND_LABELS[p.kind].toLowerCase()}
          {p.midSentence ? ' (inside a sentence: needs a reason)' : ''}
        </option>
      ))}
    </select>
  );
}

/** The cut between a shot and the next moved to another cut point between their words, with an optional nudge of up to ±2 s. */
function MoveCutForm({ left, right, version: v, edits, onReload }: { left: ShotView; right: ShotView; version: StoryboardVersionView; edits: Edits; onReload: () => void }) {
  const current = right.timing.narration?.from ?? '';
  const points = cutPointsBetween(v.cutPoints, left.timing.narrationStartMs ?? left.startMs, right.timing.narrationEndMs ?? right.endMs);
  const [to, setTo] = useState(points.some((p) => p.id === current) ? current : (points[0]?.id ?? ''));
  const [offset, setOffset] = useState(String(right.timing.cutOffsetMs ?? 0));
  const ms = Number(offset);
  const valid = Number.isInteger(ms) && Math.abs(ms) <= CUT_OFFSET_MAX_MS;
  const changed = to !== current || ms !== (right.timing.cutOffsetMs ?? 0);
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-stone-200 p-2 text-sm"
      data-move-cut={`${left.key}|${right.key}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (to && valid && changed) edits.submit([{ op: 'moveCut', leftShotKey: left.key, rightShotKey: right.key, to, ...(ms ? { offsetMs: ms } : {}) }]);
      }}
    >
      <Field label={`Cut between ${left.key} and ${right.key} at`}>
        <CutPointSelect points={points} value={to} onChange={setTo} />
      </Field>
      <Field label={`Nudge (ms, ±${CUT_OFFSET_MAX_MS})`}>
        <input type="number" min={-CUT_OFFSET_MAX_MS} max={CUT_OFFSET_MAX_MS} step={50} value={offset} onChange={(e) => setOffset(e.target.value)} className={`${input} w-28`} />
      </Field>
      <SaveRow edits={edits} disabled={!to || !valid || !changed} label="Move the cut (new version)" onReload={onReload} />
      {!valid && <p className="w-full text-xs text-red-700">A nudge is a whole number of ms, at most {CUT_OFFSET_MAX_MS} either way.</p>}
    </form>
  );
}

/** The recommended provider and model, chosen by a person among the router's candidates (kept on later re-costing), or back to the router's choice. */
function ProviderForm({ shot: s, edits, onReload }: { shot: ShotView; edits: Edits; onReload: () => void }) {
  const c = s.cost!;
  const options = c.candidates.map((x) => `${x.provider}\u0000${x.model}`);
  const [pick, setPick] = useState(options.find((o) => o === `${c.provider}\u0000${c.model}`) ?? options[0] ?? '');
  const [provider, model] = pick.split('\u0000');
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-stone-200 p-2 text-sm"
      data-provider-form={s.key}
      onSubmit={(e) => {
        e.preventDefault();
        if (provider && model) edits.submit([{ op: 'setRecommendation', shotKey: s.key, provider, model }]);
      }}
    >
      <Field label="Recommend (a candidate, with its forecast)">
        <select value={pick} onChange={(e) => setPick(e.target.value)} className={input}>
          {c.candidates.map((x) => (
            <option key={`${x.provider}/${x.model}`} value={`${x.provider}\u0000${x.model}`}>
              {x.provider} {x.model} · {estimateUsd(x.totalUsd)}
            </option>
          ))}
        </select>
      </Field>
      <SaveRow edits={edits} disabled={!pick || (provider === c.provider && model === c.model && c.source === 'USER')} label="Use it (new version)" onReload={onReload} />
      {c.source === 'USER' && (
        <button type="button" disabled={edits.pending} onClick={() => edits.submit([{ op: 'clearRecommendation', shotKey: s.key }])} className={secondary}>
          Back to the router's choice
        </button>
      )}
      <p className="w-full text-xs text-stone-500">The treatment comes first; a provider is only a recommendation for a later milestone. Nothing is generated.</p>
    </form>
  );
}

