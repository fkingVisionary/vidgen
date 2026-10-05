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
  moneyMentions,
  namesAltered,
  quantities,
  quantitiesAdded,
  quantitiesLost,
  renderExamples,
  renderMoneyContexts,
  retrievalNeeds,
  retrieve,
  spokenRatio,
  unitFor,
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

/** The uncertainty families, each as a pattern that finds every wording of it. */
const FAMILIES = Object.entries({ hedge: HEDGE_PATTERN, disputed: DISPUTED_PATTERN, unverified: UNVERIFIED_PATTERN, legend: MYTH_PATTERN }).map(([family, p]) => [family, new RegExp(p.source, 'gi')] as const);

/**
 * The uncertainty families a text's wording carries, each with how often it
 * is said (for "every hedge kept": one hedge dropped where two claims each
 * had one is a hedge lost, though the family is still there).
 */
export function uncertaintyOf(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [family, p] of FAMILIES) {
    const n = text.match(p)?.length ?? 0;
    if (n) out.set(family, n);
  }
  return out;
}

const NAMED_DAYS = 'January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const CALENDAR = new RegExp(String.raw`\b(?:${NAMED_DAYS})\b`, 'g');
const NAMED_DAY = new RegExp(`^(?:${NAMED_DAYS})$`);
const SEASONS = /\b(?:spring|summer|autumn|winter)\b/gi;
/** Words that place a date within its span ("early April", "the end of the decade", "the late seventeenth century"). */
const QUALIFIERS = new Set(['early', 'mid', 'middle', 'late', 'end', 'beginning', 'start', 'turn', 'close', 'dawn']);
/** Words that may stand between a qualifier and its date ("the end of the year", "late in the decade", "early that spring"). */
const LINKS = new Set(['of', 'the', 'in', 'that', 'this']);
/** Ordinals said in words ("the second auction", "the seventeenth century"): figures the quantities do not count ("third" is one already). */
const ORDINALS = new Set('first second fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth'.split(' '));

/** The date a qualifier can place, starting at word i: a month or weekday, a season, a year or decade, a span ("the year"), a century. */
function dateAt(words: readonly string[], i: number): string | null {
  const w = words[i];
  if (!w) return null;
  const lower = w.toLowerCase();
  if (NAMED_DAY.test(w) || /^(?:spring|summer|autumn|winter|week|month|year|decade|century|centuries|\d{3,4}s?)$/.test(lower)) return lower;
  const next = words[i + 1]?.toLowerCase();
  return (ORDINALS.has(lower) || lower === 'third' || /^\d+(?:st|nd|rd|th)$/.test(lower)) && (next === 'century' || next === 'centuries') ? `${lower} ${next}` : null;
}

/**
 * Months, weekdays and seasons a text names, and each date with the
 * qualifier that places it ("early april", "end year", "late seventeenth
 * century"): a date is a fact, kept as it was. (Months and days only when
 * capitalised: "may" is a verb.)
 */
export function calendarWords(text: string): Set<string> {
  const out = new Set([...text.matchAll(CALENDAR), ...text.matchAll(SEASONS)].map((m) => m[0].toLowerCase()));
  // A qualifier places only a date in its own clause.
  for (const clause of text.split(/[.!?;:,()"“”—–]/)) {
    const words = clause.match(/[\p{L}\p{N}]+/gu) ?? [];
    words.forEach((w, i) => {
      if (!QUALIFIERS.has(w.toLowerCase())) return;
      let j = i + 1;
      while (LINKS.has(words[j]?.toLowerCase() ?? '')) j++;
      const date = dateAt(words, j);
      if (date) out.add(`${w.toLowerCase()} ${date}`);
    });
  }
  return out;
}

/** The ordinals a text says in words. */
const ordinalsOf = (text: string) => wordTokens(text).filter((w) => ORDINALS.has(w));

/** The items of `a` that `b` does not have as often (a multiset difference). */
function without<T>(a: readonly T[], b: readonly T[]): T[] {
  const left = [...b];
  return a.filter((x) => {
    const i = left.indexOf(x);
    if (i >= 0) left.splice(i, 1);
    return i < 0;
  });
}

/** Words that give a sum of money its meaning: added only from the evidence's money context. (A plural possessive ends in an apostrophe, where "\b" cannot follow.) */
const COMPARISON = /\b(?:earn(?:ed|s|t)?|wages?|salary|income|a (?:year|month|week|day)'?s|as much as|enough to buy|the price of a|in today'?s money|modern money|equivalent)\b|\b(?:years|months|weeks|days)'(?!\w)/g;
const comparisonsIn = (normalized: string) => normalized.match(COMPARISON) ?? [];
/** A phrase said whole: not run on into a longer word or a possessive ("a craftsman" is not "a craftsman's son"). */
const whole = (words: string) => new RegExp(String.raw`(?<![\p{L}\p{N}'])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\p{L}\p{N}'])`, 'gu');
/** Wording as compared: normalized, without the full stop that ends it. */
const phrase = (s: string) => normalize(s).replace(/[.!?]+$/, '');

/** The pass's edits by the id the review judges each under (it numbers a patch's edits in order: N1, N2, …): two edits may name the same block. */
const byChange = (out: NarrationOutput) => new Map(out.edits.map((e, i) => [`N${i + 1}`, e]));

/**
 * The narration pass's own invariants for one edit, on top of the evidence
 * rules: a settled block is not touched (skipped); a speaker's line or a
 * quotation is never touched, and no quotation is added; every figure and
 * date stays, and none is added; new figures and money comparisons come only
 * from the money context the edit cites, which is for a sum the block says
 * and is said in its own words (where the evidence gives none, the honest
 * line is no comparison); names keep their spelling; every hedge
 * stays; lines to keep stay; no new machine habit; and a block grows by a
 * third at most (more only with money context).
 */
export function narrationGuard(plan: NarrationPlan, out: NarrationOutput, scope: ScriptScope): NonNullable<ReviewContext['guard']> {
  const edits = byChange(out);
  const contexts = new Map(plan.money.contexts.map((c) => [c.id, c]));
  const { currencies } = scopeMoney(scope);
  const known = knownNames(scope);
  const kept = plan.kept.map((l) => normalize(l));
  const spaced = (t: string) => ` ${wordTokens(t).join(' ')} `;
  return (before, after, change) => {
    if (!before || !after) return [];
    const f = (kind: ScriptFindingKind, detail: string): ScriptFinding => ({ kind, ref: after.key, detail: `Block ${change.ref}: ${detail}` });
    if (!plan.needs.has(change.ref)) return 'Settled: the diagnostics found nothing to fix in this block — it stays as written';
    const found: ScriptFinding[] = [];
    if (before.speakerId) found.push(f('NARRATION_QUOTE_TOUCHED', "a speaker's line is the record's words, not the narrator's"));
    // Every quotation, however short: a word changed inside quotation marks is put in the record's mouth.
    const quoted = quotedPassages(before.text, 1);
    const touched = quoted.filter((q) => !after.text.includes(q));
    for (const q of touched) found.push(f('NARRATION_QUOTE_TOUCHED', `the quotation "${q.slice(0, 60)}" is no longer word for word`));
    const invented = touched.length ? [] : quotedPassages(after.text, 1).filter((q) => !quoted.some((x) => x.includes(q)));
    if (invented.length) found.push(f('NARRATION_QUOTE_TOUCHED', `adds the quotation "${invented[0]!.slice(0, 60)}", which the block did not quote`));
    const ordinals = [ordinalsOf(before.text), ordinalsOf(after.text)] as const;
    const lost = [...quantitiesLost(before.text, after.text), ...without(ordinals[0], ordinals[1])];
    if (lost.length) found.push(f('NARRATION_FIGURE_CHANGED', `the figure(s) ${lost.join(', ')} are no longer said as before`));
    const newOrdinals = without(ordinals[1], ordinals[0]);
    if (newOrdinals.length) found.push(f('NARRATION_FIGURE_CHANGED', `adds the figure(s) ${newOrdinals.join(', ')}, which the block did not say`));
    const dated = calendarWords(before.text);
    const days = calendarWords(after.text);
    const changedDates = [...dated].filter((w) => !days.has(w));
    if (changedDates.length) found.push(f('NARRATION_FIGURE_CHANGED', `the date word(s) ${changedDates.join(', ')} are no longer said`));
    const newDates = [...days].filter((w) => !dated.has(w));
    if (newDates.length) found.push(f('NARRATION_FIGURE_CHANGED', `adds the date word(s) ${newDates.join(', ')}, which the block did not say`));
    const ids = (edits.get(change.id)?.moneyContext ?? []).map((id) => id.trim());
    const cited = ids.map((id) => contexts.get(id)).filter((c): c is HistoricalMoneyContext => !!c);
    const unknownIds = ids.filter((id) => !contexts.has(id));
    if (unknownIds.length) found.push(f('NARRATION_MONEY_UNSOURCED', `cites money context ${unknownIds.join(', ')}, which the evidence does not support`));
    const sums = moneyMentions(after.text, currencies);
    // A cited context is said in its own words: its comparison, or the evidence's sentence beside the sum. The rest of the edit is judged without them — so the wage a context sets the sum beside is said only as the evidence says it (in other words, its period would be the pass's: "a month" for "a year").
    const text = normalize(after.text);
    const own = (c: HistoricalMoneyContext) => [c.explanation, c.comparisonValue].map(phrase).filter(Boolean).map(whole);
    // The honest line is no comparison where the evidence gives none for the sums the block says.
    const honest = sums.length > 0 && !sums.some((m) => plan.money.contexts.some((c) => c.amount === m.amount && c.currency === m.currency));
    const rest = [...cited.flatMap(own), ...(honest ? [whole(phrase(NO_EQUIVALENT))] : [])].reduce((t, p) => t.replace(p, ' '), text);
    const allowed = new Set(cited.flatMap((c) => [c.amount, ...quantities(c.explanation), ...(c.ratio ? [spokenRatio(c.ratio).value] : [])]));
    const added = quantitiesAdded(normalize(before.text), rest).filter((q) => !allowed.has(q));
    if (added.length) found.push(f(cited.length ? 'NARRATION_MONEY_UNSOURCED' : 'NARRATION_FIGURE_CHANGED', `adds the figure(s) ${added.join(', ')}, which ${cited.length ? 'the money context it cites does not give' : 'the block did not say'}`));
    // A cited context is for a sum the block says, and is said whole.
    for (const c of cited) {
      if (!sums.some((m) => m.amount === c.amount && m.currency === c.currency)) found.push(f('NARRATION_MONEY_UNSOURCED', `cites ${c.id}, which is for ${c.amountText} ${unitFor(c.currency, c.amount)} — a sum this block does not say`));
      else if (!own(c).some((p) => text.search(p) >= 0)) found.push(f('NARRATION_MONEY_UNSOURCED', `cites ${c.id} but does not say its comparison ("${c.explanation}")`));
    }
    const fresh = without(comparisonsIn(rest), comparisonsIn(normalize(before.text)));
    if (fresh.length) found.push(f('NARRATION_MONEY_UNSOURCED', cited.length ? `adds a money comparison ("${fresh[0]}") the money context it cites does not give` : `adds a money comparison without citing the evidence's money context ("${NO_EQUIVALENT}" is the honest line when there is none)`));
    const renamed = namesAltered(before.text, after.text, known);
    if (renamed.length) found.push(f('NARRATION_NAME_CHANGED', `${renamed.join('; ')} — a historical name keeps its spelling`));
    const hedges = uncertaintyOf(after.text);
    const fewer = [...uncertaintyOf(before.text)].filter(([h, n]) => (hedges.get(h) ?? 0) < n);
    const gone = fewer.filter(([h]) => !hedges.has(h)).map(([h]) => h);
    if (gone.length) found.push(f('NARRATION_HEDGE_DROPPED', `the ${gone.join(' and ')} wording of the original is gone`));
    for (const [h, n] of fewer.filter(([x]) => hedges.has(x))) found.push(f('NARRATION_HEDGE_DROPPED', `the original's ${h} wording is said ${n} times, the edit's only ${hedges.get(h)}: a hedge is gone`));
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
 * never changed. A line a person wrote stays theirs (its generated wording
 * and who edited it come along), but not the time of the edit: that marks a
 * fact issue fixed, and this run's fact checker has not seen it yet.
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
      blocks: s.blocks.map((b) => ({ ...b, rowId: undefined, editedAt: null, claimKeys: [...b.claimKeys], beatIds: [...b.beatIds], delivery: { ...b.delivery, emphasis: b.delivery.emphasis.map((e) => ({ ...e })) }, visual: { ...b.visual, mustShow: b.visual.mustShow.map((m) => ({ ...m, claimKeys: [...m.claimKeys] })), mustAvoid: [...b.visual.mustAvoid] }, presentation: b.presentation.map((p) => ({ ...p })) })),
    })),
  };
}

/** The picture description the kept edits moved out of the narration, written into each block's visual note. */
export function moveToVisual(draft: ScriptDraft, out: NarrationOutput, changes: readonly ScriptReviewChange[], scope: ScriptScope): { draft: ScriptDraft; moved: { ref: string; note: string }[] } {
  const edits = byChange(out);
  const moved: { ref: string; note: string }[] = [];
  const at = new Map<string, string>();
  for (const c of changes) {
    const note = c.status === 'ACCEPTED' ? edits.get(c.id)?.visualNote?.trim() : undefined;
    if (!note || !c.savedRef) continue;
    const was = at.get(c.savedRef);
    if (!was?.includes(note)) at.set(c.savedRef, was ? `${was} ${note}` : note);
  }
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
  const edits = byChange(out);
  const used = new Map<string, { contextId: string; ref: string }>();
  for (const c of changes) {
    const e = c.reviewer === 'NARRATION' && c.status === 'ACCEPTED' ? edits.get(c.id) : undefined;
    if (!e || !c.savedRef) continue;
    for (const id of e.moneyContext.map((x) => x.trim()).filter((x) => ids.has(x))) used.set(`${id} ${c.savedRef}`, { contextId: id, ref: c.savedRef });
  }
  return [...used.values()];
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
