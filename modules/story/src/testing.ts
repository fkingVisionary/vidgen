/**
 * Scripted fakes for testing the story stages end to end without network or
 * credits. The dossier is SYNTHETIC test data shaped like the Tulip Mania
 * problem, with fictional people ("Jan Testbroek", "Cornelis Proefman") and
 * "(test)" sources; it is not research content and must never be presented
 * as such.
 */
import type {
  CitationStance,
  ClaimImportance,
  ClaimType,
  ClaimVerdict,
  ConfidenceLevel,
  ResearchDossierContent,
  SourceType,
} from '@docengine/core';
import type { Database } from '@docengine/database';
import { ProviderError } from '@docengine/providers';
import type { AIProvider, ObjectGenerationRequest, ObjectGenerationResult, ProviderInfo, TextGenerationResult } from '@docengine/providers';
import type { EvidenceInput } from './evidence.ts';
import type { ArchitectOutput, ArchitectureReviewOutput, CriticOutput, MinedCandidate, MiningOutput, SelectionOutput, SupportVerdict } from './schemas.ts';

// ── Synthetic dossier ────────────────────────────────────────────────────────

interface FakeSource {
  key: string;
  title: string;
  sourceType: SourceType;
  author: string | null;
  retrieved: boolean;
}

export const FAKE_SOURCES: FakeSource[] = [
  { key: 'A', title: 'Notarial records of the bulb trade (test)', sourceType: 'ACADEMIC', author: 'Test Historian A', retrieved: true },
  { key: 'B', title: 'Tulip trade monograph (test)', sourceType: 'BOOK', author: 'Test Historian B', retrieved: true },
  { key: 'C', title: 'Dialogue pamphlet of 1637 (test)', sourceType: 'PRIMARY', author: null, retrieved: true },
  { key: 'D', title: 'Popular delusions, 1841 (test)', sourceType: 'BOOK', author: 'Charles Mackay', retrieved: true },
  { key: 'E', title: 'Alkmaar auction list (test)', sourceType: 'ARCHIVE', author: null, retrieved: true },
  { key: 'F', title: 'Economic history article (test)', sourceType: 'REPUTABLE_SECONDARY', author: 'Test Economist C', retrieved: true },
  { key: 'G', title: 'Tulip book watercolours (test)', sourceType: 'ARCHIVE', author: null, retrieved: true },
  { key: 'X', title: 'Unretrieved web page (test)', sourceType: 'GENERAL_WEB', author: null, retrieved: false },
];

interface FakeClaim {
  key: string;
  importance: ClaimImportance;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  claimType: ClaimType;
  statement: string;
  popularVersion?: string;
  notes?: string;
  /** [source key, quote, stance, verified] */
  cites: [string, string, CitationStance?, boolean?][];
}

export const FAKE_CLAIMS: FakeClaim[] = [
  { key: 'C001', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'In the winter of 1636-37 buyers in Haarlem signed contracts for tulip bulbs that were still in the ground.', cites: [['A', 'buyers signed contracts for bulbs that were still in the ground'], ['B', 'most of the trade was in bulbs still in the ground']] },
  { key: 'C002', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'Trading took place in taverns, where groups of florists called colleges met to deal.', cites: [['A', 'florists met in taverns in groups called colleges'], ['C', 'they meet in the inn to trade bulbs they have never seen']] },
  { key: 'C003', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'An auction in Alkmaar on 5 February 1637 sold bulbs for a total of 90,000 guilders.', cites: [['E', 'the bulbs were sold for a total of 90,000 guilders'], ['B', 'the Alkmaar sale raised about 90,000 guilders']] },
  { key: 'C004', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'PERSON', statement: 'The bulbs sold at Alkmaar had belonged to Jan Testbroek, an innkeeper whose orphaned children inherited them.', cites: [['E', 'the estate of Jan Testbroek, innkeeper, for his orphans'], ['B', 'Testbroek had kept a tavern and traded bulbs']] },
  { key: 'C005', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'In the first week of February 1637 buyers stopped appearing at a Haarlem auction and prices collapsed.', cites: [['A', 'in the first week of February 1637 no buyers came'], ['B', 'the collapse began at an auction in Haarlem']] },
  { key: 'C006', importance: 'KEY', verdict: 'PROBABLE', confidence: 'MEDIUM', claimType: 'EVENT', statement: 'Many buyers refused to pay for bulbs they had contracted for once prices fell.', cites: [['A', 'many buyers refused to pay']] },
  { key: 'C007', importance: 'SUPPORTING', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'In April 1637 the courts of Holland referred the unsettled contracts to local authorities rather than enforcing them.', cites: [['A', 'in April 1637 the Court of Holland referred the matter to the towns'], ['F', 'courts declined to enforce the contracts']] },
  { key: 'C008', importance: 'SUPPORTING', verdict: 'PROBABLE', confidence: 'MEDIUM', claimType: 'EVENT', statement: 'Cornelis Proefman, a buyer, was sued by a grower after refusing to accept bulbs he had bought for 1,200 guilders.', cites: [['A', 'Cornelis Proefman refused to accept the bulbs he had bought for 1,200 guilders']] },
  { key: 'C009', importance: 'KEY', verdict: 'DISPUTED', confidence: 'MEDIUM', claimType: 'ECONOMIC_FIGURE', statement: 'A single Semper Augustus bulb was offered for 5,500 guilders.', notes: 'Reported in popular accounts; no completed sale is documented.', cites: [['D', 'a single Semper Augustus was offered 5,500 guilders'], ['B', 'No completed sale of a Semper Augustus at 5,500 guilders is documented', 'CONTRADICTS']] },
  { key: 'C010', importance: 'KEY', verdict: 'MYTH', confidence: 'HIGH', claimType: 'EVENT', statement: 'Many people were ruined and the Dutch economy suffered a severe shock.', popularVersion: 'Tulip mania ruined thousands and crashed the Dutch economy.', notes: 'The archives show no wave of bankruptcies.', cites: [['D', 'Mackay wrote that many who had been rich became beggars'], ['A', 'There is no evidence in the archives of widespread bankruptcies', 'CONTRADICTS']] },
  { key: 'C011', importance: 'KEY', verdict: 'MYTH', confidence: 'HIGH', claimType: 'EVENT', statement: 'A sailor ate a Semper Augustus bulb, mistaking it for an onion.', popularVersion: 'A sailor ate a priceless bulb for breakfast.', notes: 'The anecdote has no documentary source.', cites: [['D', 'a sailor ate a Semper Augustus bulb mistaking it for an onion'], ['B', 'the sailor anecdote has no documentary source', 'CONTRADICTS']] },
  { key: 'C012', importance: 'SUPPORTING', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'PERSON', statement: 'Charles Mackay popularised the story of tulip mania in his 1841 book.', cites: [['D', 'first published in 1841'], ['F', 'Charles Mackay popularised the story in 1841']] },
  { key: 'C013', importance: 'SUPPORTING', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'CONTEXT', statement: 'Moralising pamphlets published in 1637 mocked the florists and shaped later accounts.', cites: [['C', 'the pamphlet mocks the florists'], ['B', 'the pamphlets of 1637 shaped every later account']] },
  { key: 'C014', importance: 'BACKGROUND', verdict: 'PROBABLE', confidence: 'MEDIUM', claimType: 'CONTEXT', statement: 'Striped tulips were prized because their patterns could not be reproduced reliably.', cites: [['G', 'striped flamed tulips were the most prized']] },
  { key: 'C015', importance: 'SUPPORTING', verdict: 'UNVERIFIED', confidence: 'LOW', claimType: 'EVENT', statement: 'A chimney sweep is said to have traded his tools for a bulb contract.', notes: 'Only in later retellings; no record found.', cites: [['X', 'a chimney sweep traded his tools', 'SUPPORTS', false]] },
  { key: 'C016', importance: 'SUPPORTING', verdict: 'ESTABLISHED', confidence: 'MEDIUM', claimType: 'CONTEXT', statement: 'Participants were mostly merchants and well-off artisans.', cites: [['B', 'mostly merchants and well-off artisans']] },
  { key: 'C017', importance: 'BACKGROUND', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'CONTEXT', statement: 'Haarlem was a centre of the bulb trade in the 1630s.', cites: [['A', 'Haarlem was the centre of the trade']] },
  { key: 'C018', importance: 'SUPPORTING', verdict: 'PROBABLE', confidence: 'MEDIUM', claimType: 'ECONOMIC_FIGURE', statement: 'A skilled craftsman earned roughly 300 guilders a year.', cites: [['F', 'a skilled craftsman earned about 300 guilders a year']] },
  { key: 'C019', importance: 'SUPPORTING', verdict: 'DISPUTED', confidence: 'MEDIUM', claimType: 'INTERPRETATION', statement: 'Economists disagree whether the price rise was a speculative bubble or a rational price for rare varieties.', cites: [['F', 'the prices may reflect rational expectations'], ['B', 'a speculative episode', 'CONTRADICTS']] },
  { key: 'C020', importance: 'BACKGROUND', verdict: 'ESTABLISHED', confidence: 'HIGH', claimType: 'EVENT', statement: 'Bulb prices rose sharply between November 1636 and January 1637.', cites: [['A', 'prices rose sharply between November 1636 and January 1637']] },
];

export const FAKE_CONTENT: ResearchDossierContent = {
  questions: [],
  timeline: [
    { date: 'Nov 1636', event: 'Prices begin to rise sharply', approximate: true, claimKeys: ['C020'] },
    { date: '5 Feb 1637', event: 'Alkmaar auction', approximate: false, claimKeys: ['C003'] },
    { date: 'Feb 1637', event: 'A Haarlem auction fails', approximate: false, claimKeys: ['C005'] },
    { date: 'Apr 1637', event: 'The courts refer the contracts to the towns', approximate: false, claimKeys: ['C007'] },
    { date: '1841', event: 'Mackay publishes his account', approximate: false, claimKeys: ['C012'] },
  ],
  keyFigures: [
    { name: 'Jan Testbroek', role: 'Innkeeper and bulb owner', description: 'His bulbs were auctioned for his orphans', claimKeys: ['C004'] },
    { name: 'Charles Mackay', role: 'Popular author (1841)', description: 'Popularised the story', claimKeys: ['C012'] },
  ],
  priceEvidence: [
    { item: 'Semper Augustus (one bulb)', price: '5,500', currency: 'guilders', date: '1637', context: 'offer reported in popular accounts', reliability: 'disputed', claimKeys: ['C009'] },
    { item: 'Alkmaar auction (total)', price: '90,000', currency: 'guilders', date: '5 Feb 1637', context: 'auction list', reliability: 'high', claimKeys: ['C003'] },
  ],
  myths: [{ popularVersion: 'The economy was ruined', whatTheEvidenceShows: 'No wave of bankruptcies', origin: 'Mackay, 1841', claimKeys: ['C010'] }],
  interpretations: [{ position: 'Rational pricing of rare varieties', proponents: ['Test Economist C'], summary: 'test', claimKeys: ['C019'] }],
  bubbleAssessment: { summary: 'Contested', argumentsFor: ['Rapid rise and fall'], argumentsAgainst: ['Little economic damage'], claimKeys: ['C019'] },
  narrativeHistory: { summary: 'Pamphlets of 1637, then Mackay in 1841', milestones: [{ date: '1841', work: 'Mackay', contribution: 'Popularised the story' }], claimKeys: ['C012', 'C013'] },
  openQuestions: [{ question: 'How many people traded?', whyUnresolved: 'Records are partial', whatWouldResolveIt: 'More notarial records', claimKeys: [] }],
  missingEvidence: [],
};

/** The synthetic dossier in memory (unit tests). Ids are "claim-C001", "src-A". */
export function fakeEvidenceInput(): EvidenceInput {
  return {
    dossierId: 'dossier-test',
    dossierVersion: 1,
    summary: 'Synthetic test dossier.',
    content: FAKE_CONTENT,
    sources: FAKE_SOURCES.map((s) => ({ id: `src-${s.key}`, title: s.title, sourceType: s.sourceType, author: s.author, publishedDate: null, domain: 'example.org', retrieved: s.retrieved, duplicateOfId: null })),
    claims: FAKE_CLAIMS.map((c) => ({
      id: `claim-${c.key}`,
      key: c.key,
      statement: c.statement,
      claimType: c.claimType,
      importance: c.importance,
      verdict: c.verdict,
      confidence: c.confidence,
      popularVersion: c.popularVersion ?? null,
      notes: c.notes ?? null,
      citations: c.cites.map(([src, quote, stance, verified]) => ({ sourceId: `src-${src}`, stance: stance ?? 'SUPPORTS', quote, quoteVerified: verified ?? true })),
    })),
  };
}

/** Persist the synthetic dossier as the project's APPROVED dossier v1 (integration tests). */
export async function seedFakeDossier(db: Database, projectId: string): Promise<{ dossierId: string; claimIds: Record<string, string> }> {
  const sources = new Map<string, string>();
  for (const s of FAKE_SOURCES) {
    const row = await db.source.create({
      data: {
        projectId,
        sourceType: s.sourceType,
        title: s.title,
        author: s.author,
        url: `https://example.org/test/${s.key}`,
        normalizedUrl: `https://example.org/test/${s.key}`,
        domain: 'example.org',
        citation: `${s.title}. https://example.org/test/${s.key}`,
        retrievalStatus: s.retrieved ? 'RETRIEVED' : 'FAILED',
      },
    });
    sources.set(s.key, row.id);
  }
  const dossier = await db.researchDossier.create({
    data: { projectId, version: 1, status: 'APPROVED', summary: 'Synthetic test dossier.', content: FAKE_CONTENT, qualityPassed: true },
  });
  const claimIds: Record<string, string> = {};
  for (const [i, c] of FAKE_CLAIMS.entries()) {
    const row = await db.researchClaim.create({
      data: {
        dossierId: dossier.id,
        claimKey: c.key,
        importance: c.importance,
        statement: c.statement,
        claimType: c.claimType,
        verdict: c.verdict,
        confidence: c.confidence,
        popularVersion: c.popularVersion ?? null,
        notes: c.notes ?? null,
        sortOrder: i,
        citations: {
          create: c.cites.map(([src, quote, stance, verified]) => ({ sourceId: sources.get(src)!, stance: stance ?? 'SUPPORTS', quote, quoteVerified: verified ?? true })),
        },
      },
    });
    claimIds[c.key] = row.id;
  }
  return { dossierId: dossier.id, claimIds };
}

// ── Scripted mining output ───────────────────────────────────────────────────

const BASE = {
  setting: 'Haarlem',
  timePeriod: 'Winter of 1636',
  desire: 'Buyers wanted to resell at a profit.',
  conflict: 'Buyers and sellers disagreed about what the contracts meant.',
  stakes: 'Money promised for bulbs not yet delivered.',
  escalation: 'Prices kept rising through the winter.',
  turningPoint: 'The buyers stopped coming.',
  payoff: 'The contracts were never settled in full.',
  whyInteresting: 'Because nobody knows exactly how it ended.',
  viewerQuestion: 'What happened to the contracts?',
  mythThread: null,
  notes: '',
};

type Character = MinedCandidate['characters'][number];
const group = (name: string, claimKeys: string[]): Character => ({ name, kind: 'GROUP', role: 'traders', claimKeys });
const role = (name: string, claimKeys: string[]): Character => ({ name, kind: 'ROLE', role: 'a participant', claimKeys });
const person = (name: string, claimKeys: string[]): Character => ({ name, kind: 'NAMED_PERSON', role: 'central figure', claimKeys });

function mined(title: string, storyType: MinedCandidate['storyType'], claimKeys: string[], characters: Character[], extra: Partial<MinedCandidate> = {}): MinedCandidate {
  return { ...BASE, title, hook: `What really happened in "${title}"?`, storyType, claimKeys, characters, ...extra };
}

const myth = (claimKeys: string[], whoSpreadIt = 'Later retellings') => ({
  popularStory: 'The popular version of events.',
  origin: 'Moralising retellings after the crash.',
  whoSpreadIt,
  whatHappened: 'The records tell a smaller story.',
  whyItSurvived: 'It made a good moral tale.',
  claimKeys,
});

/** 15 candidates that pass the evidence rules (and the critic). */
export const FAKE_VALID: MinedCandidate[] = [
  mined('Contracts for flowers still in the ground', 'DEAL', ['C001', 'C020'], [group('Haarlem buyers', ['C001'])], { hook: 'Why would anyone pay for a flower nobody had seen?' }),
  mined('The tavern colleges', 'SOCIAL_PHENOMENON', ['C002', 'C017'], [group('florists', ['C002'])]),
  mined("The innkeeper's orphans", 'FORTUNE', ['C003', 'C004'], [person('Jan Testbroek', ['C004']), group('his orphaned children', ['C004'])], {
    hook: "An innkeeper's bulbs sold for 90,000 guilders, and his orphans inherited the money.",
  }),
  mined('The auction where nobody came', 'MARKET_EVENT', ['C005', 'C020'], [group('Haarlem buyers', ['C005'])]),
  mined('Buyers who refused to pay', 'CONFLICT', ['C006', 'C007'], [group('buyers', ['C006']), group('growers', ['C006'])]),
  // "300" is not in C008: the rules link C018, where the dossier has it.
  mined('Proefman in court', 'CONFLICT', ['C008'], [person('Cornelis Proefman', ['C008'])], { stakes: 'He had promised 1,200 guilders when a craftsman earned 300 guilders a year.' }),
  mined('The Semper Augustus price', 'MYSTERY', ['C009'], [role('an unnamed seller', ['C009'])], { hook: 'Was a single bulb really worth 5,500 guilders?' }),
  mined('The ruin that never happened', 'MYTH_ORIGIN', ['C010', 'C016'], [group('merchants and artisans', ['C016'])], { mythThread: myth(['C010'], 'Charles Mackay') }),
  mined('The sailor and the onion', 'MYTH_ORIGIN', ['C011', 'C012'], [person('Charles Mackay', ['C012']), role('a sailor', ['C011'])], { mythThread: myth(['C011'], 'Charles Mackay') }),
  // Mackay is not in C013: the rules link C012, where the dossier names him.
  mined('How a pamphlet wrote history', 'DISCOVERY', ['C013'], [role('pamphlet authors', ['C013']), person('Charles Mackay', [])]),
  mined('Striped tulips', 'DISCOVERY', ['C014'], [group('growers', ['C014'])]),
  mined('Who really traded', 'SOCIAL_PHENOMENON', ['C016', 'C002', 'C777'], [group('merchants', ['C016'])]),
  mined('Bubble or rational?', 'CONFLICT', ['C019', 'C018'], [group('economists', ['C019'])]),
  mined('The courts step back', 'REVERSAL', ['C007', 'C005'], [group('the courts of Holland', ['C007'])]),
  mined('Prices before the fall', 'MARKET_EVENT', ['C020', 'C017'], [group('buyers', ['C020'])]),
];

/** Candidates the evidence rules (or the critic) must remove, each for a different reason. */
export const FAKE_INVALID: MinedCandidate[] = [
  mined('The invented merchant', 'CHARACTER', ['C001'], [person('Hendrik Fakename', ['C001'])], { hook: 'Hendrik Fakename bet everything on one bulb.' }),
  mined('A fortune of 7,777 guilders', 'FORTUNE', ['C003'], [group('heirs', ['C003'])], { hook: 'A fortune of 7,777 guilders vanished overnight.' }),
  mined('The onion-eating sailor', 'MYTH_ORIGIN', ['C011'], [role('a sailor', ['C011'])]),
  mined('Contracts for bulbs underground', 'DEAL', ['C001', 'C020'], [group('buyers', ['C001'])]),
  mined('Ghost claims', 'DEAL', ['C998', 'C999'], [group('nobody', [])]),
  mined('The chimney sweep', 'CHARACTER', ['C015'], [role('a chimney sweep', ['C015'])]),
  mined('Critic-flagged story', 'REVERSAL', ['C017', 'C014'], [group('growers', ['C017'])]),
];

// ── Fake AI ──────────────────────────────────────────────────────────────────

interface FakeUnit {
  key: string;
  claims: string[];
  characters: string[];
}

export interface FakeArchitectOptions {
  /** Leave out the caveats for disputed/myth claims. */
  omitCaveats?: boolean;
  secondsPerSequence?: number;
  /** Add this person (not in the evidence) to every sequence. */
  inventPerson?: string;
  /** Only use this many units (the rest go unused, without a reason). */
  useUnits?: number;
}

export class FakeStoryAI implements AIProvider {
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
  /** User prompts by task, in call order. */
  prompts: Record<string, string[]> = {};
  /** Fail the next call for this task with a transient error (the job is retried). */
  failNextTask: string | null = null;
  /** Successive story.mine responses (the last one repeats). */
  mineBatches: MinedCandidate[][] = [[...FAKE_VALID, ...FAKE_INVALID]];
  /** Critic support verdicts by candidate title (default SUPPORTED). */
  support: Record<string, SupportVerdict> = { 'Critic-flagged story': 'UNSUPPORTED', 'The Semper Augustus price': 'NEEDS_CAVEAT' };
  /** Titles the critic leaves out of its first answer. */
  criticSkips = new Set<string>();
  /** Picks the proposed selection from the ranked keys. */
  selectKeys: (keys: string[]) => string[] = (keys) => [...keys.slice(0, 7), 'S99'];
  architectOptions: FakeArchitectOptions = {};
  /** The reviewer adds the caveats the automated findings ask for. */
  reviewFixesCaveats = false;

  async generateText(): Promise<TextGenerationResult> {
    throw new Error('not used by the story stages');
  }

  async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    this.calls[req.task] = (this.calls[req.task] ?? 0) + 1;
    const user = req.messages.map((m) => m.content).join('\n');
    (this.prompts[req.task] ??= []).push(user);
    if (this.failNextTask === req.task) {
      this.failNextTask = null;
      throw new ProviderError('fake-ai', 'overloaded (test)', true);
    }
    const object = this.respond(req.task, user);
    return {
      object: req.schema.parse(object),
      meta: { provider: 'fake-ai', model: 'fake-model', mock: false, usage: [{ unit: 'INPUT_TOKENS', quantity: Math.round(user.length / 4) }, { unit: 'OUTPUT_TOKENS', quantity: 1_500 }] },
    };
  }

  private respond(task: string, user: string): unknown {
    switch (task) {
      case 'story.mine': {
        const n = this.calls[task]! - 1;
        return { candidates: this.mineBatches[Math.min(n, this.mineBatches.length - 1)]! } satisfies MiningOutput;
      }
      case 'story.critic': {
        const found = [...user.matchAll(/^### (M\d+) — (.+) \[[A-Z_]+\]$/gm)].map((m) => ({ ref: m[1]!, title: m[2]! }));
        return {
          assessments: found
            .filter((c) => {
              if (!this.criticSkips.has(c.title)) return true;
              this.criticSkips.delete(c.title);
              return false;
            })
            .map((c, i) => {
              const support = this.support[c.title] ?? 'SUPPORTED';
              return {
                candidateId: c.ref,
                intrigue: 4 + ((i * 3) % 7),
                humanDrama: 3 + ((i * 5) % 8),
                stakes: 5 + (i % 5),
                surprise: 2 + ((i * 7) % 9),
                escalation: 4 + ((i * 2) % 6),
                visualPotential: 6 + (i % 4),
                financialStakes: 3 + ((i * 4) % 7),
                emotionalWeight: 4 + ((i * 6) % 6),
                rationale: `Test assessment of ${c.title}.`,
                support,
                problems: support === 'SUPPORTED' ? [] : ['An overstated statement (test).'],
                caveat: support === 'NEEDS_CAVEAT' ? 'Say that no completed sale is documented.' : null,
              };
            }),
        } satisfies CriticOutput;
      }
      case 'story.select': {
        const keys = [...user.matchAll(/^(S\d+) · rank/gm)].map((m) => m[1]!);
        const chosen = this.selectKeys(keys);
        return {
          selected: chosen.map((k) => ({ candidateKey: k, reason: `Test role for ${k}` })),
          workingPremise: 'A test premise about contracts and legend.',
          rationale: 'They work together (test).',
          alternates: keys.filter((k) => !chosen.includes(k)).slice(0, 2),
        } satisfies SelectionOutput;
      }
      case 'story.architect':
        return this.architect(user);
      case 'story.review':
        return this.review(user);
      default:
        throw new Error(`unexpected task ${task}`);
    }
  }

  private architect(user: string): ArchitectOutput {
    const o = this.architectOptions;
    const units: FakeUnit[] = user
      .split(/^## /m)
      .slice(1)
      .map((block) => ({
        key: /^(S\d+)/.exec(block)?.[1] ?? '',
        claims: (/^claims: (.*)$/m.exec(block)?.[1] ?? '').split(', ').filter(Boolean),
        characters: (/^characters: (.*)$/m.exec(block)?.[1] ?? '')
          .split('; ')
          .map((c) => c.replace(/ \([A-Z_]+\):.*$/, ''))
          .filter(Boolean),
      }))
      .filter((u) => u.key);
    const caveatKeys = [...(/^Claims that need a caveat.*: (.*)$/m.exec(user)?.[1] ?? '').matchAll(/(C\d+)/g)].map((m) => m[1]!);
    const used = units.slice(0, o.useUnits ?? units.length);
    return {
      premise: 'A test premise.',
      centralQuestion: 'Why did a flower trade end in court?',
      narrativeSpine: 'From contracts to collapse to legend (test).',
      resolution: 'The courts and the record answer it (test).',
      sequences: used.map((u) => ({
        title: `The story of ${u.key}`,
        purpose: 'Test purpose.',
        candidateKeys: [u.key],
        openingHook: 'What happened next?',
        narrativeQuestion: 'Why did it happen?',
        keyEvents: [
          { event: 'The first turn (test).', claimKeys: [u.claims[0]!] },
          { event: 'The second turn (test).', claimKeys: [u.claims[1] ?? u.claims[0]!] },
        ],
        characters: [...u.characters, ...(o.inventPerson ? [o.inventPerson] : [])],
        conflict: 'A conflict (test).',
        escalation: 'It escalates (test).',
        reveal: 'A reveal (test).',
        endingBeat: 'And then… (test).',
        claimKeys: u.claims,
        caveats: o.omitCaveats ? [] : u.claims.filter((k) => caveatKeys.includes(k)).map((k) => ({ claimKey: k, framing: 'Present it as disputed or as legend (test).' })),
        estimatedDurationSec: o.secondsPerSequence ?? 120,
      })),
      unusedCandidates: [],
    };
  }

  private review(user: string): ArchitectureReviewOutput {
    if (!this.reviewFixesCaveats) return { issues: [{ severity: 'MINOR', description: 'Polish the hook (test).', sequenceNumbers: [1], claimKeys: [], fixedInRevision: false }], revised: null };
    const json = /# Architecture\n([\s\S]*?)\n\n# Evidence/.exec(user)?.[1];
    const draft = JSON.parse(json!) as ArchitectOutput;
    const missing = [...user.matchAll(/^- Sequence (\d+): uses (C\d+) \(/gm)].map((m) => ({ seq: Number(m[1]), key: m[2]! }));
    for (const m of missing) draft.sequences[m.seq - 1]!.caveats.push({ claimKey: m.key, framing: 'Present it as disputed or as legend (review fix).' });
    return {
      issues: [{ severity: 'CRITICAL', description: 'Disputed or myth claims told without caveats.', sequenceNumbers: missing.map((m) => m.seq), claimKeys: missing.map((m) => m.key), fixedInRevision: true }],
      revised: draft,
    };
  }
}
