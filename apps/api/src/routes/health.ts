import type { HealthView } from '@docengine/core';
import { describeProviders } from '@docengine/providers';
import type { FastifyInstance } from 'fastify';
import type { AppContainer } from '../container.ts';
import { APP_VERSION } from '../version.ts';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

/** Public (no auth): used by Railway's deploy health check. Reveals no secrets. */
export async function healthRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    // Connectivity was checked once at startup; a check still running reads as not confirmed. Both waits run together.
    const [database, connectivity] = await Promise.all([
      withTimeout(c.db.$queryRaw`SELECT 1`, 3_000).then(
        (): HealthView['database'] => 'ok',
        (err: unknown): HealthView['database'] => {
          app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'health check: database unreachable');
          return 'error';
        },
      ),
      withTimeout(c.connectivity.done, 3_000).catch(() => c.connectivity.current()),
    ]);
    const providers = describeProviders(c.providers);
    const body: HealthView = {
      status: database === 'ok' ? 'ok' : 'degraded',
      version: APP_VERSION,
      commit: c.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      environment: c.env.NODE_ENV,
      database,
      worker: c.runner.running ? 'embedded' : 'disabled',
      mockMode: providers.some((p) => p.mock),
      providers,
      realStages: c.realStages,
      ...connectivity,
    };
    return reply.code(database === 'ok' ? 200 : 503).send(body);
  });
}
