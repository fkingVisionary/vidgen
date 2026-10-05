import { ContentPackageRequest, ExploreAnglesInput, ReorderSelectionInput, ReviseArchitectureInput, StoryJobInput, UpdateContentOpportunityInput, UpdateStoryCandidateInput } from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { anglePreflight, architecturePreflight, loadContentPackage, loadStoryView, toOpportunityView } from '../story-views.ts';
import { findProject, toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const CandidateParams = z.object({ id: z.uuid() });
const OpportunityParams = z.object({ id: z.uuid() });

/** Query-string form of a content package request: ?documentary=true&shorts=6&languages=en,es,de */
const PackageQuery = z.object({
  documentary: z.enum(['true', 'false']).optional(),
  shorts: z.string().regex(/^(all|\d{1,2})$/).optional(),
  languages: z.string().max(200).optional(),
});

/**
 * Story mining and architecture: the read model, the editor's controls over
 * candidates, another mining pass, and building the architecture. Approval
 * goes through the generic approvals route (gate STORY).
 */
export async function storyRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = ProjectParams.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  };

  /** Latest pack, architecture and angle exploration, or ?pack=N / ?architecture=M / ?exploration=E. */
  app.get('/api/projects/:id/story', async (req) => {
    const project = await requireProject(req.params);
    const q = z
      .object({ pack: z.coerce.number().int().min(1).optional(), architecture: z.coerce.number().int().min(1).optional(), exploration: z.coerce.number().int().min(1).optional() })
      .parse(req.query ?? {});
    const view = await loadStoryView(c.db, project, q, c.realStages);
    if (!view) throw new NotFoundError('Story version', `${q.pack ?? ''}/${q.architecture ?? ''}/${q.exploration ?? ''}`);
    return view;
  });
  const fresh = (projectId: string) => c.db.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true, status: true, failedFromStatus: true } });

  /** The editor's decision on one candidate: status, selection, priority, notes, title, narrative mode, central question, POV. Returns the updated story view. */
  app.patch('/api/story-candidates/:id', async (req) => {
    const { id } = CandidateParams.parse(req.params);
    const updated = await c.projects.editStoryCandidate(id, UpdateStoryCandidateInput.parse(req.body ?? {}), actorOf(req));
    return loadStoryView(c.db, await fresh(updated.projectId), {}, c.realStages);
  });

  /**
   * Run Story Mining: the first pass (from RESEARCH_COMPLETE), or another pass
   * with the editor's brief (rewinds a later story status to STORY_MINING).
   */
  app.post('/api/projects/:id/story/mine', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = StoryJobInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const job =
      project.status === 'RESEARCH_COMPLETE' || project.status === 'STORY_MINING'
        ? await c.projects.enqueueJob(project.id, { type: 'STORY_MINING', input }, actor)
        : await c.projects.restartPhase(project.id, 'STORY_MINING', input, actor, input.notes ? `Another story-mining pass: ${input.notes}` : 'Another story-mining pass');
    return reply.code(202).send(toJobView(job));
  });

  /** The editor's order of the selected units (exactly the current selection). Returns the updated story view. */
  app.put('/api/projects/:id/story/selection-order', async (req) => {
    const project = await requireProject(req.params);
    await c.projects.reorderStorySelection(project.id, ReorderSelectionInput.parse(req.body ?? {}), actorOf(req));
    return loadStoryView(c.db, await fresh(project.id), {}, c.realStages);
  });

  /** The editor's decision on one content opportunity: approve, reject (or back to proposed), notes. */
  app.patch('/api/content-opportunities/:id', async (req) => {
    const { id } = OpportunityParams.parse(req.params);
    const updated = await c.projects.editContentOpportunity(id, UpdateContentOpportunityInput.parse(req.body ?? {}), actorOf(req));
    const row = await c.db.contentOpportunity.findUniqueOrThrow({
      where: { id: updated.id },
      include: { claims: { select: { claimId: true } }, architecture: { select: { version: true, status: true } } },
    });
    return toOpportunityView(row);
  });

  /**
   * The content package a production request would use — the approved long-form
   * documentary and the top approved short opportunities. Read-only: nothing is
   * generated. GET takes ?documentary=true&shorts=6&languages=en,es; POST takes
   * the same request as JSON ({"documentary": true, "shorts": 6, "languages": ["en","es"]}).
   */
  app.get('/api/projects/:id/content-package', async (req) => {
    const project = await requireProject(req.params);
    const q = PackageQuery.parse(req.query ?? {});
    const request = ContentPackageRequest.parse({
      ...(q.documentary ? { documentary: q.documentary === 'true' } : {}),
      ...(q.shorts ? { shorts: q.shorts === 'all' ? 'all' : Number(q.shorts) } : {}),
      ...(q.languages ? { languages: q.languages.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    });
    return loadContentPackage(c.db, project, request);
  });
  app.post('/api/projects/:id/content-package', async (req) => {
    const project = await requireProject(req.params);
    return loadContentPackage(c.db, project, ContentPackageRequest.parse(req.body ?? {}));
  });

  /** Generate the story architecture from the current selection (checked first: 5–10 units), optionally on an explored angle. */
  app.post('/api/projects/:id/story/architecture', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = StoryJobInput.parse(req.body ?? {});
    if (input.revise) throw new ConflictError('Use POST /api/projects/:id/story/architecture/revise to revise an architecture');
    if (c.realStages.includes('STORY_ARCHITECTURE')) {
      const problem = (await architecturePreflight(c.db, project.id)) ?? (input.angle ? await anglePreflight(c.db, project.id, input.angle) : null);
      if (problem) throw new ConflictError(problem);
    }
    const job = await c.projects.enqueueJob(project.id, { type: 'STORY_ARCHITECTURE', input }, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });

  /**
   * Reconsider / revise an architecture: the architect revises version
   * `baseVersion` from the editor's brief (what is not working), using only
   * the story pack and the approved dossier; both reviewers run again; the
   * result is a new version and every earlier version is kept.
   */
  app.post('/api/projects/:id/story/architecture/revise', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = ReviseArchitectureInput.parse(req.body ?? {});
    if (!c.realStages.includes('STORY_ARCHITECTURE')) throw new ConflictError('Story architecture is a MOCK stage here: revisions need the real story engine');
    const job = await c.projects.reviseArchitecture(project.id, input, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });

  /** Explore 2–3 materially different narrative angles from the current story pack (a side job: the project's status does not change). */
  app.post('/api/projects/:id/story/angles', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = ExploreAnglesInput.parse(req.body ?? {});
    if (!c.realStages.includes('STORY_ANGLES')) throw new ConflictError('Angle exploration needs the real story engine (it is a MOCK stage here)');
    const job = await c.projects.exploreAngles(project.id, input, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });
}
