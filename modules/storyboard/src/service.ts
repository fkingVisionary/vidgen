import {
  GenerateStoryboardInput,
  RegenerateBeatsInput,
  SwitchApproachInput,
  type CreateVisualProfileFamilyInput,
  type DuplicateVisualProfileInput,
  type JobView,
  type NewVisualProfileVersionInput,
  type RestoreStoryboardInput,
  type RetimeStoryboardInput,
  type ShotDecisionInput,
  type StoryboardDecisionInput,
  type StoryboardEditInput,
  type StoryboardInputsView,
  type StoryboardSummaryView,
  type StoryboardView,
  type UpdateVisualProfileFamilyInput,
  type VisualCatalog,
  type VisualCatalogView,
  type VisualProductionView,
  type VisualProfileHistoryView,
  type VisualProfileLibraryView,
  type VisualSelectionInput,
} from '@docengine/core';
import type { Database, Job, Project, Tx } from '@docengine/database';
import { ConflictError, NotFoundError, type ProjectService, type StoryboardJobRequest } from '@docengine/pipeline';
import { describeVisualCatalog } from '@docengine/providers';
import { approvedScript } from '@docengine/voice';
import { decideShot, decideVersion, requireNewest } from './decisions.ts';
import { EditError } from './edits.ts';
import { editStoryboard, restoreStoryboard, retimeStoryboard, type MadeVersion } from './editing.ts';
import { InputError, gateAssemblyId } from './inputs.ts';
import {
  VisualProfileError,
  createVisualProfileFamily,
  duplicateVisualProfile,
  ensurePresets,
  isUniqueViolation,
  newVisualProfileVersion,
  resolveVisualProduction,
  setVisualSelection,
  updateVisualProfileFamily,
} from './profiles.ts';
import { PREVIEW_STATUSES, loadStoryboardInputs, loadStoryboardView, loadVisualLibrary, loadVisualProduction, loadVisualProfileHistory, phaseAllowed, storyboardSummary } from './views.ts';

/**
 * The editor's side of the Storyboard Engine: plan a storyboard of a voice
 * run's narration (a preview, or the phase job once the VOICE gate has
 * approved the narration), switch its approach or re-plan chosen beats —
 * each a paid planning job, confirmed by the request — and, with no model
 * call, edit, re-time or restore versions, decide shots and versions, keep
 * the visual profile library and choose a project's profile. Nothing here
 * generates a picture; every job goes through the ProjectService.
 */

export interface StoryboardServiceDeps {
  db: Database;
  projects: ProjectService;
  /** The visual catalog forecasts are priced from. */
  catalog: VisualCatalog;
  /** The storyboard stages are real here (the AI provider is configured). */
  realStage: boolean;
  /** The planning job's ceiling, in USD. */
  planningCeilingUsd: number;
  toJobView: (job: never) => JobView;
}

/** A refusal the editor can act on (409): a profile, input or edit problem, or something saved at the same time elsewhere. */
function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof VisualProfileError || err instanceof InputError || err instanceof EditError) throw new ConflictError(err.message);
    if (isUniqueViolation(err)) throw new ConflictError('Saved at the same time somewhere else (a profile name, a version or a project\'s choice): reload and try again');
    throw err;
  });
}

export class StoryboardService {
  constructor(private readonly deps: StoryboardServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** A project by id or slug. */
  private async project(ref: string): Promise<Project> {
    const p = /^[0-9a-f-]{36}$/i.test(ref) ? await this.db.project.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] } }) : await this.db.project.findUnique({ where: { slug: ref } });
    if (!p) throw new NotFoundError('Project', ref);
    return p;
  }

  private async version(id: string) {
    const row = await this.db.storyboard.findUnique({ where: { id }, include: { project: true } });
    if (!row) throw new NotFoundError('Storyboard', id);
    return row;
  }

  /** The project's visual selection is still at the revision the request was made at (in the request's transaction). */
  private async selectionAt(tx: Tx, projectId: string, revision: number, actor: string): Promise<void> {
    const production = await resolveVisualProduction(tx, projectId, { create: true, actor });
    if (production.revision !== revision) throw new ConflictError(`The project's visual profile or its overrides changed since this was requested (revision ${revision}, now ${production.revision}): reload and request it again`);
  }

  /** Runs a storyboard request as the phase job or a preview, as the version's scope or the narration decides. */
  private enqueue(project: Project, phase: boolean, actor: string, reason: string, prepare: (tx: Tx, p: Project) => Promise<StoryboardJobRequest>): Promise<Job> {
    return phase ? this.deps.projects.storyboardJob(project.id, actor, reason, prepare) : this.deps.projects.storyboardPreview(project.id, actor, reason, prepare);
  }

  private requireReal(): void {
    if (!this.deps.realStage) throw new ConflictError('The storyboard is planned by the model, which is not configured here (MOCK): nothing would be planned');
  }

  /**
   * Plan a storyboard of a voice run's narration (a paid planning job, so
   * confirmed by the request). The phase job when the narration is the one
   * the VOICE gate approved and the project is past it (the default
   * assembly then); otherwise a preview of the run's latest assembly (or the
   * one named), while the narration is reviewed or just approved.
   */
  async generate(projectRef: string, raw: GenerateStoryboardInput, actor: string): Promise<{ job: Job; kind: 'PREVIEW' | 'PHASE'; assemblyId: string }> {
    const input = GenerateStoryboardInput.parse(raw);
    return wrap(async () => {
      this.requireReal();
      const project = await this.project(projectRef);
      const run = await this.db.voiceRun.findFirst({ where: { id: input.narration.runId, projectId: project.id }, include: { assemblies: { orderBy: { version: 'desc' }, select: { id: true, version: true } } } });
      if (!run) throw new NotFoundError('Voice run', input.narration.runId);
      const approved = await approvedScript(this.db, project.id);
      if (!approved || approved.id !== run.scriptId) throw new ConflictError(`Voice run ${run.number} narrates another script than the approved one${approved ? ` (v${approved.version})` : ''}: a storyboard is planned on the approved script's narration`);
      if (input.narration.assemblyId && !run.assemblies.some((a) => a.id === input.narration.assemblyId)) throw new NotFoundError(`Assembly of voice run ${run.number}`, input.narration.assemblyId);
      const gate = await gateAssemblyId(this.db, project.id);
      const gateHere = !!gate && run.assemblies.some((a) => a.id === gate);
      const assemblyId = input.narration.assemblyId ?? (gateHere && phaseAllowed(project) ? gate! : run.assemblies[0]?.id);
      if (!assemblyId) throw new ConflictError(`Voice run ${run.number} has no assembled narration yet`);
      const phase = assemblyId === gate && phaseAllowed(project);
      if (!phase && !PREVIEW_STATUSES.includes(project.status as (typeof PREVIEW_STATUSES)[number])) {
        throw new ConflictError(
          phaseAllowed(project)
            ? `In ${project.status} the storyboard is planned on the narration the VOICE gate approved${gate ? '' : ' (none is approved)'}: a preview of another narration is planned while the narration is reviewed`
            : `A storyboard is planned while the narration is reviewed or after it is approved, and before visual generation (the project is ${project.status})`,
        );
      }
      const version = run.assemblies.find((a) => a.id === assemblyId)!.version;
      const reason = `${phase ? 'Storyboard' : 'Storyboard preview'} of voice run ${run.number}, assembly v${version}${input.approach ? `, approach ${input.approach}` : ''}`;
      const job = await this.enqueue(project, phase, actor, reason, async (tx, p) => {
        await this.selectionAt(tx, p.id, input.selectionRevision, actor);
        return { mode: 'GENERATE', narration: { runId: run.id, assemblyId }, ...(input.approach ? { approach: input.approach } : {}), selectionRevision: input.selectionRevision };
      });
      return { job, kind: phase ? 'PHASE' : 'PREVIEW', assemblyId };
    });
  }

  /** A paid re-plan of the newest version: its other beats and shots copied (BEATS: the named beats; APPROACH: those whose treatment changes). */
  private async replan(storyboardId: string, expected: number, actor: string, reason: (v: number) => string, request: (base: { id: string; version: number; runId: string; assemblyId: string }) => Omit<StoryboardJobRequest, 'selectionRevision'>): Promise<{ job: Job }> {
    return wrap(async () => {
      this.requireReal();
      const row = await this.version(storyboardId);
      if (!row.voiceRunId || !row.voiceAssemblyId) throw new ConflictError(`Storyboard v${row.version}'s narration no longer exists: plan a new storyboard`);
      const base = { id: row.id, version: row.version, runId: row.voiceRunId, assemblyId: row.voiceAssemblyId };
      const job = await this.enqueue(row.project, row.scope === 'FULL', actor, reason(row.version), async (tx, p) => {
        await requireNewest(tx, p.id, expected);
        const production = await resolveVisualProduction(tx, p.id);
        return { ...request(base), selectionRevision: production.revision };
      });
      return { job };
    });
  }

  /** Re-plan chosen beats of the newest version, with the editor's instructions (their ranges stay; everything else is copied). */
  async regenerateBeats(storyboardId: string, raw: RegenerateBeatsInput, actor: string): Promise<{ job: Job }> {
    const input = RegenerateBeatsInput.parse(raw);
    const row = await this.version(storyboardId);
    const beats = await this.db.visualBeat.findMany({ where: { storyboardId, beatKey: { in: input.beatKeys } }, select: { beatKey: true } });
    const missing = input.beatKeys.filter((k) => !beats.some((b) => b.beatKey === k));
    if (missing.length) throw new ConflictError(`Storyboard v${row.version} has no beat ${missing.join(', ')}`);
    return this.replan(storyboardId, input.expectedVersion, actor, (v) => `Re-plan of ${input.beatKeys.join(', ')} from storyboard v${v}`, (base) => ({
      mode: 'BEATS',
      narration: { runId: base.runId, assemblyId: base.assemblyId },
      base: { storyboardId: base.id, version: base.version },
      beatKeys: input.beatKeys,
      ...(input.instructions ? { instructions: input.instructions } : {}),
    }));
  }

  /** Plan another approach from the newest version: only the beats whose treatment it changes are re-planned. */
  async switchApproach(storyboardId: string, raw: SwitchApproachInput, actor: string): Promise<{ job: Job }> {
    const input = SwitchApproachInput.parse(raw);
    return this.replan(storyboardId, input.expectedVersion, actor, (v) => `Approach ${input.approach} from storyboard v${v}`, (base) => ({
      mode: 'APPROACH',
      narration: { runId: base.runId, assemblyId: base.assemblyId },
      base: { storyboardId: base.id, version: base.version },
      approach: input.approach,
    }));
  }

  private get editing() {
    return { db: this.db, projects: this.deps.projects, catalog: this.deps.catalog };
  }

  /** A person's edits: a new version, no model call. */
  edit(storyboardId: string, input: StoryboardEditInput, actor: string): Promise<MadeVersion> {
    return wrap(() => editStoryboard(this.editing, storyboardId, input, actor));
  }

  /** The same plan on another assembly of its voice run: a new version, no model call. */
  retime(storyboardId: string, input: RetimeStoryboardInput, actor: string): Promise<MadeVersion> {
    return wrap(() => retimeStoryboard(this.editing, storyboardId, input, actor));
  }

  /** An older version made current again, as a new version. */
  restore(storyboardId: string, input: RestoreStoryboardInput, actor: string): Promise<MadeVersion> {
    return wrap(() => restoreStoryboard(this.editing, storyboardId, input, actor));
  }

  /** A person's decision on a version (a whole-script one under review goes through the STORYBOARD gate). */
  decide(storyboardId: string, input: StoryboardDecisionInput, actor: string) {
    return wrap(() => decideVersion(this.editing, storyboardId, input, actor));
  }

  /** A person's decision on one shot. */
  decideShot(shotId: string, input: ShotDecisionInput, actor: string) {
    return wrap(() => decideShot(this.editing, shotId, input, actor));
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  private get viewDeps() {
    return { db: this.db, catalog: this.deps.catalog, realStage: this.deps.realStage, planningCeilingUsd: this.deps.planningCeilingUsd, toJobView: this.deps.toJobView };
  }

  /** The Storyboard page (the newest version, or version `v`). */
  async view(projectRef: string, v?: number): Promise<StoryboardView> {
    const project = await this.project(projectRef);
    if (v !== undefined && !(await this.db.storyboard.findUnique({ where: { projectId_version: { projectId: project.id, version: v } }, select: { id: true } }))) throw new NotFoundError(`Storyboard version of ${project.slug}`, `v${v}`);
    return loadStoryboardView(this.viewDeps, project, v);
  }

  /** What a new storyboard would be planned from (the presets are made at the library's first use). */
  async inputs(projectRef: string): Promise<StoryboardInputsView> {
    const project = await this.project(projectRef);
    await ensurePresets(this.db);
    return loadStoryboardInputs(this.viewDeps, project);
  }

  /** The project page's storyboard card (null: no version yet). */
  summary(projectId: string): Promise<StoryboardSummaryView | null> {
    return storyboardSummary(this.db, projectId, this.deps.catalog);
  }

  /** The visual catalog: methods, cards, models and rates with their sources (no client, nothing priced live). */
  catalog(): VisualCatalogView {
    return describeVisualCatalog(this.deps.catalog);
  }

  // ── The visual profile library ─────────────────────────────────────────────

  private get profileDeps() {
    return { db: this.db, catalog: this.deps.catalog };
  }

  /** The library (its five presets made at its first use). */
  async library(opts: { archived: boolean }, actor = 'system'): Promise<VisualProfileLibraryView> {
    await ensurePresets(this.db, actor);
    return loadVisualLibrary(this.profileDeps, opts);
  }

  async profileHistory(familyId: string): Promise<VisualProfileHistoryView> {
    const view = await loadVisualProfileHistory(this.profileDeps, familyId);
    if (!view) throw new NotFoundError('Visual profile', familyId);
    return view;
  }

  async createProfile(input: CreateVisualProfileFamilyInput, actor: string): Promise<{ familyId: string; versionId: string }> {
    return wrap(async () => {
      const v = await createVisualProfileFamily(this.db, input, actor);
      return { familyId: v.familyId, versionId: v.id };
    });
  }

  async newProfileVersion(familyId: string, input: NewVisualProfileVersionInput, actor: string): Promise<{ familyId: string; versionId: string; version: number }> {
    return wrap(async () => {
      const v = await newVisualProfileVersion(this.db, familyId, input, actor);
      return { familyId: v.familyId, versionId: v.id, version: v.version };
    });
  }

  async duplicateProfile(familyId: string, input: DuplicateVisualProfileInput, actor: string): Promise<{ familyId: string; versionId: string }> {
    return wrap(async () => {
      const v = await duplicateVisualProfile(this.db, familyId, input, actor);
      return { familyId: v.familyId, versionId: v.id };
    });
  }

  async updateProfileFamily(familyId: string, input: UpdateVisualProfileFamilyInput): Promise<{ familyId: string }> {
    return wrap(async () => ({ familyId: (await updateVisualProfileFamily(this.db, familyId, input)).id }));
  }

  /** What a project's storyboards are planned with now (the presets made at the library's first use). */
  async production(projectRef: string): Promise<VisualProductionView> {
    const project = await this.project(projectRef);
    await ensurePresets(this.db);
    return loadVisualProduction(this.profileDeps, project.id);
  }

  /** A project's choice of visual profile and its overrides (409 when changed in another tab). */
  async setSelection(projectRef: string, input: VisualSelectionInput, actor: string): Promise<{ revision: number }> {
    return wrap(async () => {
      const project = await this.project(projectRef);
      await ensurePresets(this.db, actor);
      return { revision: (await setVisualSelection(this.db, project, input, actor)).revision };
    });
  }
}
