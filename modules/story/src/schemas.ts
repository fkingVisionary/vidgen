import {
  BEAT_FUNCTIONS,
  CAST_KINDS,
  CHARACTER_KINDS,
  CONTENT_FORMATS,
  INFORMATION_CLASSES,
  NARRATIVE_MODES,
  POV_STRATEGIES,
  PRESENTATIONS,
  RECONSTRUCTION_LEVELS,
  SPEECH_KINDS,
  STORY_TYPES,
  TIME_JUMPS,
} from '@docengine/core';
import { z } from 'zod';

/**
 * Output schemas of the story model calls. Deliberately plain (all fields
 * required, nullable instead of optional, no numeric bounds) so they map
 * cleanly onto structured outputs; the strict rules are enforced afterwards in
 * code (mining.ts, architecture.ts, opportunities.ts, quality.ts), where they
 * can be tested.
 */

const ClaimKeys = z.array(z.string()).describe('dossier claim keys, e.g. ["C004","C017"]');
const Score = z.number().describe('integer 0–10');
const PovOutput = z.object({ type: z.enum(POV_STRATEGIES), description: z.string().describe('how the point of view is used; empty for NARRATOR') });

// ── Mining ───────────────────────────────────────────────────────────────────

export const MythThreadOutput = z.object({
  popularStory: z.string().describe('the story as commonly told'),
  origin: z.string().describe('where it came from'),
  whoSpreadIt: z.string().describe('who created or repeated it'),
  whatHappened: z.string().describe('what the evidence shows actually happened'),
  whyItSurvived: z.string().describe('why the popular version lasted'),
  claimKeys: ClaimKeys,
});

export const MinedCandidate = z.object({
  title: z.string().describe('short and specific: a story, not a topic label'),
  hook: z.string().describe('one sentence that makes a viewer need to know what happens next'),
  storyType: z.enum(STORY_TYPES),
  characters: z.array(
    z.object({
      name: z.string().describe('a NAMED_PERSON exactly as spelled in the evidence; for a GROUP or ROLE a plain description, e.g. "the town\'s bakers"'),
      kind: z.enum(CHARACTER_KINDS),
      role: z.string().describe('what they want or do in this story'),
      claimKeys: ClaimKeys,
    }),
  ),
  protagonist: z.string().describe('who carries the story: a person, group or role from the characters; empty if the evidence records none'),
  setting: z.string(),
  timePeriod: z.string(),
  desire: z.string().describe('what the protagonist wanted, as their recorded actions show'),
  couldGain: z.string().describe('what they stood to gain'),
  couldLose: z.string().describe('what they stood to lose'),
  immediateProblem: z.string().describe('the problem in front of them when the story starts'),
  conflict: z.string(),
  stakes: z.string(),
  escalation: z.string(),
  turningPoint: z.string(),
  reveal: z.string().describe('a documented fact that changes how the viewer understands the situation'),
  payoff: z.string().describe('the consequence: what happened because of the decision or event'),
  whyInteresting: z.string().describe('why someone would keep listening for another 30 seconds'),
  viewerQuestion: z.string().describe('the unanswered question this story makes the viewer want answered'),
  centralQuestion: z.string().describe('the question this unit could carry as a whole documentary segment'),
  visualEnvironment: z.string().describe('where it happens and what is visible there, as far as the evidence or period allows'),
  coldOpen: z
    .object({ text: z.string().describe('one line that drops the viewer into the situation'), basis: z.enum(INFORMATION_CLASSES) })
    .describe('an immersive opening, labelled with its information class (a second-person scene is a RECONSTRUCTION or FICTION, never DOCUMENTED)'),
  narrativeMode: z.enum(NARRATIVE_MODES).describe('the mode that best fits this unit\'s evidence and human story'),
  povStrategy: PovOutput,
  reconstructionLevel: z.enum(RECONSTRUCTION_LEVELS).describe('how much reconstruction or fiction telling it well would need'),
  claimKeys: ClaimKeys.describe('every claim this story relies on'),
  mythThread: MythThreadOutput.nullable().describe('required when the story uses a claim marked MYTH; otherwise null'),
  notes: z.string().describe('caveats the telling must respect; empty if none'),
});
export type MinedCandidate = z.infer<typeof MinedCandidate>;

export const MiningOutput = z.object({ candidates: z.array(MinedCandidate) });
export type MiningOutput = z.infer<typeof MiningOutput>;

export const SUPPORT_VERDICTS = ['SUPPORTED', 'NEEDS_CAVEAT', 'UNSUPPORTED'] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

export const CriticOutput = z.object({
  assessments: z.array(
    z.object({
      candidateId: z.string().describe('the candidate id, e.g. M04'),
      // STORY VALUE
      humanStakes: Score,
      conflict: Score,
      mystery: Score,
      escalation: Score,
      characterPotential: Score,
      visualPotential: Score,
      emotionalPotential: Score,
      revealPotential: Score,
      mythInvestigation: Score,
      // HISTORICAL VALUE (evidence quality is computed from the claims)
      significance: Score,
      relevance: Score,
      uniqueness: Score,
      reasons: z.array(z.object({ dimension: z.string().describe('a score name, e.g. "humanStakes"'), reason: z.string().describe('one line') })).describe('one line for each score above'),
      rationale: z.string().describe('one or two sentences: what makes it strong or weak as a story'),
      support: z.enum(SUPPORT_VERDICTS),
      problems: z.array(z.string()).describe('each statement the cited evidence does not support or that overstates it; empty if none'),
      caveat: z.string().nullable().describe('how the telling must qualify the story when support is NEEDS_CAVEAT; otherwise null'),
    }),
  ),
});
export type CriticOutput = z.infer<typeof CriticOutput>;
export type CriticAssessment = CriticOutput['assessments'][number];

export const SelectionOutput = z.object({
  selected: z.array(z.object({ candidateKey: z.string().describe('e.g. S03'), reason: z.string().describe('the role this unit plays in the documentary') })),
  workingPremise: z.string().describe('the documentary these units add up to, in one or two sentences'),
  rationale: z.string().describe('how the selected units work together'),
  alternates: z.array(z.string()).describe('candidate keys that could replace a selected unit'),
  centralQuestion: z.string().describe('the question the documentary would build towards'),
  narrativeMode: z.enum(NARRATIVE_MODES).describe('the main narrative mode for the documentary'),
  povStrategy: PovOutput,
});
export type SelectionOutput = z.infer<typeof SelectionOutput>;

// ── Architecture ─────────────────────────────────────────────────────────────

export const ArchitectCastMember = z.object({
  id: z.string().describe('"pov" for the viewer proxy, "F1"… for fictional composites, "R1"… for real people, groups and roles'),
  name: z.string().describe('real cast exactly as in the evidence; the POV proxy is "You"'),
  kind: z.enum(CAST_KINDS),
  description: z.string().describe('who they are; for a composite, the documented kind of person they stand for'),
  claimKeys: ClaimKeys.describe('real cast: claims that ground them; composite: claims establishing that people like them existed'),
  justification: z.string().describe('why a fictional device is needed; empty for real cast'),
});

export const ArchitectBeat = z.object({
  function: z.enum(BEAT_FUNCTIONS),
  basis: z.enum(INFORMATION_CLASSES),
  description: z.string().describe('what happens on screen, one or two sentences; describes the drama, never narration prose'),
  claimKeys: ClaimKeys.describe('DOCUMENTED, RECONSTRUCTION and UNCERTAIN beats must cite the claims behind them'),
  castIds: z.array(z.string()).describe('cast ids present in the beat'),
  speech: z
    .array(
      z.object({
        speakerId: z.string(),
        text: z.string(),
        kind: z.enum(SPEECH_KINDS),
        claimKey: z.string().nullable().describe('RECORDED_QUOTE: the claim whose verified quotation this is; otherwise null'),
      }),
    )
    .describe('planned lines of speech, if any; empty for most beats'),
});

const SettingFieldOutput = z.object({ value: z.string(), basis: z.enum(['DOCUMENTED', 'RECONSTRUCTION']) });

export const ArchitectSequence = z.object({
  title: z.string(),
  purpose: z.string().describe('what this sequence does for the documentary'),
  mode: z.enum(NARRATIVE_MODES),
  candidateKeys: z.array(z.string()).describe('selected story units this sequence tells, e.g. ["S03"]'),
  openingHook: z.string(),
  question: z.string().describe('the question that keeps the viewer watching through this sequence'),
  conflict: z.string(),
  escalation: z.string(),
  reveal: z.string(),
  consequence: z.string(),
  endingBeat: z.string(),
  transition: z.string().describe('the bridge into the next sequence; empty for the last'),
  beats: z.array(ArchitectBeat),
  setting: z.object({ location: SettingFieldOutput, date: SettingFieldOutput, timeOfDay: SettingFieldOutput }),
  visual: z.object({
    environment: z.string(),
    keyObjects: z.array(z.string()),
    physicalActions: z.array(z.string()),
    emotionalState: z.string(),
    visualMetaphor: z.string(),
    mustShow: z.array(z.object({ detail: z.string(), claimKeys: ClaimKeys })).describe('historical details that must appear, each with its claims'),
    mustAvoid: z.array(z.string()).describe('anachronisms and unjustified imagery'),
    shotIdeas: z.array(z.string()),
  }),
  continuity: z.object({
    carriesIn: z.array(z.string()),
    carriesOut: z.array(z.string()),
    opens: z.array(z.object({ id: z.string().describe('e.g. "Q3"'), question: z.string() })),
    resolves: z.array(z.string()).describe('ids of questions answered here; "Q0" is the central question'),
    timeJump: z.enum(TIME_JUMPS),
  }),
  claimKeys: ClaimKeys.describe('story evidence: every claim of the selected units this sequence relies on (no other claims)'),
  contextClaims: z
    .array(z.object({ claimKey: z.string(), purpose: z.string().describe('the background it provides') }))
    .describe('other dossier claims used only as background; empty if none'),
  presentation: z
    .array(z.object({ claimKey: z.string(), presentation: z.enum(PRESENTATIONS), instruction: z.string() }))
    .describe('one entry for every PROBABLE, DISPUTED, UNVERIFIED or MYTH claim the sequence uses'),
  estimatedDurationSec: z.number().describe('narration time this sequence needs, in seconds'),
});
export type ArchitectSequence = z.infer<typeof ArchitectSequence>;

export const ArchitectOutput = z.object({
  logline: z.string(),
  centralQuestion: z.string(),
  centralHumanStakes: z.string(),
  narrativeMode: z.enum(NARRATIVE_MODES),
  secondaryModes: z.array(z.enum(NARRATIVE_MODES)),
  povStrategy: PovOutput,
  cast: z.array(ArchitectCastMember),
  thesis: z.string(),
  narrativeSpine: z.string().describe('how the sequences connect into one journey'),
  resolution: z.string().describe('how the documentary answers its central question'),
  orderNote: z.string().describe('why the sequence order differs from the editor\'s order, if it does; otherwise empty'),
  sequences: z.array(ArchitectSequence),
  unusedCandidates: z.array(z.object({ candidateKey: z.string(), reason: z.string() })),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutput>;

const ReviewIssue = z.object({
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  description: z.string(),
  sequenceNumbers: z.array(z.number()),
  claimKeys: ClaimKeys,
  fixedInRevision: z.boolean().describe('true only if `revised` fixes it'),
});

const QualityBarAnswer = z.object({ pass: z.boolean(), why: z.string() });

/** The story editor: is it a story? Scores, the three quality-bar questions, and a revision for drama. */
export const StoryEditorOutput = z.object({
  scores: z.object({
    immersion: Score,
    humanStakes: Score,
    narrativeDrive: Score,
    continuity: Score,
    cinematicPotential: Score,
    clarity: Score,
  }),
  qualityBar: z.object({
    storyWithoutCitations: QualityBarAnswer.describe('if every citation were removed, would there still be an engaging story?'),
    compellingDocumentary: QualityBarAnswer.describe('could this become a compelling 10–15 minute documentary?'),
    truthAndExperience: QualityBarAnswer.describe('would a viewer understand the historical truth while feeling they experienced a story?'),
  }),
  issues: z.array(ReviewIssue),
  revised: ArchitectOutput.nullable().describe('the full revised architecture when the story can be made stronger within the rules; otherwise null'),
});
export type StoryEditorOutput = z.infer<typeof StoryEditorOutput>;

/** The fact checker: the evidence boundary has the last word. */
export const ArchitectureReviewOutput = z.object({
  issues: z.array(ReviewIssue),
  revised: ArchitectOutput.nullable().describe('the full corrected architecture when a CRITICAL or MAJOR issue can be fixed from the evidence; otherwise null'),
});
export type ArchitectureReviewOutput = z.infer<typeof ArchitectureReviewOutput>;

// ── Content opportunities ────────────────────────────────────────────────────

export const OpportunityOutput = z.object({
  opportunities: z.array(
    z.object({
      format: z.enum(CONTENT_FORMATS),
      title: z.string(),
      hook: z.string(),
      centralQuestion: z.string(),
      standalonePremise: z.string().describe('the piece in one or two sentences, understandable on its own'),
      angle: z.string().describe('the short-form narrative angle'),
      beatIds: z.array(z.string()).describe('ids of the architecture beats it is built from, e.g. ["3.1","3.4"]'),
      claimKeys: ClaimKeys.describe('claims of those beats it relies on'),
      castIds: z.array(z.string()).describe('cast ids from the architecture it uses; empty if none'),
      escalation: z.string(),
      payoff: z.string().describe('the reveal or payoff'),
      suggestedEnding: z.string(),
      visualConcept: z.string(),
      targetDurationSec: z.number().describe('SHORT/BOTH: 15–180 seconds; LONG_FORM: the length it deserves'),
      independent: z.boolean().describe('understandable without the long-form documentary'),
      requiresContext: z.boolean(),
      contextNote: z.string().describe('what a viewer must know first; empty if independent'),
      hookScore: Score,
      payoffScore: Score,
      standaloneScore: Score,
      visualScore: Score,
      emotionScore: Score,
      paceScore: Score.describe('how well it fits the short format'),
      whyItWorks: z.string(),
    }),
  ),
});
export type OpportunityOutput = z.infer<typeof OpportunityOutput>;
