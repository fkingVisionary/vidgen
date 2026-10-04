import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export interface DatabaseOptions {
  connectionString: string;
  /** Connection pool size. Keep modest on Railway's smaller Postgres plans. */
  maxConnections?: number;
}

/**
 * Creates a Prisma client using the node-postgres driver adapter (Prisma 7
 * has no bundled Rust query engine). Create one per process and reuse it.
 */
export function createDatabase(opts: DatabaseOptions): PrismaClient {
  if (!opts.connectionString) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaPg({ connectionString: opts.connectionString, max: opts.maxConnections ?? 10 });
  return new PrismaClient({ adapter });
}

export type Database = PrismaClient;
