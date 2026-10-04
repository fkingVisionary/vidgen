import { describe, expect, it } from 'vitest';
import { runResearchContract } from '../contract/index.ts';
import { ProviderError } from '../types.ts';
import { TavilyResearchProvider } from './tavily.ts';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (path: string, body: Record<string, unknown>) => { status?: number; json?: unknown; text?: string }) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    const r = respond(new URL(url).pathname, body);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const searchJson = {
  results: [
    { title: 'Tulipmania — UChicago Press', url: 'https://press.uchicago.edu/x.html', content: 'Goldgar…', score: 0.71, published_date: null },
    { title: '', url: 'https://example.org/a', content: 'b', score: 0.5 },
  ],
  usage: { credits: 2 },
  request_id: 'req-123',
};

describe('TavilyResearchProvider', () => {
  it('requires an API key unless keyless access is chosen', () => {
    expect(() => new TavilyResearchProvider({ usdPerCredit: 0.008 })).toThrow(/TAVILY_API_KEY/);
    expect(new TavilyResearchProvider({ keyless: true, usdPerCredit: 0.008 }).info).toMatchObject({ name: 'tavily', mock: false });
  });

  it('sends an authenticated advanced search with quality controls and parses results', async () => {
    const f = fakeFetch(() => ({ json: searchJson }));
    const t = new TavilyResearchProvider({ apiKey: 'tvly-test', usdPerCredit: 0.008, fetch: f.fn });
    const r = await t.search({ query: 'tulip mania', maxResults: 50, preferDomains: ['jstor.org'], excludeDomains: ['instagram.com'] });

    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.tavily.com/search');
    expect(call.headers.authorization).toBe('Bearer tvly-test');
    expect(call.headers['x-tavily-access-mode']).toBeUndefined();
    expect(call.body).toMatchObject({
      query: 'tulip mania',
      search_depth: 'advanced',
      max_results: 20, // clamped
      include_answer: false,
      include_usage: true,
      include_domains: ['jstor.org'],
      include_domains_mode: 'prefer',
      exclude_domains: ['instagram.com'],
    });
    expect(r.results).toEqual([
      { title: 'Tulipmania — UChicago Press', url: 'https://press.uchicago.edu/x.html', snippet: 'Goldgar…', score: 0.71 },
      { title: 'https://example.org/a', url: 'https://example.org/a', snippet: 'b', score: 0.5 },
    ]);
    expect(r.meta).toMatchObject({ provider: 'tavily', model: 'search:advanced', mock: false, providerRequestId: 'req-123', usage: [{ unit: 'CREDITS', quantity: 2 }] });
    expect(r.meta.costNote).toMatch(/2 credit\(s\) reported by Tavily × \$0.008/);
    expect(t.info.rates[0]).toMatchObject({ unit: 'CREDITS', usdPerUnit: 0.008 });
  });

  it('uses the keyless header and prices keyless usage at $0', async () => {
    const f = fakeFetch(() => ({ json: searchJson }));
    const t = new TavilyResearchProvider({ keyless: true, usdPerCredit: 0.008, fetch: f.fn });
    await t.search({ query: 'q' });
    expect(f.calls[0]!.headers['x-tavily-access-mode']).toBe('keyless');
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(t.info.rates[0]!.usdPerUnit).toBe(0);
  });

  it('derives credits from the documented price list when usage is not reported, and says so', async () => {
    const f = fakeFetch(() => ({ json: { results: [] } }));
    const t = new TavilyResearchProvider({ apiKey: 'k', usdPerCredit: 0.008, fetch: f.fn });
    const r = await t.search({ query: 'q', depth: 'basic' });
    expect(r.meta.usage).toEqual([{ unit: 'CREDITS', quantity: 1 }]);
    expect(r.meta.costNote).toMatch(/did not report usage/);
  });

  it('extracts full text and accounts for every URL (success, failure, empty, dropped, redirected form)', async () => {
    const f = fakeFetch(() => ({
      json: {
        results: [
          { url: 'https://a.org/page', raw_content: '# A\nfull text' }, // requested as https://www.a.org/page/
          { url: 'https://b.org/', raw_content: '   ' },
        ],
        failed_results: [{ url: 'https://c.org/', error: 'Failed to fetch url' }],
        usage: { credits: 0 },
        request_id: 'r2',
      },
    }));
    const t = new TavilyResearchProvider({ apiKey: 'k', usdPerCredit: 0.008, fetch: f.fn });
    const urls = ['https://www.a.org/page/', 'https://b.org/', 'https://c.org/', 'https://d.org/'];
    const r = await t.fetchDocuments(urls);
    expect(f.calls[0]!.body).toMatchObject({ urls, extract_depth: 'advanced', format: 'markdown', include_usage: true });
    expect(r.documents).toEqual([{ url: 'https://www.a.org/page/', contentType: 'text/markdown', text: '# A\nfull text' }]);
    expect(r.failed).toEqual([
      { url: 'https://c.org/', error: 'Failed to fetch url' },
      { url: 'https://b.org/', error: 'empty content' },
      { url: 'https://d.org/', error: 'not returned by provider' },
    ]);
    expect(r.meta).toMatchObject({ model: 'extract:advanced', usage: [{ unit: 'CREDITS', quantity: 0 }] });
  });

  it('removes NUL and other control characters from extracted text, titles and snippets (PostgreSQL rejects NUL)', async () => {
    const f = fakeFetch((path) =>
      path === '/extract'
        ? { json: { results: [{ url: 'https://a.org/x.pdf', raw_content: 'Tulip\u0000 prices\u0007 rose\tin\r\n1636' }, { url: 'https://b.org/', raw_content: '\u0000\u0000' }], usage: { credits: 1 } } }
        : { json: { results: [{ title: 'PDF\u0000 title', url: 'https://a.org/x.pdf', content: 'snip\u0000pet' }], usage: { credits: 1 } } },
    );
    const t = new TavilyResearchProvider({ apiKey: 'k', usdPerCredit: 0.008, fetch: f.fn });
    const r = await t.fetchDocuments(['https://a.org/x.pdf', 'https://b.org/']);
    expect(r.documents).toEqual([{ url: 'https://a.org/x.pdf', contentType: 'text/markdown', text: 'Tulip prices rose\tin\r\n1636' }]);
    expect(r.failed).toEqual([{ url: 'https://b.org/', error: 'empty content' }]); // nothing left after cleaning
    const s = await t.search({ query: 'q' });
    expect(s.results[0]).toMatchObject({ title: 'PDF title', snippet: 'snippet' });
  });

  it('rejects oversized extract batches before calling the API', async () => {
    const f = fakeFetch(() => ({ json: {} }));
    const t = new TavilyResearchProvider({ apiKey: 'k', usdPerCredit: 0.008, fetch: f.fn });
    await expect(t.fetchDocuments(Array.from({ length: 21 }, (_, i) => `https://x.org/${i}`))).rejects.toThrow(/at most 20/);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [432, false],
    [433, false],
  ])('classifies HTTP %i as retryable=%s and surfaces the API message', async (status, retryable) => {
    const f = fakeFetch(() => ({ status, json: { detail: { error: 'upstream says no' } } }));
    const t = new TavilyResearchProvider({ apiKey: 'k', usdPerCredit: 0.008, fetch: f.fn });
    const err = await t.search({ query: 'q' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable });
    expect((err as Error).message).toMatch(new RegExp(`HTTP ${status}: upstream says no`));
  });

  it('treats network failures as retryable', async () => {
    const t = new TavilyResearchProvider({
      apiKey: 'k',
      usdPerCredit: 0.008,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(t.search({ query: 'q' })).rejects.toMatchObject({ retryable: true });
  });
});

// Real API, opt-in: RUN_LIVE_TAVILY=1 (uses TAVILY_API_KEY if set, otherwise free keyless access).
if (process.env.RUN_LIVE_TAVILY === '1') {
  runResearchContract('tavily (live)', () =>
    new TavilyResearchProvider({ apiKey: process.env.TAVILY_API_KEY || undefined, keyless: !process.env.TAVILY_API_KEY, usdPerCredit: 0.008 }),
  );
}
