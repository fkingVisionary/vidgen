import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assertTestDatabaseUrl } from '@docengine/database/testing';

/**
 * Vitest global setup for `pnpm test:int`: applies all migrations to the
 * dedicated test database (TEST_DATABASE_URL, whose name must contain "test").
 */
export default function setup() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  execFileSync('pnpm', ['--filter', '@docengine/database', 'exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
