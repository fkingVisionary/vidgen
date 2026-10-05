import type { AiPattern, RetrievedExample, WritingCategory } from '@docengine/core';
import { filterCorpus, type CorpusEntry } from './corpus.ts';
import { clip } from './text.ts';

/**
 * Targeted retrieval: a handful of examples for what the blocks in front of
 * the writer actually need — a money explanation gets money, numbers and
 * spoken-clarity examples; a character introduction gets character, context
 * and rhythm examples; a hook gets hook, tension and restraint examples; a
 * block showing an AI pattern gets a bad example of that pattern with the
 * house rewrite, and a borderline one when the pattern is a judgment call.
 * Never the whole corpus. Deterministic: the same needs give the same
 * examples, so a resumed job sends the same prompt.
 */

export interface RetrievalNeed {
  /** The block it is for ("3.4"). */
  ref: string;
  /** In order of relevance. */
  categories: WritingCategory[];
  traits: string[];
  /** AI patterns the block shows (bad and borderline examples of them are wanted). */
  patterns: AiPattern[];
  /** Why the block needs examples, in a few words ("a sum of money", "the opening"). */
  reason: string;
}

export interface RetrievalLimits {
  positive: number;
  negative: number;
  borderline: number;
  /** Positive examples per category. */
  perCategory: number;
}

export const DEFAULT_LIMITS: RetrievalLimits = { positive: 8, negative: 5, borderline: 3, perCategory: 2 };

/** Patterns that are judgment calls (fine once): borderline examples teach where the line is. */
const JUDGMENT: ReadonlySet<AiPattern> = new Set(['contrast_formula', 'rhetorical_question', 'fragment_run', 'qa_pair', 'em_dash', 'metaphor_stack', 'imagine_opener', 'truth_reveal']);

export interface Retrieved {
  example: CorpusEntry;
  refs: string[];
  reason: string;
}

function score(e: CorpusEntry, n: RetrievalNeed): number {
  const cat = n.categories.indexOf(e.category);
  const traits = n.traits.filter((t) => e.traits.includes(t)).length;
  const patterns = n.patterns.filter((p) => e.traits.includes(p)).length;
  if (e.polarity === 'negative') return patterns ? 6 * patterns + (cat >= 0 ? 2 : 0) : 0;
  if (e.polarity === 'borderline') return patterns && n.patterns.some((p) => JUDGMENT.has(p)) ? 5 * patterns + (cat >= 0 ? 1 : 0) : 0;
  const base = cat >= 0 ? 6 - Math.min(cat, 3) : 0;
  if (!base && !traits) return 0;
  return base + 1.5 * traits + (e.quality === 'excellent' ? 1 : 0) + (e.polarity === 'house_style' ? 1.5 : 0) + (e.origin === 'HOUSE' ? 1 : 0);
}

/** The examples for a set of needs, within the limits, best first. */
export function retrieve(examples: readonly CorpusEntry[], needs: readonly RetrievalNeed[], limits: RetrievalLimits = DEFAULT_LIMITS): Retrieved[] {
  const pool = filterCorpus(examples, { retrievable: true });
  const scored = pool
    .map((e) => {
      const hits = needs.map((n) => ({ n, s: score(e, n) })).filter((x) => x.s > 0);
      const total = hits.reduce((a, x) => a + x.s, 0) + (hits.length > 1 ? hits.length : 0);
      return { e, hits, total };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total || a.e.id.localeCompare(b.e.id));
  const picked: Retrieved[] = [];
  const count = { positive: 0, negative: 0, borderline: 0 };
  const perCategory = new Map<WritingCategory, number>();
  for (const x of scored) {
    const kind = x.e.polarity === 'house_style' ? 'positive' : x.e.polarity;
    if (count[kind] >= limits[kind]) continue;
    if (kind === 'positive') {
      const n = perCategory.get(x.e.category) ?? 0;
      if (n >= limits.perCategory) continue;
      perCategory.set(x.e.category, n + 1);
    }
    count[kind]++;
    const best = [...x.hits].sort((a, b) => b.s - a.s)[0]!;
    picked.push({ example: x.e, refs: [...new Set(x.hits.map((h) => h.n.ref))], reason: best.n.reason });
  }
  return picked;
}

export const asRecord = (r: readonly Retrieved[]): RetrievedExample[] => r.map((x) => ({ id: x.example.id, version: x.example.version, category: x.example.category, quality: x.example.quality, refs: x.refs, reason: x.reason }));

const quote = (s: string) => `"${s.replace(/\s+/g, ' ').trim()}"`;

/**
 * The retrieved examples as a prompt section. Style only: the heading says
 * they carry no facts, and their names, numbers and events are never to be
 * reused (the evidence rules reject any that are).
 */
export function renderExamples(r: readonly Retrieved[]): string {
  if (!r.length) return '';
  const positive = r.filter((x) => x.example.polarity === 'positive' || x.example.polarity === 'house_style');
  const negative = r.filter((x) => x.example.polarity === 'negative');
  const borderline = r.filter((x) => x.example.polarity === 'borderline');
  const refs = (x: Retrieved) => ` (for ${x.refs.slice(0, 6).join(', ')}${x.refs.length > 6 ? '…' : ''}: ${x.reason})`;
  const lines = ['# House style — reference examples (style only: they carry no facts; never reuse their names, numbers or events)'];
  if (positive.length) {
    lines.push('## Models to follow');
    for (const x of positive) lines.push(`- (${x.example.category}, ${x.example.quality}) ${quote(x.example.text)} — why it works: ${clip(x.example.whyItWorks ?? '', 220)}${refs(x)}`);
  }
  if (negative.length) {
    lines.push('## Habits to avoid — the bad version, then the house version');
    for (const x of negative) lines.push(`- ✗ ${quote(x.example.text)} → ✓ ${quote(x.example.rewrite ?? '')} — why: ${clip(x.example.whyItFails ?? '', 220)}${refs(x)}`);
  }
  if (borderline.length) {
    lines.push('## Judgment calls — right once, wrong when repeated');
    for (const x of borderline) lines.push(`- ${quote(x.example.text)} — works: ${clip(x.example.whyItWorks ?? '', 160)}; fails: ${clip(x.example.whyItFails ?? '', 160)}${refs(x)}`);
  }
  return lines.join('\n');
}
