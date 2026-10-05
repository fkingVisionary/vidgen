import { sentences, wordTokens } from '@docengine/story/shared';
import { contentWords, topicWords } from './craft.ts';
import { allBlocks, type DraftBlock, type ScriptDraft } from './draft.ts';
import type { ScriptFinding } from './rules.ts';
import { realCast, type ScriptScope } from './scope.ts';
import { PROBABILITY_PATTERN, isHedgePhrase, stem } from './wording.ts';

/**
 * Evidence invariants beyond figures, dates and quotation marks: a factual
 * assertion need not contain a number to need a claim. Three checks, all
 * blocking, all generic:
 *
 * - UNCERTAINTY_UPGRADED — probability wording ("probably", "what probably
 *   happened") is for PROBABLE claims; said of a myth, an unverified or
 *   disputed claim, a reconstruction or a framing line, it raises the truth
 *   status of what it describes;
 * - ASSERTION_UNCITED — a sentence about a real person says something (an
 *   action, a detail) that a claim about that person carries, but the block
 *   does not cite that claim;
 * - CLAIM_LINK_LOST — a sentence kept from the version before (word for word
 *   or nearly) no longer cites the claim that supported it there.
 *
 * Heuristics over words, stated as such: they catch the common ways an
 * assertion drifts from its evidence; the fact checker covers the rest.
 */

/** Words too general to tie a sentence to one claim: time words, and light verbs (by stem) that any sentence about a person might use. */
const GENERIC = new Set(
  [
    'year years time times day days week weeks month months season seasons later earlier early first second third last next during whole part parts kind sort moment moments while place places thing things people',
    'go come take make get say tell know think see seem become keep begin put leave try use give find want ask need feel work call look turn hold bring show let mean happen stand stay live set move stop start wait watch',
  ]
    .join(' ')
    .split(' '),
);
const generic = (w: string) => GENERIC.has(w) || GENERIC.has(stem(w));

const quotationsOut = (text: string) => text.replace(/["“][^"”]*["”]/g, ' ');

/** A block that says something "probably" happened when none of its claims is PROBABLE. */
export function uncertaintyUpgrade(b: DraftBlock, scope: ScriptScope): ScriptFinding | null {
  if (b.speakerId || b.infoClass === 'FICTION') return null;
  // Statements only: a question ("So what probably happened?") asks, it does not assert.
  const statements = sentences(quotationsOut(b.text)).filter((x) => !x.trim().endsWith('?')).join(' ');
  const m = PROBABILITY_PATTERN.exec(statements);
  if (!m) return null;
  const verdict = (k: string) => scope.evidence.claim(k)?.verdict;
  if (b.claimKeys.some((k) => verdict(k) === 'PROBABLE')) return null;
  const at = `Block ${b.key}`;
  if (b.infoClass === 'RECONSTRUCTION' || b.infoClass === 'FRAMING') {
    const what = b.infoClass === 'RECONSTRUCTION' ? 'a reconstruction' : 'a framing line';
    return { kind: 'UNCERTAINTY_UPGRADED', ref: b.key, detail: `${at}: "${m[0]}" presents ${what} as probable history, and no PROBABLE claim stands behind it — tell it as the scene or question it is, or cite the claim that makes it probable` };
  }
  const weak = b.claimKeys.filter((k) => ['MYTH', 'UNVERIFIED', 'DISPUTED'].includes(verdict(k) ?? ''));
  if (weak.length && b.claimKeys.every((k) => verdict(k) !== 'ESTABLISHED')) {
    return { kind: 'UNCERTAINTY_UPGRADED', ref: b.key, detail: `${at}: "${m[0]}" upgrades ${weak.map((k) => `${k} (${verdict(k)})`).join(', ')} to probable — word it as its verdict requires` };
  }
  return null;
}

/** Stems of what the evidence behind these claims says. */
const evidenceStems = (scope: ScriptScope, keys: readonly string[]) => new Set(wordTokens(scope.evidence.textFor(keys)).map(stem));

/** Sentences about a real person that say what an uncited claim about that person says. */
export function uncitedAssertions(b: DraftBlock, scope: ScriptScope, topic: ReadonlySet<string>): ScriptFinding[] {
  if ((b.infoClass !== 'DOCUMENTED' && b.infoClass !== 'UNCERTAIN') || b.speakerId) return [];
  const people = realCast(scope).filter((c) => c.member.kind === 'REAL_PERSON' && c.tokens.length > 0);
  if (!people.length) return [];
  const cited = evidenceStems(scope, b.claimKeys);
  const out: ScriptFinding[] = [];
  for (const s of sentences(quotationsOut(b.text))) {
    const words = wordTokens(s);
    for (const p of people) {
      if (!p.tokens.some((t) => words.includes(t))) continue;
      const fresh = [...new Set(contentWords(s).filter((w) => w.length >= 4 && !p.tokens.includes(w) && !topic.has(w) && !generic(w) && !isHedgePhrase(w)).map(stem))].filter((w) => !cited.has(w));
      if (!fresh.length) continue;
      for (const k of scope.claims) {
        if (b.claimKeys.includes(k)) continue;
        const statement = wordTokens(scope.evidence.claim(k)?.statement ?? '');
        if (!p.member.claimKeys.includes(k) && !p.tokens.some((t) => statement.includes(t))) continue;
        const stems = new Set(statement.map(stem));
        const hits = fresh.filter((w) => stems.has(w));
        if (!hits.length) continue;
        const verdict = scope.evidence.claim(k)?.verdict;
        out.push({
          kind: 'ASSERTION_UNCITED',
          ref: b.key,
          detail: `Block ${b.key}: "${snippet(s)}" says of ${p.member.name} what ${k} (${verdict}) carries (${hits.join(', ')}), but the block does not cite ${k} — cite it, worded as its verdict requires, or cut it`,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Sentences kept from the version before (word for word, or 80% of the same
 * words) that no longer cite a claim behind them there: the claim's words are
 * still in the sentence, and no claim the block now cites carries them.
 */
export function claimLinksLost(draft: ScriptDraft, previous: ScriptDraft, scope: ScriptScope): ScriptFinding[] {
  const before = allBlocks(previous)
    .flatMap((b) => sentences(b.text).map((s) => ({ b, tokens: wordTokens(s) })))
    .filter((x) => x.tokens.length >= 5)
    .map((x) => ({ ...x, set: new Set(x.tokens) }));
  const exact = new Map(before.map((x) => [x.tokens.join(' '), x]));
  const out: ScriptFinding[] = [];
  for (const b of allBlocks(draft)) {
    if (b.infoClass !== 'DOCUMENTED' && b.infoClass !== 'UNCERTAIN' && b.infoClass !== 'RECONSTRUCTION') continue;
    const cited = evidenceStems(scope, b.claimKeys);
    for (const s of sentences(b.text)) {
      const tokens = wordTokens(s);
      if (tokens.length < 5) continue;
      const match = exact.get(tokens.join(' ')) ?? nearest(tokens, before);
      if (!match) continue;
      for (const k of match.b.claimKeys.filter((x) => !b.claimKeys.includes(x))) {
        const statement = new Set(contentWords(scope.evidence.claim(k)?.statement ?? '').map(stem));
        const shared = [...new Set(contentWords(s).map(stem))].filter((w) => statement.has(w) && !cited.has(w) && !generic(w));
        if (shared.length < 2) continue;
        out.push({
          kind: 'CLAIM_LINK_LOST',
          ref: b.key,
          detail: `Block ${b.key} keeps "${snippet(s)}" from the version before, but no longer cites ${k} (${scope.evidence.claim(k)?.verdict}), the claim behind it — cite it, worded as its verdict requires, or cut the sentence`,
        });
      }
    }
  }
  return out;
}

function nearest<T extends { set: Set<string> }>(tokens: readonly string[], pool: readonly T[]): T | null {
  const mine = new Set(tokens);
  let best: T | null = null;
  let score = 0;
  for (const x of pool) {
    // At 80% shared words the sizes cannot differ much: skip the rest cheaply.
    if (x.set.size < mine.size * 0.8 || x.set.size > mine.size * 1.25) continue;
    let shared = 0;
    for (const w of mine) if (x.set.has(w)) shared++;
    const jaccard = shared / (mine.size + x.set.size - shared);
    if (jaccard >= 0.8 && jaccard > score) {
      best = x;
      score = jaccard;
    }
  }
  return best;
}

/** A sentence as quoted in a finding: whole when short, else cut at a word before `n` characters. */
const snippet = (s: string, n = 70) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return `${(cut.lastIndexOf(' ') > n / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[,;:]$/, '').trimEnd()}…`;
};

/** The evidence invariants for a whole version (the per-block ones; claim links need the version before). */
export function evidenceInvariants(draft: ScriptDraft, scope: ScriptScope, previous: ScriptDraft | null): ScriptFinding[] {
  const blocks = allBlocks(draft);
  const topic = topicWords(blocks.filter((b) => !b.speakerId));
  const out: ScriptFinding[] = [];
  for (const b of blocks) {
    const up = uncertaintyUpgrade(b, scope);
    if (up) out.push(up);
    out.push(...uncitedAssertions(b, scope, topic));
  }
  if (previous) out.push(...claimLinksLost(draft, previous, scope));
  return out;
}
