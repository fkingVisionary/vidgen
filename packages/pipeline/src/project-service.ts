import {
  CreateProjectInput,
  STATUS_DEFINITIONS,
  UpdateStoryCandidateInput,
  assertTransition,
  getTransitionKind,
  jobPhase,
  resolveApproval,
  resolveEnqueue,
  startsNewPhaseRun,
  type ApprovalInput,
  type EnqueueJobInput,
  type JobType,
  type ProjectStatus,
  type RewindInput,
  type TransitionKind,
} from '@docengine/core';
import type { Approval, Database, Job, Prisma, Project, StoryCandidate, Tx } from '@docengine/database';
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
      const changes = [
        status !== c.status ? `${c.status} → ${status}` : null,
        selected !== c.selected ? (selected ? 'selected' : 'deselected') : null,
        priority !== c.priority ? `priority ${priority}` : null,
        editorNotes !== c.editorNotes ? 'notes updated' : null,
      ].filter((x): x is string => x !== null);
      const updated = await tx.storyCandidate.update({ where: { id: candidateId }, data: { status, selected, priority, editorNotes } });
      if (changes.length > 0) {
        await this.event(tx, project.id, EVENT.CANDIDATE_UPDATED, `${c.candidateKey} "${c.title}": ${changes.join(', ')}`, {
          actor,
          candidateId,
          status,
          selected,
          priority,
          editorNotes,
        });
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
