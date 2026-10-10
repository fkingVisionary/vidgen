import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from './generated/prisma/client.ts';

export interface DatabaseOptions {
  connectionString: string;
  /** Connection pool size. Keep modest on Railway's smaller Postgres plans. */
  maxConnections?: number;
}

/**
 * A pooled connection that sends one query at a time. Prisma's driver adapter
 * sends a transaction's included relations at once on the transaction's one
 * connection; pg queues them but warns that this is deprecated (pg 9 removes
 * it). Queue them here instead, in the order they were called, as pg ran them.
 */
class OneQueryAtATime extends pg.Client {
  #last: Promise<unknown> = Promise.resolve();
  // `any`: pg's query has many overloads, and this keeps every one of them.
  override query(...args: unknown[]): any {
    const [config, values, callback] = args;
    const plain = typeof values !== 'function' && typeof callback !== 'function' && typeof (config as { submit?: unknown } | null)?.submit !== 'function';
    if (!plain) return (super.query as (...a: unknown[]) => unknown)(...args); // pool.query's callback form, submittables: unchanged
    const run = this.#last.then(() => (super.query as (...a: unknown[]) => Promise<unknown>)(config, values));
    this.#last = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Creates a Prisma client using the node-postgres driver adapter (Prisma 7
 * has no bundled Rust query engine). Create one per process and reuse it.
 */
export function createDatabase(opts: DatabaseOptions): PrismaClient {
  if (!opts.connectionString) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaPg({ connectionString: opts.connectionString, max: opts.maxConnections ?? 10, Client: OneQueryAtATime });
  return new PrismaClient({ adapter });
}

export type Database = PrismaClient;
