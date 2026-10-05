import {
  DELIVERY_EMOTIONS,
  DELIVERY_EMOTION_LABELS,
  DELIVERY_ENERGIES,
  DELIVERY_ENERGY_LABELS,
  DELIVERY_PACES,
  DELIVERY_PACE_LABELS,
  PAUSE_LENGTHS,
  PAUSE_LENGTH_LABELS,
  PAUSE_REASON_LABELS,
  SCRIPT_BLOCK_CLASSES,
  SCRIPT_BLOCK_CLASS_HELP,
  SCRIPT_BLOCK_CLASS_LABELS,
  SCRIPT_ORIGIN_LABELS,
  SCRIPT_SCORES,
  SCRIPT_SCORE_LABELS,
  SECTION_REVIEW_STATUS_LABELS,
  VISUAL_INTENTS,
  VISUAL_INTENT_LABELS,
  fmtClock,
  fmtVariance,
  type ClaimView,
  type QualityJudgment,
  type QualityMeasurement,
  type ScriptAssessmentItem,
  type ScriptReviewChange,
  type ScriptBlockClass,
  type ScriptCompareView,
  type ScriptBlockView,
  type ScriptDelivery,
  type ScriptPause,
  type ScriptSectionView,
  type ScriptVersionView,
  type ScriptView,
  type SectionReviewStatus,
  type UpdateScriptBlockInput,
  type VisualIntent,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { formatUsd } from '../format.ts';
import { ClaimRefs, Section } from './evidence.tsx';

/**
 * The script as a production document: sections of narration blocks, each
 * coloured by information class, with its delivery, pauses, emphasis, visual
 * intent and evidence — and the editor's controls (edit, reorder, approve or
 * reject a section, rewrite it from a brief).
 */

export const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export const CLASS_TONE: Record<ScriptBlockClass, { bar: string; badge: string; bg: string }> = {
  DOCUMENTED: { bar: 'border-l-emerald-500', badge: 'bg-emerald-600 text-white', bg: 'bg-white' },
  RECONSTRUCTION: { bar: 'border-l-sky-500', badge: 'bg-sky-600 text-white', bg: 'bg-sky-50/50' },
  UNCERTAIN: { bar: 'border-l-amber-400', badge: 'bg-amber-400 text-amber-950', bg: 'bg-amber-50/60' },
  FICTION: { bar: 'border-l-fuchsia-600 border-dashed', badge: 'bg-fuchsia-700 text-white', bg: 'bg-fuchsia-50/60' },
  FRAMING: { bar: 'border-l-stone-300', badge: 'bg-stone-200 text-stone-700', bg: 'bg-white' },
};

const REVIEW_TONE: Record<SectionReviewStatus, string> = { PENDING: 'bg-stone-100 text-stone-600', APPROVED: 'bg-emerald-600 text-white', REJECTED: 'bg-red-600 text-white' };

export function ClassBadge({ cls }: { cls: ScriptBlockClass }) {
  return (
    <span className={`${pill} font-semibold ${CLASS_TONE[cls].badge}`} title={SCRIPT_BLOCK_CLASS_HELP[cls]}>
      {SCRIPT_BLOCK_CLASS_LABELS[cls]}
    </span>
  );
}

/** Invalidate the script view and the project after a change. */
export function useScriptRequest<T>(fn: (arg: T) => Promise<unknown>, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => onDone?.(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['script'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

const PAUSE_MARK: Record<ScriptPause['length'], string> = { NONE: '', MICRO: '·', SHORT: '‖', MEDIUM: '‖ ‖', LONG: '‖ ‖ ‖' };

function PauseMark({ pause }: { pause: ScriptPause }) {
  if (pause.length === 'NONE') return null;
  return (
    <span className="mx-1 align-middle font-mono text-xs text-violet-700" title={`${PAUSE_LENGTH_LABELS[pause.length]} pause${pause.reason ? ` (${PAUSE_REASON_LABELS[pause.reason]})` : ''}`}>
      {PAUSE_MARK[pause.length]}
    </span>
  );
}

/** The block's text with its emphasised words marked. */
function Spoken({ text, emphasis }: { text: string; emphasis: ScriptDelivery['emphasis'] }) {
  const ranges = emphasis
    .map((e) => ({ at: text.indexOf(e.text), len: e.text.length, strong: e.level === 'STRONG' }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at)
    .filter((r, i, all) => i === 0 || r.at >= all[i - 1]!.at + all[i - 1]!.len);
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.at > pos) parts.push(text.slice(pos, r.at));
    parts.push(
      <span key={i} className={r.strong ? 'font-bold underline decoration-violet-500 decoration-2' : 'underline decoration-violet-400'} title={r.strong ? 'Strong emphasis' : 'Light emphasis'}>
        {text.slice(r.at, r.at + r.len)}
      </span>,
    );
    pos = r.at + r.len;
  });
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

function DeliveryChips({ d }: { d: ScriptDelivery }) {
  const chips = [d.pace !== 'NORMAL' ? DELIVERY_PACE_LABELS[d.pace] : null, d.energy !== 'MEDIUM' ? DELIVERY_ENERGY_LABELS[d.energy] : null, d.emotion !== 'NEUTRAL' ? DELIVERY_EMOTION_LABELS[d.emotion] : null].filter(Boolean);
  return (
    <>
      {chips.map((c) => (
        <span key={c} className={`${pill} bg-violet-100 text-violet-900`}>
          {c}
        </span>
      ))}
    </>
  );
}

export function SectionCard({
  projectId,
  view: v,
  script: s,
  section: sec,
  claims,
  cast,
}: {
  projectId: string;
  view: ScriptView;
  script: ScriptVersionView;
  section: ScriptSectionView;
  claims: ClaimView[];
  cast: Map<string, { name: string; kind: string }>;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(sec.editorNotes ?? '');
  const [rewriting, setRewriting] = useState(false);
  const [brief, setBrief] = useState('');
  const editable = v.editorial.edit.allowed;
  const review = useScriptRequest((input: { reviewStatus?: SectionReviewStatus; editorNotes?: string | null }) => api.reviewScriptSection(sec.id, input), () => setNoting(false));
  const reorder = useScriptRequest((ids: string[]) => api.reorderScriptBlocks(sec.id, ids));
  const rewrite = useScriptRequest(() => api.reviseScript(projectId, { baseVersion: s.version, sections: [sec.sequenceNumber!], brief: brief.trim() }), () => setRewriting(false));
  const move = (i: number, d: -1 | 1) => {
    const ids = sec.blocks.map((b) => b.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };
  const planned = sec.plan?.targetSec ?? sec.targetDurationSec;
  const error = review.error ?? reorder.error ?? rewrite.error;
  return (
    <article data-section={sec.sequenceNumber} className="rounded-lg border border-stone-200 bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        <span className="font-mono text-xs text-stone-400">{sec.sequenceNumber}</span>
        <h3 className="font-semibold">{sec.title}</h3>
        <span className={`${pill} ${REVIEW_TONE[sec.reviewStatus]}`}>{SECTION_REVIEW_STATUS_LABELS[sec.reviewStatus]}</span>
        <span className="text-xs text-stone-500 tabular-nums">
          {fmtClock(sec.estimatedDurationSec)}
          {planned ? ` / ${fmtClock(planned)} planned` : ''} · {sec.wordCount} words
        </span>
        {s.sectionsWritten.length > 0 && s.origin === 'SECTIONS' && (
          <span className={`${pill} ${s.sectionsWritten.includes(sec.sequenceNumber!) ? 'bg-sky-100 text-sky-900' : 'bg-stone-100 text-stone-500'}`}>{s.sectionsWritten.includes(sec.sequenceNumber!) ? `rewritten in v${s.version}` : 'unchanged'}</span>
        )}
      </header>
      {sec.plan && (
        <details className="border-b border-stone-100 px-4 py-2 text-sm">
          <summary className="cursor-pointer text-xs text-stone-500">The plan for this section</summary>
          <dl className="mt-1 space-y-0.5 text-xs text-stone-700">
            <div>
              <dt className="inline font-medium">Purpose: </dt>
              <dd className="inline">{sec.plan.purpose}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Approach: </dt>
              <dd className="inline">{sec.plan.approach}</dd>
            </div>
            {sec.plan.showNotSay.length > 0 && (
              <div>
                <dt className="inline font-medium">Show, not say: </dt>
                <dd className="inline">{sec.plan.showNotSay.join('; ')}</dd>
              </div>
            )}
            <div>
              <dt className="inline font-medium">Tension / reveal: </dt>
              <dd className="inline">
                {sec.plan.tension} / {sec.plan.reveal}
              </dd>
            </div>
          </dl>
        </details>
      )}
      <ol className="divide-y divide-stone-100">
        {sec.blocks.map((b, i) => (
          <BlockRow key={b.id} block={b} claims={claims} cast={cast} editable={editable} first={i === 0} last={i === sec.blocks.length - 1} onMove={(d) => move(i, d)} moving={reorder.isPending} />
        ))}
      </ol>
      {sec.editorNotes && !noting && <p className="border-t border-stone-100 px-4 py-2 text-sm text-stone-700">Editor's note: “{sec.editorNotes}”</p>}
      {editable && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-stone-100 px-4 py-2">
          <button disabled={review.isPending || sec.reviewStatus === 'APPROVED'} onClick={() => review.mutate({ reviewStatus: 'APPROVED' })} className={`${button} bg-emerald-700 text-white hover:bg-emerald-600`}>
            Approve section
          </button>
          <button disabled={review.isPending || sec.reviewStatus === 'REJECTED'} onClick={() => review.mutate({ reviewStatus: 'REJECTED' })} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
            Reject
          </button>
          <button onClick={() => setNoting((x) => !x)} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50`}>
            {sec.editorNotes ? 'Edit note' : 'Add note'}
          </button>
          <button disabled={!v.editorial.revise.allowed} onClick={() => setRewriting((x) => !x)} title={v.editorial.revise.reason ?? undefined} className={`${button} bg-white text-sky-800 ring-1 ring-sky-300 hover:bg-sky-50`}>
            Regenerate section…
          </button>
        </footer>
      )}
      {noting && (
        <div className="space-y-2 border-t border-stone-100 px-4 py-2">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What to change in this section (used when it is rewritten)" className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
          <button disabled={review.isPending} onClick={() => review.mutate({ editorNotes: note.trim() || null })} className={`${button} bg-stone-800 text-white`}>
            Save note
          </button>
        </div>
      )}
      {rewriting && (
        <div className="space-y-2 border-t border-stone-100 bg-sky-50/40 px-4 py-2 text-sm">
          <p className="text-xs text-stone-600">
            Rewrites only this section into a new version (v{(v.scripts[0]?.version ?? 0) + 1}); every other section is copied unchanged, with no model calls. The script editor, the fact checker and the performance pass review the rewrite; v{s.version} is kept.
          </p>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="What to change — e.g. make this more tense and less explanatory; start closer to the turn" className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm" />
          <button disabled={rewrite.isPending || brief.trim().length < 10} onClick={() => rewrite.mutate(undefined)} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
            Rewrite section {sec.sequenceNumber}
          </button>
          {brief.trim().length < 10 && <span className="ml-2 text-xs text-stone-500">The brief needs at least a sentence.</span>}
        </div>
      )}
      {error && <p className="px-4 pb-2 text-sm text-red-700">{error.message}</p>}
    </article>
  );
}

function BlockRow({ block: b, claims, cast, editable, first, last, onMove, moving }: { block: ScriptBlockView; claims: ClaimView[]; cast: Map<string, { name: string; kind: string }>; editable: boolean; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; moving: boolean }) {
  const [editing, setEditing] = useState(false);
  const tone = CLASS_TONE[b.infoClass];
  const speaker = b.speakerId ? cast.get(b.speakerId) : undefined;
  const edited = b.editedAt !== null;
  return (
    <li data-block={b.key} className={`border-l-4 px-4 py-2 ${tone.bar} ${tone.bg}`}>
      {editing ? (
        <BlockEditor block={b} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="leading-relaxed">
            <PauseMark pause={b.delivery.pauseBefore} />
            {speaker && <span className="mr-1 text-xs font-semibold text-stone-500 uppercase">{speaker.name}:</span>}
            <Spoken text={b.text} emphasis={b.delivery.emphasis} />
            <PauseMark pause={b.delivery.pauseAfter} />
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
            <span className="font-mono text-stone-400">{b.key}</span>
            <ClassBadge cls={b.infoClass} />
            {b.fictionalDevice && <span className={`${pill} border border-dashed border-fuchsia-400 text-fuchsia-800`}>fictional device</span>}
            {b.speechKind && <span className={`${pill} bg-stone-100 text-stone-700`}>{b.speechKind === 'RECORDED_QUOTE' ? 'recorded quote' : 'invented line'}</span>}
            <DeliveryChips d={b.delivery} />
            <span className="tabular-nums">{b.estimatedDurationSec.toFixed(1)} s</span>
            {b.visual.intent !== 'NONE' && <span className={`${pill} bg-stone-100 text-stone-700`} title={[b.visual.note, b.visual.mustShow.length ? `Must show: ${b.visual.mustShow.map((m) => m.detail).join('; ')}` : '', b.visual.mustAvoid.length ? `Avoid: ${b.visual.mustAvoid.join('; ')}` : ''].filter(Boolean).join(' · ')}>👁 {VISUAL_INTENT_LABELS[b.visual.intent]}</span>}
            {b.claimKeys.length > 0 && <ClaimRefs keys={b.claimKeys} claims={claims} link={false} />}
            {edited && <span className={`${pill} bg-amber-100 text-amber-900`} title={`Generated: “${b.generatedText}”`}>edited by {b.editedBy}</span>}
            {editable && (
              <span className="ml-auto flex gap-1">
                <button aria-label={`Move ${b.key} up`} disabled={first || moving} onClick={() => onMove(-1)} className="rounded px-1.5 ring-1 ring-stone-300 disabled:opacity-30">
                  ▲
                </button>
                <button aria-label={`Move ${b.key} down`} disabled={last || moving} onClick={() => onMove(1)} className="rounded px-1.5 ring-1 ring-stone-300 disabled:opacity-30">
                  ▼
                </button>
                <button onClick={() => setEditing(true)} className="rounded px-2 text-sky-800 ring-1 ring-sky-300 hover:bg-sky-50">
                  Edit
                </button>
              </span>
            )}
          </div>
          {b.presentation.length > 0 && <p className="mt-1 text-xs text-amber-900">Presentation: {b.presentation.map((p) => `${p.claimKey} ${p.verdict.toLowerCase()} — ${p.instruction}`).join(' · ')}</p>}
        </>
      )}
    </li>
  );
}

function BlockEditor({ block: b, onDone }: { block: ScriptBlockView; onDone: () => void }) {
  const [text, setText] = useState(b.text);
  const [cls, setCls] = useState<ScriptBlockClass>(b.infoClass);
  const [d, setD] = useState<ScriptDelivery>(b.delivery);
  const [emphasis, setEmphasis] = useState(b.delivery.emphasis.map((e) => e.text).join(', '));
  const [strong, setStrong] = useState(b.delivery.emphasis.some((e) => e.level === 'STRONG'));
  const [intent, setIntent] = useState<VisualIntent>(b.visual.intent);
  const save = useScriptRequest((input: UpdateScriptBlockInput) => api.updateScriptBlock(b.id, input), onDone);
  const submit = () => {
    const phrases = emphasis.split(',').map((x) => x.trim()).filter(Boolean);
    const input: UpdateScriptBlockInput = {
      ...(text.trim() !== b.text ? { text: text.trim() } : {}),
      ...(cls !== b.infoClass ? { infoClass: cls } : {}),
      delivery: { ...d, emphasis: phrases.map((p) => ({ text: p, level: strong ? 'STRONG' : 'LIGHT' })) },
      ...(intent !== b.visual.intent ? { visual: { intent } } : {}),
    };
    save.mutate(input);
  };
  const select = 'min-w-0 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm';
  const pauseSelect = (value: ScriptPause, set: (p: ScriptPause) => void, label: string) => (
    <select aria-label={label} value={value.length} onChange={(e) => set({ length: e.target.value as ScriptPause['length'], reason: e.target.value === 'NONE' ? null : (value.reason ?? 'RHYTHM') })} className={select}>
      {PAUSE_LENGTHS.map((p) => (
        <option key={p} value={p}>
          {label}: {PAUSE_LENGTH_LABELS[p]}
        </option>
      ))}
    </select>
  );
  return (
    <div className="space-y-2">
      <textarea aria-label="Narration" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))} className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm leading-relaxed" />
      <div className="grid gap-2 sm:grid-cols-3">
        <select aria-label="Information class" value={cls} onChange={(e) => setCls(e.target.value as ScriptBlockClass)} className={select}>
          {SCRIPT_BLOCK_CLASSES.map((c) => (
            <option key={c} value={c}>
              {SCRIPT_BLOCK_CLASS_LABELS[c]}
            </option>
          ))}
        </select>
        <select aria-label="Pace" value={d.pace} onChange={(e) => setD({ ...d, pace: e.target.value as ScriptDelivery['pace'] })} className={select}>
          {DELIVERY_PACES.map((p) => (
            <option key={p} value={p}>
              {DELIVERY_PACE_LABELS[p]}
            </option>
          ))}
        </select>
        <select aria-label="Energy" value={d.energy} onChange={(e) => setD({ ...d, energy: e.target.value as ScriptDelivery['energy'] })} className={select}>
          {DELIVERY_ENERGIES.map((p) => (
            <option key={p} value={p}>
              {DELIVERY_ENERGY_LABELS[p]}
            </option>
          ))}
        </select>
        <select aria-label="Emotion" value={d.emotion} onChange={(e) => setD({ ...d, emotion: e.target.value as ScriptDelivery['emotion'] })} className={select}>
          {DELIVERY_EMOTIONS.map((p) => (
            <option key={p} value={p}>
              {DELIVERY_EMOTION_LABELS[p]}
            </option>
          ))}
        </select>
        {pauseSelect(d.pauseBefore, (p) => setD({ ...d, pauseBefore: p }), 'Pause before')}
        {pauseSelect(d.pauseAfter, (p) => setD({ ...d, pauseAfter: p }), 'Pause after')}
        <input aria-label="Emphasis" value={emphasis} onChange={(e) => setEmphasis(e.target.value)} placeholder="Words to stress, comma-separated" className="rounded-md border border-stone-300 px-2 py-1 text-sm sm:col-span-2" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={strong} onChange={(e) => setStrong(e.target.checked)} /> strong emphasis
        </label>
        <select aria-label="Visual intent" value={intent} onChange={(e) => setIntent(e.target.value as VisualIntent)} className={select}>
          {VISUAL_INTENTS.map((p) => (
            <option key={p} value={p}>
              {VISUAL_INTENT_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-stone-500">The gate checks the block again when you save (rules only). The generated text is kept.</p>
      <div className="flex gap-2">
        <button disabled={save.isPending || !text.trim()} onClick={submit} className={`${button} bg-sky-700 text-white hover:bg-sky-600`}>
          Save
        </button>
        <button onClick={onDone} className={`${button} bg-white text-stone-700 ring-1 ring-stone-300`}>
          Cancel
        </button>
      </div>
      {save.error && <p className="text-sm text-red-700">{save.error.message}</p>}
    </div>
  );
}

// ── Versions and comparison ──────────────────────────────────────────────────

export function VersionsTab({ projectId, view: v, onVersion }: { projectId: string; view: ScriptView; onVersion: (version: number) => void }) {
  const shown = v.script?.version ?? null;
  const [a, setA] = useState<number | null>(v.scripts[1]?.version ?? null);
  const [b, setB] = useState<number | null>(v.scripts[0]?.version ?? null);
  const compare = useQuery({ queryKey: ['script', 'compare', projectId, a, b], queryFn: () => api.compareScripts(projectId, a!, b!), enabled: a !== null && b !== null && a !== b });
  const restore = useScriptRequest((version: number) => api.restoreScript(projectId, version));
  return (
    <div className="space-y-4">
      <Section title={`Versions (${v.scripts.length}) — every version is kept`}>
        <ul className="divide-y divide-stone-100 text-sm">
          {v.scripts.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
              <button onClick={() => onVersion(x.version)} disabled={x.version === shown} className="font-mono text-sky-800 underline decoration-dotted disabled:text-stone-900 disabled:no-underline">
                v{x.version}
              </button>
              <span className={`${pill} bg-stone-100 text-stone-700`}>{x.status.toLowerCase().replace('_', ' ')}</span>
              {!x.qualityPassed && <span className={`${pill} bg-red-100 text-red-800`}>blocking findings</span>}
              <span className="text-stone-600">
                {SCRIPT_ORIGIN_LABELS[x.origin]}
                {x.revisionOfVersion ? ` of v${x.revisionOfVersion}` : ''}
                {x.origin === 'SECTIONS' && x.sectionsWritten.length ? ` (section${x.sectionsWritten.length > 1 ? 's' : ''} ${x.sectionsWritten.join(', ')})` : ''} · architecture v{x.architectureVersion ?? '—'} · {x.wordCount} words · {fmtClock(x.estimatedDurationSec)}
              </span>
              {x.version === shown && <span className="text-xs text-stone-500">(shown)</span>}
            </li>
          ))}
        </ul>
        {v.script && v.editorial.restore.allowed && (
          <button disabled={restore.isPending} onClick={() => restore.mutate(v.script!.version)} className={`${button} mt-2 bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50`}>
            Make v{v.script.version} current again (as a new version)
          </button>
        )}
        {restore.error && <p className="mt-1 text-sm text-red-700">{restore.error.message}</p>}
      </Section>
      {v.scripts.length > 1 && (
        <Section title="Compare versions">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {[
              ['From', a, setA] as const,
              ['to', b, setB] as const,
            ].map(([label, value, set]) => (
              <label key={label} className="flex items-center gap-1">
                {label}
                <select value={value ?? ''} onChange={(e) => set(Number(e.target.value))} className="rounded-md border border-stone-300 px-2 py-1">
                  {v.scripts.map((x) => (
                    <option key={x.id} value={x.version}>
                      v{x.version}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {compare.data && <Comparison cmp={compare.data} />}
          {compare.error && <p className="text-sm text-red-700">{compare.error.message}</p>}
        </Section>
      )}
    </div>
  );
}

const GATE_TONE = (passed: boolean) => (passed ? 'text-emerald-700' : 'text-red-700');
const CLASS_ORDER: ScriptBlockClass[] = ['DOCUMENTED', 'RECONSTRUCTION', 'UNCERTAIN', 'FICTION', 'FRAMING'];

/** Two versions side by side: the numbers, what changed and why, the evidence, the checklist, then the text. */
function Comparison({ cmp }: { cmp: ScriptCompareView }) {
  const { a, b, facts, totals, evidence } = cmp;
  const ev = [...evidence.claimsAdded.map((k) => `+${k}`), ...evidence.claimsRemoved.map((k) => `−${k}`)];
  const figs = [...evidence.figuresAdded.map((k) => `+${k}`), ...evidence.figuresRemoved.map((k) => `−${k}`)];
  const row = (label: string, x: ReactNode, y: ReactNode) => (
    <tr key={label}>
      <th className="py-1 pr-3 text-left font-normal text-stone-500">{label}</th>
      <td className="py-1 pr-3 tabular-nums">{x}</td>
      <td className="py-1 tabular-nums">{y}</td>
    </tr>
  );
  const gate = (f: typeof facts.a) => (
    <span className={GATE_TONE(f.gate.passed)} title={[...f.gate.failed.map((c) => `FAIL ${c}`), ...f.gate.warned.map((c) => `WARN ${c}`)].join(', ')}>
      {f.gate.passed ? 'passed' : `${f.gate.failed.length} blocking`}
      {f.gate.warned.length ? <span className="text-stone-500"> · {f.gate.warned.length} warn</span> : null}
    </span>
  );
  return (
    <div className="mt-3 space-y-4 text-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[18rem]">
          <thead className="text-xs text-stone-500 uppercase">
            <tr>
              <th />
              <th className="pb-1 text-left font-medium">
                v{a.version} <span className="normal-case">{SCRIPT_ORIGIN_LABELS[a.origin].toLowerCase()}</span>
              </th>
              <th className="pb-1 text-left font-medium">
                v{b.version} <span className="normal-case">{SCRIPT_ORIGIN_LABELS[b.origin].toLowerCase()}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {row('Words', a.wordCount.toLocaleString(), b.wordCount.toLocaleString())}
            {row('Runtime', fmtClock(a.estimatedDurationSec), fmtClock(b.estimatedDurationSec))}
            {row('Blocks', facts.a.blocks, facts.b.blocks)}
            {row('Quality gate', gate(facts.a), gate(facts.b))}
            {row('Model cost', facts.a.cost.calls ? `${formatUsd(facts.a.cost.totalUsd)} · ${facts.a.cost.calls} calls` : '—', facts.b.cost.calls ? `${formatUsd(facts.b.cost.totalUsd)} · ${facts.b.cost.calls} calls` : '—')}
            {SCRIPT_SCORES.filter((k) => facts.a.scores[k] !== undefined || facts.b.scores[k] !== undefined).map((k) => row(`${SCRIPT_SCORE_LABELS[k]} (model judgment)`, facts.a.scores[k] ?? '—', facts.b.scores[k] ?? '—'))}
            {CLASS_ORDER.filter((k) => facts.a.classWords[k] || facts.b.classWords[k]).map((k) => row(`${SCRIPT_BLOCK_CLASS_LABELS[k]} (words)`, facts.a.classWords[k] ?? 0, facts.b.classWords[k] ?? 0))}
          </tbody>
        </table>
      </div>
      <p className="text-stone-700">
        {totals.sectionsChanged} section(s) changed · <span className={totals.wordsRemoved ? 'text-red-700' : ''}>{totals.wordsRemoved ? `−${totals.wordsRemoved.toLocaleString()}` : 'no'} words removed</span> ·{' '}
        <span className={totals.wordsAdded ? 'text-emerald-700' : ''}>{totals.wordsAdded ? `+${totals.wordsAdded.toLocaleString()}` : 'none'} added</span>
      </p>
      <p className={ev.length || figs.length ? 'text-amber-800' : 'text-stone-600'}>
        Evidence: {ev.length || figs.length ? [ev.length ? `claims ${ev.join(', ')}` : null, figs.length ? `figures ${figs.join(', ')}` : null].filter(Boolean).join(' · ') : 'the same claims cited and the same figures said.'}
      </p>
      {cmp.changeLog && (cmp.changeLog.summary || cmp.changeLog.changes.length > 0) && (
        <div>
          <p className="font-medium">
            What changed in v{b.version}, and why <span className="font-normal text-stone-500">— the writer's own account; the measured figures above are what count</span>
          </p>
          {cmp.changeLog.summary && <p className="mt-1 text-stone-700">{cmp.changeLog.summary}</p>}
          <ul className="mt-1 list-disc pl-5 text-stone-700">
            {cmp.changeLog.changes.map((c, i) => (
              <li key={i}>
                {c.section ? `Section ${c.section}: ` : ''}
                {c.what} <span className="text-stone-500">— {c.why}</span>
              </li>
            ))}
          </ul>
          {(cmp.changeLog.kept ?? []).length > 0 && <p className="mt-1 text-stone-600">Kept word for word: {cmp.changeLog.kept!.map((l) => `“${l}”`).join(' · ')}</p>}
        </div>
      )}
      {cmp.assessment.length > 0 && <AssessmentList items={cmp.assessment} against={a.version} />}
      {cmp.sections.map((x) => (
        <details key={x.sequenceNumber} className="rounded border border-stone-200 p-2">
          <summary className="cursor-pointer">
            <span className="font-medium">
              {x.sequenceNumber}. {x.title}
            </span>{' '}
            <span className="text-xs text-stone-500 tabular-nums">
              {x.changed ? `${x.words.a} → ${x.words.b} words (−${x.words.removed} +${x.words.added}) · ${fmtClock(x.durationSec.a)} → ${fmtClock(x.durationSec.b)}` : 'unchanged'}
            </span>
          </summary>
          <ul className="mt-1 space-y-1">
            {x.diff.map((d, i) => (
              <li key={i} className={d.op === 'added' ? 'bg-emerald-50 text-emerald-900' : d.op === 'removed' ? 'bg-red-50 text-red-800 line-through' : 'text-stone-500'}>
                <span className="mr-1 font-mono text-xs">{d.op === 'added' ? '+' : d.op === 'removed' ? '−' : ' '}</span>
                {d.text}
              </li>
            ))}
          </ul>
        </details>
      ))}
      <p className="text-xs text-stone-500">To use v{a.version} instead, open it above and make it current again — a new version; nothing is lost.</p>
    </div>
  );
}

const ANSWER_TONE: Record<ScriptAssessmentItem['answer'], string> = { YES: 'bg-emerald-100 text-emerald-800', PARTLY: 'bg-amber-100 text-amber-900', NO: 'bg-red-100 text-red-800' };

/** The script editor's refinement checklist, answered against the version refined. */
export function AssessmentList({ items, against }: { items: ScriptAssessmentItem[]; against: number | null }) {
  return (
    <Section title={`Refinement checklist — the script editor${against ? `, against v${against}` : ''} (model judgment)`}>
      <ol className="space-y-1.5 text-sm">
        {items.map((x, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2">
            <span className={`${pill} ${ANSWER_TONE[x.answer]}`}>{x.answer.toLowerCase()}</span>
            <span className="text-xs text-stone-500">{x.comparedToPrevious.toLowerCase()}</span>
            <span className="font-medium">{x.question}</span>
            <span className="basis-full text-stone-600 sm:basis-auto">{x.note}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ── Measured, judged, and what the reviewers proposed ────────────────────────

/** What code measured from the script: never a model's estimate. */
export function MeasurementsSection({ items }: { items: QualityMeasurement[] }) {
  return (
    <Section title="Measured — computed from the script, not estimated by a model">
      <ul className="divide-y divide-stone-100 text-sm">
        {items.map((m) => (
          <li key={m.id} className="py-1.5 break-words">
            <span className="font-medium">{m.label}:</span> <span className="tabular-nums">{m.value}</span>
            {m.detail && <span className="text-stone-500"> — {m.detail}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What the models judged: opinions, recorded, never measurements. */
export function JudgmentsSection({ items }: { items: QualityJudgment[] }) {
  return (
    <Section title="Model judgments — opinions, recorded, never measurements">
      <ul className="space-y-2 text-sm">
        {items.map((j) => (
          <li key={j.id}>
            <span className="font-medium">{j.label}</span> <span className="text-xs text-stone-500">({j.source})</span>: {j.value}
            {j.detail && <div className="break-words text-stone-600">{j.detail}</div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

const CHANGE_TONE: Record<ScriptReviewChange['status'], string> = { ACCEPTED: 'bg-emerald-100 text-emerald-800', REJECTED: 'bg-red-100 text-red-800', SKIPPED: 'bg-stone-100 text-stone-600' };
const REVIEWER_LABEL: Record<ScriptReviewChange['reviewer'], string> = { SCRIPT_EDITOR: 'Script editor', FACT_CHECKER: 'Fact checker', PERFORMANCE: 'Performance timing' };

/** Every change the reviewers proposed in the run that made this version, judged one by one. */
export function ReviewChangesSection({ changes }: { changes: ScriptReviewChange[] }) {
  const n = (s: ScriptReviewChange['status']) => changes.filter((c) => c.status === s).length;
  const reviewers = [...new Set(changes.map((c) => c.reviewer))];
  return (
    <Section title={`Reviewer changes — each judged on its own (${n('ACCEPTED')} kept, ${n('REJECTED')} rejected, ${n('SKIPPED')} skipped)`}>
      <p className="mb-2 text-xs text-stone-500">A change is kept only if it weakens no invariant: evidence, claim links, information classes, fiction and real-person boundaries, quotations, uncertainty, the architecture, the runtime maximum. One rejected change never costs the others.</p>
      {reviewers.map((r) => (
        <div key={r} className="mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{REVIEWER_LABEL[r]}</h3>
          <ul className="mt-1 space-y-1.5 text-sm">
            {changes
              .filter((c) => c.reviewer === r)
              .map((c) => (
                <li key={c.id} className="break-words">
                  <span className={`${pill} ${CHANGE_TONE[c.status]}`}>{c.status.toLowerCase()}</span> <span className="font-mono text-xs text-stone-500">{c.id}</span> {c.type.toLowerCase()} {c.ref ?? ''}
                  {c.savedRef && c.savedRef !== c.ref ? ` → ${c.savedRef}` : ''} — <span className="text-stone-700">{c.reason || 'no reason given'}</span>
                  {c.rejectionReason && <div className="text-xs text-red-800">{c.rejectionReason}</div>}
                  {c.status === 'ACCEPTED' && c.rulesImpacted.length > 0 && <div className="text-xs text-stone-500">{c.rulesImpacted.join(' · ')}</div>}
                  {(c.originalText || c.proposedText) && (
                    <details className="text-xs text-stone-600">
                      <summary className="cursor-pointer">the change</summary>
                      {c.originalText && <p className="text-red-800 line-through">{c.originalText}</p>}
                      {c.proposedText && <p className="text-emerald-900">{c.proposedText}</p>}
                    </details>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

// ── Pronunciation and the voice plan ─────────────────────────────────────────

export function VoiceTab({ projectId, script: s }: { projectId: string; script: ScriptVersionView }) {
  const [show, setShow] = useState(false);
  const plan = useQuery({ queryKey: ['script', 'voice', projectId, s.version], queryFn: () => api.voicePlan(projectId, s.version), enabled: show });
  const p = s.content?.pronunciations ?? [];
  return (
    <div className="space-y-4">
      <Section title={`Pronunciation (${p.length})`}>
        {p.length === 0 ? (
          <p className="text-sm text-stone-500">No pronunciation notes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-stone-500 uppercase">
                <tr>
                  <th className="py-1 pr-3">Term</th>
                  <th className="py-1 pr-3">Say it</th>
                  <th className="py-1 pr-3">IPA</th>
                  <th className="py-1 pr-3">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 align-top">
                {p.map((x) => (
                  <tr key={x.term}>
                    <td className="py-1 pr-3 font-medium">
                      {x.term}
                      {x.language && <span className="ml-1 text-xs font-normal text-stone-500">({x.language})</span>}
                    </td>
                    <td className="py-1 pr-3">{x.respelling}</td>
                    <td className="py-1 pr-3 font-mono text-xs">{x.ipa ?? '—'}</td>
                    <td className="py-1 pr-3">
                      <span className={`${pill} ${x.needsReview ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800'}`}>{x.needsReview ? `${x.confidence.toLowerCase()} — check` : 'confirmed'}</span>
                      {x.note && <p className="text-xs text-stone-500">{x.note}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-stone-500">Pronunciations are not guessed silently: anything not confirmed is flagged for a person to check, and only confirmed ones would be sent to the voice provider.</p>
      </Section>
      <Section title={`Voice plan — ${s.voice.provider} (no audio generated)`}>
        <p className="text-sm text-stone-600">
          {s.voice.segments} request(s), {s.voice.characters.toLocaleString()} characters
          {s.voice.pendingPronunciations ? ` · ${s.voice.pendingPronunciations} pronunciation(s) to confirm first` : ''}. This is what the voice adapter would send; the voice stage is a later milestone.
        </p>
        {!show ? (
          <button onClick={() => setShow(true)} className={`${button} mt-2 bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50`}>
            Show the requests
          </button>
        ) : plan.data ? (
          <div className="mt-2 space-y-2">
            {plan.data.unsupported.length > 0 && <p className="text-xs text-amber-900">Not expressible for this provider (kept in the script): {plan.data.unsupported.join('; ')}</p>}
            <ol className="space-y-2">
              {plan.data.segments.map((seg, i) => (
                <li key={i} className="rounded border border-stone-200 p-2 text-xs">
                  <p className="text-stone-500">
                    {seg.sectionKey} · blocks {seg.blockKeys.join(', ')} · speed {seg.speed} · {seg.characters} characters
                  </p>
                  <p className="mt-1 font-mono break-words whitespace-pre-wrap text-stone-800">{seg.text}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-sm text-stone-500">Loading…</p>
        )}
      </Section>
    </div>
  );
}

export function TimingSummary({ script: s }: { script: ScriptVersionView }) {
  const t = s.timing;
  const pct = Math.min(100, (t.totalSec / Math.max(t.maxSec, 1)) * 100);
  const tone = t.fit === 'WITHIN' ? 'bg-emerald-500' : t.fit === 'NEAR' ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{fmtClock(t.totalSec)}</span>
        <span className="text-sm text-stone-500">
          target {fmtClock(t.targetSec)} · variance <span className={t.fit === 'WITHIN' ? 'text-emerald-700' : 'text-amber-800'}>{fmtVariance(t.varianceSec)}</span>
        </span>
      </div>
      <div className="relative mt-1 h-2 rounded bg-stone-100" title={`Acceptable ${fmtClock(t.minSec)}–${fmtClock(t.maxSec)}`}>
        <div className="absolute inset-y-0 rounded bg-emerald-100" style={{ left: `${(t.minSec / Math.max(t.maxSec, 1)) * 100}%`, right: 0 }} />
        <div className={`absolute inset-y-0 left-0 rounded ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-stone-500">
        {t.words.toLocaleString()} spoken words at 150 a minute, with pauses and pace · acceptable {fmtClock(t.minSec)}–{fmtClock(t.maxSec)}
      </p>
    </div>
  );
}
