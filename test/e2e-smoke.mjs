import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

test('Stage 1 runtime smoke', { timeout: 20_000 }, async () => {
  const port = await getFreePort();
  const databasePath = resolve(
    process.cwd(),
    'data',
    `stage1-e2e-${process.pid}-${Date.now()}.db`,
  );
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      LOG_LEVEL: 'log',
      DATABASE_URL: databaseUrl,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_DEV_POLLING: 'false',
      TELEGRAM_API_ROOT: '',
      ADMIN_TELEGRAM_ID: '',
      TELEGRAM_WEBHOOK_SECRET: 'stage1-test-secret',
      GOOGLE_OAUTH_CLIENT_ID: '',
      GOOGLE_OAUTH_CLIENT_SECRET: '',
      GOOGLE_OAUTH_REDIRECT_URI: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  try {
    await waitForHealth(port, child, stdout, stderr);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'pomoshchnik-naznacheniya-vstrech');
    assert.equal(health.environment, 'test');
    assert.equal(typeof health.timestamp, 'string');

    const googleStatusResponse = await fetch(
      `http://127.0.0.1:${port}/google/oauth/status`,
    );
    assert.equal(googleStatusResponse.status, 200);
    assert.deepEqual(await googleStatusResponse.json(), {
      configured: false,
      authorized: false,
      tokenExpiresAt: null,
    });
    const googleStartResponse = await fetch(
      `http://127.0.0.1:${port}/google/oauth/start`,
      { redirect: 'manual' },
    );
    assert.equal(googleStartResponse.status, 400);

    const unauthorizedResponse = await fetch(
      `http://127.0.0.1:${port}/telegram/webhook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ update_id: 1001 }),
      },
    );
    assert.equal(unauthorizedResponse.status, 401);
    const unauthorizedBody = await unauthorizedResponse.json();
    assert.equal(unauthorizedBody.statusCode, 401);
    assert.equal(unauthorizedBody.path, '/telegram/webhook');

    const webhookResponse = await fetch(
      `http://127.0.0.1:${port}/telegram/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'stage1-test-secret',
        },
        body: JSON.stringify({ update_id: 1002 }),
      },
    );
    assert.equal(webhookResponse.status, 200);
    assert.deepEqual(await webhookResponse.json(), { ok: true });

    await waitForLog(stdout, 'telegram.webhook.received');
    const entries = [
      ...parseJsonLogLines(stdout.join('')),
      ...parseJsonLogLines(stderr.join('')),
    ];
    assert.ok(entries.some((entry) => entry.event === 'application.started'));
    assert.ok(
      entries.some((entry) => entry.event === 'database.migrations.ready'),
    );
    assert.ok(entries.some((entry) => entry.event === 'database.seed.ready'));
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === 'telegram.webhook.received' && entry.update_id === 1002,
      ),
    );
    assert.ok(entries.some((entry) => entry.event === 'http.request.failed'));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
});

test('Invalid environment fails with a structured startup error', async () => {
  const stderr = [];
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '70000',
      LOG_LEVEL: 'log',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_DEV_POLLING: 'false',
      TELEGRAM_API_ROOT: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(exitCode, 1);
  const entries = parseJsonLogLines(stderr.join(''));
  const failure = entries.find(
    (entry) => entry.event === 'application.start_failed',
  );
  assert.ok(failure);
  assert.match(failure.error_message, /PORT must be an integer/u);
});

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('Failed to select a free port'));
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(port, child, stdout, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Application exited early (${child.exitCode}).\n${stdout.join('')}\n${stderr.join('')}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The HTTP server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Application did not become healthy.\n${stdout.join('')}\n${stderr.join('')}`,
  );
}

async function waitForLog(stdout, event) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (stdout.join('').includes(event)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Log event not found: ${event}`);
}

function parseJsonLogLines(output) {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
