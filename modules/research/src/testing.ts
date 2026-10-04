/**
 * Scripted fake providers for testing the research stage end to end without
 * network or credits. The corpus is SYNTHETIC test data shaped like the
 * Tulip Mania research problem (scholarship vs. popular myth); it is not
 * research content and must never be presented as such.
 */
import type { SourceType } from '@docengine/core';
import type {
  AIProvider,
  FetchResponse,
  ObjectGenerationRequest,
  ObjectGenerationResult,
  ProviderInfo,
  ResearchProvider,
  ResearchQuery,
  SearchResponse,
  TextGenerationResult,
} from '@docengine/providers';
import type { PlanOutput, ReadOutput, ReviewOutput, SynthesisOutput, TriageOutput } from './schemas.ts';

interface CorpusEntry {
  url: string;
  title: string;
  type: SourceType;
  author: string | null;
  facts: string[];
  /** Text identical to another entry (a mirror), by URL. */
  copyOf?: string;
  fail?: string;
  stub?: boolean;
  /** Only returned by an open-access lookup (a quoted-title "pdf" search) for this entry's title. */
  openAccessFor?: string;
}

export const FAKE_CORPUS: CorpusEntry[] = [
  { url: 'https://www.jstor.org/stable/test-tulip-contracts', title: 'Tulip contracts in Haarlem (test)', type: 'ACADEMIC', author: 'Test Historian A', facts: [
    'Notarial records from Haarlem show that most tulip contracts agreed in the winter of 1636-37 were never settled in full.',
    'The sharpest price rises occurred between November 1636 and early February 1637.',
    'There is no evidence in the archives of widespread bankruptcies caused by the tulip trade.',
  ] },
  { url: 'https://press.uchicago.edu/test-tulipmania-excerpt', title: 'Tulipmania excerpt (test)', type: 'BOOK', author: 'Test Historian B', facts: [
    'The archival record contains no case of a person drowning themselves or being ruined by tulips.',
    'The participants were mostly merchants and well-off artisans rather than chimney sweeps and maids.',
    'The collapse began at an auction in Haarlem in the first week of February 1637.',
  ] },
  { url: 'https://www.dbnl.org/test-samenspraeck-1637', title: 'Dialogue pamphlet of 1637 (test)', type: 'PRIMARY', author: null, facts: [
    'Gaergoedt tells Waermondt that a single bulb had changed hands several times in one day.',
    'The pamphlet mocks the florists who met in taverns to trade bulbs they had never seen.',
  ] },
  { url: 'https://archive.org/details/test-mackay-1841', title: 'Extraordinary Popular Delusions, 1841 (test)', type: 'BOOK', author: 'Charles Mackay', facts: [
    'Mackay wrote in 1841 that many who had been rich became beggars and that commerce suffered a severe shock.',
    'Mackay claimed that a sailor ate a Semper Augustus bulb mistaking it for an onion.',
  ] },
  { url: 'https://www.rijksmuseum.nl/test-tulip-book', title: 'Tulip book watercolours (test)', type: 'ARCHIVE', author: null, facts: [
    'Watercolour tulip books were commissioned by growers to advertise the flowers they sold.',
    'Striped flamed tulips were the most prized varieties because their patterns could not be reproduced reliably.',
  ] },
  { url: 'https://www.economist.com/test-tulip-myth', title: 'The tulip myth (test)', type: 'REPUTABLE_SECONDARY', author: null, facts: [
    'Economic historians now argue the Dutch economy was barely affected by the end of the tulip trade.',
    'The story of ruin owes much to moralising pamphlets published after the collapse.',
  ] },
  { url: 'https://en.wikipedia.org/wiki/Test_tulip_mania', title: 'Tulip mania (test)', type: 'GENERAL_REFERENCE', author: null, facts: [
    'At the peak some single tulip bulbs reportedly sold for more than ten times the annual income of a skilled craftsman.',
  ] },
  { url: 'https://tulip-facts-blog.com/crazy-tulips', title: '10 crazy tulip facts (test)', type: 'GENERAL_WEB', author: null, facts: [
    'Tulip mania destroyed the Dutch economy and left thousands of families ruined overnight.',
    'A sailor ate a precious bulb thinking it was an onion and was jailed for it.',
  ] },
  { url: 'https://mirror-site.com/tulip-contracts-copy', title: 'Tulip contracts (mirror)', type: 'GENERAL_WEB', author: null, facts: [], copyOf: 'https://www.jstor.org/stable/test-tulip-contracts' },
  { url: 'https://www.nber.org/papers/test-garber', title: 'Famous first bubbles (test)', type: 'ACADEMIC', author: 'Test Economist C', facts: [
    'High prices for rare bulbs were consistent with the economics of new flower varieties.',
    'Prices of common bulbs rose by many times in January 1637 before falling sharply.',
  ] },
  { url: 'https://www.metmuseum.org/test-tulip-prints', title: 'Satirical prints of 1637 (test)', type: 'ARCHIVE', author: null, facts: [
    'Satirical prints from 1637 depicted the florists as fools riding in a carriage of Flora.',
  ] },
  { url: 'https://www.historytoday.com/test-tulipmania', title: 'Tulipmania revisited (test)', type: 'REPUTABLE_SECONDARY', author: null, facts: [
    'Courts of Holland later allowed tulip contracts to be settled for a small fraction of the agreed price.',
  ] },
  { url: 'https://eh.net/encyclopedia/test-tulips', title: 'The tulip trade (test)', type: 'ACADEMIC', author: 'Test Historian D', facts: [
    'The States of Holland referred the matter of unpaid contracts to the courts in April 1637.',
  ] },
  { url: 'https://broken-site.org/tulips', title: 'Broken page (test)', type: 'GENERAL_WEB', author: null, facts: [], fail: 'Failed to fetch url' },
  { url: 'https://paywalled-journal.org/abstract', title: 'Paywalled article (test)', type: 'ACADEMIC', author: null, facts: [], stub: true },
  { url: 'https://www.instagram.com/p/test-tulips', title: 'Tulip post (test)', type: 'GENERAL_WEB', author: null, facts: [] },
  // Open-access lookup results for the paywalled article: a matching copy that cannot be downloaded,
  // an author manuscript (same title) and an unrelated page (must be rejected).
  { url: 'https://www.researchgate.net/publication/test-paywalled-article', title: '(PDF) Paywalled article (test)', type: 'ACADEMIC', author: null, facts: [],
    fail: 'Failed to fetch url', openAccessFor: 'https://paywalled-journal.org/abstract' },
  { url: 'https://repository.test-university.edu/paywalled-article-manuscript.pdf', title: 'Paywalled article (test) [author manuscript]', type: 'ACADEMIC', author: 'Test Historian E', facts: [
    'Notarial deeds name well-off artisans, merchants and a few patricians as the buyers of bulbs.',
  ], openAccessFor: 'https://paywalled-journal.org/abstract' },
  { url: 'https://garden-tips.example.com/growing-tulips.pdf', title: 'Growing tulips in your garden (test)', type: 'GENERAL_WEB', author: null, facts: [
    'Plant tulip bulbs in autumn at a depth of three times their height.',
  ], openAccessFor: 'https://paywalled-journal.org/abstract' },
];

/** Long, unique filler so documents pass the minimum length and do not look like near-duplicates of each other. */
function documentText(e: CorpusEntry): string {
  const src = e.copyOf ? FAKE_CORPUS.find((x) => x.url === e.copyOf)! : e;
  if (e.stub) return 'Abstract only. Log in to read the full article.';
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of ${src.title} discusses archival detail number ${i * 7 + src.url.length}.`).join(' ');
  return `# ${src.title}\n\n${src.facts.join('\n\n')}\n\n${filler}`;
}

const usage = (inTok: number, outTok: number) => [
  { unit: 'INPUT_TOKENS' as const, quantity: inTok },
  { unit: 'OUTPUT_TOKENS' as const, quantity: outTok },
];

export class FakeResearchProvider implements ResearchProvider {
  readonly info: ProviderInfo = { kind: 'RESEARCH', name: 'fake-search', mock: false, rates: [{ provider: 'fake-search', unit: 'CREDITS', usdPerUnit: 0.01 }] };
  readonly maxBatchSize = 5;
  searches = 0;
  queries: string[] = [];
  fetched: string[] = [];

  /** Topic searches return the whole corpus; a quoted-title "pdf" search returns that title's open-access candidates. */
  async search(q: ResearchQuery): Promise<SearchResponse> {
    this.searches++;
    this.queries.push(q.query);
    const quoted = /^"(.+)" pdf$/.exec(q.query)?.[1];
    const entries = quoted
      ? FAKE_CORPUS.filter((e) => e.openAccessFor && FAKE_CORPUS.find((x) => x.url === e.openAccessFor)?.title === quoted)
      : FAKE_CORPUS.filter((e) => !e.openAccessFor);
    return {
      results: entries.map((e, i) => ({ title: e.title, url: e.url, snippet: e.facts[0] ?? e.title, score: 0.9 - i * 0.01 })),
      meta: { provider: 'fake-search', model: `search:${q.depth ?? 'basic'}`, mock: false, usage: [{ unit: 'CREDITS', quantity: q.depth === 'advanced' ? 2 : 1 }] },
    };
  }

  async fetchDocuments(urls: string[]): Promise<FetchResponse> {
    this.fetched.push(...urls);
    const documents: FetchResponse['documents'] = [];
    const failed: FetchResponse['failed'] = [];
    for (const url of urls) {
      const e = FAKE_CORPUS.find((x) => x.url === url);
      if (!e || e.fail) failed.push({ url, error: e?.fail ?? 'unknown' });
      else documents.push({ url, contentType: 'text/markdown', text: documentText(e) });
    }
    return { documents, failed, meta: { provider: 'fake-search', model: 'extract:advanced', mock: false, usage: [{ unit: 'CREDITS', quantity: documents.length / 5 }] } };
  }
}

interface ClaimSpec {
  key: string;
  statement: string;
  verdict: SynthesisOutput['claims'][number]['verdict'];
  importance: SynthesisOutput['claims'][number]['importance'];
  supports?: string[];
  contradicts?: string[];
  popular?: string;
  extraIds?: string[];
}

/** Claims written against markers in the corpus facts. */
const CLAIMS: ClaimSpec[] = [
  { key: 'C001', importance: 'KEY', verdict: 'ESTABLISHED', statement: 'Most tulip contracts of winter 1636–37 were never settled in full.', supports: ['never settled', 'small fraction'] },
  { key: 'C002', importance: 'KEY', verdict: 'ESTABLISHED', statement: 'The collapse began at a Haarlem auction in early February 1637.', supports: ['auction in Haarlem', 'sharpest price rises'] },
  { key: 'C003', importance: 'KEY', verdict: 'MYTH', statement: 'Tulip mania ruined the Dutch economy.', popular: 'Mackay (1841): commerce suffered a severe shock', supports: ['destroyed the Dutch economy', 'became beggars'], contradicts: ['barely affected', 'widespread bankruptcies'] },
  { key: 'C004', importance: 'KEY', verdict: 'MYTH', statement: 'Ruined speculators drowned themselves.', supports: ['became beggars'], contradicts: ['drowning themselves'] },
  { key: 'C005', importance: 'SUPPORTING', verdict: 'DISPUTED', statement: 'Single bulbs sold for more than ten times a craftsman’s annual income.', supports: ['ten times the annual income'], contradicts: ['new flower varieties'] },
  { key: 'C006', importance: 'SUPPORTING', verdict: 'ESTABLISHED', statement: 'Participants were mostly merchants and well-off artisans.', supports: ['well-off artisans'] },
  { key: 'C007', importance: 'SUPPORTING', verdict: 'PROBABLE', statement: 'Single bulbs could change hands several times in a day.', supports: ['changed hands several times'] },
  { key: 'C008', importance: 'BACKGROUND', verdict: 'ESTABLISHED', statement: 'Flamed tulips were the most prized varieties.', supports: ['flamed tulips', 'tulip books'] },
  { key: 'C009', importance: 'SUPPORTING', verdict: 'UNVERIFIED', statement: 'Tavern trading followed fixed rules of the "colleges".' },
  { key: 'C010', importance: 'SUPPORTING', verdict: 'ESTABLISHED', statement: 'Satirical prints and pamphlets mocked the florists.', supports: ['carriage of Flora', 'never seen'] },
  { key: 'C011', importance: 'SUPPORTING', verdict: 'ESTABLISHED', statement: 'Unpaid contracts were referred to the courts in April 1637.', supports: ['April 1637'] },
  { key: 'C012', importance: 'KEY', verdict: 'ESTABLISHED', statement: 'The ruin story owes much to moralising pamphlets.', supports: ['moralising pamphlets'] },
  { key: 'C013', importance: 'SUPPORTING', verdict: 'MYTH', statement: 'A sailor ate a Semper Augustus bulb mistaking it for an onion.', supports: ['sailor ate', 'thinking it was an onion'] },
  { key: 'C014', importance: 'BACKGROUND', verdict: 'PROBABLE', statement: 'Common bulb prices rose sharply in January 1637.', supports: ['common bulbs'], extraIds: ['S77.E1'] },
];

export class FakeResearchAI implements AIProvider {
  readonly info: ProviderInfo = {
    kind: 'AI',
    name: 'fake-ai',
    mock: false,
    rates: [
      { provider: 'fake-ai', unit: 'INPUT_TOKENS', usdPerUnit: 1e-6 },
      { provider: 'fake-ai', unit: 'OUTPUT_TOKENS', usdPerUnit: 5e-6 },
    ],
  };
  calls: Record<string, number> = {};
  /** User prompts of research.read calls, for asserting what the reader was told. */
  readPrompts: string[] = [];
  /** Insert one fabricated quote in this source's reading, to prove quote verification rejects it. */
  fabricateFor = 'https://www.economist.com/test-tulip-myth';

  async generateText(): Promise<TextGenerationResult> {
    throw new Error('not used by the research stage');
  }

  async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    this.calls[req.task] = (this.calls[req.task] ?? 0) + 1;
    const user = req.messages.map((m) => m.content).join('\n');
    const object = this.respond(req.task, user);
    return { object: req.schema.parse(object), meta: { provider: 'fake-ai', model: 'fake-model', mock: false, usage: usage(user.length / 4, 2_000) } };
  }

  private respond(task: string, user: string): unknown {
    switch (task) {
      case 'research.plan':
        return {
          questions: ['chronology', 'participants', 'prices', 'mythology'].map((cat, i) => ({
            id: `Q${i + 1}`, category: cat, question: `Test question about ${cat}?`, rationale: 'test', queries: [`${cat} query one`, `${cat} query two`],
          })),
        } satisfies PlanOutput;
      case 'research.triage': {
        // Like the model, triage judges the likely type from title and snippet, not only the domain.
        const lines = user.split('\n').filter((l) => /^C\d+ \|/.test(l));
        return {
          selected: lines.map((l) => {
            const [id, , hint, , , url] = l.split(' | ');
            const type = FAKE_CORPUS.find((e) => e.url === url)?.type ?? (hint as SourceType);
            return { candidateId: id!, likelySourceType: type, priority: 'ESSENTIAL', reason: 'test' };
          }),
        } satisfies TriageOutput;
      }
      case 'research.read': {
        this.readPrompts.push(user);
        const url = /^URL: (.*)$/m.exec(user)![1]!;
        const e = FAKE_CORPUS.find((x) => x.url === url)!;
        const evidence = e.facts.map((fact) => ({
          focusAreas: ['F1'], statement: fact, quote: fact, locator: null, kind: 'FACT' as const, attribution: e.author ?? 'the page',
        }));
        if (url === this.fabricateFor) {
          evidence.push({ focusAreas: ['F1'], statement: 'invented', quote: 'This sentence was invented and does not appear anywhere in the retrieved document.', locator: null, kind: 'FACT', attribution: 'nobody' });
        }
        return {
          assessment: {
            title: e.title, author: e.author, publisher: null, publishedDate: null, sourceType: e.type, isPrimarySource: e.type === 'PRIMARY',
            reliability: e.type === 'GENERAL_WEB' ? 'LOW' : 'HIGH', reliabilityNotes: 'test', relevance: 'HIGH', summary: `Summary of ${e.title}`,
            repeatsPopularMyths: e.type === 'GENERAL_WEB',
          },
          evidence,
        } satisfies ReadOutput;
      }
      case 'research.synthesize': {
        const ids = [...user.matchAll(/^\[(S\d+\.E\d+)\] .*"(.*)"$/gm)].map((m) => ({ id: m[1]!, quote: m[2]! }));
        const find = (markers: string[] = []) => markers.flatMap((mk) => ids.filter((x) => x.quote.includes(mk)).map((x) => x.id));
        const claims = CLAIMS.map((c, i) => ({
          key: c.key, statement: c.statement, claimType: 'EVENT' as const, questionId: `Q${(i % 4) + 1}`, importance: c.importance, verdict: c.verdict,
          confidence: 'MEDIUM' as const, popularVersion: c.popular ?? null, notes: c.verdict === 'DISPUTED' ? 'Sources disagree.' : '',
          needsVerification: c.verdict === 'UNVERIFIED', supportingEvidence: [...find(c.supports), ...(c.extraIds ?? [])],
          contradictingEvidence: find(c.contradicts), contextEvidence: [],
        }));
        return {
          summary: 'Test summary.',
          questionAnswers: [{ questionId: 'Q1', answerSummary: 'Test answer', confidence: 'MEDIUM' }],
          claims,
          timeline: [
            { date: 'Nov 1636', event: 'Sharp rises begin', approximate: true, claimKeys: ['C002'] },
            { date: 'Feb 1637', event: 'Haarlem auction fails', approximate: false, claimKeys: ['C002'] },
            { date: 'Apr 1637', event: 'Contracts referred to courts', approximate: false, claimKeys: ['C011'] },
          ],
          keyFigures: [{ name: 'Charles Mackay', role: 'Popular author (1841)', description: 'Popularised the ruin story', claimKeys: ['C003'] }],
          priceEvidence: [{ item: 'Single rare bulb', price: '>10× annual income', currency: 'guilders', date: '1637', context: 'reported', reliability: 'disputed', claimKeys: ['C005'] }],
          myths: [{ popularVersion: 'The economy was ruined', whatTheEvidenceShows: 'Barely affected', origin: 'Mackay 1841', claimKeys: ['C003', 'C004'] }],
          interpretations: [{ position: 'Rational pricing of novelties', proponents: ['Test Economist C'], summary: 'test', claimKeys: ['C005'] }],
          bubbleAssessment: { summary: 'Contested', argumentsFor: ['Rapid rise and fall'], argumentsAgainst: ['Limited economic effect'], claimKeys: ['C003', 'C005'] },
          narrativeHistory: { summary: 'Moralising pamphlets, then Mackay', milestones: [{ date: '1841', work: 'Mackay', contribution: 'Popularised' }], claimKeys: ['C012'] },
          openQuestions: [{ question: 'How many people traded?', whyUnresolved: 'Records are partial', whatWouldResolveIt: 'More notarial records', claimKeys: [] }],
          missingEvidence: [{ topic: 'Volumes', description: 'No reliable trade volumes' }],
        } satisfies SynthesisOutput;
      }
      case 'research.review':
        return {
          issues: [
            { severity: 'CRITICAL', description: 'C007 relies on a satirical pamphlet', claimKeys: ['C007'], fix: { action: 'SET_NEEDS_VERIFICATION', verdict: null, confidence: null, rationale: 'satire' } },
            { severity: 'MINOR', description: 'Wording of C008', claimKeys: ['C008'], fix: { action: 'NONE', verdict: null, confidence: null, rationale: 'style' } },
          ],
        } satisfies ReviewOutput;
      default:
        throw new Error(`unexpected task ${task}`);
    }
  }
}

/** Gate thresholds scaled to the fake corpus. */
export const FAKE_CORPUS_GATE = {
  minClaims: 10,
  minKeyClaims: 3,
  minCitedSources: 8,
  minHighTierSources: 4,
  minSourceTypes: 3,
  minDomains: 6,
  generalWebShare: { warn: 0.25, fail: 0.4 },
};
