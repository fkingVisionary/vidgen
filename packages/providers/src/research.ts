import type { SourceType } from '@docengine/core';
import type { CallMeta, ProviderInfo } from './types.ts';

export interface ResearchQuery {
  query: string;
  maxResults?: number;
  /** Preferred language of results (ISO 639-1). */
  language?: string;
  /** Relevance vs. latency/cost. Historical research uses 'advanced'. */
  depth?: 'basic' | 'advanced';
  /** Rank these domains higher without excluding the rest of the web. */
  preferDomains?: string[];
  /** Never return results from these domains. */
  excludeDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  /** Search-engine excerpt. Good for triage; NEVER sufficient evidence for a claim. */
  snippet: string;
  /** Provider relevance score (0–1 where available). */
  score?: number;
  publishedDate?: string;
  /** Provider's guess; the research stage decides the final SourceType. */
  sourceTypeHint?: SourceType;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: CallMeta;
}

export interface FetchedDocument {
  url: string;
  title?: string;
  /** e.g. text/markdown */
  contentType: string;
  text: string;
}

export interface FetchResponse {
  documents: FetchedDocument[];
  /** Every requested URL appears exactly once, in `documents` or here. */
  failed: { url: string; error: string }[];
  meta: CallMeta;
}

/**
 * Discovers and retrieves sources. V1 implementation: Tavily. Evaluating the
 * evidence is the research *stage's* job (with the AIProvider), not this one's.
 */
export interface ResearchProvider {
  readonly info: ProviderInfo;
  /** Largest number of URLs `fetchDocuments` accepts per call. */
  readonly maxBatchSize: number;
  search(query: ResearchQuery): Promise<SearchResponse>;
  fetchDocuments(urls: string[], opts?: { depth?: 'basic' | 'advanced' }): Promise<FetchResponse>;
}
