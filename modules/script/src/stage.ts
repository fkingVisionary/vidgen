import {
  CURRENT_SCRIPT_ENGINE,
  ScriptJobInput,
  StoryArchitectureContentV2,
  fmtClock,
  fmtVariance,
  runtimeTarget,
  scriptTiming,
  type RuntimeTarget,
  type ScriptContent,
  type ScriptIssue,
  type ScriptSectionPlan,
} from '@docengine/core';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError } from '@docengine/providers';
import { CostCeiling, EvidenceBase, StepCheckpoint } from '@docengine/story/shared';
import { z } from 'zod';
import { DEFAULT_SCRIPT_CONFIG, SCRIPT_STEPS, type ScriptConfig, type ScriptStep } from './config.ts';
import { allBlocks, applyPatch, applyPerformance, markCentralQuestion, mergePronunciations, sectionDurationSec, sectionWords, sectionsFromWriter, type ScriptDraft } from './draft.ts';
import { PROMPT_VERSION, factCheckSystemPrompt, performanceSystemPrompt, plannerSystemPrompt, rewriteSystemPrompt, scriptEditorSystemPrompt, writerSystemPrompt } from './prompts.ts';
import { computeScriptReport } from './quality.ts';
import { renderArchitecture, renderEvidence, renderScript } from './render.ts';
import { SCRIPT_BLOCKING, blockingCount, checkScript, type ScriptFinding } from './rules.ts';
import { FactCheckOutput, PerformanceOutput, PlannerOutput, ScriptEditorOutput, WriterOutput, type ScriptPatch } from './schemas.ts';
import { buildScope, type ScriptScope } from './scope.ts';
import { loadVersion, saveVersion, type LoadedScript } from './store.ts';

/**
 * SCRIPT stage (Script Engine 1.0). Turns the approved story architecture
 * into a structured spoken script — it does not reinterpret the research:
 *
 *   planner → writer → rules → script editor (+ patch) → rules
 *     → fact checker (+ patch) → rules → performance → gate → script vN
 *
 * A revision makes a new version from an earlier one: chosen sections are
 * rewritten (the others copied unchanged, no model calls for them), or the
 * whole script is rewritten from the editor's brief. Every version is kept.
 * The gate never stops a version reaching review: its blocking findings stop
 * approval until the editor fixes them. Nothing is approved here.
 */
export function createScriptStage(overrides: Partial<ScriptConfig> = {}): StageHandler {
  const cfg: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...overrides };
  return { type: 'SCRIPT', mock: false, run: (ctx) => new ScriptRun(ctx, cfg).run() };
}

const Unavailable = z.object({ unavailable: z.string() });
const EditStep = z.union([ScriptEditorOutput, Unavailable]);
const FactStep = z.union([FactCheckOutput, Unavailable]);
const PerformStep = z.union([PerformanceOutput, Unavailable]);

type Mode = 'DRAFT' | 'SECTIONS' | 'REVISION';

interface Architecture {
  id: string;
  version: number;
  dossierId: string;
  content: StoryArchitectureContentV2;
}

class ScriptRun {
  private readonly steps: StepCheckpoint<ScriptStep>;
  private readonly ceiling: CostCeiling;
  /** The model that served each step (as the provider reported it). */
  private readonly models: Partial<Record<ScriptStep, string>> = {};

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: ScriptConfig,
  ) {
    this.steps = new StepCheckpoint(ctx, SCRIPT_STEPS, PROMPT_VERSION);
    this.ceiling = new CostCeiling(ctx, cfg.maxCostUsd, 'Script generation');
  }

  async run(): Promise<Record<string, unknown>> {
    const { ctx } = this;
    const started = Date.now();
    const input = ScriptJobInput.parse(ctx.job.input ?? {});
    if (!(await this.steps.load())) await ctx.progress('Saved progress from another version of the script engine was ignored; starting again');

    const base = input.revise ? await loadVersion(ctx.db, ctx.project.id, input.revise.baseVersion) : null;
    if (input.revise && !base) throw new NonRetryableError(`Script v${input.revise.baseVersion} does not exist`);
    const arch = await this.architecture(base);
    const evidence = await EvidenceBase.load(ctx.db, arch.dossierId);
    const scope = buildScope({ architectureId: arch.id, architectureVersion: arch.version, architecture: arch.content, evidence });
    const target = runtimeTarget(ctx.project);
    const all = arch.content.sequences.map((s) => s.number);
    const mode: Mode = !input.revise ? 'DRAFT' : input.revise.sections.length ? 'SECTIONS' : 'REVISION';
    const written = mode === 'SECTIONS' ? input.revise!.sections : all;
    const unknown = written.filter((n) => !all.includes(n));
    if (unknown.length) throw new NonRetryableError(`Sections ${unknown.join(', ')} are not sequences of architecture v${arch.version}`);
    const brief = input.notes?.trim() || null;
    const allowed = new Set(written);
    const notes: string[] = [];

    await ctx.progress(
      mode === 'DRAFT'
        ? `Script draft from architecture v${arch.version}: ${all.length} sequences, ${scope.claims.length} claims; target ${fmtClock(target.targetSec)}`
        : `${mode === 'SECTIONS' ? `Rewriting section${written.length > 1 ? 's' : ''} ${written.join(', ')}` : 'Revising the whole script'} of script v${base!.row.version} from the editor's brief: "${clip(brief ?? '', 140)}"`,
      { architectureVersion: arch.version, mode, sections: written, brief, target },
    );

    // A. Plan (a section rewrite keeps the base version's plan).
    let plans = new Map<number, ScriptSectionPlan>(base ? base.draft.sections.flatMap((s) => (s.plan ? [[s.sequence, s.plan] as const] : [])) : []);
    let narrator = base?.content?.narrator ?? { persona: '', tone: '', approach: '' };
    if (mode === 'SECTIONS') await this.steps.skip('plan');
    else {
      await this.ceiling.check();
      const plan = await this.steps.step('plan', PlannerOutput, () => this.plan(scope, target, brief, base));
      plans = new Map(plan.sections.filter((p) => all.includes(p.sequence)).map((p) => [p.sequence, { purpose: p.purpose, approach: p.approach, showNotSay: p.showNotSay, exposition: p.exposition, tension: p.tension, reveal: p.reveal, sparse: p.sparse, targetSec: Math.max(0, p.targetSec) }]));
      narrator = plan.narrator;
      notes.push(...plan.notes.map((n) => `Planner: ${n}`));
    }

    // B. Write (or rewrite the chosen sections; the others are copied unchanged).
    await this.ceiling.check();
    const writerOut = await this.steps.step('write', WriterOutput, () => (mode === 'SECTIONS' ? this.rewrite(scope, target, base!, written, brief, plans) : this.write(scope, target, brief, plans, narrator, base)));
    let draft = this.assemble(writerOut, scope, base, written, plans, notes);
    const draftFindings = checkScript(draft, scope, { target });
    await ctx.progress(`Script ${mode === 'DRAFT' ? 'draft' : 'rewrite'}: ${allBlocks(draft).length} blocks, ${allBlocks(draft).reduce((n, b) => n + b.wordCount, 0)} words, ~${fmtClock(scriptTiming(allBlocks(draft), target).totalSec)}; ${blockingCount(draftFindings)} blocking findings`, {
      findings: draftFindings.filter((f) => SCRIPT_BLOCKING.includes(f.kind)).map((f) => f.detail).slice(0, 30),
    });

    // C. Script editor (craft).
    await this.ceiling.check();
    const edited = await this.steps.step('edit', EditStep, () => this.unavailableOnError(() => this.call('edit', 'script.edit', ScriptEditorOutput, 'ScriptEditorReview', scriptEditorSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief), (x) => ({ issues: x.issues.length, edits: x.edits.length }))));
    let editor: ScriptContent['editor'] = null;
    if ('unavailable' in edited) notes.push(`Script editor unavailable: ${edited.unavailable}`);
    else {
      const r = this.tryPatch(draft, edited, scope, target, allowed, 'Script editor', notes);
      draft = r.draft;
      editor = { verdict: edited.verdict, scores: edited.scores, issues: edited.issues.map((i) => ({ ...i, ...resolve(i.ref, r) })) };
    }

    // D. Fact checker (last word on facts).
    await this.ceiling.check();
    const checked = await this.steps.step('factCheck', FactStep, () => this.unavailableOnError(() => this.call('factCheck', 'script.factCheck', FactCheckOutput, 'ScriptFactCheck', factCheckSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief), (x) => ({ issues: x.issues.length, edits: x.edits.length }))));
    let factCheck: ScriptContent['factCheck'] = null;
    if ('unavailable' in checked) notes.push(`Fact checker unavailable: ${checked.unavailable}`);
    else {
      const r = this.tryPatch(draft, checked, scope, target, allowed, 'Fact checker', notes);
      draft = r.draft;
      factCheck = { verdict: checked.verdict, issues: checked.issues.map((i) => ({ ...i, ...resolve(i.ref, r) })) };
      // The editor's issue references now point at the fact checker's numbering too.
      if (editor && r.kept) editor = { ...editor, issues: editor.issues.map((i) => (i.ref && r.keyMap.has(i.ref) ? { ...i, ref: r.keyMap.get(i.ref) ?? i.ref } : i)) };
    }

    // E. Performance: delivery where it matters, pauses with a reason, pronunciation.
    await this.ceiling.check();
    const perf = await this.steps.step('perform', PerformStep, () => this.unavailableOnError(() => this.perform(draft, scope, allowed)));
    if ('unavailable' in perf) notes.push(`Performance pass unavailable: ${perf.unavailable}`);
    else {
      draft = applyPerformance(draft, perf, scope, allowed, notes);
      notes.push(...perf.notes.map((n) => `Performance: ${n}`));
    }

    // The gate, the content, the new version.
    const posed = allBlocks(draft).find((b) => b.centralQuestion === 'POSED')?.key ?? null;
    const answered = allBlocks(draft).find((b) => b.centralQuestion === 'ANSWERED')?.key ?? null;
    const content: ScriptContent = {
      engineVersion: CURRENT_SCRIPT_ENGINE,
      architecture: { id: arch.id, version: arch.version },
      narrator,
      centralQuestion: { text: arch.content.centralQuestion, posedIn: posed, answeredIn: answered },
      pronunciations: draft.pronunciations,
      performanceNotes: 'unavailable' in perf ? [] : perf.notes,
      editor,
      factCheck,
      provenance: {
        origin: mode,
        baseVersion: base?.row.version ?? null,
        baseId: base?.row.id ?? null,
        sections: written,
        brief,
        requestedBy: (await this.requester()) ?? null,
        changeLog: writerOut.changeLog,
      },
    };
    const findings = checkScript(draft, scope, { target, factIssues: factCheck?.issues });
    const timing = scriptTiming(allBlocks(draft), target);
    const report = computeScriptReport({ findings, timing, content, notes, reviewers: { editor: 'unavailable' in edited ? edited.unavailable : null, factCheck: 'unavailable' in checked ? checked.unavailable : null } });
    const stats = {
      engineVersion: CURRENT_SCRIPT_ENGINE,
      promptVersion: PROMPT_VERSION,
      architectureVersion: arch.version,
      dossierVersion: evidence.dossierVersion,
      mode,
      sectionsWritten: written,
      models: this.models,
      blocks: allBlocks(draft).length,
      words: timing.words,
      durationSec: timing.totalSec,
      targetSec: timing.targetSec,
      varianceSec: timing.varianceSec,
      classes: countBy(allBlocks(draft).map((b) => b.infoClass)),
      draftBlockingFindings: blockingCount(draftFindings),
      blockingFindings: blockingCount(findings),
      warnings: findings.length - blockingCount(findings),
      editorIssues: editor?.issues.length ?? null,
      factIssues: factCheck?.issues.length ?? null,
      pronunciations: draft.pronunciations.length,
      resumedSteps: [...this.steps.reused],
      durationMs: Date.now() - started,
    };
    const claimIds = new Map([...scope.claims].map((k) => [k, evidence.claim(k)!.id]));
    const saved = await ctx.db.$transaction((tx) =>
      saveVersion(tx, {
        projectId: ctx.project.id,
        languageVersionId: ctx.languageVersion.id,
        architectureId: arch.id,
        dossierClaimIds: claimIds,
        jobId: ctx.job.id,
        revisionOfId: base?.row.id ?? null,
        notes: brief,
        draft,
        content,
        report,
        stats,
        targetDurationSec: target.targetSec,
        status: 'IN_REVIEW',
      }),
    );
    await this.steps.clear();

    const spend = await this.spent();
    const failed = report.checks.filter((c) => c.status === 'FAIL');
    const warned = report.checks.filter((c) => c.status === 'WARN');
    await ctx.progress(
      `Script v${saved.version}${base ? ` (from v${base.row.version})` : ''} saved for review: ${draft.sections.length} sections, ${timing.words} words, ${fmtClock(timing.totalSec)} against a target of ${fmtClock(timing.targetSec)} (${fmtVariance(timing.varianceSec)}) — quality gate ${report.passed ? 'PASSED' : `FAILED (${failed.map((c) => c.id).join(', ')}): approval is blocked until fixed`}`,
      {
        scriptId: saved.id,
        version: saved.version,
        superseded: saved.superseded,
        architectureVersion: arch.version,
        words: timing.words,
        durationSec: timing.totalSec,
        targetSec: timing.targetSec,
        varianceSec: timing.varianceSec,
        sections: draft.sections.map((s) => `${s.sequence}. ${s.title}: ${s.blocks.length} blocks, ${sectionWords(s)} words, ${fmtClock(sectionDurationSec(s))}${s.written ? '' : ' (copied)'}`),
        classes: stats.classes,
        failedChecks: failed.map((c) => `${c.id}: ${c.detail}`),
        warnings: warned.map((c) => `${c.id}: ${c.detail}`),
        editorScores: editor ? Object.fromEntries(Object.entries(editor.scores).map(([k, v]) => [k, v.score])) : null,
        factIssues: factCheck?.issues.map((i) => `${i.severity} ${i.ref ?? ''} ${i.kind}: ${i.note} [${i.resolution}]`) ?? null,
        pronunciations: draft.pronunciations.map((p) => `${p.term} = ${p.respelling} (${p.confidence})`),
        models: this.models,
        estimatedCostUsd: spend,
        resumedSteps: stats.resumedSteps,
      },
    );
    return { scriptId: saved.id, version: saved.version, qualityPassed: report.passed, words: timing.words, durationSec: timing.totalSec, sections: draft.sections.length, mode, ...(base ? { revisionOf: base.row.version } : {}), estimatedCostUsd: spend };
  }

  /** The architecture to tell: the approved one; a revision keeps its base version's (which must still be the approved one). */
  private async architecture(base: LoadedScript | null): Promise<Architecture> {
    const { db, project } = this.ctx;
    const approved = await db.storyArchitecture.findFirst({ where: { projectId: project.id, status: 'APPROVED' }, orderBy: { version: 'desc' } });
    if (!approved) throw new NonRetryableError('No approved story architecture: approve one at the Story gate first');
    if (approved.engineVersion !== 2) throw new NonRetryableError(`Architecture v${approved.version} was built by story engine 1; the script engine needs a Story Engine 2.0 architecture`);
    if (base && base.row.storyId !== approved.id) {
      const told = base.row.storyId ? await db.storyArchitecture.findUnique({ where: { id: base.row.storyId }, select: { version: true } }) : null;
      throw new NonRetryableError(`Script v${base.row.version} tells architecture v${told?.version ?? '?'}, which is no longer the approved architecture (v${approved.version}): generate a new draft instead`);
    }
    const content = StoryArchitectureContentV2.safeParse(approved.content);
    if (!content.success) throw new NonRetryableError(`Architecture v${approved.version} could not be read`);
    if (!approved.dossierId) throw new NonRetryableError(`Architecture v${approved.version} has no research dossier`);
    return { id: approved.id, version: approved.version, dossierId: approved.dossierId, content: content.data };
  }

  /** Copy the base's sections that are not rewritten; take the rest from the writer. */
  private assemble(out: WriterOutput, scope: ScriptScope, base: LoadedScript | null, written: readonly number[], plans: ReadonlyMap<number, ScriptSectionPlan>, notes: string[]): ScriptDraft {
    const fresh = sectionsFromWriter(out, scope, written, plans, notes);
    if (!base) return { sections: fresh, pronunciations: [] };
    const sections = scope.architecture.sequences.map((seq) => {
      const mine = fresh.find((s) => s.sequence === seq.number);
      if (mine) return mine;
      const copied = base.draft.sections.find((s) => s.sequence === seq.number);
      return copied ? { ...copied, blocks: copied.blocks.map((b) => ({ ...b })), written: false } : { ...fresh[0]!, sequence: seq.number, blocks: [], written: false };
    });
    // The base's central-question blocks stay flagged unless the rewrite moved them.
    const draft = { sections, pronunciations: mergePronunciations(base.draft.pronunciations, []) };
    markCentralQuestion(draft.sections, out.centralQuestion, notes);
    return draft;
  }

  /** Keep a reviewer's patch only if the rules find no more blocking problems after it. */
  private tryPatch(draft: ScriptDraft, patch: ScriptPatch, scope: ScriptScope, target: RuntimeTarget, allowed: ReadonlySet<number>, who: string, notes: string[]): Patched {
    const identity: Patched = { draft, kept: false, keyMap: new Map(allBlocks(draft).map((b) => [b.key, b.key])), touched: new Set() };
    if (patch.edits.length + patch.removals.length + patch.insertions.length === 0) return identity;
    const before = blockingCount(checkScript(draft, scope, { target }));
    const local: string[] = [];
    const r = applyPatch(draft, patch, scope, allowed, who, local);
    if (r.changed === 0) {
      notes.push(...local);
      return identity;
    }
    const after = blockingCount(checkScript(r.draft, scope, { target }));
    if (after > before) {
      notes.push(`${who}: its ${r.changed} change(s) were not kept — they left ${after} blocking findings, against ${before} before`);
      return identity;
    }
    notes.push(...local, `${who}: ${r.changed} change(s) kept (blocking findings ${before} → ${after})`);
    const touched = new Set([...patch.edits.map((e) => e.ref), ...patch.removals].map((x) => x.trim()));
    return { draft: r.draft, kept: true, keyMap: r.keyMap, touched };
  }

  // ── Model calls ────────────────────────────────────────────────────────────

  private header(target: RuntimeTarget): string {
    const p = this.ctx.project;
    return [`Documentary: ${p.title} — ${p.topic}`, `Target runtime: about ${fmtClock(target.targetSec)} of narration (acceptable ${fmtClock(target.minSec)}–${fmtClock(target.maxSec)}).`].join('\n');
  }

  private async plan(scope: ScriptScope, target: RuntimeTarget, brief: string | null, base: LoadedScript | null): Promise<PlannerOutput> {
    const parts = [this.header(target)];
    if (brief) parts.push('', `# The editor's brief for this version (follow it)\n${brief}`);
    if (base) parts.push('', `# The current script (v${base.row.version}) — the version to improve`, renderScript(base.draft));
    parts.push('', renderArchitecture(scope), '', renderEvidence(scope));
    return this.call('plan', 'script.plan', PlannerOutput, 'ScriptPlan', plannerSystemPrompt(target), parts.join('\n'), (x) => ({ sections: x.sections.length }));
  }

  private renderPlan(plans: ReadonlyMap<number, ScriptSectionPlan>, narrator: ScriptContent['narrator']): string {
    const lines = ['# The plan', `Narrator: ${narrator.persona} — ${narrator.tone}. ${narrator.approach}`];
    for (const [n, p] of [...plans.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`## Section ${n} (${fmtClock(p.targetSec)}${p.sparse ? ', sparse narration' : ''})`, `purpose: ${p.purpose}`, `approach: ${p.approach}`, `show, not say: ${p.showNotSay.join('; ') || '—'}`, `exposition: ${p.exposition.join('; ') || '—'}`, `tension: ${p.tension} | reveal: ${p.reveal}`);
    }
    return lines.join('\n');
  }

  private async write(scope: ScriptScope, target: RuntimeTarget, brief: string | null, plans: ReadonlyMap<number, ScriptSectionPlan>, narrator: ScriptContent['narrator'], base: LoadedScript | null): Promise<WriterOutput> {
    const parts = [this.header(target)];
    if (brief) parts.push('', `# The editor's brief for this version (answer it)\n${brief}`);
    if (base) parts.push('', `# The current script (v${base.row.version}) — rewrite it as a whole; keep what works`, renderScript(base.draft));
    parts.push('', this.renderPlan(plans, narrator), '', renderArchitecture(scope), '', renderEvidence(scope));
    return this.call('write', 'script.write', WriterOutput, 'DocumentaryScript', writerSystemPrompt(target), parts.join('\n'), summarizeWriter);
  }

  private async rewrite(scope: ScriptScope, target: RuntimeTarget, base: LoadedScript, sections: readonly number[], brief: string | null, plans: ReadonlyMap<number, ScriptSectionPlan>): Promise<WriterOutput> {
    const notes = base.draft.sections.filter((s) => sections.includes(s.sequence) && (s.editorNotes || s.reviewStatus === 'REJECTED')).map((s) => `- Section ${s.sequence}${s.reviewStatus === 'REJECTED' ? ' (rejected by the editor)' : ''}: ${s.editorNotes ?? 'no note'}`);
    const parts = [
      this.header(target),
      '',
      `# Rewrite section${sections.length > 1 ? 's' : ''} ${sections.join(', ')} of script v${base.row.version}; every other section stays exactly as it is`,
      brief ? `The editor's brief: ${brief}` : 'No brief: improve what the editor marked.',
      ...(notes.length ? ["The editor's notes on these sections:", ...notes] : []),
      '',
      `# Script v${base.row.version} (all sections, for the joins)`,
      renderScript(base.draft),
      '',
      this.renderPlan(new Map([...plans].filter(([n]) => sections.includes(n))), base.content?.narrator ?? { persona: '', tone: '', approach: '' }),
      '',
      renderArchitecture(scope),
      '',
      renderEvidence(scope),
    ];
    return this.call('write', 'script.rewrite', WriterOutput, 'DocumentaryScript', rewriteSystemPrompt(target), parts.join('\n'), summarizeWriter);
  }

  /** What a reviewer sees: the script (the sections it may change in full), the rule findings, the architecture and the evidence. */
  private reviewPrompt(draft: ScriptDraft, scope: ScriptScope, target: RuntimeTarget, allowed: ReadonlySet<number>, brief: string | null): string {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const inScope = (f: ScriptFinding) => f.ref === null || only === undefined || [...only].some((n) => f.ref!.startsWith(`${n}.`) || f.ref === `S${n}`);
    const findings = checkScript(draft, scope, { target }).filter(inScope);
    return [
      this.header(target),
      ...(brief ? ['', `# The editor's brief for this version\n${brief}`] : []),
      '',
      `# The script${only ? ` — review and change only section${only.size > 1 ? 's' : ''} ${[...only].join(', ')}` : ''}`,
      renderScript(draft, { only }),
      '',
      `# What the automated rules found (${findings.length}; blocking ones must be fixed)`,
      ...(findings.length ? findings.slice(0, 60).map((f) => `- ${SCRIPT_BLOCKING.includes(f.kind) ? 'BLOCKING' : 'warning'} ${f.kind}: ${f.detail}`) : ['- nothing']),
      '',
      renderArchitecture(scope),
      '',
      renderEvidence(scope),
    ].join('\n');
  }

  /** A reviewer or the performance pass that cannot run (a permanent provider error) is reported, not fatal. */
  private async unavailableOnError<T>(fn: () => Promise<T>): Promise<T | { unavailable: string }> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) return { unavailable: err.message };
      throw err;
    }
  }

  private async perform(draft: ScriptDraft, scope: ScriptScope, allowed: ReadonlySet<number>): Promise<PerformanceOutput> {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const parts = [
      `Documentary: ${this.ctx.project.title} — ${this.ctx.project.topic}`,
      `Narrator: ${scope.architecture.narrativeMode}; point of view ${scope.architecture.povStrategy.type}.`,
      `Cast: ${scope.architecture.cast.map((m) => `${m.name} (${m.kind})`).join('; ')}`,
      '',
      `# The script${only ? ` — mark only section${only.size > 1 ? 's' : ''} ${[...only].join(', ')}` : ''}`,
      renderScript(draft, { only }),
    ];
    return this.call('perform', 'script.perform', PerformanceOutput, 'ScriptPerformance', performanceSystemPrompt(), parts.join('\n'), (x) => ({ blocks: x.blocks.length, pronunciations: x.pronunciations.length }));
  }

  private async call<T>(step: ScriptStep, task: string, schema: z.ZodType<T>, schemaName: string, system: string, content: string, summarize: (x: T) => Record<string, unknown>): Promise<T> {
    const { ctx, cfg } = this;
    const r = await ctx.callProvider(
      'ai',
      'generateObject',
      () =>
        ctx.providers.ai.generateObject({
          task,
          schema,
          schemaName,
          system,
          messages: [{ role: 'user', content }],
          effort: cfg.effort[step],
          maxTokens: cfg.maxTokens[step],
          ...(cfg.models[step] ? { model: cfg.models[step] } : {}),
          signal: ctx.signal,
        }),
      { request: { task, step }, summarize: (x) => summarize(x.object) },
    );
    this.models[step] = r.meta.model;
    return r.object;
  }

  private async requester(): Promise<string | null> {
    const ev = await this.ctx.db.projectEvent.findFirst({ where: { jobId: this.ctx.job.id, type: 'JOB_QUEUED' }, orderBy: { createdAt: 'asc' }, select: { data: true } });
    const actor = (ev?.data as { actor?: unknown } | null)?.actor;
    return typeof actor === 'string' ? actor : null;
  }

  private async spent(): Promise<number> {
    const [row] = await this.ctx.db.$queryRaw<{ spent: string | null }[]>`
      SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd))::text AS spent FROM provider_calls WHERE job_id = ${this.ctx.job.id}::uuid`;
    return Math.round(Number(row?.spent ?? 0) * 10_000) / 10_000;
  }
}

interface Patched {
  draft: ScriptDraft;
  kept: boolean;
  keyMap: Map<string, string | null>;
  /** References the reviewer changed or removed. */
  touched: Set<string>;
}

/** Where a reviewer's issue stands after its own patch. */
function resolve(ref: string | null, r: Patched): Pick<ScriptIssue, 'ref' | 'resolution'> {
  if (!ref) return { ref: null, resolution: r.kept ? 'recorded' : 'open: left for the editor' };
  const now = r.keyMap.has(ref) ? r.keyMap.get(ref)! : ref;
  if (r.kept && r.touched.has(ref)) return { ref: now, resolution: now === null ? 'fixed: the block was removed' : 'fixed by its own edit' };
  return { ref: now ?? ref, resolution: 'open: left for the editor' };
}

function summarizeWriter(x: WriterOutput): Record<string, unknown> {
  return { sections: x.sections.length, blocks: x.sections.reduce((n, s) => n + s.blocks.length, 0) };
}

function countBy(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type { ScriptFinding };
