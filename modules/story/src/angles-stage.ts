import {
  AnyStoryArchitectureContent,
  ExploreAnglesInput,
  PRESENTATION_FOR_VERDICT,
  QualityReport,
  StoryExplorationContent,
  isArchitectureV2,
  runtimeTarget,
  selectionProblem,
  type QualityCheck,
  type RuntimeTarget,
  type StoryArchitectureContentV2,
} from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { buildAngles, type BuiltAngles } from './angles.ts';
import { coreClaimsOf, type SelectedUnit } from './architecture.ts';
import { candidateInclude, renderUnit, toUnit } from './architecture-stage.ts';
import { StepCheckpoint } from './checkpoint.ts';
import { DEFAULT_STORY_CONFIG, type StoryConfig } from './config.ts';
import { EvidenceBase } from './evidence.ts';
import { PROMPT_VERSION, anglesSystemPrompt } from './prompts.ts';
import { fmtMinutes } from './quality.ts';
import { AnglesOutput } from './schemas.ts';
import { CostCeiling } from './util.ts';

/**
 * STORY_ANGLES (a side job): before the editor commits to one architecture,
 * explore 2–3 materially different narrative approaches to the same curated
 * story units — mode, POV, opening, emotional centre, structure. One model
 * call; the rules keep every angle inside the evidence boundary (the pack's
 * units and their claims, nothing new) and drop near-duplicates. The result
 * is a versioned exploration; nothing is committed or approved, and the
 * project's status does not change.
 */
export function createStoryAnglesStage(overrides: Partial<StoryConfig> = {}): StageHandler {
  const cfg: StoryConfig = { ...DEFAULT_STORY_CONFIG, ...overrides };
  return { type: 'STORY_ANGLES', mock: false, run: (ctx) => new AnglesRun(ctx, cfg).run() };
}

const STEPS = ['angles'] as const;

class AnglesRun {
  private readonly steps: StepCheckpoint<(typeof STEPS)[number]>;
  private readonly ceiling: CostCeiling;
  private readonly models: string[] = [];

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: StoryConfig,
  ) {
    this.steps = new StepCheckpoint(ctx, STEPS);
    this.ceiling = new CostCeiling(ctx, cfg.maxCostUsd.angles, 'Angle exploration');
  }

  async run(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { ctx } = this;
    const parsed = ExploreAnglesInput.safeParse(ctx.job.input ?? {});
    if (!parsed.success) throw new NonRetryableError(`Invalid STORY_ANGLES input: ${parsed.error.message}`);
    const input = parsed.data;
    if (!(await this.steps.load())) ctx.logger.warn({ jobId: ctx.job.id }, 'saved angle-exploration progress is from another version; starting over');

    const pack = await ctx.db.storyPack.findFirst({ where: { projectId: ctx.project.id }, orderBy: { version: 'desc' }, include: candidateInclude(true) });
    if (!pack || (pack.status !== 'IN_REVIEW' && pack.status !== 'APPROVED')) throw new NonRetryableError('No story pack to explore: run Story Mining first.');
    const selected = pack.candidates.filter((c) => c.selected);
    const problem = selectionProblem(selected.length);
    if (problem) throw new NonRetryableError(`Cannot explore angles: ${problem}.`);
    const evidence = await EvidenceBase.load(ctx.db, pack.dossierId);
    const units = [
      ...selected.map((c) => toUnit(c, evidence)).sort((a, b) => (a.selectionOrder ?? Infinity) - (b.selectionOrder ?? Infinity)),
      ...pack.candidates.filter((c) => !c.selected).map((c) => toUnit(c, evidence, true)),
    ];
    const base = input.basedOnVersion !== undefined ? await this.loadBase(input.basedOnVersion, pack.id) : null;
    const target = runtimeTarget(ctx.project);
    await ctx.progress(`Exploring ${input.count} alternative angles from pack v${pack.version}: ${selected.length} selected units${units.length > selected.length ? ` + ${units.length - selected.length} approved in reserve` : ''}${base ? `; as alternatives to architecture v${base.version}` : ''}`, {
      units: units.map((u) => `${u.key} ${u.title}${u.reserve ? ' [reserve]' : ''}`),
      notes: input.notes ?? null,
    });

    const raw = await this.steps.step('angles', AnglesOutput, () => this.explore(units, evidence, target, input.count, input.notes ?? null, base));
    await this.ceiling.check();
    const built = buildAngles(raw, units, evidence, { count: input.count, base: base?.content ?? null, baseVersion: base?.version ?? null });
    const report = anglesReport(built, input.count);
    const content: StoryExplorationContent = {
      angles: built.angles,
      removed: built.removed,
      poolKeys: units.map((u) => u.key),
      reserveKeys: units.filter((u) => u.reserve).map((u) => u.key),
      comparisons: built.comparisons,
      basedOnVersion: base?.version ?? null,
      editorNotes: input.notes ?? null,
    };
    const stats = { promptVersion: PROMPT_VERSION, packVersion: pack.version, dossierVersion: evidence.dossierVersion, models: this.models, proposed: raw.angles.length, kept: built.angles.length, removed: built.removed, resumedSteps: [...this.steps.reused], durationMs: Date.now() - started };
    const exploration = await this.persist(pack.id, base?.id ?? null, content, report, stats, input.notes ?? null);
    await ctx.progress(`Angle exploration ${exploration.version} saved: ${built.angles.map((a) => `${a.key} "${a.title}" (${a.narrativeMode}, ${a.povStrategy.type})`).join('; ') || 'no angle kept'}`, {
      explorationId: exploration.id,
      removed: built.removed.map((r) => `${r.title}: ${r.reason}`),
      comparisons: built.comparisons.map((c) => `${c.a}/${c.b}: ${c.differences.join(', ')}`),
    });
    if (!report.passed) {
      throw new NonRetryableError(`Fewer than two materially different angles survived the rules (${built.angles.length} of ${raw.angles.length}): ${built.removed.map((r) => `"${r.title}" — ${r.reason}`).join('; ')}. Exploration ${exploration.version} saved for inspection.`);
    }
    await this.steps.clear();
    return { explorationId: exploration.id, version: exploration.version, angles: built.angles.length, stats };
  }

  private async loadBase(version: number, packId: string): Promise<{ id: string; version: number; content: StoryArchitectureContentV2 | null; outline: string }> {
    const a = await this.ctx.db.storyArchitecture.findUnique({ where: { projectId_version: { projectId: this.ctx.project.id, version } } });
    if (!a) throw new NonRetryableError(`Architecture v${version} does not exist.`);
    if (a.packId !== packId) throw new NonRetryableError(`Architecture v${version} was built from an earlier story pack.`);
    const parsed = AnyStoryArchitectureContent.safeParse(a.content);
    if (!parsed.success) return { id: a.id, version, content: null, outline: '(unreadable)' };
    const c = parsed.data;
    const outline = isArchitectureV2(c)
      ? [`Logline: ${c.logline}`, `Central question: ${c.centralQuestion}`, `Human stakes: ${c.centralHumanStakes}`, `Mode: ${c.narrativeMode}; POV: ${c.povStrategy.type}`, ...c.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ')}; ${s.mode}): ${s.openingHook}`)].join('\n')
      : [`Premise: ${c.premise}`, `Central question: ${c.centralQuestion}`, ...c.sequences.map((s) => `${s.number}. ${s.title} (${s.candidateKeys.join(', ')}): ${s.purpose}`)].join('\n');
    return { id: a.id, version, content: isArchitectureV2(c) ? c : null, outline };
  }

  private async explore(units: readonly SelectedUnit[], evidence: EvidenceBase, target: RuntimeTarget, count: number, notes: string | null, base: { version: number; outline: string } | null): Promise<AnglesOutput> {
    const { ctx, cfg } = this;
    const claimKeys = coreClaimsOf(units, evidence);
    const parts = [
      `Documentary: ${ctx.project.title} — ${ctx.project.topic}`,
      `Target runtime: about ${fmtMinutes(target.targetSec)} (acceptable ${fmtMinutes(target.minSec)}–${fmtMinutes(target.maxSec)})`,
      '',
      `Propose ${count} materially different approaches to the story units below.`,
    ];
    if (notes) parts.push('', `The editor's brief for this exploration (follow it):\n${notes}`);
    if (base) parts.push('', `# The current architecture v${base.version} — every approach must also differ materially from it`, base.outline);
    parts.push(
      '',
      `# Story units (the editor's selection${units.some((u) => u.reserve) ? ', then units the editor approved but did not select' : ''})`,
      units.map(renderUnit).join('\n\n'),
      '',
      `# Evidence: the units' claims (${claimKeys.length})`,
      evidence.renderClaims(claimKeys, { quotes: 2, quoteChars: 300 }),
    );
    const uncertain = claimKeys.filter((k) => evidence.claim(k)!.verdict !== 'ESTABLISHED').map((k) => `${k} ${evidence.claim(k)!.verdict} → ${PRESENTATION_FOR_VERDICT[evidence.claim(k)!.verdict]}`);
    if (uncertain.length) parts.push('', `Claims that are not established (name them among the risks where an approach leans on them): ${uncertain.join('; ')}`);
    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task: 'story.angles',
          schema: AnglesOutput,
          schemaName: 'StoryAngles',
          system: anglesSystemPrompt(target, count),
          messages: [{ role: 'user', content: parts.join('\n') }],
          effort: cfg.effort.angles,
          maxTokens: cfg.maxTokens.angles,
          signal: ctx.signal,
        }),
      { request: { task: 'story.angles', count, units: units.length, basedOn: base?.version ?? null }, summarize: (x) => ({ angles: x.object.angles.length }) },
    );
    if (r.meta.model && !this.models.includes(r.meta.model)) this.models.push(r.meta.model);
    return r.object;
  }

  private async persist(packId: string, basedOnArchitectureId: string | null, content: StoryExplorationContent, report: QualityReport, stats: Record<string, unknown>, notes: string | null) {
    const { db, project, job } = this.ctx;
    const parsedContent = StoryExplorationContent.parse(content);
    return db.$transaction(async (tx) => {
      const last = await tx.storyExploration.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, select: { version: true } });
      return tx.storyExploration.create({
        data: {
          projectId: project.id,
          packId,
          version: (last?.version ?? 0) + 1,
          basedOnArchitectureId,
          content: parsedContent as unknown as Prisma.InputJsonValue,
          qualityReport: QualityReport.parse(report) as unknown as Prisma.InputJsonValue,
          qualityPassed: report.passed,
          stats: stats as Prisma.InputJsonValue,
          notes,
          jobId: job.id,
        },
      });
    });
  }
}

/** The exploration's checks: enough materially different angles; what the rules removed and flagged. */
function anglesReport(built: BuiltAngles, count: number): QualityReport {
  const n = built.angles.length;
  const evidenceRemovals = built.removed.filter((r) => !r.reason.startsWith('too close') && !r.reason.startsWith('beyond'));
  const twins = built.removed.filter((r) => r.reason.startsWith('too close'));
  const warnings = built.angles.flatMap((a) => a.warnings.map((w) => `${a.key}: ${w}`));
  const checks: QualityCheck[] = [
    { id: 'angle_count', label: 'Materially different angles', status: n >= 2 ? 'PASS' : 'FAIL', detail: `${n} of ${count} asked for${n < count ? ' (quality over quantity: none is padded)' : ''}`, metric: n, threshold: 2 },
    {
      id: 'distinct',
      label: 'Each angle is a different film',
      status: 'PASS',
      detail: built.comparisons.map((c) => `${c.a}/${c.b}: ${c.differences.join(', ')}`).join('; ') + (twins.length ? `; removed as too close: ${twins.map((t) => `"${t.title}"`).join(', ')}` : ''),
      metric: twins.length,
      threshold: null,
    },
    {
      id: 'evidence_bound',
      label: 'Angles stay inside the evidence',
      status: evidenceRemovals.length ? 'WARN' : 'PASS',
      detail: evidenceRemovals.length ? `${evidenceRemovals.length} removed: ${evidenceRemovals.map((r) => `"${r.title}" — ${r.reason}`).join('; ')}` : "Every angle uses only the pack's units and their evidence",
      metric: evidenceRemovals.length,
      threshold: 0,
    },
    { id: 'priorities', label: "The editor's priorities", status: warnings.length ? 'WARN' : 'PASS', detail: warnings.join('; ') || 'No angle leaves out a HIGH-priority unit', metric: warnings.length, threshold: 0 },
  ];
  return { passed: checks.every((c) => c.status !== 'FAIL'), generatedAt: new Date().toISOString(), checks, normalizations: [...built.notes, ...built.angles.flatMap((a) => a.notes.map((x) => `${a.key}: ${x}`))], coherenceIssues: [] };
}
