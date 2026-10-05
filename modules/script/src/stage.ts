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
import { compareDrafts, evidenceChanges } from './compare.ts';
import { allBlocks, applyPatch, applyPerformance, markCentralQuestion, mergePronunciations, sectionDurationSec, sectionWords, sectionsFromWriter, type ScriptDraft } from './draft.ts';
import { PROMPT_VERSION, REFINEMENT_CHECKLIST, factCheckSystemPrompt, performanceSystemPrompt, plannerSystemPrompt, refineSystemPrompt, rewriteSystemPrompt, scriptEditorSystemPrompt, writerSystemPrompt } from './prompts.ts';
import { renderTrimPlan, selfReportMismatch, type Refrain } from './craft.ts';
import { computeScriptReport } from './quality.ts';
import { renderArchitecture, renderEvidence, renderScript } from './render.ts';
import { CRAFT_KINDS, blockingCount, checkScript, cutPlan, isBlocking, ruleDigest, type RuleDigest, type ScriptFinding, type ScriptFindingKind } from './rules.ts';
import { FactCheckOutput, PerformanceOutput, PlannerOutput, RefineOutput, ScriptEditorOutput, WriterOutput, type ScriptPatch } from './schemas.ts';
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
 * rewritten (the others copied unchanged, no model calls for them), the
 * whole script is rewritten from the editor's brief, or — a narrative
 * refinement — the whole script's telling is rewritten for the ear with its
 * story, structure, classes and evidence unchanged (no planner; the script
 * editor answers the refinement checklist against the version refined).
 * Every version is kept.
 * The script quality rules (craft.ts) — redundancy, passenger facts, pacing,
 * spoken syntax, meta-narration, introductions, evidence for what is said
 * about a person, deliberate repetition — are shown to the refiner and every
 * reviewer; a version over its maximum comes with a ranked cut plan for the
 * script editor. The job log records what the rules find in the version a
 * run starts from, the versions it replaces and the one it makes.
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

type Mode = 'DRAFT' | 'SECTIONS' | 'REVISION' | 'REFINEMENT';

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
    const mode: Mode = !input.revise ? 'DRAFT' : input.revise.refine ? 'REFINEMENT' : input.revise.sections.length ? 'SECTIONS' : 'REVISION';
    const written = mode === 'SECTIONS' ? input.revise!.sections : all;
    const unknown = written.filter((n) => !all.includes(n));
    if (unknown.length) throw new NonRetryableError(`Sections ${unknown.join(', ')} are not sequences of architecture v${arch.version}`);
    const brief = input.notes?.trim() || null;
    const allowed = new Set(written);
    const notes: string[] = [];

    await ctx.progress(
      mode === 'DRAFT'
        ? `Script draft from architecture v${arch.version}: ${all.length} sequences, ${scope.claims.length} claims; target ${fmtClock(target.targetSec)}`
        : mode === 'REFINEMENT'
          ? `Refining the narration of script v${base!.row.version} for the ear (story, structure and evidence unchanged) — ${brief ? `with the director's instructions: "${clip(brief, 140)}"` : 'the house style, no director\'s instructions'}`
          : `${mode === 'SECTIONS' ? `Rewriting section${written.length > 1 ? 's' : ''} ${written.join(', ')}` : 'Revising the whole script'} of script v${base!.row.version} from the editor's brief: "${clip(brief ?? '', 140)}"`,
      { architectureVersion: arch.version, mode, sections: written, brief, target },
    );
    const baseDigest = base ? ruleDigest(base.draft, scope, { target }) : null;
    if (base && baseDigest) await ctx.progress(`Script quality rules on v${base.row.version}: ${digestLine(baseDigest)}`, { version: base.row.version, rules: baseDigest });

    // A. Plan (a section rewrite and a refinement keep the base version's plan).
    let plans = new Map<number, ScriptSectionPlan>(base ? base.draft.sections.flatMap((s) => (s.plan ? [[s.sequence, s.plan] as const] : [])) : []);
    let narrator = base?.content?.narrator ?? { persona: '', tone: '', approach: '' };
    if (mode === 'SECTIONS' || mode === 'REFINEMENT') await this.steps.skip('plan');
    else {
      await this.ceiling.check();
      const plan = await this.steps.step('plan', PlannerOutput, () => this.plan(scope, target, brief, base));
      plans = new Map(plan.sections.filter((p) => all.includes(p.sequence)).map((p) => [p.sequence, { purpose: p.purpose, approach: p.approach, showNotSay: p.showNotSay, exposition: p.exposition, tension: p.tension, reveal: p.reveal, sparse: p.sparse, targetSec: Math.max(0, p.targetSec) }]));
      narrator = plan.narrator;
      notes.push(...plan.notes.map((n) => `Planner: ${n}`));
    }

    // B. Write (or rewrite the chosen sections, the others copied unchanged; or refine the whole telling).
    await this.ceiling.check();
    const writerOut: WriterOutput & { keptLines?: string[] } =
      mode === 'REFINEMENT'
        ? await this.steps.step('write', RefineOutput, () => this.refine(scope, target, base!, brief, plans))
        : await this.steps.step('write', WriterOutput, () => (mode === 'SECTIONS' ? this.rewrite(scope, target, base!, written, brief, plans) : this.write(scope, target, brief, plans, narrator, base)));
    let draft = this.assemble(writerOut, scope, base, written, plans, notes, mode === 'REFINEMENT');
    const keptLines = mode === 'REFINEMENT' ? (writerOut.keptLines ?? []).map((l) => l.trim()).filter(Boolean) : [];
    // Models misjudge the length of what they wrote: the system measures it, and says so when the change log is wrong.
    const misstated = writerOut.changeLog ? selfReportMismatch([writerOut.changeLog.summary, ...writerOut.changeLog.changes.map((c) => `${c.what} ${c.why}`)].join('\n'), scriptTiming(allBlocks(draft), target)) : null;
    if (misstated) notes.push(`Length: ${misstated} — the measured length is the one that counts`);
    const draftFindings = checkScript(draft, scope, { target });
    await ctx.progress(`Script ${mode === 'DRAFT' ? 'draft' : mode === 'REFINEMENT' ? 'refinement' : 'rewrite'}: ${allBlocks(draft).length} blocks, ${allBlocks(draft).reduce((n, b) => n + b.wordCount, 0)} words, ~${fmtClock(scriptTiming(allBlocks(draft), target).totalSec)}; ${blockingCount(draftFindings)} blocking findings`, {
      findings: draftFindings.filter(isBlocking).map((f) => f.detail).slice(0, 30),
    });

    // C. Script editor (craft).
    await this.ceiling.check();
    const refined = mode === 'REFINEMENT' ? base! : null;
    const edited = await this.steps.step('edit', EditStep, () =>
      this.unavailableOnError(() =>
        this.call('edit', 'script.edit', ScriptEditorOutput, 'ScriptEditorReview', scriptEditorSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief, { previous: refined, base: base?.draft ?? null, checklist: refined !== null, cuts: true, kept: keptLines }), (x) => ({ issues: x.issues.length, edits: x.edits.length, assessment: x.assessment.length })),
      ),
    );
    let editor: ScriptContent['editor'] = null;
    if ('unavailable' in edited) notes.push(`Script editor unavailable: ${edited.unavailable}`);
    else {
      const r = this.tryPatch(draft, edited, scope, target, allowed, 'Script editor', notes);
      draft = r.draft;
      editor = { verdict: edited.verdict, scores: edited.scores, issues: edited.issues.map((i) => ({ ...i, ...resolve(i.ref, r) })), ...(refined ? { assessment: checklistAnswers(edited.assessment, notes) } : {}) };
    }

    // D. Fact checker (last word on facts).
    await this.ceiling.check();
    const checked = await this.steps.step('factCheck', FactStep, () =>
      this.unavailableOnError(() => this.call('factCheck', 'script.factCheck', FactCheckOutput, 'ScriptFactCheck', factCheckSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief, { previous: null, checklist: false, refinementOf: refined?.row.version }), (x) => ({ issues: x.issues.length, edits: x.edits.length }))),
    );
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
    const perf = await this.steps.step('perform', PerformStep, () => this.unavailableOnError(() => this.perform(draft, scope, allowed, target)));
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
        changeLog: mode === 'REFINEMENT' ? { ...writerOut.changeLog, kept: keptLines } : writerOut.changeLog,
      },
    };
    const findings = checkScript(draft, scope, { target, factIssues: factCheck?.issues, previous: base?.draft ?? null, kept: keptLines });
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

    // The quality rules on the version made, the version it came from and the versions it replaces.
    const digests: Record<string, RuleDigest> = {};
    if (base && baseDigest) digests[`v${base.row.version}`] = baseDigest;
    for (const v of saved.superseded.filter((x) => x !== base?.row.version)) {
      const old = await loadVersion(ctx.db, ctx.project.id, v);
      if (old?.content?.architecture.id === arch.id) digests[`v${v}`] = ruleDigest(old.draft, scope, { target });
    }
    const made = ruleDigest(draft, scope, { target, previous: base?.draft ?? null, kept: keptLines });
    digests[`v${saved.version}`] = made;
    await ctx.progress(
      base && baseDigest ? `Script quality rules, v${base.row.version} → v${saved.version}: ${digestChange(baseDigest, made)}` : `Script quality rules on v${saved.version}: ${digestLine(made)}`,
      { rules: digests },
    );
    const spend = await this.spent();
    const failed = report.checks.filter((c) => c.status === 'FAIL');
    const warned = report.checks.filter((c) => c.status === 'WARN');
    const comparison = base && mode === 'REFINEMENT' ? refinementSummary(base, draft, content, spend) : null;
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
        ...(comparison ? { comparison } : {}),
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

  /**
   * Copy the base's sections that are not rewritten; take the rest from the
   * writer. A refinement that returns a section empty keeps that section as
   * it was (noted), rather than losing it.
   */
  private assemble(out: WriterOutput, scope: ScriptScope, base: LoadedScript | null, written: readonly number[], plans: ReadonlyMap<number, ScriptSectionPlan>, notes: string[], refinement = false): ScriptDraft {
    const fresh = sectionsFromWriter(out, scope, written, plans, notes);
    if (!base) return { sections: fresh, pronunciations: [] };
    const sections = scope.architecture.sequences.map((seq) => {
      const mine = fresh.find((s) => s.sequence === seq.number);
      const kept = refinement && mine && mine.blocks.length === 0 ? base.draft.sections.find((s) => s.sequence === seq.number) : undefined;
      if (kept?.blocks.length) {
        notes.push(`The refinement returned section ${seq.number} empty; it is kept as it was in v${base.row.version}`);
        return { ...kept, blocks: kept.blocks.map((b) => ({ ...b })), written: false };
      }
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

  /**
   * A narrative refinement: the whole script's telling rewritten for the ear
   * from the base version. The system prompt carries the complete house style
   * and the order of precedence; this prompt follows that order — what the
   * reviewers and the rules said about the base (4), the script, plan,
   * architecture and evidence it must keep to (3), and last the director's
   * optional instructions and section notes (5). Without them the house style
   * applies in full.
   */
  private async refine(scope: ScriptScope, target: RuntimeTarget, base: LoadedScript, instructions: string | null, plans: ReadonlyMap<number, ScriptSectionPlan>): Promise<RefineOutput> {
    const v = base.row.version;
    const timing = scriptTiming(allBlocks(base.draft), target);
    const sectionNotes = base.draft.sections.filter((s) => s.editorNotes || s.reviewStatus === 'REJECTED').map((s) => `- Section ${s.sequence}${s.reviewStatus === 'REJECTED' ? ' (rejected by the editor)' : ''}: ${s.editorNotes ?? 'no note'}`);
    const editor = base.content?.editor;
    const factCheck = base.content?.factCheck;
    const findings = checkScript(base.draft, scope, { target, factIssues: factCheck?.issues }).filter((f) => f.kind !== 'RUNTIME_PLAN');
    const { text: cuts, refrains } = cutPlan(base.draft, scope, { target, kept: base.content?.provenance.changeLog?.kept ?? [] });
    const parts = [
      this.header(target),
      `Script v${v} runs ${fmtClock(timing.totalSec)} (${timing.words} spoken words).`,
      '',
      `# Refine the narration of script v${v} — every section; its story, order, evidence and information classes stay as they are`,
      '',
      `# What the reviewers and the checks said about v${v} (rank 4)`,
      ...(editor
        ? [
            '## The script editor',
            editor.verdict,
            ...Object.entries(editor.scores).map(([k, x]) => `- ${k}: ${x!.score}/10 — ${x!.why}`),
            ...editor.issues.map((i) => `- ${i.severity} ${i.kind}${i.ref ? ` at ${i.ref}` : ''}: ${i.note} [${i.resolution}]`),
          ]
        : ['## The script editor', 'No review.']),
      ...(factCheck ? ['## The fact checker (do not reintroduce what it fixed)', factCheck.verdict, ...factCheck.issues.map((i) => `- ${i.severity} ${i.kind}${i.ref ? ` at ${i.ref}` : ''}: ${i.note} [${i.resolution}]`)] : ['## The fact checker', 'No review.']),
      `## The automated checks (${findings.length}; the script quality rules among them point at the weak material to cut or rework)`,
      ...renderFindings(findings, 90),
      ...(refrains.length ? [`## Deliberate repetition in v${v} — keep it: it is not redundancy`, ...renderRepetition(refrains)] : []),
      cuts ? `## The runtime — v${v} runs over its maximum: bring it inside, cutting from this plan first and never what it protects\n${cuts}` : `## The runtime — v${v} is within the acceptable range (${fmtClock(target.minSec)}–${fmtClock(target.maxSec)}): keep it there`,
      '',
      `# Script v${v} — the text to refine (each block with its class, beats, claims and speaker)`,
      renderScript(base.draft),
      '',
      this.renderPlan(plans, base.content?.narrator ?? { persona: '', tone: '', approach: '' }),
      '',
      renderArchitecture(scope),
      '',
      renderEvidence(scope),
      '',
      "# The director's instructions (rank 5: they may steer style, emphasis, pacing and creative direction; never parts 1 and 3)",
      instructions ?? 'None. Apply the refinement style in full.',
      ...(sectionNotes.length ? ["The director's notes on sections:", ...sectionNotes] : []),
    ];
    return this.call('write', 'script.refine', RefineOutput, 'RefinedScript', refineSystemPrompt(target), parts.join('\n'), (x) => ({ ...summarizeWriter(x), keptLines: x.keptLines.length }));
  }

  /**
   * What a reviewer sees: the script (the sections it may change in full),
   * the rule findings, the architecture and the evidence — and, for a
   * refinement's script editor, the version refined and the checklist.
   */
  private reviewPrompt(
    draft: ScriptDraft,
    scope: ScriptScope,
    target: RuntimeTarget,
    allowed: ReadonlySet<number>,
    brief: string | null,
    opts: { previous?: LoadedScript | null; base?: ScriptDraft | null; checklist?: boolean; refinementOf?: number; cuts?: boolean; kept?: readonly string[] } = {},
  ): string {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const inSections = (ref: string | null) => ref === null || only === undefined || [...only].some((n) => ref.startsWith(`${n}.`) || ref === `S${n}`);
    const previous = opts.previous ?? null;
    // Checked against the version it was made from (its refrains must survive), shown in full only to a refinement's editor.
    const checks = { target, previous: opts.base ?? previous?.draft ?? null, kept: opts.kept ?? [] };
    const findings = checkScript(draft, scope, checks).filter((f) => inSections(f.ref) && f.kind !== 'RUNTIME_PLAN');
    const timing = scriptTiming(allBlocks(draft), target);
    const { plan, refrains } = opts.cuts ? cutPlan(draft, scope, checks) : { plan: null, refrains: [] as Refrain[] };
    const cuts = plan ? renderTrimPlan({ ...plan, candidates: plan.candidates.filter((c) => inSections(c.ref)) }) : null;
    return [
      this.header(target),
      `This version runs ${fmtClock(timing.totalSec)} (${timing.words} spoken words).`,
      ...(brief ? ['', `# The editor's brief for this version\n${brief}`] : []),
      ...(opts.refinementOf ? ['', `This version is a narrative refinement of v${opts.refinementOf}: rewording must not change what the evidence supports — hedges kept, numbers and dates unchanged, quotations exact, fiction still fiction.`] : []),
      '',
      `# The script${only ? ` — review and change only section${only.size > 1 ? 's' : ''} ${[...only].join(', ')}` : ''}`,
      renderScript(draft, { only }),
      '',
      `# What the automated rules found (${findings.length}; blocking ones must be fixed)`,
      ...renderFindings(findings, 90),
      ...(opts.cuts
        ? [
            '',
            cuts
              ? `# This version runs over its maximum — where to cut (ranked by the rules): make the cuts the story can afford, in this order, until it fits; never a protected block\n${cuts}`
              : `# Runtime: ${fmtClock(timing.totalSec)}, within the acceptable range (${fmtClock(target.minSec)}–${fmtClock(target.maxSec)}): do not cut for length`,
            ...(refrains.length ? ['', '# Deliberate repetition — keep it: it is not redundancy', ...renderRepetition(refrains)] : []),
          ]
        : []),
      ...(previous
        ? [
            '',
            `# The previous version (v${previous.row.version}) this one refines — for comparison only; do not change it (${fmtClock(scriptTiming(allBlocks(previous.draft), target).totalSec)})`,
            renderScript(previous.draft),
          ]
        : []),
      ...(opts.kept?.length ? ['', `# Lines the refinement says it kept word for word (${opts.kept.length})`, ...opts.kept.map((l) => `- "${l}"`)] : []),
      ...(opts.checklist ? ['', `# Refinement checklist — answer every question, in this order, for this version against v${previous?.row.version ?? '?'}`, ...REFINEMENT_CHECKLIST.map((q, i) => `${i + 1}. ${q}`)] : []),
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

  private async perform(draft: ScriptDraft, scope: ScriptScope, allowed: ReadonlySet<number>, target: RuntimeTarget): Promise<PerformanceOutput> {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const timing = scriptTiming(allBlocks(draft), target);
    const parts = [
      `Documentary: ${this.ctx.project.title} — ${this.ctx.project.topic}`,
      `Runtime: ${fmtClock(timing.totalSec)} of narration (acceptable ${fmtClock(target.minSec)}–${fmtClock(target.maxSec)}).${timing.totalSec > target.maxSec ? ' It already runs over its maximum: add no pause the story does not need.' : ''}`,
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

/** The script editor's checklist answers, one per question in the checklist's order (its own wording of a question is replaced by ours). */
function checklistAnswers(answers: ScriptEditorOutput['assessment'], notes: string[]): NonNullable<NonNullable<ScriptContent['editor']>['assessment']> {
  if (answers.length !== REFINEMENT_CHECKLIST.length) notes.push(`Script editor: ${answers.length} checklist answer(s) for ${REFINEMENT_CHECKLIST.length} questions`);
  return REFINEMENT_CHECKLIST.flatMap((question, i) => {
    const a = answers[i];
    return a ? [{ question, answer: a.answer, comparedToPrevious: a.comparedToPrevious, note: a.note.trim() }] : [];
  });
}

/** A refinement against its base, for the job's final report: words, runtime, what changed, evidence, the checklist. */
function refinementSummary(base: LoadedScript, draft: ScriptDraft, content: ScriptContent, spend: number) {
  const cmp = compareDrafts(base.draft, draft);
  const ev = evidenceChanges(base.draft, draft);
  const assessment = content.editor?.assessment ?? [];
  return {
    base: { version: base.row.version, words: cmp.totals.wordsA, durationSec: cmp.totals.durationA },
    refined: { words: cmp.totals.wordsB, durationSec: cmp.totals.durationB },
    wordsRemoved: cmp.totals.wordsRemoved,
    wordsAdded: cmp.totals.wordsAdded,
    sectionsChanged: cmp.totals.sectionsChanged,
    bySection: cmp.sections.map((x) => `${x.sequenceNumber}. ${x.title}: ${x.words.a} → ${x.words.b} words (−${x.words.removed} +${x.words.added}), ${fmtClock(x.durationSec.a)} → ${fmtClock(x.durationSec.b)}`),
    evidence: ev,
    keptLines: content.provenance.changeLog?.kept ?? [],
    changeSummary: content.provenance.changeLog?.summary ?? null,
    changes: (content.provenance.changeLog?.changes ?? []).map((c) => `${c.section ? `S${c.section} ` : ''}${c.what} — ${c.why}`),
    checklist: assessment.map((a, i) => `${i + 1}. ${a.answer} (${a.comparedToPrevious.toLowerCase()} than v${base.row.version}) ${a.question} — ${a.note}`),
    estimatedCostUsd: spend,
  };
}

export type { ScriptFinding };

/** The quality rules about the story — said once, facts that earn their place, introductions, evidence, pacing — read before the sentence-level warnings. */
const STORY_RULES = CRAFT_KINDS.filter((k) => !['WRITTEN_SYNTAX', 'LIST_SENTENCE', 'NUMBER_DENSE', 'MONOTONOUS_RHYTHM', 'NOUN_HEAVY'].includes(k));

/**
 * Rule findings as a reader of the prompt sees them: blocking ones first and
 * in full, then the story-level quality rules, then the other warnings — a
 * warning found in many places shown four times, then where else.
 */
function renderFindings(findings: readonly ScriptFinding[], max: number): string[] {
  const rank = (f: ScriptFinding) => (isBlocking(f) ? 0 : STORY_RULES.includes(f.kind) ? 1 : 2);
  const groups = new Map<ScriptFindingKind, ScriptFinding[]>();
  for (const f of [...findings].sort((a, b) => rank(a) - rank(b))) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  const lines: string[] = [];
  for (const [kind, fs] of groups) {
    const blocking = isBlocking(fs[0]!);
    const shown = blocking ? fs : fs.slice(0, 4);
    for (const f of shown) lines.push(`- ${blocking ? 'BLOCKING' : 'warning'} ${kind}: ${f.detail}`);
    if (fs.length > shown.length) lines.push(`- warning ${kind}: the same in ${fs.length - shown.length} more place(s): ${fs.slice(shown.length).map((f) => f.ref ?? 'the script').join(', ')}`);
  }
  if (lines.length > max) return [...lines.slice(0, max), `- (${lines.length - max} more lines not shown)`];
  return lines.length ? lines : ['- nothing'];
}

/** Deliberate repetition, as the rules recognised it. */
function renderRepetition(refrains: readonly Refrain[]): string[] {
  return refrains.map((r) => (r.kind === 'ESCALATION' ? `- an escalating run of short sentences in ${r.refs.join(', ')}` : `- ${r.kind === 'REFRAIN' ? 'refrain' : 'callback'} "${r.phrase}" (${r.refs.join(', ')})`));
}

/** The quality rules in the order a reader wants them: about the story first, then about the sentences. */
const digestOrder = () => [...STORY_RULES, ...CRAFT_KINDS.filter((k) => !STORY_RULES.includes(k))];

/** A rule digest in one line: length, and the quality rules' findings by kind. */
function digestLine(d: RuleDigest): string {
  const kinds = digestOrder().flatMap((k) => (d.counts[k] ? [`${k} ${d.counts[k]}`] : []));
  return `${d.words} words, ${d.runtime}${d.overMax ? ` (${d.overMax} over the maximum)` : ''}; ${kinds.length ? kinds.join(', ') : 'no findings'}`;
}

/** Two digests side by side: length, and each kind's count before and after. */
function digestChange(a: RuleDigest, b: RuleDigest): string {
  const kinds = digestOrder().filter((k) => a.counts[k] || b.counts[k]);
  return `${a.words} → ${b.words} words, ${a.runtime} → ${b.runtime}${b.overMax ? ` (${b.overMax} over the maximum)` : ''}; ${kinds.length ? kinds.map((k) => `${k} ${a.counts[k] ?? 0} → ${b.counts[k] ?? 0}`).join(', ') : 'no findings in either'}`;
}
