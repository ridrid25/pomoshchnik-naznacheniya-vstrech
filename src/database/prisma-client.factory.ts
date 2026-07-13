import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

import { PrismaClient } from '../generated/prisma/client';
import { ensureSqliteDirectory } from './sqlite-path';

export function createPrismaClient(
  databaseUrl = process.env.DATABASE_URL ?? 'file:./data/app.db',
): PrismaClient {
  ensureSqliteDirectory(databaseUrl);
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}
