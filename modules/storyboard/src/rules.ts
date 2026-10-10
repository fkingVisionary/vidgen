import {
  GENERATIVE_METHODS,
  RECORD_TREATMENTS,
  SHOT_LIMITS,
  SOURCING_METHODS,
  STORYBOARD_FINDING_SEVERITY,
  TREATMENT_CLASS_RULES,
  UNREAL_REALISMS,
  type ContinuitySpec,
  type InformationClass,
  type Presentation,
  type ScriptBlockClass,
  type ShotSubjectDetail,
  type StoryboardFindingKind,
  type StoryboardQaFinding,
  type StorySequenceV2,
  type UncertaintyDevice,
  type VisualTreatment,
} from '@docengine/core';
import type { DraftBlock } from '@docengine/script';
import { checkFigures, checkPerson, extractFigures, isYear, mentionsName, nameTokens, normalize, quoteFoundIn, unknownProperNouns, wordTokens } from '@docengine/story/shared';
import { avoidedMatches, avoidWords, periodDetails, showsAll, visibleText } from './anachronism.ts';
import { droppedReferences, type PlannedShot, type PlannedStoryboard, type PlannedSubject, type StoryboardFacts } from './draft.ts';
import { beatBases, claimFacts, contextClaims, coveredClaims, inheritedMustAvoid, inheritedMustShow, isFictional, isReal, labelObligation, shownClaimKeys, shownFacts, type ClaimFact } from './inherit.ts';
import { rhythmFindings } from './rhythm.ts';
import { minDurationMs, rangeOf, silenceInside } from './timing.ts';

/**
 * Deterministic storyboard QA (§2.10, brief §24 and the guardrails of
 * §11). Blocking findings cover the timeline (every word mapped once, shots
 * tiling the clock, possible durations), the structure (treatment, asset
 * requirement, class) and the evidence: no uncertain material shown as
 * fact, no generated records, fiction kept out of documented scenes and
 * away from real people, no invented characters or generated likenesses of
 * real people, invented details never in a documented shot, overlays that
 * rest on evidence, devices that are really there. Warnings are for a
 * person to weigh. Everything runs on structured data; prose heuristics
 * only ever warn.
 */

const finding = (kind: StoryboardFindingKind, ref: string | null, detail: string): StoryboardQaFinding => ({ kind, severity: STORYBOARD_FINDING_SEVERITY[kind], ref, detail });

/** Data treatments draw a chart, timeline or map: they need a data requirement. */
export const DATA_TREATMENTS: readonly VisualTreatment[] = ['DATA_VISUALIZATION', 'INFOGRAPHIC', 'TIMELINE', 'MAP_ANIMATION'];
/** Treatments that assert a record, data or a likeness (factual over FRAMING narration: a warning). */
const FACTUAL_TREATMENTS: readonly VisualTreatment[] = [...RECORD_TREATMENTS, 'DATA_VISUALIZATION', 'INFOGRAPHIC', 'TIMELINE', 'MAP_ANIMATION', 'DIAGRAM', 'PORTRAIT'];

/** The devices that keep each presentation from being shown as fact in a reconstruction (rule 6). NARRATOR_LED never does. */
const DEVICES_FOR: Readonly<Record<Exclude<Presentation, 'STATE'>, readonly UncertaintyDevice[] | 'VISIBLE'>> = {
  HEDGE: 'VISIBLE',
  PRESENT_AS_DISPUTED: ['COMPETING_VERSIONS', 'SOURCE_SHOWN', 'LABELLED_LEGEND'],
  PRESENT_AS_UNCONFIRMED: ['SOURCE_SHOWN', 'ABSENCE', 'STYLISED_UNREAL', 'LABELLED_LEGEND'],
  INVESTIGATE_AS_MYTH: ['LABELLED_LEGEND', 'STYLISED_UNREAL', 'COMPETING_VERSIONS'],
};

const visible = (d: UncertaintyDevice) => d !== 'NONE' && d !== 'NARRATOR_LED';

/** A date or place stamp says what a documented setting field says: its figures and its name words are all in it. */
function inDocumented(stamp: string, field: { value: string; basis: string }): boolean {
  if (field.basis !== 'DOCUMENTED' || !field.value.trim()) return false;
  const figures = extractFigures(stamp);
  const words = nameTokens(stamp);
  const have = new Set([...extractFigures(field.value), ...wordTokens(field.value)]);
  return figures.length + words.length > 0 && [...figures, ...words].every((x) => have.has(x));
}

/** What a shot covers and shows, read from the narration and the version's subjects. */
export interface ShotContext {
  /** The blocks whose words it supports (a silence-only shot: the blocks either side). */
  blocks: DraftBlock[];
  /** The blocks heard while it is seen (its lead-in and tail-out included). */
  visualBlocks: DraftBlock[];
  sequences: (StorySequenceV2 | null)[];
  /** The sequence where it starts. */
  sequence: StorySequenceV2 | null;
  narrationClasses: ScriptBlockClass[];
  beatBases: InformationClass[];
  /** Its subjects with their specs (unknown keys left out). */
  subjects: { key: string; spec: ContinuitySpec; detail: ShotSubjectDetail }[];
  claims: ClaimFact[];
}

export function shotContext(shot: Pick<PlannedShot, 'narration' | 'silenceAt' | 'startMs' | 'endMs' | 'subjects' | 'claims'>, facts: StoryboardFacts, subjects: ReadonlyMap<string, { spec: ContinuitySpec }>): ShotContext {
  const spine = facts.spine;
  const blockOf = (key: string) => spine.block(key)?.block;
  let keys: string[] = [];
  if (shot.narration) {
    const r = rangeOf(spine, shot.narration);
    if (typeof r !== 'string') keys = [...new Set(spine.words.slice(r.from.position, r.to.position).map((w) => w.blockKey))];
  } else if (shot.silenceAt) {
    const p = spine.point(shot.silenceAt);
    if (p) keys = [...new Set([spine.words[p.position - 1]?.blockKey, spine.words[p.position]?.blockKey].filter((k): k is string => !!k))];
  }
  const blocks = keys.flatMap((k) => (blockOf(k) ? [blockOf(k)!] : []));
  const seen = shot.startMs !== null && shot.endMs !== null ? spine.words.filter((w) => w.heard.startMs < shot.endMs! && w.heard.endMs > shot.startMs!).map((w) => w.blockKey) : [];
  const visualBlocks = [...new Set([...keys, ...seen])].flatMap((k) => (blockOf(k) ? [blockOf(k)!] : []));
  const sequenceOf = (b: DraftBlock) => facts.scope.sequences.get(spine.block(b.key)!.sequence) ?? null;
  const sequences = [...new Set(blocks.map(sequenceOf))];
  return {
    blocks,
    visualBlocks,
    sequences,
    sequence: blocks[0] ? sequenceOf(blocks[0]) : null,
    narrationClasses: [...new Set(blocks.map((b) => b.infoClass))],
    beatBases: beatBases(facts.scope, blocks),
    subjects: shot.subjects.flatMap((s) => {
      const x = subjects.get(s.subjectKey);
      return x ? [{ key: s.subjectKey, spec: x.spec, detail: s.detail }] : [];
    }),
    claims: claimFacts(facts.scope, shot.claims),
  };
}

export interface CheckOptions {
  /** At the project STORYBOARD gate: a PARTIAL version or an incomplete assembly blocks. */
  gate?: boolean;
}

/** The version's QA (§2.10), as saved and live: STALE_* findings are added by the stale evaluator. */
export function checkStoryboard(p: PlannedStoryboard, facts: StoryboardFacts, o: CheckOptions = {}): StoryboardQaFinding[] {
  const out: StoryboardQaFinding[] = [];
  const subjects = new Map(p.subjects.map((s) => [s.key, s]));
  structure(p, facts, out);
  for (const shot of p.shots) if (!shot.unplanned) shotRules(shot, p, facts, subjects, out);
  for (const s of p.subjects) subjectRules(s, facts, out);
  labels(p, facts, subjects, out);
  narration(p, facts, o, out);
  warnings(p, facts, subjects, out);
  return out;
}

// ── Timeline and structure ───────────────────────────────────────────────────

function structure(p: PlannedStoryboard, facts: StoryboardFacts, out: StoryboardQaFinding[]): void {
  const spine = facts.spine;
  const total = spine.totalDurationMs;
  for (const s of p.shots) {
    if (s.unplanned) out.push(finding('SHOT_UNPLANNED', s.key, `${s.key} covers beat ${s.beatKey}, whose plan could not be made valid: edit or regenerate the beat`));
    else {
      if (!s.treatment) out.push(finding('TREATMENT_MISSING', s.key, `${s.key} has no treatment`));
      if (!s.infoClass) out.push(finding('INFO_CLASS_MISSING', s.key, `${s.key} has no information class`));
      if (!s.asset) out.push(finding('ASSET_REQUIREMENT_MISSING', s.key, `${s.key} has no asset requirement`));
      else if (s.treatment && DATA_TREATMENTS.includes(s.treatment) && !s.direction.dataSpec) out.push(finding('ASSET_REQUIREMENT_MISSING', s.key, `${s.key} is a ${s.treatment} without its data requirement (what it charts, from which claims)`));
    }
    const silence = s.silenceAt ? spine.point(s.silenceAt) : undefined;
    const anchor = s.narration
      ? rangeOf(spine, s.narration)
      : s.silenceAt
        ? silence
          ? silenceInside(spine, silence, p.shots)
          : `the cut point ${s.silenceAt} is not in the narration`
        : 'it has neither narration nor a silence';
    if (typeof anchor === 'string') out.push(finding('TIMING_MISSING', s.key, `${s.key}: ${anchor}`));
    else if (s.startMs === null || s.endMs === null || !s.timing) out.push(finding('TIMING_MISSING', s.key, `${s.key} has no times`));
    else {
      const d = s.endMs - s.startMs;
      const min = minDurationMs(s.treatment);
      if (d <= 0) out.push(finding('DURATION_IMPOSSIBLE', s.key, `${s.key} ends before it starts`));
      else if (d < min) out.push(finding('DURATION_IMPOSSIBLE', s.key, `${s.key} lasts ${d} ms, under the ${min} ms minimum`));
      else if (d > SHOT_LIMITS.maxMs) out.push(finding('DURATION_IMPOSSIBLE', s.key, `${s.key} lasts ${Math.round(d / 1000)} s, over the ${SHOT_LIMITS.maxMs / 1000} s maximum`));
      if (s.startMs < 0 || s.endMs > total) out.push(finding('DURATION_IMPOSSIBLE', s.key, `${s.key} runs outside the narration (0–${total} ms)`));
    }
  }
  for (const b of p.beats) {
    const r = rangeOf(spine, b.narration);
    if (typeof r === 'string') out.push(finding('TIMING_MISSING', b.key, `${b.key}: ${r}`));
    else if (b.startMs === null || b.endMs === null) out.push(finding('TIMING_MISSING', b.key, `${b.key} has no times: ${p.shots.some((s) => s.beatKey === b.key) ? 'a shot of it is not timed' : 'it has no shots'}`));
  }

  // The visual track tiles the clock.
  const timed = p.shots.filter((s) => s.startMs !== null && s.endMs !== null).sort((a, b) => a.startMs! - b.startMs!);
  let edge = 0;
  let prev: PlannedShot | null = null;
  for (const s of timed) {
    if (s.startMs! > edge) out.push(finding('TIMELINE_GAP', s.key, `Nothing is on screen from ${edge} to ${s.startMs} ms${prev ? ` (after ${prev.key})` : ''}`));
    else if (prev && s.startMs! < edge) out.push(finding('SHOT_OVERLAP', s.key, `${s.key} starts at ${s.startMs} ms, before ${prev.key} ends (${edge} ms)`));
    edge = Math.max(edge, s.endMs!);
    prev = s;
  }
  if (edge < total) out.push(finding('TIMELINE_GAP', prev?.key ?? null, `Nothing is on screen from ${edge} to ${total} ms`));

  // Every word is supported by exactly one shot, and lies in exactly one beat: an untimed word too (all of a take without word timings).
  const n = spine.words.length;
  const shotCount = new Array<number>(n).fill(0);
  const beatCount = new Array<number>(n).fill(0);
  const beatRange = new Map<string, [number, number]>();
  for (const b of p.beats) {
    const r = rangeOf(spine, b.narration);
    if (typeof r === 'string') continue;
    beatRange.set(b.key, [r.from.position, r.to.position]);
    for (let i = r.from.position; i < r.to.position; i++) beatCount[i]!++;
  }
  const beatKeys = new Set(p.beats.map((b) => b.key));
  for (const s of p.shots) {
    if (!beatKeys.has(s.beatKey)) out.push(finding('NARRATION_UNMAPPED', s.key, `${s.key} belongs to ${s.beatKey}, which is not a beat of this version`));
    if (!s.narration) continue;
    const r = rangeOf(spine, s.narration);
    if (typeof r === 'string') continue;
    for (let i = r.from.position; i < r.to.position; i++) shotCount[i]!++;
    const br = beatRange.get(s.beatKey);
    if (br && (r.from.position < br[0] || r.to.position > br[1])) out.push(finding('NARRATION_UNMAPPED', s.key, `${s.key}'s narration (${s.narration.from}–${s.narration.to}) lies outside its beat ${s.beatKey}`));
  }
  const report = (counts: number[], what: 'shot' | 'beat') => {
    let i = 0;
    while (i < n) {
      const c = counts[i]!;
      if (c === 1) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && counts[j] === c) j++;
      const a = spine.words[i]!;
      const z = spine.words[j - 1]!;
      out.push(finding('NARRATION_UNMAPPED', null, `Words ${a.blockKey}:${a.word}–${z.blockKey}:${z.word} ("${a.text} … ${z.text}") are supported by ${c === 0 ? 'no' : c} ${what}${c === 0 ? '' : 's'}`));
      i = j;
    }
  };
  report(shotCount, 'shot');
  report(beatCount, 'beat');
}

// ── Evidence, class and fiction (§2.7) ───────────────────────────────────────

/** Whether a declared device really shows in the shot (rule 11), and why not. */
export function deviceRealized(shot: PlannedShot, ctx: ShotContext, p: PlannedStoryboard, facts: StoryboardFacts): string | null {
  const d = shot.direction.uncertaintyDevice;
  const uncertainDepicts = [...ctx.claims.filter((c) => c.role === 'DEPICTS'), ...shownFacts(facts.scope, shot.direction)].filter((c, i, all) => c.claim?.verdict !== 'ESTABLISHED' && all.findIndex((x) => x.key === c.key) === i);
  switch (d) {
    case 'NONE':
      return null;
    case 'SOURCE_SHOWN':
      return ctx.claims.some((c) => c.role === 'SHOWS_SOURCE' && c.sources.length > 0) ? null : 'no SHOWS_SOURCE claim with a traceable source';
    case 'COMPETING_VERSIONS': {
      const beatClaims = new Set(p.shots.filter((s) => s.beatKey === shot.beatKey).flatMap((s) => s.claims.filter((c) => c.role === 'DEPICTS' || c.role === 'SHOWS_SOURCE').map((c) => c.claimKey)));
      const caption = shot.direction.overlays.some((o) => o.kind === 'CAPTION' && o.claimKeys.length >= 2);
      return beatClaims.size >= 2 || caption ? null : 'the beat shows only one account, and no caption names two';
    }
    case 'LABELLED_LEGEND':
      return shot.direction.overlays.some((o) => o.kind === 'RECONSTRUCTION_LABEL' || o.kind === 'CAPTION') ? null : 'no reconstruction label or caption';
    case 'STYLISED_UNREAL': {
      const realism = shot.direction.styleOverrides.realism ?? facts.profile.effective.realism;
      return UNREAL_REALISMS.includes(realism) ? null : `the look is ${realism.toLowerCase()}, not plainly unreal`;
    }
    case 'ABSENCE':
      return ctx.subjects.some((s) => s.detail.action.trim()) ? `${ctx.subjects.find((s) => s.detail.action.trim())!.key} performs an action on screen` : null;
    case 'NARRATOR_LED':
      return uncertainDepicts.length ? `the picture depicts ${uncertainDepicts.map((c) => c.key).join(', ')}, which is not established` : null;
  }
}

function shotRules(shot: PlannedShot, p: PlannedStoryboard, facts: StoryboardFacts, subjects: ReadonlyMap<string, PlannedSubject>, out: StoryboardQaFinding[]): void {
  const scope = facts.scope;
  const evidence = scope.evidence;
  const ctx = shotContext(shot, facts, subjects);
  const k = shot.key;
  const cls = shot.infoClass;
  const t = shot.treatment!;
  const depiction = shot.direction.depiction;
  const device = shot.direction.uncertaintyDevice;
  const established = (c: ClaimFact) => c.claim?.verdict === 'ESTABLISHED';
  const role = (r: ClaimFact['role']) => ctx.claims.filter((c) => c.role === r);
  const keys = ctx.claims.map((c) => c.key);

  // CLAIM_INVALID: every claim known and allowed for its role; class and verdict consistent; data from its own claims.
  const invalid: string[] = [];
  const covered = coveredClaims(scope, ctx.blocks);
  const context = contextClaims(scope, ctx.blocks, ctx.sequences);
  // (A shot whose anchors do not resolve covers no narration here: TIMING_MISSING says so, and its claims are judged once it is placed.)
  const placed = ctx.blocks.length > 0;
  for (const c of ctx.claims) {
    if (!scope.claimSet.has(c.key)) invalid.push(`${c.key} is not in the approved evidence`);
    else if (placed && (c.role === 'CONTEXT' || c.role === 'PERIOD_BASIS' ? context : covered).has(c.key) === false) invalid.push(`${c.key} (${c.role}) is not a claim of the narration it covers`);
  }
  if (cls === 'DOCUMENTED') for (const c of role('DEPICTS')) if (!established(c)) invalid.push(`a documented shot depicts ${c.key}, which is ${c.claim?.verdict ?? 'unknown'}`);
  // What the picture's details rest on: claims of the evidence it may use, a claim basis naming one, every figure found in them.
  const shown = shownFacts(scope, shot.direction);
  for (const key of shownClaimKeys(shot.direction)) {
    if (!scope.claimSet.has(key)) invalid.push(`a detail rests on ${key}, which is not in the approved evidence`);
    else if (placed && !context.has(key)) invalid.push(`a detail rests on ${key}, which is not a claim of the narration it covers`);
  }
  if (cls === 'DOCUMENTED') for (const c of shown) if (!established(c) && !role('DEPICTS').some((x) => x.key === c.key)) invalid.push(`a documented shot shows a detail resting on ${c.key}, which is ${c.claim?.verdict ?? 'unknown'}`);
  for (const d of [...shot.direction.specifics.map((x) => ({ text: x.detail, basis: x.basis, claimKeys: x.claimKeys })), ...shot.direction.objects.map((x) => ({ text: x.name, basis: x.basis, claimKeys: x.claimKeys }))]) {
    if (d.basis !== 'CLAIM') continue;
    const known = d.claimKeys.filter((key) => scope.claimSet.has(key));
    if (known.length === 0) {
      if (d.claimKeys.length === 0) invalid.push(`"${d.text}" rests on a claim but names none`);
      continue;
    }
    const check = checkFigures([d.text], known, evidence, { strictYears: true, linkFrom: [] });
    if (check.unsupported.length || check.links.length) invalid.push(`${[...check.unsupported, ...check.links.map((l) => l.figure)].join(', ')} in "${d.text}" is not in ${known.join(', ')}`);
  }
  const rule = cls ? TREATMENT_CLASS_RULES[t][cls] : null;
  if (rule?.condition === 'NO_DEPICTS' && role('DEPICTS').length) invalid.push(`a ${t} illustrates, it does not depict ${role('DEPICTS').map((c) => c.key).join(', ')}: cite it as context`);
  for (const item of shot.direction.dataSpec?.items ?? []) {
    if (!keys.includes(item.claimKey)) {
      invalid.push(`the data cites ${item.claimKey}, which the shot does not rest on`);
      continue;
    }
    const figures = [item.figure, item.date].filter((x): x is string => !!x);
    const check = figures.length ? checkFigures(figures, [item.claimKey], evidence, { strictYears: true, linkFrom: [] }) : null;
    if (check && (check.unsupported.length || check.links.length)) invalid.push(`${[...check.unsupported, ...check.links.map((l) => l.figure)].join(', ')} is not in ${item.claimKey}`);
    if (item.place && !checkPerson(item.place, [item.claimKey], evidence, { linkFrom: [] }).grounded) invalid.push(`the place "${item.place}" is not in ${item.claimKey}`);
  }
  if (invalid.length) out.push(finding('CLAIM_INVALID', k, `${k}: ${invalid.join('; ')}`));

  // EVIDENCE_MISSING: a factual visual rests on traceable evidence, and every claim it depicts is traceable.
  const factualRoles = ctx.claims.filter((c) => c.role === 'DEPICTS' || c.role === 'SHOWS_SOURCE' || c.role === 'DATA');
  const factual = (cls === 'DOCUMENTED' || cls === 'RECONSTRUCTION' || cls === 'UNCERTAIN') && (depiction === 'RECORD' || depiction === 'RECONSTRUCTED' || depiction === 'DATA');
  if (factual || factualRoles.length) {
    const relevant = factualRoles.length ? factualRoles : ctx.claims;
    const untraced = role('DEPICTS').filter((c) => c.sources.length === 0);
    if (relevant.length === 0) out.push(finding('EVIDENCE_MISSING', k, `${k} shows ${depiction.toLowerCase()} material as ${cls?.toLowerCase()} but rests on no claim`));
    else if (!relevant.some((c) => c.sources.length > 0)) out.push(finding('EVIDENCE_MISSING', k, `${k}: none of ${relevant.map((c) => c.key).join(', ')} has a retrieved source with a verified quote`));
    else if (untraced.length) out.push(finding('EVIDENCE_MISSING', k, `${k} depicts ${untraced.map((c) => c.key).join(', ')}, with no retrieved source with a verified quote`));
  }

  // The class matrix: cells it refuses, and the conditions of the others.
  const uncertain: string[] = [];
  if (rule && !rule.allowed) {
    if (cls === 'FICTION') out.push(finding('FICTION_WITH_FACTS', k, `${k}: a fictional device is never shown as ${t}`));
    else out.push(finding('EVIDENCE_MISSING', k, `${k}: a ${t} asserts a record, data or a likeness, but the shot rests on no claim (${cls})`));
  }
  const captioned = shot.direction.overlays.some((o) => o.kind === 'CAPTION');
  if (rule?.condition === 'VISIBLE_DEVICE' && !visible(device)) uncertain.push(`a ${t} of uncertain material needs a visible device (${device === 'NONE' ? 'none' : 'narrator-led is not one'})`);
  if (rule?.condition === 'UNCERTAINTY_MARKED' && device === 'NONE' && !captioned && !shot.direction.overlays.some((o) => o.kind === 'RECONSTRUCTION_LABEL')) uncertain.push(`a ${t} of uncertain material marks what is uncertain (a device or a caption)`);
  if (rule?.condition === 'HEDGED_DATA') {
    const weak = role('DATA').filter((c) => c.claim?.verdict !== 'ESTABLISHED' && c.claim?.verdict !== 'PROBABLE');
    if (weak.length) uncertain.push(`reconstructed data rests on ${weak.map((c) => `${c.key} (${c.claim?.verdict})`).join(', ')}`);
    if (!captioned && device === 'NONE') uncertain.push('reconstructed data needs a hedged caption');
  }
  if (rule?.condition === 'RANGES_CAPTIONED' && !captioned) uncertain.push('uncertain data shows its ranges or competing series with a caption');
  // Rule 6: a disputed or unconfirmed event is never plain footage.
  const unrealized = deviceRealized(shot, ctx, p, facts);
  if (depiction === 'RECONSTRUCTED') {
    const depicted = role('DEPICTS');
    for (const c of [...depicted, ...shown.filter((x) => !depicted.some((y) => y.key === x.key))]) {
      if (!c.presentation || c.presentation === 'STATE') continue;
      const fits = DEVICES_FOR[c.presentation];
      const ok = fits === 'VISIBLE' ? visible(device) || cls === 'RECONSTRUCTION' : fits.includes(device);
      const how = depicted.includes(c) ? 'depicts' : 'shows a detail resting on';
      if (!ok) uncertain.push(`it ${how} ${c.key} (${c.claim?.verdict}, ${c.presentation}) with ${device === 'NONE' ? 'no device' : device}${fits === 'VISIBLE' ? '' : `: use ${fits.join(', ')}`}`);
    }
  }
  if (uncertain.length) out.push(finding('UNCERTAIN_AS_FACT', k, `${k}: ${uncertain.join('; ')}`));
  if (unrealized) out.push(finding('DEVICE_UNREALIZED', k, `${k} declares ${device}, but ${unrealized}`));

  // Rule 1: records are sourced, never generated.
  if (RECORD_TREATMENTS.includes(t) && shot.method && !SOURCING_METHODS.includes(shot.method)) out.push(finding('GENERATED_RECORD', k, `${k}: a ${t} is a record and is only ever sourced, never made by ${shot.method}`));
  else if (t === 'DOCUMENT_ANIMATION' && !ctx.claims.some((c) => c.role === 'SHOWS_SOURCE' && c.sources.length > 0)) out.push(finding('GENERATED_RECORD', k, `${k}: a document animation shows a sourced document (a SHOWS_SOURCE claim with a traceable source); otherwise it would be an invented one`));

  // Rules 2, 3, 5: fiction placement and interaction; likeness.
  const fictional = ctx.subjects.filter((s) => isFictional(s.spec));
  const real = ctx.subjects.filter((s) => isReal(s.spec));
  if (fictional.length) {
    const documented = ctx.visualBlocks.filter((b) => beatBases(scope, [b]).includes('DOCUMENTED'));
    if (documented.length) out.push(finding('FICTION_IN_DOCUMENTED', k, `${k} shows ${fictional.map((s) => s.spec.name).join(', ')} while the documented narration of ${documented.map((b) => b.key).join(', ')} is heard`));
  }
  const allowed = new Set(['NONE', 'OBSERVES', 'NEAR']);
  const realKeys = new Set(real.map((s) => s.key));
  const fictionalKeys = new Set(fictional.map((s) => s.key));
  const touches: string[] = [];
  for (const s of ctx.subjects) {
    for (const i of s.detail.interactions) {
      const crossing = (fictionalKeys.has(s.key) && realKeys.has(i.withSubjectKey)) || (realKeys.has(s.key) && fictionalKeys.has(i.withSubjectKey));
      if (crossing && !allowed.has(i.kind)) touches.push(`${s.key} ${i.kind.toLowerCase().replace(/_/g, ' ')} ${i.withSubjectKey}`);
    }
    if (fictionalKeys.has(s.key) && s.detail.speaks?.kind === 'RECORDED_QUOTE') touches.push(`${s.key}, a fictional character, speaks a recorded quotation`);
  }
  if (touches.length) out.push(finding('FICTION_REAL_INTERACTION', k, `${k}: ${touches.join('; ')} — fictional characters only observe real people`));
  const likeness: string[] = [];
  const unidentified: string[] = [];
  const generated = shot.method !== null && GENERATIVE_METHODS.includes(shot.method);
  for (const s of real.filter((x) => x.spec.castKind === 'REAL_PERSON')) {
    if (s.detail.likeness === 'GENERATED_LIKENESS') likeness.push(`${s.spec.name} is given a generated likeness`);
    else if (s.detail.likeness === 'DOCUMENTED_LIKENESS' && generated) likeness.push(`${s.spec.name}'s documented likeness would be generated by ${shot.method}`);
    else if (rule?.condition === 'DOCUMENTED_LIKENESS' && !(s.detail.likeness === 'DOCUMENTED_LIKENESS' && shot.method !== null && SOURCING_METHODS.includes(shot.method))) likeness.push(`a documented portrait of ${s.spec.name} is a sourced, documented likeness`);
    else if (rule?.condition === 'NON_IDENTIFYING' && s.detail.likeness === 'DOCUMENTED_LIKENESS') unidentified.push(s.spec.name);
  }
  if (likeness.length) out.push(finding('REAL_LIKENESS', k, `${k}: ${likeness.join('; ')} — show a real person through a sourced likeness, a silhouette or a period-generic figure`));
  // The matrix's non-identifying cells: there a real person appears unidentified, not even by a sourced likeness.
  if (unidentified.length) out.push(finding('REAL_LIKENESS', k, `${k}: a ${t.toLowerCase().replace(/_/g, ' ')} of ${cls!.toLowerCase()} material shows ${unidentified.join(', ')} only unidentified (a silhouette or a period-generic figure), not by a documented likeness`));

  // Rule 7: fiction carries no facts.
  if (cls === 'FICTION') {
    const facts7 = ctx.claims.filter((c) => c.role !== 'CONTEXT' && c.role !== 'PERIOD_BASIS');
    if (facts7.length) out.push(finding('FICTION_WITH_FACTS', k, `${k} is a fictional device but ${facts7.map((c) => `${c.role.toLowerCase().replace(/_/g, ' ')} ${c.key}`).join(', ')}: fiction carries only context`));
  }

  // Rule 8: invented details in a documented shot.
  const invented = [...shot.direction.specifics, ...shot.direction.objects].filter((d) => d.basis === 'INVENTED').map((d) => ('detail' in d ? d.detail : d.name));
  if (cls === 'DOCUMENTED' && invented.length) out.push(finding('INVENTED_DETAIL_DOCUMENTED', k, `${k} is documented but invents ${invented.map((x) => `"${x}"`).join(', ')}`));

  // Rule 9: overlays rest on the setting or the evidence.
  const setting = ctx.sequence?.setting;
  const overlayKeys = (keysOf: readonly string[]) => [...new Set([...keysOf, ...keys])];
  const unsupported: string[] = [];
  for (const ov of shot.direction.overlays) {
    if (ov.kind === 'DATE_STAMP') {
      const documented = !!setting && inDocumented(ov.text, setting.date);
      const figures = extractFigures(ov.text);
      const fromClaims = figures.length > 0 && (() => {
        const c = checkFigures([ov.text], overlayKeys(ov.claimKeys), evidence, { strictYears: true, linkFrom: [] });
        return c.unsupported.length === 0 && c.links.length === 0;
      })();
      if (!documented && !fromClaims) unsupported.push(`the date "${ov.text}" is neither a documented setting nor in its claims`);
    } else if (ov.kind === 'LOCATION_STAMP') {
      const documented = !!setting && inDocumented(ov.text, setting.location);
      if (!documented && !checkPerson(ov.text, overlayKeys(ov.claimKeys), evidence, { linkFrom: [] }).grounded) unsupported.push(`the place "${ov.text}" is neither a documented setting nor in its claims`);
    } else if (ov.kind === 'QUOTE') {
      const quoted = ov.text.replace(/^["“'‘]|["”'’]$/g, '');
      if (!overlayKeys(ov.claimKeys).some((key) => evidence.verifiedQuotes(key).some((q) => quoteFoundIn(quoted, q)))) unsupported.push(`"${ov.text}" is not a verified quotation of its claims`);
    }
  }
  if (unsupported.length) out.push(finding('OVERLAY_UNSUPPORTED', k, `${k}: ${unsupported.join('; ')}`));
}

function subjectRules(s: PlannedSubject, facts: StoryboardFacts, out: StoryboardQaFinding[]): void {
  const cast = s.spec.castId ? facts.scope.cast.get(s.spec.castId) : undefined;
  if (s.spec.kind === 'CHARACTER' && !s.spec.castId && !s.spec.anonymous) out.push(finding('INVENTED_CHARACTER', s.key, `${s.key} "${s.spec.name}" is a named character the architecture does not have: use a cast member or an unnamed figure`));
  if (s.spec.castId && !cast) out.push(finding('CONTINUITY_INVALID', s.key, `${s.key}: the cast id "${s.spec.castId}" is not in the architecture`));
  else if (cast) {
    if (cast.fictional !== isFictional(s.spec)) out.push(finding('CONTINUITY_INVALID', s.key, `${s.key}: ${cast.member.name} is ${cast.fictional ? 'a fictional device' : 'a real cast member'}, but the subject is described as ${isFictional(s.spec) ? 'fictional' : 'real'}`));
    if (s.spec.castKind !== cast.member.kind) out.push(finding('CONTINUITY_INVALID', s.key, `${s.key}: ${cast.member.name} is ${cast.member.kind}, not ${s.spec.castKind ?? 'unknown'}`));
  }
}

/** FICTION_LABEL_MISSING: a block whose script promised an on-screen label for its fictional device has a labelled shot. */
function labels(p: PlannedStoryboard, facts: StoryboardFacts, subjects: ReadonlyMap<string, PlannedSubject>, out: StoryboardQaFinding[]): void {
  for (const b of facts.spine.blocks) {
    if (!labelObligation(b.block)) continue;
    const covering = p.shots.filter((s) => shotContext(s, facts, subjects).blocks.some((x) => x.key === b.key) && s.narration);
    if (covering.length && !covering.some((s) => s.direction.overlays.some((o) => o.kind === 'FICTION_LABEL'))) {
      out.push(finding('FICTION_LABEL_MISSING', covering[0]!.key, `The script labels the fictional device in ${b.key} on screen, and no shot over it carries the label`));
    }
  }
}

function narration(p: PlannedStoryboard, facts: StoryboardFacts, o: CheckOptions, out: StoryboardQaFinding[]): void {
  const n = facts.spine.narration;
  const mock = n.takes.filter((t) => t.mock);
  if (mock.length) out.push(finding('MOCK_NARRATION', null, `${mock.length} of ${n.takes.length} takes are mock audio or mock timings: never acceptable for approval`));
  if (o.gate && (facts.scopeKind === 'PARTIAL' || !n.assembly.complete)) out.push(finding('SCOPE_INCOMPLETE', null, facts.scopeKind === 'PARTIAL' ? 'A preview of part of the script cannot pass the storyboard gate' : 'The assembly does not narrate the whole script'));
  if (facts.narrationApproval === 'UNREVIEWED') {
    const approved = n.takes.filter((t) => t.status === 'APPROVED').length;
    out.push(finding('PROVISIONAL_TIMING', null, `Provisional timing: takes ${approved}/${n.takes.length} approved (approving the version needs them all)`));
  }
  for (const id of facts.spine.unalignedTakes) {
    const entry = n.entries.find((e) => e.generationId === id);
    out.push(finding('UNALIGNED_TAKE', null, `Clip ${(entry?.chunkIndex ?? 0) + 1} has no word timings: only its edges can be cuts`));
  }
  if (facts.scopeKind === 'PARTIAL') out.push(finding('SCOPE_PARTIAL', null, `A preview of ${facts.spine.blocks.length} of ${facts.spine.blocks.length + facts.spine.outOfScope.length} script blocks (the narrated ones)`));
  const keys = new Set([...p.shots.map((x) => x.key), ...p.beats.map((x) => x.key), ...p.subjects.map((x) => x.key)]);
  for (const d of droppedReferences(p.normalization)) out.push(finding('MODEL_REFERENCE_DROPPED', d.ref && keys.has(d.ref) ? d.ref : null, d.detail));
}

// ── Warnings for a person to weigh ───────────────────────────────────────────

function warnings(p: PlannedStoryboard, facts: StoryboardFacts, subjects: ReadonlyMap<string, PlannedSubject>, out: StoryboardQaFinding[]): void {
  const scope = facts.scope;
  const profile = facts.profile.effective;
  out.push(...rhythmFindings(p.shots, p.beats, facts, profile));

  // Cost.
  const ceiling = profile.costCeilingUsd;
  if (ceiling.total !== null && p.costs.totalUsd !== null && p.costs.totalUsd > ceiling.total) out.push(finding('COST_HIGH', null, `The forecast is $${p.costs.totalUsd.toFixed(2)}, over the profile's ceiling of $${ceiling.total.toFixed(2)}`));
  if (ceiling.perFinishedMinute !== null && p.costs.perFinishedMinute !== null && p.costs.perFinishedMinute > ceiling.perFinishedMinute) {
    out.push(finding('COST_HIGH', null, `The forecast is $${p.costs.perFinishedMinute.toFixed(2)} a finished minute, over the profile's ceiling of $${ceiling.perFinishedMinute.toFixed(2)}`));
  }
  if (p.costs.unpricedShots > 0) out.push(finding('COST_UNPRICED', null, `${p.costs.unpricedShots} of ${p.shots.length} shots have no verified price: the total covers the rest only`));

  // Continuity.
  for (const s of p.subjects) {
    if (s.appearances.length >= 2 && s.spec.referenceAsset.required) out.push(finding('CONTINUITY_RISK', s.key, `Requires ${s.spec.name} continuity asset: it appears in ${s.appearances.join(', ')} and no reference exists yet`));
    // NONE shows no face (hands, a back, an object): it cannot contradict a face shown elsewhere.
    const modes = new Set(p.shots.flatMap((x) => x.subjects.filter((y) => y.subjectKey === s.key && y.detail.likeness !== 'NONE').map((y) => y.detail.likeness)));
    if (modes.size > 1) out.push(finding('CONTINUITY_RISK', s.key, `${s.spec.name} is shown with different likenesses (${[...modes].join(', ')})`));
  }
  for (const b of p.beats) {
    const seqs = [...new Set(b.blocks.map((r) => facts.spine.block(r.blockKey)?.sequence))].flatMap((n) => (n !== undefined && scope.sequences.get(n) ? [scope.sequences.get(n)!] : []));
    if (seqs.length < 2) continue;
    const reconstructed = (s: StorySequenceV2) => [s.setting.location, s.setting.date, s.setting.timeOfDay].filter((f) => f.basis === 'RECONSTRUCTION').map((f) => f.value).join('|');
    if (new Set(seqs.map(reconstructed)).size > 1) out.push(finding('CONTINUITY_RISK', b.key, `${b.key} spans sequences whose reconstructed settings differ`));
  }

  // What the picture implies, beyond its evidence.
  const flat = (s: string) => normalize(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const anachronisms: { key: string; matches: string[]; period: string[]; date: string }[] = [];
  const castNames = new Set([...scope.cast.values()].flatMap((c) => normalize(c.member.name).split(/[^a-z0-9]+/)));
  for (const shot of p.shots) {
    if (shot.unplanned) continue;
    const ctx = shotContext(shot, facts, subjects);
    const names = new Set([...castNames, ...ctx.subjects.flatMap((s) => normalize(s.spec.name).split(/[^a-z0-9]+/))]);
    const known = { has: (w: string) => scope.known.has(w) || names.has(w) };
    const text = visibleText(shot.direction, shot.subjects.map((s) => s.detail.action));
    const implications: string[] = [];
    const invented = [...shot.direction.specifics, ...shot.direction.objects].filter((d) => d.basis === 'INVENTED').map((d) => ('detail' in d ? d.detail : d.name));
    if (shot.infoClass !== 'DOCUMENTED' && invented.length) implications.push(`invents ${invented.map((x) => `"${x}"`).join(', ')}`);
    const unknown = unknownProperNouns(text, known);
    if (unknown.length) implications.push(`names ${unknown.join(', ')}, which the evidence does not`);
    const allowedFigures = new Set([...scope.evidence.figuresFor([...ctx.claims.map((c) => c.key), ...shownClaimKeys(shot.direction)]), ...extractFigures([ctx.sequence?.setting.date.value ?? '', ctx.sequence?.setting.location.value ?? ''].join(' '))]);
    const stray = extractFigures(text).filter((f) => !allowedFigures.has(f));
    if (stray.length) implications.push(`shows ${stray.map((f) => (isYear(f) ? `the year ${f}` : f)).join(', ')}, not in its claims or setting`);
    const outsiders = scope.outsiders.filter((o) => mentionsName(text, o.name)).map((o) => o.name);
    if (outsiders.length) implications.push(`depicts ${outsiders.join(', ')}, whom the architecture leaves out`);
    // A real person named in a generated picture but not one of its subjects: nothing says how they are shown.
    if (shot.method && GENERATIVE_METHODS.includes(shot.method)) {
      const pictured = visibleText({ ...shot.direction, overlays: [] }, shot.subjects.map((s) => s.detail.action));
      const subjectCast = new Set(ctx.subjects.map((s) => s.spec.castId));
      const named = [...scope.cast.values()].filter((c) => c.member.kind === 'REAL_PERSON' && !subjectCast.has(c.member.id) && mentionsName(pictured, c.member.name)).map((c) => c.member.name);
      if (named.length) implications.push(`names ${named.join(', ')} in a generated picture without a subject saying how they are shown (a real person: a silhouette or a period-generic figure, never a generated likeness)`);
    }
    const weak = ctx.claims.filter((c) => c.role === 'DEPICTS' && c.claim?.confidence === 'LOW').map((c) => c.key);
    if (weak.length) implications.push(`depicts ${weak.join(', ')}, a low-confidence claim`);
    if (shot.treatment === 'TEXT_ON_SCREEN' && shot.infoClass === 'UNCERTAIN') {
      const worded = shot.direction.overlays.filter((o) => !o.auto && o.claimKeys.some((k) => scope.presentation.has(k)));
      if (worded.length) implications.push(`puts uncertain claims on screen: check the wording follows ${[...new Set(worded.flatMap((o) => o.claimKeys.flatMap((k) => scope.presentation.get(k)?.presentation ?? [])))].join(', ')}`);
    }
    if (implications.length) out.push(finding('VISUAL_IMPLICATION', shot.key, `${shot.key} ${implications.join('; ')}`));

    const avoid = [...shot.direction.mustAvoid.map((m) => m.text), ...inheritedMustAvoid(ctx.blocks, ctx.sequences).map((m) => m.text)];
    const matches = avoidedMatches(text, [...new Set(avoid)]);
    // Once per shot, however it is cased or punctuated: a shot never names itself among the others.
    const period = periodDetails(shot.direction, ctx.sequence).filter((d, i, all) => all.findIndex((x) => flat(x) === flat(d)) === i);
    if (matches.length || period.length) anachronisms.push({ key: shot.key, matches, period, date: ctx.sequence?.setting.date.value ?? '' });
    const framing = ctx.narrationClasses.length > 0 && ctx.narrationClasses.every((c) => c === 'FRAMING');
    if (framing && shot.treatment && FACTUAL_TREATMENTS.includes(shot.treatment) && !ctx.claims.some((c) => c.role === 'CONTEXT')) {
      out.push(finding('FRAMING_FACTUAL_VISUAL', shot.key, `${shot.key} is a ${shot.treatment} over framing narration with no context claim`));
    }
  }
  // What a shot must avoid is its own; a period detail is one check against its date however many shots show it: on the first, naming the others.
  const showing = new Map<string, string[]>();
  for (const a of anachronisms) for (const d of a.period) showing.set(`${flat(d)}\u0000${a.date}`, [...(showing.get(`${flat(d)}\u0000${a.date}`) ?? []), a.key]);
  for (const a of anachronisms) {
    const period = a.period.flatMap((d) => {
      const [first, ...others] = showing.get(`${flat(d)}\u0000${a.date}`)!;
      return first === a.key ? [others.length ? `${d}, also in ${others.join(', ')}` : d] : [];
    });
    if (!a.matches.length && !period.length) continue;
    const parts = [...(a.matches.length ? [`shows what it must avoid (${a.matches.join('; ')})`] : []), ...(period.length ? [`has period details resting on the period's look only (${period.join('; ')}) in a sequence dated ${a.date}`] : [])];
    out.push(finding('ANACHRONISM_RISK', a.key, `${a.key} ${parts.join('; ')}: check against the period`));
  }

  // Must-shows the script or the sequence asked for over these words, each asked once: a block's own over its words; a sequence's over
  // all the words that tell its claims, however many blocks tell them. One carries another when either names every content word of
  // the other (an empty or a bare "the" carries nothing); a shot carries one too when any one sentence of what it shows names every
  // content word of it, outside a negation (words spread over separate sentences name nothing). Words are all code can compare: a
  // paraphrase in other words, or words joined only by a comma, can still mislead.
  const carries = (shown: string, wanted: string) => {
    const a = avoidWords(shown);
    const b = avoidWords(wanted);
    if (!a.length) return false;
    return b.length ? b.every((w) => a.includes(w)) || a.every((w) => b.includes(w)) : flat(shown) === flat(wanted);
  };
  const shows = (shot: PlannedShot, wanted: string) => showsAll(visibleText(shot.direction, shot.subjects.map((s) => s.detail.action)), avoidWords(wanted));
  const asks = new Map<string, { detail: string; origin: 'SCRIPT' | 'SEQUENCE'; blocks: string[] }>();
  const own = (blockKey: string, detail: string) => `SCRIPT\u0000${blockKey}\u0000${flat(detail)}`;
  for (const b of facts.spine.blocks) {
    for (const m of inheritedMustShow(scope, b.block, scope.sequences.get(b.sequence) ?? null)) {
      const id = m.origin === 'SCRIPT' ? own(b.key, m.detail) : `SEQUENCE\u0000${b.sequence}\u0000${flat(m.detail)}`;
      const ask = asks.get(id) ?? { detail: m.detail, origin: m.origin, blocks: [] };
      if (!ask.blocks.includes(b.key)) ask.blocks.push(b.key);
      asks.set(id, ask);
    }
  }
  for (const ask of asks.values()) {
    // A block's own must-show of the same detail speaks for the sequence's: carried over that block, it carries the sequence's too; dropped, it is reported once.
    if (ask.origin === 'SEQUENCE' && ask.blocks.some((k) => asks.has(own(k, ask.detail)))) continue;
    const covering = p.shots.filter((s) => s.blocks.some((r) => ask.blocks.includes(r.blockKey)));
    if (covering.some((s) => s.direction.mustShow.some((x) => carries(x.detail, ask.detail)) || shows(s, ask.detail))) continue;
    const beat = p.beats.find((x) => x.blocks.some((r) => r.blockKey === ask.blocks[0]));
    out.push(finding('MUST_SHOW_DROPPED', beat?.key ?? null, `The ${ask.origin === 'SCRIPT' ? 'script' : 'sequence'} asks to show "${ask.detail}" over ${ask.blocks.join(', ')}; no shot over those words names it`));
  }
}
