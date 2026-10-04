import type { Rate, UsageItem } from '@docengine/core';
import type { FetchResponse, ResearchProvider, ResearchQuery, SearchResponse, SearchResult } from '../research.ts';
import { ProviderError, type CallMeta, type ProviderInfo } from '../types.ts';

/**
 * Tavily (https://docs.tavily.com) — web search and full-text extraction.
 *
 * The only place in the codebase that knows Tavily's HTTP API. Pricing is
 * credit-based (checked 2026-10-04, docs.tavily.com/documentation/api-credits):
 *   search: basic 1 credit, advanced 2 credits per request
 *   extract: basic 1 credit / advanced 2 credits per 5 successful URLs
 *   pay-as-you-go $0.008/credit; monthly plans $0.005–$0.0075/credit.
 * Tavily reports credits (`include_usage`) but not dollars, so every cost is
 * recorded as an ESTIMATE = reported credits × configured $/credit.
 */

export interface TavilyOptions {
  apiKey?: string;
  /** Free, rate-limited access with no key (`X-Tavily-Access-Mode: keyless`). */
  keyless?: boolean;
  usdPerCredit: number;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const PRICING_SOURCE = 'docs.tavily.com/documentation/api-credits (checked 2026-10-04)';
const MAX_EXTRACT_URLS = 20;

interface TavilySearchResponse {
  results?: { title?: string; url: string; content?: string; score?: number; published_date?: string | null }[];
  usage?: { credits?: number };
  request_id?: string;
  response_time?: number;
}

interface TavilyExtractResponse {
  results?: { url: string; raw_content?: string | null }[];
  failed_results?: { url: string; error?: string }[];
  usage?: { credits?: number };
  request_id?: string;
}

export class TavilyResearchProvider implements ResearchProvider {
  readonly info: ProviderInfo;
  readonly maxBatchSize = MAX_EXTRACT_URLS;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: TavilyOptions) {
    if (!opts.apiKey && !opts.keyless) {
      throw new ProviderError('tavily', 'TAVILY_API_KEY is not set (or set TAVILY_ACCESS_MODE=keyless for free, rate-limited access)', false);
    }
    if (!(opts.usdPerCredit >= 0)) throw new ProviderError('tavily', 'usdPerCredit must be ≥ 0', false);
    const usdPerUnit = opts.apiKey ? opts.usdPerCredit : 0; // keyless access is free
    const rates: Rate[] = [{ provider: 'tavily', unit: 'CREDITS', usdPerUnit, source: opts.apiKey ? PRICING_SOURCE : 'keyless access (free)' }];
    this.info = { kind: 'RESEARCH', name: 'tavily', mock: false, rates };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async search(q: ResearchQuery): Promise<SearchResponse> {
    const depth = q.depth ?? 'advanced';
    const body: Record<string, unknown> = {
      query: q.query,
      search_depth: depth,
      max_results: Math.min(Math.max(q.maxResults ?? 8, 1), 20),
      chunks_per_source: 3,
      include_answer: false, // we want sources, not Tavily's own summary
      include_raw_content: false, // full text comes from extract, for selected sources only
      include_published_date: true,
      include_usage: true,
    };
    if (q.preferDomains?.length) {
      body.include_domains = q.preferDomains.slice(0, 300);
      body.include_domains_mode = 'prefer';
    }
    if (q.excludeDomains?.length) body.exclude_domains = q.excludeDomains.slice(0, 150);
    if (q.language) body.language = q.language;

    const data = await this.post<TavilySearchResponse>('/search', body);
    const results: SearchResult[] = (data.results ?? [])
      .filter((r) => typeof r.url === 'string' && r.url.length > 0)
      .map((r) => ({
        title: stripControlChars(r.title ?? '').trim() || r.url,
        url: r.url,
        snippet: stripControlChars(r.content ?? ''),
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        ...(r.published_date ? { publishedDate: r.published_date } : {}),
      }));
    return { results, meta: this.meta(`search:${depth}`, data, { kind: 'search', depth }) };
  }

  async fetchDocuments(urls: string[], opts: { depth?: 'basic' | 'advanced' } = {}): Promise<FetchResponse> {
    if (urls.length === 0) throw new ProviderError('tavily', 'fetchDocuments needs at least one URL', false);
    if (urls.length > MAX_EXTRACT_URLS) throw new ProviderError('tavily', `Tavily extract accepts at most ${MAX_EXTRACT_URLS} URLs per call`, false);
    const depth = opts.depth ?? 'advanced';
    const data = await this.post<TavilyExtractResponse>('/extract', {
      urls,
      extract_depth: depth, // advanced: tables & embedded content, higher success rate
      format: 'markdown',
      include_usage: true,
    });

    // Map URLs back to the form that was requested (Tavily may add/remove a trailing slash, www., https).
    const requested = new Map(urls.map((u) => [canonicalForMatching(u), u]));
    const asRequested = (u: string) => requested.get(canonicalForMatching(u)) ?? u;

    const documents = (data.results ?? [])
      .map((r) => ({ url: r.url, text: typeof r.raw_content === 'string' ? stripControlChars(r.raw_content) : '' }))
      .filter((r) => r.text.trim().length > 0)
      .map((r) => ({ url: asRequested(r.url), contentType: 'text/markdown', text: r.text }));
    const failed = (data.failed_results ?? []).map((f) => ({ url: asRequested(f.url), error: f.error ?? 'extraction failed' }));
    // Empty extractions and URLs Tavily silently dropped count as failures, so every URL is accounted for.
    const returned = new Set([...documents.map((d) => d.url), ...failed.map((f) => f.url)]);
    for (const r of data.results ?? []) {
      const url = asRequested(r.url);
      if (!documents.some((d) => d.url === url) && !failed.some((f) => f.url === url)) failed.push({ url, error: 'empty content' });
    }
    for (const url of urls) {
      if (!returned.has(url) && !failed.some((f) => f.url === url)) failed.push({ url, error: 'not returned by provider' });
    }
    return { documents, failed, meta: this.meta(`extract:${depth}`, data, { kind: 'extract', depth, successes: documents.length }) };
  }

  /** Credits as reported by Tavily; if absent, the documented price list (noted as such). */
  private meta(
    model: string,
    data: { usage?: { credits?: number }; request_id?: string },
    op: { kind: 'search'; depth: string } | { kind: 'extract'; depth: string; successes: number },
  ): CallMeta {
    const reported = data.usage?.credits;
    let usage: UsageItem[];
    let costNote: string | undefined;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      usage = [{ unit: 'CREDITS', quantity: reported }];
      costNote = `${reported} credit(s) reported by Tavily × $${this.info.rates[0]!.usdPerUnit}/credit (${this.info.rates[0]!.source})`;
    } else {
      const perUnit = op.depth === 'advanced' ? 2 : 1;
      const credits = op.kind === 'search' ? perUnit : (op.successes / 5) * perUnit;
      usage = [{ unit: 'CREDITS', quantity: credits }];
      costNote = `Tavily did not report usage; ${credits} credit(s) derived from the documented price list`;
    }
    return {
      provider: 'tavily',
      model,
      mock: false,
      usage,
      costNote,
      ...(data.request_id ? { providerRequestId: data.request_id } : {}),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    else headers['x-tavily-access-mode'] = 'keyless';

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network failure or timeout: worth retrying.
      throw new ProviderError('tavily', `${path} request failed: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
    }

    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { detail?: { error?: string } | string };
        detail = typeof parsed.detail === 'string' ? parsed.detail : (parsed.detail?.error ?? detail);
      } catch {
        // keep raw text
      }
      // 429 rate limit and 5xx are transient; 400/401/422/432 (plan limit)/433 (pay-as-you-go limit) are not.
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError('tavily', `${path} HTTP ${res.status}: ${detail}`, retryable);
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ProviderError('tavily', `${path} returned invalid JSON`, true, { cause: err });
    }
  }
}

/** Loose URL identity used only to reconcile provider output with requested URLs. */
/**
 * Extracted PDFs can contain NUL and other control characters. They mean
 * nothing to a reader and PostgreSQL refuses NUL, so they are removed here,
 * at the boundary; tab, newline and carriage return are kept.
 */
function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function canonicalForMatching(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return u;
  }
}
