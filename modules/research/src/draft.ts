import {
  HIGH_TIER_SOURCE_TYPES,
  SOURCE_TIER,
  type CitationBasis,
  type CitationStance,
  type ClaimImportance,
  type ClaimType,
  type ClaimVerdict,
  type ConfidenceLevel,
  type ResearchDossierContent,
  type ResearchQuestion,
  type SourceType,
} from '@docengine/core';
import type { EvidenceKind, SynthesisOutput } from './schemas.ts';

/** In-memory dossier, built from the synthesis and checked before anything is written. */

export interface DraftSource {
  id: string;
  key: string;
  url: string;
  domain: string;
  sourceType: SourceType;
  retrieved: boolean;
  duplicateOfId: string | null;
}

export interface EvidenceRecord {
  id: string; // "S12.E3"
  sourceId: string;
  focusAreas: string[];
  statement: string;
  quote: string;
  locator: string | null;
  kind: EvidenceKind;
  attribution: string;
  verified: boolean;
}

export interface DraftCitation {
  evidenceId: string;
  sourceId: string;
  stance: CitationStance;
  basis: CitationBasis;
  quote: string;
  locator: string | null;
  quoteVerified: boolean;
}

export interface DraftClaim {
  key: string;
  statement: string;
  claimType: ClaimType;
  category: string;
  importance: ClaimImportance;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  popularVersion: string | null;
  notes: string;
  needsVerification: boolean;
  citations: DraftCitation[];
}

export interface DossierDraft {
  summary: string;
  content: ResearchDossierContent;
  claims: DraftClaim[];
}

/** Turns the synthesis into a draft, resolving evidence IDs to citations. Unknown IDs are dropped and reported. */
export function buildDraft(
  synthesis: SynthesisOutput,
  evidence: ReadonlyMap<string, EvidenceRecord>,
  plan: { id: string; category: string; question: string; rationale: string; queries: string[] }[],
): { draft: DossierDraft; notes: string[] } {
  const notes: string[] = [];
  const answers = new Map(synthesis.questionAnswers.map((a) => [a.questionId, a]));

  const claims: DraftClaim[] = synthesis.claims.map((c) => {
    const citations: DraftCitation[] = [];
    const add = (ids: string[], stance: CitationStance) => {
      for (const id of ids) {
        const e = evidence.get(id.trim());
        if (!e) {
          notes.push(`${c.key}: dropped citation to unknown evidence ID "${id}"`);
          continue;
        }
        const existing = citations.find((x) => x.evidenceId === e.id);
        if (existing) {
          if (existing.stance !== stance) notes.push(`${c.key}: evidence ${e.id} cited both as ${existing.stance} and ${stance}; kept ${existing.stance}`);
          continue;
        }
        citations.push({ evidenceId: e.id, sourceId: e.sourceId, stance, basis: 'FULL_TEXT', quote: e.quote, locator: e.locator, quoteVerified: e.verified });
      }
    };
    add(c.contradictingEvidence, 'CONTRADICTS');
    add(c.supportingEvidence, 'SUPPORTS');
    add(c.contextEvidence, 'CONTEXT');
    return {
      key: c.key.trim(),
      statement: c.statement.trim(),
      claimType: c.claimType,
      category: c.questionId,
      importance: c.importance,
      verdict: c.verdict,
      confidence: c.confidence,
      popularVersion: c.popularVersion?.trim() || null,
      notes: c.notes.trim(),
      needsVerification: c.needsVerification,
      citations,
    };
  });

  const questions: ResearchQuestion[] = plan.map((q) => ({
    id: q.id,
    category: q.category,
    question: q.question,
    rationale: q.rationale,
    queries: q.queries,
    answerSummary: answers.get(q.id)?.answerSummary ?? null,
    confidence: answers.get(q.id)?.confidence ?? null,
  }));

  const { summary, timeline, keyFigures, priceEvidence, myths, interpretations, bubbleAssessment, narrativeHistory, openQuestions, missingEvidence } = synthesis;
  return {
    draft: {
      summary,
      claims,
      content: { questions, timeline, keyFigures, priceEvidence, myths, interpretations, bubbleAssessment, narrativeHistory, openQuestions, missingEvidence },
    },
    notes,
  };
}

const isHighTier = (t: SourceType) => HIGH_TIER_SOURCE_TYPES.includes(t);

/**
 * Deterministic rules applied after the model (and after automatic review
 * fixes): the model proposes verdicts, these rules make sure no verdict
 * claims more certainty than its citations allow. Every change is reported.
 */
export function normalizeDraft(draft: DossierDraft, sources: ReadonlyMap<string, DraftSource>): string[] {
  const notes: string[] = [];

  // 1. Unique claim keys.
  const seenKeys = new Set<string>();
  for (const c of draft.claims) {
    if (!c.key || seenKeys.has(c.key)) {
      const old = c.key;
      let n = draft.claims.length + 1;
      while (seenKeys.has(`C${String(n).padStart(3, '0')}`)) n++;
      c.key = `C${String(n).padStart(3, '0')}`;
      notes.push(`Duplicate or empty claim key "${old}" renamed to ${c.key}`);
    }
    seenKeys.add(c.key);
  }

  for (const c of draft.claims) {
    // 2. Citations must point at a retrieved, canonical source with a verified quote.
    const kept: DraftCitation[] = [];
    for (const cit of c.citations) {
      let src = sources.get(cit.sourceId);
      if (src?.duplicateOfId) {
        const canonical = sources.get(src.duplicateOfId);
        if (canonical) {
          notes.push(`${c.key}: citation moved from duplicate ${src.key} to ${canonical.key}`);
          cit.sourceId = canonical.id;
          src = canonical;
        }
      }
      if (!src || !src.retrieved) {
        notes.push(`${c.key}: dropped citation ${cit.evidenceId} (source not retrieved)`);
        continue;
      }
      if (!cit.quoteVerified || cit.basis !== 'FULL_TEXT') {
        notes.push(`${c.key}: dropped citation ${cit.evidenceId} (quote not verified against full text)`);
        continue;
      }
      if (kept.some((k) => k.evidenceId === cit.evidenceId)) continue;
      kept.push(cit);
    }
    c.citations = kept;

    const supports = kept.filter((x) => x.stance === 'SUPPORTS');
    const contra = kept.filter((x) => x.stance === 'CONTRADICTS');
    const supportSources = new Set(supports.map((x) => x.sourceId));
    const typeOf = (id: string) => sources.get(id)!.sourceType;

    // 3. Verdict rules.
    const demote = (to: ClaimVerdict, why: string) => {
      notes.push(`${c.key}: ${c.verdict} → ${to} (${why})`);
      c.verdict = to;
    };
    if (c.verdict === 'MYTH') {
      if (contra.length === 0) demote('UNVERIFIED', 'a myth needs contradicting evidence');
      else if (!c.popularVersion) c.popularVersion = c.statement;
    } else if (c.verdict !== 'UNVERIFIED' && supports.length === 0 && contra.length === 0) {
      demote('UNVERIFIED', 'no verified citation');
    } else if ((c.verdict === 'ESTABLISHED' || c.verdict === 'PROBABLE') && supports.length === 0) {
      demote('DISPUTED', 'cited only with contradicting evidence');
    } else if (c.verdict === 'ESTABLISHED') {
      const strongContra = contra.some((x) => SOURCE_TIER[typeOf(x.sourceId)] <= 2);
      if (strongContra) demote('DISPUTED', 'contradicted by a primary, scholarly or reputable source');
      else if (!(supportSources.size >= 2 || [...supportSources].some((id) => isHighTier(typeOf(id))))) {
        demote('PROBABLE', 'needs two independent sources or one primary/academic/book/archive source');
      }
    }
    if (c.verdict === 'UNVERIFIED' || c.verdict === 'DISPUTED') c.needsVerification = true;
  }

  // 4. Section references must resolve; facts in narrative sections must rest on claims.
  const keys = new Set(draft.claims.map((c) => c.key));
  let dangling = 0;
  const clean = (ks: string[]) => {
    const out = ks.map((k) => k.trim()).filter((k) => keys.has(k));
    dangling += ks.length - out.length;
    return out;
  };
  const content = draft.content;
  const requireClaims = <T extends { claimKeys: string[] }>(name: string, entries: T[]): T[] =>
    entries
      .map((e) => ({ ...e, claimKeys: clean(e.claimKeys) }))
      .filter((e) => {
        if (e.claimKeys.length > 0) return true;
        notes.push(`${name}: removed an entry that rests on no claim`);
        return false;
      });
  content.timeline = requireClaims('timeline', content.timeline);
  content.keyFigures = requireClaims('keyFigures', content.keyFigures);
  content.priceEvidence = requireClaims('priceEvidence', content.priceEvidence);
  content.myths = requireClaims('myths', content.myths);
  content.interpretations = requireClaims('interpretations', content.interpretations);
  content.openQuestions = content.openQuestions.map((q) => ({ ...q, claimKeys: clean(q.claimKeys) }));
  content.bubbleAssessment = { ...content.bubbleAssessment, claimKeys: clean(content.bubbleAssessment.claimKeys) };
  content.narrativeHistory = { ...content.narrativeHistory, claimKeys: clean(content.narrativeHistory.claimKeys) };
  if (dangling > 0) notes.push(`Removed ${dangling} section reference(s) to claims that do not exist`);

  return notes;
}
