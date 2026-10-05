import { GenerateScriptInput, ReorderScriptBlocksInput, RestoreScriptInput, ReviewScriptSectionInput, ReviseScriptInput, UpdateScriptBlockInput } from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { loadScriptCompare, loadScriptView, loadVoicePlan, ownerOfBlock, ownerOfSection } from '../script-views.ts';
import { findProject, toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const IdParams = z.object({ id: z.uuid() });
const Version = z.coerce.number().int().min(1);

/**
 * The script: the read model, writing a draft, rewriting sections or the
 * whole script, the editor's edits (blocks, order, section decisions),
 * restoring an earlier version, comparing versions and the voice plan.
 * Approval goes through the generic approvals route (gate SCRIPT).
 */
export async function scriptRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = ProjectParams.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  };
  const realStage = () => c.realStages.includes('SCRIPT');
  const requireReal = () => {
    if (!realStage()) throw new ConflictError('The script stage is a MOCK here: writing a script needs the real AI provider (AI_PROVIDER=anthropic)');
  };
  /** The script view of one version, after a change to it. */
  const viewOf = async (projectId: string, version: number) => {
    const project = await c.db.project.findUniqueOrThrow({ where: { id: projectId } });
    return loadScriptView(c.db, project, { version }, realStage());
  };

  /** Latest script version, or ?version=N. */
  app.get('/api/projects/:id/script', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ version: Version.optional() }).parse(req.query ?? {});
    const view = await loadScriptView(c.db, project, q, realStage());
    if (!view) throw new NotFoundError('Script', `v${q.version}`);
    return view;
  });

  /** Write a draft from the approved architecture. */
  app.post('/api/projects/:id/script', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = GenerateScriptInput.parse(req.body ?? {});
    requireReal();
    const job = await c.projects.generateScript(project.id, input, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });

  /** Rewrite chosen sections (the rest copied unchanged), or the whole script, from the editor's brief: a new version. */
  app.post('/api/projects/:id/script/revise', async (req, reply) => {
    const project = await requireProject(req.params);
    const input = ReviseScriptInput.parse(req.body ?? {});
    requireReal();
    const job = await c.projects.reviseScript(project.id, input, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });

  /** Make an earlier version current again, as a new version (no model calls). */
  app.post('/api/projects/:id/script/restore', async (req) => {
    const project = await requireProject(req.params);
    const { version } = await c.scripts.restore(project.id, RestoreScriptInput.parse(req.body ?? {}), actorOf(req));
    return viewOf(project.id, version);
  });

  /** Compare two versions section by section: ?a=1&b=2. */
  app.get('/api/projects/:id/script/compare', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ a: Version, b: Version }).parse(req.query ?? {});
    const view = await loadScriptCompare(c.db, project.id, q.a, q.b);
    if (!view) throw new NotFoundError('Script versions', `v${q.a}/v${q.b}`);
    return view;
  });

  /** What the planned voice provider would receive for a version (read only: no audio is generated). */
  app.get('/api/projects/:id/script/voice-plan', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ version: Version.optional() }).parse(req.query ?? {});
    const plan = await loadVoicePlan(c.db, project.id, q.version);
    if (!plan) throw new NotFoundError('Script', q.version ? `v${q.version}` : 'latest');
    return plan;
  });

  /** The editor's change to one block of the version under review. Returns the updated script view. */
  app.patch('/api/script-blocks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = UpdateScriptBlockInput.parse(req.body ?? {});
    const owner = await ownerOfBlock(c.db, id);
    if (!owner) throw new NotFoundError('Script block', id);
    await c.scripts.editBlock(id, input, actorOf(req));
    return viewOf(owner.script.projectId, owner.script.version);
  });

  /** The editor's order of one section's blocks. */
  app.put('/api/script-sections/:id/order', async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = ReorderScriptBlocksInput.parse(req.body ?? {});
    const owner = await ownerOfSection(c.db, id);
    if (!owner) throw new NotFoundError('Script section', id);
    await c.scripts.reorderBlocks(id, input, actorOf(req));
    return viewOf(owner.script.projectId, owner.script.version);
  });

  /** Approve or reject a section, or note what to change. */
  app.patch('/api/script-sections/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = ReviewScriptSectionInput.parse(req.body ?? {});
    const owner = await ownerOfSection(c.db, id);
    if (!owner) throw new NotFoundError('Script section', id);
    await c.scripts.reviewSection(id, input, actorOf(req));
    return viewOf(owner.script.projectId, owner.script.version);
  });
}
