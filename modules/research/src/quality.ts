import { HIGH_TIER_SOURCE_TYPES, SOURCE_TIER, type CoherenceIssue, type QualityCheck, type QualityReport } from '@docengine/core';
import type { QualityThresholds } from './config.ts';
import type { DossierDraft, DraftSource } from './draft.ts';
import { isValidSourceUrl } from './urls.ts';

/**
 * The research quality gate. Pure function of the (normalised) draft, so
 * every rule is unit-tested. FAIL blocks RESEARCH_REVIEW; WARN is shown to
 * the human reviewer. Passing never approves anything.
 */
export function computeQualityReport(args: {
  draft: DossierDraft;
  sources: ReadonlyMap<string, DraftSource>;
  thresholds: QualityThresholds;
  normalizations: string[];
  coherenceIssues: CoherenceIssue[];
  /** Duplicate sources detected (by URL or content) during retrieval. */
  duplicatesDetected: number;
  now?: Date;
}): QualityReport {
  const { draft, sources, thresholds: t } = args;
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, ok: boolean | 'warn', detail: string, metric: number | null = null, threshold: number | null = null) =>
    checks.push({ id, label, status: ok === 'warn' ? 'WARN' : ok ? 'PASS' : 'FAIL', detail, metric, threshold });

  const claims = draft.claims;
  const citations = claims.flatMap((c) => c.citations.map((cit) => ({ claim: c, cit })));
  const citedIds = new Set(citations.map((x) => x.cit.sourceId));
  const cited = [...citedIds].map((id) => sources.get(id)).filter((s): s is DraftSource => !!s);
  const evidenceCitations = citations.filter((x) => x.cit.stance !== 'CONTEXT');

  // Volume
  const keyClaims = claims.filter((c) => c.importance === 'KEY');
  add('claim_count', 'Enough claims', claims.length >= t.minClaims && keyClaims.length >= t.minKeyClaims,
    `${claims.length} claims (${keyClaims.length} key); need ≥ ${t.minClaims} and ≥ ${t.minKeyClaims} key`, claims.length, t.minClaims);

  // Sources
  add('min_sources', 'Minimum source count', cited.length >= t.minCitedSources,
    `${cited.length} distinct sources cited; need ≥ ${t.minCitedSources}`, cited.length, t.minCitedSources);
  const highTier = cited.filter((s) => HIGH_TIER_SOURCE_TYPES.includes(s.sourceType));
  add('high_tier_sources', 'Primary / scholarly / book / archive sources', highTier.length >= t.minHighTierSources,
    `${highTier.length} high-tier sources cited; need ≥ ${t.minHighTierSources}`, highTier.length, t.minHighTierSources);
  const types = new Set(cited.map((s) => s.sourceType));
  const domains = new Set(cited.map((s) => s.domain));
  add('source_diversity', 'Source diversity', types.size >= t.minSourceTypes && domains.size >= t.minDomains,
    `${types.size} source types (need ≥ ${t.minSourceTypes}), ${domains.size} domains (need ≥ ${t.minDomains})`, domains.size, t.minDomains);
  const web = evidenceCitations.filter((x) => sources.get(x.cit.sourceId)?.sourceType === 'GENERAL_WEB').length;
  const webShare = evidenceCitations.length ? web / evidenceCitations.length : 0;
  add('general_web_share', 'Not built on general-web pages',
    webShare > t.generalWebShare.fail ? false : webShare > t.generalWebShare.warn ? 'warn' : true,
    `${Math.round(webShare * 100)}% of evidence citations come from GENERAL_WEB (warn > ${t.generalWebShare.warn * 100}%, fail > ${t.generalWebShare.fail * 100}%)`,
    Math.round(webShare * 1000) / 1000, t.generalWebShare.fail);

  // Citations
  const uncited = claims.filter((c) => c.verdict !== 'UNVERIFIED' && c.citations.filter((x) => x.stance !== 'CONTEXT').length === 0);
  add('claims_cited', 'Every claim (other than UNVERIFIED) has citations', uncited.length === 0,
    uncited.length ? `Uncited: ${uncited.map((c) => c.key).join(', ')}` : 'All verified-status claims cite evidence', uncited.length, 0);
  const keyWeak = keyClaims.filter((c) => c.verdict !== 'UNVERIFIED' && !c.citations.some((x) => x.stance !== 'CONTEXT' && x.basis === 'FULL_TEXT' && x.quoteVerified));
  add('key_claims_full_text', 'No key claim rests on a search snippet', keyWeak.length === 0,
    keyWeak.length ? `Key claims without a verified full-text citation: ${keyWeak.map((c) => c.key).join(', ')}` : 'Every key claim cites a quote verified against the retrieved document', keyWeak.length, 0);
  const snippetOrUnverified = citations.filter((x) => x.cit.basis !== 'FULL_TEXT' || !x.cit.quoteVerified);
  add('quotes_verified', 'All citation quotes verified in retrieved text', snippetOrUnverified.length === 0,
    `${citations.length - snippetOrUnverified.length}/${citations.length} citation quotes verified verbatim`, snippetOrUnverified.length, 0);
  const keyUnverified = keyClaims.filter((c) => c.verdict === 'UNVERIFIED');
  if (keyUnverified.length) {
    add('key_claims_unverified', 'Key claims awaiting evidence', 'warn',
      `${keyUnverified.length} key claim(s) are UNVERIFIED: ${keyUnverified.map((c) => c.key).join(', ')}`, keyUnverified.length, 0);
  }

  // Flags
  // A popular page "contradicting" an established fact is how a myth looks; only strong counter-evidence
  // (primary, scholarly, book, archive or reputable secondary) obliges a DISPUTED/MYTH flag.
  const strong = (id: string) => {
    const type = sources.get(id)?.sourceType;
    return type !== undefined && SOURCE_TIER[type] <= 2;
  };
  const conflicted = claims.filter((c) => c.citations.some((x) => x.stance === 'SUPPORTS') && c.citations.some((x) => x.stance === 'CONTRADICTS' && strong(x.sourceId)));
  const conflictedUnflagged = conflicted.filter((c) => !['DISPUTED', 'MYTH'].includes(c.verdict) && !(c.verdict === 'PROBABLE' && c.notes.length > 0));
  add('disputes_flagged', 'Conflicting evidence is flagged', conflictedUnflagged.length === 0,
    conflictedUnflagged.length ? `Strong counter-evidence not marked DISPUTED/MYTH: ${conflictedUnflagged.map((c) => c.key).join(', ')}` : `${conflicted.length} claim(s) with strong conflicting evidence, all flagged`, conflictedUnflagged.length, 0);
  const disputedUnflagged = claims.filter((c) => c.verdict === 'DISPUTED' && (!c.needsVerification || c.notes.length === 0));
  add('disputed_explained', 'Disputed claims flagged and explained', disputedUnflagged.length === 0,
    disputedUnflagged.length ? `Missing flag/explanation: ${disputedUnflagged.map((c) => c.key).join(', ')}` : `${claims.filter((c) => c.verdict === 'DISPUTED').length} disputed claim(s), all flagged with notes`, disputedUnflagged.length, 0);
  const unverifiedUnflagged = claims.filter((c) => c.verdict === 'UNVERIFIED' && !c.needsVerification);
  add('unverified_flagged', 'Unverified claims flagged', unverifiedUnflagged.length === 0,
    `${claims.filter((c) => c.verdict === 'UNVERIFIED').length} unverified claim(s); ${unverifiedUnflagged.length} not flagged`, unverifiedUnflagged.length, 0);
  const badMyths = claims.filter((c) => c.verdict === 'MYTH' && (!c.popularVersion || !c.citations.some((x) => x.stance === 'CONTRADICTS')));
  add('myths_evidenced', 'Myths state the popular version and the counter-evidence', badMyths.length === 0,
    badMyths.length ? `Incomplete: ${badMyths.map((c) => c.key).join(', ')}` : `${claims.filter((c) => c.verdict === 'MYTH').length} myth(s), each with counter-evidence`, badMyths.length, 0);
  const popular = claims.filter((c) => c.popularVersion).length;
  add('popular_version_recorded', 'Popular version documented', popular > 0 ? true : 'warn',
    `${popular} claim(s) record what is commonly claimed`, popular, 1);

  // Sources: URLs and duplicates
  const badUrls = cited.filter((s) => !isValidSourceUrl(s.url) || !s.retrieved);
  add('valid_urls', 'Cited source URLs valid and retrieved', badUrls.length === 0,
    badUrls.length ? `Invalid or unretrieved: ${badUrls.map((s) => s.key).join(', ')}` : `${cited.length} cited URLs valid and retrieved`, badUrls.length, 0);
  const citedDuplicates = cited.filter((s) => s.duplicateOfId);
  add('duplicates', 'Duplicate sources detected and merged', citedDuplicates.length === 0,
    `${args.duplicatesDetected} duplicate source(s) detected; ${citedDuplicates.length} still cited as separate sources`, args.duplicatesDetected, null);

  // Coherence
  const keys = new Set(claims.map((c) => c.key));
  const c = draft.content;
  const refs = [
    ...c.timeline, ...c.keyFigures, ...c.priceEvidence, ...c.myths, ...c.interpretations, ...c.openQuestions, c.bubbleAssessment, c.narrativeHistory,
  ].flatMap((e) => e.claimKeys);
  const dangling = refs.filter((k) => !keys.has(k));
  const mythTimeline = c.timeline.filter((e) => e.claimKeys.every((k) => claims.find((x) => x.key === k)?.verdict === 'MYTH'));
  const unresolved = args.coherenceIssues.filter((i) => i.severity === 'CRITICAL' && !i.resolution.startsWith('Applied'));
  const majors = args.coherenceIssues.filter((i) => i.severity === 'MAJOR' && !i.resolution.startsWith('Applied'));
  const coherent = dangling.length === 0 && mythTimeline.length === 0 && unresolved.length === 0;
  add('internally_coherent', 'Dossier internally coherent', coherent ? (majors.length ? 'warn' : true) : false,
    [
      dangling.length ? `${dangling.length} dangling claim reference(s)` : null,
      mythTimeline.length ? `${mythTimeline.length} timeline event(s) rest only on MYTH claims` : null,
      `${args.coherenceIssues.length} review issue(s): ${unresolved.length} critical unresolved, ${majors.length} major left for review`,
    ].filter(Boolean).join('; '), unresolved.length, 0);
  const questions = c.questions;
  const uncovered = questions.filter((q) => !claims.some((cl) => cl.category === q.id));
  add('question_coverage', 'Every research question answered by claims',
    uncovered.length === 0 ? true : uncovered.length <= Math.floor(questions.length / 3) ? 'warn' : false,
    uncovered.length ? `No claims for: ${uncovered.map((q) => q.id).join(', ')}` : `All ${questions.length} questions have claims`, uncovered.length, 0);

  return {
    passed: checks.every((x) => x.status !== 'FAIL'),
    generatedAt: (args.now ?? new Date()).toISOString(),
    checks,
    normalizations: args.normalizations,
    coherenceIssues: args.coherenceIssues,
  };
}
