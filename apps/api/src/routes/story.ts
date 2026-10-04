import { StoryJobInput, UpdateStoryCandidateInput } from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { architecturePreflight, loadStoryView } from '../story-views.ts';
import { findProject, toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const CandidateParams = z.object({ id: z.uuid() });

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

  /** Latest pack and architecture, or ?pack=N / ?architecture=M. */
  app.get('/api/projects/:id/story', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ pack: z.coerce.number().int().min(1).optional(), architecture: z.coerce.number().int().min(1).optional() }).parse(req.query ?? {});
    const view = await loadStoryView(c.db, project, q);
    if (!view) throw new NotFoundError('Story version', `${q.pack ?? ''}/${q.architecture ?? ''}`);
    return view;
  });

  /** The editor's decision on one candidate: status, selection, priority, notes. Returns the updated story view. */
  app.patch('/api/story-candidates/:id', async (req) => {
    const { id } = CandidateParams.parse(req.params);
    const updated = await c.projects.editStoryCandidate(id, UpdateStoryCandidateInput.parse(req.body ?? {}), actorOf(req));
    const project = await c.db.project.findUniqueOrThrow({ where: { id: updated.projectId }, select: { id: true, status: true } });
    return loadStoryView(c.db, project);
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

  /** Generate the story architecture from the current selection (checked first: 5–10 units). */
  app.post('/api/projects/:id/story/architecture', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = StoryJobInput.parse(req.body ?? {});
    if (c.realStages.includes('STORY_ARCHITECTURE')) {
      const problem = await architecturePreflight(c.db, project.id);
      if (problem) throw new ConflictError(problem);
    }
    const job = await c.projects.enqueueJob(project.id, { type: 'STORY_ARCHITECTURE', input }, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });
}
