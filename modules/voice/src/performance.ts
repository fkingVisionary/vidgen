import { EARLIER_PERFORMANCE_RULES, type ChunkPauses, type DeliveryEmotion, type DirectorMark, type PauseLength, type PauseReason, type PerformanceIntent, type PerformanceMark, type PerformanceRules, type PerformanceStrategy, type ScriptBlockClass, type ScriptDelivery } from '@docengine/core';
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
 * The limits and words are a profile's performance rules; the figures and
 * words here are the earlier rules' (the default when none are given).
 *
 * EXPRESSIVE is the house style plus at most one deliberate moment per
 * chunk, where the script turns: the sentence after a reveal, impact or
 * emotional-turn pause, or else the start of a block the script marks with a
 * delivery. The moment is one bracket of up to two cues from the script
 * (feeling, then energy, then pace; for a turn the script gives no delivery,
 * a slower or quieter manner), as far from any other direction as the house
 * style's directions are from each other. It colours its block; the next
 * block goes back to the direction the house style has in force there, so
 * nothing outside that block differs from it.
 *
 * PLAIN sends no directions at all. DIRECTED marks every sentence, loudly —
 * kept only to compare against (what over-direction sounds like), never the
 * default; its own words ("dramatic", "intense", "sighs"…) are not rules.
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

/** The earlier rules' word for each scripted feeling (none for neutral narration). */
export const EMOTION_WORDS: Record<DeliveryEmotion, string | null> = { NEUTRAL: null, ...EARLIER_PERFORMANCE_RULES.emotionWords };

/** The rules' word for a scripted feeling (none for neutral narration). */
const emotionWord = (emotion: DeliveryEmotion, rules: PerformanceRules): string | null => (emotion === 'NEUTRAL' ? null : rules.emotionWords[emotion]);

/** The delivery word for a block's energy and pace (energy first: it is the stronger cue). */
export function deliveryWord(d: Pick<ScriptDelivery, 'energy' | 'pace'>, rules: PerformanceRules = EARLIER_PERFORMANCE_RULES): string | null {
  const w = rules.deliveryWords;
  if (d.energy === 'LOW') return w.lowEnergy;
  if (d.pace === 'SLOW') return w.slowPace;
  if (d.energy === 'HIGH') return w.highEnergy;
  if (d.pace === 'FAST') return w.fastPace;
  return null;
}

export const isPlainDelivery = (d: Pick<ScriptDelivery, 'emotion' | 'energy' | 'pace'>) => d.emotion === 'NEUTRAL' && d.energy === 'MEDIUM' && d.pace === 'NORMAL';
const sameDelivery = (a: ScriptDelivery, b: ScriptDelivery) => a.emotion === b.emotion && a.energy === b.energy && a.pace === b.pace;

/** The earlier rules' limits of the house style. */
export const HOUSE_STYLE = { maxMarksPerChunk: EARLIER_PERFORMANCE_RULES.maxMarksPerChunk, minWordsBetweenMarks: EARLIER_PERFORMANCE_RULES.minWordsBetweenMarks } as const;

/** Back to the plain register, in the rules' word. */
const reset = (rules: PerformanceRules): PerformanceIntent => ({ emotion: null, delivery: rules.resetWord, intensity: 'LOW', vocalAction: null, pacing: 'NORMAL' });

/** A direction back to the plain register. */
export const isReset = (i: PerformanceIntent, rules: PerformanceRules = EARLIER_PERFORMANCE_RULES) => !i.emotion && i.delivery === rules.resetWord && !i.vocalAction;

/** The house style's words for a delivery: its feeling and one delivery word (both null for plain narration). */
function houseWords(d: ScriptDelivery, rules: PerformanceRules): Pick<PerformanceIntent, 'emotion' | 'delivery'> {
  return { emotion: emotionWord(d.emotion, rules), delivery: deliveryWord(d, rules) };
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
export function isHouseDirection(m: PerformanceMark, sentences: readonly PreparedSentence[], rules: PerformanceRules = EARLIER_PERFORMANCE_RULES): boolean {
  if (isReset(m.intent, rules)) return true;
  const s = sentences[m.sentence];
  if (!s || m.intent.vocalAction) return false;
  const says = (w: Pick<PerformanceIntent, 'emotion' | 'delivery'>) => m.intent.emotion === w.emotion && m.intent.delivery === w.delivery;
  if (says(houseWords(s.delivery, rules))) return true;
  const carried = inForceAt(restrained(sentences, rules), m.sentence);
  return !!carried && says(carried.intent);
}

function restrained(sentences: readonly PreparedSentence[], rules: PerformanceRules): PerformanceMark[] {
  const marks: PerformanceMark[] = [];
  let wordsSince = Number.POSITIVE_INFINITY;
  let marked = false; // a direction is in force
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1];
    const change = i === 0 || (s.blockStart && prev && !sameDelivery(prev.delivery, s.delivery));
    if (change && marks.length < rules.maxMarksPerChunk) {
      // A delivery the rules have no word for is told plainly (never in the direction before it).
      const words = houseWords(s.delivery, rules);
      if ((words.emotion || words.delivery) && (i === 0 || wordsSince >= rules.minWordsBetweenMarks)) {
        const intent: PerformanceIntent = { ...words, intensity: 'LOW', pacing: s.delivery.pace, vocalAction: null };
        marks.push({ sentence: i, intent, source: 'SCRIPT', reason: `block ${s.blockKey}: the script marks it ${describe(s.delivery)}` });
        wordsSince = 0;
        marked = true;
      } else if (marked) {
        marks.push({ sentence: i, intent: reset(rules), source: 'SCRIPT', reason: `block ${s.blockKey}: back to the plain register after a marked passage (a direction carries forward)` });
        wordsSince = 0;
        marked = false;
      }
    }
    wordsSince += countWords(s.text);
  });
  return marks;
}

/** Over-direction: the rules' words where the script gives a delivery, and its own loud words everywhere else. */
function directed(sentences: readonly PreparedSentence[], rules: PerformanceRules): PerformanceMark[] {
  return sentences.map((s, i) => {
    const emotion = emotionWord(s.delivery.emotion, rules) ?? (isQuestion(s.text) ? 'curious' : 'dramatic');
    const delivery = deliveryWord(s.delivery, rules) ?? 'intense';
    const vocalAction = s.blockStart && s.delivery.emotion === 'SOMBER' ? 'sighs' : s.blockStart && s.delivery.emotion === 'REFLECTIVE' ? 'exhales' : null;
    return { sentence: i, intent: { emotion, delivery, intensity: 'HIGH', pacing: s.delivery.pace, vocalAction }, source: 'STRATEGY', reason: 'over-directed comparison: a direction on every sentence' } satisfies PerformanceMark;
  });
}

/** Pause reasons that mark a turn worth one deliberate moment, strongest first. */
const TURNS: readonly PauseReason[] = ['REVEAL', 'IMPACT', 'EMOTIONAL_TURN'];
/** The manner of a moment where the script marks a turn but no delivery: slower after a reveal or impact, quieter after an emotional turn. */
const TURN_MANNER: Partial<Record<PauseReason, keyof PerformanceRules['deliveryWords']>> = { REVEAL: 'slowPace', IMPACT: 'slowPace', EMOTIONAL_TURN: 'lowEnergy' };

/**
 * The words of a moment: the script's feeling and its manner (energy, then
 * pace), two at most — "[curious, quiet]", "[quiet, deliberate]"; for a turn
 * the script gives no delivery, its manner alone. Null when there is nothing
 * to say.
 */
function momentWords(d: ScriptDelivery, turn: PauseReason | null, rules: PerformanceRules): Pick<PerformanceIntent, 'emotion' | 'delivery'> | null {
  const w = rules.deliveryWords;
  // One word once: rules may give energy and pace the same word.
  const manner = [d.energy === 'LOW' ? w.lowEnergy : d.energy === 'HIGH' ? w.highEnergy : null, d.pace === 'SLOW' ? w.slowPace : d.pace === 'FAST' ? w.fastPace : null].filter((x, i, all): x is string => !!x && all.indexOf(x) === i);
  const feeling = emotionWord(d.emotion, rules);
  if (feeling) return { emotion: feeling, delivery: manner[0] ?? null };
  if (manner.length === 2) return { emotion: manner[0]!, delivery: manner[1]! };
  if (manner.length === 1) return { emotion: null, delivery: manner[0]! };
  const turnManner = turn ? TURN_MANNER[turn] : undefined;
  return turnManner ? { emotion: null, delivery: w[turnManner] } : null;
}

function expressive(sentences: readonly PreparedSentence[], pauses: ChunkPauses, rules: PerformanceRules): PerformanceMark[] {
  const house = restrained(sentences, rules);
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
    const words = momentWords(s.delivery, c.turn, rules);
    // A moment says more than the house style would there.
    if (!words) continue;
    const intent: PerformanceIntent = { ...words, intensity: 'LOW', pacing: s.delivery.pace, vocalAction: null };
    const moment: PerformanceMark = { sentence: c.sentence, intent, source: 'STRATEGY', reason: `expressive moment: ${c.turn ? `after a ${c.turn.toLowerCase().replace('_', ' ')} pause` : `block ${s.blockKey}: the script marks it ${describe(s.delivery)}`}` };
    if (isHouseDirection(moment, sentences, rules)) continue;
    // Never on consecutive short sentences: the rules' words or more from the directions before and after it.
    const before = house.filter((m) => m.sentence < c.sentence && !isReset(m.intent, rules)).at(-1);
    const after = house.find((m) => m.sentence > c.sentence && !isReset(m.intent, rules));
    if (before && wordsBetween(sentences, before.sentence, c.sentence) < rules.minWordsBetweenMarks) continue;
    if (after && wordsBetween(sentences, c.sentence, after.sentence) < rules.minWordsBetweenMarks) continue;
    // The moment colours its block, as the house style's directions do; the next block goes back to the direction the house style has in force there.
    return overlay(house, [moment], (m, marks) => {
      const next = sentences.findIndex((x, i) => i > m.sentence && x.blockStart);
      if (next < 0 || marks.some((x) => x.sentence > m.sentence && x.sentence <= next)) return null;
      const back = inForceAt(house, next);
      const key = sentences[next]!.blockKey;
      return back && !isReset(back.intent, rules)
        ? { sentence: next, intent: back.intent, source: 'STRATEGY', reason: `block ${key}: back to the house style after the expressive moment (the direction of sentence ${back.sentence + 1})` }
        : { sentence: next, intent: reset(rules), source: 'STRATEGY', reason: `block ${key}: back to the plain register after the expressive moment (a direction carries forward)` };
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

/** The directions for one chunk under a profile's rules: the strategy's, with the director's laid over them (each for its one sentence). */
export function performanceMarks(sentences: readonly PreparedSentence[], strategy: PerformanceStrategy, pauses: ChunkPauses, director?: readonly DirectorMark[], rules: PerformanceRules = EARLIER_PERFORMANCE_RULES): PerformanceMark[] {
  const base = strategy === 'PLAIN' ? [] : strategy === 'DIRECTED' ? directed(sentences, rules) : strategy === 'EXPRESSIVE' ? expressive(sentences, pauses, rules) : restrained(sentences, rules);
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
    return inForce && !isReset(inForce.intent, rules)
      ? { sentence: next, intent: inForce.intent, source: 'DIRECTOR', reason: `back to the direction of sentence ${inForce.sentence + 1} after the director's (a direction carries forward)` }
      : { sentence: next, intent: reset(rules), source: 'DIRECTOR', reason: "back to the plain register after the director's direction (a direction carries forward)" };
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
