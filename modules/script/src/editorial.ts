import type { HistoricalMoneyContext, NameEntry } from '@docengine/core';
import { actionable, aiSignals, currenciesOf, directionLeaks, moneyContexts, moneyInNarration, nameLayer, type KnownName, type MoneyUse, type NarrationBlock } from '@docengine/writing';
import { allBlocks, type DraftBlock, type ScriptDraft } from './draft.ts';
import { namesInScript } from './craft.ts';
import type { ScriptFinding } from './rules.ts';
import type { ScriptScope } from './scope.ts';

/**
 * The script's side of Writing Engine 2: a script version as the writing
 * engine reads it, the money context and names of its scope, and the
 * editorial findings the rules report — AI patterns, narration describing the
 * picture, sums without the context the evidence offers (warnings), and
 * production directions inside narration (blocking: the voice would speak
 * them, or take them as performance tags).
 */

export function narrationBlocks(draft: ScriptDraft): NarrationBlock[] {
  return draft.sections.flatMap((s) => s.blocks.map((b) => toNarrationBlock(b, s.sequence)));
}

export function toNarrationBlock(b: DraftBlock, section: number): NarrationBlock {
  return { key: b.key, section, text: b.text, infoClass: b.infoClass, speakerId: b.speakerId, claimKeys: b.claimKeys, visual: { note: b.visual.note, mustShow: b.visual.mustShow } };
}

const contextsByScope = new WeakMap<ScriptScope, { contexts: HistoricalMoneyContext[]; currencies: Set<string> }>();

/** The money context the scope's evidence supports, worked out once per scope. */
export function scopeMoney(scope: ScriptScope): { contexts: HistoricalMoneyContext[]; currencies: Set<string> } {
  let m = contextsByScope.get(scope);
  if (!m) contextsByScope.set(scope, (m = { contexts: moneyContexts(scope.evidence, scope.claimSet), currencies: currenciesOf(scope.evidence) }));
  return m;
}

export function moneyUses(draft: ScriptDraft, scope: ScriptScope): MoneyUse[] {
  const { contexts, currencies } = scopeMoney(scope);
  return moneyInNarration(narrationBlocks(draft), contexts, currencies);
}

/** The names the scope knows: the architecture's people (real and fictional) and the dossier's key figures it cites. */
export function knownNames(scope: ScriptScope): KnownName[] {
  const cast: KnownName[] = scope.architecture.cast
    .filter((m) => m.kind === 'REAL_PERSON' || m.kind === 'FICTIONAL_COMPOSITE')
    .map((m) => ({ name: m.name, kind: 'PERSON', castId: m.id, fictional: m.kind === 'FICTIONAL_COMPOSITE', claimKeys: m.claimKeys }));
  const figures: KnownName[] = scope.evidence.content.keyFigures
    .filter((f) => f.claimKeys.some((k) => scope.claimSet.has(k)) && !cast.some((c) => c.name === f.name))
    .map((f) => ({ name: f.name, kind: 'PERSON', castId: null, fictional: false, claimKeys: f.claimKeys }));
  return [...cast, ...figures];
}

/** The name layer of a version: historical, display and spoken forms, and the names waiting for a pronunciation decision. */
export function scriptNames(draft: ScriptDraft, scope: ScriptScope): NameEntry[] {
  const found = namesInScript(draft);
  const other = [...found.mentions.entries()].flatMap(([key, ms]) => ms.map((m) => ({ form: m.form, refs: [key] })));
  const byForm = new Map<string, { form: string; refs: string[] }>();
  for (const o of other) {
    const e = byForm.get(o.form) ?? { form: o.form, refs: [] };
    e.refs.push(...o.refs);
    byForm.set(o.form, e);
  }
  return nameLayer({ known: knownNames(scope), blocks: narrationBlocks(draft), pronunciations: draft.pronunciations, otherNames: [...byForm.values()] });
}

/** Editorial findings of a version (called by checkScript). */
export function editorialFindings(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const blocks = narrationBlocks(draft);
  for (const b of allBlocks(draft)) {
    const leaks = directionLeaks(b.text);
    if (leaks.length) out.push({ kind: 'DIRECTION_IN_NARRATION', ref: b.key, detail: `Block ${b.key} has ${leaks.join(', ')} in its narration: the voice would speak it — directions belong in the delivery and visual layers` });
  }
  const words = blocks.filter((b) => !b.speakerId).reduce((n, b) => n + b.text.split(/\s+/).length, 0);
  const signals = actionable(aiSignals(blocks), words);
  const byBlock = new Map<string, Set<string>>();
  for (const s of signals) {
    // Stock phrases and question counts have their own rules (AI_PHRASES, RHETORICAL_QUESTIONS).
    if (s.pattern === 'stock_phrase' || s.pattern === 'visual_description' || (s.pattern === 'rhetorical_question' && s.kind === 'DENSITY')) continue;
    byBlock.set(s.ref, (byBlock.get(s.ref) ?? new Set()).add(s.pattern));
  }
  for (const [ref, patterns] of byBlock) out.push({ kind: 'AI_PATTERN', ref, detail: `Block ${ref} reads as machine-written (${[...patterns].join(', ')}): say it plainly — the facts carry the drama` });
  for (const s of signals.filter((x) => x.pattern === 'visual_description')) out.push({ kind: 'VISUAL_IN_NARRATION', ref: s.ref, detail: `Block ${s.ref} describes what the picture shows ("${s.excerpt}"): leave it to the visuals, and say what they cannot — the stakes, the price, the rule, the date` });
  for (const u of moneyUses(draft, scope)) {
    if (u.contextualised || !u.contexts.length) continue;
    const c = u.contexts[0]!;
    out.push({ kind: 'MONEY_WITHOUT_CONTEXT', ref: u.ref, detail: `Block ${u.ref} says ${u.mention.amountText} ${u.mention.currency} without what it meant; the evidence gives ${c.id}: ${c.explanation} (${c.sourceClaimKeys.join(', ')}, ${c.verdict})` });
  }
}
