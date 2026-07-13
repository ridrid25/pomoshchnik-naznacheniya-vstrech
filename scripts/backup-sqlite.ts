import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { resolveSqlitePath } from '../src/database/sqlite-path';

export function backupSqliteDatabase(
  databaseUrl = process.env.DATABASE_URL ?? 'file:./data/app.db',
  backupDirectory = process.env.BACKUP_DIR ?? './backups',
): string {
  const sourcePath = resolveSqlitePath(databaseUrl);
  if (!existsSync(sourcePath)) {
    throw new Error(`SQLite database does not exist: ${sourcePath}`);
  }

  const sourceStats = statSync(sourcePath);
  if (!sourceStats.isFile() || sourceStats.size === 0) {
    throw new Error(`SQLite database is empty or invalid: ${sourcePath}`);
  }

  const destinationDirectory = resolve(process.cwd(), backupDirectory);
  mkdirSync(destinationDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const destinationPath = resolve(
    destinationDirectory,
    `${basename(sourcePath, '.db')}-${timestamp}.db`,
  );

  copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

if (require.main === module) {
  try {
    const destinationPath = backupSqliteDatabase();
    process.stdout.write(
      `${JSON.stringify({
        event: 'database.backup.completed',
        destination_path: destinationPath,
      })}\n`,
    );
  } catch (error: unknown) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'database.backup.failed',
        error_message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
