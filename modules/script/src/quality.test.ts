import { scriptTiming, type ScriptContent } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { allBlocks } from './draft.ts';
import { NARRATION_CHECKLIST, REFINEMENT_CHECKLIST } from './prompts.ts';
import { computeScriptReport } from './quality.ts';
import { fixtureDraft } from './testing.ts';

/**
 * The judgments of the quality report name the checklist the script editor
 * answered. That is read from the answers themselves: a restored copy keeps
 * the answers of the version it copies, but not that version's origin or the
 * record of its narration pass.
 */

const target = { minSec: 40, maxSec: 80, targetSec: 60 };
const answers = (questions: readonly string[]) => questions.map((question) => ({ question, answer: 'YES' as const, comparedToPrevious: 'BETTER' as const, note: 'Fine (test).' }));
const provenance = (origin: ScriptContent['provenance']['origin']): ScriptContent['provenance'] => ({ origin, baseVersion: 4, baseId: 'base', sections: [], brief: null, requestedBy: null, changeLog: null });

function checklistLabel(questions: readonly string[], origin: ScriptContent['provenance']['origin']) {
  const d = fixtureDraft();
  const report = computeScriptReport({
    findings: [],
    timing: scriptTiming(allBlocks(d), target),
    content: { editor: { verdict: 'Fine (test).', scores: {}, issues: [], assessment: answers(questions) }, factCheck: null, provenance: provenance(origin) },
    notes: [],
  });
  return report.judgments?.find((j) => j.id === 'checklist')?.label;
}

describe('the checklist judgment', () => {
  it('names the narration checklist on the version a narration pass made, and the refinement checklist on a refinement', () => {
    expect(checklistLabel(NARRATION_CHECKLIST, 'NARRATION')).toMatch(/^Narration checklist/);
    expect(checklistLabel(REFINEMENT_CHECKLIST, 'REFINEMENT')).toBe('Refinement checklist');
  });

  it('keeps the name on a restored copy, which has neither the origin nor the narration record', () => {
    expect(checklistLabel(NARRATION_CHECKLIST, 'RESTORE')).toMatch(/^Narration checklist/);
    expect(checklistLabel(REFINEMENT_CHECKLIST, 'RESTORE')).toBe('Refinement checklist');
  });

  it('reads a partial answer sheet too (the questions both checklists share decide nothing)', () => {
    expect(checklistLabel(NARRATION_CHECKLIST.slice(0, 3), 'RESTORE')).toMatch(/^Narration checklist/);
    const shared = NARRATION_CHECKLIST.filter((q) => (REFINEMENT_CHECKLIST as readonly string[]).includes(q));
    expect(shared.length).toBeGreaterThan(0);
    expect(checklistLabel([...REFINEMENT_CHECKLIST.slice(0, 2), ...shared], 'RESTORE')).toBe('Refinement checklist');
  });
});
