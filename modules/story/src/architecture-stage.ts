import {
  CANDIDATE_PRIORITIES,
  MythThread,
  QualityReport,
  StoryArchitectureContent,
  StoryCharacter,
  StoryJobInput,
  runtimeTarget,
  selectionProblem,
  type CoherenceIssue,
  type RuntimeTarget,
} from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError } from '@docengine/providers';
import { z } from 'zod';
import { blockingCount, buildArchitecture, coreClaimsOf, describeFinding, totalDurationSec, type BuiltArchitecture, type SelectedUnit } from './architecture.ts';
import { StepCheckpoint } from './checkpoint.ts';
import { DEFAULT_STORY_CONFIG, type StoryConfig } from './config.ts';
import { EvidenceBase } from './evidence.ts';
import { PROMPT_VERSION, architectSystemPrompt, reviewSystemPrompt } from './prompts.ts';
import { computeArchitectureReport, fmtMinutes } from './quality.ts';
import { caveatClaims, orderedKeys } from './rules.ts';
import { ArchitectOutput, ArchitectureReviewOutput } from './schemas.ts';
import { CostCeiling } from './util.ts';

/**
 * STORY_ARCHITECTURE stage. Turns the editor's selection from the current
 * story pack into a documentary blueprint — premise, central question,
 * narrative spine and sequences, each traced to claims and sources — then has
 * a fact-checking editor review (and, where the evidence allows, fix) it.
 *
 *   architect → evidence rules → review (+ revision) → evidence rules → gate
 *             → story architecture vN (IN_REVIEW for the human gate)
 *
 * It writes no script and approves nothing: a human approves or rejects the
 * architecture at the STORY gate.
 */
export function createStoryArchitectureStage(overrides: Partial<StoryConfig> = {}): StageHandler {
  const cfg: StoryConfig = { ...DEFAULT_STORY_CONFIG, ...overrides };
  return { type: 'STORY_ARCHITECTURE', mock: false, run: (ctx) => new ArchitectureRun(ctx, cfg).run() };
}

const STEPS = ['architect', 'review'] as const;
type Step = (typeof STEPS)[number];

const ReviewStep = z.union([ArchitectureReviewOutput, z.object({ unavailable: z.string() })]);
type ReviewStep = z.infer<typeof ReviewStep>;

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
    // Stable sort: by the editor's priority, then rank (the query's order).
    const units = pack.candidates.map((c) => toUnit(c, evidence)).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    const target = runtimeTarget(ctx.project);
    const rework = await this.loadRework();
    await ctx.progress(
      `Story architecture from pack v${pack.version}: ${units.length} selected units (${units.filter((u) => u.priority === 'HIGH').length} high priority); target ${fmtMinutes(target.targetSec)}` +
        (rework ? `; reworking v${rework.version}` : ''),
      { packId: pack.id, units: units.map((u) => `${u.key} ${u.title} [${u.priority}]`), editorNotes },
    );

    // 1. Architect.
    const draftRaw = await this.steps.step('architect', ArchitectOutput, () => this.architect(units, evidence, target, editorNotes, rework));
    const draft = buildArchitecture(draftRaw, evidence, units);
    await ctx.progress(`Architecture draft: ${draft.content.sequences.length} sequences, ~${fmtMinutes(totalDurationSec(draft.content))}; ${draft.findings.length} automated findings`, {
      findings: draft.findings.map(describeFinding),
    });
    await this.ceiling.check();

    // 2. Review: a fact-checking editor, who may return a corrected version.
    const review = await this.steps.step('review', ReviewStep, () => this.review(draft, units, evidence, target));
    let final = draft;
    const notes = [...draft.notes];
    let revisedByReviewer = false;
    let issues: CoherenceIssue[];
    if ('unavailable' in review) {
      issues = [{ severity: 'MAJOR', description: `Automated review unavailable: ${review.unavailable}`, claimKeys: [], resolution: 'Left for human review' }];
    } else {
      let accepted = false;
      if (review.revised) {
        const revised = buildArchitecture(review.revised, evidence, units);
        if (blockingCount(revised.findings) <= blockingCount(draft.findings)) {
          final = revised;
          accepted = true;
          revisedByReviewer = true;
          notes.push(...revised.notes.map((n) => `(revision) ${n}`), 'The reviewer revised the architecture; the evidence rules were re-applied to the revision.');
        } else {
          notes.push(`The reviewer's revision was discarded: it had ${blockingCount(revised.findings)} evidence problems against the draft's ${blockingCount(draft.findings)}.`);
        }
      }
      issues = review.issues.map((i) => ({
        severity: i.severity,
        description: `${i.sequenceNumbers.length ? `Sequence ${i.sequenceNumbers.join(', ')}: ` : ''}${i.description}`,
        claimKeys: i.claimKeys,
        resolution: i.fixedInRevision && accepted ? 'Fixed in the revised architecture' : 'Left for human review',
      }));
    }
    await ctx.progress(`Review: ${issues.length} issues; ${revisedByReviewer ? 'revision accepted' : 'no revision applied'}; ${final.findings.length} automated findings remain`, {
      issues: issues.map((i) => `${i.severity}: ${i.description} — ${i.resolution}`),
      findings: final.findings.map(describeFinding),
    });

    // 3. Gate and save.
    const report = computeArchitectureReport({ content: final.content, evidence, units, findings: final.findings, issues, normalizations: notes, target });
    const stats = {
      promptVersion: PROMPT_VERSION,
      packVersion: pack.version,
      dossierVersion: evidence.dossierVersion,
      units: units.length,
      models: this.models,
      sequences: final.content.sequences.length,
      draftFindings: draft.findings.length,
      finalFindings: final.findings.length,
      reviewIssues: issues.length,
      revisedByReviewer,
      resumedSteps: [...this.steps.reused],
      durationMs: Date.now() - started,
    };
    const story = await this.persist(pack.id, pack.dossierId, final, report, target, stats, editorNotes);
    if (report.passed) await this.steps.clear();

    const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label} (${c.detail})`);
    const total = totalDurationSec(final.content);
    await ctx.progress(`Story architecture v${story.version} saved: ${final.content.sequences.length} sequences, ~${fmtMinutes(total)} — quality gate ${report.passed ? 'PASSED' : 'FAILED'}`, {
      architectureId: story.id,
      premise: final.content.premise,
      centralQuestion: final.content.centralQuestion,
      sequences: final.content.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ') || 'no unit'}; ${s.estimatedDurationSec}s; ${s.historicalStatus} ${s.historicalConfidence}/10)`),
      failedChecks: failed,
    });
    if (!report.passed) {
      throw new NonRetryableError(`Story architecture quality gate failed: ${failed.join('; ')}. Architecture v${story.version} saved as DRAFT for inspection.`);
    }
    return { architectureId: story.id, version: story.version, qualityPassed: true, sequences: final.content.sequences.length, estimatedDurationSec: total, stats };
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async architect(units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget, editorNotes: string | null, rework: Rework | null): Promise<ArchitectOutput> {
    const { ctx, cfg } = this;
    const claimKeys = coreClaimsOf(units, evidence);
    const background = [...evidence.claims.keys()].filter((k) => !claimKeys.includes(k));
    const caveats = caveatClaims([...evidence.claims.keys()], evidence).map((k) => `${k} (${evidence.claim(k)!.verdict})`);
    const parts = [
      `Documentary: ${ctx.project.title} — ${ctx.project.topic}`,
      `Target runtime: about ${fmtMinutes(target.targetSec)} (acceptable ${fmtMinutes(target.minSec)}–${fmtMinutes(target.maxSec)})`,
    ];
    if (editorNotes) parts.push('', `The editor's instructions for this version (follow them):\n${editorNotes}`);
    if (rework) {
      parts.push('', `Previous architecture v${rework.version} (${rework.status}). The editor's decisions on it:\n${rework.decisions.map((d) => `- ${d}`).join('\n') || '- none recorded'}\nIts outline:\n${rework.outline}`);
    }
    parts.push('', '# Selected story units (the editor\'s order: priority, then rank)', units.map(renderUnit).join('\n\n'));
    parts.push(
      '',
      `# Story evidence: the selected units' claims (${claimKeys.length})`,
      'Only these claims may be story evidence: claimKeys, key events, people, figures and dates.',
      evidence.renderClaims(claimKeys, { quotes: 2, quoteChars: 320 }),
    );
    if (background.length) {
      parts.push(
        '',
        `# Other claims of the approved dossier: background only (${background.length})`,
        'Cite one only as a contextClaim with its purpose, for setting or explanation. Never use them for key events, people, figures, dates or narrative beats, and never build a story on them.',
        evidence.renderClaimList(background),
      );
    }
    if (caveats.length) parts.push('', `Claims that need a caveat in every sequence that uses them (as story evidence or context): ${caveats.join(', ')}`);

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

  private async review(draft: BuiltArchitecture, units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget): Promise<ReviewStep> {
    const { ctx, cfg } = this;
    const c = draft.content;
    const asOutput: ArchitectOutput = {
      premise: c.premise,
      centralQuestion: c.centralQuestion,
      narrativeSpine: c.narrativeSpine,
      resolution: c.resolution,
      sequences: c.sequences.map((s) => ({
        title: s.title,
        purpose: s.purpose,
        candidateKeys: s.candidateKeys,
        openingHook: s.openingHook,
        narrativeQuestion: s.narrativeQuestion,
        keyEvents: s.keyEvents,
        characters: s.characters,
        conflict: s.conflict,
        escalation: s.escalation,
        reveal: s.reveal,
        endingBeat: s.endingBeat,
        claimKeys: s.claimKeys,
        contextClaims: s.contextClaims,
        caveats: s.caveats,
        estimatedDurationSec: s.estimatedDurationSec,
      })),
      unusedCandidates: c.unusedCandidates,
    };
    const core = coreClaimsOf(units, evidence);
    const others = orderedKeys(
      c.sequences.flatMap((s) => [...s.claimKeys, ...s.keyEvents.flatMap((e) => e.claimKeys), ...s.contextClaims.map((x) => x.claimKey)]),
      evidence,
    ).filter((k) => !core.includes(k));
    const content = [
      `Documentary: ${ctx.project.title} — ${ctx.project.topic}`,
      `Target runtime: ${fmtMinutes(target.minSec)}–${fmtMinutes(target.maxSec)}; current estimate ${fmtMinutes(totalDurationSec(c))}`,
      '',
      `Selected units: ${units.map((u) => `${u.key} [${u.priority}] ${u.title}`).join('; ')}`,
      `Story evidence allowed (the selected units' claims): ${core.join(', ')}`,
      '',
      `Automated findings (fix every one the evidence allows):\n${draft.findings.map((f) => `- ${describeFinding(f)}`).join('\n') || '- none'}`,
      '',
      '# Architecture',
      JSON.stringify(asOutput, null, 1),
      '',
      '# Evidence: the selected units\' claims',
      evidence.renderClaims(core, { quotes: 2, quoteChars: 320 }),
      ...(others.length ? ['', '# Other dossier claims the architecture uses (background only, never story evidence)', evidence.renderClaims(others, { quotes: 1, quoteChars: 240 })] : []),
    ].join('\n');
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
            messages: [{ role: 'user', content }],
            effort: cfg.effort.review,
            maxTokens: cfg.maxTokens.review,
            signal: ctx.signal,
          }),
        { request: { task: 'story.review', sequences: c.sequences.length, findings: draft.findings.length }, summarize: (x) => ({ issues: x.object.issues.length, revised: x.object.revised !== null }) },
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
    const parsed = StoryArchitectureContent.safeParse(prev.content);
    const outline = parsed.success
      ? [
          `Premise: ${parsed.data.premise}`,
          `Central question: ${parsed.data.centralQuestion}`,
          ...parsed.data.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ')}): ${s.purpose}`),
        ].join('\n')
      : '(unreadable)';
    return {
      version: prev.version,
      status: prev.status,
      decisions: prev.approvals.map((a) => `${a.decision}${a.notes ? `: ${a.notes}` : ' (no notes)'}`),
      outline,
    };
  }

  // ── Persist ────────────────────────────────────────────────────────────────

  private async persist(packId: string, dossierId: string, built: BuiltArchitecture, report: QualityReport, target: RuntimeTarget, stats: Record<string, unknown>, editorNotes: string | null) {
    const { db, project, job } = this.ctx;
    const content = StoryArchitectureContent.parse(built.content);
    const reportJson = QualityReport.parse(report);
    return db.$transaction(async (tx) => {
      const last = await tx.storyArchitecture.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, select: { version: true } });
      await tx.storyArchitecture.updateMany({ where: { projectId: project.id, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
      return tx.storyArchitecture.create({
        data: {
          projectId: project.id,
          dossierId,
          packId,
          version: (last?.version ?? 0) + 1,
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
    });
  }

  private noteModel(model: string | undefined) {
    if (model && !this.models.includes(model)) this.models.push(model);
  }
}

type CandidateRow = Prisma.StoryCandidateGetPayload<{ include: { claims: { include: { claim: { select: { claimKey: true } } } } } }>;

function toUnit(c: CandidateRow, evidence: EvidenceBase): SelectedUnit {
  const characters = z.array(StoryCharacter).safeParse(c.characters);
  const myth = c.mythThread === null ? null : MythThread.safeParse(c.mythThread);
  return {
    id: c.id,
    key: c.candidateKey,
    title: c.title,
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
  };
}

function renderUnit(u: SelectedUnit): string {
  const editor = [u.priority !== 'NORMAL' ? `${u.priority} priority` : null, u.status !== 'PROPOSED' ? `editor: ${u.status}` : null].filter(Boolean).join(' · ');
  const lines = [
    `## ${u.key}${editor ? ` · ${editor}` : ''} · ${u.historicalStatus} ${u.historicalConfidence}/10 — ${u.title} [${u.storyType}]`,
    `hook: ${u.hook}`,
    `characters: ${u.characters.map((c) => `${c.name} (${c.kind}): ${c.role}`).join('; ')}`,
    `setting: ${u.setting} | period: ${u.timePeriod}`,
    `desire: ${u.desire}`,
    `conflict: ${u.conflict}`,
    `stakes: ${u.stakes}`,
    `escalation: ${u.escalation}`,
    `turning point: ${u.turningPoint}`,
    `payoff: ${u.payoff}`,
    `viewer question: ${u.viewerQuestion}`,
  ];
  if (u.mythThread) {
    const m = u.mythThread;
    lines.push(`myth thread: popular story: ${m.popularStory} | origin: ${m.origin} | spread by: ${m.whoSpreadIt} | what happened: ${m.whatHappened} | why it survived: ${m.whyItSurvived}`);
  }
  if (u.notes) lines.push(`caveats: ${u.notes}`);
  if (u.editorNotes) lines.push(`editor's notes: ${u.editorNotes}`);
  lines.push(`claims: ${u.claimKeys.join(', ')}`);
  return lines.join('\n');
}
