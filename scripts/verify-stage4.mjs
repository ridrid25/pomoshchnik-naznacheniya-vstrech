import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const dataDirectory = resolve(root, 'data');
const databasePath = resolve(
  dataDirectory,
  `stage4-smoke-${process.pid}-${Date.now()}.db`,
);
mkdirSync(dataDirectory, { recursive: true });

try {
  const cliPath = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [cliPath, 'test/stage4-availability-smoke.ts'],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: `file:${databasePath.replaceAll('\\', '/')}`,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_DEV_POLLING: 'false',
      },
      encoding: 'utf8',
      shell: false,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Stage 4 smoke failed with status ${result.status}`);
  }
} finally {
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}
