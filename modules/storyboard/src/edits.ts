import {
  TREATMENT_METHODS,
  shotKey as makeShotKey,
  type CostAlternative,
  type CutReason,
  type StoryboardDecisionKind,
  type StoryboardEditOp,
  type VersionChanges,
} from '@docengine/core';
import { nextKey, type DraftShot, type PlannedBeat, type PlannedShot, type StoryboardDraft, type StoryboardFacts } from './draft.ts';
import { subjectBasis } from './continuity.ts';
import { canonical } from './hash.ts';
import { claimAllowed } from './inherit.ts';
import { planStoryboard } from './plan.ts';
import { shotContext } from './rules.ts';
import { rangeOf, timeStoryboard } from './timing.ts';

/**
 * A person's edits (§2.12): pure operations over a draft, applied in order,
 * that make a new version — no model call. A reference that does not exist,
 * a claim outside the approved evidence, or a cut that cannot move is
 * refused with the reason (EditError), never silently dropped. Decisions on
 * shots whose content and length did not change are carried to the new
 * version as copies; a version's own decision never carries.
 */

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

export interface EditOptions {
  /** The base version's cheaper alternatives (computed from the draft when absent). */
  alternatives?: readonly CostAlternative[];
  /** Keys used by earlier versions, so a new shot never reuses one. */
  usedShotKeys?: Iterable<string>;
}

/** The cut reason a cut point's kind gives a new cut there. */
function reasonAt(kind: string): CutReason {
  switch (kind) {
    case 'SENTENCE':
      return 'SENTENCE_END';
    case 'CLAUSE':
      return 'CLAUSE';
    case 'BLOCK':
      return 'BLOCK_END';
    case 'SECTION':
      return 'SECTION_CHANGE';
    case 'PAUSE':
      return 'PAUSE';
    default:
      return 'SCOPE_EDGE';
  }
}

/** The draft after these edits, and what code noted while applying them. */
export function applyEdits(base: StoryboardDraft, ops: readonly StoryboardEditOp[], facts: StoryboardFacts, o: EditOptions = {}): { draft: StoryboardDraft; notes: string[] } {
  let draft: StoryboardDraft = structuredClone({ ...base, normalization: [] });
  const notes: string[] = [];
  const used = new Set([...draft.shots.map((s) => s.key), ...(o.usedShotKeys ?? [])]);
  const spine = facts.spine;
  const scope = facts.scope;
  const shot = (key: string) => {
    const s = draft.shots.find((x) => x.key === key);
    if (!s) throw new EditError(`There is no shot ${key} in this version`);
    return s;
  };
  const subjectKeys = () => new Set(draft.subjects.map((s) => s.key));
  const ordered = () => {
    const g = timeStoryboard(draft, spine);
    return [...draft.shots].sort((a, b) => (g.shots.get(a.key)?.startMs ?? Infinity) - (g.shots.get(b.key)?.startMs ?? Infinity));
  };
  const point = (id: string) => {
    const p = spine.point(id);
    if (!p) throw new EditError(`${id} is not a cut point of the narration`);
    return p;
  };
  const checkClaims = (s: DraftShot, claims: DraftShot['claims']) => {
    const ctx = shotContext({ narration: s.narration, silenceAt: s.silenceAt, startMs: null, endMs: null, subjects: [], claims: [] }, facts, new Map());
    for (const c of claims) {
      if (!scope.claimSet.has(c.claimKey)) throw new EditError(`${c.claimKey} is not a claim of the approved evidence`);
      if (!claimAllowed(scope, c.role, c.claimKey, ctx.blocks, ctx.sequences)) throw new EditError(`${c.claimKey} cannot be ${c.role} for ${s.key}: it is not a claim of the narration the shot covers`);
    }
  };
  const knownClaims = (keys: readonly string[]) => {
    for (const k of keys) if (!scope.claimSet.has(k)) throw new EditError(`${k} is not a claim of the approved evidence`);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'updateShot': {
        const s = shot(op.shotKey);
        const { treatment, method, infoClass, subjects, claims, ...spec } = op.patch;
        if (treatment && treatment !== s.treatment) {
          s.treatment = treatment;
          s.method = null;
        }
        if (method) {
          if (!s.treatment || !TREATMENT_METHODS[s.treatment].includes(method)) throw new EditError(`${method} cannot make ${s.treatment ?? 'a shot with no treatment'}`);
          s.method = method;
        }
        if (infoClass) s.proposedClass = infoClass;
        if (subjects) {
          const known = subjectKeys();
          for (const x of subjects) {
            if (!known.has(x.subjectKey)) throw new EditError(`There is no continuity subject ${x.subjectKey}`);
            for (const i of x.detail.interactions) if (!known.has(i.withSubjectKey)) throw new EditError(`There is no continuity subject ${i.withSubjectKey}`);
          }
          s.subjects = subjects;
        }
        if (claims) {
          checkClaims(s, claims);
          s.claims = claims;
        }
        if (spec.environment?.subjectKey && !subjectKeys().has(spec.environment.subjectKey)) throw new EditError(`There is no continuity subject ${spec.environment.subjectKey}`);
        for (const list of [spec.objects, spec.specifics, spec.mustShow, spec.overlays]) for (const x of list ?? []) knownClaims(x.claimKeys);
        for (const d of [...(spec.specifics ?? []).map((x) => ({ text: x.detail, ...x })), ...(spec.objects ?? []).map((x) => ({ text: x.name, ...x }))]) {
          if (d.basis === 'CLAIM' && d.claimKeys.length === 0) throw new EditError(`"${d.text}" rests on a claim: name it, or mark the detail period-generic or invented`);
        }
        for (const item of spec.dataSpec?.items ?? []) knownClaims([item.claimKey]);
        // Automatic labels are recomputed on every version.
        const overlays = spec.overlays?.filter((x) => !x.auto);
        s.spec = { ...s.spec, ...spec, ...(overlays ? { overlays } : {}) };
        if (s.unplanned && s.treatment) s.unplanned = false;
        break;
      }
      case 'setTreatment': {
        const s = shot(op.shotKey);
        if (op.method && !TREATMENT_METHODS[op.treatment].includes(op.method)) throw new EditError(`${op.method} cannot make ${op.treatment}`);
        s.treatment = op.treatment;
        s.method = op.method ?? null;
        s.unplanned = false;
        if (s.recommendation) {
          const card = facts.catalog.cards.find((c) => c.provider === s.recommendation!.provider);
          const model = card?.models.find((m) => m.model === s.recommendation!.model);
          const methods = op.method ? [op.method] : TREATMENT_METHODS[op.treatment];
          if (model && !methods.some((m) => model.methods.includes(m))) {
            notes.push(`${s.key}: the chosen ${s.recommendation.provider} ${s.recommendation.model} cannot make ${op.treatment}; the recommendation was cleared`);
            s.recommendation = null;
          }
        }
        break;
      }
      case 'moveCut': {
        const left = shot(op.leftShotKey);
        const right = shot(op.rightShotKey);
        const order = ordered();
        if (order.indexOf(right) !== order.indexOf(left) + 1) throw new EditError(`${left.key} and ${right.key} are not next to each other`);
        if (!left.narration || !right.narration) throw new EditError('A cut beside a silence-only shot is moved with that shot');
        const p = point(op.to);
        const lo = point(left.narration.from).position;
        const hi = point(right.narration.to).position;
        if (p.position <= lo || p.position >= hi) throw new EditError(`${op.to} is not between the start of ${left.key} and the end of ${right.key}`);
        const leftBeat = draft.beats.find((b) => b.key === left.beatKey)!;
        const rightBeat = draft.beats.find((b) => b.key === right.beatKey)!;
        if (leftBeat !== rightBeat) {
          leftBeat.narration = { ...leftBeat.narration, to: p.id };
          rightBeat.narration = { ...rightBeat.narration, from: p.id };
        }
        left.narration = { ...left.narration, to: p.id };
        right.narration = { ...right.narration, from: p.id };
        left.visualTo = null;
        right.visualFrom = null;
        left.cutOut = reasonAt(p.kind);
        right.cutIn = reasonAt(p.kind);
        right.cutOffsetMs = op.offsetMs ?? 0;
        if (op.offsetMs) {
          const t = timeStoryboard(draft, spine);
          const reduced = t.notes.find((n) => n.startsWith(`${right.key}: the cut nudge`));
          if (reduced) throw new EditError(`The cut cannot move by ${op.offsetMs} ms: ${reduced.replace(/^[^—]*— /, '')}`);
        }
        break;
      }
      case 'splitShot': {
        const s = shot(op.shotKey);
        if (!s.narration) throw new EditError(`${s.key} is silence-only: there are no words to split`);
        const p = point(op.at);
        if (p.position <= point(s.narration.from).position || p.position >= point(s.narration.to).position) throw new EditError(`${op.at} is not inside ${s.key}'s words`);
        const key = nextKey(used, makeShotKey);
        used.add(key);
        const second: DraftShot = { ...structuredClone(s), key, narration: { from: p.id, to: s.narration.to }, visualFrom: null, cutIn: reasonAt(p.kind), cutOffsetMs: 0 };
        s.narration = { from: s.narration.from, to: p.id };
        s.visualTo = null;
        s.cutOut = reasonAt(p.kind);
        draft.shots.splice(draft.shots.indexOf(s) + 1, 0, second);
        break;
      }
      case 'mergeShots': {
        const [a, b] = [shot(op.shotKeys[0]), shot(op.shotKeys[1])];
        const order = ordered();
        if (order.indexOf(b) !== order.indexOf(a) + 1) throw new EditError(`${a.key} is not right before ${b.key}`);
        if (a.beatKey !== b.beatKey) throw new EditError(`${a.key} and ${b.key} are in different beats`);
        if (a.narration && b.narration) a.narration = { from: a.narration.from, to: b.narration.to };
        else if (!a.narration && b.narration) {
          a.narration = b.narration;
          a.silenceAt = null;
        }
        a.visualTo = b.visualTo;
        a.cutOut = b.cutOut;
        for (const c of b.claims) if (!a.claims.some((x) => x.claimKey === c.claimKey && x.role === c.role)) a.claims.push(c);
        for (const x of b.subjects) if (!a.subjects.some((y) => y.subjectKey === x.subjectKey)) a.subjects.push(x);
        draft.shots = draft.shots.filter((s) => s !== b);
        break;
      }
      case 'reorderShots': {
        const beatShots = ordered().filter((s) => s.beatKey === op.beatKey);
        if (!draft.beats.some((b) => b.key === op.beatKey)) throw new EditError(`There is no beat ${op.beatKey}`);
        const keys = beatShots.map((s) => s.key);
        if (op.order.length !== keys.length || [...op.order].sort().join() !== [...keys].sort().join()) throw new EditError(`The order must list each shot of ${op.beatKey} once (${keys.join(', ')})`);
        // Content moves between the beat's time slots; the narration stays with its slot.
        const slots = beatShots.map((s) => ({ narration: s.narration, silenceAt: s.silenceAt, visualFrom: s.visualFrom, visualTo: s.visualTo, cutIn: s.cutIn, cutOut: s.cutOut, cutOffsetMs: s.cutOffsetMs }));
        const contents = op.order.map((k) => structuredClone(beatShots.find((s) => s.key === k)!));
        const moved = contents.map((c, i) => ({ ...c, ...slots[i]! }));
        draft.shots = draft.shots.map((s) => (s.beatKey === op.beatKey ? moved.shift()! : s));
        break;
      }
      case 'updateBeat': {
        const b = draft.beats.find((x) => x.key === op.beatKey);
        if (!b) throw new EditError(`There is no beat ${op.beatKey}`);
        const { continuityNotes, ...rest } = op.patch;
        b.content = { ...b.content, ...rest, ...(continuityNotes ? { continuity: { ...b.content.continuity, notes: continuityNotes } } : {}) };
        break;
      }
      case 'setRecommendation': {
        shot(op.shotKey).recommendation = { provider: op.provider, model: op.model };
        if (!facts.catalog.cards.some((c) => c.provider === op.provider)) notes.push(`${op.shotKey}: ${op.provider} is not in the visual catalog; its estimate is unpriced`);
        break;
      }
      case 'clearRecommendation':
        shot(op.shotKey).recommendation = null;
        break;
      case 'applyAlternative': {
        const list = o.alternatives ?? planStoryboard(draft, facts).alternatives;
        const alt = list.find((a) => a.id === op.alternativeId);
        if (!alt) throw new EditError(`The alternative ${op.alternativeId} does not apply to this version`);
        for (const k of alt.shotKeys) {
          const s = shot(k);
          s.treatment = alt.to.treatment;
          s.method = alt.to.method;
          s.recommendation = null;
        }
        notes.push(`Applied "${alt.title}" to ${alt.shotKeys.join(', ')}`);
        break;
      }
      case 'updateContinuity': {
        const subject = draft.subjects.find((s) => s.key === op.subjectKey);
        if (!subject) throw new EditError(`There is no continuity subject ${op.subjectKey}`);
        for (const d of op.patch.designDetails ?? []) {
          knownClaims(d.claimKeys);
          if (d.basis === 'CLAIM' && d.claimKeys.length === 0) throw new EditError(`"${d.detail}" rests on a claim: name it, or mark the detail period-generic or invented`);
        }
        subject.spec = { ...subject.spec, ...op.patch };
        // Its basis follows its design details, as when it was proposed.
        subject.spec.basis = subjectBasis(subject.spec, subject.spec.castId ? (scope.cast.get(subject.spec.castId) ?? null) : null);
        break;
      }
      case 'setProfile':
        notes.push(`The visual profile was changed (selection revision ${op.selectionRevision}): shots re-costed, their content unchanged`);
        break;
    }
  }
  draft = { ...draft, normalization: notes };
  for (const b of draft.beats) if (typeof rangeOf(spine, b.narration) === 'string') throw new EditError(`${b.key} no longer covers any words`);
  return { draft, notes };
}

// ── Carried decisions ────────────────────────────────────────────────────────

/** A shot of the base version with its latest decision (null: none). */
export interface DecidedShot {
  shotKey: string;
  contentHash: string;
  durationMs: number | null;
  latest: { id: string; decision: StoryboardDecisionKind } | null;
}

/** How far a shot's length may move and still carry a decision: 10% of it, or 300 ms, whichever is more. */
export const sameDuration = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= Math.max(0.1 * a, 300);

/**
 * The shot decisions a new version carries (§2.12): a shot with the same key
 * and content hash, and a length within 10% or 300 ms of the base shot,
 * gets its latest decision copied (labelled "carried from vN"); a cleared
 * decision is nothing to carry. Every other shot starts pending.
 */
export function carriedDecisions(base: readonly DecidedShot[], next: readonly { shotKey: string; contentHash: string; durationMs: number | null }[]): { shotKey: string; fromDecisionId: string; decision: StoryboardDecisionKind }[] {
  const byKey = new Map(base.map((b) => [b.shotKey, b]));
  return next.flatMap((n) => {
    const b = byKey.get(n.shotKey);
    if (!b?.latest || b.latest.decision === 'CLEARED' || b.contentHash !== n.contentHash || !sameDuration(b.durationMs, n.durationMs)) return [];
    return [{ shotKey: n.shotKey, fromDecisionId: b.latest.id, decision: b.latest.decision }];
  });
}

// ── What changed from the base ───────────────────────────────────────────────

type ShotFields = Pick<PlannedShot, 'key' | 'beatKey' | 'treatment' | 'method' | 'infoClass' | 'narration' | 'silenceAt' | 'visualFrom' | 'visualTo' | 'startMs' | 'endMs' | 'direction' | 'claims' | 'subjects' | 'recommendation' | 'cost'>;
type BeatFields = Pick<PlannedBeat, 'key' | 'narration' | 'treatment' | 'stored' | 'claimKeys'>;

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** What changed from the base version: shots and beats added, removed, and changed with the fields that differ. */
export function versionChanges(baseVersion: number, base: { shots: readonly ShotFields[]; beats: readonly BeatFields[] }, next: { shots: readonly ShotFields[]; beats: readonly BeatFields[] }): VersionChanges {
  const diff = <T extends { key: string }>(a: readonly T[], b: readonly T[], fields: (x: T, y: T) => string[]) => {
    const before = new Map(a.map((x) => [x.key, x]));
    const after = new Map(b.map((x) => [x.key, x]));
    return {
      added: b.filter((x) => !before.has(x.key)).map((x) => x.key),
      removed: a.filter((x) => !after.has(x.key)).map((x) => x.key),
      changed: b.flatMap((y) => {
        const x = before.get(y.key);
        const f = x ? fields(x, y) : [];
        return f.length ? [{ key: y.key, fields: f }] : [];
      }),
    };
  };
  const shotFields = (x: ShotFields, y: ShotFields) => {
    const out: string[] = [];
    if (x.beatKey !== y.beatKey) out.push('beat');
    if (x.treatment !== y.treatment) out.push('treatment');
    if (x.method !== y.method) out.push('method');
    if (x.infoClass !== y.infoClass) out.push('infoClass');
    if (!same([x.narration, x.silenceAt, x.visualFrom, x.visualTo], [y.narration, y.silenceAt, y.visualFrom, y.visualTo])) out.push('narration');
    if (x.startMs !== y.startMs || x.endMs !== y.endMs) out.push('times');
    for (const k of Object.keys(y.direction) as (keyof ShotFields['direction'])[]) if (!same(x.direction[k], y.direction[k])) out.push(k);
    if (!same(x.claims, y.claims)) out.push('claims');
    if (!same(x.subjects, y.subjects)) out.push('subjects');
    if (!same(x.recommendation, y.recommendation)) out.push('recommendation');
    if (x.cost?.totalUsd !== y.cost?.totalUsd || x.cost?.basis !== y.cost?.basis) out.push('cost');
    return out;
  };
  const beatFields = (x: BeatFields, y: BeatFields) => {
    const out: string[] = [];
    if (!same(x.narration, y.narration)) out.push('narration');
    if (x.treatment !== y.treatment) out.push('treatment');
    for (const k of ['title', 'purpose', 'concept', 'importance', 'options', 'continuity', 'evidenceRelationship'] as const) if (!same(x.stored[k], y.stored[k])) out.push(k);
    if (!same(x.claimKeys, y.claimKeys)) out.push('claims');
    return out;
  };
  const s = diff(base.shots, next.shots, shotFields);
  const b = diff(base.beats, next.beats, beatFields);
  return {
    baseVersion,
    shots: { added: s.added, removed: s.removed, changed: s.changed.map((c) => ({ shotKey: c.key, fields: c.fields })) },
    beats: { added: b.added, removed: b.removed, changed: b.changed.map((c) => ({ beatKey: c.key, fields: c.fields })) },
  };
}
