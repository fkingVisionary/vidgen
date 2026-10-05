import {
  PAUSE_LENGTHS,
  type ChunkBoundary,
  type ChunkPauses,
  type ChunkPerformance,
  type ChunkSpan,
  type ChunkingSettings,
  type DeliveryEmotion,
  type DeliveryEnergy,
  type DeliveryPace,
  type PauseLength,
  type ScriptBlockClass,
  type ScriptDelivery,
} from '@docengine/core';
import { countWords, isQuestion, sentenceSpans } from './text.ts';

/**
 * Small-bite chunking. A script is never sent to a voice as one request: its
 * blocks are cut into chunks of natural speech — whole sentences of one
 * section, roughly a completed thought — small enough to regenerate on their
 * own, large enough to sound like one piece of speech.
 *
 * Deterministic: the cut points minimise a cost over every possible cut of a
 * section (dynamic programming), so the same script and settings always give
 * the same chunks, and every chunk says why it ends where it does.
 *
 * - Never inside a sentence, never across a section or a change of speaker.
 * - Preferred cuts: a paragraph (block) end, a scripted pause, a change in
 *   the script's delivery (pace, energy, emotion) — the stronger the change,
 *   the stronger the preference.
 * - Avoided cuts: between a question and its answer, a setup ("…", "—") and
 *   its payoff, before a very short sentence (usually a payoff), or before a
 *   sentence that continues the last ("And…", "But…").
 * - Size: chunks under the minimum or over the maximum cost more the further
 *   out they are; a fixed cost per chunk keeps a section from shattering into
 *   tiny clips just because the delivery shifts slightly.
 */

export interface ChunkBlock {
  id: string;
  key: string;
  text: string;
  delivery: ScriptDelivery;
  speakerId: string | null;
  infoClass: ScriptBlockClass;
  /** Position of the block in the whole script (blocks that are not adjacent are never joined). */
  order: number;
}

export interface ChunkSection {
  id: string;
  key: string;
  blocks: readonly ChunkBlock[];
}

/** A sentence of a chunk: its range in the chunk's text and the block it comes from. */
export interface ChunkSentence {
  start: number;
  end: number;
  blockKey: string;
}

export interface PlannedChunk {
  /** Order within the plan (0-based, across sections). */
  index: number;
  sectionId: string;
  sectionKey: string;
  spans: ChunkSpan[];
  /** The canonical text: the spans verbatim, blocks separated by a line break. */
  text: string;
  words: number;
  sentences: ChunkSentence[];
  boundary: ChunkBoundary;
  performance: ChunkPerformance;
}

interface Unit {
  block: ChunkBlock;
  start: number;
  end: number;
  text: string;
  words: number;
}

interface Gap {
  hard: boolean;
  cost: number;
  boundary: ChunkBoundary;
}

const RANK: Record<PauseLength, number> = Object.fromEntries(PAUSE_LENGTHS.map((p, i) => [p, i])) as Record<PauseLength, number>;
const longer = (a: PauseLength, b: PauseLength): PauseLength => (RANK[a] >= RANK[b] ? a : b);

/** Gap and size costs (tuned on narration; see the chunking tests). */
export const CHUNK_COSTS = {
  perChunk: 6,
  underMinPerWord: 1.5,
  overMaxPerWord: 3,
  /** Over max × this, a chunk of several sentences is not allowed at all. */
  hardMaxFactor: 1.5,
  sentenceInsideBlock: 4,
  pause: { NONE: 0, MICRO: -1, SHORT: -2, MEDIUM: -8, LONG: -20 } satisfies Record<PauseLength, number>,
  shift: { NONE: 0, MINOR: -4, MAJOR: -20 },
  questionToAnswer: 30,
  questionToQuestion: 6,
  setupToPayoff: 25,
  beforeShortSentence: 12,
  beforeContinuation: 6,
} as const;

/** Words that open a sentence continuing the last one's thought ("Then…" and "Still…" usually open a new beat, so they are not here). */
const CONTINUATIONS = new Set(['and', 'but', 'so', 'yet', 'or', 'nor', 'which', 'because', 'until', 'instead', 'that', 'while', 'whereas']);

/**
 * How much the script's delivery changes between two blocks: each of pace,
 * energy and emotion moves one step (to or from the plain register) or two
 * (from one extreme or feeling to another). A two-step move in any of them,
 * or one step in all three at once, is a major transition.
 */
export function performanceShift(a: ScriptDelivery, b: ScriptDelivery): 'NONE' | 'MINOR' | 'MAJOR' {
  const pace = a.pace === b.pace ? 0 : a.pace === 'NORMAL' || b.pace === 'NORMAL' ? 1 : 2;
  const energy = a.energy === b.energy ? 0 : a.energy === 'MEDIUM' || b.energy === 'MEDIUM' ? 1 : 2;
  const emotion = a.emotion === b.emotion ? 0 : a.emotion === 'NEUTRAL' || b.emotion === 'NEUTRAL' ? 1 : 2;
  const total = pace + energy + emotion;
  if (total === 0) return 'NONE';
  return Math.max(pace, energy, emotion) === 2 || total >= 3 ? 'MAJOR' : 'MINOR';
}

function units(section: ChunkSection): Unit[] {
  return section.blocks.flatMap((block) =>
    sentenceSpans(block.text).map((s) => {
      const text = block.text.slice(s.start, s.end);
      return { block, start: s.start, end: s.end, text, words: countWords(text) };
    }),
  );
}

function gapBetween(a: Unit, b: Unit): Gap {
  let cost = 0;
  let boundary: ChunkBoundary = 'SENTENCE';
  if (a.block !== b.block) {
    if (a.block.speakerId !== b.block.speakerId) return { hard: true, cost: 0, boundary: 'SPEAKER' };
    if (b.block.order !== a.block.order + 1) return { hard: true, cost: 0, boundary: 'PARAGRAPH' };
    const pause = longer(a.block.delivery.pauseAfter.length, b.block.delivery.pauseBefore.length);
    const shift = performanceShift(a.block.delivery, b.block.delivery);
    cost += CHUNK_COSTS.pause[pause] + CHUNK_COSTS.shift[shift];
    boundary = RANK[pause] >= RANK.MEDIUM ? 'PAUSE' : shift !== 'NONE' ? 'PERFORMANCE' : pause !== 'NONE' ? 'PAUSE' : 'PARAGRAPH';
  } else {
    cost += CHUNK_COSTS.sentenceInsideBlock;
  }
  // Keep a thought together.
  if (isQuestion(a.text)) cost += isQuestion(b.text) ? CHUNK_COSTS.questionToQuestion : CHUNK_COSTS.questionToAnswer;
  if (/(?:…|\.\.\.|—|–|:)["'”’)\]]*$/.test(a.text)) cost += CHUNK_COSTS.setupToPayoff;
  if (b.words <= 4) cost += CHUNK_COSTS.beforeShortSentence;
  const first = /^["'“‘(]*([\p{L}]+)/u.exec(b.text)?.[1]?.toLowerCase();
  if (first && CONTINUATIONS.has(first)) cost += CHUNK_COSTS.beforeContinuation;
  return { hard: false, cost, boundary };
}

function sizeCost(words: number, sentences: number, s: ChunkingSettings): number {
  if (sentences > 1 && words > s.maxWords * CHUNK_COSTS.hardMaxFactor) return Number.POSITIVE_INFINITY;
  let cost = CHUNK_COSTS.perChunk;
  if (words < s.minWords) cost += (s.minWords - words) * CHUNK_COSTS.underMinPerWord;
  if (words > s.maxWords) cost += (words - s.maxWords) * CHUNK_COSTS.overMaxPerWord;
  return cost;
}

/** The cheapest cut of one section's sentences into chunks: [start, end) unit ranges and the boundary each ends at. */
function cut(us: readonly Unit[], settings: ChunkingSettings): { from: number; to: number; boundary: ChunkBoundary }[] {
  const n = us.length;
  const gaps = us.slice(0, -1).map((u, i) => gapBetween(u, us[i + 1]!));
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    let words = 0;
    for (let i = j - 1; i >= 0; i--) {
      words += us[i]!.words;
      // A chunk never spans a hard boundary (a change of speaker, blocks that are not adjacent).
      if (i < j - 1 && gaps[i]!.hard) break;
      if (best[i] === Number.POSITIVE_INFINITY) continue;
      const cost = best[i]! + sizeCost(words, j - i, settings) + (j < n ? gaps[j - 1]!.cost : 0);
      if (cost < best[j]!) {
        best[j] = cost;
        from[j] = i;
      }
    }
  }
  const out: { from: number; to: number; boundary: ChunkBoundary }[] = [];
  for (let j = n; j > 0; j = from[j]!) out.unshift({ from: from[j]!, to: j, boundary: j === n ? 'SECTION_END' : gaps[j - 1]!.boundary });
  return out;
}

/** The script's delivery over a chunk, by words: the most common pace, energy and emotion. */
function dominant<T extends string>(parts: readonly { value: T; words: number }[], fallback: T): T {
  const totals = new Map<T, number>();
  for (const p of parts) totals.set(p.value, (totals.get(p.value) ?? 0) + p.words);
  let best = fallback;
  let max = -1;
  for (const [v, w] of totals) {
    if (w > max) {
      best = v;
      max = w;
    }
  }
  return best;
}

function build(section: ChunkSection, us: readonly Unit[], from: number, to: number, boundary: ChunkBoundary): Omit<PlannedChunk, 'index'> {
  const spans: ChunkSpan[] = [];
  const sentences: ChunkSentence[] = [];
  const inside: ChunkPauses['inside'] = [];
  let text = '';
  for (let k = from; k < to; k++) {
    const u = us[k]!;
    const last = spans.at(-1);
    if (last && last.blockId === u.block.id) {
      // Same block: keep the script's own spacing between its sentences.
      text += u.block.text.slice(last.end, u.start);
      last.end = u.end;
    } else {
      if (last) {
        const prev = us[k - 1]!.block;
        const pause = longer(prev.delivery.pauseAfter.length, u.block.delivery.pauseBefore.length);
        if (pause !== 'NONE') inside.push({ afterSentence: sentences.length - 1, length: pause });
        text += '\n';
      }
      spans.push({ blockId: u.block.id, blockKey: u.block.key, start: u.start, end: u.end });
    }
    sentences.push({ start: text.length, end: text.length + u.text.length, blockKey: u.block.key });
    text += u.text;
  }
  const first = us[from]!;
  const lastUnit = us[to - 1]!;
  const parts = us.slice(from, to).map((u) => ({ d: u.block.delivery, words: u.words }));
  const performance: ChunkPerformance = {
    pace: dominant<DeliveryPace>(parts.map((p) => ({ value: p.d.pace, words: p.words })), 'NORMAL'),
    energy: dominant<DeliveryEnergy>(parts.map((p) => ({ value: p.d.energy, words: p.words })), 'MEDIUM'),
    emotion: dominant<DeliveryEmotion>(parts.map((p) => ({ value: p.d.emotion, words: p.words })), 'NEUTRAL'),
    pauses: {
      before: first.start === firstSentenceStart(first.block) ? first.block.delivery.pauseBefore.length : 'NONE',
      after: lastUnit.end === lastSentenceEnd(lastUnit.block) ? lastUnit.block.delivery.pauseAfter.length : 'NONE',
      inside,
    },
  };
  return { sectionId: section.id, sectionKey: section.key, spans, text, words: countWords(text), sentences, boundary, performance };
}

const firstSentenceStart = (b: ChunkBlock) => sentenceSpans(b.text)[0]?.start ?? 0;
const lastSentenceEnd = (b: ChunkBlock) => sentenceSpans(b.text).at(-1)?.end ?? b.text.length;

/** Chunks for the given sections (in order), numbered across them. */
export function planChunks(sections: readonly ChunkSection[], settings: ChunkingSettings): PlannedChunk[] {
  const out: PlannedChunk[] = [];
  for (const section of sections) {
    const us = units(section);
    if (!us.length) continue;
    for (const c of cut(us, settings)) out.push({ index: out.length, ...build(section, us, c.from, c.to, c.boundary) });
  }
  return out;
}

/** The text of a chunk's spans as they read in some version of the blocks (null when a block is missing). */
export function spanText(spans: readonly ChunkSpan[], blockText: (key: string) => string | null): string | null {
  let text = '';
  for (const [i, s] of spans.entries()) {
    const t = blockText(s.blockKey);
    if (t === null || s.end > t.length) return null;
    text += (i > 0 ? '\n' : '') + t.slice(s.start, s.end);
  }
  return text;
}
