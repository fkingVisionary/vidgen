import {
  DENSITY_TARGETS,
  DEPICTION_FOR,
  GENERATED_VIDEO_METHODS,
  TREATMENT_CLASS_RULES,
  VISUAL_APPROACHES,
  type ApproachSummary,
  type ContinuitySpec,
  type CostRollup,
  type ScriptBlockClass,
  type VisualApproach,
  type VisualBeatContent,
  type VisualCostEstimate,
  type VisualTreatment,
} from '@docengine/core';
import type { DraftBeat, PlannedBeat, PlannedShot, StoryboardDraft, StoryboardFacts } from './draft.ts';
import { isFictional, isReal } from './inherit.ts';
import { rollupTotal, routeShot } from './route.ts';

/**
 * Alternative visual approaches (§23, U6): A cinematic reconstruction, B
 * evidence-led (documents, maps, archival, graphics), C hybrid. Every beat
 * carries all three options, each checked against the class matrix; one
 * approach is planned in full, and its card is the version's own forecast.
 * Switching approach re-plans only the beats whose treatment changes, so
 * another approach's card counts the planned shots of the beats it keeps and
 * estimates the beats it changes by the same deterministic rules.
 */

/** A treatment that may show this narrative class at all. */
export const optionAllowed = (treatment: VisualTreatment, cls: ScriptBlockClass) => TREATMENT_CLASS_RULES[treatment][cls].allowed;

/** Every class allows it: the replacement when neither an option nor the seed is allowed. */
const ALWAYS: VisualTreatment = 'ENVIRONMENT';

/** The beat's options with any the class matrix refuses replaced by the seed treatment (each replacement noted). */
export function checkOptions(ref: string, options: VisualBeatContent['options'], cls: ScriptBlockClass, seed: VisualTreatment | null, notes: string[]): VisualBeatContent['options'] {
  const out = { ...options };
  for (const a of VISUAL_APPROACHES) {
    const o = options[a];
    if (optionAllowed(o.treatment, cls)) continue;
    const replacement = seed && optionAllowed(seed, cls) ? seed : ALWAYS;
    notes.push(`${ref}: option ${a} (${o.treatment}) is not allowed over ${cls} narration; replaced by ${replacement}`);
    out[a] = { treatment: replacement, concept: o.concept };
  }
  return out;
}

/** How many options were replaced, from the version's notes. */
export const replacedOptions = (notes: readonly string[], approach: VisualApproach) => notes.filter((n) => new RegExp(`^VB\\d+: option ${approach} \\(`).test(n)).length;

/** The approach a version plans: the one asked for, else the profile's, else the hybrid. */
export const chooseApproach = (asked: VisualApproach | undefined, profileApproach: VisualApproach | undefined): VisualApproach => asked ?? profileApproach ?? 'C';

/** The beats whose treatment another approach changes: the only ones "switch approach" re-plans. */
export function beatsToReplan(draft: Pick<StoryboardDraft, 'beats' | 'approach'>, approach: VisualApproach): string[] {
  return draft.beats.filter((b) => b.content.options[approach].treatment !== b.content.options[draft.approach].treatment).map((b) => b.key);
}

/**
 * The draft for another approach: every beat whose treatment is unchanged is
 * copied with its shots; the others keep their range and options and lose
 * their shots, to be re-planned (`replan`).
 */
export function switchApproach(draft: StoryboardDraft, approach: VisualApproach): { draft: StoryboardDraft; replan: string[] } {
  const replan = beatsToReplan(draft, approach);
  const changed = new Set(replan);
  return {
    draft: structuredClone({ ...draft, approach, shots: draft.shots.filter((s) => !changed.has(s.beatKey)) }),
    replan,
  };
}

const evidenceTreatment = (t: VisualTreatment) => DEPICTION_FOR[t] === 'RECORD' || DEPICTION_FOR[t] === 'DATA';

/**
 * The three approaches measured across the version's beats: treatment mix,
 * generated-video share, shots, cost by the same router and catalog
 * (durations from the audio), and the share of beats that show evidence (a
 * record or data, with claims behind it). A beat an approach keeps (its
 * treatment is the planned one's) is counted from its planned shots, as a
 * switch copies them; a beat it changes is estimated at the profile's
 * density. The planned approach keeps every beat, so its card is the
 * version's own forecast. A kept shot that reuses an asset made in a
 * re-planned beat is still counted at $0, so a switch can be slightly
 * under-estimated.
 */
export function approachSummaries(beats: readonly PlannedBeat[], planned: readonly PlannedShot[], subjects: ReadonlyMap<string, { spec: ContinuitySpec }>, facts: StoryboardFacts, notes: readonly string[]): ApproachSummary[] {
  const profile = facts.profile.effective;
  const target = DENSITY_TARGETS[profile.density];
  const shotMs = ((target.averageShotSec.min + target.averageShotSec.max) / 2) * 1000;
  const timed = beats.filter((b): b is PlannedBeat & { startMs: number; endMs: number } => b.startMs !== null && b.endMs !== null);
  const runtime = timed.reduce((a, b) => a + (b.endMs - b.startMs), 0);
  return VISUAL_APPROACHES.map((approach) => {
    const mix: Partial<Record<VisualTreatment, number>> = {};
    let generated = 0;
    let shots = 0;
    let evidence = 0;
    const costs: (VisualCostEstimate | null)[] = [];
    for (const b of timed) {
      const t = b.stored.options[approach].treatment;
      if (evidenceTreatment(t) && b.claimRows.length > 0) evidence++;
      if (t === b.treatment) {
        // A beat this approach keeps is copied with its shots on a switch: counted as planned.
        for (const s of planned.filter((x) => x.beatKey === b.key)) {
          const len = s.startMs !== null && s.endMs !== null ? s.endMs - s.startMs : 0;
          if (s.treatment && !s.unplanned) mix[s.treatment] = (mix[s.treatment] ?? 0) + len;
          if (s.method && GENERATED_VIDEO_METHODS.includes(s.method)) generated += len;
          shots++;
          costs.push(s.cost);
        }
        continue;
      }
      const ms = b.endMs - b.startMs;
      mix[t] = (mix[t] ?? 0) + ms;
      const people = beatPeople(b, subjects);
      const n = Math.max(1, Math.round(ms / shotMs));
      shots += n;
      const route = routeShot({ treatment: t, method: null, durationMs: Math.round(ms / n), ...people, recommendation: null, reuseOf: null }, profile, facts.catalog);
      if (GENERATED_VIDEO_METHODS.includes(route.method)) generated += ms;
      for (let i = 0; i < n; i++) costs.push(route.estimate);
    }
    const total = rollupTotal(costs);
    return {
      approach,
      treatmentMix: mix,
      generatedVideoShare: runtime > 0 ? Math.round((generated / runtime) * 1000) / 1000 : 0,
      estimatedShots: shots,
      estimatedCostUsd: total.totalUsd,
      costBasis: total.basis,
      unpricedShots: total.unpricedShots,
      evidenceShare: timed.length ? Math.round((evidence / timed.length) * 1000) / 1000 : 0,
      replacedOptions: replacedOptions(notes, approach),
    };
  });
}

/**
 * The planned approach's card read from the version itself: its forecast,
 * shots, generated-video share and the planned shots' runtime by treatment
 * (all frozen with the version). A version saved before the card was the
 * version's own forecast shows the same figures as the rest of the page.
 */
export function plannedCard(o: ApproachSummary, costs: Pick<CostRollup, 'totalUsd' | 'basis' | 'unpricedShots'>, shots: readonly PlannedShot[], generatedVideoShare: number): ApproachSummary {
  const treatmentMix: Partial<Record<VisualTreatment, number>> = {};
  for (const s of shots) if (s.treatment && !s.unplanned && s.startMs !== null && s.endMs !== null) treatmentMix[s.treatment] = (treatmentMix[s.treatment] ?? 0) + (s.endMs - s.startMs);
  return { ...o, estimatedCostUsd: costs.totalUsd, costBasis: costs.basis, unpricedShots: costs.unpricedShots, estimatedShots: shots.length, generatedVideoShare, treatmentMix };
}

/** Whether a beat's subjects include a real person or a fictional character (the router's portrait rules). */
export function beatPeople(beat: DraftBeat, subjects: ReadonlyMap<string, { spec: ContinuitySpec }>): { realPerson: boolean; fictionalSubject: boolean } {
  const specs = beat.content.continuity.subjectKeys.flatMap((k) => (subjects.get(k) ? [subjects.get(k)!.spec] : []));
  return { realPerson: specs.some((s) => isReal(s)), fictionalSubject: specs.some((s) => isFictional(s)) };
}
