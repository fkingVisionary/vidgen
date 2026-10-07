import { SCRIPT_BLOCK_CLASS_LABELS, TIMING_RELATION_HELP, VISUAL_TREATMENT_LABELS, VISUAL_TREATMENT_TONES, VOICE_GENERATION_STATUS_LABELS, type StoryboardVersionView } from '@docengine/core';
import { useState, type ReactNode } from 'react';
import { CLASS_BAR, RELATION_MARK, TONE_BAR, ZOOM_LEVELS, byTime, clock, defaultZoom, laneBox, laneWidth, rangeText, relationText, rulerTicks, secondsText } from '../storyboard-plan.ts';
import { ReviewBadge, TreatmentBadge } from './storyboard.tsx';
import { pill, secondary } from './ui.ts';

/**
 * The Timeline tab: lanes on the narration clock — the audio (blocks,
 * sentence and pause cut points, silences, the takes heard, a playhead),
 * the visual beats, the shots (with lead-ins, tail-outs and bridges drawn),
 * a labelled treatment lane and the information class of each shot. The
 * lanes scroll inside their own box at a chosen px per second; on a phone
 * the same plan reads as a list in time order.
 */
export function TimelineTab({ version: v, onOpenShot }: { version: StoryboardVersionView; onOpenShot: (key: string) => void }) {
  const total = v.narrationLane.totalDurationMs || v.runtimeMs || 0;
  const [zoom, setZoom] = useState<number>(() => defaultZoom(total));
  const [take, setTake] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const width = laneWidth(total, zoom);
  const shots = byTime(v.shots);
  const box = (startMs: number, endMs: number) => {
    const b = laneBox(startMs, endMs, zoom);
    return { left: `${b.left}px`, width: `${b.width}px` };
  };
  const heard = v.narrationLane.takes.find((t) => t.generationId === take) ?? null;
  const zoomAt = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        The clock is the narration's real audio ({clock(total)}): every cut sits on a cut point between words or in a silence, and the pictures cover the clock with no gap. Lead-ins (◂) start a picture under the previous shot's last words; tail-outs (▸) hold it over the next shot's first; bridges (⇄) cross a beat or section, or fill a silence.
      </p>
      <div className="hidden flex-wrap items-center gap-2 text-sm sm:flex">
        <span className="text-xs text-stone-500">Zoom</span>
        <button type="button" aria-label="Zoom out" disabled={zoomAt <= 0} onClick={() => setZoom(ZOOM_LEVELS[zoomAt - 1]!)} className={secondary}>
          −
        </button>
        <span className="text-xs tabular-nums text-stone-600" data-zoom={zoom}>
          {zoom} px a second
        </span>
        <button type="button" aria-label="Zoom in" disabled={zoomAt >= ZOOM_LEVELS.length - 1} onClick={() => setZoom(ZOOM_LEVELS[zoomAt + 1]!)} className={secondary}>
          +
        </button>
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-stone-200 bg-white sm:block" data-timeline>
        <div className="relative py-2" style={{ width: `${width + 16}px` }}>
          <div className="relative mx-2" style={{ width: `${width}px` }}>
            {playhead !== null && <div className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-red-500" style={{ left: `${(playhead / 1000) * zoom}px` }} data-playhead />}
            <Lane label="Time" height="h-5">
              {rulerTicks(total, zoom).map((t) => (
                <span key={t.atMs} className="absolute top-0 border-l border-stone-300 pl-0.5 text-[10px] text-stone-500 tabular-nums" style={{ left: `${(t.atMs / 1000) * zoom}px` }}>
                  {t.label}
                </span>
              ))}
            </Lane>
            <Lane label="Narration (blocks, cut points, silences)">
              {v.narrationLane.blocks.map((b) => (
                <div key={b.id} className={`absolute top-0 h-full overflow-hidden rounded-sm border px-1 text-[10px] leading-8 whitespace-nowrap ${CLASS_BAR[b.infoClass]}`} style={box(b.startMs, b.endMs)} title={`${b.key} · ${SCRIPT_BLOCK_CLASS_LABELS[b.infoClass]} · ${rangeText(b.startMs, b.endMs)}: ${b.text}`} data-lane-block={b.key}>
                  {b.key}
                </div>
              ))}
              {v.narrationLane.silences.map((s, i) => (
                <div key={i} className="absolute top-0 h-full bg-stone-900/15" style={box(s.startMs, s.endMs)} title={`Silence ${secondsText(s.endMs - s.startMs)}`} />
              ))}
              {v.cutPoints.map((p) => (
                <div key={p.id} className={`absolute bottom-0 w-px ${p.kind === 'SENTENCE' || p.kind === 'BLOCK' || p.kind === 'SECTION' ? 'h-full bg-stone-700' : 'h-1/2 bg-stone-400'}`} style={{ left: `${(p.atMs / 1000) * zoom}px` }} title={`${p.id} (${p.kind.toLowerCase()}${p.midSentence ? ', inside a sentence' : ''})`} />
              ))}
            </Lane>
            <Lane label="Visual beats">
              {v.beats.map((b) => (
                <div key={b.id} className={`absolute top-0 h-full overflow-hidden rounded-sm border px-1 text-[10px] leading-8 whitespace-nowrap ${TONE_BAR[VISUAL_TREATMENT_TONES[b.treatment]]}`} style={box(b.startMs, b.endMs)} title={`${b.key} · ${b.content.title} · ${rangeText(b.startMs, b.endMs)}`} data-lane-beat={b.key}>
                  {b.key} {b.content.title}
                </div>
              ))}
            </Lane>
            <Lane label="Shots">
              {shots.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenShot(s.key)}
                  className="absolute top-0 h-full overflow-hidden rounded-sm border border-stone-500 bg-white px-1 text-left text-[10px] leading-8 whitespace-nowrap hover:bg-stone-100"
                  style={box(s.startMs, s.endMs)}
                  title={`${s.key} · ${rangeText(s.startMs, s.endMs)} · ${relationText(s)} — open the shot`}
                  data-lane-shot={s.key}
                >
                  {s.timing.leadInMs > 0 && <span className="absolute top-0 left-0 h-full bg-sky-200/70" style={{ width: `${(s.timing.leadInMs / 1000) * zoom}px` }} />}
                  {s.timing.tailOutMs > 0 && <span className="absolute top-0 right-0 h-full bg-sky-200/70" style={{ width: `${(s.timing.tailOutMs / 1000) * zoom}px` }} />}
                  <span className="relative">
                    {RELATION_MARK[s.relation]}
                    {s.key}
                  </span>
                </button>
              ))}
            </Lane>
            <Lane label="Treatment">
              {shots.map((s) => (
                <div key={s.id} className={`absolute top-0 h-full overflow-hidden rounded-sm border px-1 text-[10px] leading-8 whitespace-nowrap ${s.treatment ? TONE_BAR[VISUAL_TREATMENT_TONES[s.treatment]] : 'border-red-500 bg-red-100 text-red-900'}`} style={box(s.startMs, s.endMs)} title={s.treatment ? VISUAL_TREATMENT_LABELS[s.treatment] : 'Not planned'} data-lane-treatment={s.key}>
                  {s.treatment ? VISUAL_TREATMENT_LABELS[s.treatment] : 'Not planned'}
                </div>
              ))}
            </Lane>
            <Lane label="Information class">
              {shots.map((s) => (
                <div key={s.id} className={`absolute top-0 h-full overflow-hidden rounded-sm border px-1 text-[10px] leading-8 whitespace-nowrap ${s.infoClass ? CLASS_BAR[s.infoClass] : 'border-red-500 bg-red-100 text-red-900'}`} style={box(s.startMs, s.endMs)} title={s.infoClass ? SCRIPT_BLOCK_CLASS_LABELS[s.infoClass] : 'No class'}>
                  {s.infoClass ? SCRIPT_BLOCK_CLASS_LABELS[s.infoClass] : 'No class'}
                </div>
              ))}
            </Lane>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600" data-takes>
        <span>Takes heard:</span>
        {v.narrationLane.takes.map((t) => (
          <button key={t.generationId} type="button" disabled={!t.audioUrl} onClick={() => setTake(t.generationId)} aria-pressed={take === t.generationId} className={`${secondary} text-xs`} title={`${rangeText(t.startMs, t.endMs)} · ${VOICE_GENERATION_STATUS_LABELS[t.status]}`}>
            #{t.chunkIndex + 1} {clock(t.startMs)}
            {t.status !== 'APPROVED' && <span className="ml-1 text-amber-800">({VOICE_GENERATION_STATUS_LABELS[t.status].toLowerCase()})</span>}
          </button>
        ))}
      </div>
      {heard?.audioUrl && (
        <audio
          key={heard.generationId}
          controls
          preload="none"
          src={heard.audioUrl}
          aria-label={`Take of chunk ${heard.chunkIndex + 1}`}
          className="h-9 w-full max-w-md"
          onTimeUpdate={(e) => setPlayhead(heard.startMs + e.currentTarget.currentTime * 1000)}
          onEnded={() => setPlayhead(null)}
        />
      )}
      <ol className="space-y-2 sm:hidden" data-timeline-list>
        {shots.map((s) => (
          <li key={s.id} className="rounded-md border border-stone-200 bg-white p-2 text-xs" data-list-shot={s.key}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono tabular-nums text-stone-500">{rangeText(s.startMs, s.endMs)}</span>
              <span className="font-semibold text-stone-900">{s.key}</span>
              <TreatmentBadge treatment={s.treatment} />
              {s.infoClass && <span className={`${pill} border ${CLASS_BAR[s.infoClass]}`}>{SCRIPT_BLOCK_CLASS_LABELS[s.infoClass]}</span>}
              <ReviewBadge review={s.review} />
            </div>
            <p className="mt-1 text-stone-600" title={TIMING_RELATION_HELP[s.relation]}>
              {s.beatKey} · {relationText(s)}
            </p>
            {s.narration.text && <p className="mt-1 break-words text-stone-800">“{s.narration.text}”</p>}
            <button type="button" onClick={() => onOpenShot(s.key)} className="mt-1 inline-flex min-h-6 items-center text-xs text-stone-600 underline">
              Open {s.key}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Lane({ label, children, height = 'h-8' }: { label: string; children: ReactNode; height?: string }) {
  return (
    <div className="mt-1">
      <div className="sticky left-0 w-max text-[10px] font-semibold tracking-wide text-stone-500 uppercase">{label}</div>
      <div className={`relative ${height}`}>{children}</div>
    </div>
  );
}
