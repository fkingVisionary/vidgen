import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const PUBLIC_PATHS = new Set(['/api/health']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * HTTP Basic auth for the whole app (dashboard and API) when a password is
 * configured. Required in production (enforced by env validation). A single
 * shared credential is enough for a one-creator studio; proper user accounts
 * can replace this later without touching the routes.
 */
export function registerBasicAuth(app: FastifyInstance, user: string, password: string | undefined): void {
  if (!password) {
    app.log.warn('DASHBOARD_PASSWORD not set: dashboard and API are unauthenticated (development only)');
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
        (req as { actor?: string }).actor = decoded.slice(0, sep);
        return;
      }
    }
    return reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Documentary Engine", charset="UTF-8"')
      .send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  });
}

export const actorOf = (req: object): string => (req as { actor?: string }).actor ?? 'dashboard';
