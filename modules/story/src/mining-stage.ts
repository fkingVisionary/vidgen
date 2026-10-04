import {
  QualityReport,
  StoryJobInput,
  StoryPackContent,
  StoryScores,
  StoryCharacter,
  MythThread,
  historicalConfidenceOf,
  historicalStatusOf,
  rankScore,
  runtimeTarget,
  type RuntimeTarget,
} from '@docengine/core';
import { Prisma } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { z } from 'zod';
import { StepCheckpoint } from './checkpoint.ts';
import { DEFAULT_STORY_CONFIG, type StoryConfig } from './config.ts';
import { EvidenceBase } from './evidence.ts';
import { applyAssessments, byRank, normalizeMined, normalizeSelection, type DraftCandidate, type KnownCandidate, type PackCandidate, type RemovedCandidate, type ScoredCandidate } from './mining.ts';
import { PROMPT_VERSION, criticSystemPrompt, miningSystemPrompt, miningUserPrompt, selectionSystemPrompt } from './prompts.ts';
import { computeMiningReport } from './quality.ts';
import { CriticOutput, MiningOutput, SelectionOutput } from './schemas.ts';
import { CostCeiling, countBy, renderCandidateForCritic } from './util.ts';

/**
 * STORY_MINING stage. Mines the project's approved research dossier for
 * story units (not facts), checks every one against the evidence, has a
 * critic score its appeal and support, ranks them (appeal weighted by
 * historical confidence) and proposes a selection for the documentary.
 *
 *   mine → evidence rules → critic (scores + support) → [top-up] → rank
 *        → proposed selection → mining gate → story pack vN
 *
 * Candidates the editor approved or flagged in the previous pass are carried
 * into the new pack; rejected ones are not proposed again. Nothing is
 * approved automatically: the editor curates the pack in STORY_SELECTION.
 */
export function createStoryMiningStage(overrides: Partial<StoryConfig> = {}): StageHandler {
  const cfg: StoryConfig = { ...DEFAULT_STORY_CONFIG, ...overrides };
  return { type: 'STORY_MINING', mock: false, run: (ctx) => new MiningRun(ctx, cfg).run() };
}

const STEPS = ['mine', 'score', 'rescore', 'topUp', 'topUpScore', 'topUpRescore', 'select'] as const;
type Step = (typeof STEPS)[number];

interface Stats {
  promptVersion: string;
  dossierVersion: number;
  models: string[];
  proposed: number;
  removedByRules: number;
  removedByCritic: number;
  carriedOver: number;
  topUp: boolean;
  candidates: number;
  selected: number;
  resumedSteps: string[];
  durationMs?: number;
}

/** The previous pack on the same dossier: what the editor decided there. */
interface Prior {
  version: number;
  carried: PackCandidate[];
  rejected: { key: string; title: string; hook: string; editorNotes: string | null; claimKeys: string[] }[];
}

class MiningRun {
  private readonly steps: StepCheckpoint<Step>;
  private readonly ceiling: CostCeiling;
  private stats!: Stats;

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: StoryConfig,
  ) {
    this.steps = new StepCheckpoint(ctx, STEPS);
    this.ceiling = new CostCeiling(ctx, cfg.maxCostUsd.mining, 'Story mining');
  }

  async run(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { ctx, cfg } = this;
    const parsedInput = StoryJobInput.safeParse(ctx.job.input ?? {});
    if (!parsedInput.success) throw new NonRetryableError(`Invalid STORY_MINING input: ${parsedInput.error.message}`);
    const editorNotes = parsedInput.data.notes || null;
    if (!(await this.steps.load())) ctx.logger.warn({ jobId: ctx.job.id }, 'saved story-mining progress is from another version; starting over');

    const dossier = await ctx.db.researchDossier.findFirst({ where: { projectId: ctx.project.id, status: 'APPROVED' }, orderBy: { version: 'desc' } });
    if (!dossier) throw new NonRetryableError('Story mining needs an approved research dossier, and this project has none.');
    const evidence = await EvidenceBase.load(ctx.db, dossier.id);
    const target = runtimeTarget(ctx.project);
    const prior = await this.loadPrior(dossier.id, evidence);
    this.stats = {
      promptVersion: PROMPT_VERSION,
      dossierVersion: dossier.version,
      models: [],
      proposed: 0,
      removedByRules: 0,
      removedByCritic: 0,
      carriedOver: prior?.carried.length ?? 0,
      topUp: false,
      candidates: 0,
      selected: 0,
      resumedSteps: [],
    };
    await ctx.progress(
      `Story mining on research dossier v${dossier.version}: ${evidence.claims.size} claims` +
        (prior ? `; ${prior.carried.length} candidates carried over from pack v${prior.version}, ${prior.rejected.length} rejected there are excluded` : '') +
        (editorNotes ? '; following the editor\'s brief' : ''),
      { dossierId: dossier.id, editorNotes },
    );

    const carried = prior?.carried ?? [];
    const known: KnownCandidate[] = carried.map((c) => ({ label: `${c.title} (carried over)`, title: c.title, claimKeys: c.claimKeys }));
    const rejected: KnownCandidate[] = (prior?.rejected ?? []).map((r) => ({ label: r.title, title: r.title, claimKeys: r.claimKeys }));
    const removed: RemovedCandidate[] = [];
    const notes: string[] = [];

    // 1. Mine.
    const count = Math.max(12, cfg.mineCount - carried.length);
    const mined = await this.steps.step('mine', MiningOutput, () => this.mine(evidence, target, count, editorNotes, carried, prior, []));
    this.stats.proposed += mined.candidates.length;
    const first = normalizeMined(mined.candidates, evidence, { firstRef: 1, known, rejected });
    notes.push(...first.notes);
    removed.push(...first.removed);
    this.stats.removedByRules += first.removed.length;
    await ctx.progress(`Mining: ${mined.candidates.length} candidates proposed; ${first.removed.length} removed by the evidence rules`, {
      removed: first.removed.map((r) => `${r.title}: ${r.reason}`),
    });
    await this.ceiling.check();

    // 2. Critic: support check and appeal scores.
    const scored = await this.assess(first.kept, evidence, 'score', 'rescore', removed);
    await this.ceiling.check();

    // 3. Top up when the rules and the critic left too few.
    const min = cfg.limits.candidates.min;
    if (scored.length + carried.length < min) {
      this.stats.topUp = true;
      const shortfall = min - scored.length - carried.length;
      const keepForPrompt = [...carried, ...scored];
      const more = await this.steps.step('topUp', MiningOutput, () => this.mine(evidence, target, shortfall + cfg.topUpExtra, editorNotes, keepForPrompt, prior, removed));
      this.stats.proposed += more.candidates.length;
      const second = normalizeMined(more.candidates, evidence, {
        firstRef: mined.candidates.length + 1,
        known: [...known, ...scored.map((s) => ({ label: s.title, title: s.title, claimKeys: s.claimKeys }))],
        rejected,
      });
      notes.push(...second.notes);
      removed.push(...second.removed);
      this.stats.removedByRules += second.removed.length;
      await ctx.progress(`Top-up mining: ${more.candidates.length} more proposed; ${second.removed.length} removed by the evidence rules`, {
        removed: second.removed.map((r) => `${r.title}: ${r.reason}`),
      });
      scored.push(...(await this.assess(second.kept, evidence, 'topUpScore', 'topUpRescore', removed)));
      await this.ceiling.check();
    } else {
      for (const s of ['topUp', 'topUpScore', 'topUpRescore'] as const) await this.steps.skip(s);
    }

    // 4. Rank everything together; carried candidates keep the editor's decisions.
    let pool: PackCandidate[] = [...carried, ...scored.map(toPackCandidate)].sort(byRank);
    const max = cfg.limits.candidates.max;
    if (pool.length > max) {
      // Carried candidates are the editor's: only newly mined ones are cut, lowest ranked first.
      const keep = new Set([...pool.filter((c) => c.carriedFrom), ...pool.filter((c) => !c.carriedFrom).slice(0, Math.max(0, max - carried.length))]);
      for (const c of pool.filter((x) => !keep.has(x))) removed.push({ title: c.title, storyType: c.storyType, reason: `beyond the pack limit of ${max} (lowest ranked)`, claimKeys: c.claimKeys });
      pool = pool.filter((c) => keep.has(c));
    }
    pool.forEach((c, i) => {
      c.rank = i + 1;
      c.key = `S${String(i + 1).padStart(2, '0')}`;
    });

    // 5. Propose a selection for the documentary (the editor decides).
    let proposal: SelectionOutput = { selected: [], workingPremise: '', rationale: '', alternates: [] };
    if (pool.length > 0) proposal = await this.steps.step('select', SelectionOutput, () => this.select(pool, target, editorNotes));
    else await this.steps.skip('select');
    const selection = normalizeSelection(proposal, pool, cfg.limits.selection);
    for (const c of pool) {
      c.aiSelected = selection.keys.includes(c.key);
      c.aiSelectionReason = selection.reasons.get(c.key) ?? null;
    }

    // 6. Gate and save.
    const report = computeMiningReport({ candidates: pool, evidence, selectionKeys: selection.keys, removed, normalizations: [...notes, ...selection.notes], limits: cfg.limits });
    this.stats.candidates = pool.length;
    this.stats.selected = selection.keys.length;
    this.stats.resumedSteps = [...this.steps.reused];
    this.stats.durationMs = Date.now() - started;
    const content: StoryPackContent = {
      selection: { candidateKeys: selection.keys, workingPremise: selection.workingPremise, rationale: selection.rationale, alternates: selection.alternates },
      removed: removed.map((r) => ({ title: r.title, storyType: r.storyType, reason: r.reason, claimKeys: r.claimKeys })),
      carriedOver: pool.filter((c) => c.carriedFrom).map((c) => ({ fromPackVersion: c.carriedFrom!.packVersion, fromKey: c.carriedFrom!.key, key: c.key })),
      editorNotes,
    };
    const pack = await this.persist(dossier.id, evidence, pool, content, report, editorNotes);
    if (report.passed) await this.steps.clear(); // a failed gate keeps it: a retry re-evaluates without paying again

    const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label} (${c.detail})`);
    await ctx.progress(`Story pack v${pack.version} saved: ${pool.length} candidates, ${selection.keys.length} proposed for the documentary — quality gate ${report.passed ? 'PASSED' : 'FAILED'}`, {
      packId: pack.id,
      ranked: pool.map((c) => `${c.key} ${c.title} [${c.storyType}, ${c.historicalStatus} ${c.historicalConfidence}/10, rank ${c.rankScore}]`),
      selection: selection.keys,
      workingPremise: selection.workingPremise,
      failedChecks: failed,
    });
    if (!report.passed) {
      throw new NonRetryableError(`Story mining quality gate failed: ${failed.join('; ')}. Pack v${pack.version} saved as DRAFT for inspection.`);
    }
    return {
      packId: pack.id,
      version: pack.version,
      qualityPassed: report.passed,
      candidates: pool.length,
      selected: selection.keys.length,
      removed: removed.length,
      historicalStatus: countBy(pool, (c) => c.historicalStatus),
      storyTypes: countBy(pool, (c) => c.storyType),
      stats: this.stats,
    };
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async mine(
    evidence: EvidenceBase,
    target: RuntimeTarget,
    count: number,
    editorNotes: string | null,
    keep: readonly { key?: string; title: string; hook: string }[],
    prior: Prior | null,
    removed: readonly RemovedCandidate[],
  ): Promise<MiningOutput> {
    const { ctx, cfg } = this;
    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task: 'story.mine',
          schema: MiningOutput,
          schemaName: 'StoryCandidates',
          system: miningSystemPrompt(),
          messages: [
            {
              role: 'user',
              content: miningUserPrompt({
                title: ctx.project.title,
                topic: ctx.project.topic,
                target,
                count,
                editorNotes,
                keep: keep.map((k, i) => ({ label: k.key || `K${i + 1}`, title: k.title, hook: k.hook })),
                rejected: prior?.rejected ?? [],
                removed: removed.map((r) => ({ title: r.title, reason: r.reason })),
                dossierVersion: evidence.dossierVersion,
                claims: evidence.renderClaims(),
                sections: evidence.renderSections(),
                sources: evidence.renderSources(),
              }),
            },
          ],
          effort: cfg.effort.mine,
          maxTokens: cfg.maxTokens.mine,
          signal: ctx.signal,
        }),
      { request: { task: 'story.mine', count, claims: evidence.claims.size }, summarize: (x) => ({ candidates: x.object.candidates.length }) },
    );
    this.noteModel(r.meta.model);
    return r.object;
  }

  /** Critic pass: scores and support verdicts; candidates it skipped get one more pass. */
  private async assess(drafts: DraftCandidate[], evidence: EvidenceBase, step: Step, retryStep: Step, removed: RemovedCandidate[]): Promise<ScoredCandidate[]> {
    if (drafts.length === 0) {
      await this.steps.skip(step);
      await this.steps.skip(retryStep);
      return [];
    }
    const first = await this.steps.step(step, CriticOutput, () => this.critic(drafts, evidence));
    let result = applyAssessments(drafts, first.assessments);
    if (result.unassessed.length > 0) {
      const second = await this.steps.step(retryStep, CriticOutput, () => this.critic(result.unassessed, evidence));
      const again = applyAssessments(result.unassessed, second.assessments);
      for (const d of again.unassessed) removed.push({ title: d.title, storyType: d.storyType, reason: 'the critic did not assess it', claimKeys: d.claimKeys });
      result = { scored: [...result.scored, ...again.scored], removed: [...result.removed, ...again.removed], unassessed: again.unassessed };
    } else {
      await this.steps.skip(retryStep);
    }
    removed.push(...result.removed);
    this.stats.removedByCritic += result.removed.length;
    const caveats = result.scored.filter((s) => s.support === 'NEEDS_CAVEAT').length;
    await this.ctx.progress(`Critic: ${result.scored.length} candidates scored (${caveats} need a caveat); ${result.removed.length} removed as unsupported`, {
      removed: result.removed.map((r) => `${r.title}: ${r.reason}`),
    });
    return result.scored;
  }

  private async critic(drafts: readonly DraftCandidate[], evidence: EvidenceBase): Promise<CriticOutput> {
    const { ctx, cfg } = this;
    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task: 'story.critic',
          schema: CriticOutput,
          schemaName: 'StoryAssessments',
          system: criticSystemPrompt(),
          messages: [
            {
              role: 'user',
              content: `Documentary: ${ctx.project.title} — ${ctx.project.topic}\n\nAssess each of these ${drafts.length} story candidates. Each is followed by the evidence of the claims it cites.\n\n${drafts.map((d) => renderCandidateForCritic(d, evidence)).join('\n\n')}`,
            },
          ],
          effort: cfg.effort.critic,
          maxTokens: cfg.maxTokens.critic,
          signal: ctx.signal,
        }),
      { request: { task: 'story.critic', candidates: drafts.length }, summarize: (x) => ({ assessments: x.object.assessments.length }) },
    );
    this.noteModel(r.meta.model);
    return r.object;
  }

  private async select(pool: readonly PackCandidate[], target: RuntimeTarget, editorNotes: string | null): Promise<SelectionOutput> {
    const { ctx, cfg } = this;
    const lines = pool.map((c) => {
      const editor = c.status !== 'PROPOSED' || c.priority !== 'NORMAL' ? ` [editor: ${c.status}${c.priority !== 'NORMAL' ? `, ${c.priority} priority` : ''}${c.editorNotes ? ` — ${c.editorNotes}` : ''}]` : '';
      const people = c.characters.map((ch) => ch.name).join(', ');
      return `${c.key} · rank ${c.rank} · score ${c.rankScore} · ${c.historicalStatus} ${c.historicalConfidence}/10 · ${c.storyType}${editor}\n   ${c.title} — ${c.hook}\n   ${c.timePeriod}; ${people}\n   viewer question: ${c.viewerQuestion}`;
    });
    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task: 'story.select',
          schema: SelectionOutput,
          schemaName: 'StorySelection',
          system: selectionSystemPrompt(target),
          messages: [
            {
              role: 'user',
              content: `Documentary: ${ctx.project.title} — ${ctx.project.topic}${editorNotes ? `\n\nThe editor's brief: ${editorNotes}` : ''}\n\nRanked story candidates:\n${lines.join('\n')}`,
            },
          ],
          effort: cfg.effort.select,
          maxTokens: cfg.maxTokens.select,
          signal: ctx.signal,
        }),
      { request: { task: 'story.select', candidates: pool.length }, summarize: (x) => ({ selected: x.object.selected.length }) },
    );
    this.noteModel(r.meta.model);
    return r.object;
  }

  // ── Previous pass ──────────────────────────────────────────────────────────

  private async loadPrior(dossierId: string, evidence: EvidenceBase): Promise<Prior | null> {
    const pack = await this.ctx.db.storyPack.findFirst({
      where: { projectId: this.ctx.project.id, dossierId, status: { not: 'DRAFT' } },
      orderBy: { version: 'desc' },
      include: { candidates: { orderBy: { rank: 'asc' }, include: { claims: { include: { claim: { select: { claimKey: true } } } } } } },
    });
    if (!pack) return null;
    const carried: PackCandidate[] = [];
    const rejected: Prior['rejected'] = [];
    for (const c of pack.candidates) {
      const claimKeys = [...evidence.claims.keys()].filter((k) => c.claims.some((x) => x.claim.claimKey === k));
      if (c.status === 'REJECTED') {
        rejected.push({ key: c.candidateKey, title: c.title, hook: c.hook, editorNotes: c.editorNotes, claimKeys });
        continue;
      }
      if (c.status !== 'APPROVED' && c.status !== 'FLAGGED') continue;
      const scores = StoryScores.safeParse(c.scores);
      const characters = z.array(StoryCharacter).safeParse(c.characters);
      const myth = c.mythThread === null ? { success: true as const, data: null } : MythThread.safeParse(c.mythThread);
      if (!scores.success || !characters.success || !myth.success || claimKeys.length === 0) {
        this.ctx.logger.warn({ candidateId: c.id }, 'carried-over candidate has invalid stored data; not carried');
        continue;
      }
      const confidence = historicalConfidenceOf(evidence.storyClaims(claimKeys));
      carried.push({
        title: c.title,
        hook: c.hook,
        storyType: c.storyType,
        characters: characters.data,
        setting: c.setting,
        timePeriod: c.timePeriod,
        desire: c.desire,
        conflict: c.conflict,
        stakes: c.stakes,
        escalation: c.escalation,
        turningPoint: c.turningPoint,
        payoff: c.payoff,
        whyInteresting: c.whyInteresting,
        viewerQuestion: c.viewerQuestion,
        mythThread: myth.data,
        claimKeys,
        notes: c.notes ? [c.notes] : [],
        historicalStatus: historicalStatusOf(claimKeys.map((k) => evidence.claim(k)!.verdict)),
        historicalConfidence: confidence,
        sourceIds: evidence.sourcesFor(claimKeys),
        scores: scores.data,
        rankScore: rankScore(scores.data.appeal, confidence),
        key: c.candidateKey,
        rank: c.rank,
        status: c.status,
        priority: c.priority,
        editorNotes: c.editorNotes,
        aiSelected: false,
        aiSelectionReason: null,
        carriedFrom: { packVersion: pack.version, key: c.candidateKey },
      });
    }
    return { version: pack.version, carried, rejected };
  }

  // ── Persist ────────────────────────────────────────────────────────────────

  private async persist(dossierId: string, evidence: EvidenceBase, pool: readonly PackCandidate[], content: StoryPackContent, report: QualityReport, editorNotes: string | null) {
    const { db, project, job } = this.ctx;
    const contentJson = StoryPackContent.parse(content);
    const reportJson = QualityReport.parse(report);
    return db.$transaction(
      async (tx) => {
        const last = await tx.storyPack.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' }, select: { version: true } });
        // A new pack replaces the pack and any architecture still open for review.
        await tx.storyPack.updateMany({ where: { projectId: project.id, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
        await tx.storyArchitecture.updateMany({ where: { projectId: project.id, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
        const pack = await tx.storyPack.create({
          data: {
            projectId: project.id,
            dossierId,
            version: (last?.version ?? 0) + 1,
            status: report.passed ? 'IN_REVIEW' : 'DRAFT',
            content: contentJson as unknown as Prisma.InputJsonValue,
            qualityReport: reportJson as unknown as Prisma.InputJsonValue,
            qualityPassed: report.passed,
            stats: this.stats as unknown as Prisma.InputJsonValue,
            notes: editorNotes,
            jobId: job.id,
          },
        });
        const rows = await tx.storyCandidate.createManyAndReturn({
          data: pool.map((c) => ({
            packId: pack.id,
            projectId: project.id,
            dossierId,
            candidateKey: c.key,
            title: c.title,
            hook: c.hook,
            storyType: c.storyType,
            characters: c.characters as unknown as Prisma.InputJsonValue,
            setting: c.setting,
            timePeriod: c.timePeriod,
            desire: c.desire,
            conflict: c.conflict,
            stakes: c.stakes,
            escalation: c.escalation,
            turningPoint: c.turningPoint,
            payoff: c.payoff,
            whyInteresting: c.whyInteresting,
            viewerQuestion: c.viewerQuestion,
            mythThread: c.mythThread ? (c.mythThread as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            scores: c.scores as unknown as Prisma.InputJsonValue,
            historicalStatus: c.historicalStatus,
            historicalConfidence: c.historicalConfidence,
            rankScore: c.rankScore,
            rank: c.rank,
            notes: c.notes.join('\n') || null,
            aiSelected: c.aiSelected,
            aiSelectionReason: c.aiSelectionReason,
            status: c.status,
            // The proposal is a starting point the editor changes freely.
            selected: c.aiSelected,
            priority: c.priority,
            editorNotes: c.editorNotes,
          })),
          select: { id: true, candidateKey: true },
        });
        const idByKey = new Map(rows.map((r) => [r.candidateKey, r.id]));
        await tx.storyCandidateClaim.createMany({
          data: pool.flatMap((c) => c.claimKeys.map((k) => ({ candidateId: idByKey.get(c.key)!, claimId: evidence.claim(k)!.id }))),
        });
        return pack;
      },
      { timeout: 60_000 },
    );
  }

  private noteModel(model: string | undefined) {
    if (model && !this.stats.models.includes(model)) this.stats.models.push(model);
  }
}

function toPackCandidate(s: ScoredCandidate): PackCandidate {
  const { ref: _ref, support: _support, ...rest } = s;
  return { ...rest, key: '', rank: 0, status: 'PROPOSED', priority: 'NORMAL', editorNotes: null, aiSelected: false, aiSelectionReason: null, carriedFrom: null };
}
