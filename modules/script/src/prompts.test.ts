import { describe, expect, it } from 'vitest';
import { REFINEMENT_CHECKLIST, factCheckSystemPrompt, performanceSystemPrompt, plannerSystemPrompt, refineSystemPrompt, rewriteSystemPrompt, scriptEditorSystemPrompt, writerSystemPrompt } from './prompts.ts';

/**
 * Production prompts are generic: they shape every documentary, so no fact,
 * name, place, number or term of any particular one may appear in them
 * (the test documentary's included).
 */
const target = { minSec: 600, maxSec: 900, targetSec: 750 };
const prompts = {
  planner: plannerSystemPrompt(target),
  writer: writerSystemPrompt(target),
  rewrite: rewriteSystemPrompt(target),
  refine: refineSystemPrompt(target),
  editor: scriptEditorSystemPrompt(),
  factCheck: factCheckSystemPrompt(),
  performance: performanceSystemPrompt(),
};
const TOPIC = /tulip|bulb|guilder|stuiver|florist|haarlem|amsterdam|alkmaar|holland|dutch|semper|augustus|mackay|switser|thijs|pamphlet|1636|1637/i;

describe('script prompts', () => {
  it('carry no facts of any particular documentary', () => {
    for (const [name, text] of Object.entries(prompts)) expect([name, TOPIC.exec(text)?.[0] ?? null]).toEqual([name, null]);
    expect(REFINEMENT_CHECKLIST.join(' ')).not.toMatch(TOPIC);
  });

  it('ask a refinement to change the telling only, within the same bounds as the draft', () => {
    const r = prompts.refine;
    for (const rule of ['Meta-narration', 'Protect what is strong', 'keptLines', 'No purple prose', 'Trust the viewer', 'Legend as discovery', 'Cut only what is weak', 'No new facts, no new claims, no new people', 'Every block keeps its information class', 'never inside a documented event', 'is a planning midpoint, not a target. Never pad.'])
      expect(r).toContain(rule);
    expect(r).toContain('The acceptable range is 10:00–15:00');
    // The hard rules are the draft's own.
    expect(r).toContain('THE EVIDENCE BOUNDARY');
    expect(r).toContain('INFORMATION CLASSES');
    expect(r).toContain('REAL PEOPLE');
    expect(prompts.editor).toContain('REFINEMENT CHECKLIST');
    expect(prompts.performance).toContain('it never makes up for it');
  });

  it('give the script editor thirteen yes-is-good questions', () => {
    expect(REFINEMENT_CHECKLIST).toHaveLength(13);
    expect(REFINEMENT_CHECKLIST.every((q) => q.endsWith('?'))).toBe(true);
    expect(REFINEMENT_CHECKLIST).toContain('Is it free of unnecessary explanations?');
  });
});
