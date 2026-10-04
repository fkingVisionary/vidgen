import { existsSync } from 'node:fs';
import { createDatabase, type Database } from '@docengine/database';
import { assertTestDatabaseUrl, truncateAll } from '@docengine/database/testing';
import { afterAll, beforeEach } from 'vitest';

if (existsSync('.env')) process.loadEnvFile('.env');

/** A Prisma client on the test database, emptied before every test. */
export function useTestDatabase(): Database {
  const db = createDatabase({ connectionString: assertTestDatabaseUrl(process.env.TEST_DATABASE_URL), maxConnections: 5 });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  return db;
}

export const tulipInput = {
  title: 'Tulip Mania',
  workingTitle: 'The Bubble That Became a Legend',
  topic: 'The Dutch tulip bulb market of 1636–37',
  category: 'Economic History',
  style: 'Premium Historical Documentary',
};
