import { z } from 'zod';
import {
  ARTIFACT_STATUSES,
  ASPECT_RATIOS,
  ASSET_SOURCINGS,
  BEAT_FUNCTIONS,
  BEAT_IMPORTANCES,
  CAMERA_MOTIONS,
  CAST_KINDS,
  CLAIM_VERDICTS,
  CONFIDENCE_LEVELS,
  CONTINUITY_KINDS,
  CUT_REASONS,
  DEPICTIONS,
  DETAIL_BASES,
  EVIDENCE_RELATIONS,
  GENERATION_COMPLEXITIES,
  GENERATIVE_METHODS,
  INFOGRAPHIC_TYPES,
  INFORMATION_CLASSES,
  LICENSING_STATUSES,
  LIKENESS_MODES,
  MOTION_INTENSITIES,
  NARRATION_APPROVALS,
  OVERLAY_KINDS,
  PRESENTATIONS,
  PRICE_CONFIDENCES,
  PRODUCTION_METHODS,
  REUSE_CATEGORIES,
  SCRIPT_BLOCK_CLASSES,
  SHOT_CLAIM_ROLES,
  SHOT_TRANSITIONS,
  SHOT_TYPES,
  SOURCING_METHODS,
  SPECIFIC_KINDS,
  SPEECH_KINDS,
  STORYBOARD_MODES,
  STORYBOARD_ORIGINS,
  STORYBOARD_SCOPES,
  SUBJECT_INTERACTIONS,
  SUBJECT_ROLES,
  UNCERTAINTY_DEVICES,
  VISUAL_APPROACHES,
  VISUAL_ASSET_TYPES,
  VISUAL_COST_BASES,
  VISUAL_TREATMENTS,
  VOICE_GENERATION_STATUSES,
  VOICE_RUN_KINDS,
  type Depiction,
  type ProductionMethod,
  type ScriptBlockClass,
  type VisualDensity,
  type VisualIntent,
  type VisualTreatment,
} from '../enums.ts';
import { BilledUsage, PriceCheckDate, PriceSource, VisualPricingSnapshot } from './visual-catalog.ts';
import { VisualProfileSnapshot, VisualStyleProfileConfig } from './visual-profile.ts';
import { AssemblyEntry, ChunkSpan, NarrationAlignment, NarrationTimelineEntry } from './voice.ts';

/**
 * Storyboard Engine V1: what the viewer sees, when, why, and how it should
 * be produced. Nothing here generates anything.
 *
 * A storyboard version is timed against one pinned voice assembly. Visual
 * beats tile the narration clock; each beat has one or more shots, which
 * also tile it, and every narration word is supported by exactly one shot.
 * A shot is structured data (a ShotSpec, never a prompt): its treatment
 * comes first, the production method follows from it, and a provider is
 * only a recommendation. Times, classes, evidence links and costs are
 * computed by code; a model chooses cut points by ID and fills bounded,
 * typed fields.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Lengths of what a model or an editor writes (descriptions, other fields, titles) and sizes of its lists. */
export const STORYBOARD_LIMITS = {
  title: 120,
  field: 200,
  description: 600,
  instructions: 2000,
  shotsPerBeat: 12,
  beatsPerSection: 40,
  specifics: 12,
  overlays: 4,
  claimsPerShot: 12,
  notes: 5,
} as const;

const L = STORYBOARD_LIMITS;
const Title = z.string().trim().min(1).max(L.title);
const Field = z.string().trim().max(L.field);
const Description = z.string().trim().max(L.description);
const Note = z.string().trim().min(1).max(L.field);
const Ms = z.number().int().min(0);
/** A row id as JSON stores it. */
const Id = z.string().min(1);
const ClaimKey = z.string().trim().min(1).max(40);
const ClaimKeys = z.array(ClaimKey).max(L.claimsPerShot);
/** A narration fingerprint: sha256 hex of narrationFingerprintText(entries). */
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hex fingerprint');

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * Lineage keys, kept across versions: a visual beat "VB07", a shot "SH023",
 * a continuity subject "CS03". Row ids change with every version; keys let
 * versions be compared and decisions carried.
 */
export const BeatKey = z.string().regex(/^VB\d{2,4}$/, 'a beat key such as "VB07"');
export const ShotKey = z.string().regex(/^SH\d{3,5}$/, 'a shot key such as "SH023"');
export const SubjectKey = z.string().regex(/^CS\d{2,4}$/, 'a continuity subject key such as "CS03"');

export const beatKey = (n: number) => `VB${String(n).padStart(2, '0')}`;
export const shotKey = (n: number) => `SH${String(n).padStart(3, '0')}`;
export const subjectKey = (n: number) => `CS${String(n).padStart(2, '0')}`;

/** The scope's edges as cut points. */
export const SCOPE_START = '⟨start⟩';
export const SCOPE_END = '⟨end⟩';

/**
 * A place where a cut may fall, by ID: "<blockKey>:<wordIndex>" is the
 * boundary before that word of the block (its index in the block's words),
 * "<blockKey>:end" the boundary after its last word, and ⟨start⟩ / ⟨end⟩
 * the edges of the scope. Code turns IDs into times; a model never gives one.
 * One spelling per point (no leading zeros), so equal points are equal IDs.
 */
export const CutPointId = z.string().regex(/^(⟨start⟩|⟨end⟩|[^\s:⟨⟩]{1,40}:(0|[1-9]\d{0,4}|end))$/, 'a cut point such as "1.3:12", "1.3:end", "⟨start⟩" or "⟨end⟩"');
export type CutPointId = z.infer<typeof CutPointId>;

export type CutPointRef = { edge: 'START' | 'END' } | { blockKey: string; word: number | 'end' };

export function cutPointId(blockKey: string, word: number | 'end'): string {
  return `${blockKey}:${word}`;
}

/** What a cut point ID names, or null when it is not one. */
export function parseCutPointId(id: string): CutPointRef | null {
  if (!CutPointId.safeParse(id).success) return null;
  if (id === SCOPE_START) return { edge: 'START' };
  if (id === SCOPE_END) return { edge: 'END' };
  const at = id.lastIndexOf(':');
  const word = id.slice(at + 1);
  return { blockKey: id.slice(0, at), word: word === 'end' ? 'end' : Number(word) };
}

// ── The narration spine (read from the voice module) ─────────────────────────

/**
 * One pinned assembly as the storyboard reads it, strictly validated: its
 * entries, the chunks' spans and canonical text, and the takes the entries
 * name (by entry.generationId, never a chunk's current take, which moves).
 * `timeline` is the stored narration timeline, read only to cross-check word
 * times: its part bounds are an estimate where a part has no matched words,
 * and are never used for timing.
 */
export const NarrationSpine = z.object({
  assembly: z.object({
    id: Id,
    runId: Id,
    version: z.number().int().min(1),
    status: z.enum(ARTIFACT_STATUSES),
    complete: z.boolean(),
    totalDurationMs: Ms,
    fingerprint: Fingerprint,
    profileId: Id,
    scriptId: Id,
    languageVersionId: Id,
  }),
  run: z.object({
    id: Id,
    number: z.number().int().min(1),
    kind: z.enum(VOICE_RUN_KINDS),
    /** The block keys the run's scope resolved to, in script order. */
    scopeBlockKeys: z.array(z.string()),
  }),
  entries: z.array(AssemblyEntry).min(1),
  chunks: z.array(z.object({ id: Id, index: z.number().int().min(0), sectionKey: z.string(), spans: z.array(ChunkSpan).min(1), sourceText: z.string() })),
  takes: z.array(
    z.object({
      id: Id,
      chunkId: Id,
      status: z.enum(VOICE_GENERATION_STATUSES),
      durationMs: Ms.nullable(),
      /** Null: the take has no word timings (only its clip edges can be cuts). */
      alignment: NarrationAlignment.nullable(),
      audioAssetId: Id.nullable(),
      /** Mock audio or mock timings: never acceptable for approval. */
      mock: z.boolean(),
      /** The take has a BLOCKING voice QA finding. */
      qaBlocking: z.boolean(),
    }),
  ),
  timeline: z.array(NarrationTimelineEntry),
});
export type NarrationSpine = z.infer<typeof NarrationSpine>;

/**
 * What the narration fingerprint hashes: the clips and their places. Equal
 * for identical entries (a RESTORE can recreate them under a new assembly
 * version); any change of take, start, end or gap changes it.
 */
export function narrationFingerprintText(entries: readonly Pick<AssemblyEntry, 'chunkId' | 'generationId' | 'startMs' | 'endMs' | 'gapAfterMs'>[]): string {
  return JSON.stringify(entries.map((e) => [e.chunkId, e.generationId, e.startMs, e.endMs, e.gapAfterMs]));
}

// ── Timing ───────────────────────────────────────────────────────────────────

/** The narration words a shot or beat supports, from one cut point to another. */
export const NarrationRange = z.object({ from: CutPointId, to: CutPointId });
export type NarrationRange = z.infer<typeof NarrationRange>;

/** A take heard under a shot. */
export const AudioRef = z.object({ chunkId: Id, generationId: Id, audioAssetId: Id.optional() });
export type AudioRef = z.infer<typeof AudioRef>;

/**
 * When a shot is seen against when its words are heard. Every number is
 * computed from the cut geometry; the requests are cut-point IDs. A lead-in
 * shows the picture under the previous shot's last words, a tail-out holds
 * it over the next shot's first; a bridge crosses a block, beat or section
 * boundary, or covers only a silence.
 */
export const ShotTiming = z
  .object({
    /** The words supported (null: a silence-only shot, see silenceAt). */
    narration: NarrationRange.nullable(),
    narrationStartMs: Ms.nullable(),
    narrationEndMs: Ms.nullable(),
    leadInMs: Ms,
    tailOutMs: Ms,
    bridge: z.object({ kind: z.enum(['BLOCK', 'BEAT', 'SECTION', 'SILENCE']), fromBlockId: Id.nullable(), toBlockId: Id.nullable() }).nullable(),
    /** A lead-in requested by cut point (null: the default cut). */
    visualFrom: CutPointId.nullable(),
    /** A tail-out requested by cut point (null: the default cut). */
    visualTo: CutPointId.nullable(),
    /** A silence-only shot occupies this cut point's silence. */
    silenceAt: CutPointId.nullable(),
    /** A person's nudge of the cut before this shot off its cut point, in ms (moveCut; absent: none). */
    cutOffsetMs: z.number().int().min(-2000).max(2000).optional(),
    cutIn: z.enum(CUT_REASONS),
    cutOut: z.enum(CUT_REASONS),
    audio: z.array(AudioRef),
    /** A bound is the clip edge of a take without word timings (real audio, never an estimate). */
    unalignedTake: z.boolean(),
  })
  .refine((t) => (t.narration === null) !== (t.silenceAt === null), { message: 'a shot is anchored to narration words or to a silence, exactly one', path: ['narration'] })
  .refine((t) => (t.narration === null ? t.narrationStartMs === null && t.narrationEndMs === null : t.narrationStartMs !== null && t.narrationEndMs !== null), {
    message: 'a narration range has both its times, and a silence-only shot none',
    path: ['narrationStartMs'],
  })
  .refine((t) => t.narrationStartMs === null || t.narrationEndMs === null || t.narrationStartMs <= t.narrationEndMs, { message: 'narration ends before it starts', path: ['narrationEndMs'] })
  .refine((t) => t.narration !== null || (t.visualFrom === null && t.visualTo === null && t.leadInMs === 0 && t.tailOutMs === 0), {
    message: 'a silence-only shot has no lead-in or tail-out',
    path: ['visualFrom'],
  })
  .refine((t) => t.narration !== null || t.bridge !== null, { message: 'a silence-only shot is a bridge', path: ['bridge'] });
export type ShotTiming = z.infer<typeof ShotTiming>;

// ── The shot specification ───────────────────────────────────────────────────

/**
 * What a later deterministic renderer needs for a chart, timeline, diagram
 * or map: never a full InfographicSpec. No coordinates, no computed numbers,
 * no free-form payload; a map lists place names only (geocoded later). Every
 * figure, date and place must be found in its own claim.
 */
export const DataRequirement = z
  .object({
    chartType: z.enum(INFOGRAPHIC_TYPES),
    title: Title,
    items: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            /** As written in the claim ("3,000 guilders"). */
            figure: z.string().trim().min(1).max(80).nullable(),
            date: z.string().trim().min(1).max(40).nullable(),
            place: z.string().trim().min(1).max(80).nullable(),
            claimKey: ClaimKey,
          })
          .strict(),
      )
      .min(1)
      .max(24),
    note: Field,
  })
  .strict();
export type DataRequirement = z.infer<typeof DataRequirement>;

/** A specific visual detail that declares what it rests on (makes invented uniforms, documents or technology checkable). */
export const ShotSpecific = z.object({ detail: Field, kind: z.enum(SPECIFIC_KINDS), basis: z.enum(DETAIL_BASES), claimKeys: ClaimKeys });
export type ShotSpecific = z.infer<typeof ShotSpecific>;

/** Text laid over a shot. `auto`: added by code (a fiction or reconstruction label), not proposed. */
export const ShotOverlay = z.object({ kind: z.enum(OVERLAY_KINDS), text: Field, reason: Field, claimKeys: ClaimKeys, auto: z.boolean() });
export type ShotOverlay = z.infer<typeof ShotOverlay>;

/**
 * A shot, structured: downstream providers write their prompts from it.
 * Stored in the existing shots.direction column. `depiction` is derived by
 * code (depictionFor), never proposed.
 */
export const ShotSpec = z.object({
  purpose: Field,
  /** What is seen (provider-neutral; not a prompt). */
  description: Description,
  composition: Field,
  shotType: z.enum(SHOT_TYPES).nullable(),
  camera: z.object({ angle: Field, lens: Field.nullable() }),
  movement: z.object({ motion: z.enum(CAMERA_MOTIONS).nullable(), intensity: z.enum(MOTION_INTENSITIES), note: Field }),
  environment: z.object({ subjectKey: SubjectKey.nullable(), description: Description }),
  objects: z.array(z.object({ name: Field, basis: z.enum(DETAIL_BASES), claimKeys: ClaimKeys })).max(L.specifics),
  lighting: Field,
  mood: Field,
  transitionIn: z.enum(SHOT_TRANSITIONS),
  transitionOut: z.enum(SHOT_TRANSITIONS),
  continuity: z.object({ subjectKeys: z.array(SubjectKey).max(12), notes: z.array(Note).max(L.notes) }),
  /** Inherited details are kept as written (so up to a description's length). */
  mustShow: z.array(z.object({ detail: Description, claimKeys: ClaimKeys, origin: z.enum(['SCRIPT', 'SEQUENCE', 'STORYBOARD']) })).max(12),
  mustAvoid: z.array(z.object({ text: Description, origin: z.enum(['SCRIPT', 'SEQUENCE', 'PROFILE', 'STORYBOARD']) })).max(24),
  specifics: z.array(ShotSpecific).max(L.specifics),
  /** Up to STORYBOARD_LIMITS.overlays proposed, plus the automatic labels. */
  overlays: z.array(ShotOverlay).max(L.overlays + 2),
  uncertaintyDevice: z.enum(UNCERTAINTY_DEVICES),
  dataSpec: DataRequirement.nullable(),
  depiction: z.enum(DEPICTIONS),
  /** The profile's look changed for this shot only. */
  styleOverrides: VisualStyleProfileConfig.pick({ realism: true, colour: true, lighting: true, filmGrain: true, motionIntensity: true }).partial(),
  notes: z.array(Note).max(L.notes),
});
export type ShotSpec = z.infer<typeof ShotSpec>;

/** A continuity subject in one shot: what it does, how it relates to the others, how its face is shown, and whether it speaks. */
export const ShotSubjectDetail = z.object({
  role: z.enum(SUBJECT_ROLES),
  action: Field,
  interactions: z.array(z.object({ withSubjectKey: SubjectKey, kind: z.enum(SUBJECT_INTERACTIONS) })).max(8),
  likeness: z.enum(LIKENESS_MODES),
  speaks: z.object({ kind: z.enum(SPEECH_KINDS), claimKey: ClaimKey.nullable() }).nullable(),
});
export type ShotSubjectDetail = z.infer<typeof ShotSubjectDetail>;

/**
 * The evidence behind a shot when it was saved: its claims with their
 * verdicts, presentation and traceable sources, the classes of the words it
 * covers, and the basis of their architecture beats and setting. Views
 * re-read the live verdicts (STALE_VERDICT).
 */
export const ShotEvidence = z.object({
  claims: z.array(
    z.object({
      claimId: Id,
      claimKey: ClaimKey,
      role: z.enum(SHOT_CLAIM_ROLES),
      verdict: z.enum(CLAIM_VERDICTS),
      confidence: z.enum(CONFIDENCE_LEVELS),
      presentation: z.enum(PRESENTATIONS).nullable(),
      /** Retrieved sources with a verified quote (duplicates folded into the original); empty: untraced. */
      sourceIds: z.array(Id),
    }),
  ),
  narrationClasses: z.array(z.enum(SCRIPT_BLOCK_CLASSES)),
  beatBases: z.array(z.enum(INFORMATION_CLASSES)),
  archBeatIds: z.array(z.string()),
  sequenceNumber: z.number().int().min(1).nullable(),
  settingBasis: z.object({
    location: z.enum(['DOCUMENTED', 'RECONSTRUCTION']).nullable(),
    date: z.enum(['DOCUMENTED', 'RECONSTRUCTION']).nullable(),
    timeOfDay: z.enum(['DOCUMENTED', 'RECONSTRUCTION']).nullable(),
  }),
});
export type ShotEvidence = z.infer<typeof ShotEvidence>;

/**
 * The asset a shot needs before it can be edited, and what a future reuse
 * library would file it under (§18). Shots sharing a reuse key are one
 * generation; `reuseOf` names the shot whose asset this one reuses.
 */
export const AssetRequirement = z.object({
  assetType: z.enum(VISUAL_ASSET_TYPES),
  method: z.enum(PRODUCTION_METHODS),
  sourcing: z.enum(ASSET_SOURCINGS),
  durationSec: z.number().min(0),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.string().trim().min(1).max(20),
  /** "Requires ⟨name⟩ continuity asset": none exists in V1. */
  references: z.array(z.object({ subjectKey: SubjectKey, status: z.literal('MISSING') })),
  licensing: z.object({ status: z.enum(LICENSING_STATUSES), note: Field }),
  reuse: z.object({
    reusable: z.boolean(),
    reuseKey: z.string().min(1).max(100),
    category: z.enum(REUSE_CATEGORIES),
    subjects: z.array(SubjectKey),
    location: Field.nullable(),
    era: Field.nullable(),
    style: z.object({ profileId: Id, version: z.number().int().min(1) }),
    claimKeys: z.array(ClaimKey),
    projectId: Id,
    /** From the cost recommendation. */
    provider: z.string().nullable(),
    model: z.string().nullable(),
    /** Filled by the generation milestone (null in V1). */
    source: z.string().nullable(),
    promptVersion: z.string().nullable(),
  }),
  reuseOf: ShotKey.nullable(),
});
export type AssetRequirement = z.infer<typeof AssetRequirement>;

/**
 * A forecast of what producing a shot would cost: never spend, never in the
 * provider-call ledger. UNPRICED (no verified price) has no total: it is
 * never $0. A priced estimate prices every line, each rate with its source,
 * check date and confidence. The duration is the shot's real narration time.
 */
export const VisualCostEstimate = z
  .object({
    method: z.enum(PRODUCTION_METHODS),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    /** ROUTER: recommended by the router; USER: chosen by a person (kept across re-costing). */
    source: z.enum(['ROUTER', 'USER']),
    /** One line per component (an image line and a video line for IMAGE_TO_VIDEO); a line without a rate is unpriced. */
    lines: z.array(
      z.object({
        what: Field,
        usage: z.array(BilledUsage),
        rate: z.object({ unit: BilledUsage.shape.unit, usdPerUnit: z.number().min(0), source: PriceSource, checkedAt: PriceCheckDate, confidence: z.enum(PRICE_CONFIDENCES) }).nullable(),
      }),
    ),
    perGenerationUsd: z.number().min(0).nullable(),
    rerollAllowance: z.number().min(0),
    /** 1 + the reroll allowance. */
    generations: z.number().min(1),
    totalUsd: z.number().min(0).nullable(),
    basis: z.enum(VISUAL_COST_BASES),
    durationSource: z.literal('AUDIO'),
    /** The length billed for one generation after clip rounding. */
    billedClipSec: z.number().min(0).nullable(),
    /** "8 s billed as 10 s × $0.1125/s × 2.5 generations (source, checked …; ASSUMPTION)", or why it is unpriced. */
    note: z.string(),
    /** Footage to generate after reuse (§16 "estimated generation duration"). */
    generationSec: z.number().min(0),
    /** The weakest line's confidence; null when UNPRICED. */
    confidence: z.enum(PRICE_CONFIDENCES).nullable(),
    candidates: z.array(z.object({ provider: z.string(), model: z.string(), totalUsd: z.number().min(0).nullable(), basis: z.enum(VISUAL_COST_BASES) })),
  })
  .refine((c) => (c.basis === 'UNPRICED') === (c.totalUsd === null), { message: 'an UNPRICED estimate has no total, and only an UNPRICED one', path: ['totalUsd'] })
  .refine((c) => c.basis !== 'UNPRICED' || (c.perGenerationUsd === null && c.confidence === null), { message: 'an UNPRICED estimate has no price per generation and no confidence', path: ['confidence'] })
  .refine((c) => c.basis === 'UNPRICED' || c.lines.every((l) => l.rate !== null), { message: 'a line without a rate makes the estimate UNPRICED', path: ['basis'] })
  .refine((c) => c.basis === 'UNPRICED' || c.lines.length === 0 || c.confidence !== null, { message: 'a priced estimate says how sure its prices are', path: ['confidence'] });
export type VisualCostEstimate = z.infer<typeof VisualCostEstimate>;

// ── Beats and continuity ─────────────────────────────────────────────────────

/** One visual approach to a beat: its treatment and concept. */
export const ApproachOption = z.object({ treatment: z.enum(VISUAL_TREATMENTS), concept: Description });
export type ApproachOption = z.infer<typeof ApproachOption>;

/** A visual beat (§5): one visual idea over a span of narration, between a script block and a shot. */
export const VisualBeatContent = z.object({
  title: Title,
  purpose: Field,
  concept: Description,
  informationCommunicated: z.array(Note).max(8),
  narrativePurpose: Field,
  functions: z.array(z.enum(BEAT_FUNCTIONS)).max(4),
  evidenceRelationship: z.enum(EVIDENCE_RELATIONS),
  importance: z.enum(BEAT_IMPORTANCES),
  complexity: z.enum(GENERATION_COMPLEXITIES),
  continuity: z.object({ subjectKeys: z.array(SubjectKey).max(12), notes: z.array(Note).max(L.notes) }),
  narration: NarrationRange,
  /** The approach this version plans (its treatment is the beat's). */
  approach: z.enum(VISUAL_APPROACHES),
  options: z.object({ A: ApproachOption, B: ApproachOption, C: ApproachOption }),
});
export type VisualBeatContent = z.infer<typeof VisualBeatContent>;

/**
 * A recurring character, environment, place, object, document or map, with
 * what must stay the same wherever it appears (§19). Characters are the
 * architecture's cast (castId) or anonymous background figures: the
 * storyboard never invents a named character. Every invented design detail
 * says so.
 */
export const ContinuitySpec = z.object({
  name: Title,
  kind: z.enum(CONTINUITY_KINDS),
  castId: z.string().min(1).max(20).nullable(),
  castKind: z.enum(CAST_KINDS).nullable(),
  basis: z.enum(['DOCUMENTED', 'RECONSTRUCTION', 'FICTION']),
  anonymous: z.boolean(),
  description: Description,
  era: Field.nullable(),
  location: Field.nullable(),
  approximateAge: Field.nullable(),
  clothing: Field.nullable(),
  physicalDescription: Field.nullable(),
  visualIdentity: z.object({ palette: z.array(Note).max(8), silhouette: Field.nullable(), props: z.array(Note).max(8) }),
  designDetails: z.array(z.object({ detail: Field, basis: z.enum(DETAIL_BASES), claimKeys: ClaimKeys })).max(L.specifics),
  /** "Observes, never interacts with real people". */
  rules: z.array(Note).max(8),
  claimKeys: z.array(ClaimKey),
  referenceAsset: z.object({ required: z.boolean(), status: z.literal('MISSING'), note: Field }),
});
export type ContinuitySpec = z.infer<typeof ContinuitySpec>;

// ── QA ───────────────────────────────────────────────────────────────────────

/** Deterministic storyboard QA (brief §24, guardrails §11), recomputed live in views, decisions and the gate. */
export const STORYBOARD_FINDING_KINDS = [
  // Blocking: timing and structure
  'NARRATION_UNMAPPED',
  'TIMING_MISSING',
  'SHOT_OVERLAP',
  'TIMELINE_GAP',
  'DURATION_IMPOSSIBLE',
  'TREATMENT_MISSING',
  'ASSET_REQUIREMENT_MISSING',
  'INFO_CLASS_MISSING',
  /** A beat whose model output could not be made valid: one placeholder shot with no content covers it. */
  'SHOT_UNPLANNED',
  // Blocking: evidence, information class and fiction
  'EVIDENCE_MISSING',
  'CLAIM_INVALID',
  'UNCERTAIN_AS_FACT',
  'GENERATED_RECORD',
  'FICTION_IN_DOCUMENTED',
  'FICTION_REAL_INTERACTION',
  'FICTION_WITH_FACTS',
  'INVENTED_CHARACTER',
  'REAL_LIKENESS',
  'INVENTED_DETAIL_DOCUMENTED',
  'OVERLAY_UNSUPPORTED',
  'FICTION_LABEL_MISSING',
  'DEVICE_UNREALIZED',
  'CONTINUITY_INVALID',
  'MOCK_NARRATION',
  // Blocking: approval is version-specific (live only)
  'STALE_SCRIPT',
  'STALE_ARCHITECTURE',
  'STALE_NARRATION',
  /** Blocking when the live verdict needs another presentation; otherwise a warning. */
  'STALE_VERDICT',
  /** The gate only: a PARTIAL version, or an incomplete assembly. */
  'SCOPE_INCOMPLETE',
  // Warnings: rhythm and variety
  'TREATMENT_REPETITION',
  'TREATMENT_DOMINANT',
  'GENERATED_VIDEO_SHARE',
  'DENSITY_HIGH',
  'DENSITY_LOW',
  'SHOT_COUNT_HIGH',
  'SHOT_COUNT_LOW',
  'RAPID_CUTS',
  'STATIC_LONG',
  'NO_VISUAL_CHANGE',
  'GENERIC_BROLL',
  'UNIFORM_DURATIONS',
  'MID_SENTENCE_CUT',
  'ENVIRONMENT_REPEATED',
  // Warnings: cost
  'COST_HIGH',
  'COST_UNPRICED',
  // Warnings: for human review
  'CONTINUITY_RISK',
  'VISUAL_IMPLICATION',
  'ANACHRONISM_RISK',
  'MUST_SHOW_DROPPED',
  'FRAMING_FACTUAL_VISUAL',
  /** The takes timing it are not all approved (approving the version needs them approved). */
  'PROVISIONAL_TIMING',
  'UNALIGNED_TAKE',
  /** Code dropped something the model referenced (listed in the version's normalization notes). */
  'MODEL_REFERENCE_DROPPED',
  'STALE_PROFILE',
  'STALE_PRICING',
  'SCOPE_PARTIAL',
] as const;
export type StoryboardFindingKind = (typeof STORYBOARD_FINDING_KINDS)[number];

/** Same shape as VoiceQaFinding: ref is a shot key, beat key, subject key, or null for the whole version. */
export const StoryboardQaFinding = z.object({
  kind: z.enum(STORYBOARD_FINDING_KINDS),
  severity: z.enum(['BLOCKING', 'WARNING']),
  ref: z.string().nullable(),
  detail: z.string(),
});
export type StoryboardQaFinding = z.infer<typeof StoryboardQaFinding>;

/** The kinds are listed blocking first: every kind from TREATMENT_REPETITION on is a warning. */
const WARNING_KINDS = new Set<StoryboardFindingKind>(STORYBOARD_FINDING_KINDS.slice(STORYBOARD_FINDING_KINDS.indexOf('TREATMENT_REPETITION')));

/** The severity each kind has (STALE_VERDICT is lowered to a warning when the presentation is unchanged). */
export const STORYBOARD_FINDING_SEVERITY: Readonly<Record<StoryboardFindingKind, 'BLOCKING' | 'WARNING'>> = Object.fromEntries(
  STORYBOARD_FINDING_KINDS.map((k) => [k, WARNING_KINDS.has(k) ? 'WARNING' : 'BLOCKING']),
) as Record<StoryboardFindingKind, 'BLOCKING' | 'WARNING'>;

// ── Jobs and edits ───────────────────────────────────────────────────────────

/**
 * Input of a VISUAL_PLAN or STORYBOARD_PREVIEW job. GENERATE plans a
 * version; APPROACH re-plans the beats whose treatment the approach changes;
 * BEATS re-plans the named beats, with the editor's instructions.
 */
export const StoryboardJobInput = z
  .object({
    mode: z.enum(STORYBOARD_MODES),
    narration: z.object({ runId: z.uuid(), assemblyId: z.uuid() }),
    approach: z.enum(VISUAL_APPROACHES).optional(),
    base: z.object({ storyboardId: z.uuid(), version: z.number().int().min(1) }).optional(),
    beatKeys: z.array(BeatKey).min(1).max(L.beatsPerSection).optional(),
    instructions: z.string().trim().max(L.instructions).optional(),
    /** The project's visual selection revision the request was made at (0: none chosen yet). */
    selectionRevision: z.number().int().min(0),
    requestedBy: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((v) => (v.mode === 'GENERATE') === (v.base === undefined), { message: 'APPROACH and BEATS work on a base version; GENERATE has none', path: ['base'] })
  .refine((v) => (v.mode === 'BEATS') === (v.beatKeys !== undefined), { message: 'BEATS names the beats to re-plan (and only BEATS does)', path: ['beatKeys'] })
  .refine((v) => v.mode !== 'APPROACH' || v.approach !== undefined, { message: 'APPROACH names the approach to switch to', path: ['approach'] })
  .refine((v) => v.mode === 'BEATS' || v.instructions === undefined, { message: 'instructions go with a beat re-plan', path: ['instructions'] });
export type StoryboardJobInput = z.infer<typeof StoryboardJobInput>;

/**
 * A change to a shot: any field of its spec (but its depiction, which is
 * derived), its treatment or method, its subjects and claims, and its class
 * (which may only be lowered below the derived one).
 */
export const ShotPatch = ShotSpec.omit({ depiction: true })
  .partial()
  .extend({
    treatment: z.enum(VISUAL_TREATMENTS).optional(),
    method: z.enum(PRODUCTION_METHODS).optional(),
    infoClass: z.enum(SCRIPT_BLOCK_CLASSES).optional(),
    subjects: z.array(z.object({ subjectKey: SubjectKey, detail: ShotSubjectDetail })).max(12).optional(),
    claims: z.array(z.object({ claimKey: ClaimKey, role: z.enum(SHOT_CLAIM_ROLES) })).max(L.claimsPerShot).optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'nothing to change' });
export type ShotPatch = z.infer<typeof ShotPatch>;

/** Most a person may move a cut off its cut point, either way (the same limits as a lead-in). */
export const CUT_OFFSET_MAX_MS = 2000;

/** One edit of a version. Every edit set makes a new version (no model call). */
export const StoryboardEditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('updateShot'), shotKey: ShotKey, patch: ShotPatch }).strict(),
  z.object({ op: z.literal('setTreatment'), shotKey: ShotKey, treatment: z.enum(VISUAL_TREATMENTS), method: z.enum(PRODUCTION_METHODS).optional() }).strict(),
  z
    .object({
      op: z.literal('moveCut'),
      leftShotKey: ShotKey,
      rightShotKey: ShotKey,
      to: CutPointId,
      offsetMs: z.number().int().min(-CUT_OFFSET_MAX_MS).max(CUT_OFFSET_MAX_MS).optional(),
    })
    .strict(),
  z.object({ op: z.literal('splitShot'), shotKey: ShotKey, at: CutPointId }).strict(),
  z.object({ op: z.literal('mergeShots'), shotKeys: z.tuple([ShotKey, ShotKey]) }).strict(),
  z.object({ op: z.literal('reorderShots'), beatKey: BeatKey, order: z.array(ShotKey).min(2).max(L.shotsPerBeat) }).strict(),
  z
    .object({
      op: z.literal('updateBeat'),
      beatKey: BeatKey,
      patch: z
        .object({ title: Title, purpose: Field, concept: Description, importance: z.enum(BEAT_IMPORTANCES), continuityNotes: z.array(Note).max(L.notes) })
        .partial()
        .strict()
        .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'nothing to change' }),
    })
    .strict(),
  z.object({ op: z.literal('setRecommendation'), shotKey: ShotKey, provider: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(100) }).strict(),
  z.object({ op: z.literal('clearRecommendation'), shotKey: ShotKey }).strict(),
  z.object({ op: z.literal('applyAlternative'), alternativeId: z.string().min(1).max(60) }).strict(),
  z
    .object({
      op: z.literal('updateContinuity'),
      subjectKey: SubjectKey,
      patch: ContinuitySpec.pick({ description: true, approximateAge: true, clothing: true, physicalDescription: true, visualIdentity: true, designDetails: true, rules: true })
        .partial()
        .strict()
        .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'nothing to change' }),
    })
    .strict(),
  z.object({ op: z.literal('setProfile'), selectionRevision: z.number().int().min(0) }).strict(),
]);
export type StoryboardEditOp = z.infer<typeof StoryboardEditOp>;

// ── A version's content ──────────────────────────────────────────────────────

/** What a version was planned from, frozen into it (§2.2). */
export const StoryboardInputs = z.object({
  script: z.object({ id: Id, version: z.number().int().min(1) }),
  architecture: z.object({ id: Id, version: z.number().int().min(1), dossierId: Id }),
  narration: z.object({
    runId: Id,
    runNumber: z.number().int().min(1),
    runKind: z.enum(VOICE_RUN_KINDS),
    assemblyId: Id,
    assemblyVersion: z.number().int().min(1),
    fingerprint: Fingerprint,
    languageVersionId: Id,
    language: z.string(),
    totalDurationMs: Ms,
    complete: z.boolean(),
    /** The voice profile the narration was made with (provenance only). */
    voiceProfileId: Id,
    takes: z.array(z.object({ id: Id, chunkIndex: z.number().int().min(0), status: z.enum(VOICE_GENERATION_STATUSES), mock: z.boolean() })),
    approval: z.enum(NARRATION_APPROVALS),
  }),
  profile: VisualProfileSnapshot,
  pricing: VisualPricingSnapshot,
  candidates: z.array(z.object({ id: Id, key: z.string(), timePeriod: z.string(), setting: z.string(), visualEnvironment: z.string().nullable() })),
});
export type StoryboardInputs = z.infer<typeof StoryboardInputs>;

/** How a version came about. */
export const StoryboardProvenance = z.object({
  origin: z.enum(STORYBOARD_ORIGINS),
  baseVersion: z.number().int().min(1).nullable(),
  baseId: Id.nullable(),
  approach: z.enum(VISUAL_APPROACHES),
  /** BEATS: the beats re-planned; APPROACH: the beats whose treatment changed. */
  beatKeys: z.array(BeatKey),
  /** EDIT: the edits applied, in order. */
  ops: z.array(StoryboardEditOp),
  /** The editor's note on an edit, or the instructions of a beat re-plan. */
  note: z.string().nullable(),
  requestedBy: z.string().nullable(),
  jobId: Id.nullable(),
  /** The model of each planning step ("beats", "shots.1", "repair"). */
  models: z.record(z.string(), z.string()),
  promptVersion: z.string().nullable(),
});
export type StoryboardProvenance = z.infer<typeof StoryboardProvenance>;

/** What a version covers on the narration clock. */
export const StoryboardScopeInfo = z.object({
  kind: z.enum(STORYBOARD_SCOPES),
  blockKeys: z.array(z.string()),
  sectionKeys: z.array(z.string()),
  startMs: Ms,
  endMs: Ms,
  /** Blocks of the script outside the narration (out of scope; counted, never estimated). */
  outOfScopeBlocks: z.number().int().min(0),
});
export type StoryboardScopeInfo = z.infer<typeof StoryboardScopeInfo>;

const Share = z.number().min(0).max(1);
/** A rollup's basis: its shots' common basis, or MIXED when they differ. */
const RollupBasis = z.enum([...VISUAL_COST_BASES, 'MIXED']);

/**
 * What every forecast rollup keeps honest: with nothing priced (UNPRICED)
 * there is no total, never $0, and the unpriced shots are counted; any
 * unpriced shot makes the basis UNPRICED or MIXED. A total is the priced
 * shots' sum, always read with the unpriced count.
 */
function checkRollup(r: { total: number | null; basis: z.infer<typeof RollupBasis>; unpriced: number }, ctx: z.RefinementCtx, totalKey: string, basisKey: string): void {
  if ((r.basis === 'UNPRICED') !== (r.total === null)) ctx.addIssue({ code: 'custom', path: [totalKey], message: 'nothing priced has no total (never $0), and anything priced has one' });
  if (r.basis === 'UNPRICED' && r.unpriced === 0) ctx.addIssue({ code: 'custom', path: [basisKey], message: 'an UNPRICED rollup counts its unpriced shots' });
  if (r.unpriced > 0 && r.basis !== 'UNPRICED' && r.basis !== 'MIXED') ctx.addIssue({ code: 'custom', path: [basisKey], message: 'unpriced shots make the basis UNPRICED or MIXED' });
}

/** One approach costed and measured across the version's beats (computed, never chosen). */
export const ApproachSummary = z
  .object({
    approach: z.enum(VISUAL_APPROACHES),
    /** Runtime per treatment, in ms. */
    treatmentMix: z.partialRecord(z.enum(VISUAL_TREATMENTS), Ms),
    generatedVideoShare: Share,
    /** Beat durations over the profile density's target shot length. */
    estimatedShots: z.number().int().min(0),
    /** The priced part (null: nothing priced). */
    estimatedCostUsd: z.number().min(0).nullable(),
    costBasis: RollupBasis,
    unpricedShots: z.number().int().min(0),
    /** Share of beats with a SHOWS_SOURCE or DATA claim. */
    evidenceShare: Share,
    /** Options replaced by the beat's seed treatment (outside the class matrix). */
    replacedOptions: z.number().int().min(0),
  })
  .superRefine((a, ctx) => checkRollup({ total: a.estimatedCostUsd, basis: a.costBasis, unpriced: a.unpricedShots }, ctx, 'estimatedCostUsd', 'costBasis'));
export type ApproachSummary = z.infer<typeof ApproachSummary>;

/** A cheaper way to show some shots (§17). Applying one is an edit that makes a new version; nothing is applied automatically. */
export const CostAlternative = z
  .object({
    id: z.string().min(1).max(60),
    title: Field,
    shotKeys: z.array(ShotKey).min(1),
    from: z.object({ treatment: z.enum(VISUAL_TREATMENTS), method: z.enum(PRODUCTION_METHODS) }),
    to: z.object({ treatment: z.enum(VISUAL_TREATMENTS), method: z.enum(PRODUCTION_METHODS) }),
    beforeUsd: z.number().min(0).nullable(),
    afterUsd: z.number().min(0).nullable(),
    /** Null unless both sides are priced. */
    savingUsd: z.number().nullable(),
    basis: RollupBasis,
    /** What the picture loses. */
    tradeoff: Field,
  })
  .refine((a) => (a.savingUsd === null) === (a.beforeUsd === null || a.afterUsd === null), { message: 'a saving needs both sides priced', path: ['savingUsd'] });
export type CostAlternative = z.infer<typeof CostAlternative>;

/** Visual rhythm (§13), measured on the version. */
export const RhythmStats = z.object({
  shots: z.number().int().min(0),
  averageShotMs: Ms,
  medianShotMs: Ms,
  minShotMs: Ms,
  maxShotMs: Ms,
  cutsPerMinute: z.number().min(0),
  treatmentChanges: z.number().int().min(0),
  longestSameTreatmentRun: z.number().int().min(0),
  staticShare: Share,
  movingShare: Share,
  claimsPerMinute: z.number().min(0),
  overlaysPerMinute: z.number().min(0),
  resetPoints: z.array(z.object({ atMs: Ms, kind: z.enum(['SECTION', 'PAUSE', 'TIME_JUMP']), ref: z.string() })),
  peaks: z.array(z.object({ atMs: Ms, beatKey: BeatKey, kind: z.enum(['REVEAL', 'TURN', 'QUESTION_POSED', 'QUESTION_ANSWERED']) })),
  reveals: z.number().int().min(0),
  transitions: z.number().int().min(0),
  generatedVideoShare: Share,
});
export type RhythmStats = z.infer<typeof RhythmStats>;

/** Forecast cost in one group of shots: the priced part (null: nothing priced). */
export const CostBucket = z
  .object({ key: z.string(), shots: z.number().int().min(0), totalUsd: z.number().min(0).nullable(), unpricedShots: z.number().int().min(0), basis: RollupBasis })
  .superRefine((b, ctx) => checkRollup({ total: b.totalUsd, basis: b.basis, unpriced: b.unpricedShots }, ctx, 'totalUsd', 'basis'));
export type CostBucket = z.infer<typeof CostBucket>;

/** The version's forecast: the priced total (null: nothing priced), always shown with the number of unpriced shots. */
export const CostRollup = z
  .object({
    totalUsd: z.number().min(0).nullable(),
    basis: RollupBasis,
    unpricedShots: z.number().int().min(0),
    byTreatment: z.array(CostBucket),
    byMethod: z.array(CostBucket),
    byProvider: z.array(CostBucket),
    byModel: z.array(CostBucket),
    bySection: z.array(CostBucket),
    byBeat: z.array(CostBucket),
    perFinishedMinute: z.number().min(0).nullable(),
  })
  .superRefine((r, ctx) => checkRollup({ total: r.totalUsd, basis: r.basis, unpriced: r.unpricedShots }, ctx, 'totalUsd', 'basis'));
export type CostRollup = z.infer<typeof CostRollup>;

/** What changed from the base version. */
export const VersionChanges = z.object({
  baseVersion: z.number().int().min(1),
  shots: z.object({ added: z.array(ShotKey), removed: z.array(ShotKey), changed: z.array(z.object({ shotKey: ShotKey, fields: z.array(z.string()) })) }),
  beats: z.object({ added: z.array(BeatKey), removed: z.array(BeatKey), changed: z.array(z.object({ beatKey: BeatKey, fields: z.array(z.string()) })) }),
});
export type VersionChanges = z.infer<typeof VersionChanges>;

/** storyboards.content: everything about a version that is not a row of its own. */
export const StoryboardContent = z.object({
  engineVersion: z.literal(1),
  inputs: StoryboardInputs,
  provenance: StoryboardProvenance,
  scope: StoryboardScopeInfo,
  approaches: z.object({ chosen: z.enum(VISUAL_APPROACHES), options: z.array(ApproachSummary) }),
  alternatives: z.array(CostAlternative),
  rhythm: RhythmStats,
  costs: CostRollup,
  /** Factual shots (a factual class or a record, reconstruction or data picture) and how many have a traceable source. */
  evidenceCoverage: z.object({ factualShots: z.number().int().min(0), traced: z.number().int().min(0), untraced: z.array(ShotKey) }),
  changes: VersionChanges.nullable(),
  /** What code changed in the model's output, one line each. Never fixed silently. */
  normalization: z.array(z.string()),
  notes: z.array(z.string()),
});
export type StoryboardContent = z.infer<typeof StoryboardContent>;

// ── Provider-neutral data (no prices) ────────────────────────────────────────

/**
 * The production methods each treatment can be made with, the usual one
 * first. The router keeps those the class rules allow: a real person's
 * PORTRAIT is sourced, a fictional one generated.
 */
export const TREATMENT_METHODS: Readonly<Record<VisualTreatment, readonly ProductionMethod[]>> = {
  CINEMATIC_RECONSTRUCTION: ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO', 'STILL_MOTION'],
  GENERATED_STILL: ['GENERATIVE_IMAGE', 'STILL_MOTION'],
  ARCHIVAL_IMAGE: ['ARCHIVAL_SOURCING'],
  ARCHIVAL_VIDEO: ['ARCHIVAL_SOURCING'],
  DOCUMENT_ANIMATION: ['DOCUMENT_MOTION'],
  MAP_ANIMATION: ['MAP_RENDER'],
  DATA_VISUALIZATION: ['DETERMINISTIC_GRAPHIC'],
  TIMELINE: ['DETERMINISTIC_GRAPHIC'],
  DIAGRAM: ['DETERMINISTIC_GRAPHIC'],
  INFOGRAPHIC: ['DETERMINISTIC_GRAPHIC'],
  PORTRAIT: ['ARCHIVAL_SOURCING', 'GENERATIVE_IMAGE'],
  CHARACTER_VISUAL: ['GENERATIVE_IMAGE', 'IMAGE_TO_VIDEO'],
  ENVIRONMENT: ['GENERATIVE_IMAGE', 'STILL_MOTION', 'GENERATIVE_VIDEO', 'STOCK_SOURCING'],
  PRODUCT_OBJECT: ['GENERATIVE_IMAGE', 'STILL_MOTION', 'GENERATIVE_VIDEO', 'STOCK_SOURCING'],
  SCREEN_CAPTURE: ['SCREEN_RECORDING'],
  NEWS_FOOTAGE: ['ARCHIVAL_SOURCING'],
  ABSTRACT_METAPHOR: ['GENERATIVE_VIDEO', 'MOTION_DESIGN'],
  TEXT_ON_SCREEN: ['EDIT_TIME'],
  TRANSITION: ['EDIT_TIME'],
  MOTION_GRAPHIC: ['MOTION_DESIGN'],
};

/** Treatments that show a record: only ever sourced, never generated (GENERATED_RECORD). */
export const RECORD_TREATMENTS: readonly VisualTreatment[] = ['ARCHIVAL_IMAGE', 'ARCHIVAL_VIDEO', 'NEWS_FOOTAGE', 'DOCUMENT_ANIMATION', 'SCREEN_CAPTURE'];

/** What a treatment needs before it may show a shot of a class, where it is allowed only under a condition. */
export const TREATMENT_CONDITIONS = [
  'GROUNDED_SPECIFICS', // every specific rests on a claim or is generic for the period
  'VISIBLE_DEVICE', // a realised, visible uncertainty device
  'NO_DEPICTS', // mood or structure only: no DEPICTS claim
  'SOURCED', // a sourced record, never generated
  'UNCERTAINTY_MARKED', // uncertain areas or items are marked as such
  'HEDGED_DATA', // ESTABLISHED or PROBABLE data, with a hedged label
  'RANGES_CAPTIONED', // ranges or competing series, with a caption
  'DOCUMENTED_LIKENESS', // a sourced, documented likeness
  'NON_IDENTIFYING', // no identifiable likeness of a real person
  'VERIFIED_QUOTE', // a quotation is a verified recorded quote
  'PRESENTATION_WORDING', // the wording follows the claim's presentation
] as const;
export type TreatmentCondition = (typeof TREATMENT_CONDITIONS)[number];

/** Whether a treatment may show a shot of a class, and under which condition (null: none). */
export interface TreatmentClassRule {
  allowed: boolean;
  condition: TreatmentCondition | null;
}

const YES: TreatmentClassRule = { allowed: true, condition: null };
const NO: TreatmentClassRule = { allowed: false, condition: null };
const IF = (condition: TreatmentCondition): TreatmentClassRule => ({ allowed: true, condition });
const row = (documented: TreatmentClassRule, reconstruction: TreatmentClassRule, uncertain: TreatmentClassRule, fiction: TreatmentClassRule, framing: TreatmentClassRule) => ({
  DOCUMENTED: documented,
  RECONSTRUCTION: reconstruction,
  UNCERTAIN: uncertain,
  FICTION: fiction,
  FRAMING: framing,
});

const GENERATED = row(IF('GROUNDED_SPECIFICS'), YES, IF('VISIBLE_DEVICE'), YES, IF('NO_DEPICTS'));
const RECORD = row(IF('SOURCED'), IF('SOURCED'), IF('SOURCED'), NO, IF('SOURCED'));
const MARKED = row(YES, YES, IF('UNCERTAINTY_MARKED'), NO, YES);
const DATA = row(YES, IF('HEDGED_DATA'), IF('RANGES_CAPTIONED'), NO, NO);
const ANY = row(YES, YES, YES, YES, YES);
const DESIGN = row(IF('NO_DEPICTS'), YES, YES, YES, YES);

/**
 * The treatment × shot class matrix (§2.7). A FICTION shot is labelled as a
 * fictional device wherever it appears; the hard rules (no generated
 * records, fiction placement, likeness, uncertain shown as fact…) apply on
 * top of it.
 */
export const TREATMENT_CLASS_RULES: Readonly<Record<VisualTreatment, Readonly<Record<ScriptBlockClass, TreatmentClassRule>>>> = {
  CINEMATIC_RECONSTRUCTION: GENERATED,
  GENERATED_STILL: GENERATED,
  ARCHIVAL_IMAGE: RECORD,
  ARCHIVAL_VIDEO: RECORD,
  NEWS_FOOTAGE: RECORD,
  DOCUMENT_ANIMATION: row(IF('SOURCED'), IF('SOURCED'), IF('SOURCED'), NO, NO),
  SCREEN_CAPTURE: RECORD,
  MAP_ANIMATION: MARKED,
  DATA_VISUALIZATION: DATA,
  INFOGRAPHIC: DATA,
  TIMELINE: MARKED,
  DIAGRAM: MARKED,
  PORTRAIT: row(IF('DOCUMENTED_LIKENESS'), IF('NON_IDENTIFYING'), IF('NON_IDENTIFYING'), YES, NO),
  CHARACTER_VISUAL: row(IF('NON_IDENTIFYING'), YES, IF('VISIBLE_DEVICE'), YES, NO),
  ENVIRONMENT: ANY,
  PRODUCT_OBJECT: ANY,
  ABSTRACT_METAPHOR: DESIGN,
  MOTION_GRAPHIC: DESIGN,
  TRANSITION: DESIGN,
  TEXT_ON_SCREEN: row(IF('VERIFIED_QUOTE'), YES, IF('PRESENTATION_WORDING'), YES, YES),
};

/** The treatments that may show a shot of a class at all (some only under their condition). */
export function treatmentsFor(infoClass: ScriptBlockClass): VisualTreatment[] {
  return VISUAL_TREATMENTS.filter((t) => TREATMENT_CLASS_RULES[t][infoClass].allowed);
}

/** The treatment a script block's visual intent suggests (a seed: the class matrix still decides). */
export const INTENT_TREATMENT_SEED: Readonly<Record<VisualIntent, VisualTreatment | null>> = {
  CINEMATIC_RECONSTRUCTION: 'CINEMATIC_RECONSTRUCTION',
  DOCUMENT: 'DOCUMENT_ANIMATION',
  MAP: 'MAP_ANIMATION',
  DATA: 'DATA_VISUALIZATION',
  TIMELINE: 'TIMELINE',
  ARCHIVAL: 'ARCHIVAL_IMAGE',
  PORTRAIT: 'PORTRAIT',
  ENVIRONMENT: 'ENVIRONMENT',
  ABSTRACT_METAPHOR: 'ABSTRACT_METAPHOR',
  ON_SCREEN_TEXT: 'TEXT_ON_SCREEN',
  NONE: null,
};

/** The seed treatment of a block's visual intent: a fictional portrait is a character visual. */
export function seedTreatment(intent: VisualIntent, fictional: boolean): VisualTreatment | null {
  const seed = INTENT_TREATMENT_SEED[intent];
  return seed === 'PORTRAIT' && fictional ? 'CHARACTER_VISUAL' : seed;
}

/**
 * Generations allowed for beyond the first, per method: generated video 1.5,
 * a generated still 1.3, everything rendered, sourced or made in the edit 0
 * (sourcing is priced per item, or unpriced). A profile may set its own.
 */
export const DEFAULT_REROLLS: Readonly<Record<ProductionMethod, number>> = {
  GENERATIVE_VIDEO: 1.5,
  IMAGE_TO_VIDEO: 1.5,
  GENERATIVE_IMAGE: 1.3,
  STILL_MOTION: 1.3,
  DETERMINISTIC_GRAPHIC: 0,
  MAP_RENDER: 0,
  DOCUMENT_MOTION: 0,
  ARCHIVAL_SOURCING: 0,
  STOCK_SOURCING: 0,
  SCREEN_RECORDING: 0,
  MOTION_DESIGN: 0,
  EDIT_TIME: 0,
};

/** Average shot length and the most cuts per minute for each density (DENSITY_* and SHOT_COUNT_* warn outside them). */
export const DENSITY_TARGETS: Readonly<Record<VisualDensity, { averageShotSec: { min: number; max: number }; maxCutsPerMinute: number }>> = {
  SPARSE: { averageShotSec: { min: 6, max: 12 }, maxCutsPerMinute: 9 },
  BALANCED: { averageShotSec: { min: 4, max: 8 }, maxCutsPerMinute: 14 },
  DENSE: { averageShotSec: { min: 2.5, max: 5 }, maxCutsPerMinute: 22 },
};

/** Shot durations and rhythm thresholds. */
export const SHOT_LIMITS = {
  /** Shortest shot (DURATION_IMPOSSIBLE below it); a TRANSITION may be as short as transitionMinMs. */
  minMs: 700,
  transitionMinMs: 200,
  maxMs: 60_000,
  /** STATIC_LONG: a static shot longer than this. */
  staticWarnMs: 12_000,
  /** NO_VISUAL_CHANGE: narration longer than this with no cut. */
  noChangeWarnMs: 20_000,
  /** RAPID_CUTS: shots shorter than this, several in a row, with no reason. */
  rapidCutMs: 1_500,
  /** TREATMENT_REPETITION: more consecutive shots of one treatment than this. */
  maxSameTreatmentRun: 4,
  /** UNIFORM_DURATIONS: durations whose coefficient of variation is below this. */
  uniformDurationCv: 0.1,
} as const;

/**
 * Depiction fixed by the treatment (null: it depends on the method and on
 * what the shot shows). A record treatment is a RECORD only when sourced, a
 * data treatment DATA only when not generated, and an illustrative one
 * ILLUSTRATIVE only while a generated picture of it shows no one and depicts
 * no claim: otherwise the picture is generated, and so RECONSTRUCTED.
 */
export const DEPICTION_FOR: Readonly<Record<VisualTreatment, Depiction | null>> = {
  CINEMATIC_RECONSTRUCTION: null,
  GENERATED_STILL: null,
  ARCHIVAL_IMAGE: 'RECORD',
  ARCHIVAL_VIDEO: 'RECORD',
  DOCUMENT_ANIMATION: 'RECORD',
  MAP_ANIMATION: 'DATA',
  DATA_VISUALIZATION: 'DATA',
  TIMELINE: 'DATA',
  DIAGRAM: 'DATA',
  INFOGRAPHIC: 'DATA',
  PORTRAIT: null,
  CHARACTER_VISUAL: null,
  ENVIRONMENT: null,
  PRODUCT_OBJECT: null,
  SCREEN_CAPTURE: 'RECORD',
  NEWS_FOOTAGE: 'RECORD',
  ABSTRACT_METAPHOR: 'ILLUSTRATIVE',
  TEXT_ON_SCREEN: 'ILLUSTRATIVE',
  TRANSITION: 'ILLUSTRATIVE',
  MOTION_GRAPHIC: 'ILLUSTRATIVE',
};

/** What depictionFor looks at. */
export interface DepictionFacts {
  treatment: VisualTreatment;
  method: ProductionMethod;
  /** A subject of a fictional cast kind is in the shot. */
  fictionalSubject: boolean;
  /** People or groups are in the shot. */
  subjects: boolean;
  /** The spec lists objects (each declares a basis). */
  objects: boolean;
  /** The shot has a DEPICTS claim. */
  depicts: boolean;
}

/**
 * A shot's depiction, derived (never proposed), the first match winning:
 * a fictional subject makes it FICTIONAL; a record treatment is a RECORD
 * when sourced, a data treatment DATA when not generated (either one
 * generated is RECONSTRUCTED); a picture that is not generated keeps the
 * treatment's depiction (a sourced portrait being a RECORD, stock footage
 * ILLUSTRATIVE). A generated picture is RECONSTRUCTED when it shows subjects
 * or depicts a claim, whatever its treatment is called, and when a scene
 * shows objects; otherwise (a place, a product or a design that asserts
 * nothing) it is ILLUSTRATIVE.
 */
export function depictionFor(f: DepictionFacts): Depiction {
  if (f.fictionalSubject) return 'FICTIONAL';
  const generated = GENERATIVE_METHODS.includes(f.method);
  const fixed = DEPICTION_FOR[f.treatment];
  if (fixed === 'RECORD') return SOURCING_METHODS.includes(f.method) ? 'RECORD' : 'RECONSTRUCTED';
  if (fixed === 'DATA') return generated ? 'RECONSTRUCTED' : 'DATA';
  if (!generated) return fixed ?? (f.method === 'ARCHIVAL_SOURCING' ? 'RECORD' : 'ILLUSTRATIVE');
  if (f.depicts || f.subjects) return 'RECONSTRUCTED';
  const scene = fixed === null && f.treatment !== 'ENVIRONMENT' && f.treatment !== 'PRODUCT_OBJECT';
  return scene && f.objects ? 'RECONSTRUCTED' : 'ILLUSTRATIVE';
}
