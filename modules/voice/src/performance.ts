import type { ChunkPauses, DeliveryEmotion, DirectorMark, PauseLength, PerformanceIntent, PerformanceMark, PerformanceStrategy, ScriptBlockClass, ScriptDelivery } from '@docengine/core';
import { countWords, isQuestion } from './text.ts';

/**
 * Performance preparation: the script's delivery marks (written by the
 * script engine's performance pass and reviewed with the script) become
 * provider-neutral directions for the voice. Nothing is invented: a
 * direction translates a delivery the script asked for. The script is never
 * changed — directions live in the take's derived representation.
 *
 * House style (RESTRAINED) — a documentary narrator, not an audiobook
 * character:
 * - no direction on narration the script marks as plain (neutral emotion,
 *   medium energy, normal pace): v4-class models infer delivery from good
 *   writing;
 * - a direction only where the script's delivery changes — at the start of
 *   a chunk whose first block is marked, or where a later block's delivery
 *   differs — and back to the plain register (one short reset) when a marked
 *   passage is followed by plain narration in the same chunk, because a
 *   direction carries forward until the next one;
 * - at most two directions per chunk, never on consecutive short sentences
 *   (six words or more between them; a reset to the plain register is
 *   always allowed);
 *   low intensity; one emotion and at most one delivery word; never a vocal
 *   action (sighs, breaths) unless the director asks for one.
 *
 * PLAIN sends no directions at all. DIRECTED marks every sentence, loudly —
 * kept only to compare against (what over-direction sounds like), never the
 * default.
 */

export interface PreparedSentence {
  /** Canonical text of the sentence. */
  text: string;
  blockKey: string;
  delivery: ScriptDelivery;
  infoClass: ScriptBlockClass;
  /** First sentence of its block. */
  blockStart: boolean;
}

export const EMOTION_WORDS: Record<DeliveryEmotion, string | null> = {
  NEUTRAL: null,
  REFLECTIVE: 'reflective',
  CURIOUS: 'curious',
  TENSE: 'tense',
  SOMBER: 'somber',
  EXCITED: 'excited',
};

/** The delivery word for a block's energy and pace (energy first: it is the stronger cue). */
export function deliveryWord(d: Pick<ScriptDelivery, 'energy' | 'pace'>): string | null {
  if (d.energy === 'LOW') return 'quiet';
  if (d.pace === 'SLOW') return 'deliberate';
  if (d.energy === 'HIGH') return 'urgent';
  if (d.pace === 'FAST') return 'brisk';
  return null;
}

export const isPlainDelivery = (d: Pick<ScriptDelivery, 'emotion' | 'energy' | 'pace'>) => d.emotion === 'NEUTRAL' && d.energy === 'MEDIUM' && d.pace === 'NORMAL';
const sameDelivery = (a: ScriptDelivery, b: ScriptDelivery) => a.emotion === b.emotion && a.energy === b.energy && a.pace === b.pace;

/** Limits of the house style. */
export const HOUSE_STYLE = { maxMarksPerChunk: 2, minWordsBetweenMarks: 6 } as const;

const RESET: Omit<PerformanceIntent, 'pacing'> = { emotion: null, delivery: 'matter-of-fact', intensity: 'LOW', vocalAction: null };

function restrained(sentences: readonly PreparedSentence[]): PerformanceMark[] {
  const marks: PerformanceMark[] = [];
  let wordsSince = Number.POSITIVE_INFINITY;
  let marked = false; // a direction is in force
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1];
    const change = i === 0 || (s.blockStart && prev && !sameDelivery(prev.delivery, s.delivery));
    if (change && marks.length < HOUSE_STYLE.maxMarksPerChunk) {
      if (!isPlainDelivery(s.delivery) && (i === 0 || wordsSince >= HOUSE_STYLE.minWordsBetweenMarks)) {
        const intent: PerformanceIntent = { emotion: EMOTION_WORDS[s.delivery.emotion], delivery: deliveryWord(s.delivery), intensity: 'LOW', pacing: s.delivery.pace, vocalAction: null };
        if (intent.emotion || intent.delivery) {
          marks.push({ sentence: i, intent, source: 'SCRIPT', reason: `block ${s.blockKey}: the script marks it ${describe(s.delivery)}` });
          wordsSince = 0;
          marked = true;
        }
      } else if (marked) {
        marks.push({ sentence: i, intent: { ...RESET, pacing: 'NORMAL' }, source: 'SCRIPT', reason: `block ${s.blockKey}: back to the plain register after a marked passage (a direction carries forward)` });
        wordsSince = 0;
        marked = false;
      }
    }
    wordsSince += countWords(s.text);
  });
  return marks;
}

function directed(sentences: readonly PreparedSentence[]): PerformanceMark[] {
  return sentences.map((s, i) => {
    const emotion = EMOTION_WORDS[s.delivery.emotion] ?? (isQuestion(s.text) ? 'curious' : 'dramatic');
    const delivery = deliveryWord(s.delivery) ?? 'intense';
    const vocalAction = s.blockStart && s.delivery.emotion === 'SOMBER' ? 'sighs' : s.blockStart && s.delivery.emotion === 'REFLECTIVE' ? 'exhales' : null;
    return { sentence: i, intent: { emotion, delivery, intensity: 'HIGH', pacing: s.delivery.pace, vocalAction }, source: 'STRATEGY', reason: 'over-directed comparison: a direction on every sentence' } satisfies PerformanceMark;
  });
}

function describe(d: ScriptDelivery): string {
  return [d.emotion !== 'NEUTRAL' ? d.emotion.toLowerCase() : null, d.energy !== 'MEDIUM' ? `${d.energy.toLowerCase()} energy` : null, d.pace !== 'NORMAL' ? `${d.pace.toLowerCase()} pace` : null].filter(Boolean).join(', ');
}

/** The directions for one chunk: the director's, if given; otherwise the strategy's. */
export function performanceMarks(sentences: readonly PreparedSentence[], strategy: PerformanceStrategy, director?: readonly DirectorMark[]): PerformanceMark[] {
  if (director?.length) {
    return director
      .filter((d) => d.sentence < sentences.length && (d.emotion || d.delivery || d.vocalAction))
      .sort((a, b) => a.sentence - b.sentence)
      .map((d) => ({
        sentence: d.sentence,
        intent: { emotion: d.emotion ?? null, delivery: d.delivery ?? null, intensity: 'LOW', pacing: sentences[d.sentence]!.delivery.pace, vocalAction: d.vocalAction ?? null },
        source: 'DIRECTOR',
        reason: "the director's direction",
      }));
  }
  if (strategy === 'PLAIN') return [];
  return strategy === 'DIRECTED' ? directed(sentences) : restrained(sentences);
}

/** The pause after each sentence inside the chunk (the chunk's edges are pauses between takes, made in assembly). */
export function sentencePauses(count: number, pauses: ChunkPauses): PauseLength[] {
  const out = new Array<PauseLength>(count).fill('NONE');
  for (const p of pauses.inside) if (p.afterSentence < count - 1) out[p.afterSentence] = p.length;
  return out;
}

/** In a DIRECTED take every sentence break becomes a marked pause too (part of over-direction); otherwise only the script's pauses. */
export function strategyPauses(strategy: PerformanceStrategy, pauses: PauseLength[]): PauseLength[] {
  if (strategy !== 'DIRECTED') return pauses;
  return pauses.map((p, i) => (i === pauses.length - 1 ? p : p === 'NONE' || p === 'MICRO' || p === 'SHORT' ? 'MEDIUM' : p));
}
