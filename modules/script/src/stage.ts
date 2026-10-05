import {
  CURRENT_SCRIPT_ENGINE,
  ScriptJobInput,
  StoryArchitectureContentV2,
  fmtClock,
  fmtVariance,
  runtimeTarget,
  scriptTiming,
  type RuntimeTarget,
  type ScriptChangeLog,
  type ScriptContent,
  type ScriptReviewChange,
  type ScriptSectionPlan,
} from '@docengine/core';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError } from '@docengine/providers';
import { CostCeiling, EvidenceBase, StepCheckpoint } from '@docengine/story/shared';
import { z } from 'zod';
import { DEFAULT_SCRIPT_CONFIG, SCRIPT_STEPS, type ScriptConfig, type ScriptMode, type ScriptStep } from './config.ts';
import { compareDrafts, diffBlocks, evidenceChanges } from './compare.ts';
import { allBlocks, applyPerformance, markCentralQuestion, mergePronunciations, sectionDurationSec, sectionWords, sectionsFromWriter, type ScriptDraft } from './draft.ts';
import { fitPerformance, performanceBudget, renderBudget, type PerformanceBudget } from './performance.ts';
import { NARRATION_CHECKLIST, PROMPT_VERSION, REFINEMENT_CHECKLIST, factCheckSystemPrompt, narrationSystemPrompt, performanceSystemPrompt, plannerSystemPrompt, refineSystemPrompt, rewriteSystemPrompt, scriptEditorSystemPrompt, writerSystemPrompt } from './prompts.ts';
import { renderTrimPlan, selfReportMismatch, type Refrain } from './craft.ts';
import { computeScriptReport } from './quality.ts';
import { renderArchitecture, renderEvidence, renderScript } from './render.ts';
import { issueResolution, reviewPatch, reviewSummary } from './review.ts';
import { CRAFT_KINDS, blockingCount, checkScript, cutPlan, isBlocking, ruleDigest, type RuleDigest, type ScriptFinding, type ScriptFindingKind } from './rules.ts';
import { FactCheckOutput, NarrationOutput, PerformanceOutput, PlannerOutput, RefineOutput, ScriptEditorOutput, WriterOutput } from './schemas.ts';
import { approvedHouseExamples, changeReport, diagnose, loadCorpus, withHouseExamples, type Corpus } from '@docengine/writing';
import { moneyUses, narrationBlocks, scriptNames } from './editorial.ts';
import { composeLineage, countKinds, moneyUsed, moveToVisual, narrationBase, narrationGuard, narrationRecord, planNarration, renderNarrationContext, toNarrationPatch, uncertaintyOf, type NarrationPlan } from './narration.ts';
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
const NarrateStep = z.union([NarrationOutput, Unavailable]);

type Mode = ScriptMode;

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
    const mode: Mode = !input.revise ? 'DRAFT' : input.revise.narration ? 'NARRATION' : input.revise.refine ? 'REFINEMENT' : input.revise.sections.length ? 'SECTIONS' : 'REVISION';
    const written = mode === 'SECTIONS' ? input.revise!.sections : all;
    const unknown = written.filter((n) => !all.includes(n));
    if (unknown.length) throw new NonRetryableError(`Sections ${unknown.join(', ')} are not sequences of architecture v${arch.version}`);
    const brief = input.notes?.trim() || null;
    const allowed = new Set(written);
    const notes: string[] = [];

    await ctx.progress(
      mode === 'DRAFT'
        ? `Script draft from architecture v${arch.version}: ${all.length} sequences, ${scope.claims.length} claims; target ${fmtClock(target.targetSec)}`
        : mode === 'NARRATION'
          ? `Human Narration Pass on script v${base!.row.version} (Writing Engine 2): targeted edits from the house-style corpus and the diagnostics, every block's evidence kept — ${brief ? `with the director's instructions: "${clip(brief, 140)}"` : 'the house style, no director\'s instructions'}`
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
    if (mode === 'SECTIONS' || mode === 'REFINEMENT' || mode === 'NARRATION') await this.steps.skip('plan');
    else {
      await this.ceiling.check();
      const plan = await this.steps.step('plan', PlannerOutput, () => this.plan(scope, target, brief, base));
      plans = new Map(plan.sections.filter((p) => all.includes(p.sequence)).map((p) => [p.sequence, { purpose: p.purpose, approach: p.approach, showNotSay: p.showNotSay, exposition: p.exposition, tension: p.tension, reveal: p.reveal, sparse: p.sparse, targetSec: Math.max(0, p.targetSec) }]));
      narrator = plan.narrator;
      notes.push(...plan.notes.map((n) => `Planner: ${n}`));
    }

    // B. Write (or rewrite the chosen sections, the others copied unchanged; or refine the whole telling; or — a narration pass on its own — start from a copy of the base).
    await this.ceiling.check();
    let writerOut: (WriterOutput & { keptLines?: string[] }) | null = null;
    let draft: ScriptDraft;
    if (mode === 'NARRATION') {
      await this.steps.skip('write');
      draft = narrationBase(base!);
    } else {
      writerOut =
        mode === 'REFINEMENT'
          ? await this.steps.step('write', RefineOutput, () => this.refine(scope, target, base!, brief, plans))
          : await this.steps.step('write', WriterOutput, () => (mode === 'SECTIONS' ? this.rewrite(scope, target, base!, written, brief, plans) : this.write(scope, target, brief, plans, narrator, base)));
      draft = this.assemble(writerOut, scope, base, written, plans, notes, mode === 'REFINEMENT');
    }
    const keptLines = mode === 'REFINEMENT' ? (writerOut?.keptLines ?? []).map((l) => l.trim()).filter(Boolean) : mode === 'NARRATION' ? [...(base!.content?.provenance.changeLog?.kept ?? [])] : [];
    // Models misjudge the length of what they wrote: the system measures it, and says so when the change log is wrong.
    const misstated = writerOut?.changeLog ? selfReportMismatch([writerOut.changeLog.summary, ...writerOut.changeLog.changes.map((c) => `${c.what} ${c.why}`)].join('\n'), scriptTiming(allBlocks(draft), target)) : null;
    if (misstated) notes.push(`Length: ${misstated} — the measured length is the one that counts`);
    const draftFindings = checkScript(draft, scope, { target });
    await ctx.progress(`Script ${mode === 'DRAFT' ? 'draft' : mode === 'REFINEMENT' ? 'refinement' : mode === 'NARRATION' ? `v${base!.row.version}, as the narration pass starts` : 'rewrite'}: ${allBlocks(draft).length} blocks, ${allBlocks(draft).reduce((n, b) => n + b.wordCount, 0)} words, ~${fmtClock(scriptTiming(allBlocks(draft), target).totalSec)}; ${blockingCount(draftFindings)} blocking findings`, {
      findings: draftFindings.filter(isBlocking).map((f) => f.detail).slice(0, 30),
    });

    const reviewChanges: ScriptReviewChange[] = [];
    const judged = { scope, target, allowed, base: base?.draft ?? null, kept: keptLines };
    /** Where each block the reviewers saw went, reviewer by reviewer (for lineage and the money context used). */
    const keyMaps: Map<string, string | null>[] = [];

    // B½. The Human Narration Pass (Writing Engine 2): targeted edits from the corpus and the diagnostics, judged one by one.
    const narrating = mode === 'NARRATION' || this.cfg.narration.includes(mode);
    let narrationPlan: NarrationPlan | null = null;
    let narrationOut: NarrationOutput | null = null;
    let narrationUnavailable: string | null = null;
    let moved: { ref: string; note: string }[] = [];
    let corpus: Corpus | null = null;
    if (!narrating) await this.steps.skip('narrate');
    else {
      await this.ceiling.check();
      corpus = withHouseExamples(loadCorpus(), await approvedHouseExamples(ctx.db));
      if (corpus.errors.length) notes.push(`Writing corpus: ${corpus.errors.length} example(s) failed validation and were left out`);
      // Blocks a narration pass already edited in the base (a pass on a pass's output): its judgment calls stand.
      const handled = mode === 'NARRATION' && base?.content?.narration ? new Set((base.content.reviewChanges ?? []).filter((c) => c.reviewer === 'NARRATION' && c.status === 'ACCEPTED' && c.savedRef).map((c) => c.savedRef!)) : undefined;
      const plan = planNarration(draft, scope, { kept: keptLines, corpus, allowed, findings: draftFindings, handled });
      narrationPlan = plan;
      const narrated = await this.steps.step('narrate', NarrateStep, () =>
        this.unavailableOnError(() => this.call('narrate', 'script.narrate', NarrationOutput, 'NarrationPass', narrationSystemPrompt(), this.narratePrompt(draft, scope, target, allowed, brief, plan, base, mode), (x) => ({ edits: x.edits.length, kept: x.kept.length }))),
      );
      if ('unavailable' in narrated) {
        // A narration pass on its own would save a copy of the base: fail instead.
        if (mode === 'NARRATION') throw new NonRetryableError(`The narration pass could not run: ${narrated.unavailable}`);
        narrationUnavailable = narrated.unavailable;
        notes.push(`Narration pass unavailable: ${narrated.unavailable}`);
      } else {
        narrationOut = narrated;
        const r = reviewPatch(draft, toNarrationPatch(narrated, draft, plan), 'NARRATION', { ...judged, guard: narrationGuard(plan, narrated, scope) });
        const v = moveToVisual(r.draft, narrated, r.changes, scope);
        draft = v.draft;
        moved = v.moved;
        reviewChanges.push(...r.changes);
        keyMaps.push(r.keyMap);
        notes.push(...r.notes, ...[reviewSummary('Narration pass', r.changes)].filter((x): x is string => x !== null));
        await ctx.progress(`Narration pass: ${plan.needs.size} block(s) needed work; ${r.changes.filter((c) => c.status === 'ACCEPTED').length} edit(s) kept, ${r.changes.filter((c) => c.status === 'REJECTED').length} rejected, ${r.changes.filter((c) => c.status === 'SKIPPED').length} skipped; ${plan.retrieved.length} corpus example(s) retrieved (corpus ${plan.corpusVersion})`, {
          changes: r.changes.map((c) => `${c.id} ${c.ref ?? ''} ${c.status}${c.status === 'ACCEPTED' ? '' : `: ${c.rejectionReason}`}`).slice(0, 60),
          retrieved: plan.retrieved.map((x) => `${x.example.id}@${x.example.version} (${x.reason})`),
        });
      }
    }

    // C. Script editor (craft). Each change it proposes is judged on its own.
    await this.ceiling.check();
    const refined = mode === 'REFINEMENT' || mode === 'NARRATION' ? base! : null;
    const checklist = mode === 'REFINEMENT' ? REFINEMENT_CHECKLIST : mode === 'NARRATION' ? NARRATION_CHECKLIST : null;
    const context = { base: base?.draft ?? null, changeLog: writerOut?.changeLog ?? null, kept: keptLines };
    const narrated = reviewChanges.length ? [...reviewChanges] : undefined;
    const edited = await this.steps.step('edit', EditStep, () =>
      this.unavailableOnError(() =>
        this.call('edit', 'script.edit', ScriptEditorOutput, 'ScriptEditorReview', scriptEditorSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief, { ...context, previous: base, refinement: refined !== null, narration: mode === 'NARRATION', checklist, cuts: true, reviewed: narrated }), (x) => ({ issues: x.issues.length, edits: x.edits.length, assessment: x.assessment.length })),
      ),
    );
    let editor: ScriptContent['editor'] = null;
    if ('unavailable' in edited) notes.push(`Script editor unavailable: ${edited.unavailable}`);
    else {
      const r = reviewPatch(draft, edited, 'SCRIPT_EDITOR', judged);
      draft = r.draft;
      // The narration pass's kept changes now point at the editor's numbering.
      for (const c of reviewChanges) if (c.savedRef && r.keyMap.has(c.savedRef)) c.savedRef = r.keyMap.get(c.savedRef) ?? null;
      reviewChanges.push(...r.changes);
      keyMaps.push(r.keyMap);
      notes.push(...r.notes, ...[reviewSummary('Script editor', r.changes)].filter((x): x is string => x !== null));
      editor = { verdict: edited.verdict, scores: edited.scores, issues: edited.issues.map((i) => ({ ...i, ...issueResolution(i.ref, r) })), ...(checklist ? { assessment: checklistAnswers(edited.assessment, checklist, notes) } : {}) };
    }

    // D. Fact checker (last word on facts): it sees what the editor's changes became.
    await this.ceiling.check();
    const checked = await this.steps.step('factCheck', FactStep, () =>
      this.unavailableOnError(() =>
        this.call('factCheck', 'script.factCheck', FactCheckOutput, 'ScriptFactCheck', factCheckSystemPrompt(), this.reviewPrompt(draft, scope, target, allowed, brief, { ...context, previous: base, refinement: refined !== null, narration: mode === 'NARRATION', reviewed: reviewChanges }), (x) => ({ issues: x.issues.length, edits: x.edits.length })),
      ),
    );
    let factCheck: ScriptContent['factCheck'] = null;
    if ('unavailable' in checked) notes.push(`Fact checker unavailable: ${checked.unavailable}`);
    else {
      const r = reviewPatch(draft, checked, 'FACT_CHECKER', judged);
      draft = r.draft;
      // The editor's issues and kept changes now point at the fact checker's numbering.
      for (const c of reviewChanges) if (c.savedRef && r.keyMap.has(c.savedRef)) c.savedRef = r.keyMap.get(c.savedRef) ?? null;
      reviewChanges.push(...r.changes);
      keyMaps.push(r.keyMap);
      notes.push(...r.notes, ...[reviewSummary('Fact checker', r.changes)].filter((x): x is string => x !== null));
      factCheck = { verdict: checked.verdict, issues: checked.issues.map((i) => ({ ...i, ...issueResolution(i.ref, r) })) };
      if (editor) editor = { ...editor, issues: editor.issues.map((i) => (i.ref && r.keyMap.has(i.ref) ? { ...i, ref: r.keyMap.get(i.ref) ?? i.ref } : i)) };
    }

    // E. Performance: delivery where it matters, pauses with a reason, pronunciation — within the runtime budget.
    await this.ceiling.check();
    const budget = performanceBudget(draft, target, allowed);
    const perf = await this.steps.step('perform', PerformStep, () => this.unavailableOnError(() => this.perform(draft, scope, allowed, budget)));
    if ('unavailable' in perf) notes.push(`Performance pass unavailable: ${perf.unavailable}`);
    else {
      draft = applyPerformance(draft, perf, scope, allowed, notes);
      const fit = fitPerformance(draft, target, allowed, { allowOverMax: input.allowPerformanceOverMax });
      draft = fit.draft;
      reviewChanges.push(...fit.changes);
      if (fit.trimmedSec > 0) notes.push(`Performance: ${fit.trimmedSec.toFixed(1)} s of pauses and slower delivery given up to stay within the ${fmtClock(target.maxSec)} maximum (${fmtClock(fit.beforeSec)} → ${fmtClock(fit.afterSec)}; ${fit.changes.map((c) => c.id).join(', ')})`);
      else if (input.allowPerformanceOverMax && fit.beforeSec > target.maxSec) notes.push(`Performance: runs ${fmtClock(fit.beforeSec)}, past the ${fmtClock(target.maxSec)} maximum — the user allowed it`);
      notes.push(...perf.notes.map((n) => `Performance: ${n}`));
    }

    // Writing Engine 2: what the version is now — names, money context, diagnostics — and the record of the narration pass.
    const findings = checkScript(draft, scope, { target, factIssues: factCheck?.issues, previous: base?.draft ?? null, kept: keptLines });
    const names = scriptNames(draft, scope);
    const afterUses = moneyUses(draft, scope);
    const after = diagnose({ blocks: narrationBlocks(draft), findings: countKinds(findings), money: afterUses, names });
    const lineage = mode === 'NARRATION' ? composeLineage(base!.draft, keyMaps) : null;
    const narration = narrating
      ? narrationRecord({
          plan: narrationPlan,
          out: narrationOut,
          unavailable: narrationUnavailable,
          changes: reviewChanges,
          after,
          afterUses,
          names,
          used: narrationOut && narrationPlan ? moneyUsed(narrationOut, reviewChanges, narrationPlan) : [],
          moved,
          lineage,
          corpusVersion: corpus?.version ?? loadCorpus().version,
        })
      : undefined;
    const changeLog = mode === 'NARRATION' ? narrationChangeLog(reviewChanges, narrationOut, draft, keptLines) : mode === 'REFINEMENT' ? { ...writerOut!.changeLog, kept: keptLines } : (writerOut?.changeLog ?? null);

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
      reviewChanges,
      provenance: {
        origin: mode,
        baseVersion: base?.row.version ?? null,
        baseId: base?.row.id ?? null,
        sections: written,
        brief,
        requestedBy: (await this.requester()) ?? null,
        changeLog,
      },
      ...(narration ? { narration } : {}),
    };
    const timing = scriptTiming(allBlocks(draft), target);
    const report = computeScriptReport({ findings, timing, content, notes, draft, narrationSec: budget.narrationSec, reviewers: { editor: 'unavailable' in edited ? edited.unavailable : null, factCheck: 'unavailable' in checked ? checked.unavailable : null } });
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
      writingEngine: narrating ? 2 : 1,
      ...(narration
        ? {
            corpusVersion: narration.corpusVersion,
            narration: narration.counts,
            fingerprintBefore: narration.diagnostics.before?.fingerprint.score ?? null,
            fingerprintAfter: narration.diagnostics.after.fingerprint.score,
          }
        : {}),
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
    const comparison = base && (mode === 'REFINEMENT' || mode === 'NARRATION') ? refinementSummary(base, draft, content, spend) : null;
    const editorial = base && narration ? editorialSummary(base, saved, draft, content, narration) : null;
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
        notes,
        review: {
          kept: reviewChanges.filter((c) => c.status === 'ACCEPTED').length,
          rejected: reviewChanges.filter((c) => c.status === 'REJECTED').length,
          skipped: reviewChanges.filter((c) => c.status === 'SKIPPED').length,
          changes: reviewChanges.map((c) => `${c.id} ${c.type} ${c.ref ?? ''} ${c.status}${c.status === 'ACCEPTED' ? (c.rulesImpacted.length ? ` (${c.rulesImpacted.join(', ')})` : '') : `: ${c.rejectionReason}`}`).slice(0, 60),
        },
        measurements: report.measurements?.map((m) => `${m.label}: ${m.value}${m.detail ? ` — ${m.detail}` : ''}`),
        ...(comparison ? { comparison } : {}),
        ...(narration ? { narration: narrationLog(narration) } : {}),
        ...(editorial ? { changeReport: editorial } : {}),
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
   * What the Human Narration Pass sees: the diagnostics' needs block by
   * block (every other block is settled), the lines to keep, the money
   * context the evidence supports, the names as the evidence spells them, a
   * handful of corpus examples retrieved for those needs, the script, the
   * architecture and the evidence — and last, the director's instructions.
   */
  private narratePrompt(draft: ScriptDraft, scope: ScriptScope, target: RuntimeTarget, allowed: ReadonlySet<number>, brief: string | null, plan: NarrationPlan, base: LoadedScript | null, mode: Mode): string {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const timing = scriptTiming(allBlocks(draft), target);
    const sectionNotes = mode === 'NARRATION' && base ? base.draft.sections.filter((s) => s.editorNotes || s.reviewStatus === 'REJECTED').map((s) => `- Section ${s.sequence}${s.reviewStatus === 'REJECTED' ? ' (rejected by the editor)' : ''}: ${s.editorNotes ?? 'no note'}`) : [];
    return [
      this.header(target),
      `This version runs ${fmtClock(timing.totalSec)} (${timing.words} spoken words), measured from the script.`,
      '',
      renderNarrationContext(plan),
      '',
      `# The script${mode === 'NARRATION' && base ? ` (v${base.row.version})` : ''} — the narration to edit${only ? `: section${only.size > 1 ? 's' : ''} ${[...only].join(', ')} only` : ''}`,
      renderScript(draft, { only }),
      '',
      renderArchitecture(scope),
      '',
      renderEvidence(scope),
      '',
      "# The director's instructions (they may steer style and emphasis; never the evidence)",
      brief ?? 'None. Apply the house style in full.',
      ...(sectionNotes.length ? ["The director's notes on sections:", ...sectionNotes] : []),
    ].join('\n');
  }

  /**
   * What a reviewer sees: the script (the sections it may change in full),
   * the rule findings, the architecture and the evidence; the version it was
   * made from, the writer's change log and the lines the writer removed on
   * purpose (so a deliberate cut is not mistaken for an accident); the
   * changes already judged in this run, kept or rejected and why; and, for a
   * refinement's script editor, the checklist.
   */
  private reviewPrompt(
    draft: ScriptDraft,
    scope: ScriptScope,
    target: RuntimeTarget,
    allowed: ReadonlySet<number>,
    brief: string | null,
    opts: {
      previous?: LoadedScript | null;
      base?: ScriptDraft | null;
      refinement?: boolean;
      /** The version is a narration pass on its own (no lines were removed on purpose: the pass edits, it does not cut). */
      narration?: boolean;
      checklist?: readonly string[] | null;
      cuts?: boolean;
      kept?: readonly string[];
      changeLog?: ScriptChangeLog | null;
      reviewed?: readonly ScriptReviewChange[];
    } = {},
  ): string {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const inSections = (ref: string | null) => ref === null || only === undefined || [...only].some((n) => ref.startsWith(`${n}.`) || ref === `S${n}`);
    const previous = opts.previous ?? null;
    // Checked against the version it was made from: its claim links and refrains must survive.
    const checks = { target, previous: opts.base ?? previous?.draft ?? null, kept: opts.kept ?? [] };
    const findings = checkScript(draft, scope, checks).filter((f) => inSections(f.ref) && f.kind !== 'RUNTIME_PLAN');
    const timing = scriptTiming(allBlocks(draft), target);
    const { plan, refrains } = opts.cuts ? cutPlan(draft, scope, checks) : { plan: null, refrains: [] as Refrain[] };
    const cuts = plan ? renderTrimPlan({ ...plan, candidates: plan.candidates.filter((c) => inSections(c.ref)) }) : null;
    const removed = previous && !opts.narration ? removedLines(previous.draft, draft, only) : [];
    const log = opts.changeLog;
    return [
      this.header(target),
      `This version runs ${fmtClock(timing.totalSec)} (${timing.words} spoken words), measured from the script.`,
      ...(brief ? ['', `# The editor's brief for this version\n${brief}`] : []),
      ...(opts.refinement && previous ? ['', `This version is a ${opts.narration ? 'narration pass on' : 'narrative refinement of'} v${previous.row.version}: rewording must not change what the evidence supports — hedges kept, numbers and dates unchanged, quotations exact, fiction still fiction, every factual sentence still citing the claim behind it.`] : []),
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
      ...(log && (log.summary || log.changes.length)
        ? ['', "# The writer's change log (its own account — the measured figures above are what count)", log.summary, ...log.changes.map((c) => `- ${c.section ? `Section ${c.section}: ` : ''}${c.what} — ${c.why}`)]
        : []),
      ...(removed.length ? ['', `# Lines the writer removed on purpose from v${previous!.row.version} (${removed.length}) — not accidents: do not bring one back unless the story or the evidence needs it`, ...removed.map((l) => `- "${l}"`)] : []),
      ...(opts.kept?.length ? ['', `# Lines the refinement says it kept word for word (${opts.kept.length})`, ...opts.kept.map((l) => `- "${l}"`)] : []),
      ...(opts.reviewed?.length
        ? [
            '',
            '# Changes already judged in this run — do not undo an accepted change unless it broke the evidence; do not propose a rejected one again without fixing why it was rejected',
            ...opts.reviewed.map((c) => `- ${c.id} ${c.type} ${c.ref ?? ''} — ${c.status}${c.status === 'ACCEPTED' ? '' : `: ${c.rejectionReason}`} (${c.reason || 'no reason given'})`),
          ]
        : []),
      ...(previous
        ? [
            '',
            `# The version this one was made from (v${previous.row.version}) — for comparison only; do not change it (${fmtClock(scriptTiming(allBlocks(previous.draft), target).totalSec)})`,
            renderScript(previous.draft, { only }),
          ]
        : []),
      ...(opts.checklist?.length ? ['', `# ${opts.narration ? 'Narration' : 'Refinement'} checklist — answer every question, in this order, for this version against v${previous?.row.version ?? '?'}`, ...opts.checklist.map((q, i) => `${i + 1}. ${q}`)] : []),
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

  private async perform(draft: ScriptDraft, scope: ScriptScope, allowed: ReadonlySet<number>, budget: PerformanceBudget): Promise<PerformanceOutput> {
    const only = allowed.size === scope.architecture.sequences.length ? undefined : allowed;
    const parts = [
      `Documentary: ${this.ctx.project.title} — ${this.ctx.project.topic}`,
      renderBudget(budget),
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
function checklistAnswers(answers: ScriptEditorOutput['assessment'], checklist: readonly string[], notes: string[]): NonNullable<NonNullable<ScriptContent['editor']>['assessment']> {
  if (answers.length !== checklist.length) notes.push(`Script editor: ${answers.length} checklist answer(s) for ${checklist.length} questions`);
  return checklist.flatMap((question, i) => {
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
const STORY_RULES = CRAFT_KINDS.filter((k) => !['WRITTEN_SYNTAX', 'LIST_SENTENCE', 'NUMBER_DENSE', 'MONOTONOUS_RHYTHM', 'NOUN_HEAVY', 'AI_PATTERN', 'VISUAL_IN_NARRATION', 'MONEY_WITHOUT_CONTEXT'].includes(k) && !k.startsWith('NARRATION_'));

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

/** Block texts of the version a run started from that the new version no longer has (in the sections it may change). */
function removedLines(previous: ScriptDraft, draft: ScriptDraft, only?: ReadonlySet<number>): string[] {
  const out: string[] = [];
  for (const s of previous.sections) {
    if (only && !only.has(s.sequence)) continue;
    const now = draft.sections.find((x) => x.sequence === s.sequence)?.blocks ?? [];
    for (const d of diffBlocks(s.blocks, now)) if (d.op === 'removed') out.push(d.text);
  }
  return out.slice(0, 40);
}

/** A narration pass's change log, from its own ledger: what it changed, section by section, and the lines it kept. */
function narrationChangeLog(changes: readonly ScriptReviewChange[], out: NarrationOutput | null, draft: ScriptDraft, kept: readonly string[]): ScriptChangeLog {
  const mine = changes.filter((c) => c.reviewer === 'NARRATION' && c.status === 'ACCEPTED');
  const sections = [...new Set(mine.map((c) => c.section).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const text = allBlocks(draft).map((b) => b.text).join(' ');
  return {
    summary: `${out?.verdict ? `${out.verdict} ` : ''}Narration pass: ${mine.length} block(s) edited, every other block left as written.`,
    changes: sections.map((n) => ({ section: n, what: mine.filter((c) => c.section === n).map((c) => c.ref).join(', '), why: [...new Set(mine.filter((c) => c.section === n).map((c) => c.reason))].slice(0, 3).join(' / ') })),
    kept: [...new Set([...kept, ...(out?.kept ?? [])])].filter((l) => text.includes(l)),
  };
}

/** The narration record in the job's final log entry: what the pass did, and the diagnostics before and after. */
function narrationLog(n: NonNullable<ScriptContent['narration']>) {
  const rubric = (r: readonly { dimension: string; score: number }[] | undefined) => (r ?? []).map((x) => `${x.dimension} ${x.score}`).join(', ');
  return {
    engine: n.engine,
    corpusVersion: n.corpusVersion,
    styleBible: n.styleBibleVersion,
    unavailable: n.unavailable,
    verdict: n.verdict,
    counts: n.counts,
    fingerprint: `${n.diagnostics.before?.fingerprint.score ?? '—'} → ${n.diagnostics.after.fingerprint.score} (signals ${n.diagnostics.before?.fingerprint.signals ?? '—'} → ${n.diagnostics.after.fingerprint.signals})`,
    rubricBefore: rubric(n.diagnostics.before?.rubric),
    rubricAfter: rubric(n.diagnostics.after.rubric),
    retrieved: n.retrieved.map((r) => `${r.id}@${r.version} [${r.category}/${r.quality}] for ${r.refs.slice(0, 4).join(', ')}`),
    money: { contexts: n.money.contexts.map((c) => `${c.id} ${c.amountText} ${c.currency}: ${c.explanation} (${c.sourceClaimKeys.join(', ')}, ${c.confidence})`), used: n.money.used, gaps: n.money.gaps.map((g) => `${g.ref}: ${g.amountText} ${g.currency}`) },
    names: n.names.map((x) => `${x.displayName}${x.candidate ? ` — pronunciation to decide (${x.candidateReasons.join('; ')})` : ''}`),
    visualMoved: n.visualMoved,
  };
}

/** The change report against the base, compactly, with representative before/after examples (for the job log). */
function editorialSummary(base: LoadedScript, saved: { id: string; version: number }, draft: ScriptDraft, content: ScriptContent, narration: NonNullable<ScriptContent['narration']>) {
  const r = changeReport({
    base: { id: base.row.id, version: base.row.version, blocks: narrationBlocks(base.draft) },
    revised: { id: saved.id, version: saved.version, blocks: narrationBlocks(draft) },
    lineage: narration.lineage,
    ledger: content.reviewChanges ?? [],
    narration,
    uncertainty: uncertaintyOf,
  });
  const clipped = (t: string | null) => (t && t.length > 420 ? `${t.slice(0, 419)}…` : t);
  return {
    pairing: r.pairing,
    totals: r.totals,
    fingerprint: r.fingerprint,
    provenance: r.provenance,
    examples: r.blocks
      .filter((b) => b.status === 'REWRITTEN')
      .slice(0, 12)
      .map((b) => ({ ref: `${b.baseRef} → ${b.ref}`, original: clipped(b.original), revised: clipped(b.revised), why: b.reasons, evidencePreserved: b.evidencePreserved, uncertaintyPreserved: b.uncertaintyPreserved, moneyContext: b.moneyContext, aiPatternsRemoved: b.aiPatternsRemoved, aiPatternsAdded: b.aiPatternsAdded, visualDuplicationRemoved: b.visualDuplicationRemoved, pronunciationCandidates: b.pronunciationCandidates })),
  };
}
