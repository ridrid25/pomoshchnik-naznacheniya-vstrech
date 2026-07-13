import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error('SQLite DATABASE_URL must start with file:');
  }

  const rawPath = databaseUrl.slice('file:'.length);
  if (!rawPath) {
    throw new Error('SQLite DATABASE_URL must include a file path');
  }

  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

export function ensureSqliteDirectory(databaseUrl: string): string {
  const databasePath = resolveSqlitePath(databaseUrl);
  mkdirSync(dirname(databasePath), { recursive: true });
  return databasePath;
}
