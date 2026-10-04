import { NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { JOB_VIEW_OMIT, toJobView } from '../views.ts';

const Params = z.object({ id: z.uuid() });

export async function jobRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  app.get('/api/jobs/:id', async (req) => {
    const { id } = Params.parse(req.params);
    const job = await c.db.job.findUnique({ where: { id }, omit: JOB_VIEW_OMIT });
    if (!job) throw new NotFoundError('Job', id);
    return toJobView(job);
  });

  /** Retry a FAILED/CANCELLED job (recovers a FAILED project when it is the job that failed it). */
  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const job = await c.projects.retryJob(id, actorOf(req));
    return reply.code(202).send(toJobView(job));
  });
}
