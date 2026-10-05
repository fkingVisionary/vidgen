import { HEDGE_PATTERN, type HistoricalMoneyContext, type NameEntry, type NarrationRecord, type ScriptReviewChange } from '@docengine/core';
import { normalize, quotedPassages, wordTokens } from '@docengine/story/shared';
import {
  NO_EQUIVALENT,
  RUBRIC_VERSION,
  STYLE_BIBLE_VERSION,
  asRecord,
  blockNeeds,
  blockPatterns,
  countWords,
  diagnose,
  moneyGaps,
  namesAltered,
  quantities,
  quantitiesAdded,
  quantitiesLost,
  renderExamples,
  renderMoneyContexts,
  retrievalNeeds,
  retrieve,
  type BlockNeed,
  type Corpus,
  type Diagnosis,
  type MoneyUse,
  type Retrieved,
} from '@docengine/writing';
import { detectRefrains } from './craft.ts';
import { allBlocks, derive, type DraftBlock, type ScriptDraft } from './draft.ts';
import { knownNames, moneyUses, narrationBlocks, scopeMoney, scriptNames } from './editorial.ts';
import type { ReviewContext } from './review.ts';
import type { ScriptFinding, ScriptFindingKind } from './rules.ts';
import type { NarrationOutput, ScriptPatch } from './schemas.ts';
import type { ScriptScope } from './scope.ts';
import type { LoadedScript } from './store.ts';
import { DISPUTED_PATTERN, MYTH_PATTERN, UNVERIFIED_PATTERN } from './wording.ts';

/**
 * The Human Narration Pass (Writing Engine 2), the script's side: what the
 * pass is shown (the diagnostics' needs, block by block; the lines to keep;
 * the money context the evidence supports; the names as the evidence spells
 * them; a handful of corpus examples retrieved for those needs), how its
 * edits become a patch (texts only — claims, beats, class, speaker, visual
 * direction and delivery are kept by code; money context adds the claims it
 * rests on), and the pass's own invariants, judged change by change on top
 * of the evidence rules. Blocks the diagnostics do not flag are settled: an
 * edit to one is skipped. That is what makes the pass converge.
 */

export interface NarrationPlan {
  diagnosis: Diagnosis;
  needs: Map<string, BlockNeed>;
  money: { contexts: HistoricalMoneyContext[]; uses: MoneyUse[] };
  names: NameEntry[];
  /** Lines to keep word for word (kept on purpose by an earlier version). */
  kept: string[];
  /** Deliberate repetition the rules recognise (refrains and callbacks, as their words): kept too. */
  refrains: string[];
  retrieved: Retrieved[];
  corpusVersion: string;
}

/** Findings by kind (for the rubric). */
export const countKinds = (findings: readonly ScriptFinding[]) => {
  const out: Partial<Record<ScriptFindingKind, number>> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
};

export function planNarration(
  draft: ScriptDraft,
  scope: ScriptScope,
  opts: { kept: readonly string[]; corpus: Corpus; allowed: ReadonlySet<number>; findings: readonly ScriptFinding[]; /** Blocks an earlier narration pass already edited (by key in this draft). */ handled?: ReadonlySet<string> },
): NarrationPlan {
  const blocks = narrationBlocks(draft);
  const uses = moneyUses(draft, scope);
  const names = scriptNames(draft, scope);
  const diagnosis = diagnose({ blocks, findings: countKinds(opts.findings), money: uses, names });
  const inAllowed = (ref: string) => opts.allowed.has(Number(ref.split('.')[0]));
  const refrains = [...new Set(detectRefrains(draft, scope).filter((r) => r.kind !== 'ESCALATION').map((r) => r.phrase).filter((p) => countWords(p) >= 2))];
  const kept = [...new Set(opts.kept.map((l) => l.trim()).filter((l) => countWords(l) >= 2))];
  const words = new Map(blocks.map((b) => [b.key, ` ${wordTokens(b.text).join(' ')} `]));
  const hard = new Set(diagnosis.actionable.filter((x) => x.kind === 'HARD').map((x) => `${x.ref}|${x.pattern}`));
  const text = new Map(blocks.map((b) => [b.key, normalize(b.text)]));
  // A density pattern is a judgment call: it is not raised again on a block an earlier pass already handled, nor on one holding a line kept on purpose.
  const densityOnly = (n: BlockNeed) => !n.money.length && n.patterns.every((p) => !hard.has(`${n.ref}|${p}`));
  const settledOnPurpose = (n: BlockNeed) => densityOnly(n) && (opts.handled?.has(n.ref) || kept.some((l) => text.get(n.ref)?.includes(normalize(l))) || refrains.some((p) => words.get(n.ref)?.includes(` ${p} `)));
  const needs = new Map([...blockNeeds(blocks, diagnosis.actionable, uses)].filter(([ref, n]) => inAllowed(ref) && !settledOnPurpose(n)));
  const allowedBlocks = blocks.filter((b) => opts.allowed.has(b.section));
  const retrieved = retrieve(opts.corpus.examples, retrievalNeeds(allowedBlocks, needs, uses.filter((u) => inAllowed(u.ref)), names));
  return { diagnosis, needs, money: { contexts: scopeMoney(scope).contexts, uses }, names, kept, refrains, retrieved, corpusVersion: opts.corpus.version };
}

/** What the pass is shown besides the script, the architecture and the evidence. */
export function renderNarrationContext(plan: NarrationPlan): string {
  const fp = plan.diagnosis.diagnostics.fingerprint;
  const r = plan.diagnosis.diagnostics.rhythm;
  const needs = [...plan.needs.values()];
  const lines = [
    `# What the diagnostics found — ${needs.length} block(s) need work; every other block is settled (leave it exactly as it is)`,
    ...(needs.length
      ? needs.map((n) => `- ${n.ref} needs: ${[...n.patterns, ...(n.money.length ? [`money context (${n.money.map((m) => m.id).join(', ')})`] : [])].join(', ')}${n.excerpts.length ? ` — ${[...new Set(n.excerpts)].slice(0, 3).map((e) => `"${e}"`).join('; ')}` : ''}`)
      : ['- nothing: the narration needs no edit. Return no edits.']),
    `The script as a whole: AI-pattern score ${fp.score}/100${fp.overThreshold.length ? `; patterns past their threshold: ${fp.overThreshold.join(', ')}` : ''}; sentence lengths average ${r.meanWords} words (spread ${r.variation}); ${Math.round(r.fragmentShare * 100)}% fragments; ${r.sameLengthRuns} run(s) of same-length sentences.`,
    '',
    `# Lines to keep word for word (${plan.kept.length}) — never edit them away`,
    ...(plan.kept.length ? plan.kept.map((l) => `- "${l}"`) : ['- none listed: keep any line that already lands']),
    ...(plan.refrains.length ? ['', '# Deliberate repetition — refrains and callbacks the rules recognise (keep their words)', ...plan.refrains.map((p) => `- ${p}`)] : []),
    '',
    '# Money context the evidence supports — the only comparisons you may add (cite the id in moneyContext)',
    renderMoneyContexts(plan.money.contexts),
    '',
    '# Names, as the evidence spells them — never respelt, never westernised (how they are said is decided elsewhere)',
    ...(plan.names.length ? plan.names.map((n) => `- ${n.displayName}${n.historicalName !== n.displayName ? ` (${n.historicalName})` : ''}${n.fictional ? ' — a fictional device' : ''}`) : ['- none']),
  ];
  const examples = renderExamples(plan.retrieved);
  if (examples) lines.push('', examples);
  return lines.join('\n');
}

/** The pass's edits as a patch: texts only (money context adds the claims it rests on), no removals, no insertions. */
export function toNarrationPatch(out: NarrationOutput, draft: ScriptDraft, plan: NarrationPlan): ScriptPatch {
  const byKey = new Map(allBlocks(draft).map((b) => [b.key, b]));
  const contexts = new Map(plan.money.contexts.map((c) => [c.id, c]));
  return {
    edits: out.edits.map((e) => {
      const b = byKey.get(e.ref.trim());
      const extra = e.moneyContext.flatMap((id) => contexts.get(id.trim())?.sourceClaimKeys ?? []);
      const claimKeys = b && extra.some((k) => !b.claimKeys.includes(k)) ? [...b.claimKeys, ...extra.filter((k) => !b.claimKeys.includes(k))] : null;
      return { ref: e.ref.trim(), reason: e.reason.trim(), text: e.text, infoClass: null, claimKeys, beatIds: null };
    }),
    removals: [],
    insertions: [],
  };
}

/** The uncertainty families a text's wording carries (for "every hedge kept"). */
export function uncertaintyOf(text: string): Set<string> {
  const out = new Set<string>();
  if (HEDGE_PATTERN.test(text)) out.add('hedge');
  if (DISPUTED_PATTERN.test(text)) out.add('disputed');
  if (UNVERIFIED_PATTERN.test(text)) out.add('unverified');
  if (MYTH_PATTERN.test(text)) out.add('legend');
  return out;
}

const CALENDAR = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g;
const SEASONS = /\b(?:spring|summer|autumn|winter)\b/gi;
/** Months, weekdays and seasons a text names: a date is a fact, kept as it was. (Months and days only when capitalised: "may" is a verb.) */
export const calendarWords = (text: string) => new Set([...text.matchAll(CALENDAR), ...text.matchAll(SEASONS)].map((m) => m[0].toLowerCase()));

/** Words that give a sum of money its meaning: added only from the evidence's money context. (A plural possessive ends in an apostrophe, where "\b" cannot follow.) */
const COMPARISON = /\b(?:earn(?:ed|s|t)?|wages?|salary|income|a (?:year|month|week|day)'?s|as much as|enough to buy|the price of a|in today'?s money|modern money|equivalent)\b|\b(?:years|months|weeks|days)'(?!\w)/;

/**
 * The narration pass's own invariants for one edit, on top of the evidence
 * rules: a settled block is not touched (skipped); a speaker's line or a
 * quotation is never touched; every figure stays; new figures and money
 * comparisons come only from the money context the edit cites; names keep
 * their spelling; every hedge stays; lines to keep stay; no new machine
 * habit; and a block grows by a third at most (more only with money context).
 */
export function narrationGuard(plan: NarrationPlan, out: NarrationOutput, scope: ScriptScope): NonNullable<ReviewContext['guard']> {
  const edits = new Map(out.edits.map((e) => [e.ref.trim(), e]));
  const contexts = new Map(plan.money.contexts.map((c) => [c.id, c]));
  const known = knownNames(scope);
  const kept = plan.kept.map((l) => normalize(l));
  const spaced = (t: string) => ` ${wordTokens(t).join(' ')} `;
  return (before, after, change) => {
    if (!before || !after) return [];
    const f = (kind: ScriptFindingKind, detail: string): ScriptFinding => ({ kind, ref: after.key, detail: `Block ${change.ref}: ${detail}` });
    if (!plan.needs.has(change.ref)) return 'Settled: the diagnostics found nothing to fix in this block — it stays as written';
    const found: ScriptFinding[] = [];
    if (before.speakerId) found.push(f('NARRATION_QUOTE_TOUCHED', "a speaker's line is the record's words, not the narrator's"));
    for (const q of quotedPassages(before.text)) if (!after.text.includes(q)) found.push(f('NARRATION_QUOTE_TOUCHED', `the quotation "${q.slice(0, 60)}" is no longer word for word`));
    const lost = quantitiesLost(before.text, after.text);
    if (lost.length) found.push(f('NARRATION_FIGURE_CHANGED', `the figure(s) ${lost.join(', ')} are no longer said as before`));
    const dated = calendarWords(before.text);
    const days = calendarWords(after.text);
    const changedDates = [...dated].filter((w) => !days.has(w));
    if (changedDates.length) found.push(f('NARRATION_FIGURE_CHANGED', `the date word(s) ${changedDates.join(', ')} are no longer said`));
    const newDates = [...days].filter((w) => !dated.has(w));
    if (newDates.length) found.push(f('NARRATION_FIGURE_CHANGED', `adds the date word(s) ${newDates.join(', ')}, which the block did not say`));
    const cited = (edits.get(change.ref)?.moneyContext ?? []).map((id) => contexts.get(id.trim())).filter((c): c is HistoricalMoneyContext => !!c);
    const unknownIds = (edits.get(change.ref)?.moneyContext ?? []).filter((id) => !contexts.has(id.trim()));
    if (unknownIds.length) found.push(f('NARRATION_MONEY_UNSOURCED', `cites money context ${unknownIds.join(', ')}, which the evidence does not support`));
    const allowed = new Set(cited.flatMap((c) => [c.amount, ...quantities(`${c.explanation} ${c.comparisonValue}`), ...(c.ratio ? [Math.round(c.ratio)] : [])]));
    const added = quantitiesAdded(before.text, after.text).filter((q) => !allowed.has(q));
    if (added.length) found.push(f(cited.length ? 'NARRATION_MONEY_UNSOURCED' : 'NARRATION_FIGURE_CHANGED', `adds the figure(s) ${added.join(', ')}, which ${cited.length ? 'the money context it cites does not give' : 'the block did not say'}`));
    if (!cited.length && COMPARISON.test(normalize(after.text)) && !COMPARISON.test(normalize(before.text))) found.push(f('NARRATION_MONEY_UNSOURCED', `adds a money comparison without citing the evidence's money context ("${NO_EQUIVALENT}" is the honest line when there is none)`));
    const renamed = namesAltered(before.text, after.text, known);
    if (renamed.length) found.push(f('NARRATION_NAME_CHANGED', `${renamed.join('; ')} — a historical name keeps its spelling`));
    const hedges = uncertaintyOf(after.text);
    const dropped = [...uncertaintyOf(before.text)].filter((h) => !hedges.has(h));
    if (dropped.length) found.push(f('NARRATION_HEDGE_DROPPED', `the ${dropped.join(' and ')} wording of the original is gone`));
    const lines = kept.filter((l) => normalize(before.text).includes(l) && !normalize(after.text).includes(l));
    if (lines.length) found.push(f('NARRATION_KEPT_LINE_LOST', `the line to keep "${lines[0]!.slice(0, 70)}" is gone`));
    const echoes = plan.refrains.filter((p) => spaced(before.text).includes(` ${p} `) && !spaced(after.text).includes(` ${p} `));
    if (echoes.length) found.push(f('NARRATION_KEPT_LINE_LOST', `the deliberate repetition "${echoes[0]}" is gone`));
    const was = blockPatterns(toPlain(before));
    const now = blockPatterns(toPlain(after)).filter((p) => !was.includes(p));
    if (now.length) found.push(f('NARRATION_PATTERN_ADDED', `adds ${now.join(', ')}`));
    const a = countWords(before.text);
    const b = countWords(after.text);
    if (b > Math.ceil(a * 1.34) + (cited.length ? 18 : 4)) found.push(f('NARRATION_LENGTH_DRIFT', `grows from ${a} to ${b} words: a polish, not a rewrite`));
    return found;
  };
}

const toPlain = (b: DraftBlock) => ({ key: b.key, section: Number(b.key.split('.')[0]), text: b.text, infoClass: b.infoClass, speakerId: b.speakerId, claimKeys: b.claimKeys, visual: { note: b.visual.note, mustShow: b.visual.mustShow } });

/**
 * A narration pass on its own starts from a copy of the base version: every
 * block as it was (text, evidence, class, speaker, visual direction,
 * delivery, central question), sections awaiting review again. The base is
 * never changed.
 */
export function narrationBase(base: LoadedScript): ScriptDraft {
  return {
    pronunciations: base.draft.pronunciations.map((p) => ({ ...p })),
    sections: base.draft.sections.map((s) => ({
      ...s,
      rowId: undefined,
      plan: s.plan ? { ...s.plan } : null,
      reviewStatus: 'PENDING' as const,
      editorNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      written: true,
      blocks: s.blocks.map((b) => ({ ...b, rowId: undefined, generatedText: b.text, editedBy: null, editedAt: null, claimKeys: [...b.claimKeys], beatIds: [...b.beatIds], delivery: { ...b.delivery, emphasis: b.delivery.emphasis.map((e) => ({ ...e })) }, visual: { ...b.visual, mustShow: b.visual.mustShow.map((m) => ({ ...m, claimKeys: [...m.claimKeys] })), mustAvoid: [...b.visual.mustAvoid] }, presentation: b.presentation.map((p) => ({ ...p })) })),
    })),
  };
}

/** The picture description the kept edits moved out of the narration, written into each block's visual note. */
export function moveToVisual(draft: ScriptDraft, out: NarrationOutput, changes: readonly ScriptReviewChange[], scope: ScriptScope): { draft: ScriptDraft; moved: { ref: string; note: string }[] } {
  const notes = new Map(out.edits.filter((e) => e.visualNote?.trim()).map((e) => [e.ref.trim(), e.visualNote!.trim()]));
  const moved: { ref: string; note: string }[] = [];
  const at = new Map<string, string>();
  for (const c of changes) if (c.status === 'ACCEPTED' && c.savedRef && c.ref && notes.has(c.ref)) at.set(c.savedRef, notes.get(c.ref)!);
  if (!at.size) return { draft, moved };
  const sections = draft.sections.map((s) => ({
    ...s,
    blocks: s.blocks.map((b) => {
      const note = at.get(b.key);
      if (!note || b.visual.note.includes(note)) return b;
      moved.push({ ref: b.key, note });
      return derive({ ...b, visual: { ...b.visual, note: b.visual.note ? `${b.visual.note} ${note}` : note } }, scope);
    }),
  }));
  return { draft: { ...draft, sections }, moved };
}

/** Each block of the base and where it ended up, through the reviewers' renumbering (a narration pass on its own). */
export function composeLineage(base: ScriptDraft, maps: readonly ReadonlyMap<string, string | null>[]): { base: string; saved: string | null }[] {
  return allBlocks(base).map((b) => {
    let key: string | null = b.key;
    for (const m of maps) if (key !== null && m.has(key)) key = m.get(key) ?? null;
    return { base: b.key, saved: key };
  });
}

/** Money context the kept edits used, at the block where each landed (a change's savedRef follows the later reviewers' renumbering). */
export function moneyUsed(out: NarrationOutput, changes: readonly ScriptReviewChange[], plan: NarrationPlan): { contextId: string; ref: string }[] {
  const ids = new Set(plan.money.contexts.map((c) => c.id));
  const used: { contextId: string; ref: string }[] = [];
  for (const e of out.edits) {
    const c = changes.find((x) => x.reviewer === 'NARRATION' && x.ref === e.ref.trim() && x.status === 'ACCEPTED');
    if (c?.savedRef) for (const id of e.moneyContext.map((x) => x.trim()).filter((x) => ids.has(x))) used.push({ contextId: id, ref: c.savedRef });
  }
  return used;
}

/** The record of a narration pass, saved with the version it made. */
export function narrationRecord(args: {
  plan: NarrationPlan | null;
  out: NarrationOutput | null;
  unavailable: string | null;
  changes: readonly ScriptReviewChange[];
  after: Diagnosis;
  afterUses: readonly MoneyUse[];
  names: NameEntry[];
  used: { contextId: string; ref: string }[];
  moved: { ref: string; note: string }[];
  lineage: NarrationRecord['lineage'];
  corpusVersion: string;
}): NarrationRecord {
  const mine = args.changes.filter((c) => c.reviewer === 'NARRATION');
  const settled = mine.filter((c) => c.status === 'SKIPPED' && c.rejectionReason?.startsWith('Settled')).length;
  return {
    engine: 'writing-engine-2',
    styleBibleVersion: STYLE_BIBLE_VERSION,
    corpusVersion: args.corpusVersion,
    rubricVersion: RUBRIC_VERSION,
    unavailable: args.unavailable,
    verdict: args.out?.verdict ?? null,
    retrieved: args.plan ? asRecord(args.plan.retrieved) : [],
    counts: {
      flagged: args.plan?.needs.size ?? 0,
      settled,
      proposed: mine.length,
      kept: mine.filter((c) => c.status === 'ACCEPTED').length,
      rejected: mine.filter((c) => c.status === 'REJECTED').length,
      skipped: mine.filter((c) => c.status === 'SKIPPED').length,
    },
    diagnostics: { before: args.plan?.diagnosis.diagnostics ?? null, after: args.after.diagnostics },
    money: { contexts: args.plan?.money.contexts ?? [], used: args.used, gaps: moneyGaps(args.afterUses) },
    names: args.names,
    visualMoved: args.moved,
    lineage: args.lineage,
  };
}
