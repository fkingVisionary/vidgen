import {
  FICTIONAL_CAST_KINDS,
  TREATMENT_CLASS_RULES,
  depictionFor,
  seedTreatment,
  treatmentsFor,
  type ContinuitySpec,
  type Depiction,
  type InformationClass,
  type Presentation,
  type ProductionMethod,
  type ScriptBlockClass,
  type ShotClaimRole,
  type ShotEvidence,
  type StorySequenceV2,
  type VisualTreatment,
} from '@docengine/core';
import type { DraftBlock, ScriptScope } from '@docengine/script';
import type { EvidenceClaim } from '@docengine/story/shared';
import type { ShotContent } from './draft.ts';

/**
 * What each input contributes to a shot (§2.6) and what a shot asserts
 * (§2.7). Two classes are kept apart: the narrative class of the words a
 * shot covers (inherited from its blocks and their architecture beats), and
 * the shot's own class — what its picture asserts — which code derives from
 * its claims, its depiction and its specifics. A proposed class may only
 * lower the derived one; nothing makes a picture look more certain than its
 * evidence or its narration. The script's visual direction is a hint, never
 * an output: every must-show is re-resolved against the live evidence.
 */

/** How assertive a class is (DOCUMENTED > RECONSTRUCTION > UNCERTAIN; fiction and framing assert nothing). */
export const ASSERTIVENESS: Readonly<Record<ScriptBlockClass, number>> = { DOCUMENTED: 3, RECONSTRUCTION: 2, UNCERTAIN: 1, FICTION: 0, FRAMING: 0 };
const BY_RANK: Readonly<Record<number, ScriptBlockClass>> = { 3: 'DOCUMENTED', 2: 'RECONSTRUCTION', 1: 'UNCERTAIN' };
/** Weakest first, for the narrative class of mixed narration. */
const WEAKEST_FIRST: readonly ScriptBlockClass[] = ['FICTION', 'UNCERTAIN', 'RECONSTRUCTION', 'DOCUMENTED'];

/** The narrative class of some narration: its weakest class (framing counts only when it is all there is). */
export function narrativeClass(classes: readonly ScriptBlockClass[]): ScriptBlockClass {
  return WEAKEST_FIRST.find((c) => classes.includes(c)) ?? 'FRAMING';
}

/** The most assertive class a picture may have over this narration (framing narration caps nothing; fiction caps at uncertain). */
export function narrationCap(classes: readonly ScriptBlockClass[]): number {
  const ranks = classes.filter((c) => c !== 'FRAMING').map((c) => Math.max(1, ASSERTIVENESS[c]));
  return ranks.length ? Math.min(...ranks) : 3;
}

/** The bases of the architecture beats a block realises. */
export function beatBases(scope: ScriptScope, blocks: readonly DraftBlock[]): InformationClass[] {
  return [...new Set(blocks.flatMap((b) => b.beatIds.flatMap((id) => (scope.beats.has(id) ? [scope.beats.get(id)!.beat.basis] : []))))];
}

/** The claims a shot may depict, show the source of or draw data from: its blocks' claims and their beats' claims. */
export function coveredClaims(scope: ScriptScope, blocks: readonly DraftBlock[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    for (const k of b.claimKeys) out.add(k);
    for (const id of b.beatIds) for (const k of scope.beats.get(id)?.beat.claimKeys ?? []) out.add(k);
  }
  return out;
}

/** The claims a shot may use for context or period detail: also its sequences' context claims and claims, and the cast's. */
export function contextClaims(scope: ScriptScope, blocks: readonly DraftBlock[], sequences: readonly (StorySequenceV2 | null)[]): Set<string> {
  const out = coveredClaims(scope, blocks);
  for (const s of sequences) {
    if (!s) continue;
    for (const c of s.contextClaims) out.add(c.claimKey);
    for (const k of s.claimKeys) out.add(k);
  }
  for (const c of scope.cast.values()) for (const k of c.member.claimKeys) out.add(k);
  return out;
}

/** Whether a role may cite a claim for these blocks. */
export function claimAllowed(scope: ScriptScope, role: ShotClaimRole, key: string, blocks: readonly DraftBlock[], sequences: readonly (StorySequenceV2 | null)[]): boolean {
  if (!scope.claimSet.has(key)) return false;
  const allowed = role === 'CONTEXT' || role === 'PERIOD_BASIS' ? contextClaims(scope, blocks, sequences) : coveredClaims(scope, blocks);
  return allowed.has(key);
}

/** How a claim must be presented now: its architecture instruction, or null when it is ESTABLISHED (stated). */
export function presentationOf(scope: ScriptScope, key: string): Presentation | null {
  return scope.presentation.get(key)?.presentation ?? null;
}

/** A subject of a fictional cast kind (or a fictional device). */
export const isFictional = (spec: Pick<ContinuitySpec, 'castKind' | 'basis'>) => spec.basis === 'FICTION' || (spec.castKind !== null && FICTIONAL_CAST_KINDS.includes(spec.castKind));
/** A real person, group or role of the architecture's cast. */
export const isReal = (spec: Pick<ContinuitySpec, 'castKind'>) => spec.castKind !== null && !FICTIONAL_CAST_KINDS.includes(spec.castKind);

export interface ClaimFact {
  key: string;
  role: ShotClaimRole;
  claim: EvidenceClaim | undefined;
  presentation: Presentation | null;
  /** Retrieved sources with a verified quote. */
  sources: string[];
}

export function claimFacts(scope: ScriptScope, claims: readonly { claimKey: string; role: ShotClaimRole }[]): ClaimFact[] {
  return claims.map((c) => ({ key: c.claimKey, role: c.role, claim: scope.evidence.claim(c.claimKey), presentation: presentationOf(scope, c.claimKey), sources: scope.evidence.traceableSources(c.claimKey) }));
}

/** What depictionFor needs from a shot. */
export function shotDepiction(treatment: VisualTreatment, method: ProductionMethod, subjects: readonly ContinuitySpec[], spec: ShotContent, claims: readonly { role: ShotClaimRole }[]): Depiction {
  return depictionFor({
    treatment,
    method,
    fictionalSubject: subjects.some(isFictional),
    subjects: subjects.some((s) => s.kind === 'CHARACTER'),
    objects: spec.objects.length > 0,
    depicts: claims.some((c) => c.role === 'DEPICTS'),
  });
}

export interface ClassInput {
  depiction: Depiction;
  claims: readonly ClaimFact[];
  /** What the picture's details rest on (shownFacts): one that is not ESTABLISHED weighs as a depicted claim would. */
  shown?: readonly ClaimFact[];
  /** Every specific and object rests on a claim it names or is generic for the period. */
  grounded: boolean;
  narrationClasses: readonly ScriptBlockClass[];
  beatBases: readonly InformationClass[];
  /** A class proposed by the model or a person. */
  proposed: ScriptBlockClass | null;
}

/**
 * A shot's class (§2.7), the first rule that matches winning: a fictional
 * depiction is FICTION; a DEPICTS claim not ESTABLISHED — or one a detail
 * of the picture rests on — is UNCERTAIN (a reconstruction of PROBABLE
 * claims only is RECONSTRUCTION); ESTABLISHED DEPICTS claims are DOCUMENTED
 * when every specific is grounded and every beat is documented, else
 * RECONSTRUCTION; a record or data shown from ESTABLISHED sources is
 * DOCUMENTED (any other verdict UNCERTAIN); an illustration resting on
 * nothing is FRAMING; anything else takes the weakest class of its
 * narration. The result never exceeds what the narration allows — except a
 * record shown as itself — and a proposal only ever lowers it. `note` says
 * why a proposal was not taken.
 */
export function deriveClass(input: ClassInput): { infoClass: ScriptBlockClass; derived: ScriptBlockClass; note: string | null } {
  const established = (c: ClaimFact) => c.claim?.verdict === 'ESTABLISHED';
  const depicts = input.claims.filter((c) => c.role === 'DEPICTS');
  const shows = input.claims.filter((c) => c.role === 'SHOWS_SOURCE' || c.role === 'DATA');
  const unestablished = [...depicts, ...(input.shown ?? [])].filter((c) => !established(c));
  let derived: ScriptBlockClass;
  let record = false;
  if (input.depiction === 'FICTIONAL') derived = 'FICTION';
  else if (unestablished.length) {
    const probable = unestablished.every((c) => c.claim?.verdict === 'PROBABLE');
    derived = probable && input.depiction === 'RECONSTRUCTED' ? 'RECONSTRUCTION' : 'UNCERTAIN';
  } else if (depicts.length) {
    const documented = input.grounded && input.beatBases.length > 0 && input.beatBases.every((b) => b === 'DOCUMENTED');
    derived = documented ? 'DOCUMENTED' : 'RECONSTRUCTION';
  } else if (shows.length && shows.some((c) => !established(c))) derived = 'UNCERTAIN';
  else if (shows.length && (input.depiction === 'RECORD' || input.depiction === 'DATA')) {
    derived = 'DOCUMENTED';
    record = input.depiction === 'RECORD' && shows.some((c) => c.role === 'SHOWS_SOURCE');
  } else if (input.claims.length === 0 && input.depiction === 'ILLUSTRATIVE') derived = 'FRAMING';
  else derived = narrativeClass(input.narrationClasses);

  const cap = narrationCap(input.narrationClasses);
  if (!record && ASSERTIVENESS[derived] > cap && BY_RANK[cap]) derived = BY_RANK[cap]!;

  const p = input.proposed;
  if (!p || p === derived) return { infoClass: derived, derived, note: null };
  const rankable = (c: ScriptBlockClass) => c === 'DOCUMENTED' || c === 'RECONSTRUCTION' || c === 'UNCERTAIN';
  if (rankable(p) && rankable(derived) && ASSERTIVENESS[p] < ASSERTIVENESS[derived]) return { infoClass: p, derived, note: null };
  return { infoClass: derived, derived, note: `the proposed class ${p} was not taken: the evidence and narration make it ${derived}` };
}

/** Whether every specific and object of a spec rests on a claim it names or is generic for the period (a claim basis naming no claim rests on nothing). */
export const groundedSpec = (spec: Pick<ShotContent, 'specifics' | 'objects'>) => [...spec.specifics, ...spec.objects].every((d) => d.basis === 'PERIOD_GENERIC' || (d.basis === 'CLAIM' && d.claimKeys.length > 0));

/** The claims a picture shows through its details: those its specifics and objects rest on, and its must-shows'. */
export const shownClaimKeys = (spec: Pick<ShotContent, 'specifics' | 'objects' | 'mustShow'>) => [
  ...new Set([...[...spec.specifics, ...spec.objects].filter((d) => d.basis === 'CLAIM').flatMap((d) => d.claimKeys), ...spec.mustShow.flatMap((m) => m.claimKeys)]),
];

/** The evidence a picture's details rest on (claims of the approved evidence only; an unknown key is CLAIM_INVALID). */
export const shownFacts = (scope: ScriptScope, spec: Pick<ShotContent, 'specifics' | 'objects' | 'mustShow'>): ClaimFact[] =>
  claimFacts(
    scope,
    shownClaimKeys(spec)
      .filter((k) => scope.claimSet.has(k))
      .map((claimKey) => ({ claimKey, role: 'DEPICTS' as const })),
  );

/** The evidence behind a shot as saved (§2.5 ShotEvidence). */
export function evidenceSnapshot(
  scope: ScriptScope,
  claims: readonly ClaimFact[],
  blocks: readonly DraftBlock[],
  archBeatIds: readonly string[],
  sequence: StorySequenceV2 | null,
): ShotEvidence {
  const setting = sequence?.setting;
  return {
    claims: claims.flatMap((c) => (c.claim ? [{ claimId: c.claim.id, claimKey: c.key, role: c.role, verdict: c.claim.verdict, confidence: c.claim.confidence, presentation: c.presentation, sourceIds: c.sources }] : [])),
    narrationClasses: [...new Set(blocks.map((b) => b.infoClass))],
    beatBases: beatBases(scope, blocks),
    archBeatIds: [...new Set([...blocks.flatMap((b) => b.beatIds), ...archBeatIds])],
    sequenceNumber: sequence?.number ?? null,
    settingBasis: {
      location: setting?.location.value ? setting.location.basis : null,
      date: setting?.date.value ? setting.date.basis : null,
      timeOfDay: setting?.timeOfDay.value ? setting.timeOfDay.basis : null,
    },
  };
}

// ── The script's visual direction, as hints ──────────────────────────────────

/** Words in a script's visual note or must-show that promise an on-screen label for a fictional device. */
const LABEL_CUE = /\b(label|labelled|labeled|caption|fiction|fictional|invented|composite|imagined)\b/i;

/** The block promised an on-screen label for its fictional device (the script satisfied its introduction with it). */
export const labelObligation = (b: DraftBlock) => b.fictionalDevice && LABEL_CUE.test([b.visual.note, ...b.visual.mustShow.map((m) => m.detail)].join(' '));

export interface InheritedMustShow {
  detail: string;
  claimKeys: string[];
  origin: 'SCRIPT' | 'SEQUENCE';
  /** Why it may only be shown as its source or with a device (a claim that is not ESTABLISHED), if so. */
  caution: string | null;
}

/** What the script and the sequence say must be seen over these blocks, with its claims re-resolved against the evidence now. */
export function inheritedMustShow(scope: ScriptScope, block: DraftBlock, sequence: StorySequenceV2 | null): InheritedMustShow[] {
  const resolve = (detail: string, keys: readonly string[], origin: 'SCRIPT' | 'SEQUENCE'): InheritedMustShow => {
    const claimKeys = keys.filter((k) => scope.claimSet.has(k));
    const uncertain = claimKeys.filter((k) => scope.evidence.claim(k)?.verdict !== 'ESTABLISHED');
    return { detail, claimKeys, origin, caution: uncertain.length ? `rests on ${uncertain.join(', ')}, not established: show it as its source or with a visible device` : null };
  };
  return [
    ...block.visual.mustShow.map((m) => resolve(m.detail, m.claimKeys, 'SCRIPT')),
    ...(sequence?.visual.mustShow ?? []).filter((m) => m.claimKeys.some((k) => block.claimKeys.includes(k))).map((m) => resolve(m.detail, m.claimKeys, 'SEQUENCE')),
  ];
}

/** What must not be seen over these blocks: the script's and the sequence's (each once). */
export function inheritedMustAvoid(blocks: readonly DraftBlock[], sequences: readonly (StorySequenceV2 | null)[]): { text: string; origin: 'SCRIPT' | 'SEQUENCE' }[] {
  const out = new Map<string, { text: string; origin: 'SCRIPT' | 'SEQUENCE' }>();
  for (const b of blocks) for (const t of b.visual.mustAvoid) if (t.trim()) out.set(t.trim().toLowerCase(), { text: t.trim(), origin: 'SCRIPT' });
  for (const s of sequences) for (const t of s?.visual.mustAvoid ?? []) if (t.trim() && !out.has(t.trim().toLowerCase())) out.set(t.trim().toLowerCase(), { text: t.trim(), origin: 'SEQUENCE' });
  return [...out.values()];
}

/** What a model is told about one block: its classes, what it may be shown with, its seed treatment and its obligations. */
export interface BlockFacts {
  key: string;
  infoClass: ScriptBlockClass;
  fictional: boolean;
  beatBases: InformationClass[];
  /** Treatments the class matrix allows here at all (some under a condition). */
  treatments: VisualTreatment[];
  /** The treatment the script's visual intent suggests, when the matrix allows it. */
  seed: VisualTreatment | null;
  labelObligation: boolean;
  mustShow: InheritedMustShow[];
  mustAvoid: { text: string; origin: 'SCRIPT' | 'SEQUENCE' }[];
}

export function blockFacts(scope: ScriptScope, block: DraftBlock, sequence: StorySequenceV2 | null): BlockFacts {
  const seed = seedTreatment(block.visual.intent, block.fictionalDevice);
  return {
    key: block.key,
    infoClass: block.infoClass,
    fictional: block.fictionalDevice,
    beatBases: beatBases(scope, [block]),
    treatments: treatmentsFor(block.infoClass),
    seed: seed && TREATMENT_CLASS_RULES[seed][block.infoClass].allowed ? seed : null,
    labelObligation: labelObligation(block),
    mustShow: inheritedMustShow(scope, block, sequence),
    mustAvoid: inheritedMustAvoid([block], [sequence]),
  };
}
