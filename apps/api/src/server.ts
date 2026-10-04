import { buildApp } from './app.ts';
import { createContainer } from './container.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';
import { APP_VERSION } from './version.ts';

/**
 * Production entry point: HTTP API + dashboard, with the job worker embedded
 * (WORKER_ENABLED=true) so V1 runs as a single Railway service.
 */
async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const c = createContainer(env, logger);
  const app = await buildApp(c);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining HTTP and worker');
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      await app.close();
      await c.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));

  await app.listen({ port: env.PORT, host: env.HOST });
  if (env.WORKER_ENABLED) c.runner.start();
  logger.info({ version: APP_VERSION, port: env.PORT, worker: env.WORKER_ENABLED, env: env.NODE_ENV }, 'documentary engine started');
}

main().catch((err) => {
  // Configuration errors (missing env, unimplemented provider) land here with a readable message.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
