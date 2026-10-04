import type { FetchedDocument, ResearchProvider, ResearchQuery, SearchResponse } from '../research.ts';
import { ProviderError } from '../types.ts';
import { MOCK_FAIL_MARKER, MOCK_LABEL, mockInfo, mockMeta } from './common.ts';

/**
 * MOCK research. Results point at the reserved `.invalid` domain, which can
 * never resolve, so a mock "source" can never be mistaken for a citation.
 */
export class MockResearchProvider implements ResearchProvider {
  readonly info = mockInfo('RESEARCH');

  async search(query: ResearchQuery): Promise<SearchResponse> {
    if (query.query.includes(MOCK_FAIL_MARKER)) throw new ProviderError('mock', 'Simulated search failure', true);
    const n = Math.min(query.maxResults ?? 3, 10);
    const slug = encodeURIComponent(query.query.slice(0, 60));
    return {
      results: Array.from({ length: n }, (_, i) => ({
        title: `[${MOCK_LABEL}] Result ${i + 1} for "${query.query}"`,
        url: `https://mock.invalid/search/${slug}/${i + 1}`,
        snippet: `${MOCK_LABEL} search result. No research was performed and this is not a source.`,
        sourceTypeHint: 'GENERAL_REFERENCE' as const,
      })),
      meta: mockMeta([{ unit: 'REQUESTS', quantity: 1 }]),
    };
  }

  async fetchDocument(url: string): Promise<FetchedDocument> {
    return {
      url,
      title: `[${MOCK_LABEL}] Document`,
      contentType: 'text/plain',
      text: `${MOCK_LABEL} document for ${url}. No content was fetched.`,
      meta: mockMeta([{ unit: 'REQUESTS', quantity: 1 }]),
    };
  }
}
