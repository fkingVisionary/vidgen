import {
  historicalConfidenceOf,
  historicalStatusOf,
  type AngleComparison,
  type StoryAngle,
  type StoryArchitectureContentV2,
} from '@docengine/core';
import { coreClaimsOf, outsidePeople, peopleMentioned, type SelectedUnit } from './architecture.ts';
import type { EvidenceBase } from './evidence.ts';
import { SECOND_PERSON, checkFigures, orderedKeys } from './rules.ts';
import type { AnglesOutput } from './schemas.ts';
import { quoteFoundIn, quotedPassages, titleSimilarity, unknownProperNouns } from './text.ts';

export interface BuiltAngles {
  angles: StoryAngle[];
  removed: { title: string; reason: string }[];
  notes: string[];
  comparisons: AngleComparison[];
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const NO_REASON = 'No reason given.';

/** The dimensions that make two approaches different films (the rest is wording). */
const CORE_DIFFERENCES = ['narrative mode', 'POV', 'opening', 'human anchor'] as const;

interface Comparable {
  narrativeMode: string;
  pov: string;
  openingUnit: string | null;
  opening: string;
  anchor: string;
  centralQuestion: string;
  units: string[];
}

function differences(a: Comparable, b: Comparable): string[] {
  const out: string[] = [];
  if (a.narrativeMode !== b.narrativeMode) out.push('narrative mode');
  if (a.pov !== b.pov) out.push('POV');
  if ((a.openingUnit ?? '') !== (b.openingUnit ?? '') || titleSimilarity(a.opening, b.opening) < 0.5) out.push('opening');
  if (titleSimilarity(a.anchor, b.anchor) < 0.5) out.push('human anchor');
  if (titleSimilarity(a.centralQuestion, b.centralQuestion) < 0.6) out.push('central question');
  if (a.units.join() !== b.units.join()) out.push('structure');
  return out;
}

/** A different film: two core differences, or one with a different question and structure. */
function materiallyDifferent(diff: readonly string[]): boolean {
  const core = diff.filter((d) => (CORE_DIFFERENCES as readonly string[]).includes(d)).length;
  return core >= 2 || (core >= 1 && diff.includes('central question') && diff.includes('structure'));
}

const comparable = (a: StoryAngle): Comparable => ({
  narrativeMode: a.narrativeMode,
  pov: a.povStrategy.type,
  openingUnit: a.opening.unitKey,
  opening: a.opening.concept,
  anchor: `${a.humanAnchor} ${a.emotionalCentre}`,
  centralQuestion: a.centralQuestion,
  units: a.unitKeys,
});

function architectureComparable(c: StoryArchitectureContentV2): Comparable {
  const first = c.sequences[0];
  const units: string[] = [];
  for (const s of c.sequences) for (const k of s.candidateKeys) if (!units.includes(k)) units.push(k);
  return {
    narrativeMode: c.narrativeMode,
    pov: c.povStrategy.type,
    openingUnit: first?.candidateKeys[0] ?? null,
    opening: first?.beats[0]?.description ?? first?.openingHook ?? '',
    anchor: c.centralHumanStakes,
    centralQuestion: c.centralQuestion,
    units,
  };
}

/**
 * Apply the rules to the angles proposed for a story pack. Every angle stays
 * inside the evidence boundary — only the pack's units (the selection, and
 * units the editor approved but did not select), their claims, no new
 * figures, years, people, names or quotations — and must be a materially
 * different film from every other angle (and from the current architecture,
 * when exploring alternatives to it). An angle that breaks a rule is removed
 * with its reason; at most `count` are kept.
 */
export function buildAngles(raw: AnglesOutput, units: readonly SelectedUnit[], evidence: EvidenceBase, opts: { count: number; base: StoryArchitectureContentV2 | null; baseVersion: number | null }): BuiltAngles {
  const removed: BuiltAngles['removed'] = [];
  const notes: string[] = [];
  const byKey = new Map(units.map((u) => [u.key, u]));
  const poolClaims = coreClaimsOf(units, evidence);
  const outsiders = outsidePeople(evidence, poolClaims);
  const known = { has: (w: string) => evidence.dossierWords().has(w) };
  const kept: StoryAngle[] = [];

  raw.angles.forEach((r, i) => {
    const title = clean(r.title) || `(untitled ${i + 1})`;
    const remove = (reason: string) => removed.push({ title, reason });
    const angleNotes: string[] = [];
    if (!clean(r.title) || !clean(r.logline) || !clean(r.centralQuestion) || r.movements.length === 0) {
      remove('incomplete: a title, logline, central question and movements are required');
      return;
    }

    // Units: only the pack's, in order of first appearance.
    const unknown = new Set<string>();
    const movements = r.movements
      .map((m) => {
        const keys = [...new Set(m.unitKeys.map((k) => k.trim()))].filter((k) => {
          if (byKey.has(k)) return true;
          if (k) unknown.add(k);
          return false;
        });
        return { title: clean(m.title), unitKeys: keys, what: clean(m.what) };
      })
      .filter((m) => m.title || m.what);
    let openingUnit: string | null = clean(r.opening.unitKey) || null;
    if (openingUnit && !byKey.has(openingUnit)) {
      unknown.add(openingUnit);
      openingUnit = null;
    }
    if (unknown.size) angleNotes.push(`not units of the story pack, dropped: ${[...unknown].join(', ')}`);
    const unitKeys: string[] = [];
    for (const k of [...(openingUnit ? [openingUnit] : []), ...movements.flatMap((m) => m.unitKeys)]) if (!unitKeys.includes(k)) unitKeys.push(k);
    if (unitKeys.length < 2) {
      remove(`tells fewer than two story units of the pack${unknown.size ? ` (${[...unknown].join(', ')} are not units of the pack)` : ''}`);
      return;
    }
    const used = units.filter((u) => unitKeys.includes(u.key));
    const claimKeys = orderedKeys(used.flatMap((u) => u.claimKeys), evidence);

    // The opening's information class, as for a cold open: a second-person scene is a reconstruction,
    // and documented fact rests on ESTABLISHED claims only.
    let basis = r.opening.basis;
    const opening = clean(r.opening.concept);
    const openingClaims = openingUnit ? byKey.get(openingUnit)!.claimKeys : [];
    if (basis === 'DOCUMENTED' && SECOND_PERSON.test(opening)) {
      basis = 'RECONSTRUCTION';
      angleNotes.push('the opening addresses the viewer: labelled RECONSTRUCTION, not DOCUMENTED');
    } else if (basis === 'DOCUMENTED' && openingClaims.some((k) => evidence.claim(k)?.verdict !== 'ESTABLISHED')) {
      basis = 'UNCERTAIN';
      angleNotes.push('the opening rests on claims that are not ESTABLISHED: labelled UNCERTAIN, not DOCUMENTED');
    }

    // No new facts: figures and years from the units' evidence, no outside or unknown people, no unverified quotations.
    const texts = [title, r.logline, r.centralQuestion, r.emotionalCentre, r.humanAnchor, opening, r.povStrategy.description, r.resolution, r.differs, ...movements.flatMap((m) => [m.title, m.what]), ...r.strengths, ...r.risks, ...r.unusedUnits.map((u) => u.reason)].map(clean);
    const figures = checkFigures(texts, claimKeys, evidence, { linkFrom: poolClaims, strictYears: true });
    if (figures.unsupported.length) {
      remove(`uses figures that are not in the story units' evidence: ${figures.unsupported.join(', ')}`);
      return;
    }
    const outside = peopleMentioned(texts, outsiders);
    if (outside.length) {
      remove(`names ${outside.join(', ')}, who is not in the story units' evidence`);
      return;
    }
    const names = unknownProperNouns(texts.join('\n'), known);
    if (names.length) {
      remove(`names ${names.join(', ')}, which the evidence does not know (fictional devices are described, not named)`);
      return;
    }
    const quote = quotedPassages(texts.join('\n')).find((q) => !claimKeys.some((k) => evidence.verifiedQuotes(k).some((v) => quoteFoundIn(q, v))));
    if (quote) {
      remove(`puts "${quote}" in quotation marks, but it is not a verified quotation of the units' evidence`);
      return;
    }

    // Selected units left out: each with a reason; HIGH priority flagged for the editor.
    const reasons = new Map(r.unusedUnits.map((u) => [u.unitKey.trim(), clean(u.reason)]));
    const unusedUnits = units.filter((u) => !u.reserve && !unitKeys.includes(u.key)).map((u) => ({ unitKey: u.key, reason: reasons.get(u.key) || NO_REASON }));
    const warnings = units.filter((u) => !u.reserve && u.priority === 'HIGH' && !unitKeys.includes(u.key)).map((u) => `leaves out ${u.key} "${u.title}", which the editor marked HIGH priority`);
    const reserveUsed = used.filter((u) => u.reserve).map((u) => u.key);
    if (reserveUsed.length) angleNotes.push(`uses ${reserveUsed.join(', ')}, approved by the editor but not selected`);

    kept.push({
      key: '',
      title,
      logline: clean(r.logline),
      centralQuestion: clean(r.centralQuestion),
      emotionalCentre: clean(r.emotionalCentre),
      humanAnchor: clean(r.humanAnchor),
      narrativeMode: r.narrativeMode,
      secondaryModes: [...new Set(r.secondaryModes)].filter((m) => m !== r.narrativeMode),
      povStrategy: { type: r.povStrategy.type, description: clean(r.povStrategy.description) },
      opening: { concept: opening, basis, unitKey: openingUnit },
      movements,
      resolution: clean(r.resolution),
      unitKeys,
      unusedUnits,
      claimKeys,
      historicalStatus: historicalStatusOf(claimKeys.map((k) => evidence.claim(k)!.verdict)),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(claimKeys)),
      differs: clean(r.differs),
      strengths: r.strengths.map(clean).filter(Boolean),
      risks: r.risks.map(clean).filter(Boolean),
      warnings,
      notes: angleNotes,
    });
  });

  // Materially different films: from each other, and from the architecture they are alternatives to.
  const distinct: StoryAngle[] = [];
  const base = opts.base ? architectureComparable(opts.base) : null;
  for (const a of kept) {
    if (base) {
      const d = differences(comparable(a), base);
      if (!materiallyDifferent(d)) {
        removed.push({ title: a.title, reason: `too close to architecture v${opts.baseVersion}: it differs only in ${d.join(', ') || 'wording'}` });
        continue;
      }
    }
    const twin = distinct.map((b) => ({ b, d: differences(comparable(a), comparable(b)) })).find((x) => !materiallyDifferent(x.d));
    if (twin) {
      removed.push({ title: a.title, reason: `too close to "${twin.b.title}": it differs only in ${twin.d.join(', ') || 'wording'}` });
      continue;
    }
    distinct.push(a);
  }
  for (const a of distinct.slice(opts.count)) removed.push({ title: a.title, reason: `beyond the ${opts.count} angles asked for` });
  const angles = distinct.slice(0, opts.count).map((a, i) => ({ ...a, key: `A${i + 1}` }));
  const comparisons: AngleComparison[] = [];
  for (let i = 0; i < angles.length; i++) for (let j = i + 1; j < angles.length; j++) comparisons.push({ a: angles[i]!.key, b: angles[j]!.key, differences: differences(comparable(angles[i]!), comparable(angles[j]!)) });
  notes.push(`Angles: ${raw.angles.length} proposed, ${angles.length} kept, ${removed.length} removed`);
  return { angles, removed, notes, comparisons };
}
