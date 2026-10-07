import { CONTINUITY_KINDS, type ContinuityKind, type ContinuitySpec, type ScriptBlockClass, type ShotSubjectDetail } from '@docengine/core';
import type { ScriptScope } from '@docengine/script';
import { unknownProperNouns } from '@docengine/story/shared';
import { droppedNote, type DraftShot, type DraftSubject, type PlannedSubject } from './draft.ts';
import { subjectHash } from './hash.ts';
import { isFictional, isReal } from './inherit.ts';

/**
 * Continuity (§19): recurring characters, environments, places, objects,
 * documents and maps, and what must stay the same wherever they appear.
 * Characters are the architecture's cast or anonymous background figures:
 * the storyboard never invents a named character. Each subject knows where
 * it appears, and one that recurs (or a fictional character) requires a
 * reference asset before anything is generated — none exists in V1, so the
 * storyboard says "Requires ⟨name⟩ continuity asset".
 */

/** A subject as a model or a person proposes it (the spec without what code decides). */
export type SubjectProposal = Omit<ContinuitySpec, 'castKind' | 'basis' | 'referenceAsset'> & { key: string };

const RULES = {
  fictional: ['A fictional device: observes real people, never interacts with them', 'Never shown in a documented scene'],
  real: ['A real person: no generated likeness (a silhouette, a period-generic figure or a documented likeness)'],
  anonymous: ['Anonymous: never named or given a known face'],
} as const;

/**
 * A proposed subject resolved against the architecture: a cast id it does
 * not have is dropped, and a named character without one is an invented
 * character, dropped too. A cast member keeps the cast's name and kind.
 * Null: the subject is dropped (the note says why).
 */
export function resolveSubject(p: SubjectProposal, scope: ScriptScope, notes: string[]): DraftSubject | null {
  let castId = p.castId?.trim() || null;
  if (castId && !scope.cast.has(castId)) {
    notes.push(droppedNote(p.key, `the cast id "${castId}"`, 'it is not in the architecture'));
    castId = null;
  }
  if (castId && p.kind !== 'CHARACTER') {
    notes.push(droppedNote(p.key, `the cast id "${castId}"`, `a ${p.kind.toLowerCase()} is not a cast member`));
    castId = null;
  }
  const cast = castId ? scope.cast.get(castId)! : null;
  const anonymous = cast ? false : p.anonymous;
  if (p.kind === 'CHARACTER' && !cast && (!anonymous || unknownProperNouns(`Seen: ${p.name}.`, scope.known).length > 0)) {
    notes.push(droppedNote(p.key, `the character "${p.name}"`, 'it is neither a cast member nor an unnamed figure (INVENTED_CHARACTER)'));
    return null;
  }
  const designDetails = p.designDetails.map((d) => {
    const keys = d.claimKeys.filter((k) => scope.claimSet.has(k));
    if (keys.length < d.claimKeys.length) notes.push(droppedNote(p.key, `claim ${d.claimKeys.filter((k) => !keys.includes(k)).join(', ')} of "${d.detail}"`, 'not in the approved evidence'));
    return { ...d, claimKeys: keys, basis: d.basis === 'CLAIM' && keys.length === 0 ? ('INVENTED' as const) : d.basis };
  });
  const claimKeys = p.claimKeys.filter((k) => scope.claimSet.has(k));
  if (claimKeys.length < p.claimKeys.length) notes.push(droppedNote(p.key, `claim ${p.claimKeys.filter((k) => !claimKeys.includes(k)).join(', ')}`, 'not in the approved evidence'));
  const castKind = cast?.member.kind ?? null;
  const fictional = cast?.fictional ?? false;
  const basis = subjectBasis({ kind: p.kind, designDetails }, cast);
  const rules = [...new Set([...p.rules, ...(fictional ? RULES.fictional : cast ? RULES.real : anonymous ? RULES.anonymous : [])])].slice(0, 8);
  return {
    key: p.key,
    spec: {
      name: cast?.member.name ?? p.name,
      kind: p.kind,
      castId,
      castKind,
      basis,
      anonymous,
      description: p.description,
      era: p.era,
      location: p.location,
      approximateAge: p.approximateAge,
      clothing: p.clothing,
      physicalDescription: p.physicalDescription,
      visualIdentity: p.visualIdentity,
      designDetails,
      rules,
      claimKeys,
      referenceAsset: { required: false, status: 'MISSING', note: '' },
    },
  };
}

/**
 * What a subject rests on: a cast member's own basis (fiction or a real
 * member); any other subject is documented only when it is a place or a
 * thing whose every design detail rests on a claim, and otherwise a
 * reconstruction.
 */
export function subjectBasis(s: Pick<ContinuitySpec, 'kind' | 'designDetails'>, cast: { fictional: boolean } | null): ContinuitySpec['basis'] {
  if (cast) return cast.fictional ? 'FICTION' : 'DOCUMENTED';
  return s.kind !== 'CHARACTER' && s.designDetails.length > 0 && s.designDetails.every((d) => d.basis === 'CLAIM') ? 'DOCUMENTED' : 'RECONSTRUCTION';
}

/** The class a subject carries: what its basis asserts. */
export const subjectClass = (spec: Pick<ContinuitySpec, 'basis'>): ScriptBlockClass => spec.basis;

/** "Requires ⟨name⟩ continuity asset" when a reference asset is required (none exists yet). */
export const continuityRequirement = (spec: Pick<ContinuitySpec, 'name' | 'referenceAsset'>) => (spec.referenceAsset.required ? `Requires ${spec.name} continuity asset` : null);

/** Every subject a shot shows: its subjects and its environment. */
export const shotSubjectKeys = (s: Pick<DraftShot, 'subjects' | 'spec'>) => [...new Set([...s.subjects.map((x) => x.subjectKey), ...(s.spec.environment.subjectKey ? [s.spec.environment.subjectKey] : [])])];

/**
 * The version's subjects with where they appear, and the reference asset
 * each requires: a subject seen in two shots or more, or any fictional
 * character, needs one before generation.
 */
export function planSubjects(subjects: readonly DraftSubject[], shots: readonly DraftShot[]): PlannedSubject[] {
  return subjects.map((s) => {
    const appearances = shots.filter((x) => shotSubjectKeys(x).includes(s.key)).map((x) => x.key);
    const required = appearances.length >= 2 || (s.spec.kind === 'CHARACTER' && isFictional(s.spec));
    const spec: ContinuitySpec = { ...s.spec, referenceAsset: { required, status: 'MISSING', note: required ? `Requires ${s.spec.name} continuity asset` : '' } };
    return { key: s.key, spec, infoClass: subjectClass(spec), appearances, contentHash: subjectHash(s.key, spec) };
  });
}

/** Subjects in the order of the kinds (characters first), then by key. */
export function sortSubjects<T extends { key: string; spec: { kind: ContinuityKind } }>(subjects: readonly T[]): T[] {
  return [...subjects].sort((a, b) => CONTINUITY_KINDS.indexOf(a.spec.kind) - CONTINUITY_KINDS.indexOf(b.spec.kind) || a.key.localeCompare(b.key));
}

/** A subject's details in one shot, checked against the subjects that exist (interactions with unknown subjects are dropped). */
export function resolveDetail(ref: string, detail: ShotSubjectDetail, known: ReadonlySet<string>, notes: string[]): ShotSubjectDetail {
  const interactions = detail.interactions.filter((i) => {
    if (known.has(i.withSubjectKey)) return true;
    notes.push(droppedNote(ref, `an interaction with ${i.withSubjectKey}`, 'no such continuity subject'));
    return false;
  });
  return { ...detail, interactions };
}

export { isFictional, isReal };
