import type { ChunkPauses, DeliveryEmotion, DirectorMark, PauseLength, PauseReason, PerformanceIntent, PerformanceMark, PerformanceStrategy, ScriptBlockClass, ScriptDelivery } from '@docengine/core';
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
 * EXPRESSIVE is the house style plus at most one deliberate moment per
 * chunk, where the script turns: the sentence after a reveal, impact or
 * emotional-turn pause, or else the start of a block the script marks with a
 * delivery. The moment is one bracket of up to two cues from the script
 * (feeling, then energy, then pace; for a turn the script gives no delivery,
 * a slower or quieter manner), six words or more from any other direction.
 * It colours its block; the next block goes back to the direction the house
 * style has in force there, so nothing outside that block differs from it.
 *
 * PLAIN sends no directions at all. DIRECTED marks every sentence, loudly —
 * kept only to compare against (what over-direction sounds like), never the
 * default.
 *
 * A director's directions are laid over the strategy's: the director's wins
 * on its sentence, the rest of the strategy's stay, and the next sentence
 * goes back to what the strategy has in force there.
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

/** A direction back to the plain register. */
export const isReset = (i: PerformanceIntent) => !i.emotion && i.delivery === 'matter-of-fact' && !i.vocalAction;

/** The house style's words for a delivery: its feeling and one delivery word (both null for plain narration). */
function houseWords(d: ScriptDelivery): Pick<PerformanceIntent, 'emotion' | 'delivery'> {
  return { emotion: EMOTION_WORDS[d.emotion], delivery: deliveryWord(d) };
}

/** The direction in force at a sentence: the last one at or before it (null: none yet). */
export function inForceAt(marks: readonly PerformanceMark[], sentence: number): PerformanceMark | null {
  let found: PerformanceMark | null = null;
  for (const m of marks) if (m.sentence <= sentence && (!found || m.sentence >= found.sentence)) found = m;
  return found;
}

/**
 * A direction the house style itself would give or has in force there: back
 * to the plain register, the house's words for the sentence's own delivery,
 * or the house direction carried to that sentence.
 */
export function isHouseDirection(m: PerformanceMark, sentences: readonly PreparedSentence[]): boolean {
  if (isReset(m.intent)) return true;
  const s = sentences[m.sentence];
  if (!s || m.intent.vocalAction) return false;
  const says = (w: Pick<PerformanceIntent, 'emotion' | 'delivery'>) => m.intent.emotion === w.emotion && m.intent.delivery === w.delivery;
  if (says(houseWords(s.delivery))) return true;
  const carried = inForceAt(restrained(sentences), m.sentence);
  return !!carried && says(carried.intent);
}

function restrained(sentences: readonly PreparedSentence[]): PerformanceMark[] {
  const marks: PerformanceMark[] = [];
  let wordsSince = Number.POSITIVE_INFINITY;
  let marked = false; // a direction is in force
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1];
    const change = i === 0 || (s.blockStart && prev && !sameDelivery(prev.delivery, s.delivery));
    if (change && marks.length < HOUSE_STYLE.maxMarksPerChunk) {
      if (!isPlainDelivery(s.delivery) && (i === 0 || wordsSince >= HOUSE_STYLE.minWordsBetweenMarks)) {
        const intent: PerformanceIntent = { ...houseWords(s.delivery), intensity: 'LOW', pacing: s.delivery.pace, vocalAction: null };
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

/** Pause reasons that mark a turn worth one deliberate moment, strongest first. */
const TURNS: readonly PauseReason[] = ['REVEAL', 'IMPACT', 'EMOTIONAL_TURN'];
/** The manner of a moment where the script marks a turn but no delivery. */
const TURN_MANNER: Partial<Record<PauseReason, string>> = { REVEAL: 'deliberate', IMPACT: 'deliberate', EMOTIONAL_TURN: 'quiet' };

/**
 * The words of a moment: the script's feeling and its manner (energy, then
 * pace), two at most — "[curious, quiet]", "[quiet, deliberate]"; for a turn
 * the script gives no delivery, its manner alone. Null when there is nothing
 * to say.
 */
function momentWords(d: ScriptDelivery, turn: PauseReason | null): Pick<PerformanceIntent, 'emotion' | 'delivery'> | null {
  const manner = [d.energy === 'LOW' ? 'quiet' : d.energy === 'HIGH' ? 'urgent' : null, d.pace === 'SLOW' ? 'deliberate' : d.pace === 'FAST' ? 'brisk' : null].filter((w): w is string => !!w);
  const feeling = EMOTION_WORDS[d.emotion];
  if (feeling) return { emotion: feeling, delivery: manner[0] ?? null };
  if (manner.length === 2) return { emotion: manner[0]!, delivery: manner[1]! };
  if (manner.length === 1) return { emotion: null, delivery: manner[0]! };
  const turnManner = turn ? TURN_MANNER[turn] : undefined;
  return turnManner ? { emotion: null, delivery: turnManner } : null;
}

function expressive(sentences: readonly PreparedSentence[], pauses: ChunkPauses): PerformanceMark[] {
  const house = restrained(sentences);
  const candidates: { sentence: number; turn: PauseReason | null }[] = [];
  for (const turn of TURNS) {
    if (sentences[0]?.delivery.pauseBefore.reason === turn && pauses.before !== 'NONE') candidates.push({ sentence: 0, turn });
    for (const p of pauses.inside) if (p.reason === turn && p.afterSentence + 1 < sentences.length) candidates.push({ sentence: p.afterSentence + 1, turn });
  }
  sentences.forEach((s, i) => {
    if (s.blockStart && !isPlainDelivery(s.delivery)) candidates.push({ sentence: i, turn: null });
  });
  for (const c of candidates) {
    const s = sentences[c.sentence]!;
    const words = momentWords(s.delivery, c.turn);
    // A moment says more than the house style would there.
    if (!words) continue;
    const intent: PerformanceIntent = { ...words, intensity: 'LOW', pacing: s.delivery.pace, vocalAction: null };
    const moment: PerformanceMark = { sentence: c.sentence, intent, source: 'STRATEGY', reason: `expressive moment: ${c.turn ? `after a ${c.turn.toLowerCase().replace('_', ' ')} pause` : `block ${s.blockKey}: the script marks it ${describe(s.delivery)}`}` };
    if (isHouseDirection(moment, sentences)) continue;
    // Never on consecutive short sentences: six words or more from the directions before and after it.
    const before = house.filter((m) => m.sentence < c.sentence && !isReset(m.intent)).at(-1);
    const after = house.find((m) => m.sentence > c.sentence && !isReset(m.intent));
    if (before && wordsBetween(sentences, before.sentence, c.sentence) < HOUSE_STYLE.minWordsBetweenMarks) continue;
    if (after && wordsBetween(sentences, c.sentence, after.sentence) < HOUSE_STYLE.minWordsBetweenMarks) continue;
    // The moment colours its block, as the house style's directions do; the next block goes back to the direction the house style has in force there.
    return overlay(house, [moment], (m, marks) => {
      const next = sentences.findIndex((x, i) => i > m.sentence && x.blockStart);
      if (next < 0 || marks.some((x) => x.sentence > m.sentence && x.sentence <= next)) return null;
      const back = inForceAt(house, next);
      const key = sentences[next]!.blockKey;
      return back && !isReset(back.intent)
        ? { sentence: next, intent: back.intent, source: 'STRATEGY', reason: `block ${key}: back to the house style after the expressive moment (the direction of sentence ${back.sentence + 1})` }
        : { sentence: next, intent: { ...RESET, pacing: 'NORMAL' }, source: 'STRATEGY', reason: `block ${key}: back to the plain register after the expressive moment (a direction carries forward)` };
    });
  }
  return house;
}

function describe(d: ScriptDelivery): string {
  return [d.emotion !== 'NEUTRAL' ? d.emotion.toLowerCase() : null, d.energy !== 'MEDIUM' ? `${d.energy.toLowerCase()} energy` : null, d.pace !== 'NORMAL' ? `${d.pace.toLowerCase()} pace` : null].filter(Boolean).join(', ');
}

const wordsBetween = (sentences: readonly PreparedSentence[], from: number, to: number) => sentences.slice(from, to).reduce((n, s) => n + countWords(s.text), 0);

/** Marks laid over others: each wins on its sentence, and `end` gives the mark (if any) that ends it — a direction carries forward. */
function overlay(base: readonly PerformanceMark[], over: readonly PerformanceMark[], end: (m: PerformanceMark, marks: readonly PerformanceMark[]) => PerformanceMark | null): PerformanceMark[] {
  const taken = new Set(over.map((m) => m.sentence));
  const out = [...base.filter((m) => !taken.has(m.sentence)), ...over];
  for (const m of over) {
    const closing = end(m, out);
    if (closing) out.push(closing);
  }
  return out.sort((a, b) => a.sentence - b.sentence);
}

/** The directions for one chunk: the strategy's, with the director's laid over them (each for its one sentence). */
export function performanceMarks(sentences: readonly PreparedSentence[], strategy: PerformanceStrategy, pauses: ChunkPauses, director?: readonly DirectorMark[]): PerformanceMark[] {
  const base = strategy === 'PLAIN' ? [] : strategy === 'DIRECTED' ? directed(sentences) : strategy === 'EXPRESSIVE' ? expressive(sentences, pauses) : restrained(sentences);
  const own = (director ?? [])
    .filter((d) => d.sentence < sentences.length && (d.emotion || d.delivery || d.vocalAction))
    .sort((a, b) => a.sentence - b.sentence)
    .map(
      (d): PerformanceMark => ({
        sentence: d.sentence,
        intent: { emotion: d.emotion ?? null, delivery: d.delivery ?? null, intensity: 'LOW', pacing: sentences[d.sentence]!.delivery.pace, vocalAction: d.vocalAction ?? null },
        source: 'DIRECTOR',
        reason: "the director's direction",
      }),
    );
  if (!own.length) return base;
  // After the director's sentence, back to the strategy's direction in force there (or the plain register).
  return overlay(base, own, (m, marks) => {
    const next = m.sentence + 1;
    if (next >= sentences.length || marks.some((x) => x.sentence === next)) return null;
    const inForce = inForceAt(base, next);
    return inForce && !isReset(inForce.intent)
      ? { sentence: next, intent: inForce.intent, source: 'DIRECTOR', reason: `back to the direction of sentence ${inForce.sentence + 1} after the director's (a direction carries forward)` }
      : { sentence: next, intent: { ...RESET, pacing: 'NORMAL' }, source: 'DIRECTOR', reason: "back to the plain register after the director's direction (a direction carries forward)" };
  });
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
