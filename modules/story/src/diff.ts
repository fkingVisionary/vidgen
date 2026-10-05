import { isArchitectureV2, type AnyStoryArchitectureContent, type ArchitectureDiff, type RevisionAspect, type StoryArchitectureContentV2 } from '@docengine/core';
import { normalize } from './text.ts';

/**
 * What a revision actually changed against the version it revised, computed
 * from the two architectures — the editor's check on the architect's own
 * account (its change log). Works with an engine-1 base too (fewer fields).
 */
export function diffArchitectures(before: AnyStoryArchitectureContent, after: StoryArchitectureContentV2): ArchitectureDiff {
  const b2 = isArchitectureV2(before) ? before : null;
  const unitsBefore = firstAppearance(before.sequences.map((s) => s.candidateKeys));
  const unitsAfter = firstAppearance(after.sequences.map((s) => s.candidateKeys));
  const shared = unitsBefore.filter((k) => unitsAfter.includes(k));
  const orderAfter = unitsAfter.filter((k) => shared.includes(k));

  const groupsBefore = before.sequences.map((s) => [...new Set(s.candidateKeys)]);
  const groupsAfter = after.sequences.map((s) => [...new Set(s.candidateKeys)]);
  const together = (groups: string[][], keys: string[]) => groups.some((g) => keys.every((k) => g.includes(k)));
  const merged = groupsAfter
    .map((g) => g.filter((k) => unitsBefore.includes(k)))
    .filter((g) => g.length >= 2 && !together(groupsBefore, g));
  const split = groupsBefore
    .map((g) => g.filter((k) => unitsAfter.includes(k)))
    .filter((g) => g.length >= 2 && !together(groupsAfter, g));

  const openingOf = (c: AnyStoryArchitectureContent) => {
    if (isArchitectureV2(c)) {
      const first = c.sequences[0];
      return first ? { units: [...first.candidateKeys].sort().join(','), text: `${first.title}: ${first.beats[0]?.description ?? first.openingHook}` } : { units: '', text: '' };
    }
    const first = c.sequences[0];
    return first ? { units: [...first.candidateKeys].sort().join(','), text: `${first.title}: ${first.openingHook}` } : { units: '', text: '' };
  };
  const ob = openingOf(before);
  const oa = openingOf(after);
  const change = (x: string, y: string) => ({ changed: normalize(x) !== normalize(y), before: x, after: y });
  const pov = (c: StoryArchitectureContentV2 | null) => (c ? `${c.povStrategy.type}${c.povStrategy.description ? `: ${c.povStrategy.description}` : ''}` : '');
  const castNames = (c: StoryArchitectureContentV2 | null) => (c ? c.cast.map((m) => m.name) : []);
  const total = (c: AnyStoryArchitectureContent) => c.sequences.reduce((n, s) => n + s.estimatedDurationSec, 0);
  const beats = (c: AnyStoryArchitectureContent) => (isArchitectureV2(c) ? c.sequences.reduce((n, s) => n + s.beats.length, 0) : c.sequences.reduce((n, s) => n + s.keyEvents.length, 0));

  const diff: ArchitectureDiff = {
    substantial: false,
    sequences: { before: before.sequences.length, after: after.sequences.length, titlesBefore: before.sequences.map((s) => s.title), titlesAfter: after.sequences.map((s) => s.title) },
    unitsBefore,
    unitsAfter,
    unitsAdded: unitsAfter.filter((k) => !unitsBefore.includes(k)),
    unitsRemoved: unitsBefore.filter((k) => !unitsAfter.includes(k)),
    reordered: shared.join() !== orderAfter.join(),
    merged,
    split,
    opening: { changed: ob.units !== oa.units || normalize(ob.text) !== normalize(oa.text), before: ob.text, after: oa.text },
    centralQuestion: change(before.centralQuestion, after.centralQuestion),
    narrativeMode: change(b2?.narrativeMode ?? '', after.narrativeMode),
    pov: change(pov(b2), pov(after)),
    logline: change(isArchitectureV2(before) ? before.logline : before.premise, after.logline),
    humanStakes: change(b2?.centralHumanStakes ?? '', after.centralHumanStakes),
    castAdded: castNames(after).filter((n) => !castNames(b2).includes(n)),
    castRemoved: castNames(b2).filter((n) => !castNames(after).includes(n)),
    durationSec: { before: total(before), after: total(after) },
    beats: { before: beats(before), after: beats(after) },
    reconstruction: { before: b2?.reconstruction.level ?? 'n/a', after: after.reconstruction.level },
  };
  diff.substantial =
    diff.unitsAdded.length > 0 ||
    diff.unitsRemoved.length > 0 ||
    diff.reordered ||
    diff.merged.length > 0 ||
    diff.split.length > 0 ||
    diff.sequences.before !== diff.sequences.after ||
    diff.opening.changed ||
    diff.centralQuestion.changed ||
    diff.narrativeMode.changed ||
    diff.pov.changed;
  return diff;
}

/** Keys in order of first appearance across the groups. */
function firstAppearance(groups: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const g of groups) for (const k of g) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * The aspects the editor ticked that show no measurable change in the diff.
 * A warning for the editor (the change log may explain a subtler change),
 * never a failure.
 */
export function unaddressedAspects(aspects: readonly RevisionAspect[], d: ArchitectureDiff): RevisionAspect[] {
  const structure = d.reordered || d.merged.length > 0 || d.split.length > 0 || d.unitsAdded.length > 0 || d.unitsRemoved.length > 0 || d.sequences.before !== d.sequences.after;
  const addressed: Record<RevisionAspect, boolean> = {
    ANGLE: d.logline.changed || d.centralQuestion.changed || d.narrativeMode.changed,
    POV: d.pov.changed,
    EMOTIONAL_CENTRE: d.humanStakes.changed || d.logline.changed,
    OPENING: d.opening.changed,
    STRUCTURE: structure,
    PACING: structure || d.durationSec.before !== d.durationSec.after || d.beats.before !== d.beats.after,
    NARRATIVE_STRATEGY: d.narrativeMode.changed || d.pov.changed || structure,
    CENTRAL_QUESTION: d.centralQuestion.changed,
    HUMAN_STAKES: d.humanStakes.changed,
  };
  return [...new Set(aspects)].filter((a) => !addressed[a]);
}
