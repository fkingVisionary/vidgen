import { ApprovalInput, CreateProjectInput, EnqueueJobInput, RewindInput } from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { loadResearchView } from '../research-views.ts';
import { architecturePreflight } from '../story-views.ts';
import { findProject, listProjects, loadProjectDetail, toJobView } from '../views.ts';

const Params = z.object({ id: z.string().trim().min(1).max(100) });

export async function projectRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = Params.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  };
  const detail = async (id: string) => {
    const d = await loadProjectDetail(c.db, c.projects, id);
    if (!d) throw new NotFoundError('Project', id);
    return d;
  };

  app.get('/api/projects', async () => listProjects(c.db));

  app.post('/api/projects', async (req, reply) => {
    const input = CreateProjectInput.parse(req.body ?? {});
    const project = await c.projects.createProject(input, actorOf(req));
    return reply.code(201).send(await detail(project.id));
  });

  app.get('/api/projects/:id', async (req) => detail(Params.parse(req.params).id));

  /** Enqueue a pipeline job (may START the next phase, e.g. IDEA → RESEARCHING). */
  app.post('/api/projects/:id/jobs', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = EnqueueJobInput.parse(req.body ?? {});
    // Revisions and angle explorations have their own routes: they check the base version, the angle and the pack, and record the brief.
    if (input.type === 'STORY_ANGLES') throw new ConflictError('Use POST /api/projects/:id/story/angles to explore alternative angles');
    if (input.type === 'STORY_ARCHITECTURE' && input.input?.revise !== undefined) throw new ConflictError('Use POST /api/projects/:id/story/architecture/revise to revise an architecture');
    if (input.type === 'SCRIPT' && input.input?.revise !== undefined) throw new ConflictError('Use POST /api/projects/:id/script/revise to rewrite a script');
    // Real narration starts through the voice routes: they plan the run from the approved script and confirm its cost (a bare VOICE job has no run).
    if (input.type === 'VOICE' && c.realStages.includes('VOICE')) throw new ConflictError('Use POST /api/projects/:id/voice/runs to generate narration');
    // The real script stage starts through its own service: it checks for an approved architecture first.
    if (input.type === 'SCRIPT' && c.realStages.includes('SCRIPT')) {
      const notes = typeof input.input?.notes === 'string' ? input.input.notes : undefined;
      return reply.code(202).send(toJobView(await c.projects.generateScript(project.id, notes ? { notes } : {}, actorOf(req))));
    }
    // The real architecture stage needs a selection of 5–10 units: say so now rather than fail the job.
    if (input.type === 'STORY_ARCHITECTURE' && c.realStages.includes('STORY_ARCHITECTURE')) {
      const problem = await architecturePreflight(c.db, project.id);
      if (problem) throw new ConflictError(problem);
    }
    const job = await c.projects.enqueueJob(project.id, input, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });

  /** Record a human decision at the current approval gate. */
  app.post('/api/projects/:id/approvals', async (req, reply) => {
    const project = await requireProject(req.params);
    await c.projects.recordApproval(project.id, ApprovalInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(201).send(await detail(project.id));
  });

  /** Research dossier viewer: latest version, or ?version=N. */
  app.get('/api/projects/:id/research', async (req) => {
    const project = await requireProject(req.params);
    const { version } = z.object({ version: z.coerce.number().int().min(1).optional() }).parse(req.query ?? {});
    const view = await loadResearchView(c.db, project.id, version);
    if (!view) throw new NotFoundError('Research dossier version', String(version));
    return view;
  });

  /** Move the project back to an earlier status (e.g. re-open the script). */
  app.post('/api/projects/:id/rewind', async (req) => {
    const project = await requireProject(req.params);
    await c.projects.rewind(project.id, RewindInput.parse(req.body ?? {}), actorOf(req));
    return detail(project.id);
  });
}
