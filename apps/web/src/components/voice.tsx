import {
  CHUNK_BOUNDARY_LABELS,
  CHUNK_SECONDS,
  DELIVERY_EMOTION_LABELS,
  VOICE_GENERATION_STATUS_LABELS,
  type ArtifactStatus,
  type DirectorMark,
  type PerformanceMark,
  type RegenerateVoiceInput,
  type VoiceChunkView,
  type VoiceGenerationStatus,
  type VoiceGenerationView,
  type VoiceProductionView,
  type VoiceQaFinding,
  type VoiceRunView,
  type VoiceSettingDescriptor,
} from '@docengine/core';
import { useState } from 'react';
import { api } from '../api.ts';
import { configDifferences, isEmptyOverrides, outsideNatural, overrideProblems, parseDirections, productionRefusal, profileLabel, profileNameFor, pruneOverrides, sentenceSpans, takeCostText, takeLabels, type EditedOverrides } from '../voice-plan.ts';
import { button, link, OverridesEditor, pill, SaveAsProfile, secondary, useVoiceRequest, type OverrideField } from './voice-profiles.tsx';

export { button, link, pill, secondary, useVoiceRequest };

/** A label whose text varies (a profile's name, an override): it wraps on a phone rather than overflow. */
const tag = 'inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium break-words';

export const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

const STATUS_TONE: Record<VoiceGenerationStatus, string> = {
  PENDING: 'bg-stone-100 text-stone-600',
  GENERATING: 'bg-sky-100 text-sky-800',
  GENERATED: 'bg-violet-50 text-violet-800',
  IN_REVIEW: 'bg-violet-100 text-violet-800',
  FAILED: 'bg-red-100 text-red-800',
  REJECTED: 'bg-red-600 text-white',
  APPROVED: 'bg-emerald-600 text-white',
  SUPERSEDED: 'bg-stone-200 text-stone-600',
};

export function TakeStatus({ status }: { status: VoiceGenerationStatus }) {
  return <span className={`${pill} ${STATUS_TONE[status]}`}>{VOICE_GENERATION_STATUS_LABELS[status]}</span>;
}

const ASSEMBLY_STATUS: Record<ArtifactStatus, [string, string]> = {
  DRAFT: ['Incomplete: a chunk has no usable take', 'bg-amber-100 text-amber-900'],
  IN_REVIEW: ['To review', 'bg-violet-100 text-violet-800'],
  APPROVED: ['Approved', 'bg-emerald-600 text-white'],
  REJECTED: ['Rejected', 'bg-red-100 text-red-800'],
  SUPERSEDED: ['Superseded', 'bg-stone-200 text-stone-600'],
};

export function AssemblyStatus({ status }: { status: ArtifactStatus }) {
  const [label, tone] = ASSEMBLY_STATUS[status];
  return <span className={`${pill} ${tone}`}>{label}</span>;
}

export function Findings({ findings, empty = 'Nothing flagged.' }: { findings: VoiceQaFinding[]; empty?: string }) {
  if (!findings.length) return <p className="text-xs text-emerald-700">{empty}</p>;
  return (
    <ul className="space-y-1 text-xs">
      {findings.map((f, i) => (
        <li key={i} className={f.severity === 'BLOCKING' ? 'text-red-800' : 'text-amber-900'}>
          <span className="font-semibold">{f.severity === 'BLOCKING' ? 'Blocks approval' : 'Check'}</span>
          {f.ref ? ` · ${f.ref}` : ''} — {f.detail}
        </li>
      ))}
    </ul>
  );
}

/** An audio player sized for a phone; loads nothing until played. */
export function Player({ src, label }: { src: string | null; label: string }) {
  if (!src) return <p className="text-xs text-stone-500">No audio.</p>;
  return <audio controls preload="none" src={src} aria-label={label} className="h-9 w-full max-w-md" />;
}

/** Seconds, flagged when outside the range a natural thought runs to. */
export function Length({ sec, prefix = '' }: { sec: number; prefix?: string }) {
  // Flagged as shown: 20.04 s reads 20.0 s, inside the range.
  const shown = Math.round(sec * 10) / 10;
  const out = outsideNatural(shown);
  return (
    <span className={out ? `${pill} bg-amber-100 text-amber-900` : ''} title={out ? `Outside ${CHUNK_SECONDS.natural.min}–${CHUNK_SECONDS.natural.max} s` : undefined}>
      {prefix}
      {shown.toFixed(1)} s{out ? ` · outside ${CHUNK_SECONDS.natural.min}–${CHUNK_SECONDS.natural.max} s` : ''}
    </span>
  );
}

/** A chunk's text with its sentences numbered as directions address them ("2: curious"). */
export function NumberedText({ text, className = '' }: { text: string; className?: string }) {
  const spans = sentenceSpans(text);
  return (
    <p className={`break-words whitespace-pre-wrap ${className}`}>
      {spans.map((s, i) => (
        <span key={s.start}>
          {text.slice(i ? spans[i - 1]!.end : 0, s.start)}
          <sup className="mr-0.5 font-sans text-[10px] font-semibold text-stone-400" data-sentence={i + 1}>
            {i + 1}
          </sup>
          {text.slice(s.start, s.end)}
        </span>
      ))}
    </p>
  );
}

const MARK_SOURCE: Record<PerformanceMark['source'], string> = { SCRIPT: 'script', STRATEGY: 'strategy', DIRECTOR: 'director' };
const markWords = (m: { emotion?: string | null; delivery?: string | null; vocalAction?: string | null }) => [m.emotion, m.delivery, m.vocalAction].filter(Boolean).join(', ');

/** What a chunk card needs beyond its chunk: its run, the project's production profile now, and the provider's settings (for "Regenerate with…" and saving a take's configuration). */
export interface ChunkContext {
  run: VoiceRunView;
  production: VoiceProductionView;
  settings: readonly VoiceSettingDescriptor[];
  projectId: string;
  projectTitle: string;
}

function TakeLine({ take, chunk, context, newer = false, busy, onDecide }: { take: VoiceGenerationView; chunk: VoiceChunkView; context: ChunkContext; newer?: boolean; busy: boolean; onDecide: (id: string, action: 'APPROVE' | 'REJECT' | 'RESTORE') => void }) {
  const [showText, setShowText] = useState(false);
  const marks = take.prepared?.marks ?? [];
  const labels = takeLabels(take.configuration, take.variant);
  return (
    <div className={`rounded-md border p-2 ${take.current ? 'border-stone-300 bg-white' : 'border-stone-200 bg-stone-50'}`} data-take={take.generation} data-current={take.current}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <span className="font-semibold text-stone-800">Take {take.generation}</span>
        <TakeStatus status={take.status} />
        {take.current && <span className={`${pill} bg-stone-900 text-white`}>current</span>}
        {newer && !take.current && <span className={`${pill} bg-sky-50 text-sky-800`}>newer, not current</span>}
        {take.variant && <span className={`${pill} bg-indigo-100 text-indigo-800`}>A/B · {take.variant}</span>}
        {labels.production && (
          <span className={`${tag} bg-sky-100 text-sky-800`} data-take-config="production">
            {labels.production}
          </span>
        )}
        {labels.override && (
          <span className={`${tag} bg-amber-100 text-amber-900`} data-take-config="override">
            {labels.override}
          </span>
        )}
        {take.mock && <span className={`${pill} bg-amber-100 text-amber-900`}>MOCK</span>}
        {take.durationMs !== null ? <Length sec={take.durationMs / 1000} /> : <span>—</span>}
        <span>{take.strategy.toLowerCase()}</span>
        {take.cost ? (
          <span className="min-w-0 break-words" title={take.cost.note ?? ''}>
            {takeCostText(take.cost)}
            {take.cost.reestimated ? ' · re-estimated' : ''}
          </span>
        ) : (
          take.characters !== null && <span>{take.characters} chars</span>
        )}
        <span className="min-w-0 break-all">
          {take.model} · voice {take.voiceId} · {profileLabel(take.profile)}
        </span>
      </div>
      {labels.differs && <p className="mt-1 text-xs break-words text-stone-600">{labels.differs}</p>}
      {take.cost?.reestimated && take.cost.note && <p className="mt-1 text-xs text-stone-500">{take.cost.note}</p>}
      {marks.length > 0 && (
        <p className="mt-1 text-xs text-stone-600">
          Directions: {marks.map((m) => `${m.sentence + 1}: ${markWords(m.intent) || m.intent.pacing.toLowerCase()} (${MARK_SOURCE[m.source]})`).join(' · ')}
        </p>
      )}
      {!take.prepared && take.directions && take.directions.length > 0 && <p className="mt-1 text-xs text-stone-600">Directions asked: {take.directions.map((d) => `${d.sentence + 1}: ${markWords(d)}`).join(' · ')}</p>}
      {take.audioUrl && (
        <div className="mt-1">
          <Player src={take.audioUrl} label={`Chunk ${chunk.index + 1}, take ${take.generation}`} />
        </div>
      )}
      {take.error && <p className="mt-1 text-xs break-words text-red-800">{take.error}</p>}
      {take.note && <p className="mt-1 text-xs text-stone-600">Note: {take.note}</p>}
      {take.qa.length > 0 && (
        <div className="mt-1">
          <Findings findings={take.qa} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {take.current && (take.status === 'IN_REVIEW' || take.status === 'GENERATED') && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'APPROVE')} className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`}>
            Approve
          </button>
        )}
        {(['IN_REVIEW', 'GENERATED', 'APPROVED', 'SUPERSEDED'] as VoiceGenerationStatus[]).includes(take.status) && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'REJECT')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
            Reject
          </button>
        )}
        {!take.current && take.audioUrl && take.durationMs !== null && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'RESTORE')} className={secondary}>
            Use this take
          </button>
        )}
        {take.performanceText && (
          <button onClick={() => setShowText((x) => !x)} aria-expanded={showText} className={link}>
            {showText ? 'Hide' : 'Show'} what was sent
          </button>
        )}
      </div>
      {take.configuration.override && take.audioUrl && (
        <SaveAsProfile runId={context.run.id} generationId={take.id} projectId={context.projectId} production={context.production} defaultName={profileNameFor(context.projectTitle)} what="take" />
      )}
      {showText && take.performanceText && (
        <div className="mt-1 space-y-1 text-xs">
          <p className="text-stone-500">Derived text sent to the voice (the script is unchanged):</p>
          <p className="font-mono break-words whitespace-pre-wrap text-stone-800">{take.performanceText}</p>
          {take.prepared && take.prepared.spokenForms.length > 0 && (
            <p className="text-stone-600">Spoken forms: {take.prepared.spokenForms.map((f) => `${f.display} → ${f.spoken}${f.confidence === 'MEDIUM' ? ' (check)' : ''}`).join('; ')}</p>
          )}
          {take.prepared && (
            <p className="text-stone-600">
              Checks: {take.prepared.checks.map((c) => `${c.label} ${c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠' : '✗'}`).join(' · ')}
              {take.prepared.context.previousText || take.prepared.context.nextText ? ` · context sent: ${take.prepared.context.previousText ? 'previous' : ''}${take.prepared.context.previousText && take.prepared.context.nextText ? ' + ' : ''}${take.prepared.context.nextText ? 'next' : ''}` : ''}
              {take.prepared.seed !== null ? ` · seed ${take.prepared.seed}` : ''}
            </p>
          )}
          {take.prepared?.sent && <p className="text-stone-600">Settings sent: {Object.entries(take.prepared.sent).map(([k, v]) => `${k} ${String(v)}`).join(', ') || 'none'}</p>}
        </div>
      )}
    </div>
  );
}

// ── What a new take is made with ─────────────────────────────────────────────

/** RUN: the run's configuration; PRODUCTION: the project's production profile now; OVERRIDE: the run's configuration with a temporary override. */
export interface TakeChoice {
  base: 'RUN' | 'PRODUCTION' | 'OVERRIDE';
  override: EditedOverrides;
}
export const RUN_CHOICE: TakeChoice = { base: 'RUN', override: {} };

/** The request's part for a choice: the production profile at the revision shown, or the override (nothing for the run's own configuration). */
export function choiceRequest(c: TakeChoice, production: VoiceProductionView): Pick<RegenerateVoiceInput, 'configuration' | 'override' | 'selectionRevision'> {
  if (c.base === 'PRODUCTION') return { configuration: 'PRODUCTION', selectionRevision: production.revision };
  if (c.base === 'OVERRIDE' && !isEmptyOverrides(c.override)) return { override: pruneOverrides(c.override) };
  return {};
}

/** Why a choice cannot be sent yet (null when it can). */
export function choiceProblem(c: TakeChoice, context: Pick<ChunkContext, 'run' | 'production' | 'settings'>): string | null {
  if (c.base === 'PRODUCTION') return productionRefusal(context.run.configuration.effective, context.production);
  if (c.base !== 'OVERRIDE') return null;
  if (isEmptyOverrides(c.override)) return 'Tick at least one setting to override';
  return overrideProblems(c.override, context.settings, 'TAKE')[0] ?? null;
}

/**
 * What new takes are made with: the run's configuration, the production
 * profile now (refused with its reason when the run's chunks cannot take
 * it; what differs from the run is said), or a temporary override kept with
 * the takes only.
 */
export function TakeChoiceFields({ context, value, onChange, fields, name }: { context: Pick<ChunkContext, 'run' | 'production' | 'settings'>; value: TakeChoice; onChange: (c: TakeChoice) => void; fields: readonly OverrideField[]; name: string }) {
  const { run, production } = context;
  const refusal = productionRefusal(run.configuration.effective, production);
  const differs = !refusal && production.effective ? configDifferences(run.configuration.effective, { ...production.effective, chunking: run.configuration.effective.chunking }) : [];
  const label = production.profile ? profileLabel({ name: production.profile.name, version: production.profile.version, familyName: production.family?.name ?? null }) : 'none yet';
  return (
    <fieldset className="min-w-0 space-y-1 text-sm" data-take-choice>
      <legend className="text-xs text-stone-500">Made with</legend>
      <label className="flex min-h-6 items-center gap-2">
        <input type="radio" name={name} checked={value.base === 'RUN'} onChange={() => onChange({ ...value, base: 'RUN' })} /> This run's configuration
      </label>
      <label className={`flex min-h-6 items-start gap-2 ${refusal ? 'text-stone-500' : ''}`}>
        <input type="radio" name={name} className="mt-1" disabled={!!refusal} checked={value.base === 'PRODUCTION'} onChange={() => onChange({ ...value, base: 'PRODUCTION' })} />
        <span className="min-w-0">
          The production profile now: {label}
          {refusal ? (
            <span className="block text-xs text-red-700">{refusal}</span>
          ) : (
            <span className="block text-xs break-words text-stone-500">{differs.length ? `differs from the run: ${differs.join('; ')}` : "the same as this run's configuration"}</span>
          )}
        </span>
      </label>
      <label className="flex min-h-6 items-center gap-2">
        <input type="radio" name={name} checked={value.base === 'OVERRIDE'} onChange={() => onChange({ ...value, base: 'OVERRIDE' })} /> A temporary override
      </label>
      {value.base === 'OVERRIDE' && <OverridesEditor base={run.configuration.effective} value={value.override} onChange={(override) => onChange({ ...value, override })} settings={context.settings} scope="TAKE" fields={fields} />}
      {value.base === 'OVERRIDE' && <p className="text-xs text-stone-500">The override is kept with the new take only; the profile is not changed.</p>}
      {value.base === 'PRODUCTION' && <p className="text-xs text-stone-500">The take records the production profile it was made with; the chunk is still this run's, and no profile is changed.</p>}
    </fieldset>
  );
}

/** Takes that still need attention: in progress, failed, or an A/B take not chosen yet. */
const OPEN = new Set<VoiceGenerationStatus>(['PENDING', 'GENERATING', 'FAILED', 'GENERATED']);
const TAKE_FIELDS: OverrideField[] = ['strategy', 'context', 'numberStyle', 'rules', 'settings'];

/**
 * One chunk and its takes: takes newer than the current one that still need
 * attention (in progress, failed, an A/B take to choose) above it; every
 * other take folded below. "Regenerate" makes a take with the run's
 * configuration; "Regenerate with…" with the production profile or a
 * temporary override, and a director's directions.
 */
export function ChunkCard({ chunk, context, canGenerate, selected, onSelect }: { chunk: VoiceChunkView; context: ChunkContext; canGenerate: boolean; selected?: boolean; onSelect?: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [direct, setDirect] = useState(false);
  const [choice, setChoice] = useState<TakeChoice>(RUN_CHOICE);
  const [directions, setDirections] = useState('');
  const [note, setNote] = useState('');
  const decide = useVoiceRequest(({ id, action }: { id: string; action: 'APPROVE' | 'REJECT' | 'RESTORE' }) => api.decideTake(id, { action }));
  const regenerate = useVoiceRequest(
    (args: { marks?: DirectorMark[]; choice?: TakeChoice } | undefined) =>
      api.regenerateVoice(context.run.id, {
        chunkIds: [chunk.id],
        ...(args?.choice ? choiceRequest(args.choice, context.production) : {}),
        ...(args?.marks?.length ? { marks: args.marks } : {}),
        ...(args?.choice && note.trim() ? { note: note.trim() } : {}),
      }),
    () => {
      setDirect(false);
      setChoice(RUN_CHOICE);
      setDirections('');
      setNote('');
    },
  );
  const take = chunk.current;
  const latest = chunk.generations[0] ?? null;
  const newer = take ? chunk.generations.filter((g) => g.generation > take.generation && OPEN.has(g.status)) : latest ? [latest] : [];
  const older = chunk.generations.filter((g) => g.id !== take?.id && !newer.some((x) => x.id === g.id));
  const which = older.every((g) => !take || g.generation < take.generation) ? 'earlier' : 'other';
  const working = newer.find((g) => g.status === 'PENDING' || g.status === 'GENERATING');
  const sentences = sentenceSpans(chunk.text).length;
  const parsed = directions.trim() ? parseDirections(directions, sentences) : [];
  const problem = choiceProblem(choice, context);
  const error = decide.error ?? regenerate.error;
  const onDecide = (id: string, action: 'APPROVE' | 'REJECT' | 'RESTORE') => decide.mutate({ id, action });
  return (
    <article className="rounded-lg border border-stone-200 bg-white p-3" data-chunk={chunk.index + 1}>
      <header className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span className="font-semibold text-stone-800">#{chunk.index + 1}</span>
        <span>
          {chunk.sectionKey}
          {chunk.sectionTitle ? ` · ${chunk.sectionTitle}` : ''}
        </span>
        <span>
          block{chunk.blockKeys.length > 1 ? 's' : ''} {chunk.blockKeys.join(', ')}
        </span>
        <span>{chunk.words} words</span>
        <span title="Why the chunk ends here">ends at {CHUNK_BOUNDARY_LABELS[chunk.boundary]}</span>
        {chunk.performance.emotion !== 'NEUTRAL' && <span className={`${pill} bg-violet-50 text-violet-800`}>{DELIVERY_EMOTION_LABELS[chunk.performance.emotion]}</span>}
        {chunk.stale && <span className={`${pill} bg-red-100 text-red-800`}>script changed</span>}
        {take ? <TakeStatus status={take.status} /> : latest ? <TakeStatus status={latest.status} /> : <span className={`${pill} bg-stone-100 text-stone-600`}>Not generated yet</span>}
        {take && working && <span className={`${pill} bg-sky-100 text-sky-800`}>take {working.generation} {VOICE_GENERATION_STATUS_LABELS[working.status].toLowerCase()}</span>}
        {onSelect && (
          <label className="ml-auto inline-flex min-h-6 items-center gap-1 text-stone-700">
            <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select chunk ${chunk.index + 1}`} /> Select
          </label>
        )}
      </header>
      <NumberedText text={chunk.text} className="mt-2 text-sm text-stone-900" />
      {newer.length > 0 && (
        <div className="mt-2 space-y-2">
          {newer.map((g) => (
            <TakeLine key={g.id} take={g} chunk={chunk} context={context} newer={!!take} busy={decide.isPending} onDecide={onDecide} />
          ))}
        </div>
      )}
      {take && (
        <div className="mt-2">
          <TakeLine take={take} chunk={chunk} context={context} busy={decide.isPending} onDecide={onDecide} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canGenerate && (
          <button disabled={regenerate.isPending} onClick={() => regenerate.mutate(undefined)} className={secondary}>
            Regenerate
          </button>
        )}
        {canGenerate && (
          <button onClick={() => setDirect((x) => !x)} aria-expanded={direct} className={link}>
            {direct ? 'Cancel' : 'Regenerate with…'}
          </button>
        )}
        {older.length > 0 && (
          <button onClick={() => setOpen((x) => !x)} aria-expanded={open} className={link}>
            {open ? `Hide ${which} takes` : `Compare ${older.length} ${which} take${older.length > 1 ? 's' : ''}`}
          </button>
        )}
      </div>
      {direct && (
        <div className="mt-2 space-y-2 rounded-md border border-stone-200 p-2">
          <TakeChoiceFields context={context} value={choice} onChange={setChoice} fields={TAKE_FIELDS} name={`made-with-${chunk.id}`} />
          <label className="block text-xs text-stone-600" htmlFor={`dir-${chunk.id}`}>
            Directions (optional), one line per direction, by the sentence numbers above: <span className="font-mono">sentence: emotion, delivery</span> — e.g. <span className="font-mono">2: curious</span> or <span className="font-mono">3: quiet, deliberate</span>. Plain words only; they add to the house style, they do not replace it.
          </label>
          <textarea id={`dir-${chunk.id}`} value={directions} onChange={(e) => setDirections(e.target.value)} rows={2} className="w-full rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
          {parsed === null && <p className="text-xs text-red-700">Write each line as "sentence: emotion" or "sentence: emotion, delivery": a sentence number from 1 to {sentences}, once each, and plain words of 2–30 letters.</p>}
          <label className="block text-xs text-stone-600">
            Note (kept with the take, e.g. why, or which experiment arm)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1 text-xs" />
          </label>
          {problem && choice.base !== 'PRODUCTION' && <p className="text-xs text-red-700">{problem}</p>}
          <button disabled={parsed === null || !!problem || regenerate.isPending} onClick={() => regenerate.mutate({ marks: parsed ?? [], choice })} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
            Generate the new take
          </button>
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          {older.map((g) => (
            <TakeLine key={g.id} take={g} chunk={chunk} context={context} busy={decide.isPending} onDecide={onDecide} />
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error.message}</p>}
    </article>
  );
}
