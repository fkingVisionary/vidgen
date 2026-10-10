import type {
  ApproachSummary,
  AssetRequirement,
  BeatImportance,
  ContinuitySpec,
  CostAlternative,
  CostRollup,
  CutReason,
  EvidenceRelation,
  GenerationComplexity,
  NarrationApproval,
  NarrationRange,
  ProductionMethod,
  RhythmStats,
  ScriptBlockClass,
  ShotClaimRole,
  ShotEvidence,
  ShotSpec,
  ShotSubjectDetail,
  ShotTiming,
  StoryboardQaFinding,
  StoryboardScope,
  StoryboardScopeInfo,
  TimingRelation,
  VisualApproach,
  VisualBeatContent,
  VisualCatalog,
  VisualCostEstimate,
  VisualPricingSnapshot,
  VisualProfileSnapshot,
  VisualTreatment,
} from '@docengine/core';
import type { ScriptDraft, ScriptScope } from '@docengine/script';
import type { Spine } from './spine.ts';

/**
 * A storyboard version in memory. A StoryboardDraft is what a model or an
 * editor decides: beats and shots anchored to cut points, treatments and
 * structured shot content, subjects and claims by key. A PlannedStoryboard
 * is that draft judged by code against the narration and the evidence:
 * times, relations, classes, depictions, evidence snapshots, asset
 * requirements, cost forecasts, rhythm and QA — everything a version's rows
 * hold. Nothing derived is ever taken from a model.
 */

/** Everything a storyboard is planned against: the approved script and its evidence, the pinned narration, the visual profile and the catalog. */
export interface StoryboardFacts {
  projectId: string;
  /** The approved script in the master language, loaded from its rows (every section and block has its row id). */
  script: ScriptDraft;
  /** The architecture and a fresh read of its evidence. */
  scope: ScriptScope;
  spine: Spine;
  profile: VisualProfileSnapshot;
  catalog: VisualCatalog;
  /** PARTIAL: the narration covers part of the script (a preview). */
  scopeKind: StoryboardScope;
  narrationApproval: NarrationApproval;
}

/** A shot's spec as proposed (its depiction is derived, never proposed). */
export type ShotContent = Omit<ShotSpec, 'depiction'>;

export interface DraftShot {
  /** "SH023": kept across versions. */
  key: string;
  beatKey: string;
  /** The words supported, from cut point to cut point (null: a silence-only shot). */
  narration: NarrationRange | null;
  silenceAt: string | null;
  /** A lead-in or tail-out requested by cut point. */
  visualFrom: string | null;
  visualTo: string | null;
  cutIn: CutReason;
  cutOut: CutReason;
  /** A person's nudge of the cut before this shot (ms; 0: none). */
  cutOffsetMs: number;
  /** Null only on a SHOT_UNPLANNED placeholder. */
  treatment: VisualTreatment | null;
  /** Null: the router chooses. */
  method: ProductionMethod | null;
  /** A proposed class: kept only when it is less assertive than the derived one. */
  proposedClass: ScriptBlockClass | null;
  spec: ShotContent;
  subjects: { subjectKey: string; detail: ShotSubjectDetail }[];
  claims: { claimKey: string; role: ShotClaimRole }[];
  /** A provider and model a person chose (kept across re-costing). */
  recommendation: { provider: string; model: string } | null;
  /** A placeholder for a beat whose plan could not be made valid. */
  unplanned: boolean;
}

/** What a beat says about itself; its narrative class, functions and times are derived. */
export interface BeatProposal {
  title: string;
  purpose: string;
  concept: string;
  informationCommunicated: string[];
  narrativePurpose: string;
  evidenceRelationship: EvidenceRelation;
  importance: BeatImportance;
  complexity: GenerationComplexity;
  continuity: { subjectKeys: string[]; notes: string[] };
  options: VisualBeatContent['options'];
}

export interface DraftBeat {
  /** "VB07": kept across versions. */
  key: string;
  narration: NarrationRange;
  content: BeatProposal;
  archBeatIds: string[];
  claimKeys: string[];
}

export interface DraftSubject {
  /** "CS03": kept across versions. */
  key: string;
  spec: ContinuitySpec;
}

export interface StoryboardDraft {
  approach: VisualApproach;
  beats: DraftBeat[];
  /** In clock order. */
  shots: DraftShot[];
  subjects: DraftSubject[];
  /** What code changed in the model's or a person's input, one line each ("SH004: dropped …"). */
  normalization: string[];
}

/** The words of a script block a shot or beat covers. */
export interface SpanRow {
  scriptBlockId: string;
  blockKey: string;
  startMs: number;
  endMs: number;
  firstWord: number;
  lastWord: number;
}

export interface PlannedShot extends DraftShot {
  sortOrder: number;
  /** The section (scene) where it starts. */
  sceneId: string;
  sectionKey: string;
  startMs: number | null;
  endMs: number | null;
  relation: TimingRelation | null;
  timing: ShotTiming | null;
  /** Readable anchor ("1.3:4–1.4:end"); display only. */
  narrationAnchor: string | null;
  infoClass: ScriptBlockClass | null;
  /** The spec with its derived depiction and automatic labels. */
  direction: ShotSpec;
  blocks: SpanRow[];
  claimRows: { claimId: string; claimKey: string; role: ShotClaimRole }[];
  evidence: ShotEvidence | null;
  asset: AssetRequirement | null;
  cost: VisualCostEstimate | null;
  contentHash: string;
}

export interface PlannedBeat extends DraftBeat {
  sortOrder: number;
  sceneId: string;
  sectionKey: string;
  sequenceNumber: number | null;
  startMs: number | null;
  endMs: number | null;
  /** The approach's treatment. */
  treatment: VisualTreatment;
  /** The narrative class of the words it covers. */
  infoClass: ScriptBlockClass;
  /** The stored content (VisualBeatContent). */
  stored: VisualBeatContent;
  blocks: SpanRow[];
  claimRows: { claimId: string; claimKey: string }[];
  shotKeys: string[];
  contentHash: string;
}

export interface PlannedSubject extends DraftSubject {
  infoClass: ScriptBlockClass;
  appearances: string[];
  contentHash: string;
}

/** A version judged: its rows, its content (but inputs and provenance) and its QA. */
export interface PlannedStoryboard {
  approach: VisualApproach;
  beats: PlannedBeat[];
  shots: PlannedShot[];
  subjects: PlannedSubject[];
  scope: StoryboardScopeInfo;
  runtimeMs: number;
  approaches: { chosen: VisualApproach; options: ApproachSummary[]; keptAsPlanned?: true };
  alternatives: CostAlternative[];
  rhythm: RhythmStats;
  costs: CostRollup;
  evidenceCoverage: { factualShots: number; traced: number; untraced: string[] };
  /** The catalog entries the recommended estimates used. */
  pricing: VisualPricingSnapshot;
  normalization: string[];
  qa: StoryboardQaFinding[];
  qaPassed: boolean;
}

/** An empty shot spec (a placeholder's, or the start of one). */
export function emptyContent(): ShotContent {
  return {
    purpose: '',
    description: '',
    composition: '',
    shotType: null,
    camera: { angle: '', lens: null },
    movement: { motion: null, intensity: 'LOW', note: '' },
    environment: { subjectKey: null, description: '' },
    objects: [],
    lighting: '',
    mood: '',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    continuity: { subjectKeys: [], notes: [] },
    mustShow: [],
    mustAvoid: [],
    specifics: [],
    overlays: [],
    uncertaintyDevice: 'NONE',
    dataSpec: null,
    styleOverrides: {},
    notes: [],
  };
}

/**
 * The draft a planned version was made from (to edit it, re-plan beats or
 * re-time it). Its normalization starts empty: a new version lists only what
 * code changed in making it.
 */
export function draftOf(planned: Pick<PlannedStoryboard, 'approach' | 'beats' | 'shots' | 'subjects'>): StoryboardDraft {
  return structuredClone({
    approach: planned.approach,
    beats: planned.beats.map((b) => ({ key: b.key, narration: b.narration, content: b.content, archBeatIds: b.archBeatIds, claimKeys: b.claimKeys })),
    shots: planned.shots.map((s) => ({
      key: s.key,
      beatKey: s.beatKey,
      narration: s.narration,
      silenceAt: s.silenceAt,
      visualFrom: s.visualFrom,
      visualTo: s.visualTo,
      cutIn: s.cutIn,
      cutOut: s.cutOut,
      cutOffsetMs: s.cutOffsetMs,
      treatment: s.treatment,
      method: s.method,
      proposedClass: s.proposedClass,
      spec: s.spec,
      subjects: s.subjects,
      claims: s.claims,
      recommendation: s.recommendation,
      unplanned: s.unplanned,
    })),
    subjects: planned.subjects.map((s) => ({ key: s.key, spec: s.spec })),
    normalization: [],
  });
}

/** The number of a key ("SH023" → 23). */
export const keyNumber = (key: string) => Number(/\d+$/.exec(key)?.[0] ?? 0);

/** The next key after every one given ("SH024" after "SH023"). */
export function nextKey(keys: Iterable<string>, make: (n: number) => string): string {
  let max = 0;
  for (const k of keys) max = Math.max(max, keyNumber(k));
  return make(max + 1);
}

/** A note about something code dropped from a model's or a person's input (shown as MODEL_REFERENCE_DROPPED). */
export const droppedNote = (ref: string, what: string, why: string) => `${ref}: dropped ${what} — ${why}`;

/** Notes that record a dropped reference, by the shot, beat or subject they name ("shot 2 (VB03)": a shot of a beat, before it had a key). */
export function droppedReferences(notes: readonly string[]): { ref: string | null; detail: string }[] {
  return notes.flatMap((n) => {
    const m = /^(.+?): dropped /.exec(n);
    if (!m) return [];
    const prefix = m[1]!;
    return [{ ref: /^(SH|VB|CS)\d+$/.test(prefix) ? prefix : (/\((VB\d+)\)$/.exec(prefix)?.[1] ?? null), detail: n }];
  });
}
