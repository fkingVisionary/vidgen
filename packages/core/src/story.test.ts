import { describe, expect, it } from 'vitest';
import { AnyStoryArchitectureContent, AnyStoryScores, STORY_SCORE_KEYS, STORY_VALUE_KEYS, StoryPackContent, isArchitectureV2, type StoryValueKey } from './contracts/story.ts';
import {
  CONTENT_LIMITS,
  FICTIONAL_CAST_LIMITS,
  HEDGE_PATTERN,
  HISTORICAL_VALUE_WEIGHTS,
  OPPORTUNITY_SCORE_WEIGHTS,
  PRESENTATION_FOR_VERDICT,
  PRESENTATION_VERDICTS,
  RECONSTRUCTION_BUDGET,
  STORY_SCORE_WEIGHTS,
  STORY_VALUE_WEIGHTS,
  historicalValue,
  informationShares,
  reconstructionLevelOf,
  shortPotential,
  storyAppeal,
  storyValue,
  storyValueWeights,
  strongestStoryDimensions,
  structuralDurationSecV2,
  appealScore,
  confidenceMultiplier,
  historicalConfidenceOf,
  historicalStatusOf,
  rankScore,
  runtimeFit,
  runtimeTarget,
  selectionProblem,
  structuralDurationSec,
  type StoryEvidenceClaim,
} from './story.ts';

const all = (n: number) => Object.fromEntries(STORY_SCORE_KEYS.map((k) => [k, n])) as Record<(typeof STORY_SCORE_KEYS)[number], number>;
const claim = (verdict: StoryEvidenceClaim['verdict'], confidence: StoryEvidenceClaim['confidence'], sourceIds: string[] = ['s1', 's2', 's3']): StoryEvidenceClaim => ({
  key: 'C',
  verdict,
  confidence,
  sourceIds,
});

describe('story ranking', () => {
  it('weights the appeal components to a 0–10 score', () => {
    expect(Object.values(STORY_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(appealScore(all(10))).toBe(10);
    expect(appealScore(all(0))).toBe(0);
    expect(appealScore({ ...all(5), intrigue: 10 })).toBe(6); // intrigue weighs 0.2
  });

  it('discounts appeal by weak evidence, from ×0.55 to ×1', () => {
    expect(confidenceMultiplier(0)).toBeCloseTo(0.55);
    expect(confidenceMultiplier(10)).toBe(1);
    expect(confidenceMultiplier(42)).toBe(1); // clamped
    expect(rankScore(8, 10)).toBe(8);
  });

  it('does not let a sensational, poorly supported story beat a fascinating, well-supported one', () => {
    const sensational = rankScore(9.5, 3);
    const solid = rankScore(8, 9);
    expect(solid).toBeGreaterThan(sensational);
  });
});

describe('historical status and confidence', () => {
  it('takes the status from the weakest kind of claim', () => {
    expect(historicalStatusOf(['ESTABLISHED', 'ESTABLISHED'])).toBe('ESTABLISHED');
    expect(historicalStatusOf(['ESTABLISHED', 'PROBABLE'])).toBe('PROBABLE');
    expect(historicalStatusOf(['ESTABLISHED', 'UNVERIFIED'])).toBe('UNCERTAIN');
    expect(historicalStatusOf(['UNVERIFIED', 'DISPUTED'])).toBe('CONTESTED');
    expect(historicalStatusOf(['DISPUTED', 'MYTH', 'ESTABLISHED'])).toBe('MYTH_INVESTIGATION');
    expect(historicalStatusOf([])).toBe('UNCERTAIN');
  });

  it('scores confidence from verdicts, claim confidence and source breadth', () => {
    expect(historicalConfidenceOf([claim('ESTABLISHED', 'HIGH'), claim('ESTABLISHED', 'HIGH')])).toBe(10);
    expect(historicalConfidenceOf([])).toBe(0);
    // One weak claim drags the whole story down.
    const mixed = historicalConfidenceOf([claim('ESTABLISHED', 'HIGH'), claim('ESTABLISHED', 'HIGH'), claim('UNVERIFIED', 'LOW')]);
    expect(mixed).toBeLessThan(7);
    expect(mixed).toBeGreaterThan(2);
    // A myth whose falsity is well established is solid ground for a myth investigation.
    expect(historicalConfidenceOf([claim('MYTH', 'HIGH')])).toBe(8);
    // Fewer sources, less confidence.
    expect(historicalConfidenceOf([claim('ESTABLISHED', 'HIGH', ['s1'])])).toBe(9);
    expect(historicalConfidenceOf([claim('ESTABLISHED', 'HIGH', [])])).toBe(6);
    expect(historicalConfidenceOf([claim('DISPUTED', 'MEDIUM')])).toBe(3);
  });
});

describe('selection and runtime', () => {
  it('asks for 5–10 selected units', () => {
    expect(selectionProblem(4)).toMatch(/at least 5/);
    expect(selectionProblem(5)).toBeNull();
    expect(selectionProblem(10)).toBeNull();
    expect(selectionProblem(11)).toMatch(/at most 10/);
  });

  it('targets the middle of the project range and tolerates 20% outside it', () => {
    const t = runtimeTarget({ targetMinutesMin: 10, targetMinutesMax: 15 });
    expect(t).toEqual({ minSec: 600, maxSec: 900, targetSec: 750 });
    expect(runtimeFit(750, t)).toBe('WITHIN');
    expect(runtimeFit(520, t)).toBe('NEAR');
    expect(runtimeFit(1050, t)).toBe('NEAR');
    expect(runtimeFit(300, t)).toBe('OFF');
    expect(runtimeFit(1200, t)).toBe('OFF');
  });

  it('estimates a sequence from its structure', () => {
    expect(structuralDurationSec({ keyEvents: [1, 2, 3], caveats: [1], reveal: 'twist' })).toBe(20 + 90 + 15 + 12 + 10);
    expect(structuralDurationSec({ keyEvents: [], caveats: [], reveal: ' ' })).toBe(30);
  });
});

describe('Story Engine 2.0 scoring', () => {
  const story = (n: number, over: Partial<Record<StoryValueKey, number>> = {}) => ({ ...(Object.fromEntries(STORY_VALUE_KEYS.map((k) => [k, n])) as Record<StoryValueKey, number>), ...over });

  it('weights story value and historical value to 0–10, each summing to 1', () => {
    expect(Object.values(STORY_VALUE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(Object.values(HISTORICAL_VALUE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(storyValue(story(10), true)).toBe(10);
    expect(storyValue(story(0), true)).toBe(0);
    expect(historicalValue({ evidenceQuality: 10, significance: 10, relevance: 10, uniqueness: 10 })).toBe(10);
    expect(historicalValue({ evidenceQuality: 10, significance: 0, relevance: 0, uniqueness: 0 })).toBe(4);
  });

  it('gives myth/investigation potential no weight when the unit has no uncertain or myth material', () => {
    const s = story(6, { mythInvestigation: 10 });
    expect(storyValue(s, true)).toBeGreaterThan(storyValue(s, false));
    expect(storyValue(s, false)).toBe(6);
    expect(Object.values(storyValueWeights(false)).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(storyValueWeights(false).mythInvestigation).toBe(0);
  });

  it('ranks narrative potential separately from historical confidence', () => {
    // An important, well-evidenced event with little story against a smaller event with enormous narrative potential.
    const important = storyAppeal(storyValue(story(3), false), historicalValue({ evidenceQuality: 10, significance: 9, relevance: 9, uniqueness: 6 }));
    const gripping = storyAppeal(storyValue(story(9), false), historicalValue({ evidenceQuality: 6, significance: 5, relevance: 7, uniqueness: 7 }));
    expect(gripping).toBeGreaterThan(important);
    // Historical value still moderates: equal story value, better evidence wins.
    expect(storyAppeal(8, 9)).toBeGreaterThan(storyAppeal(8, 3));
    // A sensational but poorly evidenced story does not beat a strong, well-evidenced one.
    expect(storyAppeal(9, 2)).toBeLessThan(storyAppeal(8, 8));
    expect(storyAppeal(10, 0)).toBe(6);
    expect(storyAppeal(10, 10)).toBe(10);
  });

  it('explains a score by its strongest weighted dimensions', () => {
    const top = strongestStoryDimensions(story(4, { humanStakes: 9, mystery: 8, visualPotential: 8 }), false);
    expect(top.map((d) => d.dimension)).toEqual(['humanStakes', 'mystery', 'visualPotential']);
    expect(top[0]!.contribution).toBeCloseTo(9 * storyValueWeights(false).humanStakes, 1);
  });

  it('maps every verdict but ESTABLISHED to a required presentation, and recognises hedge wording', () => {
    expect(PRESENTATION_FOR_VERDICT).toEqual({ ESTABLISHED: 'STATE', PROBABLE: 'HEDGE', DISPUTED: 'PRESENT_AS_DISPUTED', UNVERIFIED: 'PRESENT_AS_UNCONFIRMED', MYTH: 'INVESTIGATE_AS_MYTH' });
    expect(PRESENTATION_VERDICTS).toEqual(['PROBABLE', 'DISPUTED', 'UNVERIFIED', 'MYTH']);
    for (const ok of ['Records suggest he refused to pay', 'Contemporary accounts indicate a crowd', 'He probably sold it', 'reportedly 40 bulbs', 'He refused, it seems, to pay', 'It appears the sale fell through']) expect(HEDGE_PATTERN.test(ok)).toBe(true);
    for (const bad of ['State it as fact', 'He sold it', 'This claim is probable']) expect(HEDGE_PATTERN.test(bad)).toBe(false);
  });

  it('measures reconstruction and fiction against the 40% / 25% budget', () => {
    const shares = informationShares(['DOCUMENTED', 'DOCUMENTED', 'RECONSTRUCTION', 'FICTION', 'UNCERTAIN']);
    expect(shares).toEqual({ DOCUMENTED: 0.4, RECONSTRUCTION: 0.2, UNCERTAIN: 0.2, FICTION: 0.2 });
    expect(reconstructionLevelOf(shares)).toBe('MEDIUM');
    expect(reconstructionLevelOf(informationShares(['DOCUMENTED', 'UNCERTAIN']))).toBe('NONE');
    expect(reconstructionLevelOf(informationShares(['DOCUMENTED', 'DOCUMENTED', 'DOCUMENTED', 'DOCUMENTED', 'DOCUMENTED', 'DOCUMENTED', 'RECONSTRUCTION']))).toBe('LOW');
    expect(reconstructionLevelOf(informationShares(['FICTION', 'RECONSTRUCTION', 'DOCUMENTED']))).toBe('HIGH');
    expect(RECONSTRUCTION_BUDGET).toEqual({ creative: 0.4, fiction: 0.25 });
    expect(FICTIONAL_CAST_LIMITS).toEqual({ pov: 1, composites: 2 });
  });

  it('estimates a v2 sequence from its beats and presentation instructions', () => {
    expect(structuralDurationSecV2({ beats: [{ function: 'COLD_OPEN' }, { function: 'ESCALATION' }, { function: 'REVEAL' }, { function: 'TRANSITION' }], presentation: [{}] })).toBe(20 + 20 + 20 + 8 + 8);
  });

  it('ranks short opportunities by short-form potential', () => {
    expect(Object.values(OPPORTUNITY_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(shortPotential({ hook: 10, payoff: 10, standalone: 10, visual: 10, emotion: 10, pace: 10 })).toBe(10);
    expect(shortPotential({ hook: 9, payoff: 8, standalone: 8, visual: 5, emotion: 5, pace: 6 })).toBeGreaterThan(shortPotential({ hook: 5, payoff: 6, standalone: 9, visual: 9, emotion: 9, pace: 9 }) - 1);
    expect(CONTENT_LIMITS.short).toEqual({ minSec: 15, maxSec: 180, defaultSec: 60 });
  });

  it('reads engine-1 records through the same contracts as engine-2 ones', () => {
    const v1Scores = { intrigue: 7, humanDrama: 6, stakes: 7, surprise: 5, escalation: 6, visualPotential: 7, financialStakes: 8, emotionalWeight: 5, appeal: 6.6, rationale: 'r' };
    const parsedV1 = AnyStoryScores.parse(v1Scores);
    expect('version' in parsedV1).toBe(false);
    expect(parsedV1).toMatchObject({ intrigue: 7, appeal: 6.6 });

    const v1 = {
      premise: 'p',
      centralQuestion: 'q?',
      narrativeSpine: 's',
      resolution: 'r',
      sequences: [{ number: 1, title: 't', purpose: '', candidateIds: [], candidateKeys: ['S01'], openingHook: '', narrativeQuestion: '', keyEvents: [], characters: [], conflict: '', escalation: '', reveal: '', endingBeat: '', claimKeys: ['C001'], sourceIds: [], caveats: [], historicalStatus: 'ESTABLISHED', historicalConfidence: 9, estimatedDurationSec: 120 }],
      unusedCandidates: [],
    };
    const content = AnyStoryArchitectureContent.parse(v1);
    expect(isArchitectureV2(content)).toBe(false);
    // Engine-1 pack content has no SE2 selection fields: defaults fill them.
    expect(StoryPackContent.parse({ selection: { candidateKeys: ['S01'], workingPremise: 'w', rationale: 'r', alternates: [] }, removed: [], carriedOver: [], editorNotes: null }).selection).toMatchObject({ centralQuestion: '', narrativeMode: null, povStrategy: null });
  });
});
