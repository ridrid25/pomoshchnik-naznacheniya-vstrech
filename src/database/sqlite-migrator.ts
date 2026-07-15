import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { ensureSqliteDirectory } from './sqlite-path';

interface AppliedMigration {
  checksum: string;
  finished_at: string | null;
}

export interface MigrationResult {
  appliedNames: string[];
  totalCount: number;
}

export function applySqliteMigrations(
  databaseUrl: string,
  migrationsPath = resolve(process.cwd(), 'prisma', 'migrations'),
): MigrationResult {
  const databasePath = ensureSqliteDirectory(databaseUrl);
  const database = new Database(databasePath);
  const appliedNames: string[] = [];

  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL UNIQUE,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      );
    `);

    const migrationNames = readdirSync(migrationsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const migrationName of migrationNames) {
      const sqlPath = resolve(migrationsPath, migrationName, 'migration.sql');
      const sql = readFileSync(sqlPath, 'utf8');
      const compatibleChecksums = migrationChecksums(sql);
      const checksum = compatibleChecksums[0];
      const applied = database
        .prepare(
          'SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = ?',
        )
        .get(migrationName) as AppliedMigration | undefined;

      if (applied) {
        if (
          !applied.finished_at ||
          !compatibleChecksums.includes(applied.checksum)
        ) {
          throw new Error(
            `Migration integrity check failed for ${migrationName}`,
          );
        }
        continue;
      }

      const requiresForeignKeysOff = sql.includes(
        '-- codex: foreign-keys-off',
      );
      if (requiresForeignKeysOff) database.pragma('foreign_keys = OFF');
      try {
        const applyMigration = database.transaction(() => {
          database.exec(sql);
          const violations = database.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(
              `Foreign key check failed for ${migrationName}`,
            );
          }
          const now = new Date().toISOString();
          database
            .prepare(
              `INSERT INTO "_prisma_migrations"
                (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
               VALUES (?, ?, ?, ?, ?, 1)`,
            )
            .run(randomUUID(), checksum, now, migrationName, now);
        });
        applyMigration();
      } finally {
        if (requiresForeignKeysOff) database.pragma('foreign_keys = ON');
      }
      appliedNames.push(migrationName);
    }

    return { appliedNames, totalCount: migrationNames.length };
  } finally {
    database.close();
  }
}

function migrationChecksums(sql: string): string[] {
  const normalized = sql.replace(/\r\n?/gu, '\n');
  const variants = [normalized, normalized.replace(/\n/gu, '\r\n')];
  return [...new Set(variants.map((value) => hashMigration(value)))];
}

function hashMigration(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
