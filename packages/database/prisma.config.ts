import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env files itself. In local development we load the
// repository-root .env (existing environment variables always win). On
// Railway, variables are injected by the platform and no .env file exists.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Not needed for `prisma generate` (e.g. during the Docker build), so it may be empty there.
    url: process.env.DATABASE_URL ?? '',
  },
});
