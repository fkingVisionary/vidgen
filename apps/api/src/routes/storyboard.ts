import {
  GenerateStoryboardInput,
  RegenerateBeatsInput,
  RestoreStoryboardInput,
  RetimeStoryboardInput,
  ShotDecisionInput,
  StoryboardDecisionInput,
  StoryboardEditInput,
  SwitchApproachInput,
  type StoryboardInputsView,
  type StoryboardView,
} from '@docengine/core';
import { NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const IdParams = z.object({ id: z.uuid() });
const VersionQuery = z.object({ v: z.coerce.number().int().min(1).optional() });

/**
 * The storyboard: the page's read model, what a new storyboard would be
 * planned from, planning one (a preview of a voice run's narration, or the
 * phase job on the narration the VOICE gate approved), re-planning chosen
 * beats or another approach — each a paid planning job, confirmed by the
 * request — and, with no model call, edits, re-timing and restores (each a
 * new version; the old ones are never changed), and people's decisions on
 * versions and shots. A whole-script version under review is decided at the
 * STORYBOARD gate (also through the generic approvals route, with
 * `artifactId`). Nothing here generates, renders or stores a visual.
 */
export async function storyboardRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  /** The page at one version, after a change made to or from it. */
  const viewOf = async (storyboardId: string): Promise<StoryboardView> => {
    const row = await c.db.storyboard.findUnique({ where: { id: storyboardId }, select: { projectId: true, version: true } });
    if (!row) throw new NotFoundError('Storyboard', storyboardId);
    return c.storyboards.view(row.projectId, row.version);
  };

  /** The newest version, or ?v=N. */
  app.get('/api/projects/:id/storyboard', async (req): Promise<StoryboardView> => {
    const { id } = ProjectParams.parse(req.params);
    const q = VersionQuery.parse(req.query ?? {});
    return c.storyboards.view(id, q.v);
  });

  /** What a new storyboard would be planned from: the approved script, the voice runs and their assemblies, the visual profile, the ceiling. */
  app.get('/api/projects/:id/storyboard/inputs', async (req): Promise<StoryboardInputsView> => {
    const { id } = ProjectParams.parse(req.params);
    return c.storyboards.inputs(id);
  });

  /** Plan a storyboard of a voice run's narration: a preview, or the phase job (as the narration and the project's status decide). */
  app.post('/api/projects/:id/storyboard/generate', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    const input = GenerateStoryboardInput.parse(req.body ?? {});
    const r = await c.storyboards.generate(id, input, actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), kind: r.kind, assemblyId: r.assemblyId });
  });

  /** Re-plan chosen beats of the newest version with the editor's instructions (the rest is copied). */
  app.post('/api/storyboards/:id/regenerate-beats', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = RegenerateBeatsInput.parse(req.body ?? {});
    const { job } = await c.storyboards.regenerateBeats(id, input, actorOf(req));
    return reply.code(202).send({ job: toJobView(job) });
  });

  /** Plan another approach from the newest version: only the beats whose treatment changes are re-planned. */
  app.post('/api/storyboards/:id/approach', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = SwitchApproachInput.parse(req.body ?? {});
    const { job } = await c.storyboards.switchApproach(id, input, actorOf(req));
    return reply.code(202).send({ job: toJobView(job) });
  });

  /** A person's edits of the newest version: a new version (409 with `latestVersion` when another was saved since). */
  app.post('/api/storyboards/:id/edits', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = StoryboardEditInput.parse(req.body ?? {});
    const made = await c.storyboards.edit(id, input, actorOf(req));
    return reply.code(201).send(await viewOf(made.storyboardId));
  });

  /** The same plan on another assembly of its voice run (times from the word anchors): a new version. */
  app.post('/api/storyboards/:id/retime', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = RetimeStoryboardInput.parse(req.body ?? {});
    const made = await c.storyboards.retime(id, input, actorOf(req));
    return reply.code(201).send(await viewOf(made.storyboardId));
  });

  /** An older version made current again, as a new version (the history is kept). */
  app.post('/api/storyboards/:id/restore', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = RestoreStoryboardInput.parse(req.body ?? {});
    const made = await c.storyboards.restore(id, input, actorOf(req));
    return reply.code(201).send(await viewOf(made.storyboardId));
  });

  /** Approve, reject or request changes on a version (a whole-script version under review goes through the STORYBOARD gate). */
  app.post('/api/storyboards/:id/decision', async (req): Promise<StoryboardView> => {
    const { id } = IdParams.parse(req.params);
    const input = StoryboardDecisionInput.parse(req.body ?? {});
    const r = await c.storyboards.decide(id, input, actorOf(req));
    return viewOf(r.storyboardId);
  });

  /** Approve, reject or clear one shot: a new decision; the version's content is unchanged. */
  app.post('/api/shots/:id/decision', async (req): Promise<StoryboardView> => {
    const { id } = IdParams.parse(req.params);
    const input = ShotDecisionInput.parse(req.body ?? {});
    const r = await c.storyboards.decideShot(id, input, actorOf(req));
    return viewOf(r.storyboardId);
  });
}
