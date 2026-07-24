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

  for (const screen of ['home', 'wizard', 'success', 'bookings', 'booking-detail', 'admin', 'admin-detail', 'admin-settings', 'admin-health', 'admin-restrictions', 'admin-blocked-users', 'admin-templates', 'admin-template-editor']) {
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
  assert.match(html, /https:\/\/t\.me\/Zapiscalender_bot/iu);
  assert.doesNotMatch(html, /https:\/\/t\.me\/Zapiscalendar_bot/iu);
  assert.match(html, /id="telegramButton"/u);
  assert.equal((html.match(/https?:\/\//giu) ?? []).length, 2);
  assert.doesNotMatch(html, /demoButton|data-demo-only|Открыть демо/iu);

  assert.match(css, /html\[data-theme="dark"\]/u);
  assert.match(css, /@media \(max-width: 359px\)/u);
  assert.match(css, /min-width: 320px/u);
  assert.match(css, /--primary:/u);
  assert.match(css, /--teal:/u);
  assert.match(css, /--warm:/u);
  assert.match(css, /--type-caption: 13px/u);
  assert.match(css, /--type-control: 17px/u);
  assert.match(css, /Mobile readability pass/u);
  assert.match(css, /\.work-period-row input \{ height: 54px/u);
  assert.match(css, /@media \(max-width: 480px\)/u);
  assert.match(css, /\.work-period-dash \{ display: none; \}/u);
  assert.match(css, /\.bottom-nav button \{ font-size: var\(--type-caption\)/u);
  assert.match(javascript, /setWizardStep/u);
  assert.match(javascript, /availability\/slots/u);
  assert.match(javascript, /idempotencyKey/u);
  assert.match(javascript, /tgWebAppData/u);
  assert.match(javascript, /telegramInitData/u);
  assert.match(javascript, /BackButton/u);
  assert.match(javascript, /loadBookings/u);
  assert.match(javascript, /reschedule/u);
  assert.match(javascript, /me\/notifications/u);
  assert.match(javascript, /bookingList/u);
  assert.match(html, /История <span id="archiveCount"/u);
  assert.match(html, /id="bookingsScopeHint"/u);
  assert.match(javascript, /Здесь только предстоящие встречи/u);
  assert.match(javascript, /Здесь хранятся прошедшие и закрытые записи/u);
  assert.match(javascript, /Дата прошла/u);
  assert.match(css, /bookings-scope-hint/u);
  assert.match(javascript, /dataset\.adminAction/u);
  assert.match(javascript, /admin\/bookings/u);
  assert.match(javascript, /googleCalendarDayUrl/u);
  assert.match(javascript, /dataset\.calendarUrl/u);
  assert.match(javascript, /tg\?\.openLink/u);
  assert.match(javascript, /renderCalendarReviewCard/u);
  assert.equal(
    (javascript.match(/renderCalendarReviewCard\(booking\.googleCalendarDayUrl, booking\.id\)/gu) ?? []).length,
    2,
  );
  assert.match(javascript, /Открыть Google Calendar/u);
  assert.match(javascript, /renderAdminSlotState/u);
  assert.match(javascript, /booking\.slotAvailable === false/u);
  assert.match(javascript, /booking\.canRetry/u);
  assert.match(javascript, /data-retry-id/u);
  assert.match(javascript, /Выбрать другое время/u);
  assert.match(javascript, /retryUnavailableBooking/u);
  assert.match(javascript, /Время свободно — можно подтверждать/u);
  assert.match(javascript, /Время уже занято — подтверждение недоступно/u);
  assert.match(javascript, /renderQueueAge/u);
  assert.match(javascript, /waitingMinutes/u);
  assert.match(javascript, /требуют внимания/u);
  assert.match(javascript, /Ждёт решения/u);
  assert.match(css, /queue-age\.aging/u);
  assert.match(html, /id="adminOldestWait"/u);
  assert.match(html, /id="adminReliability"/u);
  assert.match(javascript, /renderReliability/u);
  assert.match(javascript, /Статистика заявок/u);
  assert.match(javascript, /Ранее занятое время выбрали в 2 из 9 заявок/u);
  assert.match(css, /reliability-card/u);
  assert.match(css, /reliability-progress/u);
  assert.match(
    javascript,
    /🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить/u,
  );
  assert.match(javascript, /calendar-return/u);
  assert.doesNotMatch(javascript, /Возврат уже добавлен/u);
  assert.match(javascript, /window\.location\.assign\(url\.toString\(\)\)/u);
  assert.match(javascript, /TelegramWebviewProxy/u);
  assert.match(javascript, /https:\/\/web\.telegram\.org/u);
  assert.doesNotMatch(javascript, /window\.parent !== window/u);
  assert.match(javascript, /tgWebAppStartParam/u);
  assert.match(javascript, /openStartDestination/u);
  assert.doesNotMatch(`${html}\n${javascript}`, /контрольн(?:ый|ая|ое)|пилот|прототип/iu);
  assert.match(javascript, /бледную плашку «На согласовании»/u);
  assert.doesNotMatch(javascript, /demo=1|enterDemo|demoBookings|createDemo|toDemo|state\.mode/iu);
  assert.match(javascript, /state\.selectedBooking\?\.id === button\.dataset\.adminId/u);
  assert.doesNotMatch(javascript, /<dt>Номер<\/dt>/u);
  assert.doesNotMatch(javascript, /successCode'\)\.textContent = booking\.publicCode/u);
  assert.doesNotMatch(javascript, /request-code[^\n]+booking\.publicCode/u);
  assert.doesNotMatch(javascript, /adminDetailCode'\)\.textContent = `Заявка \$\{booking\.publicCode\}`/u);
  assert.match(javascript, /admin\/settings\/schedule/u);
  assert.match(javascript, /saveAdminSchedule/u);
  assert.match(javascript, /workingPeriodsDraft/u);
  assert.match(javascript, /toggleWorkingDay/u);
  assert.match(javascript, /addWorkingPeriod/u);
  assert.match(javascript, /validateWorkingPeriods/u);
  assert.match(html, /Обычные часы встречи/u);
  assert.match(html, /Защита от ночных записей/u);
  assert.match(html, /Конкретную занятость добавляйте выше/u);
  assert.match(css, /week-day-card/u);
  assert.match(css, /day-switch/u);
  assert.match(javascript, /moveByScrollStop/u);
  assert.match(javascript, /updateScrollControls/u);
  assert.match(css, /calendar-review-card/u);
  assert.match(css, /queue-slot-state\.available/u);
  assert.match(css, /queue-slot-state\.unavailable/u);
  assert.match(css, /scroll-controls/u);
  assert.match(html, /id="scrollUp"/u);
  assert.match(html, /id="scrollDown"/u);
  assert.match(css, /integration-status-card/u);
  assert.match(html, /Управление встречами/u);
  assert.match(html, /Настройки расписания/u);
  assert.doesNotMatch(`${html}\n${javascript}`, /следующ(?:ем этапе|ими блоками)/iu);
  assert.match(html, /<span>Назад<\/span>/u);
  assert.doesNotMatch(css, /\.telegram-mode \.back-button \{ display: none/u);
  assert.doesNotMatch(`${html}\n${javascript}`, /администратор/iu);
  assert.match(html, /Калининград · UTC\+2/u);
  assert.match(html, /Камчатка · UTC\+12/u);
  assert.match(javascript, /timezone: elements\.scheduleTimezone\.value/u);
  assert.match(javascript, /admin\/restrictions/u);
  assert.match(javascript, /loadRestrictions/u);
  assert.match(javascript, /saveRestriction/u);
  assert.match(javascript, /deleteRestriction/u);
  assert.match(javascript, /syncRestriction/u);
  assert.match(html, /Когда ко мне нельзя записаться/u);
  assert.match(html, /Закрыть день или время/u);
  assert.match(html, /появится в Google Calendar/u);
  assert.doesNotMatch(html, /Когда ко мне можно записаться/u);
  assert.match(css, /restriction-card/u);
  assert.match(javascript, /admin\/blocked-users/u);
  assert.match(javascript, /loadBlockedUsers/u);
  assert.match(javascript, /unblockUser/u);
  assert.match(html, /Контроль доступа/u);
  assert.match(html, /Пользователи без доступа/u);
  assert.match(css, /blocked-user-card/u);
  assert.match(javascript, /admin\/templates/u);
  assert.match(javascript, /loadTemplates/u);
  assert.match(javascript, /saveTemplate/u);
  assert.match(javascript, /data-insert-placeholder/u);
  assert.match(html, /Шаблоны уведомлений/u);
  assert.match(html, /Допустимые подстановки/u);
  assert.match(css, /template-card/u);
  assert.match(css, /placeholder-list/u);
  assert.match(html, /Состояние помощника/u);
  assert.match(html, /Проверить и восстановить/u);
  assert.match(html, /Подготовить отчёт для Codex/u);
  assert.match(html, /id="diagnosticReportText"/u);
  assert.match(javascript, /admin\/diagnostics/u);
  assert.match(javascript, /admin\/diagnostics\/repair/u);
  assert.match(html, /id="calendarReconnectAction"/u);
  assert.match(html, /href="\/google\/oauth\/start"/u);
  assert.match(html, /Переподключить Google Calendar/u);
  assert.match(css, /calendar-reconnect-action/u);
  assert.match(javascript, /navigator\.clipboard/u);
  assert.match(javascript, /diagnosticText/u);
  assert.match(javascript, /setSelectionRange/u);
  assert.match(javascript, /Нужна ручная помощь/u);
  assert.match(css, /health-summary-card/u);
  assert.match(css, /health-check-card/u);
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
