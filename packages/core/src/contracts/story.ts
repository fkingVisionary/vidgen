import { z } from 'zod';
import {
  BEAT_FUNCTIONS,
  CAST_KINDS,
  CHARACTER_KINDS,
  HISTORICAL_STATUSES,
  INFORMATION_CLASSES,
  NARRATIVE_MODES,
  POV_STRATEGIES,
  PRESENTATIONS,
  RECONSTRUCTION_LEVELS,
  SPEECH_KINDS,
  TIME_JUMPS,
} from '../enums.ts';

/**
 * Shapes of the story stage's JSON documents: story candidates (mined from an
 * approved research dossier) and the story architecture built from the
 * editor's selection.
 *
 * Like the dossier sections, everything references claims by `claimKeys`
 * ("C014"), so every story beat traces back to a claim with a verdict and
 * citations. Sources are derived from those claims, never chosen by a model.
 */

const ClaimKeys = z.array(z.string());

/** StoryCandidate.characters[] — only people, groups and roles that appear in the evidence. */
export const StoryCharacter = z.object({
  name: z.string().min(1),
  kind: z.enum(CHARACTER_KINDS),
  /** What they want or do in this story. */
  role: z.string().min(1),
  claimKeys: ClaimKeys,
});
export type StoryCharacter = z.infer<typeof StoryCharacter>;

/**
 * StoryCandidate.mythThread — a myth told as an investigation, not a lecture:
 * the popular story → where it came from → who created or repeated it → what
 * actually happened → why it survived.
 */
export const MythThread = z.object({
  popularStory: z.string().min(1),
  origin: z.string().min(1),
  whoSpreadIt: z.string().min(1),
  whatHappened: z.string().min(1),
  whyItSurvived: z.string().min(1),
  claimKeys: ClaimKeys,
});
export type MythThread = z.infer<typeof MythThread>;

/** Appeal components scored by the critic. Historical confidence is computed from the evidence instead. */
export const STORY_SCORE_KEYS = [
  'intrigue',
  'humanDrama',
  'stakes',
  'surprise',
  'escalation',
  'visualPotential',
  'financialStakes',
  'emotionalWeight',
] as const;
export type StoryScoreKey = (typeof STORY_SCORE_KEYS)[number];

const Score = z.number().int().min(0).max(10);

/** StoryCandidate.scores — the critic's component scores (0–10), the weighted appeal and the critic's reasoning. */
export const StoryScores = z.object({
  intrigue: Score,
  humanDrama: Score,
  stakes: Score,
  surprise: Score,
  escalation: Score,
  visualPotential: Score,
  /** Financial or economic significance. */
  financialStakes: Score,
  emotionalWeight: Score,
  /** Weighted appeal before the historical-confidence adjustment (0–10). */
  appeal: z.number().min(0).max(10),
  rationale: z.string(),
});
export type StoryScores = z.infer<typeof StoryScores>;

/** Appeal components scored by the Story Engine 2.0 critic: STORY VALUE. */
export const STORY_VALUE_KEYS = [
  'humanStakes',
  'conflict',
  'mystery',
  'escalation',
  'characterPotential',
  'visualPotential',
  'emotionalPotential',
  'revealPotential',
  'mythInvestigation',
] as const;
export type StoryValueKey = (typeof STORY_VALUE_KEYS)[number];

/** Components of HISTORICAL VALUE. evidenceQuality is computed from the claims; the rest are scored by the critic. */
export const HISTORICAL_VALUE_KEYS = ['evidenceQuality', 'significance', 'relevance', 'uniqueness'] as const;
export type HistoricalValueKey = (typeof HISTORICAL_VALUE_KEYS)[number];

/**
 * StoryCandidate.scores in Story Engine 2.0: story value and historical value
 * scored separately, combined into STORY APPEAL with explainable weights
 * (packages/core/src/story.ts), and the critic's reason for each dimension.
 */
export const StoryScoresV2 = z.object({
  version: z.literal(2),
  story: z.object(Object.fromEntries(STORY_VALUE_KEYS.map((k) => [k, Score])) as Record<StoryValueKey, typeof Score>),
  /** False when the unit has no uncertain or myth material: mythInvestigation then carries no weight. */
  mythApplicable: z.boolean(),
  history: z.object({
    evidenceQuality: z.number().min(0).max(10),
    significance: Score,
    relevance: Score,
    uniqueness: Score,
  }),
  storyValue: z.number().min(0).max(10),
  historicalValue: z.number().min(0).max(10),
  /** STORY APPEAL: story value moderated by historical value. The ranking score. */
  appeal: z.number().min(0).max(10),
  /** One line per dimension: why it scored as it did. */
  reasons: z.array(z.object({ dimension: z.string(), reason: z.string() })),
  rationale: z.string(),
});
export type StoryScoresV2 = z.infer<typeof StoryScoresV2>;

/** Scores of either engine (engine-1 packs keep their 8 appeal components). */
export const AnyStoryScores = z.union([StoryScoresV2, StoryScores]);
export type AnyStoryScores = z.infer<typeof AnyStoryScores>;

/** A point-of-view strategy and how it is used. */
export const PovChoice = z.object({ type: z.enum(POV_STRATEGIES), description: z.string() });
export type PovChoice = z.infer<typeof PovChoice>;

/** StoryCandidate.humanStakes — the human story inside the event (desire is stored as the candidate's `desire`). */
export const HumanStakes = z.object({
  protagonist: z.string(),
  couldGain: z.string(),
  couldLose: z.string(),
  immediateProblem: z.string(),
});
export type HumanStakes = z.infer<typeof HumanStakes>;

/** StoryCandidate.storyDesign — how the unit could be told on screen. */
export const StoryDesign = z.object({
  /** One immersive opening line, labelled with its information class. */
  coldOpen: z.object({ text: z.string(), basis: z.enum(INFORMATION_CLASSES) }),
  reveal: z.string(),
  visualEnvironment: z.string(),
  /** False when no person, group or role with something at stake was found in the evidence. */
  humanStory: z.boolean(),
});
export type StoryDesign = z.infer<typeof StoryDesign>;

/** StoryCandidate.editorOverrides — the editor's changes; the AI's original values stay in their columns. */
export const CandidateOverrides = z.object({
  title: z.string().optional(),
  narrativeMode: z.enum(NARRATIVE_MODES).optional(),
  centralQuestion: z.string().optional(),
  povStrategy: PovChoice.optional(),
});
export type CandidateOverrides = z.infer<typeof CandidateOverrides>;

/** StoryPack.content — what the pack holds besides its candidates. */
export const StoryPackContent = z.object({
  /** The AI's proposed selection for the documentary: a suggestion for the editor, never a decision. */
  selection: z.object({
    candidateKeys: z.array(z.string()),
    workingPremise: z.string(),
    rationale: z.string(),
    /** Candidates that could replace a selected one. */
    alternates: z.array(z.string()),
    /** Engine 2: the documentary these units suggest (proposals for the editor). */
    centralQuestion: z.string().default(''),
    narrativeMode: z.enum(NARRATIVE_MODES).nullable().default(null),
    povStrategy: PovChoice.nullable().default(null),
  }),
  /** Candidates the rules or the critic removed, and why (kept for transparency). */
  removed: z.array(z.object({ title: z.string(), storyType: z.string(), reason: z.string(), claimKeys: ClaimKeys })),
  /** Candidates the editor approved or flagged in the previous pass, carried into this one. */
  carriedOver: z.array(z.object({ fromPackVersion: z.number().int(), fromKey: z.string(), key: z.string() })),
  /** The editor's brief for this pass, if any. */
  editorNotes: z.string().nullable(),
});
export type StoryPackContent = z.infer<typeof StoryPackContent>;

/**
 * One sequence of the documentary blueprint. Text fields may be empty: the
 * architecture gate reports what is missing rather than the parser.
 */
export const StorySequence = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  /** What the sequence does for the documentary. */
  purpose: z.string(),
  /** Story candidates it is built from (ids and their keys in the pack). */
  candidateIds: z.array(z.string()),
  candidateKeys: z.array(z.string()),
  openingHook: z.string(),
  /** The question that keeps the viewer watching through the sequence. */
  narrativeQuestion: z.string(),
  /** Story beats; each cites core claims only. */
  keyEvents: z.array(z.object({ event: z.string().min(1), claimKeys: ClaimKeys })),
  characters: z.array(z.string()),
  conflict: z.string(),
  escalation: z.string(),
  reveal: z.string(),
  endingBeat: z.string(),
  /** Core evidence: claims of the selected story candidates, and only those. */
  claimKeys: ClaimKeys,
  /** Retrieved sources cited by the core claims (derived from the dossier). */
  sourceIds: z.array(z.string()),
  /**
   * Other claims of the approved dossier, used only as background (setting,
   * explanation), each with what it is used for. They may not introduce a new
   * story, person, event, figure or narrative beat.
   */
  contextClaims: z.array(z.object({ claimKey: z.string(), purpose: z.string() })).default([]),
  /** Retrieved sources cited by the context claims (derived from the dossier). */
  contextSourceIds: z.array(z.string()).default([]),
  /** How each disputed, unverified or myth claim used (core or context) must be told on screen. */
  caveats: z.array(z.object({ claimKey: z.string(), framing: z.string().min(1) })),
  /** Computed from the verdicts of all the claims the sequence uses. */
  historicalStatus: z.enum(HISTORICAL_STATUSES),
  historicalConfidence: z.number().int().min(0).max(10),
  estimatedDurationSec: z.number().int().min(0),
});
export type StorySequence = z.infer<typeof StorySequence>;

/** StoryArchitecture.content — the documentary blueprint (not a script). */
export const StoryArchitectureContent = z.object({
  premise: z.string(),
  centralQuestion: z.string(),
  narrativeSpine: z.string(),
  /** How the documentary answers its central question. */
  resolution: z.string(),
  sequences: z.array(StorySequence),
  /** Selected candidates the architect left out, and why. */
  unusedCandidates: z.array(z.object({ candidateKey: z.string(), reason: z.string() })),
});
export type StoryArchitectureContent = z.infer<typeof StoryArchitectureContent>;

// ---------------------------------------------------------------------------
// Story Engine 2.0 — architecture
// ---------------------------------------------------------------------------

/** How the narration must present one claim (required for every claim that is not ESTABLISHED). */
export const ClaimPresentation = z.object({
  claimKey: z.string(),
  presentation: z.enum(PRESENTATIONS),
  /** Guidance for the script, e.g. "records suggest…", "present as the legend, then test it against the record". */
  instruction: z.string().min(1),
});
export type ClaimPresentation = z.infer<typeof ClaimPresentation>;

/** Someone who appears in the documentary. Fictional kinds are narrative devices, never historical people. */
export const StoryCastMember = z.object({
  /** Referenced by beats and speech: "pov" for the viewer proxy, "F1"… for composites, "R1"… for real people. */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(CAST_KINDS),
  /** Who they are; for a composite, the documented kind of person they stand for. */
  description: z.string(),
  /** Real cast: claims that ground them. Composite: claims that establish people like them existed. */
  claimKeys: ClaimKeys,
  /** Why a fictional device is needed (empty for real cast). */
  justification: z.string(),
});
export type StoryCastMember = z.infer<typeof StoryCastMember>;

/** A line of speech planned for a beat. Not script: it marks where dialogue belongs and what kind it is. */
export const BeatSpeech = z.object({
  speakerId: z.string(),
  text: z.string().min(1),
  kind: z.enum(SPEECH_KINDS),
  /** RECORDED_QUOTE: the claim whose verified quotation this is. */
  claimKey: z.string().nullable(),
});
export type BeatSpeech = z.infer<typeof BeatSpeech>;

/** What happens on screen, labelled with its information class and the claims behind it. */
export const StoryBeat = z.object({
  /** "<sequence>.<beat>", e.g. "3.2". Content opportunities reference beats by id. */
  id: z.string(),
  function: z.enum(BEAT_FUNCTIONS),
  basis: z.enum(INFORMATION_CLASSES),
  description: z.string().min(1),
  claimKeys: ClaimKeys,
  castIds: z.array(z.string()),
  speech: z.array(BeatSpeech),
});
export type StoryBeat = z.infer<typeof StoryBeat>;

/** A setting value and whether it is documented or reconstructed. */
export const SettingField = z.object({ value: z.string(), basis: z.enum(['DOCUMENTED', 'RECONSTRUCTION']) });
export type SettingField = z.infer<typeof SettingField>;

export const SceneSetting = z.object({ location: SettingField, date: SettingField, timeOfDay: SettingField });
export type SceneSetting = z.infer<typeof SceneSetting>;

/** Visual thinking for the future Visual Director. Historical details that must appear cite claims. */
export const SequenceVisual = z.object({
  environment: z.string(),
  keyObjects: z.array(z.string()),
  physicalActions: z.array(z.string()),
  emotionalState: z.string(),
  visualMetaphor: z.string(),
  mustShow: z.array(z.object({ detail: z.string(), claimKeys: ClaimKeys })),
  /** Anachronisms and unjustified imagery to avoid. */
  mustAvoid: z.array(z.string()),
  shotIdeas: z.array(z.string()),
});
export type SequenceVisual = z.infer<typeof SequenceVisual>;

/** What one sequence inherits from and hands on to the next, so the documentary is one story. */
export const SequenceContinuity = z.object({
  /** Objects, knowledge or decisions the POV and cast bring in from earlier sequences. */
  carriesIn: z.array(z.string()),
  carriesOut: z.array(z.string()),
  /** Questions and promises opened here ("Q0" is the central question, opened by the documentary). */
  opens: z.array(z.object({ id: z.string(), question: z.string() })),
  /** Ids of questions and promises answered here. */
  resolves: z.array(z.string()),
  timeJump: z.enum(TIME_JUMPS),
});
export type SequenceContinuity = z.infer<typeof SequenceContinuity>;

/** One sequence of a Story Engine 2.0 architecture: a dramatic unit built from beats, not a heading. */
export const StorySequenceV2 = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  purpose: z.string(),
  mode: z.enum(NARRATIVE_MODES),
  candidateIds: z.array(z.string()),
  candidateKeys: z.array(z.string()),
  openingHook: z.string(),
  question: z.string(),
  conflict: z.string(),
  escalation: z.string(),
  reveal: z.string(),
  consequence: z.string(),
  endingBeat: z.string(),
  transition: z.string(),
  beats: z.array(StoryBeat),
  /** Cast present in the sequence (derived from its beats and speech). */
  castIds: z.array(z.string()),
  setting: SceneSetting,
  visual: SequenceVisual,
  continuity: SequenceContinuity,
  /** Story evidence: claims of the selected units, and only those. */
  claimKeys: ClaimKeys,
  sourceIds: z.array(z.string()),
  /** Other dossier claims used only as background, each with what it is for. */
  contextClaims: z.array(z.object({ claimKey: z.string(), purpose: z.string() })),
  contextSourceIds: z.array(z.string()),
  /** How each claim that is not ESTABLISHED must be presented. */
  presentation: z.array(ClaimPresentation),
  historicalStatus: z.enum(HISTORICAL_STATUSES),
  historicalConfidence: z.number().int().min(0).max(10),
  estimatedDurationSec: z.number().int().min(0),
});
export type StorySequenceV2 = z.infer<typeof StorySequenceV2>;

/** Share of beats per information class (computed). */
export const ReconstructionSummary = z.object({
  level: z.enum(RECONSTRUCTION_LEVELS),
  beats: z.number().int().min(0),
  shares: z.object({ DOCUMENTED: z.number(), RECONSTRUCTION: z.number(), UNCERTAIN: z.number(), FICTION: z.number() }),
});
export type ReconstructionSummary = z.infer<typeof ReconstructionSummary>;

/** StoryArchitecture.content in Story Engine 2.0: a cinematic blueprint (not a script) inside the evidence boundary. */
export const StoryArchitectureContentV2 = z.object({
  engineVersion: z.literal(2),
  logline: z.string(),
  centralQuestion: z.string(),
  centralHumanStakes: z.string(),
  narrativeMode: z.enum(NARRATIVE_MODES),
  secondaryModes: z.array(z.enum(NARRATIVE_MODES)),
  povStrategy: PovChoice,
  cast: z.array(StoryCastMember),
  thesis: z.string(),
  narrativeSpine: z.string(),
  /** How the documentary answers its central question. */
  resolution: z.string(),
  /** Why the sequence order differs from the editor's order, if it does. */
  orderNote: z.string(),
  sequences: z.array(StorySequenceV2),
  unusedCandidates: z.array(z.object({ candidateKey: z.string(), reason: z.string() })),
  reconstruction: ReconstructionSummary,
});
export type StoryArchitectureContentV2 = z.infer<typeof StoryArchitectureContentV2>;

/** Architecture content of either engine. Engine-1 content has no engineVersion. */
export const AnyStoryArchitectureContent = z.union([StoryArchitectureContentV2, StoryArchitectureContent]);
export type AnyStoryArchitectureContent = z.infer<typeof AnyStoryArchitectureContent>;

export function isArchitectureV2(c: AnyStoryArchitectureContent): c is StoryArchitectureContentV2 {
  return 'engineVersion' in c && c.engineVersion === 2;
}

// ---------------------------------------------------------------------------
// Content opportunities
// ---------------------------------------------------------------------------

/** Short-form potential components (0–10), scored when the opportunity is identified. */
export const OPPORTUNITY_SCORE_KEYS = ['hook', 'payoff', 'standalone', 'visual', 'emotion', 'pace'] as const;
export type OpportunityScoreKey = (typeof OPPORTUNITY_SCORE_KEYS)[number];

export const OpportunityScores = z.object(Object.fromEntries(OPPORTUNITY_SCORE_KEYS.map((k) => [k, Score])) as Record<OpportunityScoreKey, typeof Score>);
export type OpportunityScores = z.infer<typeof OpportunityScores>;

/**
 * ContentOpportunity.content — everything a future Shorts Engine needs to
 * produce the piece without rediscovering the story. Every reference points
 * back into the approved architecture (beats, sequences, units) and through
 * it to the approved dossier (claims, sources). No script, voice or video.
 */
export const ContentOpportunityContent = z.object({
  standalonePremise: z.string(),
  /** The short-form narrative angle. */
  angle: z.string(),
  escalation: z.string(),
  /** Reveal or payoff. */
  payoff: z.string(),
  suggestedEnding: z.string(),
  visualConcept: z.string(),
  /** What a viewer must know first, when the piece is not fully standalone. */
  contextNote: z.string(),
  beatIds: z.array(z.string()),
  sequenceNumbers: z.array(z.number().int()),
  candidateKeys: z.array(z.string()),
  candidateIds: z.array(z.string()),
  claimKeys: ClaimKeys,
  sourceIds: z.array(z.string()),
  castIds: z.array(z.string()),
  /** Copied from the architecture: how each claim that is not ESTABLISHED must be presented. */
  presentation: z.array(ClaimPresentation),
  scores: OpportunityScores,
  whyItWorks: z.string(),
  /** What the evidence rules adjusted. */
  notes: z.array(z.string()),
});
export type ContentOpportunityContent = z.infer<typeof ContentOpportunityContent>;
