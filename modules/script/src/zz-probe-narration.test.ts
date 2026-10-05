import { it } from 'vitest';
import { countWords, quantities } from '@docengine/writing';
import { EvidenceBase } from '@docengine/story/shared';
import { fakeEvidenceInput } from '@docengine/story/testing';
import type { Corpus } from '@docengine/writing';
import { allBlocks, derive, type DraftBlock, type ScriptDraft } from './draft.ts';
import { narrationGuard, planNarration, renderNarrationContext, toNarrationPatch, type NarrationPlan } from './narration.ts';
import { reviewPatch } from './review.ts';
import { checkScript } from './rules.ts';
import type { NarrationOutput } from './schemas.ts';
import { buildScope, type ScriptScope } from './scope.ts';
import { fixtureArchitecture, fixtureDraft, fixtureScope } from './testing.ts';
import { detectRefrains } from './craft.ts';

const TARGET = { minSec: 10, maxSec: 400, targetSec: 200 };
const ALL = new Set([1, 2, 3]);
const CORPUS: Corpus = { version: 'test', manifest: { version: '1.0.0', updated: 'x', changes: [] }, examples: [], errors: [] };
function reword(scope: ScriptScope, draft: ScriptDraft, texts: Record<string, string>, extra: Record<string, Partial<DraftBlock>> = {}): ScriptDraft {
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => { const text = texts[b.key]; return text === undefined && !extra[b.key] ? b : derive({ ...b, ...(text === undefined ? {} : { text, generatedText: text }), ...extra[b.key] }, scope); }) })) };
}
const planFor = (scope: ScriptScope, draft: ScriptDraft, opts: { kept?: string[]; handled?: ReadonlySet<string> } = {}) =>
  planNarration(draft, scope, { kept: opts.kept ?? [], corpus: CORPUS, allowed: ALL, findings: checkScript(draft, scope, { target: TARGET, previous: null }), handled: opts.handled });
const output = (edits: { ref: string; text: string; moneyContext?: string[]; visualNote?: string | null }[]): NarrationOutput => ({ verdict: 'v', edits: edits.map((e) => ({ ref: e.ref, text: e.text, reason: 'r', fixes: ['AI_PATTERN'], moneyContext: e.moneyContext ?? [], visualNote: e.visualNote ?? null })), kept: [] });
function narrate(scope: ScriptScope, draft: ScriptDraft, edits: any[], opts: { kept?: string[]; plan?: NarrationPlan } = {}) {
  const kept = opts.kept ?? [];
  const plan = opts.plan ?? planFor(scope, draft, { kept });
  const out = output(edits);
  return reviewPatch(draft, toNarrationPatch(out, draft, plan), 'NARRATION', { scope, target: TARGET, allowed: ALL, base: null, kept, guard: narrationGuard(plan, out, scope) });
}
const scope = fixtureScope();
const PROEFMAN = 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.';
const COURTS = 'In April 1637 the courts sent the unsettled contracts back to the towns.';
const LEGEND = 'The legend says the trade ruined a nation. The archives tell another story.';
const flagged = () => reword(scope, fixtureDraft(scope), { '2.1': `${PROEFMAN} And then, everything changed.`, '2.2': `${COURTS} That was only the beginning.`, '3.1': `${LEGEND} But then the stage was set.` });
function moneyScope(): ScriptScope {
  const architecture = fixtureArchitecture();
  const court = architecture.sequences[1]!;
  court.beats[0]!.claimKeys.push('C018');
  court.claimKeys.push('C018');
  return buildScope({ architectureId: 'arch-test', architectureVersion: 1, architecture, evidence: new EvidenceBase(fakeEvidenceInput()) });
}
const show = (label: string, c: any) => console.log(label, JSON.stringify({ status: c.status, rules: c.rulesImpacted, reason: c.rejectionReason }));

it('probe', () => {
  const one = (ref: string, text: string, o: any = {}) => narrate(o.scope ?? scope, o.draft ?? flagged(), [{ ref, text, moneyContext: o.moneyContext }], { kept: o.kept }).changes[0]!;
  show('added', one('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders, within two weeks.'));
  show('name', one('2.1', 'Records suggest that Cornelius Proefman refused the bulbs he had bought, for 1,200 guilders.'));
  show('wage', one('2.1', 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders, as much as a craftsman earned in years.'));
  show('years', one('2.1', `${PROEFMAN} That was years' pay.`));
  show('unhedged', one('2.1', 'Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.'));
  show('habit', one('2.1', `Remarkably, ${PROEFMAN.charAt(0).toLowerCase()}${PROEFMAN.slice(1)}`));
  const ms = moneyScope();
  const md = fixtureDraft(ms);
  const FOUR = `${PROEFMAN} That was about four years' pay for a skilled craftsman.`;
  show('five', one('2.1', `${PROEFMAN} That was about five years' pay for a skilled craftsman.`, { scope: ms, draft: md, moneyContext: ['M1'] }));
  show('uncited', one('2.1', FOUR, { scope: ms, draft: md }));
  show('four', one('2.1', FOUR, { scope: ms, draft: md, moneyContext: ['M1'] }));
  console.log('words', countWords(PROEFMAN), countWords(FOUR), countWords(`${PROEFMAN} And then, everything changed.`));
  // two contexts
  const plan = planFor(ms, md);
  console.log('ctx', JSON.stringify(plan.money.contexts));
  const patch = toNarrationPatch(output([{ ref: '2.1', text: FOUR, moneyContext: ['M1', 'M2'] }]), md, plan);
  console.log('two', JSON.stringify(patch.edits[0]!.claimKeys));
  const r2 = narrate(ms, md, [{ ref: '2.1', text: FOUR, moneyContext: ['M1', 'M2'] }]);
  console.log('two-after', JSON.stringify(allBlocks(r2.draft).find((b) => b.key === '2.1')!.claimKeys), r2.changes[0]!.status, r2.changes[0]!.rejectionReason);
  // handled money block
  console.log('handled-money', JSON.stringify([...planFor(ms, md, { handled: new Set(['2.1', '3.2']) }).needs.keys()]));
  // refrains
  const rd = reword(scope, fixtureDraft(scope), { '2.2': `${COURTS} The archives tell another story.`, '3.1': `${LEGEND} But then the stage was set.` });
  console.log('refrains', JSON.stringify(detectRefrains(rd, scope)));
  const rp = planFor(scope, rd);
  console.log('rplan', JSON.stringify(rp.refrains), JSON.stringify([...rp.needs.values()]));
  console.log(renderNarrationContext(rp));
  console.log('q', quantities("about four years' pay"), quantities('more than eighteen years'));
});
