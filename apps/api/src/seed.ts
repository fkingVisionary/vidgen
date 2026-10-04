import { existsSync } from 'node:fs';
import { createDatabase } from '@docengine/database';
import { ProjectService } from '@docengine/pipeline';
import { seedDemoProject } from './demo.ts';

/**
 * `pnpm db:seed` (dev) / `node apps/api/dist/seed.js` (Railway pre-deploy).
 * Only needs DATABASE_URL. Safe to run on every deploy.
 */
async function main() {
  for (const f of ['.env', '../../.env']) {
    if (existsSync(f)) {
      process.loadEnvFile(f);
      break;
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = createDatabase({ connectionString: url, maxConnections: 2 });
  try {
    const result = await seedDemoProject(db, new ProjectService({ db }));
    console.log(
      result.created
        ? `Seeded demo project "Tulip Mania" (${result.projectId})`
        : `Demo project already exists (${result.projectId}); left unchanged`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
