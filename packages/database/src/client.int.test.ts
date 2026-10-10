import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client.ts';
import { assertTestDatabaseUrl, countOverlappingQueries, truncateAll } from './testing.ts';

/**
 * The client createDatabase makes, against the test database: inside a
 * transaction Prisma sends a row's included relations at once, all on the
 * transaction's one connection. They must reach pg one at a time (pg 8 warns
 * about a query sent while another runs; pg 9 refuses it), with the same
 * rows as outside a transaction, and still after the pool is rebuilt.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

describe('createDatabase', () => {
  const db = createDatabase({ connectionString: assertTestDatabaseUrl(process.env.TEST_DATABASE_URL), maxConnections: 2 });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("sends a transaction's included relations one query at a time on its connection, with the same rows, also after a reconnect", async () => {
    await truncateAll(db);
    const project = await db.project.create({ data: { slug: `overlap-${Date.now()}`, title: 'Overlap (test)', topic: 'Overlap (test)' } });
    await db.projectEvent.create({ data: { projectId: project.id, type: 'TEST', message: 'One event (test).' } });
    const read = (c: Pick<Database, 'project'>) => c.project.findUnique({ where: { id: project.id }, include: { jobs: true, events: true, approvals: true, scripts: { include: { blocks: true, scenes: true } } } });

    const inTx = await countOverlappingQueries(() => db.$transaction((tx) => read(tx)));
    expect(inTx.overlapping).toBe(0);
    expect(inTx.result).toEqual(await read(db));
    expect(inTx.result!.events).toHaveLength(1);

    // The pool is made again after a disconnect: its connections queue the same way.
    await db.$disconnect();
    expect((await countOverlappingQueries(() => db.$transaction((tx) => read(tx)))).overlapping).toBe(0);
  });
});
