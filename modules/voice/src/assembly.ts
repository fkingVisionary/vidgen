import { SCRIPT_TIMING, type AssemblyEntry, type ChunkBoundary, type ChunkPauses, type ChunkSpan, type NarrationAlignment, type NarrationTimelineEntry, type PauseLength, type ScriptDelivery, type ScriptVisual, type VoiceQaFinding } from '@docengine/core';

/**
 * Assembled narration: a run's current takes in order on one clock, with the
 * pauses between them, and the narration timeline the storyboard will be
 * timed against. Durations are the takes' measured durations; the 150 words
 * a minute of the script stage is only a planning estimate and plays no part
 * here.
 *
 * The pause between two takes is what the script asks for there (a
 * paragraph's breath, a scripted pause, a section change) minus the silence
 * already at the end of one clip and the start of the next (from their
 * timestamps), never below zero.
 */

export interface AssemblyChunk {
  id: string;
  index: number;
  sectionKey: string;
  blockKeys: string[];
  spans: ChunkSpan[];
  text: string;
  boundary: ChunkBoundary;
  pauses: ChunkPauses;
  take: { id: string; generation: number; durationMs: number; alignment: NarrationAlignment | null; audioAssetId?: string } | null;
}

export interface AssemblyBlock {
  id: string;
  key: string;
  delivery: ScriptDelivery;
  visual: ScriptVisual;
}

/** Breath between takes, by why the first one ends (ms). */
export const BETWEEN_TAKES_MS: Record<ChunkBoundary, number> = { SENTENCE: 300, PARAGRAPH: 450, PERFORMANCE: 450, PAUSE: 450, SPEAKER: 450, PURPOSE: 450, SECTION_END: 1000 };

const RANK: Record<PauseLength, number> = { NONE: 0, MICRO: 1, SHORT: 2, MEDIUM: 3, LONG: 4 };

/** The silence wanted between two takes (before subtracting what the clips already hold). */
export function pauseBetween(a: AssemblyChunk, b: AssemblyChunk): number {
  const pause = RANK[a.pauses.after] >= RANK[b.pauses.before] ? a.pauses.after : b.pauses.before;
  const scripted = Math.round(SCRIPT_TIMING.pauseSec[pause] * 1000);
  const base = a.sectionKey !== b.sectionKey ? BETWEEN_TAKES_MS.SECTION_END : BETWEEN_TAKES_MS[a.boundary];
  return Math.max(base, scripted);
}

const leading = (t: AssemblyChunk['take']) => (t?.alignment?.words.length ? t.alignment.words[0]!.startMs : 0);
const trailing = (t: AssemblyChunk['take']) => (t?.alignment?.words.length ? Math.max(0, t.durationMs - t.alignment.words.at(-1)!.endMs) : 0);

export interface AssemblyResult {
  entries: AssemblyEntry[];
  timeline: NarrationTimelineEntry[];
  totalDurationMs: number;
  findings: VoiceQaFinding[];
}

export function assemble(chunks: readonly AssemblyChunk[], blocks: ReadonlyMap<string, AssemblyBlock>): AssemblyResult {
  const findings: VoiceQaFinding[] = [];
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  // Duplicates and gaps in the chunk order.
  const seen = new Set<number>();
  for (const c of sorted) {
    if (seen.has(c.index)) findings.push({ kind: 'DUPLICATE_CHUNK', severity: 'BLOCKING', ref: `#${c.index + 1}`, detail: `Chunk ${c.index + 1} appears more than once` });
    seen.add(c.index);
  }
  const max = sorted.at(-1)?.index ?? -1;
  for (let i = 0; i <= max; i++) if (!seen.has(i)) findings.push({ kind: 'MISSING_CHUNK', severity: 'BLOCKING', ref: `#${i + 1}`, detail: `Chunk ${i + 1} is missing from the assembly` });
  const takeIds = new Set<string>();
  for (const c of sorted) {
    if (c.take && takeIds.has(c.take.id)) findings.push({ kind: 'DUPLICATE_CHUNK', severity: 'BLOCKING', ref: `#${c.index + 1}`, detail: `Take ${c.take.id} is used twice` });
    if (c.take) takeIds.add(c.take.id);
  }
  // The same words in two chunks would be heard twice.
  sorted.forEach((c, i) => {
    const earlier = sorted.slice(0, i).find((p) => p.index !== c.index && p.spans.some((a) => c.spans.some((b) => a.blockKey === b.blockKey && a.start < b.end && b.start < a.end)));
    if (earlier) findings.push({ kind: 'DUPLICATE_CHUNK', severity: 'BLOCKING', ref: `#${c.index + 1}`, detail: `Chunk ${c.index + 1} narrates words chunk ${earlier.index + 1} already does` });
  });

  const entries: AssemblyEntry[] = [];
  const timeline: NarrationTimelineEntry[] = [];
  let clock = 0;
  const usable = sorted.filter((c, i) => sorted.findIndex((x) => x.index === c.index) === i && c.take);
  usable.forEach((c, i) => {
    const take = c.take!;
    const next = usable[i + 1];
    const gap = next ? Math.max(0, pauseBetween(c, next) - trailing(take) - leading(next.take)) : 0;
    entries.push({ chunkId: c.id, chunkIndex: c.index, generationId: take.id, generation: take.generation, ...(take.audioAssetId ? { audioAssetId: take.audioAssetId } : {}), sectionKey: c.sectionKey, blockKeys: c.blockKeys, startMs: clock, endMs: clock + take.durationMs, gapAfterMs: gap });
    timeline.push(...timelineParts(c, clock, blocks));
    clock += take.durationMs + gap;
  });
  return { entries, timeline, totalDurationMs: clock, findings };
}

/** The chunk's parts, one per script block, on the assembled clock. */
function timelineParts(c: AssemblyChunk, offset: number, blocks: ReadonlyMap<string, AssemblyBlock>): NarrationTimelineEntry[] {
  const take = c.take!;
  const out: NarrationTimelineEntry[] = [];
  let at = 0;
  for (const span of c.spans) {
    const length = span.end - span.start;
    const range = { start: at, end: at + length };
    at += length + 1; // blocks are separated by one line break in the chunk text
    const block = blocks.get(span.blockKey);
    const words = (take.alignment?.words ?? []).filter((w) => w.start >= range.start && w.end <= range.end).map((w) => ({ word: w.word, startMs: offset + w.startMs, endMs: offset + w.endMs }));
    const startMs = words.length ? words[0]!.startMs : offset + (c.spans.length === 1 ? 0 : Math.round((range.start / c.text.length) * take.durationMs));
    const endMs = words.length ? words.at(-1)!.endMs : offset + (c.spans.length === 1 ? take.durationMs : Math.round((range.end / c.text.length) * take.durationMs));
    out.push({
      scriptBlock: { id: span.blockId, key: span.blockKey, sectionKey: c.sectionKey },
      audioChunk: { id: c.id, index: c.index, generationId: take.id, generation: take.generation, ...(take.audioAssetId ? { audioAssetId: take.audioAssetId } : {}) },
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      text: c.text.slice(range.start, range.end),
      words,
      performance: { pace: block?.delivery.pace ?? 'NORMAL', energy: block?.delivery.energy ?? 'MEDIUM', emotion: block?.delivery.emotion ?? 'NEUTRAL' },
      visualHints: block ? { intent: block.visual.intent, priority: block.visual.priority, mustShow: block.visual.mustShow.map((m) => m.detail), fictional: block.visual.fictional } : { intent: 'NONE', priority: 'NORMAL', mustShow: [], fictional: false },
    });
  }
  return out;
}

/** Clips of the joined file further than this from where the entries put them are reported. */
export const DRIFT_TOLERANCE_MS = 50;

/**
 * Where the joined file actually starts each clip against the entries'
 * clock (the timeline's): a clip off by more than the tolerance means the
 * words are heard away from their timestamps. The first such clip is
 * reported (the drift only grows after it).
 */
export function clipDrift(entries: readonly Pick<AssemblyEntry, 'chunkIndex' | 'startMs'>[], startsMs: readonly number[]): VoiceQaFinding | null {
  const i = entries.findIndex((e, k) => startsMs[k] === undefined || Math.abs(startsMs[k]! - e.startMs) > DRIFT_TOLERANCE_MS);
  if (i < 0) return null;
  const e = entries[i]!;
  const at = startsMs[i];
  return {
    kind: 'ASSEMBLY_MISMATCH',
    severity: 'WARNING',
    ref: `#${e.chunkIndex + 1}`,
    detail: at === undefined ? `The joined file has ${startsMs.length} clip(s) for ${entries.length} entries` : `The joined file starts chunk ${e.chunkIndex + 1} at ${formatClock(at)}, the timeline at ${formatClock(e.startMs)} (${Math.abs(at - e.startMs)} ms apart): words are heard off their timestamps`,
  };
}

/** What is being said at a moment of the assembled narration (and what comes just before and after). */
export function whatIsSaidAt<T extends NarrationTimelineEntry>(timeline: readonly T[], ms: number): { entry: T; word: { word: string; startMs: number; endMs: number } | null; between: boolean } | null {
  if (!timeline.length) return null;
  const inside = timeline.find((e) => ms >= e.startMs && ms < e.endMs);
  const entry = inside ?? timeline.reduce((best, e) => (Math.abs(e.startMs - ms) < Math.abs(best.startMs - ms) ? e : best));
  const word = entry.words.find((w) => ms >= w.startMs && ms < w.endMs) ?? entry.words.find((w) => w.startMs >= ms) ?? null;
  return { entry, word, between: !inside };
}

/** "02:43" or "2:43.5" → milliseconds. */
export function parseClock(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const min = Number(m[1] ?? 0);
  const sec = Number(m[2]);
  if (sec >= 60 && m[1] !== undefined) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
  return (min * 60 + sec) * 1000 + frac;
}

export const formatClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
