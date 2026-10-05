import type { RuntimeTarget } from '@docengine/core';
import { EvidenceBase } from '@docengine/story/shared';
import { fakeEvidenceInput } from '@docengine/story/testing';
import type { BlockNeed, Corpus } from '@docengine/writing';
import { describe, expect, it } from 'vitest';
import { allBlocks, derive, type DraftBlock, type ScriptDraft } from './draft.ts';
import { calendarWords, composeLineage, moneyUsed, moveToVisual, narrationBase, narrationGuard, planNarration, renderNarrationContext, toNarrationPatch, uncertaintyOf, type NarrationPlan } from './narration.ts';
import { renderScript } from './render.ts';
import { reviewPatch } from './review.ts';
import { checkScript } from './rules.ts';
import type { NarrationOutput } from './schemas.ts';
import { buildScope, type ScriptScope } from './scope.ts';
import type { LoadedScript } from './store.ts';
import { fakeNarration, fixtureArchitecture, fixtureDraft, fixtureScope } from './testing.ts';

/**
 * The Human Narration Pass, the script's side: what it is asked to fix (the
 * blocks the diagnostics flag; every other block is settled), and the guard
 * that judges each of its edits on top of the evidence rules — every figure,
 * name, hedge and line to keep stays; money context only from the evidence;
 * no new machine habit; a polish, not a rewrite. Run on the fixture film with
 * habits injected, through the real review (no part of it is mocked).
 */

const TARGET: RuntimeTarget = { minSec: 10, maxSec: 400, targetSec: 200 };
const ALL = new Set([1, 2, 3]);
/** A corpus with no examples: the guard does not depend on the corpus files. */
const CORPUS: Corpus = { version: 'test', manifest: { version: '1.0.0', updated: 'x', changes: [] }, examples: [], errors: [] };

/** The draft with some blocks reworded (and any other fields changed), derived again like a saved block. */
function reword(scope: ScriptScope, draft: ScriptDraft, texts: Record<string, string>, extra: Record<string, Partial<DraftBlock>> = {}): ScriptDraft {
  return {
    ...draft,
    sections: draft.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map((b) => {
        const text = texts[b.key];
        return text === undefined && !extra[b.key] ? b : derive({ ...b, ...(text === undefined ? {} : { text, generatedText: text }), ...extra[b.key] }, scope);
      }),
    })),
  };
}

const planFor = (scope: ScriptScope, draft: ScriptDraft, opts: { kept?: string[]; allowed?: ReadonlySet<number>; handled?: ReadonlySet<string> } = {}) =>
  planNarration(draft, scope, { kept: opts.kept ?? [], corpus: CORPUS, allowed: opts.allowed ?? ALL, findings: checkScript(draft, scope, { target: TARGET, previous: null }), handled: opts.handled });

interface Edit {
  ref: string;
  text: string;
  moneyContext?: string[];
  visualNote?: string | null;
}

const output = (edits: readonly Edit[]): NarrationOutput => ({
  verdict: 'Plain where it was theatrical (test).',
  edits: edits.map((e) => ({ ref: e.ref, text: e.text, reason: 'Plainer (test).', fixes: ['AI_PATTERN'], moneyContext: e.moneyContext ?? [], visualNote: e.visualNote ?? null })),
  kept: [],
});

/** One narration pass as the stage runs it: the plan, the pass's edits as a patch, each judged with the guard. */
function narrate(scope: ScriptScope, draft: ScriptDraft, edits: readonly Edit[], opts: { kept?: string[]; plan?: NarrationPlan } = {}) {
  const kept = opts.kept ?? [];
  const plan = opts.plan ?? planFor(scope, draft, { kept });
  const out = output(edits);
  const outcome = reviewPatch(draft, toNarrationPatch(out, draft, plan), 'NARRATION', { scope, target: TARGET, allowed: ALL, base: null, kept, guard: narrationGuard(plan, out, scope) });
  return { plan, out, outcome };
}

const blockAt = (draft: ScriptDraft, key: string) => allBlocks(draft).find((b) => b.key === key)!;
/** A block without the identity the review gives it while it judges (never saved). */
const content = (b: DraftBlock) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'uid'));

// ── The fixture film, with machine habits in three blocks ────────────────────

const scope = fixtureScope();
const PROEFMAN = 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.';
const COURTS = 'In April 1637 the courts sent the unsettled contracts back to the towns.';
const LEGEND = 'The legend says the trade ruined a nation. The archives tell another story.';

/** Fake dramatic beats in 2.1 and 2.2, a stock phrase in 3.1; 2.1 also has its own delivery and visual direction. */
const flagged = () =>
  reword(
    scope,
    fixtureDraft(scope),
    {
      '2.1': `${PROEFMAN} And then, everything changed.`,
      '2.2': `${COURTS} That was only the beginning.`,
      '3.1': `${LEGEND} But then the stage was set.`,
    },
    {
      '2.1': {
        delivery: { pace: 'SLOW', energy: 'LOW', emotion: 'SOMBER', emphasis: [{ text: '1,200 guilders', level: 'STRONG' }], pauseBefore: { length: 'SHORT', reason: 'TRANSITION' }, pauseAfter: { length: 'MEDIUM', reason: 'NUMBER' } },
        visual: { intent: 'DOCUMENT', mustShow: [{ detail: 'the court record of the case', claimKeys: ['C008'] }], mustAvoid: ['modern clothing'], priority: 'HIGH', fictional: false, note: 'A ledger page, close.' },
      },
    },
  );

/** Judge a single edit of the narration pass on the flagged fixture. */
const judge = (ref: string, text: string, opts: { kept?: string[]; moneyContext?: string[]; draft?: ScriptDraft } = {}) => {
  const r = narrate(scope, opts.draft ?? flagged(), [{ ref, text, moneyContext: opts.moneyContext }], { kept: opts.kept });
  expect(r.outcome.changes).toHaveLength(1);
  return { ...r, change: r.outcome.changes[0]! };
};

describe('the narration plan', () => {
  it('flags only the blocks with a machine habit; the clean fixture needs nothing', () => {
    expect(planFor(scope, fixtureDraft(scope)).needs.size).toBe(0);
    const plan = planFor(scope, flagged());
    expect([...plan.needs.values()].map((n) => `${n.ref}: ${n.patterns.join(', ')}`)).toEqual(['2.1: dramatic_transition', '2.2: dramatic_transition', '3.1: stock_phrase, dramatic_transition']);
    expect(plan.needs.get('2.1')!.excerpts).toEqual(['And then, everything changed.']);
    expect(plan.corpusVersion).toBe('test');
    expect(plan.retrieved).toEqual([]);
  });

  it('never flags a speaker\'s line, even one with a machine habit — it is the record\'s words, not the narrator\'s', () => {
    const draft = reword(scope, fixtureDraft(scope), { '1.5': '"And then, everything changed."' });
    expect(blockAt(draft, '1.5').speakerId).toBe('F1');
    expect(planFor(scope, draft).needs.has('1.5')).toBe(false);
  });

  it('offers only the sections the run may change', () => {
    expect([...planFor(scope, flagged(), { allowed: new Set([3]) }).needs.keys()]).toEqual(['3.1']);
  });

  it('does not raise a judgment call (a density pattern) again on a block already handled or holding a line to keep; a hard habit always comes back', () => {
    const draft = reword(scope, fixtureDraft(scope), {
      '1.3': 'The buyers sign contracts, not for flowers, but for bulbs that are still in the ground.',
      '2.2': `${COURTS} It was not a trade, but a promise.`,
      '3.1': `${LEGEND} But then the stage was set.`,
    });
    const all = planFor(scope, draft);
    expect([...all.needs.values()].map((n) => `${n.ref}: ${n.patterns.join(', ')}`)).toEqual(['1.3: contrast_formula', '2.2: contrast_formula', '3.1: stock_phrase, dramatic_transition']);
    // An earlier pass edited 2.2 and 3.1: its call on the contrast stands; the stock phrase is still wrong.
    expect([...planFor(scope, draft, { handled: new Set(['2.2', '3.1']) }).needs.keys()]).toEqual(['1.3', '3.1']);
    // A line kept on purpose settles the density pattern of its block.
    expect([...planFor(scope, draft, { kept: ['It was not a trade, but a promise.'] }).needs.keys()]).toEqual(['1.3', '3.1']);
  });

  it('shows the pass what needs work, the lines to keep, the money context and the names as the evidence spells them', () => {
    const plan = planFor(scope, flagged(), { kept: ['The archives tell another story.', 'Short.'] });
    const text = renderNarrationContext(plan);
    expect(text).toContain('# What the diagnostics found — 3 block(s) need work; every other block is settled (leave it exactly as it is)');
    expect(text).toContain('- 2.1 needs: dramatic_transition — "And then, everything changed."');
    // A one-word line is no line to keep.
    expect(plan.kept).toEqual(['The archives tell another story.']);
    expect(text).toContain('# Lines to keep word for word (1) — never edit them away\n- "The archives tell another story."');
    // The fixture cites no wage: there is no comparison to add, and the prompt says so.
    expect(text).toContain("- none: the cited evidence sets no sum beside a wage, an income, a household expense or an asset. Where a sum needs meaning, say so plainly (\"The surviving records don't give us a reliable equivalent.\")");
    expect(text).toContain('- Pieter (Pieter Graanhout) — a fictional device');
    expect(text).toContain('- Cornelis Proefman');
    expect(renderNarrationContext(planFor(scope, fixtureDraft(scope)))).toContain('- nothing: the narration needs no edit. Return no edits.');
  });
});

describe('the narration guard (each edit judged on its own)', () => {
  it('skips an edit to a settled block, however harmless, and says why', () => {
    const { outcome } = narrate(scope, flagged(), [
      { ref: '1.3', text: 'Buyers sign contracts for bulbs still in the ground.' },
      { ref: '2.1', text: PROEFMAN },
    ]);
    expect(outcome.changes.map((c) => `${c.id} ${c.ref} ${c.status}`)).toEqual(['N1 1.3 SKIPPED', 'N2 2.1 ACCEPTED']);
    expect(outcome.changes[0]!.rejectionReason).toMatch(/^Settled/);
    expect(outcome.changes[0]!.rejectionReason).toBe('Settled: the diagnostics found nothing to fix in this block — it stays as written');
    expect(outcome.changes[0]!.rulesImpacted).toEqual([]);
    expect(blockAt(outcome.draft, '1.3').text).toBe('The buyers sign contracts for bulbs that are still in the ground.');
  });

  it('keeps a safe edit that removes the habit, and changes nothing but the text', () => {
    const draft = flagged();
    const before = blockAt(draft, '2.1');
    const { outcome } = narrate(scope, draft, [{ ref: '2.1', text: PROEFMAN }]);
    const c = outcome.changes[0]!;
    expect(c).toMatchObject({ id: 'N1', reviewer: 'NARRATION', type: 'EDIT', status: 'ACCEPTED', savedRef: '2.1', rejectionReason: null, originalText: before.text, proposedText: PROEFMAN });
    expect(c.rulesImpacted).toContain('resolves AI_PATTERN');
    const after = blockAt(outcome.draft, '2.1');
    expect(after.text).toBe(PROEFMAN);
    // Code keeps everything else: claims, beats, class, speaker, visual direction, delivery, central question.
    for (const field of ['key', 'claimKeys', 'beatIds', 'infoClass', 'speakerId', 'speechKind', 'visual', 'delivery', 'centralQuestion', 'presentation', 'fictionalDevice'] as const) expect([field, after[field]]).toEqual([field, before[field]]);
    expect(after.delivery.emphasis).toEqual([{ text: '1,200 guilders', level: 'STRONG' }]);
    expect(after.visual.note).toBe('A ledger page, close.');
    // The rest of the script is untouched, and the block has no need left.
    expect(allBlocks(outcome.draft).filter((b) => b.key !== '2.1').map(content)).toEqual(allBlocks(draft).filter((b) => b.key !== '2.1').map(content));
    expect(planFor(scope, outcome.draft).needs.has('2.1')).toBe(false);
  });

  it('rejects an edit that drops a figure, or says it another way ("1,200" as "twelve hundred")', () => {
    const dropped = judge('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought.').change;
    expect(dropped).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_FIGURE_CHANGED'] });
    expect(dropped.rejectionReason).toBe('Violates factual meaning (every figure kept) — Block 2.1: the figure(s) 1200 are no longer said as before [NARRATION_FIGURE_CHANGED]');

    const spelled = judge('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for twelve hundred guilders.').change;
    expect(spelled).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_FIGURE_CHANGED'] });
    expect(spelled.rejectionReason).toContain('the figure(s) 1200 are no longer said as before');
    expect(spelled.rejectionReason).toContain('(and 1 more: NARRATION_FIGURE_CHANGED)');
  });

  it('rejects an edit that adds a figure the block did not say, or drops a date word', () => {
    const added = judge('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders, within two weeks.').change;
    expect(added.status).toBe('REJECTED');
    expect(added.rulesImpacted).toContain('NARRATION_FIGURE_CHANGED');
    expect(added.rejectionReason).toContain('adds the figure(s) 2, which the block did not say');

    const undated = judge('2.2', 'In 1637 the courts sent the unsettled contracts back to the towns.').change;
    expect(undated).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_FIGURE_CHANGED'] });
    expect(undated.rejectionReason).toContain('the date word(s) april are no longer said');
  });

  it('rejects a money comparison the evidence does not give — uncited, or citing an id it does not know', () => {
    const wage = judge('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders, as much as a craftsman earned in years.').change;
    expect(wage).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_MONEY_UNSOURCED'] });
    expect(wage.rejectionReason).toContain("adds a money comparison without citing the evidence's money context");
    expect(wage.rejectionReason).toContain("The surviving records don't give us a reliable equivalent.");

    // A comparison with no figure in it ("years' pay") is a comparison all the same.
    const years = judge('2.1', `${PROEFMAN} That was years' pay.`).change;
    expect(years).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_MONEY_UNSOURCED'] });

    const unknown = judge('2.1', PROEFMAN, { moneyContext: ['M9'] }).change;
    expect(unknown).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_MONEY_UNSOURCED'] });
    expect(unknown.rejectionReason).toContain('cites money context M9, which the evidence does not support');
  });

  it('rejects a respelt or westernised name', () => {
    const c = judge('2.1', 'Records suggest that Cornelius Proefman refused the bulbs he had bought, for 1,200 guilders.').change;
    expect(c.status).toBe('REJECTED');
    expect(c.rulesImpacted).toContain('NARRATION_NAME_CHANGED');
    expect(c.rejectionReason).toContain('"cornelis" became "cornelius" — a historical name keeps its spelling');
  });

  it('rejects an edit that drops a hedge — also one the evidence rules alone would let through', () => {
    // The PROBABLE claim's hedge: the evidence rules and the guard both object.
    const unhedged = judge('2.1', 'Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.').change;
    expect(unhedged.status).toBe('REJECTED');
    expect(unhedged.rulesImpacted).toEqual(expect.arrayContaining(['PROBABLE_UNHEDGED', 'NARRATION_HEDGE_DROPPED']));

    // A disputed figure that also said "it appears": still disputed for the rules, but a hedge of the original is gone.
    const draft = reword(scope, fixtureDraft(scope), { '3.2': 'Even the most famous price is disputed. It appears a single bulb was offered for 5,500 guilders. And then, everything changed.' });
    const softer = judge('3.2', 'Even the most famous price is disputed. A single bulb was offered for 5,500 guilders.', { draft }).change;
    expect(softer).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_HEDGE_DROPPED'] });
    expect(softer.rejectionReason).toContain('the hedge wording of the original is gone');
    // Keeping the hedge, the same cut is fine.
    expect(judge('3.2', 'Even the most famous price is disputed. It appears a single bulb was offered for 5,500 guilders.', { draft }).change.status).toBe('ACCEPTED');
  });

  it('rejects an edit that loses a line to keep', () => {
    const kept = ['The archives tell another story.'];
    const lost = judge('3.1', 'The legend says the trade ruined a nation. The records disagree.', { kept }).change;
    expect(lost).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_KEPT_LINE_LOST'] });
    expect(lost.rejectionReason).toContain('the line to keep "the archives tell another story." is gone');
    expect(judge('3.1', LEGEND, { kept }).change.status).toBe('ACCEPTED');
  });

  it('rejects an edit that trades one machine habit for another', () => {
    const c = judge('2.1', `Remarkably, ${PROEFMAN.charAt(0).toLowerCase()}${PROEFMAN.slice(1)}`).change;
    expect(c).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_PATTERN_ADDED'] });
    expect(c.rejectionReason).toContain('adds hype_adverb');
  });

  it('rejects a rewrite: a block grown far beyond a polish (cutting is always allowed)', () => {
    const grown = judge('2.1', `${PROEFMAN} He would not take them, he would not pay for them, and he would not hear another word about them from anyone, then or later, however often they asked.`).change;
    expect(grown).toMatchObject({ status: 'REJECTED', rulesImpacted: ['NARRATION_LENGTH_DRIFT'] });
    expect(grown.rejectionReason).toContain('grows from 19 to 44 words: a polish, not a rewrite');
    // A few words more is a polish.
    expect(judge('2.1', `${PROEFMAN} He would not pay.`).change.status).toBe('ACCEPTED');
  });

  it("never touches a speaker's line: settled for the pass, and refused by the guard should a plan ever list it", () => {
    const draft = flagged();
    const skipped = narrate(scope, draft, [{ ref: '1.5', text: '"Everyone here is buying paper."' }]).outcome.changes[0]!;
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.rejectionReason).toMatch(/^Settled/);

    const plan = planFor(scope, draft);
    const need: BlockNeed = { ref: '1.5', patterns: ['dramatic_transition'], money: [], excerpts: [] };
    const forced: NarrationPlan = { ...plan, needs: new Map([...plan.needs, ['1.5', need]]) };
    const { outcome } = narrate(scope, draft, [{ ref: '1.5', text: '"Everyone here is buying paper."' }], { plan: forced });
    expect(outcome.changes[0]!.status).toBe('REJECTED');
    expect(outcome.changes[0]!.rulesImpacted).toContain('NARRATION_QUOTE_TOUCHED');
    expect(outcome.changes[0]!.rejectionReason).toContain("a speaker's line is the record's words, not the narrator's");
    expect(blockAt(outcome.draft, '1.5').text).toBe('"Everyone here is buying paper, not flowers."');
  });

  it('keeps a quotation in the narration word for word', () => {
    const QUOTED = 'Records suggest the complaint was simple. "Cornelis Proefman refused to accept the bulbs he had bought for 1,200 guilders."';
    const draft = reword(scope, fixtureDraft(scope), { '2.1': `${QUOTED} And then, everything changed.` });
    expect(judge('2.1', QUOTED, { draft }).change.status).toBe('ACCEPTED');
    const { change: touched, outcome } = judge('2.1', 'Records suggest the complaint was simple. "Cornelis Proefman refused to take the bulbs he had bought for 1,200 guilders."', { draft });
    expect(touched.status).toBe('REJECTED');
    expect(touched.rulesImpacted).toEqual(expect.arrayContaining(['FABRICATED_QUOTE', 'NARRATION_QUOTE_TOUCHED']));
    // The guard on its own says which quotation.
    const plan = planFor(scope, draft);
    const before = blockAt(draft, '2.1');
    const after = derive({ ...before, text: touched.proposedText! }, scope);
    const found = narrationGuard(plan, output([]), scope)(before, after, { id: 'N1', reviewer: 'NARRATION', type: 'EDIT', ref: '2.1', reason: 'Plainer (test).' });
    expect(found).toEqual([{ kind: 'NARRATION_QUOTE_TOUCHED', ref: '2.1', detail: 'Block 2.1: the quotation "Cornelis Proefman refused to accept the bulbs he had bought " is no longer word for word' }]);
    expect(blockAt(outcome.draft, '2.1').text).toBe(`${QUOTED} And then, everything changed.`);
  });

  it('judges every edit of a pass separately: one bad edit never costs the good ones', () => {
    const { outcome } = narrate(scope, flagged(), [
      { ref: '2.1', text: 'Records suggest that Cornelius Proefman refused the bulbs he had bought, for 1,200 guilders.' },
      { ref: '2.2', text: COURTS },
      { ref: '3.1', text: LEGEND },
      { ref: '3.3', text: 'An 1841 book spread the story.' },
    ]);
    expect(outcome.changes.map((c) => `${c.ref} ${c.status}`)).toEqual(['2.1 REJECTED', '2.2 ACCEPTED', '3.1 ACCEPTED', '3.3 SKIPPED']);
    expect(allBlocks(outcome.draft).map((b) => b.text).slice(5, 8)).toEqual([`${PROEFMAN} And then, everything changed.`, COURTS, LEGEND]);
  });
});

// ── Money context: the fixture with a contemporary wage cited (C018) ─────────

/** The fixture architecture, with the craftsman's wage cited by the court beat: the evidence now gives the sums their meaning. */
function moneyScope(): ScriptScope {
  const architecture = fixtureArchitecture();
  const court = architecture.sequences[1]!;
  court.beats[0]!.claimKeys.push('C018');
  court.claimKeys.push('C018');
  return buildScope({ architectureId: 'arch-test', architectureVersion: 1, architecture, evidence: new EvidenceBase(fakeEvidenceInput()) });
}

describe('money context from the evidence', () => {
  const mscope = moneyScope();
  const FOUR_YEARS = `${PROEFMAN} That was about four years' pay for a skilled craftsman.`;

  it('offers the contexts the evidence supports, for the sums the narration says without one', () => {
    const plan = planFor(mscope, fixtureDraft(mscope));
    expect(plan.money.contexts.map((c) => `${c.id}: ${c.amountText} ${c.currency} — ${c.explanation} (${c.sourceClaimKeys.join(', ')}, ${c.verdict})`)).toEqual([
      "M1: 1,200 guilder — about four years' pay for a skilled craftsman (C008, C018, PROBABLE)",
      "M2: 5,500 guilder — more than eighteen years' pay for a skilled craftsman (C009, C018, DISPUTED)",
    ]);
    expect([...plan.needs.values()].map((n) => `${n.ref}: ${n.money.map((m) => m.id).join(', ')}`)).toEqual(['2.1: M1', '3.2: M2']);
    expect(renderNarrationContext(plan)).toContain('- 2.1 needs: money context (M1)');
  });

  it("turns a cited context into the claims it rests on — and only the edit's text and claims change", () => {
    const draft = fixtureDraft(mscope);
    const plan = planFor(mscope, draft);
    const patch = toNarrationPatch(output([{ ref: ' 2.1 ', text: FOUR_YEARS, moneyContext: ['M1'] }, { ref: '2.2', text: COURTS }, { ref: '3.2', text: 'x', moneyContext: ['M9'] }]), draft, plan);
    expect(patch.removals).toEqual([]);
    expect(patch.insertions).toEqual([]);
    expect(patch.edits.map((e) => ({ ref: e.ref, claimKeys: e.claimKeys, infoClass: e.infoClass, beatIds: e.beatIds }))).toEqual([
      { ref: '2.1', claimKeys: ['C008', 'C018'], infoClass: null, beatIds: null },
      { ref: '2.2', claimKeys: null, infoClass: null, beatIds: null },
      { ref: '3.2', claimKeys: null, infoClass: null, beatIds: null },
    ]);
  });

  it('keeps an edit whose comparison comes from the context it cites, and the block then cites that context\'s claims', () => {
    const draft = fixtureDraft(mscope);
    const before = blockAt(draft, '2.1');
    const { outcome, out, plan } = narrate(mscope, draft, [{ ref: '2.1', text: FOUR_YEARS, moneyContext: ['M1'] }]);
    const c = outcome.changes[0]!;
    expect(c.status).toBe('ACCEPTED');
    expect(c.rulesImpacted).toContain('resolves MONEY_WITHOUT_CONTEXT');
    const after = blockAt(outcome.draft, '2.1');
    expect(after.text).toBe(FOUR_YEARS);
    expect(after.claimKeys).toEqual(['C008', 'C018']);
    expect({ beatIds: after.beatIds, infoClass: after.infoClass, speakerId: after.speakerId }).toEqual({ beatIds: before.beatIds, infoClass: before.infoClass, speakerId: before.speakerId });
    expect(moneyUsed(out, outcome.changes, plan)).toEqual([{ contextId: 'M1', ref: '2.1' }]);
    // The sum now has its meaning: nothing left to do there.
    expect(planFor(mscope, outcome.draft).needs.has('2.1')).toBe(false);
  });

  it('rejects a comparison the cited context does not give, and a comparison with no context cited', () => {
    const draft = fixtureDraft(mscope);
    const five = narrate(mscope, draft, [{ ref: '2.1', text: `${PROEFMAN} That was about five years' pay for a skilled craftsman.`, moneyContext: ['M1'] }]).outcome.changes[0]!;
    expect(five.status).toBe('REJECTED');
    expect(five.rulesImpacted).toContain('NARRATION_MONEY_UNSOURCED');
    expect(five.rejectionReason).toContain('adds the figure(s) 5, which the money context it cites does not give');

    const uncited = narrate(mscope, draft, [{ ref: '2.1', text: FOUR_YEARS }]).outcome.changes[0]!;
    expect(uncited.status).toBe('REJECTED');
    expect(uncited.rulesImpacted).toContain('NARRATION_MONEY_UNSOURCED');
  });
});

// ── Idempotence: a second pass over the pass's own work finds nothing ────────

describe('the pass converges', () => {
  const mscope = moneyScope();
  /** The money fixture with a picture described (1.4) and a teasing closer (2.2); 3.2 hedges its figure the way the wage claim needs. */
  const rough = () =>
    reword(mscope, fixtureDraft(mscope), {
      '1.4': 'Pieter watches the bidding from the back of the room, counting what he has. He leans in. Candlelight flickers across his hands.',
      '2.2': `${COURTS} Everything was about to change.`,
      '3.2': 'Even the most famous price is disputed: it appears a single bulb was offered for 5,500 guilders.',
    });

  /** planNarration → the fake narration editor (reading the prompt as the stage renders it) → the guarded review → the picture notes moved. */
  function pass(draft: ScriptDraft) {
    const plan = planFor(mscope, draft);
    const prompt = `${renderNarrationContext(plan)}\n\n# The script — the narration to edit\n${renderScript(draft)}`;
    const out = fakeNarration(prompt);
    const r = reviewPatch(draft, toNarrationPatch(out, draft, plan), 'NARRATION', { scope: mscope, target: TARGET, allowed: ALL, base: null, guard: narrationGuard(plan, out, mscope) });
    const moved = moveToVisual(r.draft, out, r.changes, mscope);
    return { plan, prompt, out, changes: r.changes, draft: moved.draft, moved: moved.moved };
  }

  it('fixes what the diagnostics flag the first time, and finds nothing to do the second', () => {
    const first = pass(rough());
    expect([...first.plan.needs.keys()]).toEqual(['1.4', '2.2', '2.1', '3.2']);
    expect(first.changes.map((c) => `${c.ref} ${c.status}`)).toEqual(['1.4 ACCEPTED', '2.2 ACCEPTED', '2.1 ACCEPTED', '3.2 ACCEPTED']);
    const text = (key: string) => blockAt(first.draft, key).text;
    expect(text('1.4')).toBe('Pieter watches the bidding from the back of the room, counting what he has.');
    expect(text('2.2')).toBe(COURTS);
    expect(text('2.1')).toBe(`${PROEFMAN} That was about four years' pay for a skilled craftsman.`);
    expect(text('3.2')).toBe("Even the most famous price is disputed: it appears a single bulb was offered for 5,500 guilders. That was more than eighteen years' pay for a skilled craftsman.");
    // The picture description left the narration for the visual direction.
    expect(first.moved).toEqual([{ ref: '1.4', note: 'He leans in. Candlelight flickers across his hands.' }]);
    expect(blockAt(first.draft, '1.4').visual.note).toBe('He leans in. Candlelight flickers across his hands.');

    const second = pass(first.draft);
    expect(second.plan.needs.size).toBe(0);
    expect(second.prompt).toContain('- nothing: the narration needs no edit. Return no edits.');
    expect(second.out.edits).toEqual([]);
    expect(second.changes.filter((c) => c.status === 'ACCEPTED')).toEqual([]);
    expect(second.draft).toEqual(first.draft);
  });
});

// ── A narration pass on its own: the base copied, the blocks followed ───────

describe('a narration pass on its own', () => {
  it('starts from a copy of the base version that shares no object with it', () => {
    const draft = fixtureDraft(scope);
    const s = draft.sections[1]!;
    Object.assign(s, { rowId: 'scene-2', reviewStatus: 'APPROVED', editorNotes: 'Tighter (test).', reviewedBy: 'editor', reviewedAt: '2026-10-01T00:00:00.000Z', written: false });
    Object.assign(s.blocks[0]!, { rowId: 'block-1', generatedText: 'An earlier wording (test).', editedBy: 'editor', editedAt: '2026-10-01T00:00:00.000Z' });
    s.blocks[0]!.delivery.emphasis.push({ text: '1,200 guilders', level: 'STRONG' });
    s.blocks[0]!.visual.mustShow.push({ detail: 'the court record of the case', claimKeys: ['C008'] });
    draft.pronunciations.push({ term: 'Proefman', respelling: 'PROOF-man', ipa: null, language: 'Dutch', confidence: 'MEDIUM', note: '', needsReview: true, source: 'MODEL' });
    const base: LoadedScript = { row: { version: 4 } as unknown as LoadedScript['row'], content: null, draft };
    const snapshot = structuredClone(draft);

    const copy = narrationBase(base);
    const c = copy.sections[1]!;
    expect(c).toMatchObject({ rowId: undefined, reviewStatus: 'PENDING', editorNotes: null, reviewedBy: null, reviewedAt: null, written: true, sequence: 2, title: 'The court' });
    expect(c.blocks[0]).toMatchObject({ rowId: undefined, text: s.blocks[0]!.text, generatedText: s.blocks[0]!.text, editedBy: null, editedAt: null, claimKeys: ['C008'], beatIds: ['2.1'], infoClass: 'UNCERTAIN' });
    expect(c.blocks[0]!.delivery).toEqual(s.blocks[0]!.delivery);
    expect(c.blocks[0]!.visual).toEqual(s.blocks[0]!.visual);
    expect(allBlocks(copy).map((b) => `${b.key} ${b.text}`)).toEqual(allBlocks(draft).map((b) => `${b.key} ${b.text}`));
    expect(copy.pronunciations).toEqual(draft.pronunciations);

    // Changing the copy, deep down, leaves the base as it was.
    c.blocks[0]!.claimKeys.push('C018');
    c.blocks[0]!.beatIds.push('2.2');
    c.blocks[0]!.delivery.emphasis[0]!.level = 'LIGHT';
    c.blocks[0]!.visual.mustShow.push({ detail: 'x', claimKeys: [] });
    c.blocks[0]!.visual.mustAvoid.push('y');
    c.blocks[0]!.presentation[0]!.instruction = 'changed';
    c.blocks[0]!.visual.mustShow[0]!.claimKeys.push('C009');
    copy.pronunciations[0]!.respelling = 'changed';
    copy.sections[0]!.blocks.pop();
    expect(draft).toEqual(snapshot);
  });

  it('follows each block of the base through the reviewers\' renumbering', () => {
    const base = fixtureDraft(scope);
    // The narration pass keeps every block where it was; the editor then removes 1.2; the fact checker inserts a block before the old 1.4.
    const narrationMap = new Map(allBlocks(base).map((b) => [b.key, b.key]));
    const editorMap = new Map<string, string | null>([['1.1', '1.1'], ['1.2', null], ['1.3', '1.2'], ['1.4', '1.3'], ['1.5', '1.4']]);
    const factMap = new Map<string, string | null>([['1.1', '1.1'], ['1.2', '1.2'], ['1.3', '1.4'], ['1.4', '1.5']]);
    const lineage = composeLineage(base, [narrationMap, editorMap, factMap]);
    expect(lineage.slice(0, 5)).toEqual([
      { base: '1.1', saved: '1.1' },
      { base: '1.2', saved: null },
      { base: '1.3', saved: '1.2' },
      { base: '1.4', saved: '1.4' },
      { base: '1.5', saved: '1.5' },
    ]);
    // A block a map does not mention keeps its key; a removed block stays removed.
    expect(lineage.slice(5).every((l) => l.base === l.saved)).toBe(true);
    expect(composeLineage(base, [])).toEqual(allBlocks(base).map((b) => ({ base: b.key, saved: b.key })));
  });
});

describe('what counts as a hedge and a date', () => {
  it('tells the uncertainty families apart', () => {
    expect([...uncertaintyOf('Records suggest he refused.')]).toEqual(['hedge']);
    expect([...uncertaintyOf('The price is disputed.')]).toEqual(['disputed']);
    expect([...uncertaintyOf('No surviving record confirms it.')]).toEqual(['unverified']);
    expect([...uncertaintyOf('The legend says the trade ruined a nation.')]).toEqual(['legend']);
    expect([...uncertaintyOf('He refused the bulbs.')]).toEqual([]);
  });

  it('names months, weekdays and seasons — "May" the month, not "may" the verb', () => {
    expect([...calendarWords('In April 1637, on a Monday, the courts met.')]).toEqual(['april', 'monday']);
    expect([...calendarWords('They may sell in May.')]).toEqual(['may']);
    expect([...calendarWords('They may sell.')]).toEqual([]);
    expect([...calendarWords('Winter came early; by spring it was over.')]).toEqual(['winter', 'spring']);
  });
});
