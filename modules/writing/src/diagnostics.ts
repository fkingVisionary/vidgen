import type { AiPattern, AiSignal, Diagnostics, HistoricalMoneyContext, NameEntry } from '@docengine/core';
import { actionable, aiSignals, summarise } from './fingerprints.ts';
import type { MoneyUse } from './money.ts';
import type { RetrievalNeed } from './retrieval.ts';
import { rhythmProfile } from './rhythm.ts';
import { rubric } from './rubric.ts';
import { narrationOnly, type NarrationBlock } from './text.ts';

/**
 * Everything the writing engine measures about a script, in one place: the
 * AI-pattern fingerprint, the spoken rhythm, and the read-aloud rubric built
 * from them and the script rules' findings. Pure: the same blocks give the
 * same diagnostics.
 */

export interface DiagnoseInput {
  blocks: readonly NarrationBlock[];
  /** Script rule findings by kind. */
  findings?: Readonly<Record<string, number>>;
  money?: readonly MoneyUse[];
  names?: readonly NameEntry[];
}

export interface Diagnosis {
  diagnostics: Diagnostics;
  signals: AiSignal[];
  /** The signals an editor should act on (HARD ones, and DENSITY ones past their threshold). */
  actionable: AiSignal[];
}

export function diagnose(input: DiagnoseInput): Diagnosis {
  const signals = aiSignals(input.blocks);
  const fingerprint = summarise(input.blocks, signals);
  const rhythm = rhythmProfile(input.blocks);
  const money = input.money ?? [];
  const r = rubric({
    fingerprint,
    signals,
    rhythm,
    findings: input.findings ?? {},
    money: {
      mentions: money.length,
      contextualised: money.filter((m) => m.contextualised).length,
      withContextAvailable: money.filter((m) => !m.contextualised && m.contexts.length > 0).length,
      gaps: money.filter((m) => !m.contextualised && m.contexts.length === 0).length,
    },
    names: { candidates: (input.names ?? []).filter((n) => n.candidate).length },
  });
  return { diagnostics: { fingerprint, rhythm, rubric: r }, signals, actionable: actionable(signals, fingerprint.words) };
}

/** What one block needs from an editorial pass (empty: it is settled — leave it as written). */
export interface BlockNeed {
  ref: string;
  patterns: AiPattern[];
  /** Money context the evidence offers that the narration does not give yet. */
  money: HistoricalMoneyContext[];
  excerpts: string[];
}

/**
 * The blocks that need work, and why: those with actionable AI-pattern
 * signals, and those saying a sum of money without the context the evidence
 * offers. Every other block is settled — the pass leaves it as written. This
 * is what makes the pass converge: once a block is fixed it has no need, and
 * a second pass has nothing to do.
 */
export function blockNeeds(blocks: readonly NarrationBlock[], signals: readonly AiSignal[], money: readonly MoneyUse[]): Map<string, BlockNeed> {
  const out = new Map<string, BlockNeed>();
  const keys = new Set(narrationOnly(blocks).map((b) => b.key));
  const need = (ref: string) => {
    let n = out.get(ref);
    if (!n) out.set(ref, (n = { ref, patterns: [], money: [], excerpts: [] }));
    return n;
  };
  for (const s of signals) {
    if (!keys.has(s.ref)) continue;
    const n = need(s.ref);
    if (!n.patterns.includes(s.pattern)) n.patterns.push(s.pattern);
    n.excerpts.push(s.excerpt);
  }
  for (const m of money) {
    if (m.contextualised || !m.contexts.length || !keys.has(m.ref)) continue;
    const n = need(m.ref);
    for (const c of m.contexts) if (!n.money.some((x) => x.id === c.id)) n.money.push(c);
  }
  return out;
}

/**
 * What to retrieve for: the blocks that need work (by what they show), and
 * the places where the house style matters most whether or not anything is
 * wrong there — the opening (hook, tension, restraint), the first block of
 * each section (transitions), the ending (payoff), a sum of money (money,
 * numbers, spoken clarity), a person met for the first time (character,
 * context, rhythm), uncertain history (uncertainty).
 */
export function retrievalNeeds(blocks: readonly NarrationBlock[], needs: ReadonlyMap<string, BlockNeed>, money: readonly MoneyUse[], names: readonly NameEntry[]): RetrievalNeed[] {
  const narration = narrationOnly(blocks);
  if (!narration.length) return [];
  const sections = [...new Set(narration.map((b) => b.section))];
  const first = sections[0];
  const last = sections.at(-1);
  const firstMentions = new Set(names.filter((n) => n.kind === 'PERSON').map((n) => n.firstRef));
  const moneyRefs = new Set(money.map((m) => m.ref));
  const out: RetrievalNeed[] = [];
  narration.forEach((b, i) => {
    const prev = narration[i - 1];
    const sectionStart = !prev || prev.section !== b.section;
    const lastOfSection = narration[i + 1]?.section !== b.section;
    const n = needs.get(b.key);
    const add = (categories: RetrievalNeed['categories'], traits: string[], reason: string) => out.push({ ref: b.key, categories, traits, patterns: n?.patterns ?? [], reason });
    if (b.section === first && narration.filter((x) => x.section === first).indexOf(b) < 2) add(['hook', 'scene'], ['tension', 'restraint', 'curiosity'], 'the opening');
    else if (sectionStart) add(['transition', 'context'], ['transition_by_consequence', 'curiosity'], 'a section opening');
    if (b.section === last && lastOfSection) add(['ending', 'payoff'], ['payoff', 'restraint', 'callback'], 'the ending');
    if (moneyRefs.has(b.key)) add(['economics', 'numbers', 'context'], ['money_context', 'number_in_context', 'spoken_clarity'], 'a sum of money');
    if (firstMentions.has(b.key)) add(['character', 'context'], ['character_intro', 'rhythm_variation'], 'a person met for the first time');
    if (b.infoClass === 'UNCERTAIN') add(['uncertainty'], ['hedge_natural', 'legend_vs_record'], 'uncertain history');
    if (n?.patterns.includes('visual_description')) add(['scene'], ['visual_separation', 'concrete_detail'], 'narration describing the picture');
    if (n && !out.some((x) => x.ref === b.key)) add(['other', 'explanation'], ['rhythm_variation', 'plain_language'], `${n.patterns.join(', ') || 'context'} to fix`);
  });
  return out;
}
