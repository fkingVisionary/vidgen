import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRITING_CATEGORIES, WritingCorpusExample, type WritingCorpusExample as Example } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { styleBibleMarkdown, styleBibleText } from './bible.ts';
import { corpusStats, filterCorpus, loadCorpus, withHouseExamples, type CorpusEntry } from './corpus.ts';
import { corpusFiles, corpusIndex } from './docs-cli.ts';
import { patternsMarkdown, rubricMarkdown } from './docs.ts';
import { aiSignals } from './fingerprints.ts';
import { DEFAULT_LIMITS, asRecord, renderExamples, retrieve, type RetrievalNeed } from './retrieval.ts';

/**
 * The corpus: every file valid, every category taught both ways, generic,
 * copyright-safe, versioned by its exact wording; the generated documents in
 * step with their sources; retrieval targeted, limited and deterministic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, '..', 'corpus');
const TOPIC = /tulip|bulb|guilder|stuiver|florist|haarlem|amsterdam|alkmaar|holland|dutch|semper|augustus|mackay|switser|thijs|pamphlet|1636|1637/i;

describe('the corpus files', () => {
  const corpus = loadCorpus();

  it('all validate, with unique ids, and every file is in the bundled index', () => {
    expect(corpus.errors).toEqual([]);
    expect(new Set(corpus.examples.map((e) => e.id)).size).toBe(corpus.examples.length);
    expect(readFileSync(join(corpusDir, 'index.ts'), 'utf8')).toBe(corpusIndex(corpusFiles()));
    expect(corpusFiles().length).toBeGreaterThanOrEqual(30);
  });

  it('teach every category both ways: models to follow and habits to avoid, with judgment calls besides', () => {
    for (const c of WRITING_CATEGORIES.filter((x) => x !== 'other' || corpus.examples.some((e) => e.category === 'other'))) {
      const of = corpus.examples.filter((e) => e.category === c);
      if (!of.length) continue;
      expect([c, of.some((e) => e.polarity === 'positive' || e.polarity === 'house_style')]).toEqual([c, true]);
    }
    const s = corpusStats(corpus.examples);
    expect(s.polarity.positive).toBeGreaterThan(30);
    expect(s.polarity.negative).toBeGreaterThan(25);
    expect(s.polarity.borderline).toBeGreaterThan(10);
    expect(s.polarity.house_style).toBeGreaterThan(5);
    // The categories the brief names: hooks, explanation, money, numbers, characters, uncertainty, transitions, scenes, conclusions.
    for (const c of ['hook', 'explanation', 'economics', 'numbers', 'character', 'uncertainty', 'transition', 'scene', 'ending'] as const) expect([c, (s.category[c] ?? 0) > 0]).toEqual([c, true]);
  });

  it('is copyright-safe original house writing, approved for retrieval, and generic (no subject of a film in production)', () => {
    for (const e of corpus.examples) {
      expect([e.id, e.copyrightSafe, e.approvedForRetrieval]).toEqual([e.id, true, true]);
      expect(['house', 'generated_comparison']).toContain(e.source.type);
      expect([e.id, TOPIC.exec(JSON.stringify(e))?.[0] ?? null]).toEqual([e.id, null]);
    }
  });

  it('annotates every example: why a model works, why a habit fails, and the house version of every bad one', () => {
    for (const e of corpus.examples) {
      if (e.quality === 'excellent' || e.quality === 'good') expect([e.id, !!e.whyItWorks?.trim()]).toEqual([e.id, true]);
      if (e.quality === 'bad') expect([e.id, !!e.whyItFails?.trim(), !!e.rewrite?.trim()]).toEqual([e.id, true, true]);
      if (e.quality === 'borderline') expect([e.id, !!e.whyItWorks?.trim() && !!e.whyItFails?.trim()]).toEqual([e.id, true]);
      expect(e.spokenRhythm.trim() && e.narrativeFunction.trim()).toBeTruthy();
    }
  });

  it('practises what it preaches: models to follow show no machine habit the house calls wrong everywhere; habits to avoid do', () => {
    const block = (e: Example, text = e.text) => ({ key: '1.1', section: 1, text, infoClass: 'DOCUMENTED', speakerId: null, claimKeys: [] });
    for (const e of corpus.examples.filter((x) => x.polarity === 'positive' || x.polarity === 'house_style')) {
      expect([e.id, aiSignals([block(e)]).filter((s) => s.kind === 'HARD').map((s) => s.pattern)]).toEqual([e.id, []]);
    }
    const bad = corpus.examples.filter((x) => x.polarity === 'negative');
    // Most bad examples trip the detector; their house versions trip it far less.
    const flagged = bad.filter((e) => aiSignals([block(e)]).length > 0).length;
    expect(flagged / bad.length).toBeGreaterThan(0.6);
    const rewrites = bad.reduce((n, e) => n + aiSignals([block(e, e.rewrite!)]).filter((s) => s.kind === 'HARD').length, 0);
    const originals = bad.reduce((n, e) => n + aiSignals([block(e)]).filter((s) => s.kind === 'HARD').length, 0);
    expect(rewrites).toBeLessThan(originals / 3);
  });

  it('has a version: the manifest semver plus a hash of the exact wording, changed by house examples a person approved', () => {
    expect(corpus.version).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{8}$/);
    expect(corpus.manifest.changes.at(-1)!.version).toBe(corpus.manifest.version);
    const house: Example = { id: 'house-test-1-1', version: 1, text: 'The ledger closed at noon. Nobody wrote in it again.', category: 'ending', quality: 'good', traits: ['restraint'], strengths: [], weaknesses: [], spokenRhythm: 'two short lines', narrativeFunction: 'ends', whyItWorks: 'It stops when the story stops.', source: { type: 'house' }, copyrightSafe: true, approvedForRetrieval: true };
    const joined = withHouseExamples(corpus, [house]);
    expect(joined.version).toMatch(new RegExp(`^${corpus.version.replace('+', '\\+')}\\+h[0-9a-f]{8}$`));
    expect(joined.examples.at(-1)).toMatchObject({ id: house.id, origin: 'HOUSE', polarity: 'house_style' });
    expect(withHouseExamples(corpus, [{ ...house, version: 2 }]).version).not.toBe(joined.version);
    expect(withHouseExamples(corpus, []).version).toBe(corpus.version);
  });
});

describe('the corpus entry model', () => {
  const base = { id: 'x-p-one', version: 1, text: 'A line.', category: 'hook', quality: 'good', traits: [], strengths: [], weaknesses: [], spokenRhythm: '', narrativeFunction: '', whyItWorks: 'Because.', source: { type: 'house' }, copyrightSafe: true, approvedForRetrieval: true };
  it('refuses an example that is retrievable but not copyright-safe, a model without why it works, a habit without why it fails', () => {
    expect(WritingCorpusExample.safeParse(base).success).toBe(true);
    expect(WritingCorpusExample.safeParse({ ...base, copyrightSafe: false }).success).toBe(false);
    expect(WritingCorpusExample.safeParse({ ...base, copyrightSafe: false, approvedForRetrieval: false }).success).toBe(true);
    expect(WritingCorpusExample.safeParse({ ...base, whyItWorks: undefined }).success).toBe(false);
    expect(WritingCorpusExample.safeParse({ ...base, quality: 'bad', whyItWorks: undefined }).success).toBe(false);
    expect(WritingCorpusExample.safeParse({ ...base, quality: 'bad', whyItFails: 'Hype.' }).success).toBe(true);
    expect(WritingCorpusExample.safeParse({ ...base, quality: 'borderline' }).success).toBe(false);
    expect(WritingCorpusExample.safeParse({ ...base, id: 'Not An Id' }).success).toBe(false);
    expect(WritingCorpusExample.safeParse({ ...base, source: { type: 'scraped' } }).success).toBe(false);
  });
});

describe('the generated documents', () => {
  it('are in step with their sources (STYLE_BIBLE.md, RUBRIC.md, annotations/PATTERNS.md)', () => {
    expect(readFileSync(join(corpusDir, 'STYLE_BIBLE.md'), 'utf8')).toBe(styleBibleMarkdown());
    expect(readFileSync(join(corpusDir, 'RUBRIC.md'), 'utf8')).toBe(rubricMarkdown());
    expect(readFileSync(join(corpusDir, 'annotations', 'PATTERNS.md'), 'utf8')).toBe(patternsMarkdown());
  });

  it('keep the house style the brief set out, and stay generic', () => {
    const text = styleBibleText();
    for (const rule of ['Intelligent. Calm. Confident. Curious. Historically grounded. Conversational. Occasionally cinematic. Never theatrically desperate.', 'Explain. Don’t lecture.', 'Reveal. Don’t keep announcing', 'Trust. Don’t tell the listener what to feel', 'The surviving records don’t give us a reliable equivalent.', 'Never westernised']) expect(text).toContain(rule);
    expect(TOPIC.exec(text)).toBeNull();
    expect(TOPIC.exec(rubricMarkdown())).toBeNull();
    expect(TOPIC.exec(patternsMarkdown())).toBeNull();
  });
});

describe('the writing module stays generic and a library', () => {
  it('has no subject of any documentary in its code, and calls no model', () => {
    for (const f of readdirSync(here).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(here, f), 'utf8');
      expect([f, TOPIC.exec(src)?.[0] ?? null]).toEqual([f, null]);
      expect([f, /generateObject|callProvider|@docengine\/providers|@docengine\/pipeline/.test(src)]).toEqual([f, false]);
    }
  });
});

// ── Retrieval ────────────────────────────────────────────────────────────────

const entry = (id: string, over: Partial<CorpusEntry>): CorpusEntry => ({
  id,
  version: 1,
  text: `Text of ${id}.`,
  category: 'other',
  quality: 'good',
  traits: [],
  strengths: [],
  weaknesses: [],
  spokenRhythm: '',
  narrativeFunction: '',
  whyItWorks: 'It works.',
  source: { type: 'house' },
  copyrightSafe: true,
  approvedForRetrieval: true,
  polarity: 'positive',
  origin: 'FILE',
  file: null,
  ...over,
});
const need = (over: Partial<RetrievalNeed>): RetrievalNeed => ({ ref: '1.1', categories: [], traits: [], patterns: [], reason: 'test', ...over });

describe('retrieval', () => {
  const pool: CorpusEntry[] = [
    entry('economics-p-a', { category: 'economics', traits: ['money_context', 'number_in_context'], quality: 'excellent' }),
    entry('economics-p-b', { category: 'economics', traits: ['money_context'] }),
    entry('economics-p-c', { category: 'economics', traits: ['money_context'] }),
    entry('numbers-p-a', { category: 'numbers', traits: ['number_in_context', 'spoken_clarity'] }),
    entry('character-p-a', { category: 'character', traits: ['character_intro'] }),
    entry('hook-p-a', { category: 'hook', traits: ['restraint', 'tension'] }),
    entry('hook-h-a', { category: 'hook', traits: ['restraint'], polarity: 'house_style' }),
    entry('scene-n-a', { category: 'scene', quality: 'bad', polarity: 'negative', traits: ['visual_description', 'emotion_explained'], whyItFails: 'It describes the shot.', rewrite: 'The duty would take the profit.' }),
    entry('transition-n-a', { category: 'transition', quality: 'bad', polarity: 'negative', traits: ['dramatic_transition'], whyItFails: 'A fake beat.', rewrite: 'The price fell.' }),
    entry('other-b-a', { category: 'other', quality: 'borderline', polarity: 'borderline', traits: ['contrast_formula'], whyItWorks: 'Once.', whyItFails: 'Twice.' }),
    entry('secret-p-a', { category: 'economics', traits: ['money_context'], approvedForRetrieval: false }),
    entry('unsafe-p-a', { category: 'economics', traits: ['money_context'], copyrightSafe: false, approvedForRetrieval: false }),
  ];

  it('gives a money explanation money, numbers and spoken-clarity examples; a character introduction character examples; a hook hook examples', () => {
    const money = retrieve(pool, [need({ ref: '2.1', categories: ['economics', 'numbers', 'context'], traits: ['money_context', 'number_in_context', 'spoken_clarity'], reason: 'a sum of money' })]);
    expect(money.map((r) => r.example.id)).toEqual(['economics-p-a', 'numbers-p-a', 'economics-p-b']);
    const character = retrieve(pool, [need({ categories: ['character', 'context'], traits: ['character_intro'] })]);
    expect(character.map((r) => r.example.id)).toEqual(['character-p-a']);
    const hook = retrieve(pool, [need({ categories: ['hook', 'scene'], traits: ['tension', 'restraint'] })]);
    expect(hook.map((r) => r.example.id)).toEqual(['hook-h-a', 'hook-p-a']);
  });

  it('gives a flagged pattern a bad example of it with the house version, and a judgment call when the pattern is one', () => {
    const r = retrieve(pool, [need({ ref: '3.2', categories: ['scene'], patterns: ['visual_description'], reason: 'narration describing the picture' }), need({ ref: '4.1', patterns: ['contrast_formula', 'dramatic_transition'] })]);
    const ids = r.map((x) => x.example.id);
    expect(ids).toContain('scene-n-a');
    expect(ids).toContain('transition-n-a');
    expect(ids).toContain('other-b-a');
    expect(r.find((x) => x.example.id === 'scene-n-a')!.refs).toEqual(['3.2']);
    const text = renderExamples(r);
    expect(text).toContain('# House style — reference examples (style only: they carry no facts; never reuse their names, numbers or events)');
    expect(text).toContain('- ✗ "Text of scene-n-a." → ✓ "The duty would take the profit."');
    expect(text).toMatch(/## Judgment calls — right once, wrong when repeated\n- "Text of other-b-a\." — works: Once\.; fails: Twice\./);
    // No line imitates the structures the fakes and the stage parse.
    expect(text).not.toMatch(/^\[\d+\.\d+\]|^\d+\. |^- beat |^## Sequence/m);
  });

  it('never retrieves an example that is not approved for retrieval or not copyright-safe', () => {
    const ids = retrieve(pool, [need({ categories: ['economics'], traits: ['money_context'] })]).map((r) => r.example.id);
    expect(ids).not.toContain('secret-p-a');
    expect(ids).not.toContain('unsafe-p-a');
    expect(filterCorpus(pool, { retrievable: true }).map((e) => e.id)).not.toContain('secret-p-a');
  });

  it('keeps within its limits — never the whole corpus — and is deterministic', () => {
    const many: CorpusEntry[] = Array.from({ length: 40 }, (_, i) => entry(`economics-p-${String(i).padStart(2, '0')}`, { category: i % 2 ? 'economics' : 'numbers', traits: ['money_context'] }));
    const needs = Array.from({ length: 10 }, (_, i) => need({ ref: `1.${i + 1}`, categories: ['economics', 'numbers'], traits: ['money_context'] }));
    const r = retrieve(many, needs);
    expect(r.length).toBeLessThanOrEqual(DEFAULT_LIMITS.positive);
    expect(r.filter((x) => x.example.category === 'economics').length).toBeLessThanOrEqual(DEFAULT_LIMITS.perCategory);
    expect(retrieve(many, needs).map((x) => x.example.id)).toEqual(r.map((x) => x.example.id));
    expect(retrieve(many, [])).toEqual([]);
    expect(asRecord(r)[0]).toMatchObject({ id: r[0]!.example.id, version: 1, refs: expect.any(Array), reason: 'test' });
  });

  it('works on the real corpus: a money need gets economics or numbers examples, a flagged fake beat a bad example of one', () => {
    const corpus = loadCorpus();
    const r = retrieve(corpus.examples, [
      need({ ref: '2.3', categories: ['economics', 'numbers', 'context'], traits: ['money_context', 'number_in_context', 'spoken_clarity'], reason: 'a sum of money' }),
      need({ ref: '1.4', categories: ['other'], patterns: ['dramatic_transition'], reason: 'dramatic_transition to fix' }),
    ]);
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThanOrEqual(DEFAULT_LIMITS.positive + DEFAULT_LIMITS.negative + DEFAULT_LIMITS.borderline);
    expect(r.some((x) => x.example.polarity === 'negative' && x.example.traits.includes('dramatic_transition'))).toBe(true);
    if (corpus.examples.some((e) => e.category === 'economics')) expect(r.some((x) => x.example.category === 'economics' || x.example.category === 'numbers')).toBe(true);
  });
});
