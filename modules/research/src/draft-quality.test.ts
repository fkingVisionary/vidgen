import type { ClaimVerdict, ResearchDossierContent, SourceType } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_CONFIG } from './config.ts';
import { buildDraft, normalizeDraft, type DossierDraft, type DraftCitation, type DraftClaim, type DraftSource, type EvidenceRecord } from './draft.ts';
import { computeQualityReport } from './quality.ts';
import type { SynthesisOutput } from './schemas.ts';

const TYPES: SourceType[] = ['PRIMARY', 'ACADEMIC', 'BOOK', 'ARCHIVE', 'REPUTABLE_SECONDARY', 'GENERAL_REFERENCE', 'GENERAL_WEB'];

/** 14 retrieved sources across all seven types and 14 domains, plus one duplicate. */
function makeSources(): Map<string, DraftSource> {
  const m = new Map<string, DraftSource>();
  for (let i = 1; i <= 14; i++) {
    m.set(`src${i}`, { id: `src${i}`, key: `S${i}`, url: `https://site${i}.org/page`, domain: `site${i}.org`, sourceType: TYPES[(i - 1) % TYPES.length]!, retrieved: true, duplicateOfId: null });
  }
  m.set('dup', { id: 'dup', key: 'S99', url: 'https://mirror.org/page', domain: 'mirror.org', sourceType: 'GENERAL_WEB', retrieved: true, duplicateOfId: 'src2' });
  m.set('gone', { id: 'gone', key: 'S98', url: 'https://gone.org/x', domain: 'gone.org', sourceType: 'ACADEMIC', retrieved: false, duplicateOfId: null });
  return m;
}

const cite = (sourceId: string, stance: DraftCitation['stance'] = 'SUPPORTS', evidenceId = `${sourceId}.E${Math.random().toString(36).slice(2, 7)}`): DraftCitation => ({
  evidenceId, sourceId, stance, basis: 'FULL_TEXT', quote: 'a verified quote of sufficient length', locator: null, quoteVerified: true,
});

const claim = (key: string, verdict: ClaimVerdict, citations: DraftCitation[], over: Partial<DraftClaim> = {}): DraftClaim => ({
  key, statement: `Statement ${key}`, claimType: 'EVENT', category: 'Q1', importance: 'SUPPORTING', verdict, confidence: 'MEDIUM',
  popularVersion: null, notes: 'notes', needsVerification: false, citations, ...over,
});

const emptyContent = (): ResearchDossierContent => ({
  questions: [{ id: 'Q1', category: 'chronology', question: 'When?', rationale: null, queries: ['q'], answerSummary: null, confidence: null }],
  timeline: [], keyFigures: [], priceEvidence: [], myths: [], interpretations: [],
  bubbleAssessment: { summary: 's', argumentsFor: [], argumentsAgainst: [], claimKeys: [] },
  narrativeHistory: { summary: 's', milestones: [], claimKeys: [] },
  openQuestions: [], missingEvidence: [],
});

/** A dossier that satisfies every default threshold. */
function goodDraft(): DossierDraft {
  const claims: DraftClaim[] = [];
  for (let i = 1; i <= 26; i++) {
    const a = `src${((i - 1) % 14) + 1}`;
    const b = `src${(i % 14) + 1}`;
    claims.push(claim(`C${String(i).padStart(3, '0')}`, 'ESTABLISHED', [cite(a), cite(b)], { importance: i <= 10 ? 'KEY' : 'SUPPORTING' }));
  }
  claims.push(claim('C027', 'MYTH', [cite('src7'), cite('src2', 'CONTRADICTS')], { popularVersion: 'Everyone was ruined' }));
  claims.push(claim('C028', 'UNVERIFIED', [], { needsVerification: true }));
  claims.push(claim('C029', 'DISPUTED', [cite('src2'), cite('src3', 'CONTRADICTS')], { needsVerification: true }));
  return { summary: 'summary', claims, content: { ...emptyContent(), timeline: [{ date: '1637', event: 'Collapse', approximate: false, claimKeys: ['C001'] }] } };
}

const report = (draft: DossierDraft, sources = makeSources(), extra: Partial<Parameters<typeof computeQualityReport>[0]> = {}) =>
  computeQualityReport({ draft, sources, thresholds: DEFAULT_RESEARCH_CONFIG.gate, normalizations: [], coherenceIssues: [], duplicatesDetected: 1, ...extra });
const status = (r: ReturnType<typeof report>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe('buildDraft', () => {
  it('resolves evidence IDs into citations and reports unknown IDs', () => {
    const evidence = new Map<string, EvidenceRecord>([
      ['S1.E1', { id: 'S1.E1', sourceId: 'src1', focusAreas: ['F1'], statement: 's', quote: 'quote one is long enough', locator: 'p. 3', kind: 'FACT', attribution: 'author', verified: true }],
    ]);
    const synthesis = {
      summary: 'x',
      questionAnswers: [{ questionId: 'Q1', answerSummary: 'In 1637', confidence: 'HIGH' }],
      claims: [
        { key: 'C001', statement: 's', claimType: 'DATE', questionId: 'Q1', importance: 'KEY', verdict: 'ESTABLISHED', confidence: 'HIGH', popularVersion: '  ', notes: '', needsVerification: false, supportingEvidence: ['S1.E1', 'S9.E9', 'S1.E1'], contradictingEvidence: [], contextEvidence: [] },
        { key: 'C002', statement: 's', claimType: 'DATE', questionId: 'Q1', importance: 'KEY', verdict: 'DISPUTED', confidence: 'LOW', popularVersion: null, notes: '', needsVerification: true, supportingEvidence: ['S1.E1'], contradictingEvidence: ['S1.E1'], contextEvidence: [] },
      ],
      ...(({ questions: _q, ...rest }) => rest)(emptyContent()),
    } as SynthesisOutput;
    const { draft, notes } = buildDraft(synthesis, evidence, [{ id: 'Q1', category: 'chronology', question: 'When?', rationale: 'r', queries: ['q'] }]);
    expect(draft.claims[0]!.citations).toEqual([{ evidenceId: 'S1.E1', sourceId: 'src1', stance: 'SUPPORTS', basis: 'FULL_TEXT', quote: 'quote one is long enough', locator: 'p. 3', quoteVerified: true }]);
    expect(draft.claims[0]!.popularVersion).toBeNull();
    // Repeating an ID in the same role is silently de-duplicated; using it for both sides is reported.
    expect(notes).toEqual(['C001: dropped citation to unknown evidence ID "S9.E9"', 'C002: evidence S1.E1 cited both as CONTRADICTS and SUPPORTS; kept CONTRADICTS']);
    expect(draft.claims[0]!.citations).toHaveLength(1);
    expect(draft.content.questions[0]).toMatchObject({ answerSummary: 'In 1637', confidence: 'HIGH' });
  });
});

describe('normalizeDraft — no verdict claims more than its citations allow', () => {
  const run = (claims: DraftClaim[], content = emptyContent()) => {
    const draft: DossierDraft = { summary: '', claims, content };
    const notes = normalizeDraft(draft, makeSources());
    return { draft, notes, c: (k: string) => draft.claims.find((x) => x.key === k)! };
  };

  it('demotes uncited claims to UNVERIFIED and flags them', () => {
    const { c, notes } = run([claim('C001', 'ESTABLISHED', [])]);
    expect(c('C001')).toMatchObject({ verdict: 'UNVERIFIED', needsVerification: true });
    expect(notes[0]).toMatch(/ESTABLISHED → UNVERIFIED \(no verified citation\)/);
  });

  it('requires counter-evidence for a MYTH, and fills its popular version', () => {
    const { c } = run([claim('C001', 'MYTH', [cite('src7')]), claim('C002', 'MYTH', [cite('src2', 'CONTRADICTS')])]);
    expect(c('C001').verdict).toBe('UNVERIFIED');
    expect(c('C002')).toMatchObject({ verdict: 'MYTH', popularVersion: 'Statement C002' });
  });

  it('requires two independent sources or one high-tier source for ESTABLISHED', () => {
    const { c } = run([
      claim('C001', 'ESTABLISHED', [cite('src7')]), // one GENERAL_WEB source
      claim('C002', 'ESTABLISHED', [cite('src2')]), // one ACADEMIC source
      claim('C003', 'ESTABLISHED', [cite('src5'), cite('src6')]), // two independent weaker sources
      claim('C004', 'ESTABLISHED', [cite('src7'), cite('src7')]), // same source twice ≠ independent
    ]);
    expect([c('C001').verdict, c('C002').verdict, c('C003').verdict, c('C004').verdict]).toEqual(['PROBABLE', 'ESTABLISHED', 'ESTABLISHED', 'PROBABLE']);
  });

  it('turns ESTABLISHED into DISPUTED when a strong source contradicts it, but not for a popular page', () => {
    const { c } = run([
      claim('C001', 'ESTABLISHED', [cite('src2'), cite('src1', 'CONTRADICTS')]), // contradicted by PRIMARY
      claim('C002', 'ESTABLISHED', [cite('src2'), cite('src7', 'CONTRADICTS')]), // contradicted by GENERAL_WEB
    ]);
    expect(c('C001')).toMatchObject({ verdict: 'DISPUTED', needsVerification: true });
    expect(c('C002').verdict).toBe('ESTABLISHED');
  });

  it('moves citations off duplicates and drops unretrieved or unverified ones', () => {
    const unverified = { ...cite('src3'), quoteVerified: false };
    const { c, notes } = run([claim('C001', 'PROBABLE', [cite('dup'), cite('gone'), unverified])]);
    expect(c('C001').citations.map((x) => x.sourceId)).toEqual(['src2']);
    expect(notes.join('\n')).toMatch(/moved from duplicate S99 to S2/);
    expect(notes.join('\n')).toMatch(/source not retrieved/);
    expect(notes.join('\n')).toMatch(/quote not verified/);
  });

  it('renames duplicate keys and removes section entries that rest on no claim', () => {
    const content = { ...emptyContent(), timeline: [
      { date: '1636', event: 'ok', approximate: false, claimKeys: ['C001'] },
      { date: '1637', event: 'orphan', approximate: false, claimKeys: ['C404'] },
    ] };
    const { draft, notes } = run([claim('C001', 'PROBABLE', [cite('src2')]), claim('C001', 'PROBABLE', [cite('src3')])], content);
    expect(new Set(draft.claims.map((x) => x.key)).size).toBe(2);
    expect(draft.content.timeline.map((t) => t.event)).toEqual(['ok']);
    expect(notes.join('\n')).toMatch(/renamed/);
  });

  it('is idempotent', () => {
    const { draft } = run([claim('C001', 'ESTABLISHED', [cite('src7')]), claim('C002', 'MYTH', [cite('src2', 'CONTRADICTS')])]);
    expect(normalizeDraft(draft, makeSources())).toEqual([]);
  });
});

describe('computeQualityReport', () => {
  it('passes a well-sourced dossier', () => {
    const draft = goodDraft();
    normalizeDraft(draft, makeSources());
    const r = report(draft);
    expect(r.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('fails on too few sources and too little diversity', () => {
    const draft = goodDraft();
    for (const c of draft.claims) c.citations = c.citations.map((x) => ({ ...x, sourceId: 'src2' }));
    const r = report(draft);
    expect(status(r, 'min_sources')).toBe('FAIL');
    expect(status(r, 'source_diversity')).toBe('FAIL');
    expect(status(r, 'high_tier_sources')).toBe('FAIL');
    expect(r.passed).toBe(false);
  });

  it('fails a dossier built mostly on general-web pages', () => {
    const draft = goodDraft();
    for (const c of draft.claims.slice(0, 20)) c.citations = c.citations.map((x) => ({ ...x, sourceId: 'src7' }));
    expect(status(report(draft), 'general_web_share')).toBe('FAIL');
  });

  it('fails uncited claims, key claims without full-text evidence and unverified quotes', () => {
    const draft = goodDraft();
    draft.claims[0]!.citations = [];
    draft.claims[1]!.citations = draft.claims[1]!.citations.map((x) => ({ ...x, basis: 'SNIPPET' as const, quoteVerified: false }));
    const r = report(draft);
    expect(status(r, 'claims_cited')).toBe('FAIL');
    expect(status(r, 'key_claims_full_text')).toBe('FAIL');
    expect(status(r, 'quotes_verified')).toBe('FAIL');
  });

  it('fails unflagged disputes, unflagged unverified claims and myths without counter-evidence', () => {
    const draft = goodDraft();
    draft.claims.push(claim('C030', 'PROBABLE', [cite('src2'), cite('src4', 'CONTRADICTS')], { notes: '' }));
    draft.claims.push(claim('C031', 'UNVERIFIED', [], { needsVerification: false }));
    draft.claims.push(claim('C032', 'MYTH', [cite('src7')], { popularVersion: null }));
    draft.claims.push(claim('C033', 'DISPUTED', [cite('src2')], { needsVerification: false }));
    const r = report(draft);
    expect(status(r, 'disputes_flagged')).toBe('FAIL');
    expect(status(r, 'unverified_flagged')).toBe('FAIL');
    expect(status(r, 'myths_evidenced')).toBe('FAIL');
    expect(status(r, 'disputed_explained')).toBe('FAIL');
  });

  it('fails invalid or unretrieved URLs and duplicates cited as separate sources', () => {
    const sources = makeSources();
    sources.set('src1', { ...sources.get('src1')!, url: 'https://mock.invalid/x' });
    const draft = goodDraft();
    draft.claims[5]!.citations.push(cite('dup'));
    const r = report(draft, sources);
    expect(status(r, 'valid_urls')).toBe('FAIL');
    expect(status(r, 'duplicates')).toBe('FAIL');
  });

  it('fails on unresolved critical coherence issues and warns on major ones', () => {
    const draft = goodDraft();
    const critical = report(draft, makeSources(), { coherenceIssues: [{ severity: 'CRITICAL', description: 'dates conflict', claimKeys: ['C001'], resolution: 'Left for human review' }] });
    expect(status(critical, 'internally_coherent')).toBe('FAIL');
    const fixed = report(draft, makeSources(), { coherenceIssues: [{ severity: 'CRITICAL', description: 'x', claimKeys: ['C001'], resolution: 'Applied: verdict → DISPUTED' }] });
    expect(status(fixed, 'internally_coherent')).toBe('PASS');
    const major = report(draft, makeSources(), { coherenceIssues: [{ severity: 'MAJOR', description: 'x', claimKeys: [], resolution: 'Left for human review' }] });
    expect(status(major, 'internally_coherent')).toBe('WARN');
  });

  it('fails when timeline events rest only on myths, and on too few claims', () => {
    const draft = goodDraft();
    draft.content.timeline.push({ date: '1637', event: 'Everyone ruined', approximate: false, claimKeys: ['C027'] });
    expect(status(report(draft), 'internally_coherent')).toBe('FAIL');
    const small = goodDraft();
    small.claims = small.claims.slice(0, 5);
    expect(status(report(small), 'claim_count')).toBe('FAIL');
  });
});
