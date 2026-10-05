import {
  CHUNK_BOUNDARY_LABELS,
  DELIVERY_EMOTION_LABELS,
  VOICE_GENERATION_STATUS_LABELS,
  type DirectorMark,
  type VoiceChunkView,
  type VoiceGenerationStatus,
  type VoiceGenerationView,
  type VoiceQaFinding,
} from '@docengine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { formatUsd } from '../format.ts';

export const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
export const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
export const secondary = `${button} bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50`;

export const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

const STATUS_TONE: Record<VoiceGenerationStatus, string> = {
  PENDING: 'bg-stone-100 text-stone-600',
  GENERATING: 'bg-sky-100 text-sky-800',
  GENERATED: 'bg-violet-100 text-violet-800',
  FAILED: 'bg-red-100 text-red-800',
  REJECTED: 'bg-red-600 text-white',
  APPROVED: 'bg-emerald-600 text-white',
  SUPERSEDED: 'bg-stone-200 text-stone-600',
};

export function TakeStatus({ status }: { status: VoiceGenerationStatus }) {
  return <span className={`${pill} ${STATUS_TONE[status]}`}>{VOICE_GENERATION_STATUS_LABELS[status]}</span>;
}

/** Invalidate the voice view and the project after a change. */
export function useVoiceRequest<T, R = unknown>(fn: (arg: T) => Promise<R>, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation<R, Error, T>({
    mutationFn: fn,
    onSuccess: () => onDone?.(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
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

function TakeLine({ take, chunk, busy, onDecide }: { take: VoiceGenerationView; chunk: VoiceChunkView; busy: boolean; onDecide: (id: string, action: 'APPROVE' | 'REJECT' | 'RESTORE') => void }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className={`rounded-md border p-2 ${take.current ? 'border-stone-300 bg-white' : 'border-stone-200 bg-stone-50'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <span className="font-semibold text-stone-800">Take {take.generation}</span>
        <TakeStatus status={take.status} />
        {take.current && <span className={`${pill} bg-stone-900 text-white`}>current</span>}
        {take.mock && <span className={`${pill} bg-amber-100 text-amber-900`}>MOCK</span>}
        <span>{seconds(take.durationMs)}</span>
        <span>{take.strategy.toLowerCase()}</span>
        {take.characters !== null && <span>{take.characters} chars</span>}
        {take.cost && <span title={take.cost.note ?? ''}>{take.cost.actualUsd !== null ? formatUsd(take.cost.actualUsd) : take.cost.estimatedUsd !== null ? `~${formatUsd(take.cost.estimatedUsd)}` : 'unpriced'} ({(take.cost.basis ?? '').toLowerCase()})</span>}
        <span className="truncate" title={`${take.provider} · ${take.model} · voice ${take.voiceId} · ${take.profile.name} v${take.profile.version}`}>
          {take.model} · {take.profile.name} v{take.profile.version}
        </span>
      </div>
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
      <div className="mt-1 flex flex-wrap gap-2">
        {take.current && take.status === 'GENERATED' && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'APPROVE')} className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`}>
            Approve
          </button>
        )}
        {['GENERATED', 'APPROVED', 'SUPERSEDED'].includes(take.status) && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'REJECT')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
            Reject
          </button>
        )}
        {!take.current && take.audioUrl && (
          <button disabled={busy} onClick={() => onDecide(take.id, 'RESTORE')} className={secondary}>
            Use this take
          </button>
        )}
        {take.performanceText && (
          <button onClick={() => setShowText((x) => !x)} className="text-xs text-stone-600 underline">
            {showText ? 'Hide' : 'Show'} what was sent
          </button>
        )}
      </div>
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
        </div>
      )}
    </div>
  );
}

/** The director's directions for one sentence of a chunk, typed as "sentence: emotion, delivery". */
function parseDirections(text: string): DirectorMark[] | null {
  const marks: DirectorMark[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*:\s*([a-z][a-z \-']*)(?:,\s*([a-z][a-z \-']*))?$/.exec(line.toLowerCase());
    if (!m) return null;
    marks.push({ sentence: Number(m[1]) - 1, emotion: m[2]!.trim(), ...(m[3] ? { delivery: m[3].trim() } : {}) });
  }
  return marks;
}

export function ChunkCard({ chunk, runId, canGenerate }: { chunk: VoiceChunkView; runId: string; canGenerate: boolean }) {
  const [open, setOpen] = useState(false);
  const [direct, setDirect] = useState(false);
  const [directions, setDirections] = useState('');
  const decide = useVoiceRequest(({ id, action }: { id: string; action: 'APPROVE' | 'REJECT' | 'RESTORE' }) => api.decideTake(id, { action }));
  const regenerate = useVoiceRequest((marks: DirectorMark[] | undefined) => api.regenerateVoice(runId, { chunkIds: [chunk.id], ...(marks?.length ? { marks } : {}) }), () => setDirect(false));
  const take = chunk.current;
  const older = chunk.generations.filter((g) => !g.current);
  const parsed = directions.trim() ? parseDirections(directions) : [];
  const error = decide.error ?? regenerate.error;
  return (
    <article className="rounded-lg border border-stone-200 bg-white p-3">
      <header className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span className="font-semibold text-stone-800">#{chunk.index + 1}</span>
        <span>{chunk.sectionKey}{chunk.sectionTitle ? ` · ${chunk.sectionTitle}` : ''}</span>
        <span>block{chunk.blockKeys.length > 1 ? 's' : ''} {chunk.blockKeys.join(', ')}</span>
        <span>{chunk.words} words</span>
        <span title="Why the chunk ends here">ends at {CHUNK_BOUNDARY_LABELS[chunk.boundary]}</span>
        {chunk.performance.emotion !== 'NEUTRAL' && <span className={`${pill} bg-violet-50 text-violet-800`}>{DELIVERY_EMOTION_LABELS[chunk.performance.emotion]}</span>}
        {chunk.stale && <span className={`${pill} bg-red-100 text-red-800`}>script changed</span>}
        {take && <TakeStatus status={take.status} />}
      </header>
      <p className="mt-2 text-sm break-words whitespace-pre-wrap text-stone-900">{chunk.text}</p>
      <div className="mt-2">{take ? <TakeLine take={take} chunk={chunk} busy={decide.isPending} onDecide={(id, action) => decide.mutate({ id, action })} /> : <p className="text-xs text-stone-500">{chunk.generations[0]?.status === 'FAILED' ? 'No usable take yet.' : 'Not generated yet.'}</p>}</div>
      {!take && chunk.generations[0] && chunk.generations[0].error && <p className="mt-1 text-xs break-words text-red-800">{chunk.generations[0].error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canGenerate && (
          <button disabled={regenerate.isPending} onClick={() => regenerate.mutate(undefined)} className={secondary}>
            Regenerate
          </button>
        )}
        {canGenerate && (
          <button onClick={() => setDirect((x) => !x)} className="text-xs text-stone-600 underline">
            {direct ? 'Cancel directions' : 'Regenerate with directions'}
          </button>
        )}
        {older.length > 0 && (
          <button onClick={() => setOpen((x) => !x)} className="text-xs text-stone-600 underline">
            {open ? 'Hide' : `Compare ${older.length} earlier take${older.length > 1 ? 's' : ''}`}
          </button>
        )}
      </div>
      {direct && (
        <div className="mt-2 space-y-1">
          <label className="block text-xs text-stone-600" htmlFor={`dir-${chunk.id}`}>
            One line per direction: <span className="font-mono">sentence: emotion, delivery</span> — e.g. <span className="font-mono">2: curious</span> or <span className="font-mono">3: quiet, deliberate</span>. Plain words only.
          </label>
          <textarea id={`dir-${chunk.id}`} value={directions} onChange={(e) => setDirections(e.target.value)} rows={2} className="w-full rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
          {parsed === null && <p className="text-xs text-red-700">Write each line as "sentence: emotion" or "sentence: emotion, delivery".</p>}
          <button disabled={parsed === null || !parsed.length || regenerate.isPending} onClick={() => regenerate.mutate(parsed ?? undefined)} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
            Regenerate with these directions
          </button>
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          {older.map((g) => (
            <TakeLine key={g.id} take={g} chunk={chunk} busy={decide.isPending} onDecide={(id, action) => decide.mutate({ id, action })} />
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error.message}</p>}
    </article>
  );
}
