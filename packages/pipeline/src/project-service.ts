import {
  CandidateOverrides,
  CreateProjectInput,
  ExploreAnglesInput,
  ReorderSelectionInput,
  ReviseArchitectureInput,
  STATUS_DEFINITIONS,
  StoryExplorationContent,
  UpdateContentOpportunityInput,
  UpdateStoryCandidateInput,
  assertTransition,
  getTransitionKind,
  isSideJob,
  jobPhase,
  resolveApproval,
  resolveEnqueue,
  selectionProblem,
  startsNewPhaseRun,
  type AngleRef,
  type ApprovalInput,
  type EnqueueJobInput,
  type JobType,
  type ProjectStatus,
  type RewindInput,
  type TransitionKind,
} from '@docengine/core';
import type { Approval, ContentOpportunity, Database, Job, Prisma, Project, StoryCandidate, Tx } from '@docengine/database';
import { ConflictError, NotFoundError } from './errors.ts';
import { EVENT } from './events.ts';
import { silentLogger, type Logger } from './logger.ts';

export interface ProjectServiceOptions {
  db: Database;
  logger?: Logger;
  /** Default max attempts for new jobs. */
  jobMaxAttempts?: number;
  /** Called after a job is committed as QUEUED (lets a queue transport wake workers). */
  onJobQueued?: (job: Job) => void | Promise<void>;
}

/** Who performed an action, recorded on events and approvals. */
export type Actor = string;

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'project';
}

/**
 * The only code that changes a project's status. Every operation runs in a
 * transaction that first locks the project row, so concurrent API requests
 * and workers cannot interleave transitions on the same project.
 */
export class ProjectService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly jobMaxAttempts: number;
  private readonly onJobQueued: ProjectServiceOptions['onJobQueued'];

  constructor(opts: ProjectServiceOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    this.jobMaxAttempts = opts.jobMaxAttempts ?? 3;
    this.onJobQueued = opts.onJobQueued;
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  async createProject(
    raw: CreateProjectInput,
    actor: Actor,
    extra: { slug?: string; metadata?: Prisma.InputJsonValue } = {},
  ): Promise<Project> {
    const input = CreateProjectInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const slug = await this.uniqueSlug(tx, extra.slug ?? slugify(input.title));
      const project = await tx.project.create({
        data: {
          slug,
          title: input.title,
          workingTitle: input.workingTitle ?? null,
          topic: input.topic,
          description: input.description ?? null,
          category: input.category ?? null,
          style: input.style ?? null,
          targetMinutesMin: input.targetMinutesMin,
          targetMinutesMax: input.targetMinutesMax,
          masterLanguage: input.masterLanguage,
          metadata: extra.metadata ?? {},
          // The master language version exists from day one: nothing assumes a single language.
          languageVersions: { create: { language: input.masterLanguage, status: 'IN_PRODUCTION' } },
        },
      });
      await this.event(tx, project.id, EVENT.PROJECT_CREATED, `Project "${project.title}" created`, { actor });
      return project;
    });
  }

  async enqueueJob(projectId: string, input: EnqueueJobInput, actor: Actor): Promise<Job> {
    const job = await this.db.$transaction(async (tx) => {
      let project = await this.lockProject(tx, projectId);
      const resolution = resolveEnqueue(project.status, input.type);
      if (!resolution.ok) throw new ConflictError(resolution.reason);

      const languageVersionId = await this.resolveLanguageVersionId(tx, project, input.languageVersionId);
      if (resolution.enterStatus) {
        project = await this.transition(tx, project, resolution.enterStatus, actor, `Started by enqueueing ${input.type}`);
      }
      return this.insertJob(tx, project, input.type, languageVersionId, (input.input ?? {}) as Prisma.InputJsonValue, actor);
    });
    await this.onJobQueued?.(job);
    return job;
  }

  /** Re-run a FAILED or CANCELLED job as a new job (the old row is kept as history). */
  async retryJob(jobId: string, actor: Actor): Promise<Job> {
    const job = await this.db.$transaction(async (tx) => {
      const old = await tx.job.findUnique({ where: { id: jobId } });
      if (!old) throw new NotFoundError('Job', jobId);
      if (old.status !== 'FAILED' && old.status !== 'CANCELLED') {
        throw new ConflictError(`Only FAILED or CANCELLED jobs can be retried (job is ${old.status})`);
      }
      let project = await this.lockProject(tx, old.projectId);
      if (isSideJob(old.type)) {
        // A side job runs again only where it may run; it never moves the project.
        const resolution = resolveEnqueue(project.status, old.type);
        if (!resolution.ok) throw new ConflictError(resolution.reason);
        return this.insertJob(tx, project, old.type, old.languageVersionId, old.input as Prisma.InputJsonValue, actor, old.id, old.checkpoint);
      }
      const phase = jobPhase(old.type);

      if (project.status === 'FAILED') {
        if (project.failedFromStatus !== phase || old.phaseSeq !== project.phaseSeq) {
          throw new ConflictError(`Project failed in ${project.failedFromStatus}; this ${old.type} job cannot recover it`);
        }
        project = await this.transition(tx, project, phase, actor, `Retrying ${old.type} job ${old.id}`);
      } else {
        const resolution = resolveEnqueue(project.status, old.type);
        if (!resolution.ok) throw new ConflictError(resolution.reason);
        if (resolution.enterStatus) project = await this.transition(tx, project, resolution.enterStatus, actor, `Retrying ${old.type}`);
      }
      // The retry inherits the failed job's saved progress, so it resumes instead of repeating paid work.
      return this.insertJob(tx, project, old.type, old.languageVersionId, old.input as Prisma.InputJsonValue, actor, old.id, old.checkpoint);
    });
    await this.onJobQueued?.(job);
    return job;
  }

  async recordApproval(projectId: string, input: ApprovalInput, actor: Actor): Promise<{ approval: Approval; project: Project }> {
    return this.db.$transaction(async (tx) => {
      let project = await this.lockProject(tx, projectId);
      const complete = await this.phaseJobsComplete(tx, project);
      const resolution = resolveApproval(project.status, input.gate, input.decision, { phaseJobsComplete: complete });
      if (!resolution.ok) throw new ConflictError(resolution.reason);

      // Attach the exact artifact version under review and record the decision on it.
      const decided = input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      let dossierId: string | null = null;
      let storyId: string | null = null;
      if (input.gate === 'RESEARCH') {
        const dossier = await tx.researchDossier.findFirst({ where: { projectId, status: 'IN_REVIEW' }, orderBy: { version: 'desc' } });
        if (dossier) {
          dossierId = dossier.id;
          if (input.decision !== 'FLAGGED') await tx.researchDossier.update({ where: { id: dossier.id }, data: { status: decided } });
        }
      } else if (input.gate === 'STORY') {
        const story = await tx.storyArchitecture.findFirst({ where: { projectId, status: 'IN_REVIEW' }, orderBy: { version: 'desc' } });
        if (story) {
          storyId = story.id;
          dossierId = story.dossierId;
          if (input.decision !== 'FLAGGED') await tx.storyArchitecture.update({ where: { id: story.id }, data: { status: decided } });
          // The selection it was built from is approved with it.
          if (input.decision === 'APPROVED' && story.packId) await tx.storyPack.update({ where: { id: story.packId }, data: { status: 'APPROVED' } });
          // One approved architecture at a time: an earlier approved version (e.g. the one a revision revised) is kept, superseded.
          if (input.decision === 'APPROVED') {
            const older = await tx.storyArchitecture.findMany({ where: { projectId, status: 'APPROVED', id: { not: story.id } }, select: { id: true, version: true } });
            if (older.length) {
              await tx.storyArchitecture.updateMany({ where: { id: { in: older.map((o) => o.id) } }, data: { status: 'SUPERSEDED' } });
              const versions = older.map((o) => `v${o.version}`).join(', ');
              await this.event(tx, projectId, EVENT.ARCHITECTURE_SUPERSEDED, `Approved architecture ${versions} superseded by approving v${story.version} (kept, not changed)`, { actor, superseded: older.map((o) => o.version), by: story.version });
            }
          }
        }
      }

      const approval = await tx.approval.create({
        data: {
          projectId,
          gate: input.gate,
          decision: input.decision,
          notes: input.notes ?? null,
          decidedBy: actor,
          projectStatus: project.status,
          dossierId,
          storyId,
        },
      });
      await this.event(tx, projectId, EVENT.APPROVAL_RECORDED, `${input.gate}: ${input.decision}`, {
        actor,
        approvalId: approval.id,
        notes: input.notes ?? null,
      });
      if (resolution.nextStatus) {
        project = await this.transition(tx, project, resolution.nextStatus, actor, `${input.gate} ${input.decision.toLowerCase()}`);
      }
      return { approval, project };
    });
  }

  /**
   * Run a phase again: rewind the project to the status that owns `type` (if
   * it is not already there) and enqueue the job, in one transaction. Used
   * for "another story-mining pass" from a later story status.
   */
  async restartPhase(projectId: string, type: JobType, input: Prisma.InputJsonValue, actor: Actor, reason: string): Promise<Job> {
    const job = await this.db.$transaction(async (tx) => {
      let project = await this.lockProject(tx, projectId);
      const phase = jobPhase(type);
      if (project.status !== phase) {
        const kind = getTransitionKind(project.status, phase, { failedFrom: project.failedFromStatus });
        if (kind !== 'REWIND') throw new ConflictError(`Cannot run ${type} again from ${project.status}`);
        project = await this.transition(tx, project, phase, actor, reason);
      }
      const languageVersionId = await this.resolveLanguageVersionId(tx, project);
      return this.insertJob(tx, project, type, languageVersionId, input, actor);
    });
    await this.onJobQueued?.(job);
    return job;
  }

  /**
   * Reconsider an architecture: enqueue a STORY_ARCHITECTURE job in which the
   * architect revises version `baseVersion` from the editor's brief, using only
   * the story pack and the approved dossier, and both reviewers run again on
   * the revision. Nothing is overwritten: the revision becomes a new version,
   * and the base keeps its content (it is superseded only once the revision
   * passes its gate, or — if approved — once the revision is approved).
   * From STORY_SELECTION this starts the architecture phase; from STORY_REVIEW
   * or STORY_APPROVED it goes back to it; after a failed architecture run it
   * recovers it.
   */
  async reviseArchitecture(projectId: string, raw: ReviseArchitectureInput, actor: Actor): Promise<Job> {
    const input = ReviseArchitectureInput.parse(raw);
    const job = await this.db.$transaction(async (tx) => {
      let project = await this.lockProject(tx, projectId);
      const failedArchitecture = project.status === 'FAILED' && project.failedFromStatus === 'STORY_ARCHITECTING';
      if (!['STORY_SELECTION', 'STORY_REVIEW', 'STORY_APPROVED'].includes(project.status) && !failedArchitecture) {
        throw new ConflictError(`An architecture can be revised during story selection or review, after approval, or after a failed architecture run (the project is ${project.status})`);
      }
      const base = await tx.storyArchitecture.findUnique({ where: { projectId_version: { projectId, version: input.baseVersion } }, select: { id: true, version: true, packId: true } });
      if (!base) throw new NotFoundError('Story architecture', `v${input.baseVersion}`);
      const problem = await this.storyPoolProblem(tx, projectId, base.packId, `Architecture v${base.version}`);
      if (problem) throw new ConflictError(problem);
      if (input.angle) await this.requireAngle(tx, projectId, base.packId!, input.angle);

      if (project.status !== 'STORY_ARCHITECTING') {
        const kind = getTransitionKind(project.status, 'STORY_ARCHITECTING', { failedFrom: project.failedFromStatus });
        if (kind !== 'START' && kind !== 'REWIND' && kind !== 'RECOVER') throw new ConflictError(`Cannot revise the architecture from ${project.status}`);
        project = await this.transition(tx, project, 'STORY_ARCHITECTING', actor, `Revising architecture v${base.version}`);
      }
      const languageVersionId = await this.resolveLanguageVersionId(tx, project);
      const jobInput = {
        notes: input.brief,
        revise: { baseVersion: base.version, aspects: [...new Set(input.aspects)] },
        ...(input.preferences ? { preferences: input.preferences } : {}),
        ...(input.angle ? { angle: input.angle } : {}),
      };
      const job = await this.insertJob(tx, project, 'STORY_ARCHITECTURE', languageVersionId, jobInput as Prisma.InputJsonValue, actor);
      await this.event(tx, projectId, EVENT.ARCHITECTURE_REVISION_REQUESTED, `Revision of architecture v${base.version} requested: ${input.brief.length > 160 ? `${input.brief.slice(0, 159)}…` : input.brief}`, { actor, baseVersion: base.version, aspects: jobInput.revise.aspects, brief: input.brief, angle: input.angle ?? null }, job.id);
      return job;
    });
    await this.onJobQueued?.(job);
    return job;
  }

  /**
   * Explore 2–3 alternative narrative angles from the current story pack (a
   * STORY_ANGLES side job): it never changes the project's status, and
   * commits to nothing.
   */
  async exploreAngles(projectId: string, raw: ExploreAnglesInput, actor: Actor): Promise<Job> {
    const input = ExploreAnglesInput.parse(raw);
    const job = await this.db.$transaction(async (tx) => {
      const project = await this.lockProject(tx, projectId);
      const resolution = resolveEnqueue(project.status, 'STORY_ANGLES');
      if (!resolution.ok) throw new ConflictError(resolution.reason);
      const pack = await tx.storyPack.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { id: true } });
      const problem = await this.storyPoolProblem(tx, projectId, pack?.id ?? null, 'The current story pack');
      if (problem) throw new ConflictError(problem);
      if (input.basedOnVersion !== undefined) {
        const base = await tx.storyArchitecture.findUnique({ where: { projectId_version: { projectId, version: input.basedOnVersion } }, select: { packId: true } });
        if (!base) throw new NotFoundError('Story architecture', `v${input.basedOnVersion}`);
        if (base.packId !== pack!.id) throw new ConflictError(`Architecture v${input.basedOnVersion} was built from an earlier story pack`);
      }
      const languageVersionId = await this.resolveLanguageVersionId(tx, project);
      const job = await this.insertJob(tx, project, 'STORY_ANGLES', languageVersionId, input as Prisma.InputJsonValue, actor);
      await this.event(tx, projectId, EVENT.ANGLES_REQUESTED, `${input.count} alternative angles requested${input.basedOnVersion ? ` (alternatives to architecture v${input.basedOnVersion})` : ''}`, { actor, notes: input.notes ?? null, count: input.count }, job.id);
      return job;
    });
    await this.onJobQueued?.(job);
    return job;
  }

  /** Why the units of `packId` cannot be used for a revision or angles now, or null. */
  private async storyPoolProblem(tx: Tx, projectId: string, packId: string | null, what: string): Promise<string | null> {
    const latest = await tx.storyPack.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { id: true, version: true, status: true } });
    if (!latest || !packId) return 'No story pack yet: run Story Mining first';
    if (latest.id !== packId) return `${what} was built from an earlier story pack; a newer mining pass (pack v${latest.version}) replaced it`;
    if (latest.status !== 'IN_REVIEW' && latest.status !== 'APPROVED') return `Story pack v${latest.version} is ${latest.status}`;
    const selected = await tx.storyCandidate.count({ where: { packId, selected: true, status: { not: 'REJECTED' } } });
    return selectionProblem(selected);
  }

  private async requireAngle(tx: Tx, projectId: string, packId: string, ref: AngleRef): Promise<void> {
    const exploration = await tx.storyExploration.findUnique({ where: { projectId_version: { projectId, version: ref.exploration } }, select: { packId: true, content: true } });
    if (!exploration) throw new NotFoundError('Angle exploration', String(ref.exploration));
    if (exploration.packId !== packId) throw new ConflictError(`Angle exploration ${ref.exploration} was made from another story pack`);
    const content = StoryExplorationContent.safeParse(exploration.content);
    if (!content.success || !content.data.angles.some((a) => a.key === ref.key)) throw new NotFoundError('Angle', `${ref.key} of exploration ${ref.exploration}`);
  }

  /**
   * The editor's decision on one story candidate: status, selection, priority,
   * notes. Allowed only while the project is in STORY_SELECTION and only on the
   * pack open for selection; every change is recorded on the activity log.
   */
  async editStoryCandidate(candidateId: string, raw: UpdateStoryCandidateInput, actor: Actor): Promise<StoryCandidate> {
    const input = UpdateStoryCandidateInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const found = await tx.storyCandidate.findUnique({ where: { id: candidateId }, select: { projectId: true } });
      if (!found) throw new NotFoundError('Story candidate', candidateId);
      const project = await this.lockProject(tx, found.projectId);
      if (project.status !== 'STORY_SELECTION') {
        throw new ConflictError(`Story candidates can be changed while the project is in STORY_SELECTION (it is ${project.status})`);
      }
      const c = await tx.storyCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: { pack: { select: { status: true, version: true } } } });
      if (c.pack.status !== 'IN_REVIEW') throw new ConflictError(`Story pack v${c.pack.version} is ${c.pack.status}; only the pack open for selection can be changed`);

      const status = input.status ?? c.status;
      let selected = input.selected ?? c.selected;
      if (status === 'REJECTED') {
        if (input.selected === true) throw new ConflictError('A rejected candidate cannot be selected');
        selected = false;
      }
      const priority = input.priority ?? c.priority;
      const editorNotes = input.editorNotes === undefined ? c.editorNotes : input.editorNotes || null;

      // Editorial overrides (Story Engine 2.0): the AI's values stay in their columns; null restores them.
      const before = CandidateOverrides.safeParse(c.editorOverrides ?? {});
      const overrides: CandidateOverrides = before.success ? { ...before.data } : {};
      const overrideChanges: string[] = [];
      const setOverride = <K extends keyof CandidateOverrides>(key: K, value: CandidateOverrides[K] | null | undefined, label: string) => {
        if (value === undefined) return;
        const old = JSON.stringify(overrides[key] ?? null);
        if (value === null) delete overrides[key];
        else overrides[key] = value;
        if (JSON.stringify(overrides[key] ?? null) !== old) overrideChanges.push(value === null ? `${label} reset to the AI's` : `${label} edited`);
      };
      setOverride('title', input.title, 'title');
      setOverride('narrativeMode', input.narrativeMode, 'narrative mode');
      setOverride('centralQuestion', input.centralQuestion, 'central question');
      setOverride('povStrategy', input.povStrategy, 'POV strategy');

      const changes = [
        status !== c.status ? `${c.status} → ${status}` : null,
        selected !== c.selected ? (selected ? 'selected' : 'deselected') : null,
        priority !== c.priority ? `priority ${priority}` : null,
        editorNotes !== c.editorNotes ? 'notes updated' : null,
        ...overrideChanges,
      ].filter((x): x is string => x !== null);
      const updated = await tx.storyCandidate.update({
        where: { id: candidateId },
        data: {
          status,
          selected,
          priority,
          editorNotes,
          ...(overrideChanges.length ? { editorOverrides: overrides as Prisma.InputJsonValue } : {}),
          // A candidate leaving the selection leaves the editor's order too.
          ...(!selected && c.selectionOrder !== null ? { selectionOrder: null } : {}),
        },
      });
      if (changes.length > 0) {
        await this.event(tx, project.id, EVENT.CANDIDATE_UPDATED, `${c.candidateKey} "${c.title}": ${changes.join(', ')}`, {
          actor,
          candidateId,
          status,
          selected,
          priority,
          editorNotes,
          editorOverrides: overrides,
        });
      }
      return updated;
    });
  }

  /** Set the editor's order of the selection. The ids must be exactly the selected, non-rejected candidates of the open pack. */
  async reorderStorySelection(projectId: string, raw: ReorderSelectionInput, actor: Actor): Promise<StoryCandidate[]> {
    const input = ReorderSelectionInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const project = await this.lockProject(tx, projectId);
      if (project.status !== 'STORY_SELECTION') {
        throw new ConflictError(`The selection can be reordered while the project is in STORY_SELECTION (it is ${project.status})`);
      }
      const pack = await tx.storyPack.findFirst({ where: { projectId, status: 'IN_REVIEW' }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
      if (!pack) throw new ConflictError('No story pack is open for selection');
      const selected = await tx.storyCandidate.findMany({ where: { packId: pack.id, selected: true, status: { not: 'REJECTED' } }, select: { id: true, candidateKey: true } });
      const ids = new Set(selected.map((c) => c.id));
      if (new Set(input.candidateIds).size !== input.candidateIds.length || input.candidateIds.length !== ids.size || input.candidateIds.some((id) => !ids.has(id))) {
        throw new ConflictError(`The order must list each of the ${ids.size} selected candidates exactly once`);
      }
      await tx.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selectionOrder: null } });
      for (const [i, id] of input.candidateIds.entries()) await tx.storyCandidate.update({ where: { id }, data: { selectionOrder: i + 1 } });
      const keyOf = new Map(selected.map((c) => [c.id, c.candidateKey]));
      const order = input.candidateIds.map((id) => keyOf.get(id)!);
      await this.event(tx, projectId, EVENT.SELECTION_REORDERED, `Selection order: ${order.join(', ')}`, { actor, packId: pack.id, order });
      return tx.storyCandidate.findMany({ where: { packId: pack.id, selected: true, status: { not: 'REJECTED' } }, orderBy: { selectionOrder: 'asc' } });
    });
  }

  /**
   * The editor's decision on one content opportunity. Allowed on the latest
   * architecture while it is under review or approved — a draft that failed
   * its gate (e.g. a failed revision) does not count; an opportunity is
   * eligible for production only once both it and its architecture are approved.
   */
  async editContentOpportunity(opportunityId: string, raw: UpdateContentOpportunityInput, actor: Actor): Promise<ContentOpportunity> {
    const input = UpdateContentOpportunityInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      const found = await tx.contentOpportunity.findUnique({ where: { id: opportunityId }, select: { projectId: true } });
      if (!found) throw new NotFoundError('Content opportunity', opportunityId);
      const project = await this.lockProject(tx, found.projectId);
      const o = await tx.contentOpportunity.findUniqueOrThrow({ where: { id: opportunityId }, include: { architecture: { select: { id: true, version: true, status: true } } } });
      const latest = await tx.storyArchitecture.findFirst({ where: { projectId: project.id, status: { not: 'DRAFT' } }, orderBy: { version: 'desc' }, select: { id: true } });
      if (latest?.id !== o.architectureId) throw new ConflictError(`Opportunity ${o.opportunityKey} belongs to architecture v${o.architecture.version}, which is no longer the latest`);
      if (o.architecture.status !== 'IN_REVIEW' && o.architecture.status !== 'APPROVED') {
        throw new ConflictError(`Architecture v${o.architecture.version} is ${o.architecture.status}; opportunities are decided while it is in review or approved`);
      }
      const status = input.status ?? o.status;
      const editorNotes = input.editorNotes === undefined ? o.editorNotes : input.editorNotes || null;
      const decided = status !== o.status;
      const updated = await tx.contentOpportunity.update({
        where: { id: opportunityId },
        data: { status, editorNotes, ...(decided ? { decidedBy: status === 'PROPOSED' ? null : actor, decidedAt: status === 'PROPOSED' ? null : new Date() } : {}) },
      });
      const changes = [decided ? `${o.status} → ${status}` : null, editorNotes !== o.editorNotes ? 'notes updated' : null].filter((x): x is string => x !== null);
      if (changes.length) {
        await this.event(tx, project.id, EVENT.OPPORTUNITY_UPDATED, `${o.opportunityKey} "${o.title}" (${o.format}): ${changes.join(', ')}`, { actor, opportunityId, status, editorNotes });
      }
      return updated;
    });
  }

  async rewind(projectId: string, input: RewindInput, actor: Actor): Promise<Project> {
    return this.db.$transaction(async (tx) => {
      const project = await this.lockProject(tx, projectId);
      const kind = assertTransition(project.status, input.to, { failedFrom: project.failedFromStatus });
      if (kind !== 'REWIND') throw new ConflictError(`${project.status} → ${input.to} is a ${kind}, not a rewind`);
      const updated = await this.transition(tx, project, input.to, actor, input.reason);
      if (input.to === 'STORY_SELECTION') {
        // Re-open the selection: the latest pack (approved with an architecture) becomes editable again.
        const pack = await tx.storyPack.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { id: true, status: true } });
        if (pack?.status === 'APPROVED') await tx.storyPack.update({ where: { id: pack.id }, data: { status: 'IN_REVIEW' } });
      }
      return updated;
    });
  }

  // ── Worker callbacks (called inside the runner's transaction) ─────────────

  /** A job succeeded: advance the project if this completed its phase. */
  async onJobSucceeded(tx: Tx, job: Job): Promise<void> {
    if (isSideJob(job.type)) return; // side jobs never move the project
    const project = await this.lockProject(tx, job.projectId);
    if (this.isStale(project, job)) {
      await this.event(tx, project.id, EVENT.JOB_IGNORED_STALE, `${job.type} finished after the project moved on; status unchanged`, {}, job.id);
      return;
    }
    if (project.status === 'FAILED') return; // a sibling job failed; recovery happens via retry

    const next = STATUS_DEFINITIONS[project.status].onJobsComplete;
    if (next && (await this.phaseJobsComplete(tx, project))) {
      await this.transition(tx, project, next, 'system', `All ${project.status} jobs succeeded`);
    } else if (next && STATUS_DEFINITIONS[project.status].requiresRealProviders && job.isMock) {
      await this.event(tx, project.id, EVENT.PHASE_BLOCKED_MOCK, `${job.type} ran with MOCK providers; ${project.status} → ${next} requires real providers`, {}, job.id);
    }
  }

  /** A job exhausted its attempts: fail the project if the job belongs to its current phase. */
  async onJobFailed(tx: Tx, job: Job): Promise<void> {
    if (isSideJob(job.type)) return; // a failed side job leaves the project where it is (the job shows the error)
    const project = await this.lockProject(tx, job.projectId);
    if (this.isStale(project, job) || project.status === 'FAILED') return;
    await this.transition(tx, project, 'FAILED', 'system', `${job.type} job failed: ${job.error ?? 'unknown error'}`);
  }

  /** Have all jobs of the current status succeeded in the current phase run? */
  async phaseJobsComplete(tx: Tx, project: Project): Promise<boolean> {
    const def = STATUS_DEFINITIONS[project.status];
    for (const type of def.jobs) {
      const done = await tx.job.findFirst({
        where: {
          projectId: project.id,
          type,
          phaseSeq: project.phaseSeq,
          status: 'SUCCEEDED',
          ...(def.requiresRealProviders ? { isMock: false } : {}),
        },
        select: { id: true },
      });
      if (!done) return false;
    }
    return true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private isStale(project: Project, job: Job): boolean {
    if (job.phaseSeq !== project.phaseSeq) return true;
    const phase = jobPhase(job.type);
    return project.status === 'FAILED' ? project.failedFromStatus !== phase : project.status !== phase;
  }

  private async lockProject(tx: Tx, projectId: string): Promise<Project> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Project', projectId);
    return tx.project.findUniqueOrThrow({ where: { id: projectId } });
  }

  private async transition(tx: Tx, project: Project, to: ProjectStatus, actor: Actor, reason: string): Promise<Project> {
    const kind: TransitionKind = assertTransition(project.status, to, { failedFrom: project.failedFromStatus });
    const newRun = startsNewPhaseRun(kind);
    const updated = await tx.project.update({
      where: { id: project.id },
      data: {
        status: to,
        statusChangedAt: new Date(),
        failedFromStatus: to === 'FAILED' ? project.status : null,
        ...(newRun ? { phaseSeq: { increment: 1 } } : {}),
      },
    });
    if (newRun) {
      // Queued work from the previous phase run is now obsolete.
      const cancelled = await tx.job.updateMany({
        where: { projectId: project.id, status: 'QUEUED', phaseSeq: { lt: updated.phaseSeq } },
        data: { status: 'CANCELLED', completedAt: new Date(), error: `Cancelled: project moved ${project.status} → ${to}` },
      });
      if (cancelled.count > 0) {
        await this.event(tx, project.id, EVENT.JOB_CANCELLED, `${cancelled.count} queued job(s) cancelled by ${kind.toLowerCase()}`, { actor });
      }
    }
    await this.event(tx, project.id, EVENT.STATUS_CHANGED, `${project.status} → ${to} (${kind})`, {
      from: project.status,
      to,
      kind,
      reason,
      actor,
    });
    this.logger.info({ projectId: project.id, from: project.status, to, kind, actor }, 'project status changed');
    return updated;
  }

  private async insertJob(
    tx: Tx,
    project: Project,
    type: JobType,
    languageVersionId: string | null,
    input: Prisma.InputJsonValue,
    actor: Actor,
    retryOf?: string,
    checkpoint?: Prisma.JsonValue | null,
  ): Promise<Job> {
    const active = await tx.job.findFirst({
      where: {
        projectId: project.id,
        type,
        languageVersionId,
        phaseSeq: project.phaseSeq,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      select: { id: true },
    });
    if (active) throw new ConflictError(`A ${type} job is already queued or running (${active.id})`);

    const job = await tx.job.create({
      data: {
        projectId: project.id,
        languageVersionId,
        type,
        phaseSeq: project.phaseSeq,
        maxAttempts: this.jobMaxAttempts,
        input,
        ...(checkpoint != null ? { checkpoint: checkpoint as Prisma.InputJsonValue } : {}),
      },
    });
    await this.event(tx, project.id, EVENT.JOB_QUEUED, `${type} job queued`, { actor, ...(retryOf ? { retryOf } : {}) }, job.id);
    return job;
  }

  private async resolveLanguageVersionId(tx: Tx, project: Project, requested?: string): Promise<string> {
    const lv = requested
      ? await tx.languageVersion.findFirst({ where: { id: requested, projectId: project.id } })
      : await tx.languageVersion.findUnique({ where: { projectId_language: { projectId: project.id, language: project.masterLanguage } } });
    if (!lv) throw new NotFoundError('Language version', requested ?? `${project.masterLanguage} (master)`);
    return lv.id;
  }

  private async uniqueSlug(tx: Tx, base: string): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!(await tx.project.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
    }
    throw new ConflictError(`Could not find a free slug for "${base}"`);
  }

  private async event(
    tx: Tx,
    projectId: string,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
    jobId?: string,
  ): Promise<void> {
    await tx.projectEvent.create({
      data: { projectId, type, message, data: data as Prisma.InputJsonValue, ...(jobId ? { jobId } : {}) },
    });
  }
}
