import {
  AnyStoryArchitectureContent,
  CANDIDATE_PRIORITIES,
  CURRENT_STORY_ENGINE,
  CandidateOverrides,
  HumanStakes,
  MythThread,
  PRESENTATION_FOR_VERDICT,
  PovChoice,
  QualityReport,
  StoryArchitectureContentV2,
  StoryCharacter,
  StoryDesign,
  StoryJobInput,
  isArchitectureV2,
  runtimeTarget,
  selectionProblem,
  type CoherenceIssue,
  type QualityCheck,
  type RuntimeTarget,
} from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError } from '@docengine/providers';
import { z } from 'zod';
import { blockingCount, buildArchitecture, coreClaimsOf, describeFinding, toArchitectOutput, totalDurationSec, type BuiltArchitecture, type SelectedUnit } from './architecture.ts';
import { StepCheckpoint } from './checkpoint.ts';
import { DEFAULT_STORY_CONFIG, type StoryConfig } from './config.ts';
import { EvidenceBase } from './evidence.ts';
import { buildOpportunities, type BuiltOpportunity, type RemovedOpportunity } from './opportunities.ts';
import { PROMPT_VERSION, architectSystemPrompt, opportunitiesSystemPrompt, reviewSystemPrompt, storyEditorSystemPrompt } from './prompts.ts';
import { computeArchitectureReport, fmtMinutes, type StoryEditorVerdict } from './quality.ts';
import { orderedKeys } from './rules.ts';
import { ArchitectOutput, ArchitectureReviewOutput, OpportunityOutput, StoryEditorOutput } from './schemas.ts';
import { CostCeiling } from './util.ts';

/**
 * STORY_ARCHITECTURE stage (Story Engine 2.0). Turns the editor's selection
 * into a cinematic documentary blueprint inside the evidence boundary:
 * logline, central question and human stakes, narrative mode, POV strategy,
 * cast (fictional devices declared), and sequences of labelled beats with
 * setting, visual thinking, continuity and presentation instructions. A
 * story editor makes it a better story; a fact checker has the last word on
 * the facts; the evidence rules run on every version. When the gate passes,
 * the content opportunities inside it (shorts, long-form threads) are
 * identified for a future content package.
 *
 *   architect → rules → story editor (+ revision) → rules → fact checker
 *     (+ revision) → rules → gate → [content opportunities] → architecture vN
 *
 * It writes no script and approves nothing: a human approves or rejects the
 * architecture at the STORY gate, and each opportunity individually.
 */
export function createStoryArchitectureStage(overrides: Partial<StoryConfig> = {}): StageHandler {
  const cfg: StoryConfig = { ...DEFAULT_STORY_CONFIG, ...overrides };
  return { type: 'STORY_ARCHITECTURE', mock: false, run: (ctx) => new ArchitectureRun(ctx, cfg).run() };
}

const STEPS = ['architect', 'storyReview', 'factCheck', 'opportunities'] as const;
type Step = (typeof STEPS)[number];

const Unavailable = z.object({ unavailable: z.string() });
const StoryReviewStep = z.union([StoryEditorOutput, Unavailable]);
const FactCheckStep = z.union([ArchitectureReviewOutput, Unavailable]);
const OpportunitiesStep = z.union([OpportunityOutput, Unavailable]);
type StoryReviewStep = z.infer<typeof StoryReviewStep>;
type FactCheckStep = z.infer<typeof FactCheckStep>;

const PRIORITY_ORDER = Object.fromEntries(CANDIDATE_PRIORITIES.map((p, i) => [p, i])) as Record<(typeof CANDIDATE_PRIORITIES)[number], number>;

/** The previous architecture and what the editor said about it. */
interface Rework {
  version: number;
  status: string;
  decisions: string[];
  outline: string;
}

class ArchitectureRun {
  private readonly steps: StepCheckpoint<Step>;
  private readonly ceiling: CostCeiling;
  private readonly models: string[] = [];

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: StoryConfig,
  ) {
    this.steps = new StepCheckpoint(ctx, STEPS);
    this.ceiling = new CostCeiling(ctx, cfg.maxCostUsd.architecture, 'Story architecture');
  }

  async run(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { ctx } = this;
    const parsedInput = StoryJobInput.safeParse(ctx.job.input ?? {});
    if (!parsedInput.success) throw new NonRetryableError(`Invalid STORY_ARCHITECTURE input: ${parsedInput.error.message}`);
    const editorNotes = parsedInput.data.notes || null;
    const preferences = parsedInput.data.preferences ?? null;
    if (!(await this.steps.load())) ctx.logger.warn({ jobId: ctx.job.id }, 'saved story-architecture progress is from another version; starting over');

    const pack = await ctx.db.storyPack.findFirst({
      where: { projectId: ctx.project.id, status: 'IN_REVIEW' },
      orderBy: { version: 'desc' },
      include: {
        candidates: {
          where: { selected: true, status: { not: 'REJECTED' } },
          orderBy: { rank: 'asc' },
          include: { claims: { include: { claim: { select: { claimKey: true } } } } },
        },
      },
    });
    if (!pack) throw new NonRetryableError('No story pack is open for selection: run Story Mining first.');
    const problem = selectionProblem(pack.candidates.length);
    if (problem) throw new NonRetryableError(`Cannot build the architecture: ${problem}.`);

    const evidence = await EvidenceBase.load(ctx.db, pack.dossierId);
    // The editor's order when one is set; otherwise priority, then rank (the query's order).
    const units = pack.candidates
      .map((c) => toUnit(c, evidence))
      .sort((a, b) => (a.selectionOrder ?? Infinity) - (b.selectionOrder ?? Infinity) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    const target = runtimeTarget(ctx.project);
    const rework = await this.loadRework();
    await ctx.progress(
      `Story architecture from pack v${pack.version}: ${units.length} selected units (${units.filter((u) => u.priority === 'HIGH').length} high priority); target ${fmtMinutes(target.targetSec)}` +
        (rework ? `; reworking v${rework.version}` : ''),
      { packId: pack.id, units: units.map((u) => `${u.key} ${u.title} [${u.priority}${u.narrativeMode ? `, ${u.narrativeMode}` : ''}]`), editorNotes, preferences },
    );

    // 1. Architect.
    const draftRaw = await this.steps.step('architect', ArchitectOutput, () => this.architect(units, evidence, target, editorNotes, preferences, rework));
    const draft = buildArchitecture(draftRaw, evidence, units);
    await ctx.progress(`Architecture draft: ${draft.content.sequences.length} sequences, ~${fmtMinutes(totalDurationSec(draft.content))}; ${draft.findings.length} automated findings`, {
      findings: draft.findings.map(describeFinding),
      reconstruction: draft.content.reconstruction,
    });
    await this.ceiling.check();

    // 2. Story editor: is it a story? A revision is kept only if it has no more evidence problems.
    const notes = [...draft.notes];
    let current = draft;
    let revisedByStoryEditor = false;
    const storyReview = await this.steps.step('storyReview', StoryReviewStep, () => this.storyEditor(draft, units, evidence, target));
    let storyIssues: CoherenceIssue[] = [];
    let storyVerdict: StoryEditorVerdict | { unavailable: string };
    if ('unavailable' in storyReview) {
      storyVerdict = { unavailable: storyReview.unavailable };
    } else {
      storyVerdict = { scores: storyReview.scores, qualityBar: storyReview.qualityBar };
      const accepted = this.tryRevision(storyReview.revised, current, evidence, units, notes, 'story editor');
      if (accepted) {
        current = accepted;
        revisedByStoryEditor = true;
      }
      storyIssues = storyReview.issues.map((i) => toIssue(i, revisedByStoryEditor, 'Story'));
    }
    await ctx.progress(
      `Story editor: ${'unavailable' in storyReview ? 'unavailable' : `${storyReview.issues.length} issues; ${revisedByStoryEditor ? 'revision accepted' : 'no revision applied'}`}; ${current.findings.length} automated findings remain`,
      'unavailable' in storyReview ? {} : { scores: storyReview.scores, qualityBar: storyReview.qualityBar, issues: storyIssues.map((i) => `${i.severity}: ${i.description} — ${i.resolution}`) },
    );
    await this.ceiling.check();

    // 3. Fact checker: the evidence boundary has the last word.
    const beforeFactCheck = current;
    const factCheck = await this.steps.step('factCheck', FactCheckStep, () => this.factChecker(beforeFactCheck, units, evidence, target));
    let revisedByFactChecker = false;
    let factIssues: CoherenceIssue[];
    if ('unavailable' in factCheck) {
      factIssues = [{ severity: 'MAJOR', description: `Automated fact check unavailable: ${factCheck.unavailable}`, claimKeys: [], resolution: 'Left for human review' }];
    } else {
      const accepted = this.tryRevision(factCheck.revised, current, evidence, units, notes, 'fact checker');
      if (accepted) {
        current = accepted;
        revisedByFactChecker = true;
      }
      factIssues = factCheck.issues.map((i) => toIssue(i, revisedByFactChecker, 'Fact'));
    }
    const final = current;
    await ctx.progress(`Fact check: ${factIssues.length} issues; ${revisedByFactChecker ? 'revision accepted' : 'no revision applied'}; ${final.findings.length} automated findings remain`, {
      issues: factIssues.map((i) => `${i.severity}: ${i.description} — ${i.resolution}`),
      findings: final.findings.map(describeFinding),
    });

    // 4. Gate.
    const report = computeArchitectureReport({
      content: final.content,
      evidence,
      units,
      findings: final.findings,
      issues: [...factIssues, ...storyIssues.filter((i) => i.severity !== 'CRITICAL')],
      normalizations: notes,
      target,
      storyEditor: storyVerdict,
    });

    // 5. Content opportunities, only for an architecture that passed (a failed draft is not worth packaging).
    let opportunities: BuiltOpportunity[] = [];
    let removedOpportunities: RemovedOpportunity[] = [];
    let opportunitiesUnavailable: string | null = null;
    if (report.passed) {
      await this.ceiling.check();
      const out = await this.steps.step('opportunities', OpportunitiesStep, () => this.opportunities(final, units, evidence, target));
      if ('unavailable' in out) opportunitiesUnavailable = out.unavailable;
      else {
        const built = buildOpportunities(out, final.content, evidence, units);
        opportunities = built.opportunities;
        removedOpportunities = built.removed;
        report.normalizations.push(...built.notes, ...built.removed.map((r) => `Opportunity removed: "${r.title}" — ${r.reason}`));
      }
      report.checks.push(opportunityCheck(opportunities, removedOpportunities, opportunitiesUnavailable));
    } else {
      await this.steps.skip('opportunities');
    }

    const stats = {
      engineVersion: CURRENT_STORY_ENGINE,
      promptVersion: PROMPT_VERSION,
      packVersion: pack.version,
      dossierVersion: evidence.dossierVersion,
      units: units.length,
      models: this.models,
      sequences: final.content.sequences.length,
      beats: final.content.reconstruction.beats,
      reconstruction: final.content.reconstruction,
      draftFindings: draft.findings.length,
      finalFindings: final.findings.length,
      storyIssues: storyIssues.length,
      factIssues: factIssues.length,
      revisedByStoryEditor,
      revisedByFactChecker,
      storyEditor: storyVerdict,
      opportunities: { kept: opportunities.length, shorts: opportunities.filter((o) => o.format !== 'LONG_FORM').length, removed: removedOpportunities, unavailable: opportunitiesUnavailable },
      preferences,
      resumedSteps: [...this.steps.reused],
      durationMs: Date.now() - started,
    };
    const story = await this.persist(pack.id, pack.dossierId, final, report, target, stats, editorNotes, opportunities, evidence);
    if (report.passed) await this.steps.clear();

    const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label} (${c.detail})`);
    const total = totalDurationSec(final.content);
    await ctx.progress(`Story architecture v${story.version} saved: ${final.content.sequences.length} sequences, ~${fmtMinutes(total)} — quality gate ${report.passed ? 'PASSED' : 'FAILED'}`, {
      architectureId: story.id,
      logline: final.content.logline,
      centralQuestion: final.content.centralQuestion,
      narrativeMode: final.content.narrativeMode,
      pov: final.content.povStrategy,
      cast: final.content.cast.map((m) => `${m.name} (${m.kind})`),
      reconstruction: final.content.reconstruction,
      sequences: final.content.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ') || 'no unit'}; ${s.mode}; ${s.beats.length} beats; ${s.estimatedDurationSec}s; ${s.historicalStatus} ${s.historicalConfidence}/10)`),
      opportunities: opportunities.map((o) => `${o.key} ${o.format}${o.rank ? ` #${o.rank}` : ''} ${o.title}${o.shortScore !== null ? ` (${o.shortScore})` : ''}`),
      failedChecks: failed,
    });
    if (!report.passed) {
      throw new NonRetryableError(`Story architecture quality gate failed: ${failed.join('; ')}. Architecture v${story.version} saved as DRAFT for inspection.`);
    }
    return {
      architectureId: story.id,
      version: story.version,
      qualityPassed: true,
      sequences: final.content.sequences.length,
      estimatedDurationSec: total,
      opportunities: opportunities.length,
      stats,
    };
  }

  /** Keep a reviewer's revision only if the rules find no more blocking problems in it than in the version it revised. */
  private tryRevision(revised: ArchitectOutput | null, current: BuiltArchitecture, evidence: EvidenceBase, units: readonly SelectedUnit[], notes: string[], who: string): BuiltArchitecture | null {
    if (!revised) return null;
    const built = buildArchitecture(revised, evidence, units);
    if (blockingCount(built.findings) <= blockingCount(current.findings)) {
      notes.push(...built.notes.map((n) => `(${who} revision) ${n}`), `The ${who} revised the architecture; the evidence rules were re-applied to the revision.`);
      return built;
    }
    notes.push(`The ${who}'s revision was discarded: it had ${blockingCount(built.findings)} evidence problems against ${blockingCount(current.findings)}.`);
    return null;
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async architect(
    units: readonly SelectedUnit[],
    evidence: EvidenceBase,
    target: RuntimeTarget,
    editorNotes: string | null,
    preferences: StoryJobInput['preferences'] | null,
    rework: Rework | null,
  ): Promise<ArchitectOutput> {
    const { ctx, cfg } = this;
    const claimKeys = coreClaimsOf(units, evidence);
    const background = [...evidence.claims.keys()].filter((k) => !claimKeys.includes(k));
    const parts = [
      `Documentary: ${ctx.project.title} — ${ctx.project.topic}`,
      `Target runtime: about ${fmtMinutes(target.targetSec)} (acceptable ${fmtMinutes(target.minSec)}–${fmtMinutes(target.maxSec)})`,
    ];
    if (editorNotes) parts.push('', `The editor's instructions for this version (follow them):\n${editorNotes}`);
    if (preferences && (preferences.narrativeMode || preferences.povStrategy || preferences.centralQuestion)) {
      parts.push(
        '',
        "The editor's preferences for the documentary (follow them, or say why not in orderNote):",
        ...(preferences.narrativeMode ? [`- narrative mode: ${preferences.narrativeMode}`] : []),
        ...(preferences.povStrategy ? [`- POV strategy: ${preferences.povStrategy.type}${preferences.povStrategy.description ? ` — ${preferences.povStrategy.description}` : ''}`] : []),
        ...(preferences.centralQuestion ? [`- central question: ${preferences.centralQuestion}`] : []),
      );
    }
    if (rework) {
      parts.push('', `Previous architecture v${rework.version} (${rework.status}). The editor's decisions on it:\n${rework.decisions.map((d) => `- ${d}`).join('\n') || '- none recorded'}\nIts outline:\n${rework.outline}`);
    }
    const ordered = units.some((u) => u.selectionOrder !== null);
    parts.push('', `# Selected story units (${ordered ? "the editor's order" : 'priority, then rank'})`, units.map(renderUnit).join('\n\n'));
    parts.push(
      '',
      `# Story evidence: the selected units' claims (${claimKeys.length})`,
      'Only these claims may be story evidence: beats, cast, names, places, figures and dates. Verified quotations appear in quotation marks under each claim.',
      evidence.renderClaims(claimKeys, { quotes: 3, quoteChars: 360 }),
    );
    if (background.length) {
      parts.push(
        '',
        `# Other claims of the approved dossier: background only (${background.length})`,
        'Cite one only as a contextClaim with its purpose (and only in an ORIENTATION beat). Never use them for story beats, people, places, figures or dates.',
        evidence.renderClaimList(background),
      );
    }
    const needPresentation = [...evidence.claims.values()].filter((c) => c.verdict !== 'ESTABLISHED').map((c) => `${c.key} ${c.verdict} → ${PRESENTATION_FOR_VERDICT[c.verdict]}`);
    if (needPresentation.length) parts.push('', `Claims that need a presentation entry in every sequence that uses them: ${needPresentation.join('; ')}`);

    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task: 'story.architect',
          schema: ArchitectOutput,
          schemaName: 'StoryArchitecture',
          system: architectSystemPrompt(target),
          messages: [{ role: 'user', content: parts.join('\n') }],
          effort: cfg.effort.architect,
          maxTokens: cfg.maxTokens.architect,
          signal: ctx.signal,
        }),
      { request: { task: 'story.architect', units: units.length, claims: claimKeys.length, backgroundClaims: background.length }, summarize: (x) => ({ sequences: x.object.sequences.length }) },
    );
    this.noteModel(r.meta.model);
    return r.object;
  }

  /** What every reviewer sees: the architecture (with beat ids), the automated findings and the evidence. */
  private reviewContent(built: BuiltArchitecture, units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget): string {
    const c = built.content;
    const core = coreClaimsOf(units, evidence);
    const others = orderedKeys(
      c.sequences.flatMap((s) => [...s.claimKeys, ...s.contextClaims.map((x) => x.claimKey), ...s.beats.flatMap((b) => b.claimKeys)]),
      evidence,
    ).filter((k) => !core.includes(k));
    return [
      `Documentary: ${this.ctx.project.title} — ${this.ctx.project.topic}`,
      `Target runtime: ${fmtMinutes(target.minSec)}–${fmtMinutes(target.maxSec)}; current estimate ${fmtMinutes(totalDurationSec(c))}`,
      `Reconstruction: ${c.reconstruction.level} (${Math.round(c.reconstruction.shares.RECONSTRUCTION * 100)}% reconstruction, ${Math.round(c.reconstruction.shares.FICTION * 100)}% fiction of ${c.reconstruction.beats} beats)`,
      '',
      `Selected units: ${units.map((u) => `${u.key} [${u.priority}] ${u.title}`).join('; ')}`,
      `Story evidence allowed (the selected units' claims): ${core.join(', ')}`,
      '',
      `Automated findings (fix every one the evidence allows):\n${built.findings.map((f) => `- ${describeFinding(f)}`).join('\n') || '- none'}`,
      '',
      '# Architecture (beat ids are for reference; your revision follows the architecture schema, without ids)',
      JSON.stringify(toArchitectOutput(c), null, 1),
      '',
      "# Evidence: the selected units' claims",
      evidence.renderClaims(core, { quotes: 2, quoteChars: 320 }),
      ...(others.length ? ['', '# Other dossier claims the architecture uses (background only, never story evidence)', evidence.renderClaims(others, { quotes: 1, quoteChars: 240 })] : []),
    ].join('\n');
  }

  private async storyEditor(draft: BuiltArchitecture, units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget): Promise<StoryReviewStep> {
    const { ctx, cfg } = this;
    try {
      const r = await ctx.callProvider(
        'ai',
        'generateObject',
        () =>
          ctx.providers.ai.generateObject({
            task: 'story.storyEditor',
            schema: StoryEditorOutput,
            schemaName: 'StoryEditorReview',
            system: storyEditorSystemPrompt(target),
            messages: [{ role: 'user', content: this.reviewContent(draft, units, evidence, target) }],
            effort: cfg.effort.review,
            maxTokens: cfg.maxTokens.review,
            signal: ctx.signal,
          }),
        { request: { task: 'story.storyEditor', sequences: draft.content.sequences.length, findings: draft.findings.length }, summarize: (x) => ({ issues: x.object.issues.length, revised: x.object.revised !== null }) },
      );
      this.noteModel(r.meta.model);
      return r.object;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      return { unavailable: err instanceof Error ? err.message : String(err) };
    }
  }

  private async factChecker(current: BuiltArchitecture, units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget): Promise<FactCheckStep> {
    const { ctx, cfg } = this;
    try {
      const r = await ctx.callProvider(
        'ai',
        'generateObject',
        () =>
          ctx.providers.ai.generateObject({
            task: 'story.review',
            schema: ArchitectureReviewOutput,
            schemaName: 'ArchitectureReview',
            system: reviewSystemPrompt(target),
            messages: [{ role: 'user', content: this.reviewContent(current, units, evidence, target) }],
            effort: cfg.effort.review,
            maxTokens: cfg.maxTokens.review,
            signal: ctx.signal,
          }),
        { request: { task: 'story.review', sequences: current.content.sequences.length, findings: current.findings.length }, summarize: (x) => ({ issues: x.object.issues.length, revised: x.object.revised !== null }) },
      );
      this.noteModel(r.meta.model);
      return r.object;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      return { unavailable: err instanceof Error ? err.message : String(err) };
    }
  }

  private async opportunities(final: BuiltArchitecture, units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget): Promise<z.infer<typeof OpportunitiesStep>> {
    const { ctx, cfg } = this;
    const core = coreClaimsOf(units, evidence);
    const content = [
      `Documentary: ${ctx.project.title} — ${ctx.project.topic}`,
      '',
      '# The architecture (it passed its quality gate; beat ids are what beatIds refers to)',
      JSON.stringify(toArchitectOutput(final.content), null, 1),
      '',
      "# Evidence: the selected units' claims",
      evidence.renderClaims(core, { quotes: 2, quoteChars: 300 }),
    ].join('\n');
    try {
      const r = await ctx.callProvider(
        'ai',
        'generateObject',
        () =>
          ctx.providers.ai.generateObject({
            task: 'story.opportunities',
            schema: OpportunityOutput,
            schemaName: 'ContentOpportunities',
            system: opportunitiesSystemPrompt(target),
            messages: [{ role: 'user', content }],
            effort: cfg.effort.opportunities,
            maxTokens: cfg.maxTokens.opportunities,
            signal: ctx.signal,
          }),
        { request: { task: 'story.opportunities', sequences: final.content.sequences.length }, summarize: (x) => ({ opportunities: x.object.opportunities.length }) },
      );
      this.noteModel(r.meta.model);
      return r.object;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) throw err;
      return { unavailable: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── History ────────────────────────────────────────────────────────────────

  private async loadRework(): Promise<Rework | null> {
    const prev = await this.ctx.db.storyArchitecture.findFirst({
      where: { projectId: this.ctx.project.id },
      orderBy: { version: 'desc' },
      include: { approvals: { orderBy: { createdAt: 'asc' } } },
    });
    if (!prev) return null;
    const parsed = AnyStoryArchitectureContent.safeParse(prev.content);
    let outline = '(unreadable)';
    if (parsed.success) {
      const c = parsed.data;
      outline = isArchitectureV2(c)
        ? [`Logline: ${c.logline}`, `Central question: ${c.centralQuestion}`, `Mode: ${c.narrativeMode}; POV: ${c.povStrategy.type}`, ...c.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ')}; ${s.mode}): ${s.purpose}`)].join('\n')
        : [`Premise: ${c.premise}`, `Central question: ${c.centralQuestion}`, ...c.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ')}): ${s.purpose}`)].join('\n');
    }
    return {
      version: prev.version,
      status: prev.status,
      decisions: prev.approvals.map((a) => `${a.decision}${a.notes ? `: ${a.notes}` : ' (no notes)'}`),
      outline,
    };
  }

  // ── Persist ────────────────────────────────────────────────────────────────

  private async persist(
    packId: string,
    dossierId: string,
    built: BuiltArchitecture,
    report: QualityReport,
    target: RuntimeTarget,
    stats: Record<string, unknown>,
    editorNotes: string | null,
    opportunities: readonly BuiltOpportunity[],
    evidence: EvidenceBase,
  ) {
    const { db, project, job } = this.ctx;
    const content = StoryArchitectureContentV2.parse(built.content);
    const reportJson = QualityReport.parse(report);
    return db.$transaction(
      async (tx) => {
        const last = await tx.storyArchitecture.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, select: { version: true } });
        await tx.storyArchitecture.updateMany({ where: { projectId: project.id, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
        const story = await tx.storyArchitecture.create({
          data: {
            projectId: project.id,
            dossierId,
            packId,
            version: (last?.version ?? 0) + 1,
            engineVersion: CURRENT_STORY_ENGINE,
            status: report.passed ? 'IN_REVIEW' : 'DRAFT',
            content: content as unknown as Prisma.InputJsonValue,
            targetDurationSec: target.targetSec,
            estimatedDurationSec: totalDurationSec(content),
            qualityReport: reportJson as unknown as Prisma.InputJsonValue,
            qualityPassed: report.passed,
            stats: stats as Prisma.InputJsonValue,
            notes: editorNotes,
            jobId: job.id,
          },
        });
        for (const o of opportunities) {
          await tx.contentOpportunity.create({
            data: {
              projectId: project.id,
              architectureId: story.id,
              dossierId,
              opportunityKey: o.key,
              format: o.format,
              rank: o.rank,
              shortScore: o.shortScore,
              title: o.title,
              hook: o.hook,
              centralQuestion: o.centralQuestion,
              targetDurationSec: o.targetDurationSec,
              independent: o.independent,
              requiresContext: o.requiresContext,
              historicalStatus: o.historicalStatus,
              historicalConfidence: o.historicalConfidence,
              content: o.content as unknown as Prisma.InputJsonValue,
              claims: { create: o.content.claimKeys.map((k) => ({ claimId: evidence.claim(k)!.id })) },
            },
          });
        }
        return story;
      },
      { timeout: 60_000 },
    );
  }

  private noteModel(model: string | undefined) {
    if (model && !this.models.includes(model)) this.models.push(model);
  }
}

function toIssue(i: StoryEditorOutputIssue, accepted: boolean, who: 'Story' | 'Fact'): CoherenceIssue {
  return {
    severity: i.severity,
    description: `${who === 'Story' ? 'Story editor: ' : ''}${i.sequenceNumbers.length ? `Sequence ${i.sequenceNumbers.join(', ')}: ` : ''}${i.description}`,
    claimKeys: i.claimKeys,
    resolution: i.fixedInRevision && accepted ? 'Fixed in the revised architecture' : 'Left for human review',
  };
}
type StoryEditorOutputIssue = StoryEditorOutput['issues'][number];

/** The opportunities as a report check: never a failure (they are suggestions; quality over quantity). */
function opportunityCheck(opportunities: readonly BuiltOpportunity[], removed: readonly RemovedOpportunity[], unavailable: string | null): QualityCheck {
  const shorts = opportunities.filter((o) => o.format !== 'LONG_FORM').length;
  const longForm = opportunities.length - shorts;
  if (unavailable) return { id: 'content_opportunities', label: 'Content opportunities', status: 'WARN', detail: `Not identified: ${unavailable}`, metric: 0, threshold: null };
  return {
    id: 'content_opportunities',
    label: 'Content opportunities',
    status: shorts === 0 ? 'WARN' : 'PASS',
    detail: `${shorts} short-form and ${longForm} long-form opportunities, each traced to architecture beats${removed.length ? `; ${removed.length} removed by the rules` : ''}${shorts === 0 ? ': no strong short found' : ''}`,
    metric: shorts,
    threshold: null,
  };
}

type CandidateRow = Prisma.StoryCandidateGetPayload<{ include: { claims: { include: { claim: { select: { claimKey: true } } } } } }>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/** A selected candidate as the architect sees it: the editor's overrides applied. */
export function toUnit(c: CandidateRow, evidence: EvidenceBase): SelectedUnit {
  const characters = z.array(StoryCharacter).safeParse(c.characters);
  const myth = c.mythThread === null ? null : MythThread.safeParse(c.mythThread);
  const overrides = parse(CandidateOverrides, c.editorOverrides) ?? {};
  return {
    id: c.id,
    key: c.candidateKey,
    title: overrides.title ?? c.title,
    hook: c.hook,
    storyType: c.storyType,
    characters: characters.success ? characters.data : [],
    setting: c.setting,
    timePeriod: c.timePeriod,
    desire: c.desire,
    conflict: c.conflict,
    stakes: c.stakes,
    escalation: c.escalation,
    turningPoint: c.turningPoint,
    payoff: c.payoff,
    viewerQuestion: c.viewerQuestion,
    mythThread: myth?.success ? myth.data : null,
    notes: c.notes,
    claimKeys: orderedKeys(c.claims.map((x) => x.claim.claimKey), evidence),
    historicalStatus: c.historicalStatus,
    historicalConfidence: c.historicalConfidence,
    rankScore: c.rankScore,
    status: c.status,
    priority: c.priority,
    editorNotes: c.editorNotes,
    narrativeMode: overrides.narrativeMode ?? c.narrativeMode,
    centralQuestion: overrides.centralQuestion ?? c.centralQuestion,
    povStrategy: overrides.povStrategy ?? parse(PovChoice, c.povStrategy),
    humanStakes: parse(HumanStakes, c.humanStakes),
    storyDesign: parse(StoryDesign, c.storyDesign),
    selectionOrder: c.selectionOrder,
  };
}

function renderUnit(u: SelectedUnit): string {
  const editor = [
    u.selectionOrder !== null ? `#${u.selectionOrder} in the editor's order` : null,
    u.priority !== 'NORMAL' ? `${u.priority} priority` : null,
    u.status !== 'PROPOSED' ? `editor: ${u.status}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `## ${u.key}${editor ? ` · ${editor}` : ''} · ${u.historicalStatus} ${u.historicalConfidence}/10 — ${u.title} [${u.storyType}]`,
    `hook: ${u.hook}`,
    `characters: ${u.characters.map((c) => `${c.name} (${c.kind}): ${c.role}`).join('; ')}`,
  ];
  if (u.humanStakes) {
    lines.push(`human stakes: ${u.humanStakes.protagonist || '(no protagonist recorded)'} — wants: ${u.desire}; could gain: ${u.humanStakes.couldGain || '—'}; could lose: ${u.humanStakes.couldLose || '—'}; problem: ${u.humanStakes.immediateProblem || '—'}`);
  } else {
    lines.push(`desire: ${u.desire}`);
  }
  lines.push(`setting: ${u.setting} | period: ${u.timePeriod}${u.storyDesign ? ` | on screen: ${u.storyDesign.visualEnvironment}` : ''}`, `conflict: ${u.conflict}`, `stakes: ${u.stakes}`, `escalation: ${u.escalation}`, `turning point: ${u.turningPoint}`);
  if (u.storyDesign) lines.push(`reveal: ${u.storyDesign.reveal}`, `cold open idea [${u.storyDesign.coldOpen.basis}]: ${u.storyDesign.coldOpen.text}`);
  lines.push(`consequence: ${u.payoff}`, `viewer question: ${u.viewerQuestion}`);
  if (u.centralQuestion) lines.push(`central question: ${u.centralQuestion}`);
  if (u.narrativeMode || u.povStrategy) lines.push(`told as: ${u.narrativeMode ?? '—'}${u.povStrategy ? `; POV ${u.povStrategy.type}${u.povStrategy.description ? ` (${u.povStrategy.description})` : ''}` : ''}`);
  if (u.mythThread) {
    const m = u.mythThread;
    lines.push(`myth thread: popular story: ${m.popularStory} | origin: ${m.origin} | spread by: ${m.whoSpreadIt} | what happened: ${m.whatHappened} | why it survived: ${m.whyItSurvived}`);
  }
  if (u.notes) lines.push(`caveats: ${u.notes}`);
  if (u.editorNotes) lines.push(`editor's notes: ${u.editorNotes}`);
  lines.push(`claims: ${u.claimKeys.join(', ')}`);
  return lines.join('\n');
}
