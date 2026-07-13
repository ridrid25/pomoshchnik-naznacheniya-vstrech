import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataDirectory = resolve(root, 'data');
const databaseFilename = `stage2-smoke-${runId}.db`;
const databasePath = resolve(dataDirectory, databaseFilename);
const databaseUrl = `file:./data/${databaseFilename}`;
const backupDirectory = resolve(dataDirectory, `stage2-backups-${runId}`);
const expectedMigrationCount = readdirSync(resolve(root, 'prisma', 'migrations'), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory()).length;

mkdirSync(dataDirectory, { recursive: true });
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  BACKUP_DIR: backupDirectory,
};

try {
  runLocalBin('tsx', ['scripts/migrate-sqlite.ts'], env);
  assert.ok(existsSync(databasePath), 'Migration must create a SQLite file');
  runLocalBin('tsx', ['scripts/migrate-sqlite.ts'], env);
  runLocalBin('tsx', ['prisma/seed.ts'], env);
  runLocalBin('tsx', ['prisma/seed.ts'], env);
  runLocalBin('tsx', ['test/stage2-db-smoke.ts'], env);
  runLocalBin('tsx', ['scripts/backup-sqlite.ts'], env);

  const backupFiles = readdirSync(backupDirectory).filter((name) =>
    name.endsWith('.db'),
  );
  assert.equal(backupFiles.length, 1, 'Exactly one backup must be created');
  const backupPath = join(backupDirectory, backupFiles[0]);
  assert.ok(
    statSync(backupPath).size > 0,
    'Backup file must not be empty',
  );
  const backupDatabase = new Database(backupPath, { readonly: true });
  try {
    const backupUserCount = backupDatabase
      .prepare('SELECT COUNT(*) AS count FROM "User"')
      .get().count;
    const migrationCount = backupDatabase
      .prepare('SELECT COUNT(*) AS count FROM "_prisma_migrations"')
      .get().count;
    assert.equal(backupUserCount, 1, 'Backup must contain smoke user data');
    assert.equal(
      migrationCount,
      expectedMigrationCount,
      'Backup must contain migration history',
    );
  } finally {
    backupDatabase.close();
  }

  process.stdout.write(
    `${JSON.stringify({
      event: 'stage2.verification.completed',
      clean_database_created: true,
      migration_applied: true,
      migration_idempotent: true,
      seed_applied: true,
      seed_idempotent: true,
      crud_smoke_passed: true,
      backup_verified: true,
    })}\n`,
  );
} finally {
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  rmSync(backupDirectory, { force: true, recursive: true });
}

function runLocalBin(name, args, childEnv) {
  if (name !== 'tsx') {
    throw new Error(`Unsupported local binary: ${name}`);
  }

  const cliPath = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} failed with ${result.status}`);
  }
}
