import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

test('Stage 3 Telegram bot-flow smoke', { timeout: 30_000 }, async () => {
  const appPort = await getFreePort();
  const telegramPort = await getFreePort();
  const databasePath = resolve(
    process.cwd(),
    'data',
    `stage3-e2e-${process.pid}-${Date.now()}.db`,
  );
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const telegramRequests = [];
  const telegramServer = await startTelegramApi(telegramPort, telegramRequests);
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      LOG_LEVEL: 'log',
      DATABASE_URL: databaseUrl,
      TELEGRAM_BOT_TOKEN: '900000001:stage3-test-token',
      TELEGRAM_WEBHOOK_SECRET: 'stage3-webhook-secret',
      TELEGRAM_DEV_POLLING: 'false',
      TELEGRAM_API_ROOT: `http://127.0.0.1:${telegramPort}`,
      ADMIN_TELEGRAM_ID: '9002',
      PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`,
      ADMIN_ACTION_SECRET: 'stage3-admin-action-secret-1234567890',
      MINI_APP_SESSION_SECRET: 'stage3-mini-app-session-secret-1234567890',
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

  let updateId = 2000;
  const sendMessageUpdate = (userId, text, username = `user_${userId}`) =>
    sendWebhook(appPort, ++updateId, {
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: 'Stage' },
        from: {
          id: userId,
          is_bot: false,
          first_name: 'Stage',
          last_name: 'User',
          username,
          language_code: 'ru',
        },
        text,
        ...(text.startsWith('/start')
          ? { entities: [{ offset: 0, length: 6, type: 'bot_command' }] }
          : {}),
      },
    });
  const sendCallback = (userId, data, username = `user_${userId}`) =>
    sendWebhook(appPort, ++updateId, {
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: 'stage3-chat-instance',
        from: {
          id: userId,
          is_bot: false,
          first_name: 'Stage',
          last_name: 'User',
          username,
          language_code: 'ru',
        },
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: 'private', first_name: 'Stage' },
          text: 'Test menu',
        },
        data,
      },
    });

  try {
    await waitForHealth(appPort, child, stdout, stderr);
    setGoogleAccountEmail(databasePath, 'owner@example.com');
    const miniAppUrl = `http://127.0.0.1:${appPort}/mini-app`;
    const menuButtonRequest = telegramRequests.find(
      (request) => request.method === 'setChatMenuButton',
    );
    assert.equal(menuButtonRequest?.body.menu_button?.type, 'commands');
    assert.equal(menuButtonRequest?.body.menu_button?.web_app, undefined);
    const commandsRequest = telegramRequests.find(
      (request) => request.method === 'setMyCommands',
    );
    assert.deepEqual(
      commandsRequest?.body.commands?.map((item) => item.command),
      ['start', 'menu', 'book', 'bookings', 'notifications', 'admin'],
    );

    try {
      await sendMessageUpdate(9001, '/start');
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stdout.join('')}\n${stderr.join('')}`,
      );
    }
    assert.equal(
      lastWebAppUrl(telegramRequests, '✨ Открыть приложение'),
      miniAppUrl,
    );
    await sendCallback(9001, 'notification:menu');
    await sendCallback(9001, 'notification:email');
    await sendMessageUpdate(9001, 'not-an-email');
    assert.equal(readUser(databasePath, 9001).notificationChannel, 'TELEGRAM');
    await sendMessageUpdate(9001, 'stage3@example.com');
    assert.deepEqual(readUser(databasePath, 9001), {
      lastConfirmedEmail: 'stage3@example.com',
      notificationChannel: 'EMAIL',
      status: 'ACTIVE',
    });
    await sendCallback(9001, 'notification:telegram');
    assert.equal(readUser(databasePath, 9001).notificationChannel, 'TELEGRAM');

    await sendCallback(9001, 'booking:new');
    await sendCallback(9001, 'booking:duration:30');
    await sendCallback(9001, 'booking:back');
    await sendCallback(9001, 'booking:duration:30');
    await sendCallback(9001, 'booking:format:online');
    await sendCallback(
      9001,
      lastCallbackData(telegramRequests, 'booking:week:'),
    );
    await sendCallback(
      9001,
      lastCallbackData(telegramRequests, 'booking:date:'),
    );
    await sendCallback(
      9001,
      lastCallbackData(telegramRequests, 'booking:time:'),
    );
    await sendCallback(9001, 'booking:email:skip');
    await sendMessageUpdate(9001, 'Stage 3 smoke meeting');
    await sendCallback(9001, 'booking:comment:skip');
    await sendCallback(9001, 'booking:submit');

    const bookingState = readBookingState(databasePath, 9001);
    assert.deepEqual(bookingState, {
      bookings: 1,
      reservations: 1,
      bookingStatus: 'PENDING_APPROVAL',
      reservationStatus: 'ACTIVE',
      title: 'Stage 3 smoke meeting',
      emailSnapshot: null,
    });

    await sendCallback(9001, 'booking:new');
    await sendCallback(9001, 'booking:cancel');
    assert.equal(readBookingState(databasePath, 9001).bookings, 1);

    await sendCallback(9001, 'admin:menu');
    await sendMessageUpdate(9002, '/start', 'stage3_admin');
    await sendCallback(9002, 'admin:menu', 'stage3_admin');
    await sendCallback(9002, 'admin:bookings', 'stage3_admin');
    const identifiers = readIdentifiers(databasePath, 9001);
    await sendMessageUpdate(
      9002,
      `/start calendar_${identifiers.bookingId}`,
      'stage3_admin',
    );
    assert.equal(
      lastCallbackData(telegramRequests, 'admin:confirm:'),
      `admin:confirm:${identifiers.bookingId}`,
    );
    assert.match(
      lastWebAppUrl(telegramRequests, '📱 Открыть заявку в приложении'),
      new RegExp(`tgWebAppStartParam=calendar_${identifiers.bookingId}$`, 'u'),
    );
    await sendCallback(
      9002,
      `admin:booking:${identifiers.bookingId}`,
      'stage3_admin',
    );
    const calendarLink = lastButtonUrl(
      telegramRequests,
      '📅 Открыть этот день в Google Calendar',
    );
    assert.match(
      calendarLink,
      /^https:\/\/calendar\.google\.com\/calendar\/r\/day\/\d{4}\/\d{1,2}\/\d{1,2}\?authuser=owner%40example\.com$/u,
    );
    assert.equal(
      new URL(calendarLink).searchParams.get('authuser'),
      'owner@example.com',
    );
    assert.ok(lastSentText(telegramRequests).includes(calendarLink));
    await sendCallback(
      9002,
      `admin:confirm:${identifiers.bookingId}`,
      'stage3_admin',
    );
    assert.equal(
      readBookingState(databasePath, 9001).bookingStatus,
      'CONFIRMATION_ERROR',
    );
    await sendCallback(
      9002,
      `admin:reject:${identifiers.bookingId}`,
      'stage3_admin',
    );
    assert.deepEqual(
      {
        bookingStatus: readBookingState(databasePath, 9001).bookingStatus,
        reservationStatus: readBookingState(databasePath, 9001).reservationStatus,
      },
      { bookingStatus: 'REJECTED', reservationStatus: 'RELEASED' },
    );
    await sendCallback(
      9002,
      `admin:block:${identifiers.userId}`,
      'stage3_admin',
    );
    assert.equal(readUser(databasePath, 9001).status, 'BANNED');
    await sendCallback(
      9002,
      `admin:unblock:${identifiers.userId}`,
      'stage3_admin',
    );
    assert.equal(readUser(databasePath, 9001).status, 'ACTIVE');

    const sentTexts = telegramRequests
      .filter((request) => request.method === 'sendMessage')
      .map((request) => request.body.text);
    assert.ok(sentTexts.some((text) => text.includes('Главное меню')));
    assert.ok(sentTexts.some((text) => text.includes('Email сохранен')));
    assert.ok(sentTexts.some((text) => text.includes('заявка отправлена')));
    assert.ok(sentTexts.some((text) => text.includes('нет доступа')));
    assert.ok(sentTexts.some((text) => text.includes('Управление встречами')));
    assert.ok(sentTexts.some((text) => text.includes('Последние заявки')));

    const entries = parseJsonLogLines(stdout.join(''));
    assert.ok(entries.some((entry) => entry.event === 'booking.flow.back'));
    assert.ok(entries.some((entry) => entry.event === 'booking.flow.cancelled'));
    assert.ok(entries.some((entry) => entry.event === 'booking.created'));
    assert.ok(
      entries.some((entry) => entry.event === 'notification.preference.changed'),
    );
    assert.ok(entries.some((entry) => entry.event === 'admin.access.denied'));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveExit) => setTimeout(resolveExit, 2_000)),
    ]);
    await new Promise((resolveClose) => telegramServer.close(resolveClose));
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
});

function setGoogleAccountEmail(databasePath, accountEmail) {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "GoogleOAuthToken" (id, accountEmail, updatedAt)
         VALUES (1, ?, CURRENT_TIMESTAMP)`,
      )
      .run(accountEmail);
  } finally {
    database.close();
  }
}

function readUser(databasePath, telegramId) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .prepare(
        'SELECT lastConfirmedEmail, notificationChannel, status FROM "User" WHERE telegramId = ?',
      )
      .get(telegramId);
  } finally {
    database.close();
  }
}

function readBookingState(databasePath, telegramId) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT
          COUNT(DISTINCT b.id) AS bookings,
          COUNT(DISTINCT r.id) AS reservations,
          MAX(b.status) AS bookingStatus,
          MAX(r.status) AS reservationStatus,
          MAX(b.title) AS title,
          MAX(b.emailSnapshot) AS emailSnapshot
         FROM "User" u
         LEFT JOIN "Booking" b ON b.userId = u.id
         LEFT JOIN "SlotReservation" r ON r.bookingId = b.id
         WHERE u.telegramId = ?`,
      )
      .get(telegramId);
    return row;
  } finally {
    database.close();
  }
}

function readIdentifiers(databasePath, telegramId) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT u.id AS userId, b.id AS bookingId
         FROM "User" u
         JOIN "Booking" b ON b.userId = u.id
         WHERE u.telegramId = ?
         ORDER BY b.createdAt DESC
         LIMIT 1`,
      )
      .get(telegramId);
  } finally {
    database.close();
  }
}

async function sendWebhook(port, updateId, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'stage3-webhook-secret',
    },
    body: JSON.stringify({ update_id: updateId, ...payload }),
  });
  assert.equal(response.status, 200, await response.text());
}

async function startTelegramApi(port, requests) {
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const method = request.url?.split('/').at(-1) ?? '';
    requests.push({ method, body });
    response.setHeader('content-type', 'application/json');
    if (method === 'getMe') {
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            id: 900000001,
            is_bot: true,
            first_name: 'Stage 3 Test Bot',
            username: 'stage3_test_bot',
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        }),
      );
      return;
    }
    if (method === 'sendMessage') {
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: requests.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(body.chat_id), type: 'private', first_name: 'Stage' },
            text: body.text,
            from: {
              id: 900000001,
              is_bot: true,
              first_name: 'Stage 3 Test Bot',
              username: 'stage3_test_bot',
            },
          },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return server;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('Failed to select a free port'));
        else resolvePort(port);
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
      // Application is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Application did not become healthy.\n${stdout.join('')}\n${stderr.join('')}`);
}

function parseJsonLogLines(output) {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function lastCallbackData(requests, prefix) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.method !== 'sendMessage') continue;
    const markup =
      typeof request.body.reply_markup === 'string'
        ? JSON.parse(request.body.reply_markup)
        : request.body.reply_markup;
    for (const row of markup?.inline_keyboard ?? []) {
      const button = row.find((item) => item.callback_data?.startsWith(prefix));
      if (button) return button.callback_data;
    }
  }
  throw new Error(`Callback not found: ${prefix}`);
}

function lastButtonUrl(requests, label) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.method !== 'sendMessage') continue;
    const markup =
      typeof request.body.reply_markup === 'string'
        ? JSON.parse(request.body.reply_markup)
        : request.body.reply_markup;
    for (const row of markup?.inline_keyboard ?? []) {
      const button = row.find((item) => item.text === label && item.url);
      if (button) return button.url;
    }
  }
  throw new Error(`URL button not found: ${label}`);
}

function lastWebAppUrl(requests, label) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.method !== 'sendMessage') continue;
    const markup =
      typeof request.body.reply_markup === 'string'
        ? JSON.parse(request.body.reply_markup)
        : request.body.reply_markup;
    for (const row of markup?.inline_keyboard ?? []) {
      const button = row.find((item) => item.text === label && item.web_app?.url);
      if (button) return button.web_app.url;
    }
  }
  throw new Error(`Web App button not found: ${label}`);
}

function lastSentText(requests) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.method === 'sendMessage') return request.body.text;
  }
  throw new Error('Sent text not found');
}
