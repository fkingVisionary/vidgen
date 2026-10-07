import { describe, expect, it } from 'vitest';
import { DEFAULT_STORYBOARD_CONFIG, parseStoryboardModels, stepKind, storyboardSteps } from './config.ts';
import { PROMPT_VERSION, beatsSystemPrompt, repairSystemPrompt, shotsSystemPrompt } from './prompts.ts';
import { profileSnapshot } from './testing.ts';

/**
 * The storyboard job's settings and prompts: the steps a checkpoint keeps,
 * in order; per-step models; the planning ceiling; and what every system
 * prompt says (treatment before provider, cut points not times, the class
 * matrix and the hard rules, the profile's look and rhythm).
 */

describe('storyboard settings', () => {
  it('declares every step a job can save, in order: the beats call (or one per section), a shots call per section, the repair', () => {
    expect(storyboardSteps([1, 2], false)).toEqual(['beats', 'shots.1', 'shots.2', 'repair']);
    expect(storyboardSteps([1, 2, 3], true)).toEqual(['beats.1', 'beats.2', 'beats.3', 'shots.1', 'shots.2', 'shots.3', 'repair']);
    expect(['beats', 'beats.2', 'shots.4', 'repair'].map(stepKind)).toEqual(['beats', 'beats', 'shots', 'repair']);
  });

  it('reads per-step models and refuses an unknown step', () => {
    expect(parseStoryboardModels(undefined)).toEqual({});
    expect(parseStoryboardModels(' shots = model-a , repair=model-b ')).toEqual({ shots: 'model-a', repair: 'model-b' });
    expect(() => parseStoryboardModels('render=model-a')).toThrow(/STORYBOARD_MODELS: "render=model-a" is not step=model \(steps: beats, shots, repair\)/);
    expect(() => parseStoryboardModels('shots')).toThrow(/STORYBOARD_MODELS/);
  });

  it('caps a job\'s planning spend at $5 by default and names no model', () => {
    expect(DEFAULT_STORYBOARD_CONFIG.maxCostUsd).toBe(5);
    expect(DEFAULT_STORYBOARD_CONFIG.models).toEqual({});
  });
});

describe('storyboard prompts', () => {
  const profile = profileSnapshot({ density: 'SPARSE', generation: { maxGeneratedVideoShare: 0.4, preferStillMotion: true, rerolls: {} } }).effective;

  it('ask for treatments, never a vendor, a prompt, a time or a price, and cut only at listed cut points', () => {
    for (const system of [beatsSystemPrompt(profile), shotsSystemPrompt(profile), repairSystemPrompt(profile)]) {
      expect(system).toMatch(/Never name a vendor, a model, a product or a tool, and never write a generation prompt/);
      expect(system).toMatch(/Never output times, durations or prices/);
      expect(system).toMatch(/Cut only at the cut points listed in the brief/);
      expect(system).toMatch(/Rhythm \(sparse\): an average shot of 6–12 s, at most 9 cuts a minute/);
      expect(system).toMatch(/generated video on at most about 40% of the runtime; prefer an animated still/);
    }
    expect(PROMPT_VERSION).toMatch(/^storyboard-\d+\.\d+-\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('give the shots and repair calls the class matrix and the hard rules, the beats call every treatment and approach', () => {
    const beats = beatsSystemPrompt(profile);
    expect(beats).toMatch(/- CINEMATIC_RECONSTRUCTION: A generated moving scene/);
    expect(beats).toMatch(/A: Heavy reconstruction/);
    expect(beats).toMatch(/- ARCHIVAL_IMAGE: DOCUMENTED only if a sourced record, never generated; .*FICTION ✗/);
    for (const system of [shotsSystemPrompt(profile), repairSystemPrompt(profile)]) {
      expect(system).toMatch(/No generated records/);
      expect(system).toMatch(/A real person is never given a generated face/);
      expect(system).toMatch(/A narrator-led hedge alone is never enough when the picture shows the disputed act/);
      expect(system).toMatch(/- SOURCE_SHOWN: The record itself is shown/);
    }
  });
});
