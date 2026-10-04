import {
  CONTENT_LIMITS,
  PRESENTATION_FOR_VERDICT,
  historicalConfidenceOf,
  historicalStatusOf,
  shortPotential,
  type ClaimPresentation,
  type ContentFormat,
  type ContentOpportunityContent,
  type HistoricalStatus,
  type OpportunityScores,
  type StoryArchitectureContentV2,
} from '@docengine/core';
import { coreClaimsOf, outsidePeople, peopleMentioned, type SelectedUnit } from './architecture.ts';
import type { EvidenceBase } from './evidence.ts';
import { checkFigures, orderedKeys } from './rules.ts';
import type { OpportunityOutput } from './schemas.ts';
import { quoteFoundIn, quotedPassages, titleSimilarity, unknownProperNouns, wordTokens } from './text.ts';

/** A content opportunity that passed the rules, ready to store. */
export interface BuiltOpportunity {
  key: string;
  format: ContentFormat;
  /** Rank among SHORT and BOTH by short-form potential; null for LONG_FORM. */
  rank: number | null;
  shortScore: number | null;
  title: string;
  hook: string;
  centralQuestion: string;
  targetDurationSec: number | null;
  independent: boolean;
  requiresContext: boolean;
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  content: ContentOpportunityContent;
}

export interface RemovedOpportunity {
  title: string;
  reason: string;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clamp = (n: number) => Math.min(10, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * Apply the rules to the content opportunities identified in an architecture
 * that passed its gate. An opportunity must trace to architecture beats and,
 * through them, to the approved dossier:
 *
 * - every beat id exists; its claims are claims of those beats or of their
 *   sequences (story evidence or labelled background) — never anything else;
 * - no new facts: figures and dates come from its claims; no person or place
 *   the evidence and the declared cast do not know; quotation marks only
 *   around verified quotations or the architecture's invented lines;
 * - claims that are not ESTABLISHED carry the architecture's presentation
 *   instructions (copied, not rewritten);
 * - durations fit the format; duplicates are removed; at most the limit.
 *
 * An opportunity that breaks a rule is removed with the reason (it is a
 * suggestion, not a gate). Shorts are ranked by short-form potential.
 */
export function buildOpportunities(
  raw: OpportunityOutput,
  content: StoryArchitectureContentV2,
  evidence: EvidenceBase,
  units: readonly SelectedUnit[],
): { opportunities: BuiltOpportunity[]; removed: RemovedOpportunity[]; notes: string[] } {
  const removed: RemovedOpportunity[] = [];
  const notes: string[] = [];
  const beats = new Map(content.sequences.flatMap((s) => s.beats.map((b) => [b.id, { beat: b, sequence: s }] as const)));
  const castIds = new Set(content.cast.map((m) => m.id));
  const core = coreClaimsOf(units, evidence);
  const outsiders = outsidePeople(evidence, core);
  const castWords = new Set(content.cast.flatMap((m) => wordTokens(m.name)));
  const known = { has: (w: string) => castWords.has(w) || evidence.dossierWords().has(w) };
  const kept: (Omit<BuiltOpportunity, 'key' | 'rank'> & { sortScore: number })[] = [];

  for (const o of raw.opportunities) {
    const title = clean(o.title) || '(untitled)';
    const remove = (reason: string) => removed.push({ title, reason });
    const hook = clean(o.hook);
    const centralQuestion = clean(o.centralQuestion);
    if (!clean(o.title) || !hook || !centralQuestion || !clean(o.standalonePremise)) {
      remove('incomplete: a title, hook, central question and standalone premise are required');
      continue;
    }

    // Traceability: architecture beats → their sequences → the approved dossier.
    const beatIds = [...new Set(o.beatIds.map((b) => b.trim()).filter(Boolean))];
    const missing = beatIds.filter((b) => !beats.has(b));
    if (beatIds.length === 0 || missing.length) {
      remove(beatIds.length === 0 ? 'not traceable: it names no architecture beat' : `not traceable: beat ${missing.join(', ')} does not exist in the architecture`);
      continue;
    }
    const sources = beatIds.map((b) => beats.get(b)!);
    const sequences = [...new Map(sources.map((x) => [x.sequence.number, x.sequence])).values()].sort((a, b) => a.number - b.number);
    const allowed = new Set([...sources.flatMap((x) => x.beat.claimKeys), ...sequences.flatMap((s) => [...s.claimKeys, ...s.contextClaims.map((c) => c.claimKey)])]);
    const cited = o.claimKeys.map((k) => k.trim()).filter(Boolean);
    const unknown = cited.filter((k) => !evidence.has(k));
    if (unknown.length) {
      remove(`cites ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the approved dossier`);
      continue;
    }
    const outside = cited.filter((k) => !allowed.has(k));
    if (outside.length) {
      remove(`uses ${outside.join(', ')}, which ${outside.length === 1 ? 'is' : 'are'} not in its beats or their sequences`);
      continue;
    }
    const claims = new Set(cited.length ? cited : sources.flatMap((x) => x.beat.claimKeys));
    if (claims.size === 0) {
      remove('its beats cite no claim, so nothing in it traces to the evidence');
      continue;
    }

    const cast = [...new Set(o.castIds.map((c) => c.trim()).filter(Boolean))];
    const undeclared = cast.filter((c) => !castIds.has(c));
    if (undeclared.length) {
      remove(`uses the cast id ${undeclared.join(', ')}, which the architecture does not declare`);
      continue;
    }

    const opportunityNotes: string[] = [];
    const texts = [title, hook, centralQuestion, o.standalonePremise, o.angle, o.escalation, o.payoff, o.suggestedEnding, o.visualConcept, o.contextNote, o.whyItWorks].map(clean);

    // No new facts.
    const figures = checkFigures(texts, [...claims], evidence, { linkFrom: [...allowed], strictYears: true });
    if (figures.unsupported.length) {
      remove(`uses figures that are not in its evidence: ${figures.unsupported.join(', ')}`);
      continue;
    }
    for (const link of figures.links) {
      for (const k of link.claimKeys) claims.add(k);
      opportunityNotes.push(`linked ${link.claimKeys.join(', ')} (source of the figure ${link.figure})`);
    }
    const outsidePeopleNamed = peopleMentioned(texts, outsiders);
    if (outsidePeopleNamed.length) {
      remove(`names ${outsidePeopleNamed.join(', ')}, who is not in the selected units' evidence`);
      continue;
    }
    const unknownNames = unknownProperNouns(texts.join('\n'), known);
    if (unknownNames.length) {
      remove(`names ${unknownNames.join(', ')}, which neither the evidence nor the declared cast knows`);
      continue;
    }
    const claimList = orderedKeys(claims, evidence);
    const inventedLines = sources.flatMap((x) => x.beat.speech.filter((s) => s.kind === 'INVENTED').map((s) => s.text));
    const evidenceText = evidence.textFor(claimList);
    const fakeQuote = quotedPassages(texts.join('\n')).find(
      (q) => !claimList.some((k) => evidence.verifiedQuotes(k).some((v) => quoteFoundIn(q, v))) && !quoteFoundIn(q, evidenceText) && !inventedLines.some((l) => quoteFoundIn(q, l) || quoteFoundIn(l, q)),
    );
    if (fakeQuote) {
      remove(`puts "${fakeQuote}" in quotation marks, but it is neither a verified quotation nor one of the architecture's invented lines`);
      continue;
    }

    // Presentation: the architecture's instructions for every claim that is not ESTABLISHED.
    const presentation: ClaimPresentation[] = [];
    for (const k of claimList) {
      const verdict = evidence.claim(k)!.verdict;
      if (verdict === 'ESTABLISHED') continue;
      const fromArchitecture = sequences.flatMap((s) => s.presentation).find((p) => p.claimKey === k) ?? content.sequences.flatMap((s) => s.presentation).find((p) => p.claimKey === k);
      if (fromArchitecture) presentation.push(fromArchitecture);
      else {
        presentation.push({ claimKey: k, presentation: PRESENTATION_FOR_VERDICT[verdict], instruction: `Present as ${verdict.toLowerCase()} material (${PRESENTATION_FOR_VERDICT[verdict]}).` });
        opportunityNotes.push(`${k} (${verdict}): no instruction in the architecture; the default for its verdict applies`);
      }
    }

    // Format.
    const format = o.format;
    let targetDurationSec: number | null = Number.isFinite(o.targetDurationSec) && o.targetDurationSec > 0 ? Math.round(o.targetDurationSec) : null;
    if (format === 'LONG_FORM') {
      if (targetDurationSec !== null && targetDurationSec < CONTENT_LIMITS.longFormMinSec) {
        opportunityNotes.push(`target ${targetDurationSec}s is too short for long-form; left open`);
        targetDurationSec = null;
      }
    } else {
      const { minSec, maxSec, defaultSec } = CONTENT_LIMITS.short;
      const asked = targetDurationSec;
      targetDurationSec = asked === null ? defaultSec : Math.min(maxSec, Math.max(minSec, asked));
      if (asked !== targetDurationSec) opportunityNotes.push(asked === null ? `no target duration; ${defaultSec}s assumed` : `target ${asked}s brought within ${minSec}–${maxSec}s`);
    }
    let requiresContext = o.requiresContext;
    if (!o.independent && !requiresContext) {
      requiresContext = true;
      opportunityNotes.push('not independent, so it requires context');
    }

    const scores: OpportunityScores = {
      hook: clamp(o.hookScore),
      payoff: clamp(o.payoffScore),
      standalone: clamp(o.standaloneScore),
      visual: clamp(o.visualScore),
      emotion: clamp(o.emotionScore),
      pace: clamp(o.paceScore),
    };
    const shortScore = format === 'LONG_FORM' ? null : shortPotential(scores);
    const verdicts = claimList.map((k) => evidence.claim(k)!.verdict);
    const candidateKeys = [...new Set(sequences.flatMap((s) => s.candidateKeys))];
    const built = {
      format,
      shortScore,
      title,
      hook,
      centralQuestion,
      targetDurationSec,
      independent: o.independent,
      requiresContext,
      historicalStatus: historicalStatusOf(verdicts),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(claimList)),
      sortScore: shortScore ?? -1,
      content: {
        standalonePremise: clean(o.standalonePremise),
        angle: clean(o.angle),
        escalation: clean(o.escalation),
        payoff: clean(o.payoff),
        suggestedEnding: clean(o.suggestedEnding),
        visualConcept: clean(o.visualConcept),
        contextNote: clean(o.contextNote),
        beatIds,
        sequenceNumbers: sequences.map((s) => s.number),
        candidateKeys,
        candidateIds: [...new Set(sequences.flatMap((s) => s.candidateIds))],
        claimKeys: claimList,
        sourceIds: evidence.sourcesFor(claimList),
        castIds: cast,
        presentation,
        scores,
        whyItWorks: clean(o.whyItWorks),
        notes: opportunityNotes,
      },
    };

    // Duplicates within a format family only: a short and a long-form thread may share beats.
    const family = (f: ContentFormat) => (f === 'LONG_FORM' ? 'long' : 'short');
    const duplicate = kept.find((k) => family(k.format) === family(format) && (k.content.beatIds.join() === beatIds.join() || titleSimilarity(k.title, title) >= 0.85));
    if (duplicate) {
      remove(`duplicates "${duplicate.title}"`);
      continue;
    }
    kept.push(built);
  }

  // Shorts by short-form potential (then evidence, then title); long-form after them. Quality over quantity: never padded.
  const shorts = kept.filter((k) => k.format !== 'LONG_FORM').sort((a, b) => b.sortScore - a.sortScore || b.historicalConfidence - a.historicalConfidence || a.title.localeCompare(b.title));
  const longForm = kept.filter((k) => k.format === 'LONG_FORM').sort((a, b) => b.historicalConfidence - a.historicalConfidence || a.title.localeCompare(b.title));
  const ordered = [...shorts, ...longForm];
  for (const o of ordered.slice(CONTENT_LIMITS.maxOpportunities)) removed.push({ title: o.title, reason: `beyond the limit of ${CONTENT_LIMITS.maxOpportunities} opportunities (weakest)` });
  const final = ordered.slice(0, CONTENT_LIMITS.maxOpportunities);
  let rank = 0;
  const opportunities: BuiltOpportunity[] = final.map((o, i) => {
    const { sortScore: _s, ...rest } = o;
    return { ...rest, key: `O${String(i + 1).padStart(2, '0')}`, rank: o.format === 'LONG_FORM' ? null : ++rank };
  });
  if (raw.opportunities.length > 0) notes.push(`Content opportunities: ${raw.opportunities.length} proposed, ${opportunities.length} kept (${shorts.length} short-form), ${removed.length} removed`);
  return { opportunities, removed, notes };
}
