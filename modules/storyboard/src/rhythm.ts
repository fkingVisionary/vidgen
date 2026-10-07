import {
  DENSITY_TARGETS,
  GENERATED_VIDEO_METHODS,
  SHOT_LIMITS,
  type ProductionMethod,
  type RhythmStats,
  type StoryboardQaFinding,
  type VisualStyleProfileConfig,
  type VisualTreatment,
} from '@docengine/core';
import type { PlannedBeat, PlannedShot, StoryboardFacts } from './draft.ts';

/**
 * Visual rhythm (§13): how long shots last, how often the picture changes,
 * how often the treatment changes, what moves and what holds, how dense the
 * information is, and where the story resets or peaks. Measured on the
 * version; the warnings are for a person to weigh, never blocking.
 */

/** Methods whose picture moves. */
const MOVING_METHODS: readonly ProductionMethod[] = ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO', 'STILL_MOTION', 'MOTION_DESIGN', 'MAP_RENDER', 'DOCUMENT_MOTION', 'SCREEN_RECORDING'];
const MOVING_TREATMENTS: readonly VisualTreatment[] = ['ARCHIVAL_VIDEO', 'NEWS_FOOTAGE'];
/** Shots of these treatments with no claim and no subject are generic b-roll. */
const BROLL: readonly VisualTreatment[] = ['ENVIRONMENT', 'ABSTRACT_METAPHOR'];
/** One treatment over more than this share of the runtime dominates. */
export const DOMINANT_SHARE = 0.5;
/** More than this much consecutive generic b-roll warns. */
export const GENERIC_BROLL_MS = 15_000;
/** At least this many shots in a row of near-equal length warn (a proxy for arbitrary fixed-length shots). */
export const UNIFORM_RUN = 6;
/** The same environment over more than this many consecutive beats, or this share of the runtime, warns. */
export const ENVIRONMENT_BEATS = 3;
export const ENVIRONMENT_SHARE = 0.4;

type TimedShot = PlannedShot & { startMs: number; endMs: number };
const timed = (shots: readonly PlannedShot[]) => shots.filter((s): s is TimedShot => s.startMs !== null && s.endMs !== null).sort((a, b) => a.startMs - b.startMs);
const length = (s: TimedShot) => s.endMs - s.startMs;

/** The picture moves: a camera move, a moving method, or footage. */
export const isMoving = (s: Pick<PlannedShot, 'method' | 'treatment' | 'spec'>) =>
  (s.spec.movement.motion !== null && s.spec.movement.motion !== 'STATIC') || (s.method !== null && MOVING_METHODS.includes(s.method)) || (s.treatment !== null && MOVING_TREATMENTS.includes(s.treatment));

const median = (xs: readonly number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);
const perMinute = (n: number, ms: number) => (ms > 0 ? Math.round((n / (ms / 60_000)) * 100) / 100 : 0);

/** The longest run of consecutive shots with one treatment, and where it starts. */
function longestRun(shots: readonly TimedShot[]): { length: number; start: number } {
  let best = { length: 0, start: 0 };
  let run = 0;
  shots.forEach((s, i) => {
    run = i > 0 && shots[i - 1]!.treatment === s.treatment ? run + 1 : 1;
    if (run > best.length) best = { length: run, start: i - run + 1 };
  });
  return best;
}

export function rhythmStats(shots: readonly PlannedShot[], beats: readonly PlannedBeat[], facts: StoryboardFacts): RhythmStats {
  const t = timed(shots);
  const runtime = facts.spine.totalDurationMs;
  const lengths = t.map(length);
  const total = lengths.reduce((a, b) => a + b, 0);
  const moving = t.filter(isMoving).reduce((a, s) => a + length(s), 0);
  const generated = t.filter((s) => s.method !== null && GENERATED_VIDEO_METHODS.includes(s.method)).reduce((a, s) => a + length(s), 0);

  const resetPoints: RhythmStats['resetPoints'] = [];
  const blocks = facts.spine.blocks;
  blocks.forEach((b, i) => {
    if (i > 0 && blocks[i - 1]!.sectionKey !== b.sectionKey) resetPoints.push({ atMs: b.startMs, kind: 'SECTION', ref: b.sectionKey });
    const pause = (p: { length: string }) => p.length === 'MEDIUM' || p.length === 'LONG';
    if (pause(b.block.delivery.pauseBefore)) resetPoints.push({ atMs: b.startMs, kind: 'PAUSE', ref: b.key });
    if (pause(b.block.delivery.pauseAfter)) resetPoints.push({ atMs: b.endMs, kind: 'PAUSE', ref: b.key });
  });
  for (const s of facts.spine.sections) {
    const seq = facts.scope.sequences.get(s.sequence);
    const first = blocks.find((b) => b.sectionKey === s.key);
    if (seq && first && seq.continuity.timeJump !== 'NONE') resetPoints.push({ atMs: first.startMs, kind: 'TIME_JUMP', ref: s.key });
  }
  resetPoints.sort((a, b) => a.atMs - b.atMs);

  const peaks: RhythmStats['peaks'] = [];
  for (const b of beats) {
    if (b.startMs === null) continue;
    const at = b.startMs;
    if (b.stored.functions.includes('REVEAL')) peaks.push({ atMs: at, beatKey: b.key, kind: 'REVEAL' });
    if (b.stored.functions.includes('TURN')) peaks.push({ atMs: at, beatKey: b.key, kind: 'TURN' });
    const covered = b.blocks.map((r) => facts.spine.block(r.blockKey)?.block.centralQuestion);
    if (covered.includes('POSED')) peaks.push({ atMs: at, beatKey: b.key, kind: 'QUESTION_POSED' });
    if (covered.includes('ANSWERED')) peaks.push({ atMs: at, beatKey: b.key, kind: 'QUESTION_ANSWERED' });
  }

  return {
    shots: t.length,
    averageShotMs: t.length ? Math.round(total / t.length) : 0,
    medianShotMs: median(lengths),
    minShotMs: lengths.length ? Math.min(...lengths) : 0,
    maxShotMs: lengths.length ? Math.max(...lengths) : 0,
    cutsPerMinute: perMinute(Math.max(0, t.length - 1), runtime),
    treatmentChanges: t.filter((s, i) => i > 0 && t[i - 1]!.treatment !== s.treatment).length,
    longestSameTreatmentRun: longestRun(t).length,
    staticShare: share(total - moving, total),
    movingShare: share(moving, total),
    claimsPerMinute: perMinute(
      t.reduce((a, s) => a + s.claims.length, 0),
      runtime,
    ),
    overlaysPerMinute: perMinute(
      t.reduce((a, s) => a + s.direction.overlays.length, 0),
      runtime,
    ),
    resetPoints,
    peaks,
    reveals: t.filter((s) => s.cutIn === 'REVEAL').length,
    transitions: t.filter((s) => s.treatment === 'TRANSITION' || s.direction.transitionIn !== 'CUT').length,
    generatedVideoShare: share(generated, total),
  };
}

const sec = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const W = (kind: StoryboardQaFinding['kind'], ref: string | null, detail: string): StoryboardQaFinding => ({ kind, severity: 'WARNING', ref, detail });

/** The rhythm and variety warnings (§13), against the profile's density and SHOT_LIMITS. */
export function rhythmFindings(shots: readonly PlannedShot[], beats: readonly PlannedBeat[], facts: StoryboardFacts, profile: VisualStyleProfileConfig): StoryboardQaFinding[] {
  const out: StoryboardQaFinding[] = [];
  const t = timed(shots).filter((s) => !s.unplanned);
  if (!t.length) return out;
  const total = t.reduce((a, s) => a + length(s), 0);
  const target = DENSITY_TARGETS[profile.density];

  const run = longestRun(t);
  if (run.length > SHOT_LIMITS.maxSameTreatmentRun) {
    const first = t[run.start]!;
    out.push(W('TREATMENT_REPETITION', first.key, `${run.length} shots in a row are ${first.treatment} (${first.key}–${t[run.start + run.length - 1]!.key}): vary the picture`));
  }
  const byTreatment = new Map<string, number>();
  for (const s of t) byTreatment.set(s.treatment!, (byTreatment.get(s.treatment!) ?? 0) + length(s));
  for (const [treatment, ms] of byTreatment) {
    if (ms / total > DOMINANT_SHARE) out.push(W('TREATMENT_DOMINANT', null, `${treatment} covers ${Math.round((ms / total) * 100)}% of the runtime`));
  }
  const generated = t.filter((s) => s.method !== null && GENERATED_VIDEO_METHODS.includes(s.method)).reduce((a, s) => a + length(s), 0);
  if (generated / total > profile.generation.maxGeneratedVideoShare) {
    out.push(W('GENERATED_VIDEO_SHARE', null, `Generated video covers ${Math.round((generated / total) * 100)}% of the runtime; the profile allows ${Math.round(profile.generation.maxGeneratedVideoShare * 100)}%`));
  }
  const average = total / t.length / 1000;
  if (average < target.averageShotSec.min) out.push(W('DENSITY_HIGH', null, `Shots average ${average.toFixed(1)} s; ${profile.density.toLowerCase()} density aims for ${target.averageShotSec.min}–${target.averageShotSec.max} s`));
  if (average > target.averageShotSec.max) out.push(W('DENSITY_LOW', null, `Shots average ${average.toFixed(1)} s; ${profile.density.toLowerCase()} density aims for ${target.averageShotSec.min}–${target.averageShotSec.max} s`));
  const cuts = perMinute(t.length - 1, facts.spine.totalDurationMs);
  if (cuts > target.maxCutsPerMinute) out.push(W('SHOT_COUNT_HIGH', null, `${cuts} cuts a minute; ${profile.density.toLowerCase()} density allows ${target.maxCutsPerMinute}`));
  for (const b of beats) {
    if (b.startMs === null || b.endMs === null || b.shotKeys.length !== 1) continue;
    if (b.endMs - b.startMs >= 2 * target.averageShotSec.max * 1000) out.push(W('SHOT_COUNT_LOW', b.key, `${b.key} holds one shot for ${sec(b.endMs - b.startMs)}`));
  }

  // Rapid cuts with no reason: three or more short shots in a row.
  let rapid: TimedShot[] = [];
  const reasoned = (s: TimedShot) => s.cutIn === 'REVEAL' || s.cutIn === 'PAUSE' || s.cutOut === 'REVEAL' || s.cutOut === 'PAUSE' || s.blocks.some((r) => impact(facts, r.blockKey));
  const flushRapid = () => {
    if (rapid.length >= 3) out.push(W('RAPID_CUTS', rapid[0]!.key, `${rapid.length} shots under ${sec(SHOT_LIMITS.rapidCutMs)} in a row (${rapid[0]!.key}–${rapid.at(-1)!.key}) with no reveal, impact or pause`));
    rapid = [];
  };
  for (const s of t) {
    if (length(s) < SHOT_LIMITS.rapidCutMs && !reasoned(s)) rapid.push(s);
    else flushRapid();
  }
  flushRapid();

  for (const s of t) {
    if (!isMoving(s) && length(s) > SHOT_LIMITS.staticWarnMs) out.push(W('STATIC_LONG', s.key, `${s.key} holds a static picture for ${sec(length(s))}`));
    if (length(s) > SHOT_LIMITS.noChangeWarnMs) out.push(W('NO_VISUAL_CHANGE', s.key, `${s.key} runs ${sec(length(s))} of narration with no cut`));
  }

  // Generic b-roll: consecutive environment or metaphor shots resting on nothing.
  let broll: TimedShot[] = [];
  const flushBroll = () => {
    const ms = broll.reduce((a, s) => a + length(s), 0);
    if (ms > GENERIC_BROLL_MS) out.push(W('GENERIC_BROLL', broll[0]!.key, `${sec(ms)} of generic b-roll (${broll[0]!.key}–${broll.at(-1)!.key}): no claim and no subject`));
    broll = [];
  };
  for (const s of t) {
    if (BROLL.includes(s.treatment!) && s.claims.length === 0 && s.subjects.length === 0) broll.push(s);
    else flushBroll();
  }
  flushBroll();

  // Near-equal lengths, many in a row.
  for (let i = 0; i + UNIFORM_RUN <= t.length; i++) {
    const xs = t.slice(i, i + UNIFORM_RUN).map(length);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cv = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) / mean;
    if (cv < SHOT_LIMITS.uniformDurationCv) {
      out.push(W('UNIFORM_DURATIONS', t[i]!.key, `${UNIFORM_RUN} shots in a row last about ${sec(mean)} each (${t[i]!.key}–${t[i + UNIFORM_RUN - 1]!.key}): cut where the story changes, not by the clock`));
      break;
    }
  }

  // A cut inside a sentence needs a reason.
  for (let i = 1; i < t.length; i++) {
    const s = t[i]!;
    const prev = t[i - 1]!;
    const id = s.narration?.from;
    const p = id ? facts.spine.point(id) : undefined;
    if (!p || !p.midSentence || prev.narration?.to !== s.narration?.from) continue;
    const ok = ['CONCEPT_CHANGE', 'INFORMATION_CHANGE', 'REVEAL'];
    if (!ok.includes(s.cutIn) && !ok.includes(prev.cutOut)) out.push(W('MID_SENTENCE_CUT', s.key, `${s.key} cuts inside a sentence (${p.id}) without a change of concept or information, or a reveal`));
  }

  // The same environment again and again.
  const envOf = (beatKey: string) => {
    const keys = new Set(t.filter((s) => s.beatKey === beatKey && s.treatment === 'ENVIRONMENT').map((s) => s.spec.environment.subjectKey).filter((k): k is string => !!k));
    return keys;
  };
  const ordered = beats.filter((b) => b.startMs !== null);
  const runs = new Map<string, number>();
  const reported = new Set<string>();
  for (const b of ordered) {
    const envs = envOf(b.key);
    for (const k of [...runs.keys()]) if (!envs.has(k)) runs.delete(k);
    for (const k of envs) {
      const n = (runs.get(k) ?? 0) + 1;
      runs.set(k, n);
      if (n > ENVIRONMENT_BEATS && !reported.has(k)) {
        reported.add(k);
        out.push(W('ENVIRONMENT_REPEATED', k, `The environment ${k} is the picture in ${n} beats in a row`));
      }
    }
  }
  const envTime = new Map<string, number>();
  for (const s of t) if (s.treatment === 'ENVIRONMENT' && s.spec.environment.subjectKey) envTime.set(s.spec.environment.subjectKey, (envTime.get(s.spec.environment.subjectKey) ?? 0) + length(s));
  for (const [k, ms] of envTime) if (ms / total > ENVIRONMENT_SHARE && !reported.has(k)) out.push(W('ENVIRONMENT_REPEATED', k, `The environment ${k} is the picture for ${Math.round((ms / total) * 100)}% of the runtime`));
  return out;
}

/** A block whose delivery pauses for impact or a reveal (a reason for quick cuts). */
function impact(facts: StoryboardFacts, blockKey: string): boolean {
  const d = facts.spine.block(blockKey)?.block.delivery;
  const reasons = [d?.pauseBefore.reason, d?.pauseAfter.reason];
  return reasons.includes('IMPACT') || reasons.includes('REVEAL');
}
