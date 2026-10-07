import type { ShotSpec, SpecificKind, StorySequenceV2 } from '@docengine/core';
import { wordTokens } from '@docengine/story/shared';

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

const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** The content words of an avoid item. */
export const avoidWords = (item: string) => [...new Set(wordTokens(item).filter((w) => w.length >= 3 && !GENERIC.has(w)).map(stem))];

/** What a shot shows, in words (not what it must avoid). */
export function visibleText(spec: Pick<ShotSpec, 'description' | 'composition' | 'environment' | 'objects' | 'specifics' | 'overlays' | 'mustShow' | 'lighting'>, actions: readonly string[] = []): string {
  return [spec.description, spec.composition, spec.environment.description, spec.lighting, ...spec.objects.map((o) => o.name), ...spec.specifics.map((s) => s.detail), ...spec.overlays.map((o) => o.text), ...spec.mustShow.map((m) => m.detail), ...actions].join('\n');
}

/** Avoid items whose content words all appear in the text. */
export function avoidedMatches(text: string, avoid: readonly string[]): string[] {
  const words = new Set(wordTokens(text).map(stem));
  return avoid.filter((item) => {
    const ws = avoidWords(item);
    return ws.length > 0 && ws.every((w) => words.has(w));
  });
}

/** Specific kinds whose period look a person should check against a date. */
export const PERIOD_KINDS: readonly SpecificKind[] = ['TECHNOLOGY', 'UNIFORM', 'CLOTHING', 'ARCHITECTURE', 'DOCUMENT'];

/** Period details in a dated sequence that rest only on the period's look, or on nothing. */
export function periodDetails(spec: Pick<ShotSpec, 'specifics'>, sequence: StorySequenceV2 | null): string[] {
  if (!sequence?.setting.date.value.trim()) return [];
  return spec.specifics.filter((s) => PERIOD_KINDS.includes(s.kind) && (s.basis === 'PERIOD_GENERIC' || s.basis === 'INVENTED')).map((s) => s.detail);
}
