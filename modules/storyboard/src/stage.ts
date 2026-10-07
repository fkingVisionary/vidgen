import { AssemblyEntry, StoryboardJobInput, type StoryboardInputs, type StoryboardProvenance } from '@docengine/core';
import type { Prisma, Tx } from '@docengine/database';
import { EVENT, NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { CostCeiling, StepCheckpoint } from '@docengine/story/shared';
import { approvedScript, narrationFingerprint } from '@docengine/voice';
import { z } from 'zod';
import { chooseApproach, switchApproach } from './approaches.ts';
import { BEATS_BATCH_BLOCKS, DEFAULT_STORYBOARD_CONFIG, stepKind, storyboardSteps, type StoryboardConfig } from './config.ts';
import { carryDecisions } from './decisions.ts';
import { droppedNote, type DraftBeat, type DraftSubject, type PlannedStoryboard, type StoryboardDraft, type StoryboardFacts } from './draft.ts';
import { versionChanges } from './edits.ts';
import { InputError, resolveInputs, type ResolvedInputs } from './inputs.ts';
import { summaryLine } from './log.ts';
import { applyBeatRevisions, applyRepair, beatsToRepair, markUnplanned, resolveBeats, resolveShots, sortShots } from './normalize.ts';
import { planStoryboard } from './plan.ts';
import { resolveVisualProduction } from './profiles.ts';
import { PROMPT_VERSION, beatsSystemPrompt, repairSystemPrompt, shotsSystemPrompt } from './prompts.ts';
import { beatsPrompt, repairPrompt, shotsPrompt } from './render.ts';
import { BeatsOutput, RepairOutput, ShotsOutput } from './schemas.ts';
import { contentOf, loadStoryboard, lockProject, saveVersion, usedShotKeys, type LoadedStoryboard } from './store.ts';

/**
 * The storyboard job (§2.11): VISUAL_PLAN, the phase job (a whole-script
 * storyboard for the STORYBOARD gate), and STORYBOARD_PREVIEW, the side job
 * (part of the script, never gate-eligible, the project's status unchanged).
 *
 *   S0 resolve and pin → S1 briefs → S2 beats (model) → S3 beats resolved
 *     → S4 shots per section (model) → S5 normalize and judge
 *     → S6 repair (model, one round, only if needed) → S7 save
 *
 * GENERATE plans a version; APPROACH re-plans only the beats whose
 * treatment the approach changes; BEATS re-plans the named beats with the
 * editor's instructions. Everything else is copied, keeping its keys and
 * hashes, so decisions on unchanged shots carry. The only paid calls are
 * the planning calls through the AI provider, under the job's ceiling;
 * each call's output is checkpointed, so a retry resumes after the last one.
 * Every number is code's: times from the cut points, classes, evidence,
 * costs, rhythm and QA. The job succeeds with blocking findings: the
 * version is saved for review, and approval is what they block. Nothing
 * is generated, rendered or stored but the version's rows.
 */
export function createStoryboardStage(type: 'VISUAL_PLAN' | 'STORYBOARD_PREVIEW', overrides: Partial<StoryboardConfig> = {}): StageHandler {
  const cfg: StoryboardConfig = { ...DEFAULT_STORYBOARD_CONFIG, ...overrides };
  return { type, mock: false, run: (ctx) => new StoryboardRun(ctx, cfg).run() };
}

/** A model call's output as checkpointed: with the model that served it, so a resumed job records it too. */
const Called = <T extends z.ZodType>(schema: T) => z.object({ output: schema, model: z.string() });

/** Planning stops when the beats call gave no usable beat at all: a retry would only reuse the same output. */
const NoBeats = (what: string) => new NonRetryableError(`${what}: the beats call returned no beat over the narration's cut points; plan again`);

class StoryboardRun {
  private steps!: StepCheckpoint<string>;
  private readonly ceiling: CostCeiling;
  /** The model that served each step (as the provider reported it, or as checkpointed). */
  private readonly models: Record<string, string> = {};

  constructor(
    private readonly ctx: StageContext,
    private readonly cfg: StoryboardConfig,
  ) {
    this.ceiling = new CostCeiling(ctx, cfg.maxCostUsd, 'Storyboard planning');
  }

  async run(): Promise<Record<string, unknown>> {
    const { ctx } = this;
    const parsed = StoryboardJobInput.safeParse(ctx.job.input ?? {});
    if (!parsed.success) throw new NonRetryableError(`The storyboard job's input cannot be read: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const input = parsed.data;
    const phase = ctx.job.type === 'VISUAL_PLAN';

    // S0: pins. A re-plan keeps its base's narration and profile.
    const base = input.base ? await this.base(input.base, input.narration.assemblyId) : null;
    const resolved = await this.resolve(input, phase, base);
    const { facts } = resolved;
    const title = `${ctx.project.title} — ${ctx.project.topic}`;
    const sequences = [...new Set(facts.spine.blocks.map((b) => b.sequence))];
    const batched = facts.spine.blocks.length > BEATS_BATCH_BLOCKS;
    this.steps = new StepCheckpoint(ctx, storyboardSteps(sequences, batched), PROMPT_VERSION);
    if (!(await this.steps.load())) await ctx.progress('Saved progress from another version of the storyboard engine was ignored; starting again');
    const n = facts.spine.narration;
    await ctx.progress(
      `Storyboard ${input.mode === 'GENERATE' ? 'plan' : input.mode === 'APPROACH' ? `approach ${input.approach} from v${base!.row.version}` : `re-plan of ${input.beatKeys!.join(', ')} from v${base!.row.version}`} on voice run ${n.run.number}, assembly v${n.assembly.version} (${(facts.spine.totalDurationMs / 1000).toFixed(1)} s, ${facts.spine.blocks.length} block(s), ${facts.scopeKind === 'FULL' ? 'the whole script' : 'a preview of part of the script'}); profile ${facts.profile.familyName} v${facts.profile.version}`,
      { mode: input.mode, scope: facts.scopeKind, runId: n.run.id, assemblyId: n.assembly.id, blocks: facts.spine.blocks.length, outOfScope: facts.spine.outOfScope.length, narrationApproval: facts.narrationApproval },
    );

    const notes: string[] = [];
    const candidates = resolved.inputs.candidates;
    // A new shot never takes a key another version used: a key is one shot's identity across versions.
    const used = await usedShotKeys(ctx.db, ctx.project.id);
    let draft: StoryboardDraft;
    let needRepair: string[] = [];
    let replanned: string[] = [];
    if (input.mode === 'GENERATE') {
      // S2–S3: the beats.
      const out = await this.beats(facts, title, sequences, batched, candidates);
      const { beats, subjects } = resolveBeats(out, facts, notes);
      if (!beats.length) throw NoBeats('Storyboard planning');
      draft = { approach: chooseApproach(input.approach, facts.profile.effective.approach), beats, shots: [], subjects, normalization: notes };
      replanned = beats.map((b) => b.key);
      await ctx.progress(`Visual beats: ${beats.length} over ${(facts.spine.totalDurationMs / 1000).toFixed(1)} s, ${subjects.length} continuity subject(s)${notes.length ? `; ${notes.length} of the model's references or ranges corrected (noted)` : ''}`, { step: 'beats', beats: beats.length, subjects: subjects.length, normalizations: notes.length });
      // S4: every section's shots.
      ({ draft, needRepair } = await this.shots(facts, title, draft, beats, used, undefined, candidates));
    } else if (input.mode === 'APPROACH') {
      const switched = switchApproach(base!.draft, input.approach!);
      draft = { ...switched.draft, normalization: notes };
      replanned = switched.replan;
      const beats = draft.beats.filter((b) => replanned.includes(b.key));
      if (beats.length) ({ draft, needRepair } = await this.shots(facts, title, draft, beats, used, undefined, candidates));
      else await ctx.progress(`Approach ${input.approach} changes no beat's treatment: every shot is copied`);
    } else {
      const unknown = input.beatKeys!.filter((k) => !base!.draft.beats.some((b) => b.key === k));
      if (unknown.length) throw new NonRetryableError(`Storyboard v${base!.row.version} has no beat ${unknown.join(', ')}`);
      replanned = [...input.beatKeys!];
      const set = new Set(replanned);
      const current = base!.draft.shots.filter((s) => set.has(s.beatKey));
      draft = { ...structuredClone(base!.draft), shots: base!.draft.shots.filter((s) => !set.has(s.beatKey)), normalization: notes };
      ({ draft, needRepair } = await this.shots(facts, title, draft, draft.beats.filter((b) => set.has(b.key)), used, { instructions: input.instructions, current }, candidates));
    }

    // S5: judged over the whole version; S6: one repair round for what can be repaired, only of the beats this job plans (copied beats keep their shots).
    let planned = planStoryboard(draft, facts);
    const toRepair = [...new Set([...beatsToRepair(draft, planned.qa), ...needRepair])].filter((k) => replanned.includes(k));
    if (toRepair.length) {
      await this.ceiling.check();
      const beats = draft.beats.filter((b) => toRepair.includes(b.key));
      const out = await this.call('repair', 'storyboard.repair', RepairOutput, 'StoryboardRepair', repairSystemPrompt(facts.profile.effective), repairPrompt(facts, { title, beats, shots: draft.shots, subjects: draft.subjects, approach: draft.approach, findings: planned.qa, partition: needRepair }), (x) => ({ beats: x.beats.length, shots: x.beats.reduce((s, b) => s + b.shots.length, 0) }), `a repair of ${toRepair.join(', ')}`);
      // Only the beats it was asked to repair: an answer for another beat is dropped.
      for (const r of out.beats.filter((b) => !toRepair.includes(b.beatKey))) notes.push(droppedNote(`repair of ${r.beatKey}`, 'the replacement', 'the repair was not asked to re-plan this beat'));
      const repaired = applyRepair(draft, { beats: out.beats.filter((b) => toRepair.includes(b.beatKey)) }, facts, notes, { partition: needRepair, usedKeys: used });
      draft = repaired.draft;
      await ctx.progress(`Repair of ${toRepair.join(', ')}: ${repaired.kept.length ? `kept for ${repaired.kept.join(', ')}` : 'nothing kept'} (a replacement is kept only when it removes blocking findings and adds none)`, { step: 'repair', beats: toRepair, kept: repaired.kept });
    } else await this.steps.skip('repair');
    draft = this.placeholders(draft, facts, notes, used);
    planned = planStoryboard(draft, facts);

    // S7: saved, pins re-checked.
    const saved = await this.save(input, resolved, base, planned, replanned);
    await this.steps.clear();
    const summary = await summaryLine(ctx.db, saved.id, { jobId: ctx.job.id, preview: !phase });
    ctx.logger.info(summary.data, summary.line);
    await ctx.progress(summary.line, summary.data);
    return { storyboardId: saved.id, version: saved.version, status: saved.status, ...summary.data };
  }

  /** The base version of a re-plan: this project's, at the version asked, timed on the narration asked. */
  private async base(ref: { storyboardId: string; version: number }, assemblyId: string): Promise<LoadedStoryboard> {
    const base = await loadStoryboard(this.ctx.db, ref.storyboardId);
    if (!base || base.row.projectId !== this.ctx.project.id || base.row.version !== ref.version) throw new NonRetryableError(`Storyboard v${ref.version} (${ref.storyboardId}) is not this project's`);
    if (base.row.voiceAssemblyId !== assemblyId) throw new NonRetryableError(`Storyboard v${base.row.version} is timed on another assembly: re-time it before re-planning part of it`);
    return base;
  }

  private async resolve(input: StoryboardJobInput, phase: boolean, base: LoadedStoryboard | null): Promise<ResolvedInputs> {
    try {
      return await resolveInputs(this.ctx.db, {
        projectId: this.ctx.project.id,
        runId: input.narration.runId,
        assemblyId: input.narration.assemblyId,
        phase,
        catalog: this.cfg.catalog,
        ...(base ? { profile: base.content.inputs.profile } : { selectionRevision: input.selectionRevision }),
        actor: input.requestedBy,
      });
    } catch (err) {
      throw err instanceof InputError ? new NonRetryableError(err.message) : err;
    }
  }

  /** S2: the beats call, or one per section on a long scope (each told the subjects proposed before it). */
  private async beats(facts: StoryboardFacts, title: string, sequences: readonly number[], batched: boolean, candidates: StoryboardInputs['candidates']): Promise<BeatsOutput> {
    const system = beatsSystemPrompt(facts.profile.effective);
    const summarize = (x: BeatsOutput) => ({ beats: x.beats.length, subjects: x.subjects.length });
    if (!batched) {
      await this.ceiling.check();
      return this.call('beats', 'storyboard.beats', BeatsOutput, 'StoryboardBeats', system, beatsPrompt(facts, { title, candidates }), summarize, 'the visual beats');
    }
    const all: BeatsOutput = { beats: [], subjects: [] };
    for (const n of sequences) {
      await this.ceiling.check();
      const subjects = all.subjects.map((s) => ({ key: s.key, spec: { ...s, castKind: null, basis: 'RECONSTRUCTION' as const, referenceAsset: { required: false, status: 'MISSING' as const, note: '' } } })) as DraftSubject[];
      const out = await this.call(`beats.${n}`, 'storyboard.beats', BeatsOutput, 'StoryboardBeats', system, beatsPrompt(facts, { title, sequence: n, subjects, candidates }), summarize, `the visual beats of section ${n}`);
      all.beats.push(...out.beats);
      for (const s of out.subjects) if (!all.subjects.some((x) => x.key === s.key)) all.subjects.push(s);
    }
    return all;
  }

  /** S4: a shots call per section, for the beats given that start in it; each section's shots resolved and repaired to partition its beats. */
  private async shots(facts: StoryboardFacts, title: string, draft: StoryboardDraft, beats: readonly DraftBeat[], used: readonly string[], replan: { instructions: string | undefined; current: StoryboardDraft['shots'] } | undefined, candidates: StoryboardInputs['candidates']): Promise<{ draft: StoryboardDraft; needRepair: string[] }> {
    const notes = draft.normalization;
    const needRepair: string[] = [];
    const sequenceOf = (b: DraftBeat) => {
      const p = facts.spine.point(b.narration.from);
      return p ? facts.spine.block(facts.spine.words[p.position]!.blockKey)!.sequence : facts.spine.blocks[0]!.sequence;
    };
    const sequences = [...new Set(beats.map(sequenceOf))];
    for (const n of sequences) {
      const section = beats.filter((b) => sequenceOf(b) === n);
      await this.ceiling.check();
      const out = await this.call(`shots.${n}`, 'storyboard.shots', ShotsOutput, 'StoryboardShots', shotsSystemPrompt(facts.profile.effective), shotsPrompt(facts, { title, beats: section, subjects: draft.subjects, approach: draft.approach, candidates, ...(replan?.instructions ? { instructions: replan.instructions } : {}), ...(replan ? { current: replan.current.filter((s) => section.some((b) => b.key === s.beatKey)) } : {}) }), (x) => ({ shots: x.shots.length, beats: x.beats.length }), `the shots of section ${n} (${section.map((b) => b.key).join(', ')})`);
      let next = draft;
      if (replan && out.beats.length) next = { ...next, beats: applyBeatRevisions(next.beats, out.beats.filter((r) => section.some((b) => b.key === r.beatKey)), next.approach, facts, notes) };
      const sectionBeats = next.beats.filter((b) => section.some((x) => x.key === b.key));
      const r = resolveShots(out.shots, sectionBeats, next, facts, notes, used);
      needRepair.push(...r.needRepair);
      draft = { ...next, shots: sortShots([...next.shots, ...r.shots], facts.spine) };
      await this.ctx.progress(`Section ${n}: ${r.shots.length} shot(s) over ${section.length} beat(s)${r.needRepair.length ? `; ${r.needRepair.join(', ')} not tiled by the model's shots, sent to the repair` : ''}`, { step: `shots.${n}`, shots: r.shots.length, beats: section.length, needRepair: r.needRepair });
    }
    return { draft, needRepair };
  }

  /**
   * A beat still without a shot over its words after the repair gets one
   * placeholder (SHOT_UNPLANNED); a silence-only shot that would overlap
   * another shot's words is dropped, noted. The version always tiles.
   */
  private placeholders(draft: StoryboardDraft, facts: StoryboardFacts, notes: string[], used: readonly string[]): StoryboardDraft {
    const empty = draft.beats.filter((b) => !draft.shots.some((s) => s.beatKey === b.key && s.narration)).map((b) => b.key);
    let out = markUnplanned(draft, empty, facts, notes, used);
    const planned = planStoryboard(out, facts);
    const untimed = planned.shots.filter((s) => s.startMs === null || s.endMs === null);
    if (untimed.length) {
      const silent = new Set(untimed.filter((s) => !s.narration).map((s) => s.key));
      for (const k of silent) notes.push(`${k}: the silence-only shot was removed — it could not be placed on the narration`);
      out = { ...out, shots: out.shots.filter((s) => !silent.has(s.key)) };
      out = markUnplanned(out, [...new Set(untimed.filter((s) => s.narration).map((s) => s.beatKey))], facts, notes, used);
    }
    return out;
  }

  /** A model call through the ledger, checkpointed with the model that served it; each one, or its reuse, reported as progress. */
  private async call<T>(step: string, task: string, schema: z.ZodType<T>, schemaName: string, system: string, content: string, summarize: (x: T) => Record<string, unknown>, what = step): Promise<T> {
    const { ctx, cfg } = this;
    const kind = stepKind(step);
    let called = false;
    const saved = await this.steps.step<{ output: T; model: string }>(step, Called(schema) as z.ZodType<{ output: T; model: string }>, async () => {
      called = true;
      await ctx.progress(`Planning ${what} (a model call)`, { step });
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
            effort: cfg.effort[kind],
            maxTokens: cfg.maxTokens[kind],
            ...(cfg.models[kind] ? { model: cfg.models[kind] } : {}),
            signal: ctx.signal,
          }),
        { request: { task, step, promptVersion: PROMPT_VERSION }, summarize: (x) => summarize(x.object) },
      );
      return { output: r.object, model: r.meta.model ?? 'the provider default' };
    });
    if (!called) await ctx.progress(`Planning ${what}: the saved answer of an earlier attempt is reused (no model call)`, { step, reused: true });
    this.models[step] = saved.model;
    return saved.output;
  }

  /** S7: the version saved in one transaction, after the pins are checked again; decisions on unchanged shots carried. */
  private async save(input: StoryboardJobInput, resolved: ResolvedInputs, base: LoadedStoryboard | null, planned: PlannedStoryboard, replanned: string[]) {
    const { ctx } = this;
    const { facts } = resolved;
    const origin = input.mode === 'GENERATE' ? 'GENERATED' : input.mode;
    const provenance: StoryboardProvenance = {
      origin,
      baseVersion: base?.row.version ?? null,
      baseId: base?.row.id ?? null,
      approach: planned.approach,
      beatKeys: input.mode === 'GENERATE' ? [] : replanned,
      ops: [],
      note: input.instructions ?? null,
      requestedBy: input.requestedBy,
      jobId: ctx.job.id,
      models: { ...this.models },
      promptVersion: PROMPT_VERSION,
    };
    return ctx.db.$transaction(async (tx) => {
      await lockProject(tx, ctx.project.id);
      // Never saved on a scope that no longer holds (a rewind, a new script or architecture meanwhile).
      const approved = await approvedScript(tx, ctx.project.id);
      if (approved?.id !== resolved.script.id) throw new NonRetryableError(`Not saved: script v${resolved.script.version} is no longer the approved script`);
      const arch = await tx.storyArchitecture.findUnique({ where: { id: resolved.architecture.id }, select: { status: true } });
      if (arch?.status !== 'APPROVED') throw new NonRetryableError(`Not saved: architecture v${resolved.architecture.version} is no longer approved`);
      const project = await tx.project.findUniqueOrThrow({ where: { id: ctx.project.id }, select: { phaseSeq: true } });
      // A phase job of an earlier phase run (the project was rewound meanwhile) saves a draft nobody reviews.
      const stale = ctx.job.type === 'VISUAL_PLAN' && ctx.job.phaseSeq !== project.phaseSeq;
      const status = stale ? 'DRAFT' : 'IN_REVIEW';
      // Narration newer than the one it is timed on, or a profile choice made since the request: saved all the same, timed and styled as pinned; the page shows it stale.
      const changed = await this.changedMeanwhile(tx, input, resolved, base);
      const content = contentOf(planned, { inputs: resolved.inputs, provenance, changes: base ? versionChanges(base.row.version, base.planned, planned) : null, notes: changed });
      const saved = await saveVersion(tx, { projectId: ctx.project.id, status, scope: facts.scopeKind, pins: resolved.pins, revisionOfId: base?.row.id ?? null, jobId: ctx.job.id, createdBy: input.requestedBy, planned, content, supersede: !stale });
      const carried = base ? await carryDecisions(tx, { projectId: ctx.project.id, base, saved, planned }) : 0;
      const blocking = planned.qa.filter((f) => f.severity === 'BLOCKING').length;
      await tx.projectEvent.create({
        data: {
          projectId: ctx.project.id,
          jobId: ctx.job.id,
          type: EVENT.STORYBOARD_SAVED,
          message: `Storyboard v${saved.version} saved${status === 'DRAFT' ? ' as a draft (the project was rewound while it was planned)' : ' for review'}: ${planned.beats.length} beats, ${planned.shots.length} shots${blocking ? `, ${blocking} blocking finding(s)` : ''}${base ? ` (${origin.toLowerCase()} from v${base.row.version})` : ''}`,
          data: { actor: input.requestedBy, storyboardId: saved.id, version: saved.version, status, scope: facts.scopeKind, origin, baseVersion: base?.row.version ?? null, carriedDecisions: carried, changedWhilePlanned: changed } as Prisma.InputJsonValue,
        },
      });
      if (saved.superseded.length) {
        await tx.projectEvent.create({
          data: {
            projectId: ctx.project.id,
            jobId: ctx.job.id,
            type: EVENT.STORYBOARD_SUPERSEDED,
            message: `Storyboard ${saved.superseded.map((s) => `v${s.version}`).join(', ')} superseded by v${saved.version} (kept, not changed)`,
            data: { actor: input.requestedBy, superseded: saved.superseded.map((s) => s.version), by: saved.version } as Prisma.InputJsonValue,
          },
        });
      }
      return { id: saved.id, version: saved.version, status };
    }, { timeout: 60_000 });
  }

  /**
   * What no longer matches the version's pins at its save, in the save's
   * transaction: its voice run has a newer assembly (STALE_NARRATION; re-time
   * it, no model call), or the project's visual profile choice changed since
   * the request (STALE_PROFILE; a re-plan keeps its base's profile, so only a
   * new plan is judged).
   */
  private async changedMeanwhile(tx: Tx, input: StoryboardJobInput, resolved: ResolvedInputs, base: LoadedStoryboard | null): Promise<string[]> {
    const out: string[] = [];
    const n = resolved.facts.spine.narration;
    const latest = await tx.voiceAssembly.findFirst({ where: { runId: n.run.id }, orderBy: { version: 'desc' }, select: { version: true, entries: true } });
    const entries = z.array(AssemblyEntry).min(1).safeParse(latest?.entries);
    if (latest && (!entries.success || narrationFingerprint(entries.data) !== n.assembly.fingerprint)) {
      out.push(`The narration it is timed on (assembly v${n.assembly.version}) is not its voice run's newest when it is saved (v${latest.version}): it shows as stale until it is re-timed (no model call)`);
    }
    if (!base) {
      const now = (await resolveVisualProduction(tx, this.ctx.project.id)).revision;
      if (now !== input.selectionRevision) out.push(`The project's visual profile choice changed after it was requested (revision ${input.selectionRevision}, now ${now}): it is planned with the profile it was asked with`);
    }
    return out;
  }
}
