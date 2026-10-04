import { createContainer } from './container.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';

/**
 * Standalone worker: the same JobRunner as the embedded one, without HTTP.
 * Not needed in V1. When generation work grows, deploy this as a second
 * Railway service (start command `node apps/api/dist/worker.js`) and set
 * WORKER_ENABLED=false on the web service.
 */
async function main() {
  const env = loadEnv();
  const logger = createLogger(env, 'worker');
  const c = createContainer(env, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await c.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  c.runner.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
