import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

const prototypeRoot = resolve(process.cwd(), 'prototype', 'mini-app');

test('Mini App prototype contains the approved screens and product decisions', () => {
  const html = readFileSync(resolve(prototypeRoot, 'index.html'), 'utf8');
  const css = readFileSync(resolve(prototypeRoot, 'styles.css'), 'utf8');
  const javascript = readFileSync(resolve(prototypeRoot, 'app.js'), 'utf8');

  for (const screen of ['home', 'wizard', 'success', 'bookings', 'booking-detail', 'admin', 'admin-detail', 'admin-settings']) {
    assert.match(html, new RegExp(`data-screen="${screen}"`, 'u'));
  }
  assert.match(html, /Запись на встречу/u);
  assert.match(html, /Онлайн/u);
  assert.match(html, /Личная/u);
  assert.match(html, /Google Meet/u);
  assert.match(html, /Ответ — в Telegram/u);
  assert.match(html, /Email для календаря/u);
  assert.doesNotMatch(html, /<img\b/iu);
  assert.doesNotMatch(html, /аватар|фотограф/iu);
  assert.match(html, /https:\/\/telegram\.org\/js\/telegram-web-app\.js\?62/iu);
  assert.match(html, /https:\/\/t\.me\/Zapiscalendar_bot/iu);
  assert.match(html, /id="telegramButton"/u);
  assert.equal((html.match(/https?:\/\//giu) ?? []).length, 2);
  assert.doesNotMatch(html, /demoButton|data-demo-only|Открыть демо/iu);

  assert.match(css, /html\[data-theme="dark"\]/u);
  assert.match(css, /@media \(max-width: 359px\)/u);
  assert.match(css, /min-width: 320px/u);
  assert.match(css, /--primary:/u);
  assert.match(css, /--teal:/u);
  assert.match(css, /--warm:/u);
  assert.match(javascript, /setWizardStep/u);
  assert.match(javascript, /availability\/slots/u);
  assert.match(javascript, /idempotencyKey/u);
  assert.match(javascript, /BackButton/u);
  assert.match(javascript, /loadBookings/u);
  assert.match(javascript, /reschedule/u);
  assert.match(javascript, /me\/notifications/u);
  assert.match(javascript, /bookingList/u);
  assert.match(javascript, /dataset\.adminAction/u);
  assert.match(javascript, /admin\/bookings/u);
  assert.match(javascript, /googleCalendarDayUrl/u);
  assert.match(javascript, /dataset\.calendarUrl/u);
  assert.match(javascript, /tg\?\.openLink/u);
  assert.match(javascript, /renderCalendarReviewCard/u);
  assert.match(javascript, /соседней вкладке[^\n]+«Запись на встречу»/u);
  assert.match(javascript, /бледную плашку «На согласовании»/u);
  assert.doesNotMatch(javascript, /demo=1|enterDemo|demoBookings|createDemo|toDemo|state\.mode/iu);
  assert.match(javascript, /state\.selectedBooking\?\.id === button\.dataset\.adminId/u);
  assert.doesNotMatch(javascript, /<dt>Номер<\/dt>/u);
  assert.doesNotMatch(javascript, /successCode'\)\.textContent = booking\.publicCode/u);
  assert.doesNotMatch(javascript, /request-code[^\n]+booking\.publicCode/u);
  assert.doesNotMatch(javascript, /adminDetailCode'\)\.textContent = `Заявка \$\{booking\.publicCode\}`/u);
  assert.match(javascript, /admin\/settings\/schedule/u);
  assert.match(javascript, /saveAdminSchedule/u);
  assert.match(css, /calendar-review-card/u);
  assert.match(css, /integration-status-card/u);
  assert.match(html, /Календарь и расписание/u);
  assert.match(html, /Калининград · UTC\+2/u);
  assert.match(html, /Камчатка · UTC\+12/u);
  assert.match(javascript, /timezone: elements\.scheduleTimezone\.value/u);
  assert.doesNotMatch(javascript, /серые заявки/iu);
});

test('M2 prototype server returns all local assets', { timeout: 10_000 }, async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['scripts/serve-mini-app-prototype.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PROTOTYPE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));

  try {
    await waitForServer(port, child, output);
    for (const [path, contentType] of [
      ['/', 'text/html'],
      ['/styles.css', 'text/css'],
      ['/app.js', 'text/javascript'],
      ['/mini-app', 'text/html'],
      ['/mini-app/styles.css', 'text/css'],
      ['/mini-app/app.js', 'text/javascript'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(contentType, 'u'));
      assert.ok((await response.text()).length > 100);
    }
    const traversal = await fetch(`http://127.0.0.1:${port}/..%2Fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
});

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

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Prototype server exited early.\n${output.join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Prototype server did not start.\n${output.join('')}`);
}
