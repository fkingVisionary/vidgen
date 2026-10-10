import type { ShotSpec, SpecificKind, StorySequenceV2 } from '@docengine/core';
import { normalize, wordTokens } from '@docengine/story/shared';

/**
 * Anachronism risk (§2.10, a warning for a person to check). No dates of
 * inventions live in code — they would be unsourced facts. Two things are
 * checked instead: a shot's own words that match something the script or
 * the sequence said to avoid, and period details (technology, uniforms,
 * clothing, architecture, documents) that rest on nothing more than the
 * period's look in a sequence with a date.
 */

/** Words that carry no meaning in an avoid list ("no modern clothing" is about "modern clothing"). */
const GENERIC = new Set(
  'a an the and or of in on at to for with without no not never any anything avoid avoiding use using show shows showing shown depict depicting visible see seen shot shots image images picture pictures footage scene scenes'.split(' '),
);

/** A comparison key for a word, the same for both numbers ("notes"/"note", "houses"/"house", "buses"/"bus", "heroes"/"hero", "glasses"/"glass", "notaries"/"notary"). */
export const stem = (w: string) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  const one = w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
  // "-es" after a single s or an o can be either "-e"+"s" or "-es" (houses/buses, shoes/heroes): drop that e in both numbers.
  return one.length >= 4 && /[so]e$/.test(one) ? one.slice(0, -1) : one;
};

const content = (w: string) => w.length >= 3 && !GENERIC.has(w);

/** The content words of an avoid item. */
export const avoidWords = (item: string) => [...new Set(wordTokens(item).filter(content).map(stem))];

/** What a shot shows, in words (not what it must avoid). */
export function visibleText(spec: Pick<ShotSpec, 'description' | 'composition' | 'environment' | 'objects' | 'specifics' | 'overlays' | 'mustShow' | 'lighting'>, actions: readonly string[] = []): string {
  return [spec.description, spec.composition, spec.environment.description, spec.lighting, ...spec.objects.map((o) => o.name), ...spec.specifics.map((s) => s.detail), ...spec.overlays.map((o) => o.text), ...spec.mustShow.map((m) => m.detail), ...actions].join('\n');
}

/** Words that say what follows is absent ("no electric light", "without modern clothing"). */
const NEGATIONS = new Set(['no', 'not', 'without', 'never', 'neither', 'nor', 'non', 'avoid', 'avoiding', 'avoids', 'excluding']);
/** "no one", "not only"… negate nothing that follows. */
const NOT_NEGATING = new Set(['one', 'longer', 'only', 'matter', 'doubt']);
/** A negation reaches no further than its clause (or the field: visibleText puts each on its own line). */
const CLAUSE = /[.;:,!?()[\]\n—–]+|\s(?:but|while|whereas|although|though|except)\s/i;
/** Words that open another phrase: a negation that has reached a word ends there ("no coat in modern clothing", "no shutters and glass windows"). */
const PHRASE = new Set(['in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'under', 'over', 'behind', 'beside', 'near', 'through', 'across', 'against', 'and', 'as', 'to', 'for']);

/**
 * The words a text shows, read for a phrase of `n` content words: every word
 * but those a negation reaches in its clause — the content words after it, at
 * most max(n, 2) ("no modern cars"), ending at a word that opens another
 * phrase once one is reached, and again after an "or" ("no electric light or
 * modern clothing"). A phrase must show all its words, so one negated word is
 * enough ("no modern glass windows"). "A man without a coat in modern
 * clothing" and "a man with no hat wears modern clothing" still show modern
 * clothing. Not read: a negation after the words ("electric light is not
 * visible"), "free of", "absent", "don't", and comma-separated lists.
 */
export function shownWords(text: string, n: number): Set<string> {
  const reach = Math.max(n, 2);
  const out = new Set<string>();
  for (const clause of text.split(CLAUSE)) {
    const tokens = wordTokens(clause);
    let left = 0;
    let reached = false;
    let negating = false;
    tokens.forEach((t, i) => {
      if ((NEGATIONS.has(t) && !NOT_NEGATING.has(tokens[i + 1] ?? '')) || (t === 'or' && negating)) {
        left = reach;
        reached = false;
        negating = true;
        return;
      }
      if (left > 0 && !(reached && PHRASE.has(t))) {
        if (content(t) && t !== 'yet') {
          left--;
          reached = true;
        }
        return;
      }
      if (PHRASE.has(t)) negating = false;
      left = 0;
      out.add(stem(t));
    });
  }
  return out;
}

/** Whether one sentence of the text (a field, or up to a full stop) shows all these content words, outside a negation: words scattered over a long description name nothing together. */
export function showsAll(text: string, words: readonly string[]): boolean {
  if (!words.length) return false;
  return text.split(/[.;!?\n]+/).some((sentence) => {
    const shown = shownWords(sentence, words.length);
    return words.every((w) => shown.has(w));
  });
}

/** Avoid items whose content words all appear in the text, outside a negation (each item once, whatever its case). */
export function avoidedMatches(text: string, avoid: readonly string[]): string[] {
  const seen = new Set<string>();
  return avoid.filter((item) => {
    const key = normalize(item);
    if (seen.has(key)) return false;
    seen.add(key);
    const ws = avoidWords(item);
    if (!ws.length) return false;
    const words = shownWords(text, ws.length);
    return ws.every((w) => words.has(w));
  });
}

/** Specific kinds whose period look a person should check against a date. */
export const PERIOD_KINDS: readonly SpecificKind[] = ['TECHNOLOGY', 'UNIFORM', 'CLOTHING', 'ARCHITECTURE', 'DOCUMENT'];

/** Period details in a dated sequence that rest only on the period's look, or on nothing. */
export function periodDetails(spec: Pick<ShotSpec, 'specifics'>, sequence: StorySequenceV2 | null): string[] {
  if (!sequence?.setting.date.value.trim()) return [];
  return spec.specifics.filter((s) => PERIOD_KINDS.includes(s.kind) && (s.basis === 'PERIOD_GENERIC' || s.basis === 'INVENTED')).map((s) => s.detail);
}
