import 'dotenv/config';

import { applySqliteMigrations } from '../src/database/sqlite-migrator';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./data/app.db';

try {
  const result = applySqliteMigrations(databaseUrl);
  for (const migrationName of result.appliedNames) {
    process.stdout.write(
      `${JSON.stringify({
        event: 'database.migration.applied',
        migration_name: migrationName,
      })}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'database.migrations.completed',
      applied_count: result.appliedNames.length,
      total_count: result.totalCount,
    })}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      event: 'database.migrations.failed',
      error_message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
