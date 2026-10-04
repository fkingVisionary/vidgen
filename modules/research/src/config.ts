import type { ReasoningEffort } from '@docengine/providers';

/**
 * Research stage settings. Defaults are tuned for a 10–15 minute economic
 * history documentary; every limit is explicit so cost and depth are
 * predictable.
 */
export interface ResearchConfig {
  /** Research questions the plan may contain. */
  maxQuestions: number;
  /** Search results requested per query. */
  resultsPerQuery: number;
  searchConcurrency: number;
  /** Upper bound of sources whose full text is retrieved and read. */
  maxSourcesToRetrieve: number;
  /** Diversity: at most this many retrieved sources from one domain. */
  maxPerDomain: number;
  readConcurrency: number;
  /** Characters of each document given to the model (longer documents are cut to their most topic-relevant passages, and recorded as such). */
  maxDocumentChars: number;
  /** Retrieved pages shorter than this are treated as failed retrievals (paywalls, stubs). */
  minDocumentChars: number;
  /** High-tier sources that failed retrieval for which an open-access copy is searched (one search each). */
  maxOpenAccessLookups: number;
  /** Abort the run if its recorded provider cost exceeds this (USD, estimated). */
  maxCostUsd: number;
  effort: { plan: ReasoningEffort; triage: ReasoningEffort; read: ReasoningEffort; synthesize: ReasoningEffort; review: ReasoningEffort };
  gate: QualityThresholds;
}

export interface QualityThresholds {
  minClaims: number;
  minKeyClaims: number;
  /** Distinct (non-duplicate) sources cited by at least one claim. */
  minCitedSources: number;
  /** Cited sources of type PRIMARY / ACADEMIC / BOOK / ARCHIVE. */
  minHighTierSources: number;
  minSourceTypes: number;
  minDomains: number;
  /** Share of evidence citations coming from GENERAL_WEB: warn above, fail above `fail`. */
  generalWebShare: { warn: number; fail: number };
}

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
  maxQuestions: 12,
  resultsPerQuery: 8,
  searchConcurrency: 4,
  maxSourcesToRetrieve: 45,
  maxPerDomain: 3,
  readConcurrency: 4,
  maxDocumentChars: 100_000,
  minDocumentChars: 600,
  maxOpenAccessLookups: 10,
  maxCostUsd: 40,
  effort: { plan: 'high', triage: 'medium', read: 'medium', synthesize: 'high', review: 'high' },
  gate: {
    minClaims: 25,
    minKeyClaims: 8,
    minCitedSources: 12,
    minHighTierSources: 4,
    minSourceTypes: 3,
    minDomains: 8,
    generalWebShare: { warn: 0.25, fail: 0.4 },
  },
};

/**
 * Generic focus areas for historical/economic topics. The plan turns them
 * into topic-specific questions; a project can add its own brief
 * (project.metadata.researchBrief).
 */
export const DEFAULT_FOCUS_AREAS = [
  'What actually happened, separated from later retellings',
  'Chronology: a dated sequence of events, with uncertain dates flagged',
  'The thing being traded or valued: what it was, why it was valued, supply and rarity',
  'Economic and social context of the place and period',
  'Participants: who took part, their social background, the scale of participation',
  'Mechanisms: how trading actually worked (venues, contracts, credit, settlement)',
  'Price and quantitative evidence, and where each famous number comes from',
  'The best-known stories and anecdotes: their origin and reliability',
  'The turning point or collapse: what happened, when, and why',
  'Consequences: what changed, what did not, short and long term',
  'Interpretation: what historians and economists dispute; whether common labels (e.g. "bubble", "mania") are deserved',
  'The later narrative: how the story was retold, how myths formed, and claims of modern relevance',
] as const;
