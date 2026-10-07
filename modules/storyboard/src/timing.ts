import { CUT_OFFSET_MAX_MS, SHOT_LIMITS, type AudioRef, type ShotTiming, type TimingRelation, type VisualTreatment } from '@docengine/core';
import { droppedNote, type DraftShot, type SpanRow, type StoryboardDraft } from './draft.ts';
import type { CutPoint, Spine, SpineWord } from './spine.ts';

/**
 * From cut points to times (§2.4). The visual track tiles the clock by
 * construction: each cut sits at the middle of its point's silence, a
 * silence-only shot occupies its point's silence, the first shot starts at
 * 0 and the last ends with the narration. A lead-in or tail-out is requested
 * by naming a cut point inside the neighbour's words; it is kept only within
 * a sentence or 2 s, when the neighbour keeps its minimum length and no
 * other cut is crossed. A person may nudge a cut by up to ±2 s within the
 * same limits. Every number is computed here; a refused request is dropped
 * and noted, never silently fixed.
 */

/** The shortest a shot of a treatment may be. */
export const minDurationMs = (treatment: VisualTreatment | null) => (treatment === 'TRANSITION' ? SHOT_LIMITS.transitionMinMs : SHOT_LIMITS.minMs);

/** Most a lead-in or tail-out may move a cut when it crosses more than one sentence. */
export const LEAD_MAX_MS = 2000;

export interface ShotGeometry {
  key: string;
  startMs: number;
  endMs: number;
  timing: ShotTiming;
  relation: TimingRelation;
  /** Narration positions [from, to) in the spine's words (null: silence-only). */
  from: number | null;
  to: number | null;
  /** The silence point of a silence-only shot. */
  silence: CutPoint | null;
  blocks: SpanRow[];
  /** Blocks whose words are heard while the shot is seen (its lead-in and tail-out included). */
  visualBlocks: string[];
  sceneId: string;
  sectionKey: string;
  narrationAnchor: string;
}

export interface BeatGeometry {
  key: string;
  startMs: number;
  endMs: number;
  from: number;
  to: number;
  blocks: SpanRow[];
  sceneId: string;
  sectionKey: string;
  sequence: number;
}

export interface TimingResult {
  shots: Map<string, ShotGeometry>;
  beats: Map<string, BeatGeometry>;
  /** Shots and beats whose anchors do not resolve on this narration (TIMING_MISSING), with why. */
  missing: Map<string, string>;
  /** Requests refused (dropped from the draft's anchors) and nudges reduced, one line each. */
  notes: string[];
  /** The anchors as kept: refused lead-ins and tail-outs removed, nudges as applied. */
  anchors: Map<string, Pick<DraftShot, 'visualFrom' | 'visualTo' | 'cutOffsetMs'>>;
}

interface Resolved {
  shot: DraftShot;
  order: number;
  from: CutPoint | null;
  to: CutPoint | null;
  silence: CutPoint | null;
}

const STRONG: ReadonlySet<string> = new Set(['SENTENCE', 'BLOCK', 'SECTION', 'SCOPE_EDGE']);

/** A cut point's id as a reader expects it ("1.1:0" for the start of the scope). */
export function displayId(p: CutPoint): string {
  return p.kind === 'SCOPE_EDGE' ? (p.aliases[0] ?? p.id) : p.id;
}

/** The positions [from, to) of a narration range on the spine, or why it does not resolve. */
export function rangeOf(spine: Spine, range: { from: string; to: string }): { from: CutPoint; to: CutPoint } | string {
  const from = spine.point(range.from);
  const to = spine.point(range.to);
  if (!from) return `the cut point ${range.from} is not in the narration`;
  if (!to) return `the cut point ${range.to} is not in the narration`;
  if (from.position >= to.position) return `its narration ends (${range.to}) before it starts (${range.from})`;
  return { from, to };
}

/**
 * Why a silence-only shot cannot sit at this point, or null: it belongs
 * where one shot's words end and the next one's begin (or at an edge of the
 * scope). Inside another shot's words it would cut that shot off before its
 * words end and show the next one early, an overlap no relation records.
 */
export function silenceInside(spine: Spine, point: CutPoint, shots: readonly Pick<DraftShot, 'key' | 'narration'>[]): string | null {
  for (const s of shots) {
    if (!s.narration) continue;
    const r = rangeOf(spine, s.narration);
    if (typeof r !== 'string' && r.from.position < point.position && point.position < r.to.position) return `its silence ${point.id} lies inside the words of ${s.key}`;
  }
  return null;
}

export function timeStoryboard(draft: Pick<StoryboardDraft, 'beats' | 'shots'>, spine: Spine): TimingResult {
  const missing = new Map<string, string>();
  const notes: string[] = [];
  const anchors = new Map<string, Pick<DraftShot, 'visualFrom' | 'visualTo' | 'cutOffsetMs'>>();
  const total = spine.totalDurationMs;

  const beatRanges = new Map<string, { from: CutPoint; to: CutPoint }>();
  for (const b of draft.beats) {
    const r = rangeOf(spine, b.narration);
    if (typeof r === 'string') missing.set(b.key, r);
    else beatRanges.set(b.key, r);
  }

  const resolved: Resolved[] = [];
  draft.shots.forEach((shot, order) => {
    anchors.set(shot.key, { visualFrom: shot.visualFrom, visualTo: shot.visualTo, cutOffsetMs: shot.cutOffsetMs });
    if (shot.narration) {
      const r = rangeOf(spine, shot.narration);
      if (typeof r === 'string') missing.set(shot.key, r);
      else resolved.push({ shot, order, from: r.from, to: r.to, silence: null });
    } else if (shot.silenceAt) {
      const p = spine.point(shot.silenceAt);
      const inside = p ? silenceInside(spine, p, draft.shots) : null;
      if (!p) missing.set(shot.key, `the cut point ${shot.silenceAt} is not in the narration`);
      else if (inside) missing.set(shot.key, inside);
      else resolved.push({ shot, order, from: null, to: null, silence: p });
    } else missing.set(shot.key, 'it has neither narration nor a silence');
  });
  const startPos = (r: Resolved) => (r.silence ? r.silence.position : r.from!.position);
  resolved.sort((a, b) => startPos(a) - startPos(b) || (a.silence ? 0 : 1) - (b.silence ? 0 : 1) || a.order - b.order);

  const n = resolved.length;
  // cuts[i]: the time between resolved[i] and resolved[i + 1].
  const defaults: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = resolved[i]!;
    const b = resolved[i + 1]!;
    if (b.silence) defaults.push(b.silence.silence.startMs);
    else if (a.silence) defaults.push(a.silence.silence.endMs);
    else defaults.push(a.to!.position === b.from!.position ? b.from!.atMs : Math.round((a.to!.atMs + b.from!.atMs) / 2));
  }
  const cuts = [...defaults];
  const startOf = (i: number) => (i === 0 ? 0 : cuts[i - 1]!);
  const endOf = (i: number) => (i === n - 1 ? total : cuts[i]!);
  const minOf = (i: number) => minDurationMs(resolved[i]!.shot.treatment);
  const withinShift = (q: CutPoint, p: CutPoint) => {
    if (Math.abs(p.atMs - q.atMs) <= LEAD_MAX_MS) return true;
    const [lo, hi] = q.position < p.position ? [q.position, p.position] : [p.position, q.position];
    return !spine.points.some((x) => x.position > lo && x.position < hi && STRONG.has(x.kind));
  };
  const drop = (r: Resolved, field: 'visualFrom' | 'visualTo', id: string, why: string) => {
    notes.push(droppedNote(r.shot.key, `${field === 'visualFrom' ? 'the lead-in from' : 'the tail-out to'} ${id}`, why));
    anchors.get(r.shot.key)![field] = null;
  };

  // Requests at the edges of the scope have no neighbour.
  if (n > 0) {
    const first = resolved[0]!;
    const last = resolved[n - 1]!;
    if (first.shot.visualFrom) drop(first, 'visualFrom', first.shot.visualFrom, 'the first shot has no shot before it');
    if (last.shot.visualTo) drop(last, 'visualTo', last.shot.visualTo, 'the last shot has no shot after it');
  }

  for (let i = 0; i + 1 < n; i++) {
    const a = resolved[i]!;
    const b = resolved[i + 1]!;
    const lead = b.shot.visualFrom;
    const tail = a.shot.visualTo;
    if ((lead || tail) && (a.silence || b.silence)) {
      if (lead) drop(b, 'visualFrom', lead, 'the cut is beside a silence-only shot');
      if (tail) drop(a, 'visualTo', tail, 'the cut is beside a silence-only shot');
      continue;
    }
    let leadKept = false;
    if (lead) {
      const q = spine.point(lead);
      const p = b.from!;
      const why = !q
        ? 'the cut point is not in the narration'
        : !(q.position > a.from!.position && q.position < p.position)
          ? `it is not inside the words of ${a.shot.key}`
          : !withinShift(q, p)
            ? 'it moves the cut by more than one sentence and 2 s'
            : q.atMs - startOf(i) < minOf(i)
              ? `${a.shot.key} would be shorter than its minimum`
              : null;
      if (why) drop(b, 'visualFrom', lead, why);
      else {
        cuts[i] = q!.atMs;
        anchors.get(b.shot.key)!.visualFrom = q!.id;
        leadKept = true;
      }
    }
    if (tail) {
      const q = spine.point(tail);
      const p = b.from!;
      const nextEnd = i + 2 < n ? cuts[i + 1]! : total;
      const why = leadKept
        ? `${b.shot.key} already leads in at this cut`
        : !q
          ? 'the cut point is not in the narration'
          : !(q.position > p.position && q.position < b.to!.position)
            ? `it is not inside the words of ${b.shot.key}`
            : !withinShift(q, p)
              ? 'it moves the cut by more than one sentence and 2 s'
              : nextEnd - q.atMs < minOf(i + 1)
                ? `${b.shot.key} would be shorter than its minimum`
                : null;
      if (why) drop(a, 'visualTo', tail, why);
      else {
        cuts[i] = q!.atMs;
        anchors.get(a.shot.key)!.visualTo = q!.id;
      }
    }
  }

  // A person's nudges, within ±2 s and the neighbours' minimum lengths.
  resolved.forEach((r, i) => {
    const offset = r.shot.cutOffsetMs;
    if (!offset) return;
    if (i === 0) {
      notes.push(`${r.shot.key}: the cut nudge of ${signed(offset)} ms was removed — the first shot starts with the narration`);
      anchors.get(r.shot.key)!.cutOffsetMs = 0;
      return;
    }
    const lo = startOf(i - 1) + minOf(i - 1);
    const hi = endOf(i) - minOf(i);
    const wanted = cuts[i - 1]! + Math.max(-CUT_OFFSET_MAX_MS, Math.min(CUT_OFFSET_MAX_MS, offset));
    const at = lo > hi ? cuts[i - 1]! : Math.max(lo, Math.min(hi, wanted));
    const applied = at - cuts[i - 1]!;
    if (applied !== offset) notes.push(`${r.shot.key}: the cut nudge of ${signed(offset)} ms was reduced to ${signed(applied)} ms — the shots beside it keep their minimum length and the cut stays within 2 s`);
    cuts[i - 1] = at;
    anchors.get(r.shot.key)!.cutOffsetMs = applied;
  });

  // Beats: their narration positions (and, below, their times).
  const beatOfPosition = (pos: number): string | null => {
    for (const [key, r] of beatRanges) if (pos >= r.from.position && pos < r.to.position) return key;
    return null;
  };
  const words = spine.words;
  const shots = new Map<string, ShotGeometry>();
  resolved.forEach((r, i) => {
    const startMs = startOf(i);
    const endMs = endOf(i);
    const defaultStart = i === 0 ? 0 : defaults[i - 1]!;
    const defaultEnd = i === n - 1 ? total : defaults[i]!;
    const from = r.from?.position ?? null;
    const to = r.to?.position ?? null;
    const narrated = from !== null && to !== null ? words.slice(from, to) : [];
    const timedWords = narrated.filter((w) => w.timed);
    const entries = spine.narration.entries;
    const narrationStartMs = narrated.length ? (timedWords[0]?.startMs ?? entries[narrated[0]!.entry]!.startMs) : null;
    const narrationEndMs = narrated.length ? (timedWords.at(-1)?.endMs ?? entries[narrated.at(-1)!.entry]!.endMs) : null;
    const seen = words.filter((w) => w.heard.startMs < endMs && w.heard.endMs > startMs);
    const visualBlocks = [...new Set([...narrated, ...seen].sort((x, y) => x.index - y.index).map((w) => w.blockKey))];
    const silent = r.silence !== null;
    const leadInMs = silent ? 0 : Math.max(0, defaultStart - startMs);
    const tailOutMs = silent ? 0 : Math.max(0, endMs - defaultEnd);
    const ownBeat = r.shot.beatKey;
    const sectionsHere = new Set([...narrated, ...seen].map((w) => spine.block(w.blockKey)!.sectionKey));
    const otherBeat = seen.some((w) => {
      const b = beatOfPosition(w.index);
      return b !== null && b !== ownBeat;
    });
    const span = [...narrated, ...seen].sort((x, y) => x.index - y.index);
    let bridge: ShotTiming['bridge'] = null;
    if (silent) {
      const p = r.silence!.position;
      bridge = { kind: 'SILENCE', fromBlockId: p > 0 ? words[p - 1]!.blockId : null, toBlockId: p < words.length ? words[p]!.blockId : null };
    } else if (sectionsHere.size > 1) bridge = { kind: 'SECTION', fromBlockId: span[0]!.blockId, toBlockId: span.at(-1)!.blockId };
    else if (otherBeat) bridge = { kind: 'BEAT', fromBlockId: span[0]!.blockId, toBlockId: span.at(-1)!.blockId };
    const relation: TimingRelation = bridge ? 'BRIDGE' : leadInMs > 0 ? 'LEAD_IN' : tailOutMs > 0 ? 'TAIL_OUT' : 'TIMED_TO_NARRATION';
    // The takes whose words are heard while the shot is seen.
    const heard = new Set([...narrated, ...seen].map((w) => w.entry));
    const audio: AudioRef[] = entries
      .filter((_e, i) => heard.has(i))
      .map((e) => ({ chunkId: e.chunkId, generationId: e.generationId, ...(e.audioAssetId ? { audioAssetId: e.audioAssetId } : {}) }));
    const kept = anchors.get(r.shot.key)!;
    const timing: ShotTiming = {
      narration: r.shot.narration ? { from: r.from!.id, to: r.to!.id } : null,
      narrationStartMs,
      narrationEndMs,
      leadInMs,
      tailOutMs,
      bridge,
      visualFrom: silent ? null : kept.visualFrom,
      visualTo: silent ? null : kept.visualTo,
      silenceAt: r.silence?.id ?? null,
      ...(kept.cutOffsetMs ? { cutOffsetMs: kept.cutOffsetMs } : {}),
      cutIn: r.shot.cutIn,
      cutOut: r.shot.cutOut,
      audio,
      unalignedTake: narrated.some((w) => spine.unalignedTakes.includes(w.takeId)),
    };
    const startWord = narrated[0] ?? (r.silence!.position > 0 ? words[r.silence!.position - 1] : words[0]);
    const startBlock = spine.block(startWord!.blockKey)!;
    shots.set(r.shot.key, {
      key: r.shot.key,
      startMs,
      endMs,
      timing,
      relation,
      from,
      to,
      silence: r.silence,
      blocks: spanRows(narrated, spine),
      visualBlocks,
      sceneId: startBlock.sceneId,
      sectionKey: startBlock.sectionKey,
      narrationAnchor: silent ? `silence at ${displayId(r.silence!)}` : `${displayId(r.from!)}–${displayId(r.to!)}`,
    });
  });

  const beats = new Map<string, BeatGeometry>();
  for (const b of draft.beats) {
    const range = beatRanges.get(b.key);
    if (!range) continue;
    const own = draft.shots.filter((s) => s.beatKey === b.key).map((s) => shots.get(s.key));
    if (own.length === 0 || own.some((g) => !g)) {
      if (!missing.has(b.key)) missing.set(b.key, own.length === 0 ? 'it has no shots' : 'a shot of it is not timed');
      continue;
    }
    const narrated = words.slice(range.from.position, range.to.position);
    const first = spine.block(narrated[0]!.blockKey)!;
    beats.set(b.key, {
      key: b.key,
      startMs: Math.min(...own.map((g) => g!.startMs)),
      endMs: Math.max(...own.map((g) => g!.endMs)),
      from: range.from.position,
      to: range.to.position,
      blocks: spanRows(narrated, spine),
      sceneId: first.sceneId,
      sectionKey: first.sectionKey,
      sequence: first.sequence,
    });
  }
  return { shots, beats, missing, notes, anchors };
}

/**
 * The words of a range, block by block: their first and last word and when
 * they are heard — from real audio only, so an edge word without a timestamp
 * widens the row to the nearest timed word or clip edge (never its
 * interpolated display time).
 */
export function spanRows(words: readonly SpineWord[], spine: Spine): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const w of words) {
    const last = rows.at(-1);
    if (last && last.blockKey === w.blockKey) {
      last.lastWord = w.word;
      last.endMs = w.heard.endMs;
      continue;
    }
    rows.push({ scriptBlockId: spine.block(w.blockKey)!.id, blockKey: w.blockKey, startMs: w.heard.startMs, endMs: w.heard.endMs, firstWord: w.word, lastWord: w.word });
  }
  return rows;
}

const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));
