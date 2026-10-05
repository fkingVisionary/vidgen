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

  it('make the house style the refinement default, complete without any director instructions, ranked under the evidence rules', () => {
    const r = prompts.refine;
    // The system prompt depends only on the runtime target: there is no slot for the director here.
    expect(refineSystemPrompt(target)).toBe(r);
    expect(r).not.toMatch(/director's instructions:|brief:/i);
    expect(r).toContain('These instructions are complete. They are the house style of every refinement and apply in full whether or not the director adds instructions of their own.');
    const ranks = ['1. Evidence and safety (part 1) — non-overridable, by anyone.', '2. The refinement style (part 2) — the defaults of every refinement.', "3. The approved architecture and the script's own constraints (part 3)", '4. What the script editor, the fact checker and the automated checks said', "5. The director's instructions (last in the prompt, if any)"];
    for (const rank of ranks) expect(r).toContain(rank);
    expect(ranks.map((x) => r.indexOf(x))).toEqual([...ranks.map((x) => r.indexOf(x))].sort((a, b) => a - b));
    expect(r).toContain('They never override factual integrity, the architecture, the information classes, the integrity of quotations or the boundaries of fictional characters (1 and 3).');
    // The parts appear in rank order, and part 1 is the draft's own evidence rules.
    const parts = ['PART 1 — EVIDENCE AND SAFETY (non-overridable)', 'PART 2 — THE REFINEMENT STYLE (the defaults)', 'PART 3 — THE STORY IS DECIDED'];
    expect(parts.map((x) => r.indexOf(x)).every((i, n, all) => i > 0 && (n === 0 || i > all[n - 1]!))).toBe(true);
    expect(r.indexOf('THE EVIDENCE BOUNDARY')).toBeGreaterThan(r.indexOf(parts[0]!));
    expect(r.indexOf('THE EVIDENCE BOUNDARY')).toBeLessThan(r.indexOf(parts[1]!));
    for (const rule of ['Earn the turning point', 'Slightly over the range is acceptable only when what remains is strong.', "including any director's instruction you could not follow, and why"]) expect(r).toContain(rule);
  });

  it('ask a refinement to change the telling only, within the same bounds as the draft', () => {
    const r = prompts.refine;
    for (const rule of ['Meta-narration', 'Protect what is strong', 'keptLines', 'No purple prose', 'Trust the viewer', 'Legend as discovery', 'Cut only what is weak', 'No new facts, no new claims, no new people', 'Every block keeps its information class', 'never inside a documented event', 'is a planning midpoint, not a target. Never pad, and never cut fascinating, useful material just to approach a number.'])
      expect(r).toContain(rule);
    expect(r).toContain('The acceptable range is 10:00–15:00');
    // The hard rules are the draft's own.
    expect(r).toContain('THE EVIDENCE BOUNDARY');
    expect(r).toContain('INFORMATION CLASSES');
    expect(r).toContain('REAL PEOPLE');
    expect(prompts.editor).toContain('REFINEMENT CHECKLIST');
    expect(prompts.performance).toContain('it never makes up for it');
  });

  it('teach the story economy the checks enforce — to the writer, a rewrite, the refinement and the script editor', () => {
    const rules = ['STORY ECONOMY', 'Say it once.', 'is a passenger candidate', 'a minor-looking fact a later section relies on is not disposable', 'Introduce a real person by what they do', 'At most one line about the film itself', 'rests on a claim about them', 'Speech, not page', 'Repeat with a purpose, never without', 'A repeated hedge ("historians disagree"), a recurring name or a recurring term is not a callback'];
    for (const name of ['writer', 'rewrite', 'refine', 'editor'] as const) for (const rule of rules) expect([name, rule, prompts[name].includes(rule)]).toEqual([name, rule, true]);
    // Runtime: the weak material goes first, nothing protected goes, and nobody estimates length — it is measured.
    expect(prompts.refine).toContain('Make those cuts first: they cost the story nothing');
    expect(prompts.refine).toContain('Never cut what the plan protects.');
    expect(prompts.refine).toContain('Do not state the word count or the runtime in the changeLog: the system measures them.');
    expect(prompts.writer).toContain('Do not state the word count or the runtime: the system measures them.');
    expect(prompts.editor).toContain('WHEN IT RUNS LONG — only when the prompt gives a cut plan');
    expect(prompts.factCheck).toContain('Start with what the automated rules flag about evidence: PERSON_WITHOUT_EVIDENCE');
    expect(prompts.performance).toContain('Pauses and slower delivery cost time, and the prompt gives your budget');
    expect(prompts.performance).toContain('Never speed delivery up to make room.');
  });

  it('hold every reviewer change to the invariants, one change at a time, evidence before prose', () => {
    for (const name of ['editor', 'factCheck'] as const) {
      expect(prompts[name]).toContain('THE INVARIANTS — no change may weaken them, however much better it reads');
      expect(prompts[name]).toContain('Prefer slightly weaker prose with correct evidence over better prose that blurs the evidence.');
      expect(prompts[name]).toContain('Every change carries its reason, in one sentence.');
      expect(prompts[name]).toContain('Each change is judged on its own');
    }
    expect(prompts.factCheck).toContain('do not undo an accepted change unless it broke the evidence');
    expect(prompts.refine).toContain('Prefer slightly weaker prose with correct evidence over better prose that blurs the evidence.');
    for (const name of ['writer', 'refine', 'editor', 'factCheck'] as const) {
      expect(prompts[name]).toContain('Probability words ("probably", "most likely", "what probably happened") belong to PROBABLE claims only');
      expect(prompts[name]).toContain('what a real person did, said or owned rests on a claim about them that the block cites');
    }
  });

  it('give the script editor thirteen yes-is-good questions', () => {
    expect(REFINEMENT_CHECKLIST).toHaveLength(13);
    expect(REFINEMENT_CHECKLIST.every((q) => q.endsWith('?'))).toBe(true);
    expect(REFINEMENT_CHECKLIST).toContain('Is it free of unnecessary explanations?');
  });
});
