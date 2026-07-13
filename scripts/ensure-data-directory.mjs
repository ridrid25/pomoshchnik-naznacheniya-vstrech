import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./data/app.db';
if (!databaseUrl.startsWith('file:')) {
  throw new Error('DATABASE_URL must use the file: protocol for SQLite');
}

const rawPath = databaseUrl.slice('file:'.length);
if (!rawPath) {
  throw new Error('DATABASE_URL must include a SQLite file path');
}

const databasePath = isAbsolute(rawPath)
  ? rawPath
  : resolve(process.cwd(), rawPath);
mkdirSync(dirname(databasePath), { recursive: true });

process.stdout.write(
  `${JSON.stringify({
    event: 'database.directory.ready',
    directory: dirname(databasePath),
  })}\n`,
);
