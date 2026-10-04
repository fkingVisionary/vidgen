import type { SourceType } from '@docengine/core';
import type { CallMeta, ProviderInfo } from './types.ts';

export interface ResearchQuery {
  query: string;
  maxResults?: number;
  /** Preferred language of results. */
  language?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
  contentType: string;
  text: string;
  meta: CallMeta;
}

/**
 * Finds and retrieves sources. Planned implementations: Claude's server-side
 * web search/fetch tools, or a search API (Exa, Tavily). Synthesis of a
 * dossier is the research *stage's* job, using the AIProvider.
 */
export interface ResearchProvider {
  readonly info: ProviderInfo;
  search(query: ResearchQuery): Promise<SearchResponse>;
  fetchDocument(url: string): Promise<FetchedDocument>;
}
