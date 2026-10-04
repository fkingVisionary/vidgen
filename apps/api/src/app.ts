import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { TransitionError } from '@docengine/core';
import { DomainError } from '@docengine/pipeline';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerBasicAuth } from './auth.ts';
import type { AppContainer } from './container.ts';
import { healthRoutes } from './routes/health.ts';
import { jobRoutes } from './routes/jobs.ts';
import { projectRoutes } from './routes/projects.ts';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function defaultWebDir(): string {
  // apps/api/src/app.ts (dev) and apps/api/dist/server.js (prod) both resolve to apps/web/dist.
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

export async function buildApp(c: AppContainer): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: c.logger,
    // Replaced by the concise onResponse log line below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true, // behind Railway's proxy
    bodyLimit: 1024 * 1024,
  }) as unknown as FastifyInstance;

  app.addHook('onSend', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  // One concise structured line per request; dashboard polling (GET /api/*) only at debug level.
  app.addHook('onResponse', async (req, reply) => {
    const entry = { method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.error(entry, 'request');
    else if (req.method === 'GET' && req.url.startsWith('/api/')) req.log.debug(entry, 'request');
    else req.log.info(entry, 'request');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof DomainError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
    if (err instanceof TransitionError) return reply.code(409).send({ error: 'CONFLICT', message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.id });
  });

  registerBasicAuth(app, c.env.DASHBOARD_USER, c.env.DASHBOARD_PASSWORD);

  await healthRoutes(app, c);
  await projectRoutes(app, c);
  await jobRoutes(app, c);

  const webDir = c.env.WEB_DIST_DIR ?? defaultWebDir();
  const hasWeb = existsSync(join(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDir,
      setHeaders(res, path) {
        // Vite fingerprints everything under /assets; index.html must always be revalidated.
        res.header('cache-control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  } else {
    app.log.info({ webDir }, 'dashboard build not found: serving the API only (use `pnpm dev` for the dashboard)');
  }

  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      // Client-side routing: unknown paths get the SPA shell.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` });
  });

  return app;
}
