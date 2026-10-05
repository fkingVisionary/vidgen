import type { RhythmProfile } from '@docengine/core';
import { normalize, wordTokens } from '@docengine/story/shared';
import { withoutAsides } from './fingerprints.ts';
import { clip, maskQuotes, narrationOnly, narratorSentences, sentencesOf, type NarrationBlock } from './text.ts';

/**
 * How the narration moves when spoken: sentence lengths and their spread,
 * fragments, long sentences, clauses, punctuation, repeated openings,
 * same-length runs, endings that repeat, and tongue-twisters. Signals for an
 * editor — organic variation is the aim, never a target length.
 */

const CLAUSE = /,|\b(?:and|but|or|which|who|whom|whose|that|while|when|because|although|though|whereas|if|unless|until|since|after|before)\b/g;
const PUNCTUATION = /[,;:—–()]/g;

/** Words with four or more consonant letters in a row ("strengths"): hard to say quickly. */
const CLUSTER = /[bcdfghjklmnpqrstvwxz]{4,}/;
/** Sounds that trip a narrator when they repeat at the start of neighbouring words. */
const ONSETS = ['str', 'spr', 'scr', 'shr', 'thr', 'sh', 'ch', 'th', 'st', 'sp', 'sl', 'sw', 'pr', 'br', 'tr', 'cr', 'gr', 'fr', 's', 'p', 'b', 't', 'k', 'c', 'f', 'w', 'm', 'r', 'l', 'g', 'd'];
const onset = (w: string) => ONSETS.find((o) => w.startsWith(o)) ?? w[0] ?? '';
const SIBILANT = /^(?:sh|ch|s[aeiouy]|z)/;

/** Function words a narrator glides over: they never make a tongue-twister. */
const GLIDE = new Set('the and that this then than they them their there these those was were with for from his her its our but not had has have who what when where which while some such into onto upon over under about after before could would should might must will shall'.split(' '));

/** A phrase a narrator is likely to trip over: four words of six starting alike, four sibilants in five words, or two consonant clusters in a sentence. */
export function tongueTwister(sentence: string): boolean {
  const w = wordTokens(sentence).filter((x) => x.length > 2 && !GLIDE.has(x));
  for (let i = 0; i <= Math.max(0, w.length - 6); i++) {
    const counts = new Map<string, number>();
    for (const x of w.slice(i, i + 6)) counts.set(onset(x), (counts.get(onset(x)) ?? 0) + 1);
    if ([...counts.values()].some((n) => n >= 4)) return true;
  }
  for (let i = 0; i + 4 <= w.length; i++) if (w.slice(i, i + 5).filter((x) => SIBILANT.test(x)).length >= 4) return true;
  return w.filter((x) => CLUSTER.test(x.replace(/y/g, 'a'))).length >= 2;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function rhythmProfile(blocks: readonly NarrationBlock[]): RhythmProfile {
  const all = narratorSentences(blocks).filter((s) => s.words > 0);
  const lengths = all.map((s) => s.words);
  const n = Math.max(lengths.length, 1);
  const mean = lengths.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  let longestFragmentRun = 0;
  let fragRun = 0;
  let repeatedOpenings = 0;
  let sameLengthRuns = 0;
  let run = 0;
  for (let i = 0; i < all.length; i++) {
    const s = all[i]!;
    const prev = all[i - 1];
    // A section boundary breaks every run, fragments included (as the AI-pattern check reads them).
    const sameSection = prev !== undefined && prev.section === s.section;
    fragRun = s.words <= 3 ? (sameSection ? fragRun : 0) + 1 : 0;
    longestFragmentRun = Math.max(longestFragmentRun, fragRun);
    if (sameSection) {
      const a = wordTokens(prev.text)[0];
      if (a && a === wordTokens(s.text)[0]) repeatedOpenings++;
      if (s.words >= 5 && Math.abs(s.words - prev.words) <= 2) {
        run++;
        if (run === 3) sameLengthRuns++;
      } else run = 0;
    } else run = 0;
  }
  const clauses = all.reduce((k, s) => k + 1 + (normalize(s.text).match(CLAUSE) ?? []).length, 0);
  const punctuation = all.reduce((k, s) => k + (s.text.match(PUNCTUATION) ?? []).length, 0);
  const narration = narrationOnly(blocks);
  let repeatedEnds = 0;
  for (let i = 1; i < narration.length; i++) {
    const end = (b: NarrationBlock) => {
      const last = sentencesOf(withoutAsides(b.text)).at(-1) ?? '';
      const w = wordTokens(last);
      return { short: w.length > 0 && w.length <= 4, word: w.at(-1) ?? '' };
    };
    const a = end(narration[i - 1]!);
    const b = end(narration[i]!);
    if ((a.short && b.short) || (b.word.length > 3 && a.word === b.word)) repeatedEnds++;
  }
  const tongueTwisters = narration.flatMap((b) => sentencesOf(maskQuotes(b.text)).filter(tongueTwister).map((s) => ({ ref: b.key, excerpt: clip(s, 80) })));
  return {
    sentences: lengths.length,
    meanWords: round(mean, 1),
    sdWords: round(sd, 1),
    variation: mean > 0 ? round(sd / mean) : 0,
    fragmentShare: round(lengths.filter((x) => x <= 3).length / n),
    longShare: round(lengths.filter((x) => x > 25).length / n),
    longestFragmentRun,
    clausesPerSentence: round(clauses / n),
    punctuationPerSentence: round(punctuation / n),
    repeatedOpenings,
    sameLengthRuns,
    endingRepetition: narration.length > 1 ? round(repeatedEnds / (narration.length - 1)) : 0,
    tongueTwisters,
  };
}
