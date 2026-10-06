import {
  CHUNK_SECONDS,
  DEFAULT_VOICE_PROFILE_CONFIG,
  DirectorMark,
  SCRIPT_TIMING,
  wordsForSeconds,
  type ChunkingSettings,
  type ContextSettings,
  type VoiceChunkView,
  type VoicePlanView,
  type VoiceRunSummaryView,
} from '@docengine/core';

/**
 * The Voice page's arithmetic, kept out of the components: chunk sizes in
 * seconds of speech, sentence numbers a director's direction addresses, and
 * what a request would send and cost before it is confirmed.
 */

const sized = (min: number, max: number) => ({ label: `≈${min}–${max} s`, chunking: { minWords: wordsForSeconds(min), maxWords: wordsForSeconds(max) } });
const { target, natural } = CHUNK_SECONDS;

/** Chunk sizes to choose or compare: below, at and above the target, within the natural range. */
export const CHUNK_SIZES: { label: string; chunking: ChunkingSettings }[] = [sized(natural.min, target.min), sized(target.min, target.max), sized(target.max, natural.max)];

export const NO_CONTEXT: ContextSettings = { previousChars: 0, nextChars: 0, stitch: false };
export const CONTEXTS: { label: string; context: ContextSettings }[] = [
  { label: 'Neighbouring text (a sentence or two)', context: DEFAULT_VOICE_PROFILE_CONFIG.context },
  { label: 'No context', context: NO_CONTEXT },
  { label: 'Stitched to the previous take (request ids)', context: { ...DEFAULT_VOICE_PROFILE_CONFIG.context, stitch: true } },
];

/** Seconds of speech for spoken words at the narration rate. */
export const secondsFor = (words: number) => (words * 60) / SCRIPT_TIMING.wordsPerMinute;

/** "20–30 words (≈8–12 s)" */
export const sizeLabel = (c: ChunkingSettings) => `${c.minWords}–${c.maxWords} words (≈${Math.round(secondsFor(c.minWords))}–${Math.round(secondsFor(c.maxWords))} s)`;

export const contextLabel = (c: ContextSettings) =>
  c.stitch ? 'stitched to the previous take' : c.previousChars || c.nextChars ? `neighbouring text (${c.previousChars}/${c.nextChars} chars)` : 'none';

/** Outside the range a natural thought may run to (worth a look, not an error). */
export const outsideNatural = (sec: number) => sec < natural.min || sec > natural.max;

// ── Sentences ────────────────────────────────────────────────────────────────

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(
  'mr mrs ms dr st mt jr sr prof gen col capt lt sgt rev hon vs etc eg ie approx c ca no vol pp p fig ed eds inc ltd co corp dept est fl cf al'.split(' '),
);
const CLOSERS = `"'”’)]`;

/**
 * A chunk's sentences as character ranges, numbered as a director's
 * direction counts them. The same rule as the engine's sentence splitter
 * (modules/voice text.ts), which voice-plan.test.ts and the browser check compare it against: a
 * sentence ends at . ! ? or an ellipsis followed by a capital, a digit or an
 * opening quote — not after an abbreviation or an initial — and at a line
 * break (the break between two blocks).
 */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = skipSpace(text, 0);
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(out, text, start, i);
      start = skipSpace(text, i + 1);
      i = start;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let end = i + 1;
      while (end < text.length && (text[end] === '.' || text[end] === '!' || text[end] === '?' || text[end] === '…')) end++;
      while (end < text.length && CLOSERS.includes(text[end]!)) end++;
      const next = skipSpace(text, end);
      if (next > end && next < text.length && isSentenceEnd(text, i, end, next)) {
        push(out, text, start, end);
        start = next;
        i = next;
        continue;
      }
      i = end;
      continue;
    }
    i++;
  }
  push(out, text, start, text.length);
  return out;
}

function isSentenceEnd(text: string, at: number, end: number, next: number): boolean {
  const following = text[next]!;
  if (/\p{Ll}/u.test(following)) return false;
  if (text[at] === '.' && end === at + 1) {
    const word = /([\p{L}]+)$/u.exec(text.slice(Math.max(0, at - 12), at))?.[1] ?? '';
    if (word.length === 1 && /\p{Lu}/u.test(word)) return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  }
  return /[\p{Lu}\p{N}"'“‘(\[]/u.test(following);
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function push(out: { start: number; end: number }[], text: string, start: number, end: number) {
  let e = end;
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  if (e > start) out.push({ start, end: e });
}

export const sentencesOf = (text: string) => sentenceSpans(text).map((s) => text.slice(s.start, s.end));

/**
 * A director's directions typed one line per sentence, "sentence: emotion"
 * or "sentence: emotion, delivery", by the chunk's sentence numbers (1 to
 * `sentences`, each once). Null when a line does not read: the engine drops
 * a direction for a sentence the chunk does not have, so the take would be
 * paid for without it.
 */
export function parseDirections(text: string, sentences: number): DirectorMark[] | null {
  const marks: DirectorMark[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*:\s*([a-z][a-z \-']*)(?:,\s*([a-z][a-z \-']*))?$/.exec(line.toLowerCase());
    if (!m) return null;
    const sentence = Number(m[1]) - 1;
    if (sentence < 0 || sentence >= sentences || marks.some((x) => x.sentence === sentence)) return null;
    const mark = DirectorMark.safeParse({ sentence, emotion: m[2]!.trim(), ...(m[3] ? { delivery: m[3].trim() } : {}) });
    if (!mark.success) return null;
    marks.push(mark.data);
  }
  return marks;
}

// ── Estimates before a confirmation ──────────────────────────────────────────

export interface Estimate {
  takes: number;
  characters: number;
  /** null: no price known (unpriced, or nothing generated yet to price it from). */
  costUsd: number | null;
  mock: boolean;
}

/**
 * What new takes of these chunks would send and cost: each chunk's last
 * take sent this many characters (its text plus markup), priced at the
 * run's own rate. The server counts again when the request arrives.
 */
export function takesEstimate(chunks: readonly VoiceChunkView[], variants: number, run: Pick<VoiceRunSummaryView, 'characters' | 'cost'>, mock: boolean): Estimate {
  const characters =
    variants *
    chunks.reduce((n, c) => {
      const last = c.current?.characters != null ? c.current : c.generations.find((g) => g.characters !== null);
      return n + (last?.characters ?? last?.performanceText?.length ?? c.text.length);
    }, 0);
  const rate = !mock && run.characters > 0 && run.cost.totalUsd > 0 ? run.cost.totalUsd / run.characters : null;
  return { takes: chunks.length * variants, characters, costUsd: mock ? 0 : rate === null ? null : rate * characters, mock };
}

/** The total of several plans (a comparison: every variant is generated in full). */
export function plansEstimate(plans: readonly VoicePlanView[]): Estimate {
  const mock = plans.every((p) => p.estimate.costBasis === 'MOCK');
  const priced = plans.every((p) => p.estimate.estimatedCostUsd !== null);
  return {
    takes: plans.reduce((n, p) => n + p.estimate.chunks, 0),
    characters: plans.reduce((n, p) => n + p.estimate.characters, 0),
    costUsd: mock ? 0 : priced ? plans.reduce((n, p) => n + p.estimate.estimatedCostUsd!, 0) : null,
    mock,
  };
}

export const costWords = (e: Pick<Estimate, 'costUsd' | 'mock'>) => (e.mock ? 'MOCK voice: no cost' : e.costUsd === null ? 'cost unknown (no price yet)' : `~$${e.costUsd < 0.01 ? e.costUsd.toFixed(4) : e.costUsd.toFixed(2)} estimated`);

// ── Comparisons ──────────────────────────────────────────────────────────────

/**
 * The runs one comparison job made, in variant order. A job numbers its
 * runs consecutively under one experiment name; a later job of the same
 * name starts its labels again, so a repeated label starts a new group.
 */
export function experimentRuns<R extends Pick<VoiceRunSummaryView, 'number' | 'experiment' | 'variant'>>(runs: readonly R[], number: number): R[] {
  let group: R[] = [];
  for (const r of [...runs].sort((a, b) => a.number - b.number)) {
    const last = group.at(-1);
    const joins = !!r.experiment && !!last && last.experiment === r.experiment && last.number === r.number - 1 && !group.some((g) => g.variant === r.variant);
    if (!joins) {
      if (group.some((g) => g.number === number)) break;
      group = r.experiment ? [r] : [];
    } else group.push(r);
  }
  return group.some((g) => g.number === number) ? group : [];
}
