/**
 * Scripted fakes for testing the story stages end to end without network or
 * credits. The dossier is SYNTHETIC test data shaped like the Tulip Mania
 * problem, with fictional people ("Jan Testbroek", "Cornelis Proefman") and
 * "(test)" sources; it is not research content and must never be presented
 * as such.
 */
import {
  PRESENTATION_FOR_VERDICT,
  type CastKind,
  type CharacterKind,
  type CitationStance,
  type ClaimImportance,
  type ClaimType,
  type ClaimVerdict,
  type ConfidenceLevel,
  type Presentation,
  type ResearchDossierContent,
  type SourceType,
} from '@docengine/core';
import type { Database } from '@docengine/database';
import { ProviderError } from '@docengine/providers';
import type { AIProvider, ObjectGenerationRequest, ObjectGenerationResult, ProviderInfo, TextGenerationResult } from '@docengine/providers';
import type { EvidenceInput } from './evidence.ts';
import type {
  AnglesOutput,
  ArchitectOutput,
  ArchitectRevisionOutput,
  ArchitectSequence,
  ArchitectureReviewOutput,
  CriticOutput,
  MinedCandidate,
  MiningOutput,
  OpportunityOutput,
  SelectionOutput,
  StoryEditorOutput,
  SupportVerdict,
} from './schemas.ts';

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
  couldGain: 'A quick profit on a resale.',
  couldLose: 'Money promised for bulbs not yet delivered.',
  immediateProblem: 'Nobody can see what they are buying.',
  conflict: 'Buyers and sellers disagreed about what the contracts meant.',
  stakes: 'Money promised for bulbs not yet delivered.',
  escalation: 'Prices kept rising through the winter.',
  turningPoint: 'The buyers stopped coming.',
  reveal: 'The contracts were promises, not deliveries.',
  payoff: 'The contracts were never settled in full.',
  whyInteresting: 'Because nobody knows exactly how it ended.',
  viewerQuestion: 'What happened to the contracts?',
  centralQuestion: 'Why would anyone promise money for something nobody could see?',
  visualEnvironment: 'A crowded room in winter.',
  coldOpen: { text: 'You are in a crowded room, and nobody is holding what is being sold.', basis: 'RECONSTRUCTION' as const },
  povStrategy: { type: 'VIEWER_POV' as const, description: 'The viewer is placed among the traders.' },
  reconstructionLevel: 'MEDIUM' as const,
  mythThread: null,
  notes: '',
};

const FAKE_MODES: Record<MinedCandidate['storyType'], MinedCandidate['narrativeMode']> = {
  CHARACTER: 'CHARACTER_FOLLOW',
  DEAL: 'CAUSE_AND_EFFECT',
  MARKET_EVENT: 'COUNTDOWN',
  FORTUNE: 'RISE_AND_FALL',
  SCAM: 'HEIST_OPERATION',
  CONFLICT: 'COURTROOM_DISPUTE',
  REVERSAL: 'CAUSE_AND_EFFECT',
  MYSTERY: 'HISTORICAL_MYSTERY',
  MYTH_ORIGIN: 'MYTH_VS_RECORD',
  DISCOVERY: 'INVESTIGATION',
  DISASTER: 'RISE_AND_FALL',
  SOCIAL_PHENOMENON: 'IMMERSIVE_RECONSTRUCTION',
};

type Character = MinedCandidate['characters'][number];
const group = (name: string, claimKeys: string[]): Character => ({ name, kind: 'GROUP', role: 'traders', claimKeys });
const role = (name: string, claimKeys: string[]): Character => ({ name, kind: 'ROLE', role: 'a participant', claimKeys });
const person = (name: string, claimKeys: string[]): Character => ({ name, kind: 'NAMED_PERSON', role: 'central figure', claimKeys });

function mined(title: string, storyType: MinedCandidate['storyType'], claimKeys: string[], characters: Character[], extra: Partial<MinedCandidate> = {}): MinedCandidate {
  return {
    ...BASE,
    title,
    hook: `What really happened in "${title}"?`,
    storyType,
    narrativeMode: FAKE_MODES[storyType],
    protagonist: characters[0]?.name ?? '',
    claimKeys,
    characters,
    ...extra,
  };
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

// ── Scripted architecture ────────────────────────────────────────────────────

/** A selected unit as the fake architect needs it. */
export interface FakeUnit {
  key: string;
  claims: string[];
  characters: { name: string; kind: CharacterKind }[];
  /** Approved by the editor but not selected (shown to revisions and angles). */
  reserve?: boolean;
}

export interface FakeArchitectOptions {
  /** Leave out the presentation entries for claims that are not ESTABLISHED. */
  omitPresentation?: boolean;
  /** Label every claim's beat DOCUMENTED, whatever its verdict (a rule violation for claims that are not ESTABLISHED). */
  allDocumented?: boolean;
  secondsPerSequence?: number;
  /** Add this person (not in the evidence) to the cast and to every sequence. */
  inventPerson?: string;
  /** Only use this many units (the rest go unused, without a reason). */
  useUnits?: number;
  /** Labelled background claims for the first sequence (used in an orientation beat). */
  contextClaims?: { claimKey: string; purpose: string }[];
  /** Use this claim (outside the selected units) as story evidence in the first sequence: a rule violation. */
  outsideCore?: string;
  /** Add a fictional composite who observes, with an invented line, in a FICTION beat of the first sequence. */
  composite?: { name: string; basis?: string[] };
  /** Change the output at will (the last step). */
  transform?: (out: ArchitectOutput) => ArchitectOutput;
}

const CAST_KIND: Record<CharacterKind, CastKind> = { NAMED_PERSON: 'REAL_PERSON', GROUP: 'REAL_GROUP', ROLE: 'REAL_ROLE' };

/** What a presentation instruction says, by kind (the HEDGE wording is required). */
export const FAKE_INSTRUCTIONS: Record<Presentation, string> = {
  STATE: 'State it (test).',
  HEDGE: 'Records suggest this: word it as probable, not certain (test).',
  PRESENT_AS_DISPUTED: 'Present it as disputed and give both sides (test).',
  PRESENT_AS_UNCONFIRMED: 'Say plainly that it is unconfirmed (test).',
  INVESTIGATE_AS_MYTH: 'Tell it as a legend under investigation (test).',
};

const DRAMA_FUNCTIONS = ['CONFLICT', 'ESCALATION', 'REVEAL', 'TURN'] as const;

/**
 * A rule-abiding Story Engine 2.0 architecture for these units: one sequence
 * per unit, a reconstructed opening beat with the viewer's POV, one labelled
 * beat per claim (DOCUMENTED for ESTABLISHED claims, UNCERTAIN otherwise),
 * presentation entries, continuity threads and Q0 answered in the last
 * sequence. Options introduce specific violations.
 */
export function fakeArchitectOutput(units: readonly FakeUnit[], verdictOf: (claimKey: string) => ClaimVerdict | undefined, o: FakeArchitectOptions = {}): ArchitectOutput {
  const used = units.slice(0, o.useUnits ?? units.length);
  const cast: ArchitectOutput['cast'] = [{ id: 'pov', name: 'You', kind: 'POV_PROXY', description: 'A newcomer among the traders (test).', claimKeys: [], justification: 'The viewer needs a way into the trade (test).' }];
  const castIdOf = new Map<string, string>();
  for (const u of used) {
    for (const c of u.characters) {
      const known = castIdOf.get(c.name);
      if (known) {
        const member = cast.find((m) => m.id === known)!;
        member.claimKeys = [...new Set([...member.claimKeys, ...u.claims])];
        continue;
      }
      const id = `R${castIdOf.size + 1}`;
      castIdOf.set(c.name, id);
      cast.push({ id, name: c.name, kind: CAST_KIND[c.kind], description: `${c.name} as the evidence records them (test).`, claimKeys: [...u.claims], justification: '' });
    }
  }
  if (o.inventPerson) cast.push({ id: 'X1', name: o.inventPerson, kind: 'REAL_PERSON', description: 'A trader (test).', claimKeys: [used[0]?.claims[0] ?? ''], justification: '' });
  if (o.composite) {
    cast.push({
      id: 'F1',
      name: o.composite.name,
      kind: 'FICTIONAL_COMPOSITE',
      description: 'A typical buyer of the kind the records describe (test).',
      claimKeys: o.composite.basis ?? [used[0]?.claims[0] ?? ''],
      justification: 'A typical participant lets the viewer follow the trade without inventing a real person (test).',
    });
  }

  const verdict = (k: string) => verdictOf(k) ?? 'ESTABLISHED';
  const presentationFor = (keys: readonly string[]) =>
    o.omitPresentation
      ? []
      : [...new Set(keys)].filter((k) => verdict(k) !== 'ESTABLISHED').map((k) => ({ claimKey: k, presentation: PRESENTATION_FOR_VERDICT[verdict(k)], instruction: FAKE_INSTRUCTIONS[PRESENTATION_FOR_VERDICT[verdict(k)]] }));

  const sequences: ArchitectSequence[] = used.map((u, i) => {
    const n = i + 1;
    const last = n === used.length;
    const real = u.characters.map((c) => castIdOf.get(c.name)!).slice(0, 2);
    const outside = i === 0 && o.outsideCore ? [o.outsideCore] : [];
    const context = i === 0 ? (o.contextClaims ?? []) : [];
    // A reconstruction never rests on a myth: the opening and the consequence use the unit's first other claim.
    const anchor = u.claims.find((k) => verdict(k) !== 'MYTH') ?? u.claims[0]!;
    const beats: ArchitectSequence['beats'] = [
      {
        function: i === 0 ? 'COLD_OPEN' : 'STAKES',
        basis: verdict(anchor) === 'MYTH' ? 'UNCERTAIN' : 'RECONSTRUCTION',
        description: 'You stand at the edge of the crowd as the bidding starts (test).',
        claimKeys: [anchor],
        castIds: ['pov', ...real],
        speech: [],
      },
    ];
    if (context.length) {
      const basis = context.every((c) => verdict(c.claimKey) === 'ESTABLISHED') ? 'DOCUMENTED' : 'UNCERTAIN';
      beats.push({ function: 'ORIENTATION', basis, description: 'How the trade worked, in brief (test).', claimKeys: context.map((c) => c.claimKey), castIds: real.slice(0, 1), speech: [] });
    }
    const claimBeats = u.claims.length === 1 ? [u.claims[0]!, u.claims[0]!] : u.claims.slice(0, 4);
    claimBeats.forEach((k, j) => {
      const v = verdict(k);
      const basis = o.allDocumented || v === 'ESTABLISHED' ? 'DOCUMENTED' : 'UNCERTAIN';
      beats.push({
        function: v === 'MYTH' ? 'INVESTIGATION' : DRAMA_FUNCTIONS[j % DRAMA_FUNCTIONS.length]!,
        basis,
        description: v === 'MYTH' ? 'The popular story is tested against the record (test).' : 'The record shows what happened next (test).',
        claimKeys: [k, ...(j === 1 ? outside : [])],
        castIds: [...real],
        speech: [],
      });
    });
    if (o.composite && i === 0) {
      beats.push({ function: 'ESCALATION', basis: 'FICTION', description: `${o.composite.name.split(' ')[0]} counts his coins and watches the bidding from the back (test).`, claimKeys: [], castIds: ['F1'], speech: [{ speakerId: 'F1', text: 'Everyone here is buying paper, not flowers.', kind: 'INVENTED', claimKey: null }] });
    }
    beats.push({
      function: verdict(anchor) === 'MYTH' ? 'INVESTIGATION' : 'CONSEQUENCE',
      basis: o.allDocumented || verdict(anchor) === 'ESTABLISHED' ? 'DOCUMENTED' : 'UNCERTAIN',
      description: 'What it cost, as far as the record goes (test).',
      claimKeys: [anchor],
      castIds: [...real],
      speech: [],
    });
    if (o.inventPerson) beats[1]!.castIds = [...beats[1]!.castIds, 'X1'];
    const allKeys = [...u.claims, ...outside, ...context.map((c) => c.claimKey)];
    return {
      title: `The story of ${u.key}`,
      purpose: 'Moves the documentary on (test).',
      mode: 'IMMERSIVE_RECONSTRUCTION',
      candidateKeys: [u.key],
      openingHook: 'What happened next?',
      question: 'Why did it happen?',
      conflict: 'A conflict (test).',
      escalation: 'It escalates (test).',
      reveal: 'A reveal (test).',
      consequence: 'A consequence (test).',
      endingBeat: 'And then… (test).',
      transition: last ? '' : 'From here the story moves on (test).',
      beats,
      setting: { location: { value: 'a crowded tavern room (test)', basis: 'RECONSTRUCTION' }, date: { value: '', basis: 'RECONSTRUCTION' }, timeOfDay: { value: 'evening', basis: 'RECONSTRUCTION' } },
      visual: {
        environment: 'Candle-lit interior in winter (test).',
        keyObjects: ['written contracts'],
        physicalActions: ['a hand signing'],
        emotionalState: 'tension',
        visualMetaphor: 'paper blowing in the wind',
        mustShow: [{ detail: 'the written contract', claimKeys: [anchor] }],
        mustAvoid: ['modern clothing'],
        shotIdeas: ['close-up on drying ink'],
      },
      continuity: {
        carriesIn: n > 1 ? ['the unsettled contracts'] : [],
        carriesOut: last ? [] : ['the unsettled contracts'],
        opens: [{ id: `Q${n}`, question: 'What will it cost them (test)?' }],
        resolves: [...(n > 1 ? [`Q${n - 1}`] : []), ...(last ? [`Q${n}`, 'Q0'] : [])],
        timeJump: 'NONE',
      },
      claimKeys: [...u.claims, ...outside],
      contextClaims: context,
      presentation: presentationFor(allKeys),
      estimatedDurationSec: o.secondsPerSequence ?? 120,
    };
  });

  const out: ArchitectOutput = {
    logline: 'Ordinary traders promise fortunes for flowers nobody can see, until the buyers stop coming (test).',
    centralQuestion: 'Why did a flower trade end in court?',
    centralHumanStakes: 'Their savings and their good name (test).',
    narrativeMode: 'IMMERSIVE_RECONSTRUCTION',
    secondaryModes: ['MYTH_VS_RECORD'],
    povStrategy: { type: 'VIEWER_POV', description: 'The viewer is a newcomer among the traders (test).' },
    cast,
    thesis: 'The record tells a smaller, stranger story than the legend (test).',
    narrativeSpine: 'From contracts to collapse to legend (test).',
    resolution: 'The courts and the record answer it (test).',
    orderNote: '',
    sequences,
    unusedCandidates: [],
  };
  return o.transform ? o.transform(out) : out;
}

/** The units of an architect prompt ("## S03 · … — title [TYPE]", "characters: …", "claims: …"). */
export function parseFakeUnits(prompt: string): FakeUnit[] {
  const start = ['# Selected story units', '# Story units you may use', '# Story units ('].map((h) => prompt.indexOf(h)).find((i) => i >= 0) ?? -1;
  const end = ['# Story evidence', '# Evidence'].map((h) => prompt.indexOf(h, start)).find((i) => i >= 0) ?? prompt.length;
  const section = start >= 0 ? prompt.slice(start, end) : '';
  return section
    .split(/^## /m)
    .slice(1)
    .map((block) => ({
      key: /^(S\d+)/.exec(block)?.[1] ?? '',
      reserve: /^S\d+ · approved by the editor, not selected/.test(block),
      claims: (/^claims: (.*)$/m.exec(block)?.[1] ?? '').split(', ').filter(Boolean),
      characters: (/^characters: (.*)$/m.exec(block)?.[1] ?? '')
        .split('; ')
        .map((c) => /^(.*) \((NAMED_PERSON|GROUP|ROLE)\):/.exec(c))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ name: m[1]!, kind: m[2] as CharacterKind })),
    }))
    .filter((u) => u.key);
}

type ShownBeat = ArchitectSequence['beats'][number] & { id: string };
type ShownSequence = Omit<ArchitectSequence, 'beats'> & { beats: ShownBeat[] };
/** An architecture as the reviewers and the opportunities step see it: beat ids included. */
export type ShownArchitecture = Omit<ArchitectOutput, 'sequences'> & { sequences: ShownSequence[] };

/** The architecture JSON a reviewer or the opportunities step was shown. */
function shownArchitecture(prompt: string): ShownArchitecture {
  const json = /^# (?:Architecture|The architecture)[^\n]*\n([\s\S]*?)\n\n# Evidence/m.exec(prompt)?.[1];
  if (!json) throw new Error('fake AI: no architecture in the prompt');
  return JSON.parse(json);
}

/** Opportunities the fake proposes: a short per sequence (up to five), a long-form thread, and two the rules must remove. */
export function fakeOpportunities(arch: ShownArchitecture): OpportunityOutput['opportunities'] {
  const base = {
    centralQuestion: 'What happens when nobody can see what they are buying?',
    angle: 'One decision, followed to its consequence (test).',
    escalation: 'Each bid raises the stakes (test).',
    payoff: 'The contracts turn out to be promises (test).',
    suggestedEnding: 'A question left hanging (test).',
    visualConcept: 'Close on hands, contracts and candlelight (test).',
    independent: true,
    requiresContext: false,
    contextNote: '',
    whyItWorks: 'A clear hook and a payoff in under a minute (test).',
  };
  const shorts = arch.sequences.slice(0, 5).map((s, i) => {
    const beats = s.beats.filter((b) => b.claimKeys.length > 0);
    return {
      ...base,
      format: i === 1 ? ('BOTH' as const) : ('SHORT' as const),
      title: `Short: ${s.title}`,
      hook: 'Would you pay for a flower you have never seen?',
      standalonePremise: 'A trade in promises, told in one scene (test).',
      beatIds: beats.map((b) => b.id),
      claimKeys: [...new Set(beats.flatMap((b) => b.claimKeys))],
      castIds: [...new Set(beats.flatMap((b) => b.castIds))],
      targetDurationSec: 45 + i * 10,
      hookScore: 9 - i,
      payoffScore: 7,
      standaloneScore: 8 - (i % 2),
      visualScore: 7,
      emotionScore: 6,
      paceScore: 8,
    };
  });
  const firstBeats = arch.sequences.map((s) => s.beats.find((b) => b.claimKeys.length > 0)!).filter(Boolean);
  return [
    ...shorts,
    {
      ...base,
      format: 'LONG_FORM',
      title: 'The whole trade, from promise to court',
      hook: 'How a trade in promises ended in court.',
      standalonePremise: 'The documentary itself (test).',
      beatIds: firstBeats.map((b) => b.id),
      claimKeys: [...new Set(firstBeats.flatMap((b) => b.claimKeys))],
      castIds: [],
      targetDurationSec: 780,
      independent: true,
      hookScore: 7,
      payoffScore: 8,
      standaloneScore: 9,
      visualScore: 7,
      emotionScore: 7,
      paceScore: 3,
    },
    { ...base, format: 'SHORT', title: 'A beat that does not exist', hook: 'Hook (test)?', standalonePremise: 'Premise (test).', beatIds: ['99.1'], claimKeys: [], castIds: [], targetDurationSec: 60, hookScore: 10, payoffScore: 10, standaloneScore: 10, visualScore: 10, emotionScore: 10, paceScore: 10 },
    {
      ...base,
      format: 'SHORT',
      title: 'The invented fortune',
      hook: 'A fortune of 7,777 guilders vanished overnight.',
      standalonePremise: 'Premise (test).',
      beatIds: shorts[0]?.beatIds ?? [],
      claimKeys: shorts[0]?.claimKeys ?? [],
      castIds: [],
      targetDurationSec: 60,
      hookScore: 10,
      payoffScore: 10,
      standaloneScore: 10,
      visualScore: 10,
      emotionScore: 10,
      paceScore: 10,
    },
  ];
}

// ── Scripted revision ────────────────────────────────────────────────────────

export interface FakeRevisionOptions {
  /** The revision's unit order (default: the base's units reversed; reserve units unused). */
  order?: (baseKeys: string[], reserveKeys: string[]) => string[];
  /** Pairs of units told together in one sequence. */
  merge?: [string, string][];
  narrativeMode?: ArchitectOutput['narrativeMode'];
  pov?: ArchitectOutput['povStrategy'];
  centralQuestion?: string;
  /** Change nothing: return the base as it was. */
  unchanged?: boolean;
  /** Change the output at will (the last step), e.g. to break an evidence rule. */
  transform?: (out: ArchitectRevisionOutput) => ArchitectRevisionOutput;
}

/** Questions, objects and transitions threaded through the sequences again after a restructure. */
function rethread(sequences: ArchitectSequence[]): void {
  sequences.forEach((s, i) => {
    const n = i + 1;
    const last = n === sequences.length;
    s.continuity = {
      carriesIn: n > 1 ? ['the unsettled contracts'] : [],
      carriesOut: last ? [] : ['the unsettled contracts'],
      opens: [{ id: `Q${n}`, question: 'What will it cost them (test)?' }],
      resolves: [...(n > 1 ? [`Q${n - 1}`] : []), ...(last ? [`Q${n}`, 'Q0'] : [])],
      timeJump: 'NONE',
    };
    s.transition = last ? '' : 'From here the story moves on (test).';
  });
}

/** The base architecture a revision prompt shows (beat ids included). */
function shownBase(prompt: string): ShownArchitecture | null {
  const json = /^# Architecture v\d+ \([A-Z_]+\) — the version to revise[^\n]*\n(\{[\s\S]*?\})\n\n/m.exec(prompt)?.[1];
  return json ? (JSON.parse(json) as ShownArchitecture) : null;
}

/**
 * A rule-abiding revision of the base in a revision prompt. By default a
 * substantial one: the units in reverse order, an investigation told by an
 * investigator, a new central question, logline and opening.
 */
export function fakeRevision(prompt: string, verdictOf: (claimKey: string) => ClaimVerdict | undefined, o: FakeRevisionOptions = {}): ArchitectRevisionOutput {
  const base = shownBase(prompt);
  if (!base) throw new Error('fake AI: no base architecture in the revision prompt');
  const units = parseFakeUnits(prompt);
  const baseKeys: string[] = [];
  for (const sq of base.sequences) for (const k of sq.candidateKeys) if (!baseKeys.includes(k)) baseKeys.push(k);
  const total = base.sequences.reduce((n, sq) => n + sq.estimatedDurationSec, 0);
  if (o.unchanged) {
    const same: ArchitectRevisionOutput = { ...base, sequences: base.sequences.map((sq) => ({ ...sq, beats: sq.beats.map(({ id: _id, ...b }) => b) })), changeLog: { summary: 'Nothing needed changing (test).', changes: [], kept: ['Everything (test).'] } };
    return o.transform ? o.transform(same) : same;
  }
  const order = o.order ? o.order(baseKeys, units.filter((u) => u.reserve).map((u) => u.key)) : [...baseKeys].reverse();
  const used = order.map((k) => units.find((u) => u.key === k)).filter((u): u is FakeUnit => u !== undefined);
  const out = fakeArchitectOutput(used, verdictOf, {});
  for (const [a, b] of o.merge ?? []) {
    const sa = out.sequences.find((sq) => sq.candidateKeys.includes(a));
    const sb = out.sequences.find((sq) => sq.candidateKeys.includes(b));
    if (!sa || !sb || sa === sb) continue;
    sa.title = `The story of ${a} and ${b}`;
    sa.candidateKeys = [...sa.candidateKeys, ...sb.candidateKeys];
    sa.beats = [...sa.beats, ...sb.beats.slice(1)];
    sa.claimKeys = [...new Set([...sa.claimKeys, ...sb.claimKeys])];
    sa.presentation = [...sa.presentation, ...sb.presentation.filter((p) => !sa.presentation.some((x) => x.claimKey === p.claimKey))];
    out.sequences = out.sequences.filter((sq) => sq !== sb);
  }
  rethread(out.sequences);
  for (const sq of out.sequences) sq.estimatedDurationSec = Math.round(total / out.sequences.length);
  const dropped = baseKeys.filter((k) => !order.includes(k));
  const revised: ArchitectRevisionOutput = {
    ...out,
    logline: 'A trade in promises, told as an investigation into who was left holding them (revised, test).',
    centralQuestion: o.centralQuestion ?? 'Who was left holding the promises (revised, test)?',
    centralHumanStakes: 'Their savings, and who would be blamed (revised, test).',
    narrativeMode: o.narrativeMode ?? 'INVESTIGATION',
    secondaryModes: ['COURTROOM_DISPUTE'],
    povStrategy: o.pov ?? { type: 'INVESTIGATOR', description: 'The narrator opens the files one by one (revised, test).' },
    unusedCandidates: dropped.map((k) => ({ candidateKey: k, reason: 'Folded into the investigation (test).' })),
    changeLog: {
      summary: 'Restructured as an investigation that opens on the outcome and works back (test).',
      changes: [
        { area: 'STRUCTURE', what: 'Reversed the order of the units (test).', why: 'The editor found the chronology slow (test).' },
        { area: 'OPENING', what: 'Opens on the last turn of events (test).', why: 'A stronger hook, as the brief asks (test).' },
        { area: 'POV', what: 'An investigator replaces the viewer as guide (test).', why: 'The brief asks for a clearer point of view (test).' },
        { area: 'CENTRAL_QUESTION', what: 'A new central question (test).', why: 'It carries the investigation (test).' },
      ],
      kept: ['Every claim and its presentation (test).'],
    },
  };
  return o.transform ? o.transform(revised) : revised;
}

// ── Scripted angles ──────────────────────────────────────────────────────────

/** Three materially different approaches to the units in an angles prompt. */
export function fakeAngles(prompt: string): AnglesOutput['angles'] {
  const keys = parseFakeUnits(prompt).filter((u) => !u.reserve).map((u) => u.key);
  const chunk = (ks: string[]) => ks.reduce<string[][]>((acc, k, i) => (i % 2 === 0 ? [...acc, [k]] : (acc.at(-1)!.push(k), acc)), []);
  const movements = (ks: string[], what: string) => chunk(ks).map((g, i) => ({ title: `Movement ${i + 1} (test)`, unitKeys: g, what }));
  const rotated = [...keys.slice(2), ...keys.slice(0, 2)];
  const common = { secondaryModes: [] as AnglesOutput['angles'][number]['secondaryModes'], unusedUnits: [], strengths: ['A clear human anchor (test).'], risks: ['Leans on contested material, which must stay contested (test).'] };
  return [
    {
      ...common,
      title: 'The investigation (test)',
      logline: 'The legend is tested against the record, one file at a time (test).',
      centralQuestion: 'What does the record really show (test)?',
      emotionalCentre: 'doubt giving way to discovery (test)',
      humanAnchor: 'the narrator as investigator (test)',
      narrativeMode: 'INVESTIGATION',
      povStrategy: { type: 'INVESTIGATOR', description: 'The narrator opens the files (test).' },
      opening: { concept: 'A ledger page with a gap in it (test).', basis: 'RECONSTRUCTION', unitKey: keys.at(-1)! },
      movements: movements([...keys].reverse(), 'The record is examined (test).'),
      resolution: 'The record answers the legend (test).',
      differs: 'Works backwards from the legend (test).',
    },
    {
      ...common,
      title: 'Follow the traders (test)',
      logline: 'The traders who signed the contracts, from hope to reckoning (test).',
      centralQuestion: 'What did the traders stand to lose when the buyers stopped coming (test)?',
      emotionalCentre: 'hope turning into fear (test)',
      humanAnchor: 'the traders who signed the contracts (test)',
      narrativeMode: 'CHARACTER_FOLLOW',
      povStrategy: { type: 'CHARACTER_FOLLOW', description: 'The camera stays with the traders (test).' },
      opening: { concept: 'Traders crowd a room as a contract is signed (test).', basis: 'RECONSTRUCTION', unitKey: keys[0]! },
      movements: movements(keys, 'The traders act and pay for it (test).'),
      resolution: 'The reckoning, as the record shows it (test).',
      differs: 'Stays with the people inside the trade (test).',
    },
    {
      ...common,
      title: 'The last days (test)',
      logline: 'A countdown to the day the buyers stopped coming (test).',
      centralQuestion: 'How long until the bidding stops (test)?',
      emotionalCentre: 'mounting dread shared with the viewer (test)',
      humanAnchor: 'you, a newcomer standing among the buyers (test)',
      narrativeMode: 'COUNTDOWN',
      povStrategy: { type: 'VIEWER_POV', description: 'You are placed in the room (test).' },
      opening: { concept: 'You arrive as the bidding begins (test).', basis: 'RECONSTRUCTION', unitKey: keys[1]! },
      movements: movements(rotated, 'The clock runs down (test).'),
      resolution: 'The day it ends, and what came after (test).',
      differs: 'Races against a known end (test).',
    },
  ];
}

// ── Fake AI ──────────────────────────────────────────────────────────────────

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
  /** Fail every call for this task with a permanent error (the step is reported unavailable). */
  brokenTask: string | null = null;
  /** Successive story.mine responses (the last one repeats). */
  mineBatches: MinedCandidate[][] = [[...FAKE_VALID, ...FAKE_INVALID]];
  /** Critic support verdicts by candidate title (default SUPPORTED). */
  support: Record<string, SupportVerdict> = { 'Critic-flagged story': 'UNSUPPORTED', 'The Semper Augustus price': 'NEEDS_CAVEAT' };
  /** Titles the critic leaves out of its first answer. */
  criticSkips = new Set<string>();
  /** Picks the proposed selection from the ranked keys. */
  selectKeys: (keys: string[]) => string[] = (keys) => [...keys.slice(0, 7), 'S99'];
  architectOptions: FakeArchitectOptions = {};
  /** How the architect revises an architecture (story.revise). */
  revisionOptions: FakeRevisionOptions = {};
  /** The angles the fake proposes for an angles prompt (default: three materially different ones). */
  angles: (prompt: string) => AnglesOutput['angles'] = fakeAngles;
  /** The story editor's revision of the draft (default: none). */
  storyEditorRevision: ((draft: ShownArchitecture) => ShownArchitecture | null) | null = null;
  /** The story editor's answers to the quality-bar questions (default: all pass). */
  storyEditorPasses = true;
  /** The fact checker fixes what the automated findings report: presentation, mislabelled beats, story evidence from outside the selection. */
  factCheckFixes = false;
  /** The opportunities the fake proposes for an architecture (default: fakeOpportunities). */
  opportunities: (arch: ShownArchitecture) => OpportunityOutput['opportunities'] = fakeOpportunities;

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
    if (this.brokenTask === req.task) throw new ProviderError('fake-ai', 'refused (test)', false);
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
        const found = [...user.matchAll(/^### ([MK]\d+) — (.+) \[[A-Z_]+\]$/gm)].map((m) => ({ ref: m[1]!, title: m[2]! }));
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
                humanStakes: 3 + ((i * 5) % 8),
                conflict: 5 + (i % 5),
                mystery: 4 + ((i * 3) % 7),
                escalation: 4 + ((i * 2) % 6),
                characterPotential: 3 + ((i * 4) % 7),
                visualPotential: 6 + (i % 4),
                emotionalPotential: 4 + ((i * 6) % 6),
                revealPotential: 2 + ((i * 7) % 9),
                mythInvestigation: c.title.toLowerCase().includes('myth') || c.title.includes('ruin') || c.title.includes('sailor') ? 9 : 2,
                significance: 5 + (i % 4),
                relevance: 6 + (i % 3),
                uniqueness: 3 + ((i * 2) % 6),
                reasons: [
                  { dimension: 'humanStakes', reason: `Who stands to lose in ${c.title} (test).` },
                  { dimension: 'mystery', reason: 'An open question (test).' },
                  { dimension: 'notADimension', reason: 'Ignored by the rules (test).' },
                ],
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
          centralQuestion: 'Why did promises outrun the goods (test)?',
          narrativeMode: 'IMMERSIVE_RECONSTRUCTION',
          povStrategy: { type: 'VIEWER_POV', description: 'The viewer is a newcomer among the traders (test).' },
        } satisfies SelectionOutput;
      }
      case 'story.architect': {
        // Verdicts the prompt lists ("C006 PROBABLE → HEDGE"); every other claim is ESTABLISHED.
        const verdicts = new Map([...user.matchAll(/(C\d+) ([A-Z]+) → [A-Z_]+/g)].map((m) => [m[1]!, m[2] as ClaimVerdict]));
        return fakeArchitectOutput(parseFakeUnits(user), (k) => verdicts.get(k), this.architectOptions);
      }
      case 'story.revise': {
        const verdicts = new Map([...user.matchAll(/(C\d+) ([A-Z]+) → [A-Z_]+/g)].map((m) => [m[1]!, m[2] as ClaimVerdict]));
        return fakeRevision(user, (k) => verdicts.get(k), this.revisionOptions);
      }
      case 'story.angles':
        // All of them, whatever count was asked for: the rules keep at most that many.
        return { angles: this.angles(user) } satisfies AnglesOutput;
      case 'story.storyEditor':
        return this.storyEditor(user);
      case 'story.review':
        return this.factCheck(user);
      case 'story.opportunities':
        return { opportunities: this.opportunities(shownArchitecture(user)) } satisfies OpportunityOutput;
      default:
        throw new Error(`unexpected task ${task}`);
    }
  }

  private storyEditor(user: string): StoryEditorOutput {
    const draft = shownArchitecture(user);
    const revised = this.storyEditorRevision ? this.storyEditorRevision(structuredClone(draft)) : null;
    const answer = (why: string) => ({ pass: this.storyEditorPasses, why });
    return {
      scores: { immersion: 7, humanStakes: 6, narrativeDrive: 7, continuity: 8, cinematicPotential: 7, clarity: 8 },
      qualityBar: {
        storyWithoutCitations: answer('The traders carry it (test).'),
        compellingDocumentary: answer('It builds to the court (test).'),
        truthAndExperience: answer('The legend is tested on screen (test).'),
      },
      issues: [{ severity: 'MINOR', description: 'The second sequence could open closer to the action (test).', sequenceNumbers: [2], claimKeys: [], fixedInRevision: revised !== null }],
      revised,
    };
  }

  private factCheck(user: string): ArchitectureReviewOutput {
    if (!this.factCheckFixes) {
      return { issues: [{ severity: 'MINOR', description: 'Polish the hook (test).', sequenceNumbers: [1], claimKeys: [], fixedInRevision: false }], revised: null };
    }
    const draft = shownArchitecture(user);
    const issues: ArchitectureReviewOutput['issues'] = [];
    const seq = (n: string) => draft.sequences[Number(n) - 1]!;
    // Beats presented as documented on claims that are not ESTABLISHED, and myths outside an investigation: relabel them UNCERTAIN.
    const mislabelled = [...user.matchAll(/^- Sequence (\d+): beat (\d+\.\d+) (?:is presented as documented fact but rests on|uses a MYTH claim)/gm)];
    for (const m of mislabelled) {
      const beat = seq(m[1]!).beats.find((b) => b.id === m[2]);
      if (beat) beat.basis = 'UNCERTAIN';
    }
    if (mislabelled.length) issues.push({ severity: 'CRITICAL', description: 'Uncertain material presented as documented fact.', sequenceNumbers: mislabelled.map((m) => Number(m[1])), claimKeys: [], fixedInRevision: true });
    // Presentation entries: added, or corrected to what the verdict requires.
    const presentation = [...user.matchAll(/^- Sequence (\d+): (?:uses (C\d+) \((\w+)\) without saying how|presents (C\d+) \((\w+)\) as|the instruction for (C\d+) \((\w+)\))/gm)];
    for (const m of presentation) {
      const key = (m[2] ?? m[4] ?? m[6])!;
      const verdict = (m[3] ?? m[5] ?? m[7]) as ClaimVerdict;
      const s = seq(m[1]!);
      const required = PRESENTATION_FOR_VERDICT[verdict];
      s.presentation = [...s.presentation.filter((p) => p.claimKey !== key), { claimKey: key, presentation: required, instruction: `${FAKE_INSTRUCTIONS[required]} (review fix)` }];
    }
    if (presentation.length) {
      issues.push({ severity: 'CRITICAL', description: 'Uncertain material told without its presentation.', sequenceNumbers: presentation.map((m) => Number(m[1])), claimKeys: presentation.map((m) => (m[2] ?? m[4] ?? m[6])!), fixedInRevision: true });
    }
    // Story evidence from outside the selection becomes labelled background.
    const outside = [...user.matchAll(/^- Sequence (\d+): uses (C\d+) as story evidence/gm)].map((m) => ({ seq: m[1]!, key: m[2]! }));
    for (const m of outside) {
      const s = seq(m.seq);
      s.claimKeys = s.claimKeys.filter((k) => k !== m.key);
      for (const b of s.beats) b.claimKeys = b.claimKeys.filter((k) => k !== m.key);
      s.contextClaims.push({ claimKey: m.key, purpose: 'Background only: explains the setting (review fix).' });
    }
    if (outside.length) issues.push({ severity: 'CRITICAL', description: 'Story beats taken from claims outside the selection.', sequenceNumbers: outside.map((m) => Number(m.seq)), claimKeys: outside.map((m) => m.key), fixedInRevision: true });
    return { issues, revised: draft };
  }
}
