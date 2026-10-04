import {
  ResearchDossierContent,
  type CitationStance,
  type ClaimImportance,
  type ClaimType,
  type ClaimVerdict,
  type ConfidenceLevel,
  type SourceType,
  type StoryEvidenceClaim,
} from '@docengine/core';
import type { Database } from '@docengine/database';
import { extractFigures, normalize } from './text.ts';

export interface EvidenceCitation {
  sourceId: string;
  stance: CitationStance;
  quote: string | null;
  quoteVerified: boolean;
}

export interface EvidenceClaim {
  id: string;
  key: string;
  statement: string;
  claimType: ClaimType;
  importance: ClaimImportance;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  popularVersion: string | null;
  notes: string | null;
  citations: EvidenceCitation[];
}

export interface EvidenceSource {
  id: string;
  title: string;
  sourceType: SourceType;
  author: string | null;
  publishedDate: string | null;
  domain: string | null;
  retrieved: boolean;
  duplicateOfId: string | null;
}

export interface EvidenceInput {
  dossierId: string;
  dossierVersion: number;
  summary: string | null;
  content: ResearchDossierContent;
  claims: EvidenceClaim[];
  sources: EvidenceSource[];
}

/**
 * An approved research dossier as the story stage uses it: the only material
 * stories may be built from. Answers "what does the evidence behind these
 * claims say?" for the grounding rules, and renders the dossier for prompts.
 */
export class EvidenceBase {
  readonly dossierId: string;
  readonly dossierVersion: number;
  readonly summary: string | null;
  readonly content: ResearchDossierContent;
  /** By claim key, in dossier order. */
  readonly claims: ReadonlyMap<string, EvidenceClaim>;
  readonly sources: ReadonlyMap<string, EvidenceSource>;
  /** Short source keys for prompts (S1, S2, …), by source id. */
  readonly sourceKeys: ReadonlyMap<string, string>;
  /** Everything the dossier says about each claim (statement, verified quotes, sections citing it). */
  private readonly texts = new Map<string, string>();
  private readonly figures = new Map<string, Set<string>>();
  private readonly allFigures = new Set<string>();

  constructor(input: EvidenceInput) {
    this.dossierId = input.dossierId;
    this.dossierVersion = input.dossierVersion;
    this.summary = input.summary;
    this.content = input.content;
    this.claims = new Map(input.claims.map((c) => [c.key, c]));
    this.sources = new Map(input.sources.map((s) => [s.id, s]));
    const cited = new Set(input.claims.flatMap((c) => c.citations.map((x) => x.sourceId)));
    this.sourceKeys = new Map(input.sources.filter((s) => cited.has(s.id)).map((s, i) => [s.id, `S${i + 1}`]));

    const sectionText = new Map<string, string[]>();
    const add = (keys: readonly string[], ...parts: (string | null | undefined)[]) => {
      for (const k of keys) sectionText.set(k, [...(sectionText.get(k) ?? []), ...parts.filter((p): p is string => !!p)]);
    };
    const c = input.content;
    for (const t of c.timeline) add(t.claimKeys, t.date, t.event);
    for (const f of c.keyFigures) add(f.claimKeys, f.name, f.role, f.description);
    for (const p of c.priceEvidence) add(p.claimKeys, p.item, p.price, p.currency, p.date, p.context);
    for (const m of c.myths) add(m.claimKeys, m.popularVersion, m.whatTheEvidenceShows, m.origin);
    for (const i of c.interpretations) add(i.claimKeys, i.position, i.proponents.join(', '), i.summary);
    add(c.narrativeHistory.claimKeys, c.narrativeHistory.summary, ...c.narrativeHistory.milestones.map((m) => `${m.date} ${m.work}: ${m.contribution}`));
    for (const q of c.openQuestions) add(q.claimKeys, q.question, q.whyUnresolved);

    for (const claim of input.claims) {
      const quotes = claim.citations.filter((x) => x.quoteVerified && x.quote).map((x) => x.quote!);
      const text = [claim.statement, claim.popularVersion, claim.notes, ...quotes, ...(sectionText.get(claim.key) ?? [])].filter(Boolean).join('\n');
      this.texts.set(claim.key, text);
      const figs = new Set(extractFigures(text));
      this.figures.set(claim.key, figs);
      for (const f of figs) this.allFigures.add(f);
    }
    const unlinked = [input.summary ?? '', JSON.stringify(input.content)].join('\n');
    for (const f of extractFigures(unlinked)) this.allFigures.add(f);
  }

  static async load(db: Database, dossierId: string): Promise<EvidenceBase> {
    const dossier = await db.researchDossier.findUniqueOrThrow({
      where: { id: dossierId },
      include: { claims: { orderBy: { sortOrder: 'asc' }, include: { citations: true } } },
    });
    const sources = await db.source.findMany({ where: { projectId: dossier.projectId }, orderBy: { createdAt: 'asc' } });
    return new EvidenceBase({
      dossierId: dossier.id,
      dossierVersion: dossier.version,
      summary: dossier.summary,
      content: ResearchDossierContent.parse(dossier.content),
      claims: dossier.claims.map((c) => ({
        id: c.id,
        key: c.claimKey,
        statement: c.statement,
        claimType: c.claimType,
        importance: c.importance,
        verdict: c.verdict,
        confidence: c.confidence,
        popularVersion: c.popularVersion,
        notes: c.notes,
        citations: c.citations.map((x) => ({ sourceId: x.sourceId, stance: x.stance, quote: x.quote, quoteVerified: x.quoteVerified })),
      })),
      sources: sources.map((s) => ({
        id: s.id,
        title: s.title,
        sourceType: s.sourceType,
        author: s.author,
        publishedDate: s.publishedDate,
        domain: s.domain,
        retrieved: s.retrievalStatus === 'RETRIEVED',
        duplicateOfId: s.duplicateOfId,
      })),
    });
  }

  has(key: string): boolean {
    return this.claims.has(key);
  }

  claim(key: string): EvidenceClaim | undefined {
    return this.claims.get(key);
  }

  /** Retrieved sources citing the claim with a verified quote (a mirror counts as its original). */
  traceableSources(key: string): string[] {
    const claim = this.claims.get(key);
    if (!claim) return [];
    const ids = new Set<string>();
    for (const x of claim.citations) {
      const s = this.sources.get(x.sourceId);
      if (!x.quoteVerified || !s?.retrieved) continue;
      ids.add(s.duplicateOfId ?? s.id);
    }
    return [...ids];
  }

  /** Distinct traceable sources behind a set of claims. */
  sourcesFor(keys: readonly string[]): string[] {
    return [...new Set(keys.flatMap((k) => this.traceableSources(k)))];
  }

  storyClaims(keys: readonly string[]): StoryEvidenceClaim[] {
    return keys.flatMap((k) => {
      const c = this.claims.get(k);
      return c ? [{ key: k, verdict: c.verdict, confidence: c.confidence, sourceIds: this.traceableSources(k) }] : [];
    });
  }

  /** What the evidence behind these claims says, as one text. */
  textFor(keys: readonly string[]): string {
    return keys.map((k) => this.texts.get(k) ?? '').join('\n');
  }

  figuresFor(keys: readonly string[]): Set<string> {
    return new Set(keys.flatMap((k) => [...(this.figures.get(k) ?? [])]));
  }

  /** Does the figure appear anywhere in the dossier? */
  inDossier(figure: string): boolean {
    return this.allFigures.has(figure);
  }

  /** Claims whose evidence contains the figure. */
  claimsWithFigure(figure: string): string[] {
    return [...this.figures].filter(([, figs]) => figs.has(figure)).map(([k]) => k);
  }

  /** Claims whose evidence mentions every one of these (normalized) words. */
  claimsMentioning(words: readonly string[]): string[] {
    if (words.length === 0) return [];
    return [...this.texts]
      .filter(([, text]) => {
        const t = ` ${normalize(text).replace(/[^a-z0-9]+/g, ' ')} `;
        return words.every((w) => t.includes(` ${w} `));
      })
      .map(([k]) => k);
  }

  // ── Prompt rendering ──────────────────────────────────────────────────────

  sourceLabel(id: string): string {
    const s = this.sources.get(id);
    return `${this.sourceKeys.get(id) ?? '?'} (${s?.sourceType ?? '?'})`;
  }

  /** Claims with verdicts and a few verified quotes, one block per claim. */
  renderClaims(keys: readonly string[] = [...this.claims.keys()], opts: { quotes?: number; quoteChars?: number } = {}): string {
    const maxQuotes = opts.quotes ?? 2;
    const maxChars = opts.quoteChars ?? 280;
    return keys
      .flatMap((k) => {
        const c = this.claims.get(k);
        if (!c) return [];
        const lines = [`${c.key} [${c.importance} · ${c.verdict} · ${c.confidence} · ${c.claimType}] ${c.statement}`];
        if (c.popularVersion) lines.push(`   popular version: ${c.popularVersion}`);
        if (c.notes) lines.push(`   notes: ${c.notes}`);
        const quotes = c.citations
          .filter((x) => x.quoteVerified && x.quote)
          .slice(0, maxQuotes)
          .map((x) => `${this.sourceLabel(x.sourceId)}${x.stance === 'SUPPORTS' ? '' : `, ${x.stance.toLowerCase()}`}: "${clip(x.quote!, maxChars)}"`);
        if (quotes.length) lines.push(`   evidence: ${quotes.join(' | ')}`);
        return [lines.join('\n')];
      })
      .join('\n');
  }

  /** The dossier's narrative sections (timeline, people, prices, myths, interpretations, the later legend). */
  renderSections(): string {
    const c = this.content;
    const keys = (ks: readonly string[]) => (ks.length ? ` [${ks.join(', ')}]` : '');
    const parts: string[] = [];
    if (this.summary) parts.push(`## Summary\n${this.summary}`);
    if (c.timeline.length) parts.push(`## Timeline\n${c.timeline.map((t) => `- ${t.date}${t.approximate ? ' (approx.)' : ''}: ${t.event}${keys(t.claimKeys)}`).join('\n')}`);
    if (c.keyFigures.length) parts.push(`## Key figures\n${c.keyFigures.map((f) => `- ${f.name} — ${f.role}: ${f.description}${keys(f.claimKeys)}`).join('\n')}`);
    if (c.priceEvidence.length) {
      parts.push(`## Price evidence\n${c.priceEvidence.map((p) => `- ${p.item}: ${p.price} ${p.currency} (${p.date}) — ${p.context}; reliability: ${p.reliability}${keys(p.claimKeys)}`).join('\n')}`);
    }
    if (c.myths.length) parts.push(`## Myths\n${c.myths.map((m) => `- Popular: ${m.popularVersion} | Evidence: ${m.whatTheEvidenceShows} | Origin: ${m.origin}${keys(m.claimKeys)}`).join('\n')}`);
    if (c.interpretations.length) parts.push(`## Interpretations\n${c.interpretations.map((i) => `- ${i.position} (${i.proponents.join(', ')}): ${i.summary}${keys(i.claimKeys)}`).join('\n')}`);
    const nh = c.narrativeHistory;
    if (nh.summary || nh.milestones.length) {
      parts.push(`## How the story was told later${keys(nh.claimKeys)}\n${nh.summary}\n${nh.milestones.map((m) => `- ${m.date} ${m.work}: ${m.contribution}`).join('\n')}`);
    }
    if (c.openQuestions.length) parts.push(`## Open questions\n${c.openQuestions.map((q) => `- ${q.question} — ${q.whyUnresolved}${keys(q.claimKeys)}`).join('\n')}`);
    return parts.join('\n\n');
  }

  renderSources(): string {
    return [...this.sourceKeys]
      .map(([id, key]) => {
        const s = this.sources.get(id)!;
        return `${key} | ${s.sourceType} | ${s.author ?? '—'} | ${s.publishedDate ?? '—'} | ${s.title}${s.domain ? ` | ${s.domain}` : ''}`;
      })
      .join('\n');
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
