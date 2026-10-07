import {
  GENERATED_VIDEO_METHODS,
  METHOD_SOURCING,
  STORYBOARD_LIMITS,
  parseCutPointId,
  type AssetRequirement,
  type ContinuitySpec,
  type ProductionMethod,
  type ReuseCategory,
  type ScriptBlockClass,
  type ShotOverlay,
  type ShotSpec,
  type VisualAssetType,
  type VisualTreatment,
} from '@docengine/core';
import { costAlternatives } from './alternatives.ts';
import { approachSummaries } from './approaches.ts';
import { planSubjects, shotSubjectKeys } from './continuity.ts';
import { droppedNote, type DraftShot, type PlannedBeat, type PlannedShot, type PlannedStoryboard, type ShotContent, type StoryboardDraft, type StoryboardFacts } from './draft.ts';
import { beatHash, canonical, sha256, shotHash } from './hash.ts';
import { claimFacts, deriveClass, evidenceSnapshot, groundedSpec, inheritedMustAvoid, isFictional, isReal, labelObligation, narrativeClass, shotDepiction, shownFacts } from './inherit.ts';
import { rhythmStats } from './rhythm.ts';
import { costRollup, pricingSnapshot, routeShot } from './route.ts';
import { checkStoryboard, shotContext, type CheckOptions, type ShotContext } from './rules.ts';
import { timeStoryboard, type ShotGeometry } from './timing.ts';

/**
 * Judging a draft (§2.11 S5): times and relations from the cut points; each
 * shot's class and depiction derived; the automatic labels added; route and
 * cost; the asset requirement with its reuse record; the evidence snapshot;
 * continuity appearances; content hashes; rhythm, the approaches table,
 * cheaper alternatives and the full QA. Deterministic: the same draft, the
 * same narration, evidence, profile and catalog give the same version.
 */

/** The automatic reconstruction label: internal (brief §10); whether it is shown on screen is the edit's choice. */
export const RECONSTRUCTION_LABEL: ShotOverlay = { kind: 'RECONSTRUCTION_LABEL', text: 'Reconstruction', reason: 'A reconstruction of documented circumstances (an internal label)', claimKeys: [], auto: true };

function fictionLabel(names: readonly string[], blockKey: string): ShotOverlay {
  return {
    kind: 'FICTION_LABEL',
    text: names.length ? `${names.join(', ')}: a fictional character` : 'A fictional device',
    reason: `The script promises an on-screen label for the fictional device in ${blockKey}`,
    claimKeys: [],
    auto: true,
  };
}

/** What asset a method produces. */
function assetType(method: ProductionMethod, treatment: VisualTreatment): VisualAssetType {
  switch (method) {
    case 'GENERATIVE_VIDEO':
    case 'IMAGE_TO_VIDEO':
    case 'SCREEN_RECORDING':
    case 'STOCK_SOURCING':
      return 'VIDEO_CLIP';
    case 'GENERATIVE_IMAGE':
    case 'STILL_MOTION':
      return 'IMAGE';
    case 'DETERMINISTIC_GRAPHIC':
    case 'MOTION_DESIGN':
      return 'GRAPHIC';
    case 'MAP_RENDER':
      return 'MAP';
    case 'DOCUMENT_MOTION':
      return 'DOCUMENT';
    case 'ARCHIVAL_SOURCING':
      return treatment === 'ARCHIVAL_VIDEO' || treatment === 'NEWS_FOOTAGE' ? 'VIDEO_CLIP' : 'IMAGE';
    case 'EDIT_TIME':
      return treatment === 'TEXT_ON_SCREEN' ? 'TEXT' : 'NONE';
  }
}

/** Assets a later reuse library files by place, map, document or establishing view (a person or an action is not reused). */
const REUSABLE: readonly ReuseCategory[] = ['ENVIRONMENT', 'LOCATION', 'ESTABLISHING', 'DOCUMENT', 'MAP', 'TRANSITION'];

/** What a later library would file the asset under; a place is reusable only when a continuity subject identifies it. */
function reuseCategory(treatment: VisualTreatment, subjects: readonly ContinuitySpec[], environment: ContinuitySpec | null): ReuseCategory {
  if (treatment === 'TRANSITION') return 'TRANSITION';
  if (treatment === 'MAP_ANIMATION') return 'MAP';
  if (treatment === 'DOCUMENT_ANIMATION') return 'DOCUMENT';
  if (subjects.some((s) => s.kind === 'CHARACTER')) return 'CHARACTER';
  if (!environment) return 'OTHER';
  if (treatment === 'ENVIRONMENT') return environment.kind === 'LOCATION' || environment.kind === 'BUILDING' ? 'LOCATION' : 'ENVIRONMENT';
  if (treatment === 'CINEMATIC_RECONSTRUCTION' || treatment === 'GENERATED_STILL') return 'ESTABLISHING';
  return 'OTHER';
}

interface Core {
  shot: DraftShot;
  geometry: ShotGeometry | undefined;
  ctx: ShotContext;
  method: ProductionMethod | null;
  infoClass: ScriptBlockClass | null;
  direction: ShotSpec;
  claims: DraftShot['claims'];
  subjects: DraftShot['subjects'];
}

/** The section where a cut point is (for a shot or beat that cannot be timed). */
function sectionOfId(id: string | null, facts: StoryboardFacts): { sceneId: string; sectionKey: string; sequence: number } {
  const ref = id ? parseCutPointId(id) : null;
  const blocks = facts.spine.blocks;
  const key = !ref ? blocks[0]?.key : 'edge' in ref ? (ref.edge === 'START' ? blocks[0]?.key : blocks.at(-1)?.key) : ref.blockKey;
  const section = facts.script.sections.find((s) => s.blocks.some((b) => b.key === key)) ?? facts.script.sections[0]!;
  return { sceneId: section.rowId!, sectionKey: section.key, sequence: section.sequence };
}

export function planStoryboard(draft: StoryboardDraft, facts: StoryboardFacts, o: CheckOptions = {}): PlannedStoryboard {
  const notes = [...draft.normalization];
  const note = (n: string) => {
    if (!notes.includes(n)) notes.push(n);
  };
  const timing = timeStoryboard(draft, facts.spine);
  timing.notes.forEach(note);
  const profile = facts.profile.effective;
  const draftSubjects = new Map(draft.subjects.map((s) => [s.key, s]));

  const ordered = draft.shots
    .map((shot, i) => ({ shot, i, g: timing.shots.get(shot.key) }))
    .sort((a, b) => (a.g?.startMs ?? Infinity) - (b.g?.startMs ?? Infinity) || a.i - b.i);

  // Pass 1: what each shot shows and asserts.
  const cores: Core[] = ordered.map(({ shot, g }) => {
    const anchors = timing.anchors.get(shot.key)!;
    const kept: DraftShot = { ...shot, ...anchors };
    const subjects = kept.subjects.filter((s) => {
      if (draftSubjects.has(s.subjectKey)) return true;
      note(droppedNote(kept.key, `the subject ${s.subjectKey}`, 'no such continuity subject'));
      return false;
    });
    const environmentKey = kept.spec.environment.subjectKey && draftSubjects.has(kept.spec.environment.subjectKey) ? kept.spec.environment.subjectKey : null;
    if (kept.spec.environment.subjectKey && !environmentKey) note(droppedNote(kept.key, `the environment ${kept.spec.environment.subjectKey}`, 'no such continuity subject'));
    const spec: ShotContent = { ...kept.spec, environment: { ...kept.spec.environment, subjectKey: environmentKey }, overlays: kept.spec.overlays.filter((x) => !x.auto) };
    const claims = kept.claims.filter((c, i) => kept.claims.findIndex((x) => x.claimKey === c.claimKey && x.role === c.role) === i);
    const ctx = shotContext({ narration: kept.narration, silenceAt: kept.silenceAt, startMs: g?.startMs ?? null, endMs: g?.endMs ?? null, subjects, claims }, facts, draftSubjects);
    const specs = ctx.subjects.map((s) => s.spec);
    const base = { shot: { ...kept, subjects, claims, spec }, geometry: g, ctx, claims, subjects };
    if (kept.unplanned || !kept.treatment) {
      return { ...base, method: null, infoClass: null, direction: { ...spec, depiction: 'ILLUSTRATIVE' } };
    }
    const route = routeShot({ treatment: kept.treatment, method: kept.method, durationMs: g ? g.endMs - g.startMs : 0, realPerson: specs.some(isReal), fictionalSubject: specs.some(isFictional), recommendation: null, reuseOf: null }, profile, facts.catalog);
    for (const r of route.reasons) note(`${kept.key}: ${r}`);
    const depiction = shotDepiction(kept.treatment, route.method, specs, spec, claims);
    const derived = deriveClass({ depiction, claims: ctx.claims, shown: shownFacts(facts.scope, spec), grounded: groundedSpec(spec), narrationClasses: ctx.narrationClasses, beatBases: ctx.beatBases, proposed: kept.proposedClass });
    if (derived.note) note(`${kept.key}: ${derived.note}`);
    const overlays = [...spec.overlays];
    if (derived.infoClass === 'RECONSTRUCTION' && depiction === 'RECONSTRUCTED') overlays.push(RECONSTRUCTION_LABEL);
    const mustAvoid = [...spec.mustAvoid];
    for (const m of inheritedMustAvoid(ctx.blocks, ctx.sequences)) if (!mustAvoid.some((x) => x.text.toLowerCase() === m.text.toLowerCase())) mustAvoid.push(m);
    const direction: ShotSpec = {
      ...spec,
      overlays,
      mustAvoid: mustAvoid.slice(0, 24),
      continuity: { subjectKeys: shotSubjectKeys({ subjects, spec }).slice(0, 12), notes: spec.continuity.notes },
      depiction,
    };
    return { ...base, method: route.method, infoClass: derived.infoClass, direction };
  });

  // The fiction labels the script promised: on the first shot over the block (one showing the fictional character, if any).
  for (const b of facts.spine.blocks) {
    if (!labelObligation(b.block)) continue;
    const covering = cores.filter((c) => c.shot.narration && c.ctx.blocks.some((x) => x.key === b.key) && !c.shot.unplanned);
    if (!covering.length || covering.some((c) => c.direction.overlays.some((x) => x.kind === 'FICTION_LABEL'))) continue;
    const target = covering.find((c) => c.ctx.subjects.some((s) => isFictional(s.spec))) ?? covering[0]!;
    if (target.direction.overlays.length >= STORYBOARD_LIMITS.overlays + 2) continue;
    target.direction = { ...target.direction, overlays: [...target.direction.overlays, fictionLabel(target.ctx.subjects.filter((s) => isFictional(s.spec)).map((s) => s.spec.name), b.key)] };
  }

  // Pass 2: subjects and where they appear.
  const subjects = planSubjects(draft.subjects, cores.map((c) => ({ ...c.shot, spec: c.direction })));
  const plannedSubjects = new Map(subjects.map((s) => [s.key, s]));

  // Pass 3: asset requirements, reuse, cost, evidence and hashes.
  const reuseFirst = new Map<string, { key: string; durationMs: number }[]>();
  const shots: PlannedShot[] = cores.map((c, sortOrder) => {
    const { shot, geometry: g, ctx } = c;
    const where = g ?? sectionOfId(shot.narration?.from ?? shot.silenceAt, facts);
    const claimRows = c.claims.flatMap((x) => {
      const claim = facts.scope.evidence.claim(x.claimKey);
      return claim ? [{ claimId: claim.id, claimKey: x.claimKey, role: x.role }] : [];
    });
    let asset: AssetRequirement | null = null;
    let cost: PlannedShot['cost'] = null;
    if (shot.treatment && c.method && !shot.unplanned) {
      const durationMs = g ? g.endMs - g.startMs : 0;
      const specs = ctx.subjects.map((s) => plannedSubjects.get(s.key)?.spec ?? s.spec);
      const envKey = c.direction.environment.subjectKey;
      const environment = envKey ? (plannedSubjects.get(envKey)?.spec ?? null) : null;
      const category = reuseCategory(shot.treatment, specs, environment);
      const reusable = REUSABLE.includes(category);
      const setting = ctx.sequence?.setting;
      // A place a continuity subject identifies is the same place in every sequence; otherwise the sequence's setting says where and when.
      const location = environment ? environment.location : setting?.location.value || null;
      const era = environment ? environment.era : setting?.date.value || null;
      const keysShown = shotSubjectKeys({ subjects: c.subjects, spec: c.direction });
      const claimKeys = [...new Set(c.claims.map((x) => x.claimKey))].sort();
      // A place seen again is one asset, unless something happens in it (a depicted claim); a generated establishing view is one asset only when the picture is the same.
      const place = category === 'ENVIRONMENT' || category === 'LOCATION' || category === 'ESTABLISHING';
      const depicted = [...new Set(c.claims.filter((x) => x.role === 'DEPICTS').map((x) => x.claimKey))].sort();
      const d = c.direction;
      const picture = category === 'ESTABLISHING' ? { description: d.description, composition: d.composition, shotType: d.shotType, movement: d.movement.motion, lighting: d.lighting, mood: d.mood, objects: d.objects, specifics: d.specifics } : null;
      const reuseKey = `${category.toLowerCase()}-${sha256(canonical({ treatment: shot.treatment, method: c.method, subjects: [...keysShown].sort(), location, era, profile: [facts.profile.profileId, facts.profile.version], claims: place ? depicted : claimKeys, data: d.dataSpec, picture })).slice(0, 16)}`;
      // Generated footage lasts as long as it was made: a longer shot of the same picture needs footage of its own.
      const made = reusable ? (reuseFirst.get(reuseKey) ?? []) : [];
      const reuseOf = made.find((m) => !GENERATED_VIDEO_METHODS.includes(c.method!) || durationMs <= m.durationMs)?.key ?? null;
      if (reusable && !reuseOf) reuseFirst.set(reuseKey, [...made, { key: shot.key, durationMs }]);
      const route = routeShot({ treatment: shot.treatment, method: c.method, durationMs, realPerson: specs.some(isReal), fictionalSubject: specs.some(isFictional), recommendation: shot.recommendation, reuseOf }, profile, facts.catalog);
      cost = route.estimate;
      const sourcing = METHOD_SOURCING[c.method];
      asset = {
        assetType: assetType(c.method, shot.treatment),
        method: c.method,
        sourcing,
        durationSec: Math.round(durationMs) / 1000,
        aspectRatio: profile.aspectRatio,
        resolution: profile.resolution,
        references: keysShown.filter((k) => plannedSubjects.get(k)?.spec.referenceAsset.required).map((k) => ({ subjectKey: k, status: 'MISSING' as const })),
        licensing:
          sourcing === 'SOURCE' && c.method !== 'SCREEN_RECORDING'
            ? { status: 'REQUIRED', note: 'A licence per item; unpriced unless a price is set' }
            : c.method === 'SCREEN_RECORDING'
              ? { status: 'UNKNOWN', note: 'Depends on what is recorded' }
              : { status: 'NOT_APPLICABLE', note: '' },
        reuse: {
          reusable,
          reuseKey,
          category,
          subjects: keysShown,
          location,
          era,
          style: { profileId: facts.profile.profileId, version: facts.profile.version },
          claimKeys,
          projectId: facts.projectId,
          provider: cost.provider,
          model: cost.model,
          source: null,
          promptVersion: null,
        },
        reuseOf,
      };
    }
    const evidence = shot.unplanned ? null : evidenceSnapshot(facts.scope, claimFacts(facts.scope, c.claims), ctx.blocks, [], ctx.sequence);
    const anchors = { narration: shot.narration, silenceAt: shot.silenceAt, visualFrom: shot.visualFrom, visualTo: shot.visualTo, cutIn: shot.cutIn, cutOut: shot.cutOut };
    return {
      ...shot,
      method: shot.method,
      sortOrder,
      sceneId: where.sceneId,
      sectionKey: where.sectionKey,
      startMs: g?.startMs ?? null,
      endMs: g?.endMs ?? null,
      relation: g?.relation ?? null,
      timing: g?.timing ?? null,
      narrationAnchor: g?.narrationAnchor ?? null,
      infoClass: c.infoClass,
      direction: c.direction,
      blocks: g?.blocks ?? [],
      claimRows,
      evidence,
      asset,
      cost,
      contentHash: shotHash({ beatKey: shot.beatKey, treatment: shot.treatment, method: c.method, infoClass: c.infoClass, spec: c.direction, asset, claims: claimRows, subjects: c.subjects, anchors }),
    };
  });
  // A shot's method is what the router chose (the draft's request is kept only when it was used).
  shots.forEach((s, i) => {
    s.method = cores[i]!.method;
  });

  // Beats.
  const beatOrder = draft.beats
    .map((b, i) => ({ b, i, g: timing.beats.get(b.key) }))
    .sort((x, y) => (x.g?.startMs ?? Infinity) - (y.g?.startMs ?? Infinity) || x.i - y.i);
  const beats: PlannedBeat[] = beatOrder.map(({ b, g }, sortOrder) => {
    const where = g ?? sectionOfId(b.narration.from, facts);
    const blocks = (g?.blocks ?? []).flatMap((r) => (facts.spine.block(r.blockKey) ? [facts.spine.block(r.blockKey)!.block] : []));
    const archBeatIds = b.archBeatIds.length ? b.archBeatIds : [...new Set(blocks.flatMap((x) => x.beatIds))].filter((id) => facts.scope.beats.has(id));
    const functions = [...new Set(archBeatIds.flatMap((id) => (facts.scope.beats.get(id) ? [facts.scope.beats.get(id)!.beat.function] : [])))].slice(0, 4);
    const own = shots.filter((s) => s.beatKey === b.key);
    const claimKeys = [...new Set([...b.claimKeys, ...own.flatMap((s) => s.claimRows.map((r) => r.claimKey))])];
    const claimRows = claimKeys.flatMap((k) => (facts.scope.evidence.claim(k) ? [{ claimId: facts.scope.evidence.claim(k)!.id, claimKey: k }] : []));
    const infoClass = narrativeClass(blocks.map((x) => x.infoClass));
    const treatment = b.content.options[draft.approach].treatment;
    const stored = {
      title: b.content.title,
      purpose: b.content.purpose,
      concept: b.content.concept,
      informationCommunicated: b.content.informationCommunicated,
      narrativePurpose: b.content.narrativePurpose,
      functions,
      evidenceRelationship: b.content.evidenceRelationship,
      importance: b.content.importance,
      complexity: b.content.complexity,
      continuity: b.content.continuity,
      narration: b.narration,
      approach: draft.approach,
      options: b.content.options,
    };
    return {
      ...b,
      archBeatIds,
      sortOrder,
      sceneId: where.sceneId,
      sectionKey: where.sectionKey,
      sequenceNumber: g?.sequence ?? where.sequence,
      startMs: g?.startMs ?? null,
      endMs: g?.endMs ?? null,
      treatment,
      infoClass,
      stored,
      blocks: g?.blocks ?? [],
      claimRows,
      shotKeys: own.map((s) => s.key),
      contentHash: beatHash({ key: b.key, content: stored, archBeatIds, treatment, infoClass, claimIds: claimRows.map((r) => r.claimId) }),
    };
  });

  const runtimeMs = facts.spine.totalDurationMs;
  const costs = costRollup(shots.map((s) => ({ key: s.key, treatment: s.treatment, method: s.method, sectionKey: s.sectionKey, beatKey: s.beatKey, cost: s.cost })), runtimeMs);
  const subjectSpecs = new Map(subjects.map((s) => [s.key, { spec: s.spec }]));
  const coverage = evidenceCoverage(shots, facts);
  const planned: PlannedStoryboard = {
    approach: draft.approach,
    beats,
    shots,
    subjects,
    scope: {
      kind: facts.scopeKind,
      blockKeys: facts.spine.blocks.map((b) => b.key),
      sectionKeys: facts.spine.sections.map((s) => s.key),
      startMs: 0,
      endMs: runtimeMs,
      outOfScopeBlocks: facts.spine.outOfScope.length,
    },
    runtimeMs,
    approaches: { chosen: draft.approach, options: approachSummaries(beats, subjectSpecs, facts, notes) },
    alternatives: costAlternatives(shots, subjectSpecs, facts),
    rhythm: rhythmStats(shots, beats, facts),
    costs,
    evidenceCoverage: coverage,
    pricing: pricingSnapshot(facts.catalog, shots.map((s) => s.cost)),
    normalization: notes,
    qa: [],
    qaPassed: false,
  };
  planned.qa = checkStoryboard(planned, facts, o);
  planned.qaPassed = !planned.qa.some((f) => f.severity === 'BLOCKING');
  return planned;
}

/** Factual shots (a factual class shown as a record, a reconstruction or data, or any depicting, source or data claim) and how many rest on a traceable source, every claim they depict included. */
export function evidenceCoverage(shots: readonly PlannedShot[], facts: StoryboardFacts): PlannedStoryboard['evidenceCoverage'] {
  let factualShots = 0;
  let traced = 0;
  const untraced: string[] = [];
  for (const s of shots) {
    if (s.unplanned) continue;
    const claims = claimFacts(facts.scope, s.claims);
    const roles = claims.filter((c) => c.role === 'DEPICTS' || c.role === 'SHOWS_SOURCE' || c.role === 'DATA');
    const cls = s.infoClass;
    const d = s.direction.depiction;
    const factual = ((cls === 'DOCUMENTED' || cls === 'RECONSTRUCTION' || cls === 'UNCERTAIN') && (d === 'RECORD' || d === 'RECONSTRUCTED' || d === 'DATA')) || roles.length > 0;
    if (!factual) continue;
    factualShots++;
    if ((roles.length ? roles : claims).some((c) => c.sources.length > 0) && claims.every((c) => c.role !== 'DEPICTS' || c.sources.length > 0)) traced++;
    else untraced.push(s.key);
  }
  return { factualShots, traced, untraced };
}
