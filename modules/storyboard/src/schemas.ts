import {
  BEAT_IMPORTANCES,
  CAMERA_MOTIONS,
  CONTINUITY_KINDS,
  CUT_REASONS,
  DataRequirement,
  DETAIL_BASES,
  EVIDENCE_RELATIONS,
  FILM_GRAINS,
  GENERATION_COMPLEXITIES,
  LIKENESS_MODES,
  MOTION_INTENSITIES,
  OVERLAY_KINDS,
  PRODUCTION_METHODS,
  SCRIPT_BLOCK_CLASSES,
  SHOT_CLAIM_ROLES,
  SHOT_TRANSITIONS,
  SHOT_TYPES,
  SPECIFIC_KINDS,
  SPEECH_KINDS,
  STORYBOARD_LIMITS as L,
  SUBJECT_INTERACTIONS,
  SUBJECT_ROLES,
  UNCERTAINTY_DEVICES,
  VISUAL_REALISMS,
  VISUAL_TREATMENTS,
} from '@docengine/core';
import { z } from 'zod';

/**
 * What each planning call returns (§2.11 "Model I/O contract"). Every field
 * is typed and bounded, every object strict: no milliseconds, no prices, no
 * row ids, no depiction or final class, no free-form payload. References —
 * cut points, beat, block, architecture beat, claim, cast and subject keys —
 * are plain strings here and are resolved by code; whatever does not
 * resolve is dropped and noted.
 */

const Title = z.string().trim().min(1).max(L.title);
const Field = z.string().trim().max(L.field);
const Description = z.string().trim().max(L.description);
const Item = z.string().trim().min(1).max(L.field);
/** A reference the model copies from its brief (a cut point, key or id). */
const Ref = z.string().trim().min(1).max(60);
const Keys = z.array(z.string().trim().min(1).max(40)).max(L.claimsPerShot);

export const ApproachOptionOutput = z.object({ treatment: z.enum(VISUAL_TREATMENTS), concept: Description }).strict();

/** A continuity subject the beats call proposes ("CS01"): a cast member, an unnamed figure, or a place, object, document or map. */
export const SubjectOutput = z
  .object({
    key: Ref,
    kind: z.enum(CONTINUITY_KINDS),
    /** The architecture's cast id for a character (null: an unnamed figure, or not a character). */
    castId: z.string().trim().min(1).max(20).nullable(),
    anonymous: z.boolean(),
    name: Title,
    description: Description,
    era: Field.nullable(),
    location: Field.nullable(),
    approximateAge: Field.nullable(),
    clothing: Field.nullable(),
    physicalDescription: Field.nullable(),
    visualIdentity: z.object({ palette: z.array(Item).max(8), silhouette: Field.nullable(), props: z.array(Item).max(8) }).strict(),
    designDetails: z.array(z.object({ detail: Field, basis: z.enum(DETAIL_BASES), claimKeys: Keys }).strict()).max(L.specifics),
    rules: z.array(Item).max(8),
    claimKeys: Keys,
  })
  .strict();
export type SubjectOutput = z.infer<typeof SubjectOutput>;

/** One visual beat over a narration range, with its three approach options. */
export const BeatOutput = z
  .object({
    from: Ref,
    to: Ref,
    title: Title,
    purpose: Field,
    concept: Description,
    informationCommunicated: z.array(Item).max(8),
    narrativePurpose: Field,
    evidenceRelationship: z.enum(EVIDENCE_RELATIONS),
    importance: z.enum(BEAT_IMPORTANCES),
    complexity: z.enum(GENERATION_COMPLEXITIES),
    archBeatIds: z.array(z.string().trim().min(1).max(12)).max(8),
    claimKeys: Keys,
    subjectKeys: z.array(Ref).max(12),
    continuityNotes: z.array(Item).max(L.notes),
    options: z.object({ A: ApproachOptionOutput, B: ApproachOptionOutput, C: ApproachOptionOutput }).strict(),
  })
  .strict();
export type BeatOutput = z.infer<typeof BeatOutput>;

/** S2 `storyboard.beats`: the beats over the scope (or one section), and the continuity subjects they need. */
export const BeatsOutput = z.object({ beats: z.array(BeatOutput).min(1).max(L.beatsPerSection * 5), subjects: z.array(SubjectOutput).max(40) }).strict();
export type BeatsOutput = z.infer<typeof BeatsOutput>;

/** One shot as the model plans it. */
export const ShotOutput = z
  .object({
    beatKey: Ref,
    /** The words the shot supports (null: a silence-only shot at silenceAt). */
    narration: z.object({ from: Ref, to: Ref }).strict().nullable(),
    silenceAt: Ref.nullable(),
    /** A lead-in or tail-out, requested by naming a cut point (never a number). */
    visualFrom: Ref.nullable(),
    visualTo: Ref.nullable(),
    cutIn: z.enum(CUT_REASONS),
    cutOut: z.enum(CUT_REASONS),
    treatment: z.enum(VISUAL_TREATMENTS),
    /** Only when the treatment's usual method would be wrong. */
    method: z.enum(PRODUCTION_METHODS).nullable(),
    /** A proposal: code derives the class and keeps this only when it is less assertive. */
    infoClass: z.enum(SCRIPT_BLOCK_CLASSES).nullable(),
    purpose: Field,
    description: Description,
    composition: Field,
    shotType: z.enum(SHOT_TYPES).nullable(),
    camera: z.object({ angle: Field, lens: Field.nullable() }).strict(),
    movement: z.object({ motion: z.enum(CAMERA_MOTIONS).nullable(), intensity: z.enum(MOTION_INTENSITIES), note: Field }).strict(),
    environment: z.object({ subjectKey: Ref.nullable(), description: Description }).strict(),
    objects: z.array(z.object({ name: Item, basis: z.enum(DETAIL_BASES), claimKeys: Keys }).strict()).max(L.specifics),
    lighting: Field,
    mood: Field,
    transitionIn: z.enum(SHOT_TRANSITIONS),
    transitionOut: z.enum(SHOT_TRANSITIONS),
    continuityNotes: z.array(Item).max(L.notes),
    mustShow: z.array(z.object({ detail: Description.min(1), claimKeys: Keys }).strict()).max(12),
    mustAvoid: z.array(Description.min(1)).max(12),
    specifics: z.array(z.object({ detail: Item, kind: z.enum(SPECIFIC_KINDS), basis: z.enum(DETAIL_BASES), claimKeys: Keys }).strict()).max(L.specifics),
    overlays: z.array(z.object({ kind: z.enum(OVERLAY_KINDS), text: Item, reason: Field, claimKeys: Keys }).strict()).max(L.overlays),
    uncertaintyDevice: z.enum(UNCERTAINTY_DEVICES),
    dataSpec: DataRequirement.nullable(),
    /** The look changed for this shot only (null: the profile's). */
    style: z.object({ realism: z.enum(VISUAL_REALISMS).nullable(), filmGrain: z.enum(FILM_GRAINS).nullable(), motionIntensity: z.enum(MOTION_INTENSITIES).nullable(), lighting: Field.nullable() }).strict(),
    subjects: z
      .array(
        z
          .object({
            subjectKey: Ref,
            role: z.enum(SUBJECT_ROLES),
            action: Field,
            interactions: z.array(z.object({ withSubjectKey: Ref, kind: z.enum(SUBJECT_INTERACTIONS) }).strict()).max(8),
            likeness: z.enum(LIKENESS_MODES),
            speaks: z.object({ kind: z.enum(SPEECH_KINDS), claimKey: Ref.nullable() }).strict().nullable(),
          })
          .strict(),
      )
      .max(12),
    claims: z.array(z.object({ claimKey: Ref, role: z.enum(SHOT_CLAIM_ROLES) }).strict()).max(L.claimsPerShot),
    notes: z.array(Item).max(L.notes),
  })
  .strict();
export type ShotOutput = z.infer<typeof ShotOutput>;

/** A beat's concept or treatment revised while its shots are re-planned (BEATS mode). */
export const BeatRevision = z.object({ beatKey: Ref, concept: Description.nullable(), treatment: z.enum(VISUAL_TREATMENTS).nullable() }).strict();

/** S4 `storyboard.shots`: the shots of one section's beats. */
export const ShotsOutput = z.object({ shots: z.array(ShotOutput).min(1).max(L.shotsPerBeat * L.beatsPerSection), beats: z.array(BeatRevision).max(L.beatsPerSection) }).strict();
export type ShotsOutput = z.infer<typeof ShotsOutput>;

/** S6 `storyboard.repair`: replacement shots for the beats with repairable blocking findings. */
export const RepairOutput = z.object({ beats: z.array(z.object({ beatKey: Ref, shots: z.array(ShotOutput).min(1).max(L.shotsPerBeat) }).strict()).max(L.beatsPerSection) }).strict();
export type RepairOutput = z.infer<typeof RepairOutput>;
