import {
  CLAIM_VERDICTS,
  QualityReport,
  SOURCE_TIER,
  ResearchDossierContent,
  type CoherenceIssue,
  type SourceType,
} from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError } from '@docengine/providers';
import { DEFAULT_FOCUS_AREAS, DEFAULT_RESEARCH_CONFIG, type ResearchConfig } from './config.ts';
import { EXCLUDED_DOMAINS, PREFERRED_DOMAINS, isExcludedDomain, sourceTypeHint } from './domains.ts';
import { buildDraft, normalizeDraft, type DossierDraft, type DraftSource, type EvidenceRecord } from './draft.ts';
import {
  PROMPT_VERSION,
  planSystemPrompt,
  planUserPrompt,
  readSystemPrompt,
  readUserPrompt,
  reviewSystemPrompt,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  triageSystemPrompt,
  triageUserPrompt,
} from './prompts.ts';
import { computeQualityReport } from './quality.ts';
import { PlanOutput, ReadOutput, ReviewOutput, SynthesisOutput, TriageOutput } from './schemas.ts';
import { SAME_WORK_THRESHOLD, openAccessLookup, sameWorkScore, titleTokens, type OpenAccessLookup } from './open-access.ts';
import { normalizeForMatch, relevantExcerpt, sha256, textSimilarity, topicKeywords, verifyQuote } from './text.ts';
import { domainOf, normalizeUrl } from './urls.ts';
import { countBy, errorMessage, mapLimit } from './util.ts';

/**
 * RESEARCH stage. Tavily (or any ResearchProvider) discovers and retrieves
 * sources; Claude (or any AIProvider) plans, triages, reads and synthesises.
 * Nothing here names a vendor.
 *
 *   plan → discover → triage → retrieve → read (verified quotes) → synthesise
 *        → normalise → coherence review → quality gate → persist dossier vN
 *
 * Retrieved documents and their per-source analyses are stored, so a retry
 * or a later version re-reads only what is new.
 */
export function createResearchStage(overrides: Partial<ResearchConfig> = {}): StageHandler {
  const cfg: ResearchConfig = { ...DEFAULT_RESEARCH_CONFIG, ...overrides, gate: { ...DEFAULT_RESEARCH_CONFIG.gate, ...overrides.gate } };
  return { type: 'RESEARCH', mock: false, run: (ctx) => new ResearchRun(ctx, cfg).run() };
}

interface PlanQuestion {
  id: string;
  category: string;
  question: string;
  rationale: string;
  queries: string[];
}

interface Candidate {
  id: string; // C12
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  snippet: string;
  score: number;
  publishedDate: string | null;
  hint: SourceType;
  questionIds: Set<string>;
  queries: Set<string>;
}

interface Retrieved {
  sourceId: string;
  key: string; // S1, S2, … in this run
  url: string;
  domain: string;
  title: string;
  hint: SourceType;
  documentId: string;
  text: string;
  normalized: string;
  sha: string;
  duplicateOfId: string | null;
  sourceType: SourceType;
  /** Told to the reader, e.g. that this is an open-access copy of another source. */
  note: string | null;
}

/** A selected source during retrieval. */
interface Row {
  sourceId: string;
  cand: Candidate;
  doc: { id: string; text: string; sha256: string } | null;
  error: string | null;
  note: string | null;
}

interface Stats {
  promptVersion: string;
  questions: number;
  searches: number;
  searchFailures: number;
  candidates: number;
  excludedResults: number;
  selected: number;
  retrievedNew: number;
  retrievedFromCache: number;
  retrievalFailed: number;
  openAccessLookups: number;
  openAccessRecovered: number;
  duplicates: number;
  read: number;
  readFromCache: number;
  readFailed: number;
  truncatedDocuments: number;
  evidenceVerified: number;
  evidenceRejected: number;
  models: string[];
  durationMs?: number;
}

class ResearchRun {
  private readonly stats: Stats = {
    promptVersion: PROMPT_VERSION,
    questions: 0,
    searches: 0,
    searchFailures: 0,
    candidates: 0,
    excludedResults: 0,
    selected: 0,
    retrievedNew: 0,
    retrievedFromCache: 0,
    retrievalFailed: 0,
    openAccessLookups: 0,
    openAccessRecovered: 0,
    duplicates: 0,
    read: 0,
    readFromCache: 0,
    readFailed: 0,
    truncatedDocuments: 0,
    evidenceVerified: 0,
    evidenceRejected: 0,
    models: [],
  };
  private readonly focusAreas: { id: string; text: string }[];
  private readonly brief: string[];
  /** Topic words used to pick the relevant passages of very long documents. */
  private readonly keywords: string[];

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: ResearchConfig,
  ) {
    const meta = (ctx.project.metadata ?? {}) as { researchBrief?: unknown; editorialBrief?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    this.brief = [...list(meta.researchBrief), ...list(meta.editorialBrief)];
    this.focusAreas = [...DEFAULT_FOCUS_AREAS, ...list(meta.researchBrief)].map((text, i) => ({ id: `F${i + 1}`, text }));
    this.keywords = topicKeywords(ctx.project.title, ctx.project.topic);
  }

  async run(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const plan = await this.plan();
    await this.checkpoint();
    const candidates = await this.discover(plan);
    await this.checkpoint();
    const selected = await this.triage(plan, candidates);
    await this.checkpoint();
    const retrieved = await this.retrieve(selected);
    await this.checkpoint();
    const evidence = await this.read(retrieved);
    await this.checkpoint();
    const synthesis = await this.synthesize(plan, retrieved, evidence);
    await this.checkpoint();

    const sources = new Map<string, DraftSource>(
      retrieved.map((r) => [r.sourceId, { id: r.sourceId, key: r.key, url: r.url, domain: r.domain, sourceType: r.sourceType, retrieved: true, duplicateOfId: r.duplicateOfId }]),
    );
    const { draft, notes } = buildDraft(synthesis, evidence, plan);
    notes.push(...normalizeDraft(draft, sources));
    const issues = await this.review(draft, sources, evidence);
    notes.push(...normalizeDraft(draft, sources)); // re-apply the rules after automatic review fixes

    const report = computeQualityReport({
      draft,
      sources,
      thresholds: this.cfg.gate,
      normalizations: notes,
      coherenceIssues: issues,
      duplicatesDetected: this.stats.duplicates,
    });
    this.stats.durationMs = Date.now() - started;
    const dossier = await this.persist(draft, report);

    const verdicts = Object.fromEntries(CLAIM_VERDICTS.map((v) => [v, draft.claims.filter((c) => c.verdict === v).length]));
    const citedIds = new Set(draft.claims.flatMap((c) => c.citations.map((x) => x.sourceId)));
    const cited = retrieved.filter((r) => citedIds.has(r.sourceId));
    await this.ctx.progress(
      `Research dossier v${dossier.version} saved: ${draft.claims.length} claims, ${cited.length} cited sources — quality gate ${report.passed ? 'PASSED' : 'FAILED'}`,
      { dossierId: dossier.id, verdicts },
    );
    if (!report.passed) {
      const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label} (${c.detail})`);
      throw new NonRetryableError(`Research quality gate failed: ${failed.join('; ')}. Dossier v${dossier.version} saved as DRAFT for inspection.`);
    }
    return {
      dossierId: dossier.id,
      version: dossier.version,
      qualityPassed: report.passed,
      claims: draft.claims.length,
      verdicts,
      citedSources: cited.length,
      sourcesByType: countBy(cited, (r) => r.sourceType),
      stats: this.stats,
    };
  }

  // ── 1. Plan ────────────────────────────────────────────────────────────────
  private async plan(): Promise<PlanQuestion[]> {
    const { ai } = this.ctx.providers;
    const p = this.ctx.project;
    const r = await this.ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ai.generateObject({
          task: 'research.plan',
          schema: PlanOutput,
          schemaName: 'ResearchPlan',
          system: planSystemPrompt(),
          messages: [{ role: 'user', content: planUserPrompt({ title: p.title, topic: p.topic, description: p.description, brief: this.brief, focusAreas: this.focusAreas.map((f) => f.text), maxQuestions: this.cfg.maxQuestions }) }],
          effort: this.cfg.effort.plan,
          maxTokens: 16_000,
          signal: this.ctx.signal,
        }),
      { request: { task: 'research.plan', focusAreas: this.focusAreas.length }, summarize: (x) => ({ questions: x.object.questions.length }) },
    );
    this.noteModel(r.meta.model);

    const questions = r.object.questions
      .slice(0, this.cfg.maxQuestions)
      .map((q, i) => ({
        id: `Q${i + 1}`,
        category: q.category.trim() || 'general',
        question: q.question.trim(),
        rationale: q.rationale.trim(),
        queries: [...new Set(q.queries.map((s) => s.trim()).filter(Boolean))].slice(0, 4),
      }))
      .filter((q) => q.question && q.queries.length > 0);
    if (questions.length < 3) throw new NonRetryableError(`Research plan too thin (${questions.length} usable questions)`);
    this.stats.questions = questions.length;
    await this.ctx.progress(`Research plan: ${questions.length} questions, ${questions.reduce((n, q) => n + q.queries.length, 0)} search queries`, {
      questions: questions.map((q) => `${q.id} ${q.question}`),
    });
    return questions;
  }

  // ── 2. Discover ────────────────────────────────────────────────────────────
  private async discover(plan: PlanQuestion[]): Promise<Candidate[]> {
    const { research } = this.ctx.providers;
    const tasks = plan.flatMap((q) => q.queries.map((query) => ({ q, query })));
    const results = await mapLimit(
      tasks,
      this.cfg.searchConcurrency,
      ({ q, query }) =>
        this.ctx.callProvider(
          'research',
          'search',
          () => research.search({ query, maxResults: this.cfg.resultsPerQuery, depth: 'advanced', preferDomains: [...PREFERRED_DOMAINS], excludeDomains: [...EXCLUDED_DOMAINS] }),
          { request: { query, questionId: q.id }, summarize: (r) => ({ results: r.results.length }) },
        ),
      this.ctx.signal,
    );

    const byUrl = new Map<string, Candidate>();
    results.forEach((res, i) => {
      const { q, query } = tasks[i]!;
      this.stats.searches++;
      if (!res.ok) {
        this.stats.searchFailures++;
        this.ctx.logger.warn({ query, err: errorMessage(res.error) }, 'search failed');
        return;
      }
      for (const hit of res.value.results) {
        const normalizedUrl = normalizeUrl(hit.url);
        const domain = domainOf(hit.url);
        if (!normalizedUrl || !domain || isExcludedDomain(domain)) {
          this.stats.excludedResults++;
          continue;
        }
        const existing = byUrl.get(normalizedUrl);
        if (existing) {
          existing.questionIds.add(q.id);
          existing.queries.add(query);
          existing.score = Math.max(existing.score, hit.score ?? 0);
          if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
        } else {
          byUrl.set(normalizedUrl, {
            id: `C${byUrl.size + 1}`,
            url: hit.url,
            normalizedUrl,
            domain,
            title: hit.title,
            snippet: hit.snippet,
            score: hit.score ?? 0,
            publishedDate: hit.publishedDate ?? null,
            hint: sourceTypeHint(domain),
            questionIds: new Set([q.id]),
            queries: new Set([query]),
          });
        }
      }
    });

    if (this.stats.searchFailures === tasks.length) {
      const first = results.find((r) => !r.ok) as { ok: false; error: unknown } | undefined;
      // Every search failing usually means an outage or credential problem: surface the provider's error (it says whether a retry can help).
      throw first?.error instanceof Error ? first.error : new Error('All searches failed');
    }
    const candidates = [...byUrl.values()];
    this.stats.candidates = candidates.length;
    await this.ctx.progress(
      `Discovery: ${this.stats.searches} searches (${this.stats.searchFailures} failed) → ${candidates.length} unique candidate sources`,
      { byTypeHint: countBy(candidates, (c) => c.hint), excludedResults: this.stats.excludedResults },
    );
    return candidates;
  }

  // ── 3. Triage ──────────────────────────────────────────────────────────────
  private async triage(plan: PlanQuestion[], candidates: Candidate[]): Promise<Candidate[]> {
    if (candidates.length === 0) throw new NonRetryableError('Discovery found no usable sources');
    // Keep the prompt bounded: strongest-first by coverage and score.
    const shortlist = [...candidates].sort((a, b) => b.questionIds.size - a.questionIds.size || b.score - a.score).slice(0, 220);
    const lines = shortlist
      .map((c) => `${c.id} | ${c.domain} | ${c.hint} | ${[...c.questionIds].join(',')} | ${c.title.slice(0, 140)} | ${c.url} | ${c.snippet.replace(/\s+/g, ' ').slice(0, 220)}`)
      .join('\n');
    const r = await this.ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        this.ctx.providers.ai.generateObject({
          task: 'research.triage',
          schema: TriageOutput,
          schemaName: 'SourceTriage',
          system: triageSystemPrompt(),
          messages: [{ role: 'user', content: triageUserPrompt({ questions: plan, candidates: lines, maxSelect: this.cfg.maxSourcesToRetrieve }) }],
          effort: this.cfg.effort.triage,
          maxTokens: 16_000,
          signal: this.ctx.signal,
        }),
      { request: { task: 'research.triage', candidates: shortlist.length }, summarize: (x) => ({ selected: x.object.selected.length }) },
    );
    this.noteModel(r.meta.model);

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const rank = { ESSENTIAL: 0, USEFUL: 1, BACKUP: 2 } as const;
    const picks = r.object.selected
      .filter((s) => byId.has(s.candidateId))
      .sort((a, b) => rank[a.priority] - rank[b.priority] || byId.get(b.candidateId)!.score - byId.get(a.candidateId)!.score);

    const chosen: Candidate[] = [];
    const perDomain = new Map<string, number>();
    const take = (c: Candidate, type?: SourceType) => {
      if (chosen.length >= this.cfg.maxSourcesToRetrieve || chosen.includes(c)) return;
      if ((perDomain.get(c.domain) ?? 0) >= this.cfg.maxPerDomain) return;
      if (type) c.hint = type;
      chosen.push(c);
      perDomain.set(c.domain, (perDomain.get(c.domain) ?? 0) + 1);
    };
    for (const p of picks) take(byId.get(p.candidateId)!, p.likelySourceType);
    // Coverage guardrail: every question gets at least two candidates when any exist.
    for (const q of plan) {
      const covered = chosen.filter((c) => c.questionIds.has(q.id)).length;
      if (covered >= 2) continue;
      const extra = candidates.filter((c) => c.questionIds.has(q.id) && !chosen.includes(c)).sort((a, b) => b.score - a.score);
      for (const c of extra.slice(0, 2 - covered)) take(c);
    }
    this.stats.selected = chosen.length;
    await this.ctx.progress(`Triage: ${chosen.length} of ${candidates.length} candidates selected for full-text retrieval`, {
      byType: countBy(chosen, (c) => c.hint),
    });
    return chosen;
  }

  // ── 4. Retrieve ────────────────────────────────────────────────────────────
  private async retrieve(selected: Candidate[]): Promise<Retrieved[]> {
    const { db } = this.ctx;
    const rows = new Map<string, Row>();
    for (const cand of selected) {
      rows.set(cand.normalizedUrl, await this.upsertSource(cand, { questions: [...cand.questionIds], queries: [...cand.queries] }));
    }
    const toFetch = [...rows.values()].filter((r) => !r.doc);
    this.stats.retrievedFromCache = rows.size - toFetch.length;
    await this.fetchInto(toFetch);
    await this.openAccessFallback(rows);

    // Order: strongest type hint first, so the canonical copy of a duplicate is the better source.
    const ok = [...rows.values()].filter((r) => r.doc).sort((a, b) => SOURCE_TIER[a.cand.hint] - SOURCE_TIER[b.cand.hint] || b.cand.score - a.cand.score);
    const retrieved: Retrieved[] = ok.map((r, i) => ({
      sourceId: r.sourceId,
      key: `S${i + 1}`,
      url: r.cand.url,
      domain: r.cand.domain,
      title: r.cand.title,
      hint: r.cand.hint,
      documentId: r.doc!.id,
      text: r.doc!.text,
      normalized: normalizeForMatch(r.doc!.text),
      sha: r.doc!.sha256,
      duplicateOfId: null,
      sourceType: r.cand.hint,
      note: r.note,
    }));

    // Duplicates: identical content, or near-identical text (mirrors, syndicated copies).
    for (let i = 0; i < retrieved.length; i++) {
      const a = retrieved[i]!;
      for (let j = 0; j < i; j++) {
        const b = retrieved[j]!;
        if (b.duplicateOfId) continue;
        if (a.sha === b.sha || textSimilarity(a.normalized, b.normalized) >= 0.85) {
          a.duplicateOfId = b.sourceId;
          this.stats.duplicates++;
          await db.source.update({ where: { id: a.sourceId }, data: { duplicateOfId: b.sourceId } });
          break;
        }
      }
    }

    const unique = retrieved.filter((r) => !r.duplicateOfId).length;
    await this.ctx.progress(
      `Retrieval: ${unique} unique documents (${this.stats.retrievedNew} fetched, ${this.stats.retrievedFromCache} cached, ${this.stats.retrievalFailed} failed, ${this.stats.duplicates} duplicates; ` +
        `open-access copies found for ${this.stats.openAccessRecovered} of ${this.stats.openAccessLookups} unretrievable scholarly works)`,
    );
    if (unique < 5) throw new NonRetryableError(`Only ${unique} source documents could be retrieved; not enough to research from`);
    return retrieved;
  }

  /** Create or refresh the project's source row for a candidate; an already retrieved document is reused. */
  private async upsertSource(cand: Candidate, discovery: Record<string, unknown>): Promise<Row> {
    const { db, project } = this.ctx;
    const existing = await db.source.findUnique({
      where: { projectId_normalizedUrl: { projectId: project.id, normalizedUrl: cand.normalizedUrl } },
      include: { document: { select: { id: true, text: true, sha256: true } } },
    });
    const discovered = [
      ...(Array.isArray(existing?.discoveredBy) ? (existing.discoveredBy as unknown[]) : []),
      { jobId: this.ctx.job.id, ...discovery },
    ] as Prisma.InputJsonValue;
    const data = { searchSnippet: cand.snippet.slice(0, 2_000), searchScore: cand.score, discoveredBy: discovered };
    const source = existing
      ? await db.source.update({ where: { id: existing.id }, data })
      : await db.source.create({
          data: {
            projectId: project.id,
            url: cand.url,
            normalizedUrl: cand.normalizedUrl,
            domain: cand.domain,
            title: cand.title,
            sourceType: cand.hint,
            publishedDate: cand.publishedDate,
            citation: `${cand.title}. ${cand.url}`,
            ...data,
          },
        });
    return { sourceId: source.id, cand, doc: existing?.document ?? null, error: null, note: null };
  }

  /** Retrieve full text for rows without a document, in provider-sized batches. */
  private async fetchInto(toFetch: Row[]) {
    const { db } = this.ctx;
    const { research } = this.ctx.providers;
    for (let i = 0; i < toFetch.length; i += research.maxBatchSize) {
      this.ctx.signal.throwIfAborted();
      const batch = toFetch.slice(i, i + research.maxBatchSize);
      let res;
      try {
        res = await this.ctx.callProvider('research', 'fetchDocuments', () => research.fetchDocuments(batch.map((b) => b.cand.url), { depth: 'advanced' }), {
          request: { urls: batch.map((b) => b.cand.url) },
          summarize: (r) => ({ documents: r.documents.length, failed: r.failed }),
        });
      } catch (err) {
        if (err instanceof ProviderError && err.retryable) throw err;
        for (const b of batch) await this.markFailed(b, errorMessage(err));
        continue;
      }
      const byUrl = new Map(batch.map((b) => [b.cand.url, b]));
      for (const d of res.documents) {
        const b = byUrl.get(d.url);
        if (!b) continue;
        if (d.text.trim().length < this.cfg.minDocumentChars) {
          await this.markFailed(b, `retrieved only ${d.text.trim().length} characters (paywall, stub or blocked page)`);
          continue;
        }
        const doc = await db.sourceDocument.create({
          data: { sourceId: b.sourceId, provider: research.info.name, contentFormat: d.contentType, text: d.text, chars: d.text.length, sha256: sha256(d.text) },
        });
        await db.source.update({ where: { id: b.sourceId }, data: { retrievalStatus: 'RETRIEVED', retrievalError: null, accessedAt: new Date() } });
        b.doc = { id: doc.id, text: doc.text, sha256: doc.sha256 };
        this.stats.retrievedNew++;
      }
      for (const f of res.failed) {
        const b = byUrl.get(f.url);
        if (b && !b.doc) await this.markFailed(b, f.error);
      }
    }
  }

  /**
   * Scholarly publisher pages (JSTOR, journal sites) usually refuse automated
   * retrieval, which would leave the dossier leaning on popular retellings.
   * For each high-tier work that failed, search once for an open-access copy
   * (author manuscript, working paper, university repository) and accept the
   * first copy that is retrievable and whose title matches (open-access.ts).
   * The copy is a source in its own right: the reader is told what it stands
   * in for, and the original keeps its FAILED status with a pointer to it.
   */
  private async openAccessFallback(rows: Map<string, Row>) {
    const { db, project } = this.ctx;
    const { research } = this.ctx.providers;

    // One lookup per work: the same article is often selected under two URLs.
    const byWork = new Map<string, { lookup: OpenAccessLookup; originals: Row[] }>();
    for (const r of rows.values()) {
      if (r.doc || SOURCE_TIER[r.cand.hint] !== 1) continue;
      const lookup = openAccessLookup(r.cand.title);
      if (!lookup) continue;
      const key = titleTokens(lookup.main).join(' ');
      const work = byWork.get(key);
      if (work) work.originals.push(r);
      else byWork.set(key, { lookup, originals: [r] });
    }
    const works = [...byWork.values()].slice(0, this.cfg.maxOpenAccessLookups);
    if (works.length === 0) return;

    const searches = await mapLimit(
      works,
      this.cfg.searchConcurrency,
      (w) =>
        this.ctx.callProvider(
          'research',
          'search',
          () => research.search({ query: w.lookup.query, maxResults: 5, depth: 'basic', excludeDomains: [...new Set([...EXCLUDED_DOMAINS, ...w.originals.map((o) => o.cand.domain)])] }),
          { request: { query: w.lookup.query, openAccessFor: w.originals.map((o) => o.cand.url) }, summarize: (x) => ({ results: x.results.length }) },
        ),
      this.ctx.signal,
    );

    // Up to three title-matching copies per work, best match first.
    const options = works.map((w, i) => {
      const res = searches[i]!;
      this.stats.searches++;
      this.stats.openAccessLookups++;
      if (!res.ok) {
        if (res.error instanceof ProviderError && res.error.retryable) throw res.error;
        this.stats.searchFailures++;
        this.ctx.logger.warn({ query: w.lookup.query, err: errorMessage(res.error) }, 'open-access lookup failed');
        return [];
      }
      const originalDomains = new Set(w.originals.map((o) => o.cand.domain));
      return res.value.results
        .map((hit) => ({ hit, normalizedUrl: normalizeUrl(hit.url), domain: domainOf(hit.url), match: sameWorkScore(w.lookup, hit.title, hit.snippet) }))
        .filter((x): x is typeof x & { normalizedUrl: string; domain: string } =>
          Boolean(x.normalizedUrl && x.domain && !isExcludedDomain(x.domain) && !originalDomains.has(x.domain) && !rows.has(x.normalizedUrl) && x.match >= SAME_WORK_THRESHOLD),
        )
        .sort((a, b) => b.match - a.match || (b.hit.score ?? 0) - (a.hit.score ?? 0))
        .slice(0, 3);
    });

    // Copies retrieved in an earlier run are reused; otherwise every option is fetched and the best retrievable one wins.
    const known = await db.source.findMany({
      where: { projectId: project.id, normalizedUrl: { in: options.flat().map((o) => o.normalizedUrl) }, document: { isNot: null } },
      select: { normalizedUrl: true },
    });
    const knownUrls = new Set(known.map((k) => k.normalizedUrl));
    const toFetch = [...new Set(options.filter((opts) => !opts.some((o) => knownUrls.has(o.normalizedUrl))).flat().map((o) => o.hit.url))];
    const fetched = new Map<string, { contentType: string; text: string }>();
    for (let i = 0; i < toFetch.length; i += research.maxBatchSize) {
      this.ctx.signal.throwIfAborted();
      const urls = toFetch.slice(i, i + research.maxBatchSize);
      try {
        const res = await this.ctx.callProvider('research', 'fetchDocuments', () => research.fetchDocuments(urls, { depth: 'advanced' }), {
          request: { urls, purpose: 'open-access copies' },
          summarize: (r) => ({ documents: r.documents.length, failed: r.failed }),
        });
        for (const d of res.documents) if (d.text.trim().length >= this.cfg.minDocumentChars) fetched.set(d.url, d);
      } catch (err) {
        if (err instanceof ProviderError && err.retryable) throw err;
        this.ctx.logger.warn({ urls, err: errorMessage(err) }, 'retrieving open-access copies failed');
      }
    }

    for (const [i, w] of works.entries()) {
      const pick = options[i]!.find((o) => !rows.has(o.normalizedUrl) && (knownUrls.has(o.normalizedUrl) || fetched.has(o.hit.url)));
      if (!pick) continue;
      const first = w.originals[0]!;
      const cand: Candidate = {
        id: `${first.cand.id}-OA`,
        url: pick.hit.url,
        normalizedUrl: pick.normalizedUrl,
        domain: pick.domain,
        title: pick.hit.title,
        snippet: pick.hit.snippet,
        score: pick.hit.score ?? 0,
        publishedDate: pick.hit.publishedDate ?? null,
        hint: sourceTypeHint(pick.domain), // the reader decides the real type after reading
        questionIds: new Set(w.originals.flatMap((o) => [...o.cand.questionIds])),
        queries: new Set([w.lookup.query]),
      };
      const copy = await this.upsertSource(cand, {
        openAccessFor: w.originals.map((o) => o.sourceId),
        sameWorkScore: pick.match,
        questions: [...cand.questionIds],
        queries: [w.lookup.query],
      });
      if (copy.doc) {
        this.stats.retrievedFromCache++;
      } else {
        const d = fetched.get(pick.hit.url)!;
        const doc = await db.sourceDocument.create({
          data: { sourceId: copy.sourceId, provider: research.info.name, contentFormat: d.contentType, text: d.text, chars: d.text.length, sha256: sha256(d.text) },
        });
        await db.source.update({ where: { id: copy.sourceId }, data: { retrievalStatus: 'RETRIEVED', retrievalError: null, accessedAt: new Date() } });
        copy.doc = { id: doc.id, text: doc.text, sha256: doc.sha256 };
        this.stats.retrievedNew++;
      }
      copy.note = `Found as an open-access copy of "${first.cand.title}" (${first.cand.url}), which could not be retrieved. Check that this document is that work; if it is not, say so in reliabilityNotes and judge it on its own merits.`;
      rows.set(cand.normalizedUrl, copy);
      this.stats.openAccessRecovered++;
      for (const o of w.originals) {
        await db.source.update({
          where: { id: o.sourceId },
          data: { retrievalError: `${o.error ?? 'not retrieved'} — open-access copy retrieved instead: ${pick.hit.url}`.slice(0, 1_000) },
        });
      }
    }
  }

  private async markFailed(row: Row, error: string) {
    this.stats.retrievalFailed++;
    row.error = error;
    await this.ctx.db.source.update({ where: { id: row.sourceId }, data: { retrievalStatus: 'FAILED', retrievalError: error.slice(0, 1_000) } });
  }

  // ── 5. Read ────────────────────────────────────────────────────────────────
  private async read(retrieved: Retrieved[]): Promise<Map<string, EvidenceRecord>> {
    const { db } = this.ctx;
    const cacheKey = `${PROMPT_VERSION}:${sha256(`${this.ctx.project.topic}\n${this.focusAreas.map((f) => f.text).join('\n')}`).slice(0, 16)}`;
    const system = readSystemPrompt(this.ctx.project.topic, this.focusAreas);
    const evidence = new Map<string, EvidenceRecord>();
    const toRead = retrieved.filter((r) => !r.duplicateOfId);

    const results = await mapLimit(
      toRead,
      this.cfg.readConcurrency,
      async (r) => {
        const cached = await db.sourceDocument.findUnique({ where: { id: r.documentId }, select: { analysis: true, analysisVersion: true } });
        let output: ReadOutput;
        if (cached?.analysisVersion === cacheKey && cached.analysis) {
          output = ReadOutput.parse((cached.analysis as { output: unknown }).output);
          this.stats.readFromCache++;
        } else {
          const excerpt = relevantExcerpt(r.text, this.keywords, this.cfg.maxDocumentChars);
          const truncated = excerpt.truncated;
          if (truncated) this.stats.truncatedDocuments++;
          const res = await this.ctx.callProvider(
            'ai',
            'generateObject',
            () =>
              this.ctx.providers.ai.generateObject({
                task: 'research.read',
                schema: ReadOutput,
                schemaName: 'SourceEvidence',
                system,
                cacheSystemPrompt: true,
                messages: [{ role: 'user', content: readUserPrompt({ key: r.key, url: r.url, title: r.title, domain: r.domain, hint: r.hint, note: r.note, text: excerpt.text, truncated }) }],
                effort: this.cfg.effort.read,
                maxTokens: 24_000,
                signal: this.ctx.signal,
              }),
            { request: { task: 'research.read', source: r.url, documentChars: r.text.length, sentChars: excerpt.text.length, truncated }, summarize: (x) => ({ evidence: x.object.evidence.length, relevance: x.object.assessment.relevance }) },
          );
          this.noteModel(res.meta.model);
          output = res.object;
        }

        const checked = output.evidence.map((e) => ({ ...e, check: verifyQuote(r.normalized, e.quote) }));
        await db.sourceDocument.update({
          where: { id: r.documentId },
          data: {
            analysis: { output, quoteChecks: checked.map((c) => c.check) } as unknown as Prisma.InputJsonValue,
            analysisVersion: cacheKey,
            analyzedAt: new Date(),
          },
        });
        const a = output.assessment;
        r.sourceType = a.sourceType;
        await db.source.update({
          where: { id: r.sourceId },
          data: {
            title: a.title || r.title,
            author: a.author,
            publisher: a.publisher,
            publishedDate: a.publishedDate,
            sourceType: a.sourceType,
            reliability: a.reliability,
            reliabilityNotes: a.reliabilityNotes,
            notes: `${a.summary}${a.repeatsPopularMyths ? ' [Repeats popular myths uncritically.]' : ''}`,
            citation: formatCitation(a, r.url),
          },
        });
        return { r, relevance: a.relevance, checked };
      },
      this.ctx.signal,
    );

    let failures = 0;
    for (const [i, res] of results.entries()) {
      if (!res.ok) {
        failures++;
        this.stats.readFailed++;
        this.ctx.logger.warn({ source: toRead[i]!.url, err: errorMessage(res.error) }, 'reading source failed');
        continue;
      }
      this.stats.read++;
      if (res.value.relevance === 'NONE') continue;
      res.value.checked.forEach((e, n) => {
        if (!e.check.verified) {
          this.stats.evidenceRejected++;
          return;
        }
        this.stats.evidenceVerified++;
        const id = `${res.value.r.key}.E${n + 1}`;
        evidence.set(id, {
          id,
          sourceId: res.value.r.sourceId,
          focusAreas: e.focusAreas,
          statement: e.statement,
          quote: e.quote.trim(),
          locator: e.locator,
          kind: e.kind,
          attribution: e.attribution,
          verified: true,
        });
      });
    }
    if (failures > toRead.length / 2) {
      // Mostly transient (rate limits, overload) in practice; completed reads are cached, so a retry resumes cheaply.
      const first = results.find((x) => !x.ok) as { ok: false; error: unknown };
      throw first.error instanceof ProviderError && !first.error.retryable
        ? new NonRetryableError(`Reading failed for ${failures}/${toRead.length} sources: ${errorMessage(first.error)}`)
        : new Error(`Reading failed for ${failures}/${toRead.length} sources: ${errorMessage(first.error)}`);
    }
    await this.ctx.progress(
      `Reading: ${this.stats.read} sources read (${this.stats.readFromCache} from cache, ${this.stats.readFailed} failed); ${this.stats.evidenceVerified} evidence items verified verbatim, ${this.stats.evidenceRejected} rejected (quote not found in text)`,
    );
    if (evidence.size === 0) throw new NonRetryableError('No verifiable evidence was extracted from the retrieved sources');
    return evidence;
  }

  // ── 6. Synthesise ──────────────────────────────────────────────────────────
  private async synthesize(plan: PlanQuestion[], retrieved: Retrieved[], evidence: Map<string, EvidenceRecord>): Promise<SynthesisOutput> {
    const bySource = new Map(retrieved.map((r) => [r.sourceId, r]));
    const usedSources = retrieved.filter((r) => [...evidence.values()].some((e) => e.sourceId === r.sourceId));
    const sourceMeta = await this.ctx.db.source.findMany({ where: { id: { in: usedSources.map((r) => r.sourceId) } } });
    const metaById = new Map(sourceMeta.map((s) => [s.id, s]));
    const sourcesTable = usedSources
      .map((r) => {
        const s = metaById.get(r.sourceId)!;
        return `${r.key} | ${s.sourceType} | ${s.reliability ?? '?'} | ${[s.author, s.publisher].filter(Boolean).join(' / ') || '—'} | ${s.publishedDate ?? '—'} | ${s.title} | ${s.domain}`;
      })
      .join('\n');

    const areaOf = (e: EvidenceRecord) => this.focusAreas.find((f) => e.focusAreas.includes(f.id))?.id ?? 'other';
    const groups = new Map<string, EvidenceRecord[]>();
    for (const e of evidence.values()) groups.set(areaOf(e), [...(groups.get(areaOf(e)) ?? []), e]);
    const evidenceText = [...this.focusAreas.map((f) => f.id), 'other']
      .filter((id) => groups.has(id))
      .map((id) => {
        const title = this.focusAreas.find((f) => f.id === id)?.text ?? 'Other';
        const lines = groups.get(id)!.map((e) => {
          const src = bySource.get(e.sourceId)!;
          const also = e.focusAreas.filter((f) => f !== id);
          return `[${e.id}] ${src.key} | ${e.kind} | ${e.attribution} | ${e.statement}${also.length ? ` (also ${also.join(',')})` : ''} | "${e.quote}"`;
        });
        return `## ${id}: ${title}\n${lines.join('\n')}`;
      })
      .join('\n\n');

    const r = await this.ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        this.ctx.providers.ai.generateObject({
          task: 'research.synthesize',
          schema: SynthesisOutput,
          schemaName: 'ResearchDossier',
          system: synthesisSystemPrompt(),
          messages: [
            {
              role: 'user',
              content: synthesisUserPrompt({
                title: this.ctx.project.title,
                topic: this.ctx.project.topic,
                questions: plan.map((q) => `${q.id} [${q.category}]: ${q.question}`).join('\n'),
                sources: sourcesTable,
                evidence: evidenceText,
              }),
            },
          ],
          effort: this.cfg.effort.synthesize,
          maxTokens: 120_000,
          signal: this.ctx.signal,
        }),
      { request: { task: 'research.synthesize', sources: usedSources.length, evidence: evidence.size }, summarize: (x) => ({ claims: x.object.claims.length }) },
    );
    this.noteModel(r.meta.model);
    await this.ctx.progress(`Synthesis: ${r.object.claims.length} claims drafted from ${evidence.size} evidence items`);
    return r.object;
  }

  // ── 7. Coherence review (automatic fixes are re-checked by the rules) ─────
  private async review(draft: DossierDraft, sources: ReadonlyMap<string, DraftSource>, evidence: Map<string, EvidenceRecord>): Promise<CoherenceIssue[]> {
    const typeOf = (id: string) => sources.get(id)?.sourceType ?? '?';
    const claimsText = draft.claims
      .map((c) => {
        const cites = c.citations
          .map((x) => `${x.stance.toLowerCase()} ${x.evidenceId} (${typeOf(x.sourceId)}): "${(evidence.get(x.evidenceId)?.quote ?? x.quote).slice(0, 200)}"`)
          .join('; ');
        return `${c.key} [${c.importance}|${c.verdict}|${c.confidence}] ${c.statement}${c.popularVersion ? ` | popular: ${c.popularVersion}` : ''}${c.notes ? ` | notes: ${c.notes}` : ''}${cites ? ` | ${cites}` : ''}`;
      })
      .join('\n');
    const sections = JSON.stringify({ timeline: draft.content.timeline, myths: draft.content.myths, priceEvidence: draft.content.priceEvidence }, null, 0);

    let output: ReviewOutput;
    try {
      const r = await this.ctx.callProvider(
        'ai',
        'generateObject',
        () =>
          this.ctx.providers.ai.generateObject({
            task: 'research.review',
            schema: ReviewOutput,
            schemaName: 'CoherenceReview',
            system: reviewSystemPrompt(),
            messages: [{ role: 'user', content: `Claims:\n${claimsText}\n\nSections:\n${sections}\n\nSummary:\n${draft.summary}` }],
            effort: this.cfg.effort.review,
            maxTokens: 32_000,
            signal: this.ctx.signal,
          }),
        { request: { task: 'research.review', claims: draft.claims.length }, summarize: (x) => ({ issues: x.object.issues.length }) },
      );
      this.noteModel(r.meta.model);
      output = r.object;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      return [{ severity: 'MAJOR', description: `Automated coherence review unavailable: ${errorMessage(err)}`, claimKeys: [], resolution: 'Left for human review' }];
    }

    return output.issues.map((issue) => {
      const targets = draft.claims.filter((c) => issue.claimKeys.includes(c.key));
      const f = issue.fix;
      let resolution = 'Left for human review';
      if (targets.length > 0) {
        if (f.action === 'SET_VERDICT' && f.verdict) {
          for (const t of targets) t.verdict = f.verdict;
          resolution = `Applied: verdict → ${f.verdict} (${f.rationale})`;
        } else if (f.action === 'SET_CONFIDENCE' && f.confidence) {
          for (const t of targets) t.confidence = f.confidence;
          resolution = `Applied: confidence → ${f.confidence} (${f.rationale})`;
        } else if (f.action === 'SET_NEEDS_VERIFICATION') {
          for (const t of targets) t.needsVerification = true;
          resolution = `Applied: flagged for verification (${f.rationale})`;
        } else if (f.action === 'REMOVE_CLAIM') {
          draft.claims = draft.claims.filter((c) => !targets.includes(c));
          resolution = `Applied: removed ${targets.map((t) => t.key).join(', ')} (${f.rationale})`;
        }
      }
      return { severity: issue.severity, description: issue.description, claimKeys: issue.claimKeys, resolution };
    });
  }

  // ── 8. Persist ─────────────────────────────────────────────────────────────
  private async persist(draft: DossierDraft, report: QualityReport) {
    const { db, project, job } = this.ctx;
    const content = ResearchDossierContent.parse(draft.content);
    const qualityReport = QualityReport.parse(report);
    return db.$transaction(
      async (tx) => {
        const last = await tx.researchDossier.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, select: { version: true } });
        await tx.researchDossier.updateMany({ where: { projectId: project.id, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
        const dossier = await tx.researchDossier.create({
          data: {
            projectId: project.id,
            version: (last?.version ?? 0) + 1,
            status: report.passed ? 'IN_REVIEW' : 'DRAFT',
            summary: draft.summary,
            content: content as unknown as Prisma.InputJsonValue,
            qualityReport: qualityReport as unknown as Prisma.InputJsonValue,
            qualityPassed: report.passed,
            stats: this.stats as unknown as Prisma.InputJsonValue,
            jobId: job.id,
          },
        });
        const claims = await tx.researchClaim.createManyAndReturn({
          data: draft.claims.map((c, i) => ({
            dossierId: dossier.id,
            claimKey: c.key,
            category: c.category,
            importance: c.importance,
            statement: c.statement,
            claimType: c.claimType,
            verdict: c.verdict,
            confidence: c.confidence,
            needsVerification: c.needsVerification,
            popularVersion: c.popularVersion,
            notes: c.notes || null,
            sortOrder: i,
          })),
          select: { id: true, claimKey: true },
        });
        const idByKey = new Map(claims.map((c) => [c.claimKey, c.id]));
        await tx.claimCitation.createMany({
          data: draft.claims.flatMap((c) =>
            c.citations.map((x) => ({
              claimId: idByKey.get(c.key)!,
              sourceId: x.sourceId,
              stance: x.stance,
              basis: x.basis,
              quote: x.quote,
              locator: x.locator,
              quoteVerified: x.quoteVerified,
              evidenceKey: x.evidenceId,
            })),
          ),
        });
        return dossier;
      },
      { timeout: 60_000 },
    );
  }

  /** Cancellation and the per-run cost ceiling are checked between phases. */
  private async checkpoint() {
    this.ctx.signal.throwIfAborted();
    const [row] = await this.ctx.db.$queryRaw<{ spent: string | null }[]>`
      SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd))::text AS spent FROM provider_calls WHERE job_id = ${this.ctx.job.id}::uuid`;
    const spent = Number(row?.spent ?? 0);
    if (spent > this.cfg.maxCostUsd) {
      throw new NonRetryableError(`Research stopped: estimated spend $${spent.toFixed(2)} exceeds the per-run ceiling of $${this.cfg.maxCostUsd}`);
    }
  }

  private noteModel(model: string | undefined) {
    if (model && !this.stats.models.includes(model)) this.stats.models.push(model);
  }
}

function formatCitation(a: ReadOutput['assessment'], url: string): string {
  const who = a.author ?? a.publisher ?? '';
  const when = a.publishedDate ? ` (${a.publishedDate})` : '';
  const pub = a.publisher && a.publisher !== who ? ` ${a.publisher}.` : '';
  return `${who ? `${who}${when}. ` : ''}${a.title}.${pub} ${url}`.replace(/\s+/g, ' ').trim();
}
