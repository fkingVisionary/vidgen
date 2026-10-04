import type { Database } from './client.ts';

/**
 * Integration-test helpers. Guarded so they can never wipe a non-test database.
 */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Integration tests need a dedicated Postgres database (see README).');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run integration tests against database "${dbName}": its name must contain "test".`);
  }
  return url;
}

/** Empties every application table (keeps the migrations table). */
export async function truncateAll(db: Database): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
