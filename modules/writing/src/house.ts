import { createHash } from 'node:crypto';
import { WritingCorpusExample, type WritingCategory, type WritingExampleDecisionInput, type WritingExampleStatus } from '@docengine/core';
import type { Database, Prisma, Tx, WritingExample } from '@docengine/database';
import { normalize } from '@docengine/story/shared';
import { aiSignals } from './fingerprints.ts';
import { countWords, narrationOnly, sentencesOf, type NarrationBlock } from './text.ts';

/**
 * House-style evolution: the team's own approved work becomes the most
 * important part of the corpus — but never automatically. An approved script
 * proposes candidates (lines with no machine habits, at the places where the
 * house style matters: openings, transitions, money, uncertainty, endings);
 * a person approves each one (with why it works), rejects it, or later
 * retires it. Only approved examples are retrieved. A generated script is
 * never fed back on its own: the model would learn its own mistakes.
 */

type Db = Database | Tx;

export const textHash = (text: string) => createHash('sha256').update(normalize(text)).digest('hex');

export interface CandidateProposal {
  blockKey: string;
  text: string;
  category: WritingCategory;
  traits: string[];
  narrativeFunction: string;
  spokenRhythm: string;
}

/**
 * Lines of an approved script worth proposing: narrator blocks of 8–90 words
 * with no AI-pattern signal at all, at most `max`, one or two per category,
 * in script order.
 */
export function candidateLines(blocks: readonly NarrationBlock[], opts: { max?: number; moneyRefs?: ReadonlySet<string>; firstMentions?: ReadonlySet<string> } = {}): CandidateProposal[] {
  const narration = narrationOnly(blocks);
  // Any signal at all, not only an actionable one: a candidate is a model to follow.
  const signals = new Set(aiSignals(blocks).map((s) => s.ref));
  const sections = [...new Set(narration.map((b) => b.section))];
  const out: CandidateProposal[] = [];
  const perCategory = new Map<WritingCategory, number>();
  const seen = new Set<string>();
  narration.forEach((b, i) => {
    const words = countWords(b.text);
    if (words < 8 || words > 90 || signals.has(b.key) || seen.has(normalize(b.text))) return;
    const sectionStart = narration[i - 1]?.section !== b.section;
    const ending = b.section === sections.at(-1) && narration[i + 1]?.section !== b.section;
    const [category, traits, fn]: [WritingCategory, string[], string] =
      b.section === sections[0] && sectionStart
        ? ['hook', ['restraint', 'curiosity'], 'Opens the film']
        : ending
          ? ['ending', ['payoff', 'restraint'], 'Ends the film']
          : opts.moneyRefs?.has(b.key)
            ? ['economics', ['money_context', 'number_in_context'], 'Gives a sum of money its meaning']
            : opts.firstMentions?.has(b.key)
              ? ['character', ['character_intro'], 'Introduces a person']
              : b.infoClass === 'UNCERTAIN'
                ? ['uncertainty', ['hedge_natural'], 'Tells uncertain history at its level']
                : sectionStart
                  ? ['transition', ['transition_by_consequence'], 'Opens a section']
                  : b.infoClass === 'RECONSTRUCTION' || b.infoClass === 'FICTION'
                    ? ['scene', ['visual_separation'], 'Sets a scene the pictures show']
                    : ['explanation', ['plain_language'], 'Explains what happened'];
    const n = perCategory.get(category) ?? 0;
    if (n >= 2) return;
    perCategory.set(category, n + 1);
    seen.add(normalize(b.text));
    const lengths = sentencesOf(b.text).map(countWords);
    out.push({ blockKey: b.key, text: b.text, category, traits, narrativeFunction: fn, spokenRhythm: `${lengths.length} sentence(s) of ${lengths.join(', ')} words` });
  });
  return out.slice(0, opts.max ?? 12);
}

/**
 * Save proposals as candidates (a wording already proposed is skipped).
 * Returns how many were new. One statement: a request proposing the same
 * lines at the same time (two tabs, a retry) skips them too, never fails.
 */
export async function saveCandidates(db: Db, args: { projectId: string; scriptId: string; scriptVersion: number; proposals: readonly CandidateProposal[]; actor: string }): Promise<number> {
  const { count } = await db.writingExample.createMany({
    data: args.proposals.map((p) => ({
      exampleId: `house-${args.scriptId.slice(-8)}-${p.blockKey.replace('.', '-')}`,
      projectId: args.projectId,
      scriptId: args.scriptId,
      scriptVersion: args.scriptVersion,
      blockKey: p.blockKey,
      text: p.text,
      textHash: textHash(p.text),
      category: p.category,
      quality: 'good',
      traits: p.traits,
      strengths: [],
      weaknesses: [],
      spokenRhythm: p.spokenRhythm,
      narrativeFunction: p.narrativeFunction,
      sourceType: 'house',
      sourceReference: `Approved script v${args.scriptVersion}, block ${p.blockKey}`,
      copyrightSafe: true,
      approvedForRetrieval: false,
      status: 'CANDIDATE',
      diagnostics: {} as Prisma.InputJsonValue,
      createdBy: args.actor,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** A database row in the shape of a corpus example (not yet checked). */
const corpusFields = (r: WritingExample) => ({
  id: r.exampleId,
  version: r.version,
  text: r.text,
  category: r.category,
  quality: r.quality,
  traits: r.traits,
  strengths: r.strengths,
  weaknesses: r.weaknesses,
  spokenRhythm: r.spokenRhythm,
  narrativeFunction: r.narrativeFunction,
  ...(r.whyItWorks ? { whyItWorks: r.whyItWorks } : {}),
  ...(r.whyItFails ? { whyItFails: r.whyItFails } : {}),
  source: { type: r.sourceType, ...(r.sourceReference ? { reference: r.sourceReference } : {}) },
  copyrightSafe: r.copyrightSafe,
  approvedForRetrieval: r.approvedForRetrieval,
});

/** A database row as a corpus example (what retrieval and the dashboard read). */
export function toCorpusExample(r: WritingExample): WritingCorpusExample | null {
  const parsed = WritingCorpusExample.safeParse(corpusFields(r));
  return parsed.success ? parsed.data : null;
}

/** The house examples in retrieval: approved by a person, copyright-safe. */
export async function approvedHouseExamples(db: Db): Promise<WritingCorpusExample[]> {
  const rows = await db.writingExample.findMany({ where: { status: 'APPROVED', approvedForRetrieval: true, copyrightSafe: true }, orderBy: { createdAt: 'asc' } });
  return rows.flatMap((r) => toCorpusExample(r) ?? []);
}

export class ExampleDecisionError extends Error {}

/**
 * A person's decision on a house example. Approving needs a reason it works
 * (it teaches the writer), and the example must be one retrieval can read (a
 * bad one also says why it fails): it is refused here, never approved and
 * then silently left out. A change to its annotation makes a new version.
 */
export async function decideExample(db: Db, id: string, input: WritingExampleDecisionInput, actor: string): Promise<WritingExample> {
  const row = await db.writingExample.findUnique({ where: { id } });
  if (!row) throw new ExampleDecisionError('No such house example');
  const status: WritingExampleStatus = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'RETIRED';
  if (input.decision === 'RETIRE' && row.status !== 'APPROVED') throw new ExampleDecisionError('Only an approved example can be retired');
  if (input.decision !== 'RETIRE' && row.status !== 'CANDIDATE') throw new ExampleDecisionError(`This example was already decided (${row.status.toLowerCase()})`);
  const whyItWorks = input.whyItWorks?.trim() || row.whyItWorks;
  if (input.decision === 'APPROVE' && !whyItWorks) throw new ExampleDecisionError('Say why it works: the reason is what teaches the writer');
  const annotated = (input.category && input.category !== row.category) || (input.quality && input.quality !== row.quality) || (input.whyItWorks && input.whyItWorks !== row.whyItWorks) || (input.whyItFails && input.whyItFails !== row.whyItFails);
  const decided = {
    status,
    approvedForRetrieval: status === 'APPROVED',
    ...(input.category ? { category: input.category } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(whyItWorks ? { whyItWorks } : {}),
    ...(input.whyItFails ? { whyItFails: input.whyItFails } : {}),
  };
  const unusable = status === 'APPROVED' ? WritingCorpusExample.safeParse(corpusFields({ ...row, ...decided })).error : undefined;
  if (unusable) throw new ExampleDecisionError(`Retrieval cannot use it as it stands: ${unusable.issues[0]!.message}`);
  return db.writingExample.update({
    where: { id },
    data: {
      ...decided,
      version: annotated && row.status !== 'CANDIDATE' ? row.version + 1 : row.version,
      reviewedBy: actor,
      reviewedAt: new Date(),
      reviewNote: input.note ?? null,
    },
  });
}
