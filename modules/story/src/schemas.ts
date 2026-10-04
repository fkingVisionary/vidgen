import { CHARACTER_KINDS, STORY_TYPES } from '@docengine/core';
import { z } from 'zod';

/**
 * Output schemas of the story model calls. Deliberately plain (all fields
 * required, nullable instead of optional, no numeric bounds) so they map
 * cleanly onto structured outputs; the strict rules are enforced afterwards in
 * code (mining.ts, architecture.ts, quality.ts), where they can be tested.
 */

const ClaimKeys = z.array(z.string()).describe('dossier claim keys, e.g. ["C004","C017"]');

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
      name: z.string().describe('a NAMED_PERSON exactly as spelled in the evidence; for a GROUP or ROLE a plain description, e.g. "Haarlem florists"'),
      kind: z.enum(CHARACTER_KINDS),
      role: z.string().describe('what they want or do in this story'),
      claimKeys: ClaimKeys,
    }),
  ),
  setting: z.string(),
  timePeriod: z.string(),
  desire: z.string().describe('what the participants were trying to achieve, as their recorded actions show'),
  conflict: z.string(),
  stakes: z.string(),
  escalation: z.string(),
  turningPoint: z.string(),
  payoff: z.string(),
  whyInteresting: z.string().describe('why someone would keep listening for another 30 seconds'),
  viewerQuestion: z.string().describe('the question this story makes the viewer want answered'),
  claimKeys: ClaimKeys.describe('every claim this story relies on'),
  mythThread: MythThreadOutput.nullable().describe('required when the story uses a claim marked MYTH; otherwise null'),
  notes: z.string().describe('caveats the telling must respect; empty if none'),
});
export type MinedCandidate = z.infer<typeof MinedCandidate>;

export const MiningOutput = z.object({ candidates: z.array(MinedCandidate) });
export type MiningOutput = z.infer<typeof MiningOutput>;

export const SUPPORT_VERDICTS = ['SUPPORTED', 'NEEDS_CAVEAT', 'UNSUPPORTED'] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

const Score = z.number().describe('integer 0–10');

export const CriticOutput = z.object({
  assessments: z.array(
    z.object({
      candidateId: z.string().describe('the candidate id, e.g. M04'),
      intrigue: Score,
      humanDrama: Score,
      stakes: Score,
      surprise: Score,
      escalation: Score,
      visualPotential: Score,
      financialStakes: Score,
      emotionalWeight: Score,
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
});
export type SelectionOutput = z.infer<typeof SelectionOutput>;

export const ArchitectSequence = z.object({
  title: z.string(),
  purpose: z.string().describe('what this sequence does for the documentary'),
  candidateKeys: z.array(z.string()).describe('selected story units this sequence tells, e.g. ["S03"]'),
  openingHook: z.string(),
  narrativeQuestion: z.string().describe('the question that keeps the viewer watching through this sequence'),
  keyEvents: z
    .array(z.object({ event: z.string(), claimKeys: ClaimKeys.describe('core claims only: claims of the selected units') }))
    .describe('the story beats, each from the selected units\' own claims'),
  characters: z.array(z.string()).describe('people, groups or roles as named in the story units'),
  conflict: z.string(),
  escalation: z.string(),
  reveal: z.string(),
  endingBeat: z.string().describe('the beat that pulls the viewer into the next sequence (or closes the film)'),
  claimKeys: ClaimKeys.describe('core evidence: every claim of the selected units this sequence relies on (no other claims)'),
  contextClaims: z
    .array(z.object({ claimKey: z.string(), purpose: z.string().describe('the background it provides, e.g. "explains how the contracts worked"') }))
    .describe('other dossier claims used only as background; empty if none. They must not add a story, person, event, figure or beat'),
  caveats: z.array(z.object({ claimKey: z.string(), framing: z.string().describe('how the narration must present this claim') })),
  estimatedDurationSec: z.number().describe('narration time this sequence needs, in seconds'),
});
export type ArchitectSequence = z.infer<typeof ArchitectSequence>;

export const ArchitectOutput = z.object({
  premise: z.string(),
  centralQuestion: z.string(),
  narrativeSpine: z.string().describe('how the sequences connect into one journey'),
  resolution: z.string().describe('how the documentary answers its central question'),
  sequences: z.array(ArchitectSequence),
  unusedCandidates: z.array(z.object({ candidateKey: z.string(), reason: z.string() })),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutput>;

export const ArchitectureReviewOutput = z.object({
  issues: z.array(
    z.object({
      severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
      description: z.string(),
      sequenceNumbers: z.array(z.number()),
      claimKeys: ClaimKeys,
      fixedInRevision: z.boolean().describe('true only if `revised` fixes it'),
    }),
  ),
  revised: ArchitectOutput.nullable().describe('the full corrected architecture when a CRITICAL or MAJOR issue can be fixed from the evidence; otherwise null'),
});
export type ArchitectureReviewOutput = z.infer<typeof ArchitectureReviewOutput>;
