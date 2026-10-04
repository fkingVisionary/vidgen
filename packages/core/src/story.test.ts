import { describe, expect, it } from 'vitest';
import { STORY_SCORE_KEYS } from './contracts/story.ts';
import {
  STORY_SCORE_WEIGHTS,
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
