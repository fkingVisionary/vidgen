import { buildDossierReport } from '@docengine/research';
import { createContainer } from './container.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';

/**
 * Run one research job to completion and print the evidence report.
 *
 *   pnpm research:run [project-slug]          (default: tulip-mania)
 *   node apps/api/dist/research.js tulip-mania (production image / Railway shell)
 *
 * Uses the configured providers (AI_PROVIDER=anthropic, RESEARCH_PROVIDER=tavily)
 * and the normal state machine: the project must be in IDEA or RESEARCHING
 * (rewind it in the dashboard to research again).
 */
async function main() {
  const slug = process.argv[2] ?? 'tulip-mania';
  const env = loadEnv();
  const logger = createLogger(env, 'research');
  const c = createContainer(env, logger);
  try {
    if (!c.realStages.includes('RESEARCH')) {
      throw new Error('Real research needs AI_PROVIDER=anthropic (ANTHROPIC_API_KEY) and RESEARCH_PROVIDER=tavily (TAVILY_API_KEY or TAVILY_ACCESS_MODE=keyless).');
    }
    const project = await c.db.project.findUnique({ where: { slug } });
    if (!project) throw new Error(`No project with slug "${slug}"`);

    const active = await c.db.job.findFirst({ where: { projectId: project.id, type: 'RESEARCH', status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
    const job = active ?? (await c.projects.enqueueJob(project.id, { type: 'RESEARCH' }, 'research-cli'));
    logger.info({ jobId: job.id, project: slug }, active ? 'resuming existing research job' : 'research job queued');

    for (;;) {
      const current = await c.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, error: true } });
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
        logger.info({ status: current.status, error: current.error }, 'research job finished');
        break;
      }
      // Run whatever is runnable (possibly a retry after backoff); otherwise wait briefly.
      if (!(await c.runner.runOnce())) await new Promise((r) => setTimeout(r, 2_000));
    }

    const dossier = await c.db.researchDossier.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } });
    if (dossier) console.log(`\n${await buildDossierReport(c.db, dossier.id)}\n`);
  } finally {
    await c.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
