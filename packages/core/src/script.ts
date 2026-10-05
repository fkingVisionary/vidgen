import type { ScriptDelivery, ScriptPause } from './contracts/script.ts';
import type { DeliveryPace, PauseLength } from './enums.ts';
import { runtimeFit, type RuntimeTarget } from './story.ts';

/**
 * Script timing, shared by the script stage, the API and the dashboard. All
 * deterministic: a block's duration comes from its spoken words, the
 * narration rate, its pace and its pauses — never from a model's estimate.
 */

export const CURRENT_SCRIPT_ENGINE = 1 as const;

export const SCRIPT_TIMING = {
  /** Documentary narration: a measured but conversational rate. */
  wordsPerMinute: 150,
  /** Speed of a block relative to the narration rate. */
  paceFactor: { SLOW: 0.88, NORMAL: 1, FAST: 1.12 } satisfies Record<DeliveryPace, number>,
  /** Seconds of silence per pause. */
  pauseSec: { NONE: 0, MICRO: 0.25, SHORT: 0.6, MEDIUM: 1.2, LONG: 2 } satisfies Record<PauseLength, number>,
} as const;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Words as a narrator says them. A figure is read as words: a year as two
 * ("sixteen thirty-seven"), other figures about one word per two digits
 * ("one thousand", "twelve thousand five hundred"). Punctuation is silent.
 */
export function spokenWordCount(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const digits = token.replace(/[^0-9]/g, '').length;
    if (digits > 0) n += Math.max(1, Math.ceil(digits / 2));
    else if (/\p{L}/u.test(token)) n += 1;
  }
  return n;
}

export const pauseSec = (p: ScriptPause) => SCRIPT_TIMING.pauseSec[p.length];

/** Seconds to speak a block: words at the narration rate, adjusted by pace, plus its pauses. */
export function blockDurationSec(text: string, delivery: Pick<ScriptDelivery, 'pace' | 'pauseBefore' | 'pauseAfter'>): number {
  const words = spokenWordCount(text);
  const speech = (words / (SCRIPT_TIMING.wordsPerMinute * SCRIPT_TIMING.paceFactor[delivery.pace])) * 60;
  return round1(speech + pauseSec(delivery.pauseBefore) + pauseSec(delivery.pauseAfter));
}

/** Words a section or script of `seconds` holds at the narration rate (pauses ignored). */
export const wordsForSeconds = (seconds: number) => Math.round((seconds / 60) * SCRIPT_TIMING.wordsPerMinute);

export interface ScriptTiming {
  words: number;
  totalSec: number;
  targetSec: number;
  minSec: number;
  maxSec: number;
  /** Total minus target: negative is short. */
  varianceSec: number;
  fit: 'WITHIN' | 'NEAR' | 'OFF';
}

export function scriptTiming(blocks: readonly { wordCount: number; estimatedDurationSec: number }[], target: RuntimeTarget): ScriptTiming {
  const totalSec = round1(blocks.reduce((n, b) => n + b.estimatedDurationSec, 0));
  return {
    words: blocks.reduce((n, b) => n + b.wordCount, 0),
    totalSec,
    targetSec: target.targetSec,
    minSec: target.minSec,
    maxSec: target.maxSec,
    varianceSec: round1(totalSec - target.targetSec),
    fit: runtimeFit(totalSec, target),
  };
}

/** "12:34" */
export function fmtClock(sec: number): string {
  const s = Math.round(Math.abs(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "−0:26" / "+1:05" / "0:00" */
export function fmtVariance(sec: number): string {
  const r = Math.round(sec);
  return r === 0 ? '0:00' : `${r < 0 ? '−' : '+'}${fmtClock(r)}`;
}
