import { RestoreStoryboardInput, RetimeStoryboardInput, StoryboardEditInput, type StoryboardContent, type StoryboardOrigin, type StoryboardProvenance, type VisualCatalog, type VisualProfileSnapshot } from '@docengine/core';
import type { Database, Prisma, Tx } from '@docengine/database';
import { ConflictError, EVENT, NotFoundError, type ProjectService } from '@docengine/pipeline';
import { carryDecisions, requireNewest } from './decisions.ts';
import type { PlannedStoryboard, StoryboardDraft, StoryboardFacts } from './draft.ts';
import { applyEdits, EditError, versionChanges } from './edits.ts';
import { InputError, narrationInputs, versionFacts } from './inputs.ts';
import { planStoryboard } from './plan.ts';
import { productionSnapshot, resolveVisualProduction, VisualProfileError } from './profiles.ts';
import { contentOf, loadStoryboard, lockProject, saveVersion, usedShotKeys, type LoadedStoryboard } from './store.ts';

/**
 * Versions made without a model (§2.12): a person's edits, a re-timing onto
 * another assembly of the same run, and a restore of an older version.
 * Each is one transaction under the project's lock: the version the editor
 * worked from must still be the newest (else 409 with the newest number),
 * no storyboard job may be running, the base is copied keeping its keys,
 * the change is applied, the whole version is judged again (route, cost,
 * QA), and a new IN_REVIEW version is saved; the base is never touched.
 * Decisions on shots whose content and length did not change are carried.
 * A new version of an approved whole-script storyboard re-opens the
 * STORYBOARD gate; a preview never changes the project's status.
 */

export interface EditingDeps {
  db: Database;
  projects: ProjectService;
  catalog: VisualCatalog;
}

/** A refusal the editor can act on is a 409, with what to do. */
const refusal = (err: unknown): never => {
  if (err instanceof EditError || err instanceof InputError || err instanceof VisualProfileError) throw new ConflictError(err.message);
  throw err;
};

export interface MadeVersion {
  storyboardId: string;
  version: number;
  /** Shot decisions carried from the base. */
  carried: number;
}

/** What the new version is judged with, and how it came about. */
interface Change {
  origin: StoryboardOrigin;
  event: string;
  message: (v: number) => string;
  facts: StoryboardFacts;
  draft: StoryboardDraft;
  /** The base the version is made from (its decisions are carried, its line continued). */
  base: LoadedStoryboard;
  /** What the version is compared with in its changes (the base; for a restore, the newest version it replaces). */
  compared: { version: number; planned: PlannedStoryboard };
  provenance: Omit<StoryboardProvenance, 'origin' | 'baseVersion' | 'baseId' | 'approach'>;
  /** The planned version as it is (a restore copies it), else planned from the draft. */
  planned?: PlannedStoryboard;
  content?: (planned: PlannedStoryboard, inputs: Omit<StoryboardContent['inputs'], 'pricing'>, provenance: StoryboardProvenance) => StoryboardContent;
}

/** The project's storyboard job (one at a time): versions are not made while one runs. */
async function requireNoJob(deps: EditingDeps, tx: Tx, projectId: string): Promise<void> {
  const active = await deps.projects.activeStoryboardJob(tx, projectId);
  if (active) throw new ConflictError(`A storyboard job (${active.type}) is ${active.status.toLowerCase()}: wait for it to finish before changing the storyboard`);
}

/** Every shot and beat timed on the narration, or why not. */
function requireTimed(planned: PlannedStoryboard): void {
  const untimed = [...planned.beats.filter((b) => b.startMs === null).map((b) => b.key), ...planned.shots.filter((s) => s.startMs === null || !s.timing).map((s) => s.key)];
  if (untimed.length) {
    const why = planned.qa.filter((f) => f.kind === 'TIMING_MISSING').map((f) => f.detail);
    throw new ConflictError(`${untimed.join(', ')} cannot be placed on the narration${why.length ? `: ${why.slice(0, 3).join('; ')}` : ''}`);
  }
}

/** Saves the version a change makes, in the caller's transaction. */
async function make(deps: EditingDeps, tx: Tx, change: Change, actor: string, extra: { pinned?: Partial<{ voiceAssemblyId: string; assemblyVersion: number; narrationFingerprint: string; visualProfileId: string }> } = {}): Promise<MadeVersion> {
  const { base, facts } = change;
  const row = base.row;
  const planned = change.planned ?? planStoryboard(change.draft, facts);
  requireTimed(planned);
  const narration = facts.spine.narration;
  const inputs: Omit<StoryboardContent['inputs'], 'pricing'> = {
    ...base.content.inputs,
    narration: narrationInputs(narration, facts.narrationApproval, { id: base.content.inputs.narration.languageVersionId, language: base.content.inputs.narration.language }),
    profile: facts.profile,
  };
  const provenance: StoryboardProvenance = { origin: change.origin, baseVersion: row.version, baseId: row.id, approach: planned.approach, ...change.provenance };
  const content = change.content ? change.content(planned, inputs, provenance) : contentOf(planned, { inputs, provenance, changes: versionChanges(change.compared.version, change.compared.planned, planned) });
  const saved = await saveVersion(tx, {
    projectId: row.projectId,
    status: 'IN_REVIEW',
    scope: row.scope,
    pins: {
      scriptId: row.scriptId,
      storyId: row.storyId,
      languageVersionId: row.languageVersionId,
      voiceRunId: row.voiceRunId,
      voiceAssemblyId: extra.pinned?.voiceAssemblyId ?? narration.assembly.id,
      assemblyVersion: extra.pinned?.assemblyVersion ?? narration.assembly.version,
      narrationFingerprint: extra.pinned?.narrationFingerprint ?? narration.assembly.fingerprint,
      visualProfileId: facts.profile.profileId,
    },
    revisionOfId: row.id,
    jobId: null,
    createdBy: actor,
    planned,
    content,
    supersede: true,
  });
  const carried = await carryDecisions(tx, { projectId: row.projectId, base, saved, planned });
  await tx.projectEvent.create({
    data: {
      projectId: row.projectId,
      type: change.event,
      message: change.message(saved.version),
      data: { actor, storyboardId: saved.id, version: saved.version, baseVersion: row.version, origin: change.origin, carriedDecisions: carried, ops: change.provenance.ops, note: change.provenance.note } as Prisma.InputJsonValue,
    },
  });
  if (saved.superseded.length) {
    await tx.projectEvent.create({
      data: {
        projectId: row.projectId,
        type: EVENT.STORYBOARD_SUPERSEDED,
        message: `Storyboard ${saved.superseded.map((s) => `v${s.version}`).join(', ')} superseded by v${saved.version} (kept, not changed)`,
        data: { actor, superseded: saved.superseded.map((s) => s.version), by: saved.version } as Prisma.InputJsonValue,
      },
    });
  }
  // A new version of an approved whole-script storyboard is reviewed at the gate again; the approved one stays approved until another is.
  if (row.scope === 'FULL') {
    const project = await tx.project.findUniqueOrThrow({ where: { id: row.projectId } });
    if (project.status === 'STORYBOARD_APPROVED') await deps.projects.reopenStoryboardReview(tx, project, actor, `Storyboard v${saved.version} (${change.origin.toLowerCase()} of v${row.version}) is to be reviewed`);
  }
  return { storyboardId: saved.id, version: saved.version, carried };
}

/** The version a request names, in the transaction (404 if not there). */
async function baseOf(tx: Tx, storyboardId: string): Promise<LoadedStoryboard> {
  const loaded = await loadStoryboard(tx, storyboardId);
  if (!loaded) throw new NotFoundError('Storyboard', storyboardId);
  return loaded;
}

/** The project of a version, locked; refused unless `expected` is still the newest version and no storyboard job runs. */
async function begin(deps: EditingDeps, tx: Tx, storyboardId: string, expected: number): Promise<LoadedStoryboard> {
  const head = await tx.storyboard.findUnique({ where: { id: storyboardId }, select: { projectId: true } });
  if (!head) throw new NotFoundError('Storyboard', storyboardId);
  await lockProject(tx, head.projectId);
  await requireNewest(tx, head.projectId, expected);
  await requireNoJob(deps, tx, head.projectId);
  return baseOf(tx, storyboardId);
}

const TX = { timeout: 60_000 };

/**
 * A person's edits of a version, in order: a new version (no model call).
 * setProfile re-snapshots the project's visual profile (at the revision the
 * editor saw) and re-costs; nothing else of the shots changes.
 */
export async function editStoryboard(deps: EditingDeps, storyboardId: string, raw: StoryboardEditInput, actor: string): Promise<MadeVersion> {
  const input = StoryboardEditInput.parse(raw);
  return deps.db
    .$transaction(async (tx) => {
      const base = await begin(deps, tx, storyboardId, input.expectedVersion);
      let profile: VisualProfileSnapshot = base.content.inputs.profile;
      const setProfile = input.ops.filter((o) => o.op === 'setProfile');
      if (setProfile.length) {
        const production = await resolveVisualProduction(tx, base.row.projectId, { create: true, actor });
        const asked = setProfile.at(-1)!.selectionRevision;
        if (asked !== production.revision) throw new ConflictError(`The project's visual profile changed since you chose it (revision ${asked}, now ${production.revision}): reload and choose again`);
        profile = productionSnapshot(production);
      }
      const facts = await versionFacts(tx, base.row, { catalog: deps.catalog, profile });
      const { draft } = applyEdits(base.draft, input.ops, facts, { alternatives: base.content.alternatives, usedShotKeys: await usedShotKeys(tx, base.row.projectId) });
      const origin: StoryboardOrigin = input.ops.every((o) => o.op === 'setProfile') ? 'PROFILE' : 'EDIT';
      return make(deps, tx, {
        origin,
        event: EVENT.STORYBOARD_EDITED,
        message: (v) => `Storyboard v${v}: ${input.ops.length} edit(s) of v${base.row.version}${input.note ? ` — ${input.note}` : ''}`,
        facts,
        draft,
        base,
        compared: { version: base.row.version, planned: base.planned },
        provenance: { beatKeys: [], ops: input.ops, note: input.note ?? null, requestedBy: actor, jobId: null, models: {}, promptVersion: null },
      }, actor);
    }, TX)
    .catch(refusal);
}

/**
 * The same plan on another assembly of the same run (after a take was
 * regenerated or restored): times recomputed from the word anchors, no
 * model call. Refused when the assembly is another run's, or when an
 * anchor no longer falls on a cut point of the new narration.
 */
export async function retimeStoryboard(deps: EditingDeps, storyboardId: string, raw: RetimeStoryboardInput, actor: string): Promise<MadeVersion> {
  const input = RetimeStoryboardInput.parse(raw);
  return deps.db
    .$transaction(async (tx) => {
      const base = await begin(deps, tx, storyboardId, input.expectedVersion);
      const assembly = await tx.voiceAssembly.findUnique({ where: { id: input.assemblyId }, select: { id: true, runId: true, scriptId: true, version: true } });
      if (!assembly) throw new NotFoundError('Assembly', input.assemblyId);
      if (assembly.runId !== base.row.voiceRunId || assembly.scriptId !== base.row.scriptId) throw new ConflictError(`Assembly v${assembly.version} is not an assembly of the voice run and script v${base.row.version} is timed on: a storyboard is re-timed only within its run`);
      if (assembly.id === base.row.voiceAssemblyId) throw new ConflictError(`v${base.row.version} is already timed on assembly v${assembly.version}`);
      const facts = await versionFacts(tx, base.row, { catalog: deps.catalog, profile: base.content.inputs.profile, assemblyId: assembly.id });
      const draft: StoryboardDraft = { ...structuredClone(base.draft), normalization: [] };
      return make(deps, tx, {
        origin: 'RETIME',
        event: EVENT.STORYBOARD_SAVED,
        message: (v) => `Storyboard v${v}: v${base.row.version} re-timed onto assembly v${assembly.version} (no model call)`,
        facts,
        draft,
        base,
        compared: { version: base.row.version, planned: base.planned },
        provenance: { beatKeys: [], ops: [], note: `Re-timed from assembly v${base.row.assemblyVersion ?? '?'} to v${assembly.version}`, requestedBy: actor, jobId: null, models: {}, promptVersion: null },
      }, actor);
    }, TX)
    .catch(refusal);
}

/**
 * An older version made current again as a new version: its rows copied as
 * they were saved (times, classes, evidence, costs, QA), the history
 * untouched. Shot decisions carry from the restored version; its own
 * version-level decision does not.
 */
export async function restoreStoryboard(deps: EditingDeps, storyboardId: string, raw: RestoreStoryboardInput, actor: string): Promise<MadeVersion> {
  const input = RestoreStoryboardInput.parse(raw);
  return deps.db
    .$transaction(async (tx) => {
      const base = await begin(deps, tx, storyboardId, input.expectedVersion);
      if (base.row.version === input.expectedVersion) throw new ConflictError(`v${base.row.version} is already the newest version`);
      const newest = await tx.storyboard.findFirstOrThrow({ where: { projectId: base.row.projectId, version: input.expectedVersion }, select: { id: true } });
      const replaced = (await loadStoryboard(tx, newest.id))!;
      let facts: StoryboardFacts;
      try {
        facts = await versionFacts(tx, base.row, { catalog: deps.catalog, profile: base.content.inputs.profile });
      } catch (err) {
        if (err instanceof InputError) throw new ConflictError(`v${base.row.version} cannot be restored: ${err.message}`);
        throw err;
      }
      return make(
        deps,
        tx,
        {
          origin: 'RESTORE',
          event: EVENT.STORYBOARD_RESTORED,
          message: (v) => `Storyboard v${v}: v${base.row.version} restored (a copy; v${replaced.row.version} and the history are kept)`,
          facts,
          draft: base.draft,
          base,
          compared: { version: replaced.row.version, planned: replaced.planned },
          planned: base.planned,
          provenance: { beatKeys: [], ops: [], note: `Restored v${base.row.version}`, requestedBy: actor, jobId: null, models: base.content.provenance.models, promptVersion: base.content.provenance.promptVersion },
          // A copy: what it was planned from stays its own (the narration's approval and takes as they are now).
          content: (planned, inputs, provenance) => ({ ...base.content, inputs: { ...base.content.inputs, narration: inputs.narration }, provenance, changes: versionChanges(replaced.row.version, replaced.planned, planned) }),
        },
        actor,
        { pinned: { voiceAssemblyId: base.row.voiceAssemblyId ?? undefined, assemblyVersion: base.row.assemblyVersion ?? undefined, narrationFingerprint: base.row.narrationFingerprint ?? undefined } },
      );
    }, TX)
    .catch(refusal);
}
