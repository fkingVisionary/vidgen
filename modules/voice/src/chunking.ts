import {
  CHUNK_SECONDS,
  PAUSE_LENGTHS,
  SCRIPT_TIMING,
  spokenWordCount,
  wordsForSeconds,
  type ChunkBoundary,
  type ChunkPauses,
  type ChunkPerformance,
  type ChunkSpan,
  type ChunkingSettings,
  type DeliveryEmotion,
  type DeliveryEnergy,
  type DeliveryPace,
  type PauseLength,
  type PauseReason,
  type ScriptBlockClass,
  type ScriptDelivery,
  type ScriptPause,
} from '@docengine/core';
import { isQuestion, sentenceSpans } from './text.ts';

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
 * - Preferred cuts: a paragraph (block) end, a scripted pause that closes a
 *   thought (a transition, an emotional turn, rhythm), a change in the
 *   script's delivery (pace, energy, emotion) or in the information class
 *   (into or out of fiction above all) — the stronger the change, the
 *   stronger the preference.
 * - Avoided cuts: between a question and its answer, a setup ("…", "—", or a
 *   scripted reveal, impact, question or number pause) and its payoff,
 *   before a very short sentence (usually a payoff), or before a sentence
 *   that continues the last ("And…", "But…").
 * - Size, in spoken words (a figure counts as it is read): chunks under the
 *   minimum or over the maximum cost more the further out they are, and a
 *   chunk of several sentences never runs past a natural thought's longest
 *   (≈ 20 s) unless the maximum itself does; a fixed cost per chunk keeps a
 *   section from shattering into tiny clips just because the delivery shifts
 *   slightly.
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
  /** Spoken words (the unit of the chunk-size settings). */
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

/** The pause between two adjacent blocks: the longer of the first's pause after and the second's pause before, with its reason. */
function pauseBetween(a: ScriptDelivery, b: ScriptDelivery): ScriptPause {
  const x = a.pauseAfter;
  const y = b.pauseBefore;
  if (RANK[x.length] !== RANK[y.length]) return RANK[x.length] > RANK[y.length] ? x : y;
  return x.reason ? x : y;
}

/** Pauses that hold a thought open: what follows completes what came before (the reveal, the impact, the answer, what the number means). */
const HOLDING: ReadonlySet<PauseReason> = new Set(['REVEAL', 'IMPACT', 'QUESTION', 'NUMBER']);
const holds = (p: ScriptPause) => p.length !== 'NONE' && !!p.reason && HOLDING.has(p.reason);

/** Gap and size costs (tuned on narration; see the chunking tests). */
export const CHUNK_COSTS = {
  perChunk: 6,
  underMinPerWord: 1.5,
  overMaxPerWord: 3,
  /** Over max × this (and over a natural thought's longest, ≈ 20 s, unless the maximum itself is), a chunk of several sentences is not allowed at all. */
  hardMaxFactor: 1.5,
  /** A cut inside a block rather than at its end (a block is the script's unit of thought): a little over the maximum is better than a paragraph split to join its start to the last one's payoff. */
  sentenceInsideBlock: 8,
  pause: { NONE: 0, MICRO: -1, SHORT: -2, MEDIUM: -8, LONG: -20 } satisfies Record<PauseLength, number>,
  shift: { NONE: 0, MINOR: -4, MAJOR: -20 },
  /** A change of information class: into or out of fiction (MAJOR) is cut even at the cost of short chunks; any other change only tips a close call. */
  purpose: { NONE: 0, MINOR: -4, MAJOR: -30 },
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

/** How much the information class changes between two blocks: into or out of fiction is major, any other change minor. */
export function purposeShift(a: ScriptBlockClass, b: ScriptBlockClass): 'NONE' | 'MINOR' | 'MAJOR' {
  if (a === b) return 'NONE';
  return a === 'FICTION' || b === 'FICTION' ? 'MAJOR' : 'MINOR';
}

function units(section: ChunkSection): Unit[] {
  return section.blocks.flatMap((block) =>
    sentenceSpans(block.text).map((s) => {
      const text = block.text.slice(s.start, s.end);
      return { block, start: s.start, end: s.end, text, words: spokenWordCount(text) };
    }),
  );
}

function gapBetween(a: Unit, b: Unit): Gap {
  let cost = 0;
  let boundary: ChunkBoundary = 'SENTENCE';
  if (a.block !== b.block) {
    if (a.block.speakerId !== b.block.speakerId) return { hard: true, cost: 0, boundary: 'SPEAKER' };
    if (b.block.order !== a.block.order + 1) return { hard: true, cost: 0, boundary: 'PARAGRAPH' };
    const between = pauseBetween(a.block.delivery, b.block.delivery);
    // A holding pause is part of the thought, not the end of one.
    const pause = holds(between) ? 'NONE' : between.length;
    const shift = performanceShift(a.block.delivery, b.block.delivery);
    const purpose = purposeShift(a.block.infoClass, b.block.infoClass);
    cost += (holds(between) ? CHUNK_COSTS.setupToPayoff : CHUNK_COSTS.pause[pause]) + CHUNK_COSTS.shift[shift] + CHUNK_COSTS.purpose[purpose];
    boundary =
      purpose === 'MAJOR' ? 'PURPOSE' : RANK[pause] >= RANK.MEDIUM ? 'PAUSE' : shift !== 'NONE' ? 'PERFORMANCE' : purpose !== 'NONE' ? 'PURPOSE' : pause !== 'NONE' ? 'PAUSE' : 'PARAGRAPH';
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

/** The most spoken words a chunk of several sentences may have. */
const hardMax = (s: ChunkingSettings) => Math.max(s.maxWords, Math.min(s.maxWords * CHUNK_COSTS.hardMaxFactor, wordsForSeconds(CHUNK_SECONDS.natural.max)));

function sizeCost(words: number, sentences: number, s: ChunkingSettings): number {
  if (sentences > 1 && words > hardMax(s)) return Number.POSITIVE_INFINITY;
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
        const pause = pauseBetween(us[k - 1]!.block.delivery, u.block.delivery);
        if (pause.length !== 'NONE') inside.push({ afterSentence: sentences.length - 1, length: pause.length, reason: pause.reason });
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
  return { sectionId: section.id, sectionKey: section.key, spans, text, words: spokenWordCount(text), sentences, boundary, performance };
}

const firstSentenceStart = (b: ChunkBlock) => sentenceSpans(b.text)[0]?.start ?? 0;
const lastSentenceEnd = (b: ChunkBlock) => sentenceSpans(b.text).at(-1)?.end ?? b.text.length;

/**
 * Planned seconds of a chunk: its spoken words at the narration rate and its
 * pace, plus the pauses between its sentences (the pauses at its edges fall
 * between takes). An estimate for planning; a take's measured duration is
 * what counts.
 */
export function chunkSeconds(words: number, performance: Pick<ChunkPerformance, 'pace' | 'pauses'>): number {
  const speech = (words / (SCRIPT_TIMING.wordsPerMinute * SCRIPT_TIMING.paceFactor[performance.pace])) * 60;
  const pauses = performance.pauses.inside.reduce((n, p) => n + SCRIPT_TIMING.pauseSec[p.length], 0);
  return Math.round((speech + pauses) * 10) / 10;
}

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
