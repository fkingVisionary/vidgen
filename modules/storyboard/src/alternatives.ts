import {
  GENERATED_VIDEO_METHODS,
  TREATMENT_CLASS_RULES,
  TREATMENT_METHODS,
  roundUsd,
  sumUsd,
  type CostAlternative,
  type ContinuitySpec,
  type ProductionMethod,
  type VisualCostEstimate,
  type VisualTreatment,
} from '@docengine/core';
import type { PlannedShot, StoryboardFacts } from './draft.ts';
import { sha256 } from './hash.ts';
import { isFictional, isReal } from './inherit.ts';
import { rollupBasis, routeShot } from './route.ts';

/**
 * Cheaper ways to show the same moments (§17), computed deterministically
 * from the same router and catalog: generated video as animated stills, as
 * a single generated still moved in the edit, as the sourced record where
 * the shot already shows its source, or as an environment the version
 * already has. Only treatments the class matrix allows for the shot are
 * proposed, grouped by section; applying one is an edit that makes a new
 * version. Nothing is ever downgraded automatically.
 */

interface Target {
  treatment: VisualTreatment;
  method: ProductionMethod;
  label: string;
  tradeoff: string;
  /** The shot whose asset it would reuse (only the environment seen again). */
  reuseOf?: string;
}

const STILLS: Omit<Target, 'treatment'> = { method: 'STILL_MOTION', label: 'animated stills', tradeoff: 'The picture moves only by camera moves over a still: no action on screen' };
const GENERATED_STILL: Target = { treatment: 'GENERATED_STILL', method: 'STILL_MOTION', label: 'generated stills moved in the edit', tradeoff: 'One generated frame per shot, moved in the edit: no action, less atmosphere' };
const DOCUMENT: Target = { treatment: 'DOCUMENT_ANIMATION', method: 'DOCUMENT_MOTION', label: 'the sourced documents', tradeoff: 'Shows the record itself instead of a reconstruction: less atmosphere, stronger evidence' };
const ARCHIVAL: Target = { treatment: 'ARCHIVAL_IMAGE', method: 'ARCHIVAL_SOURCING', label: 'archival images', tradeoff: 'Shows the period through its own images (licensing applies): no reconstruction' };

/** A shot of a place with no one in it and no depicted claim: an environment's asset can stand for it. */
const emptyPlace = (s: PlannedShot) => s.subjects.length === 0 && !s.claims.some((c) => c.role === 'DEPICTS');

/** What a shot could become instead of generated video, in the order offered. */
function targetsFor(shot: PlannedShot, environments: ReadonlyMap<string, PlannedShot>): Target[] {
  const out: Target[] = [];
  const t = shot.treatment!;
  if (TREATMENT_METHODS[t].includes('STILL_MOTION')) out.push({ treatment: t, ...STILLS });
  if (t !== 'GENERATED_STILL') out.push(GENERATED_STILL);
  if (shot.claims.some((c) => c.role === 'SHOWS_SOURCE')) out.push(DOCUMENT, ARCHIVAL);
  // Only a shot that shows no one and depicts nothing can become the place seen again (otherwise it would be its own asset, not a reuse);
  // generated footage lasts as long as it was made, so a longer shot cannot reuse it.
  const env = shot.spec.environment.subjectKey && emptyPlace(shot) ? environments.get(shot.spec.environment.subjectKey) : undefined;
  const lasts = (s: PlannedShot) => (s.startMs !== null && s.endMs !== null ? s.endMs - s.startMs : 0);
  if (env && env.key !== shot.key && env.method && (!GENERATED_VIDEO_METHODS.includes(env.method) || lasts(shot) <= lasts(env))) out.push({ treatment: 'ENVIRONMENT', method: env.method, reuseOf: env.key, label: `the environment ${env.key} already shows`, tradeoff: `Reuses ${env.key}'s environment: the same place seen again, nothing happening in it` });
  return out.filter((x) => shot.infoClass !== null && TREATMENT_CLASS_RULES[x.treatment][shot.infoClass].allowed);
}

const total = (costs: readonly (VisualCostEstimate | null)[]) => (costs.some((c) => c === null || c.totalUsd === null) ? null : sumUsd(costs.map((c) => c!.totalUsd)));

/** Cheaper alternatives for the version's generated-video shots, by section and target (only those that save money at known prices). */
export function costAlternatives(shots: readonly PlannedShot[], subjects: ReadonlyMap<string, { spec: ContinuitySpec }>, facts: StoryboardFacts): CostAlternative[] {
  const profile = facts.profile.effective;
  const environments = new Map<string, PlannedShot>();
  for (const s of shots) if (s.treatment === 'ENVIRONMENT' && s.spec.environment.subjectKey && emptyPlace(s) && !environments.has(s.spec.environment.subjectKey)) environments.set(s.spec.environment.subjectKey, s);
  const groups = new Map<string, { target: Target; section: string; from: { treatment: VisualTreatment; method: ProductionMethod }; shots: { shot: PlannedShot; after: VisualCostEstimate }[] }>();
  for (const shot of shots) {
    if (shot.unplanned || !shot.method || !GENERATED_VIDEO_METHODS.includes(shot.method) || shot.startMs === null || shot.endMs === null) continue;
    const specs = shot.subjects.flatMap((s) => (subjects.get(s.subjectKey) ? [subjects.get(s.subjectKey)!.spec] : []));
    for (const target of targetsFor(shot, environments)) {
      const after = routeShot({ treatment: target.treatment, method: target.method, durationMs: shot.endMs - shot.startMs, realPerson: specs.some(isReal), fictionalSubject: specs.some(isFictional), recommendation: null, reuseOf: target.reuseOf ?? null }, profile, facts.catalog).estimate;
      const id = `alt-${shot.sectionKey.toLowerCase()}-${sha256([shot.treatment, shot.method, target.treatment, target.method, target.label].join('|')).slice(0, 10)}`;
      const g = groups.get(id) ?? { target, section: shot.sectionKey, from: { treatment: shot.treatment!, method: shot.method }, shots: [] };
      g.shots.push({ shot, after });
      groups.set(id, g);
    }
  }
  const out: CostAlternative[] = [];
  for (const [id, g] of groups) {
    const beforeUsd = total(g.shots.map((x) => x.shot.cost));
    const afterUsd = total(g.shots.map((x) => x.after));
    const savingUsd = beforeUsd === null || afterUsd === null ? null : roundUsd(beforeUsd - afterUsd);
    if (savingUsd === null || savingUsd <= 0) continue;
    const n = g.shots.length;
    const seq = facts.spine.sections.find((s) => s.key === g.section)?.sequence ?? g.section;
    out.push({
      id,
      title: `Replace ${n} generated video shot${n === 1 ? '' : 's'} in section ${seq} with ${g.target.label}`,
      shotKeys: g.shots.map((x) => x.shot.key),
      from: g.from,
      to: { treatment: g.target.treatment, method: g.target.method },
      beforeUsd,
      afterUsd,
      savingUsd,
      basis: rollupBasis(g.shots.map((x) => x.after)),
      tradeoff: g.target.tradeoff,
    });
  }
  return out.sort((a, b) => (b.savingUsd ?? 0) - (a.savingUsd ?? 0) || a.id.localeCompare(b.id));
}
