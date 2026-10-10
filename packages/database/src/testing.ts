import { createRequire } from 'node:module';
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

/**
 * Runs fn and counts pg queries sent on a connection that still had a query
 * in flight (pg 8 queues them with a deprecation warning; pg 9 refuses them).
 * Calls with a callback (a pool's own) are passed through uncounted.
 */
export async function countOverlappingQueries<T>(fn: () => Promise<T>): Promise<{ result: T; overlapping: number }> {
  const pg = createRequire(import.meta.url)('pg') as typeof import('pg');
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const original = proto.query;
  const inFlight = new WeakMap<object, number>();
  let overlapping = 0;
  proto.query = function (this: object, ...args: unknown[]) {
    const n = inFlight.get(this) ?? 0;
    const out = original.apply(this, args) as Promise<unknown> | undefined;
    if (out && typeof out.then === 'function') {
      if (n > 0) overlapping++;
      inFlight.set(this, n + 1);
      const done = () => inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
      out.then(done, done);
    }
    return out;
  };
  try {
    return { result: await fn(), overlapping };
  } finally {
    proto.query = original;
  }
}
