import type { Prisma } from './generated/prisma/client.ts';

export { createDatabase, type Database, type DatabaseOptions } from './client.ts';
// PrismaClient, the Prisma namespace, model types (Project, Job, …) and DB enums.
export * from './generated/prisma/client.ts';

/** Client handed to `db.$transaction(async (tx) => …)` callbacks. */
export type Tx = Prisma.TransactionClient;
