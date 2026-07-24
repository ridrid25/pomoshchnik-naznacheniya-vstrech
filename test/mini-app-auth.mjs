import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

const BOT_TOKEN = '123456789:mini-app-test-token';
const ADMIN_TELEGRAM_ID = '900000001';

test('Mini App Telegram auth, session, origin and API guards', { timeout: 25_000 }, async () => {
  const sessionServiceSource = readFileSync(
    resolve(process.cwd(), 'src', 'mini-app', 'auth', 'mini-app-session.service.ts'),
    'utf8',
  );
  assert.match(sessionServiceSource, /sameSite: production \? 'none' : 'strict'/u);
  assert.match(sessionServiceSource, /partitioned: production/u);

  const port = await getFreePort();
  const telegramPort = await getFreePort();
  const telegramRequests = [];
  const telegramServer = await startTelegramApi(telegramPort, telegramRequests);
  const origin = `http://127.0.0.1:${port}`;
  const databasePath = resolve(
    process.cwd(),
    'data',
    `mini-app-e2e-${process.pid}-${Date.now()}.db`,
  );
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      LOG_LEVEL: 'log',
      DATABASE_URL: `file:${databasePath.replaceAll('\\', '/')}`,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: 'mini-app-webhook-secret',
      TELEGRAM_DEV_POLLING: 'false',
      TELEGRAM_API_ROOT: `http://127.0.0.1:${telegramPort}`,
      ADMIN_TELEGRAM_ID,
      PUBLIC_BASE_URL: origin,
      ADMIN_ACTION_SECRET: 'mini-app-admin-action-secret-1234567890',
      MINI_APP_SESSION_SECRET: 'mini-app-session-secret-1234567890-abcdef',
      MINI_APP_SESSION_TTL_SECONDS: '7200',
      MINI_APP_INIT_DATA_MAX_AGE_SECONDS: '600',
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
    await waitForHealth(origin, child, stdout, stderr);

    const pageResponse = await fetch(`${origin}/mini-app`);
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /telegram-web-app\.js\?62/u);
    assert.match(pageHtml, /Открыть Telegram-бота/u);
    assert.doesNotMatch(pageHtml, /Открыть демо|demoButton/u);
    assert.match(pageResponse.headers.get('content-security-policy') ?? '', /telegram\.org/u);
    const appResponse = await fetch(`${origin}/mini-app/app.js`);
    assert.equal(appResponse.status, 200);
    const appJavascript = await appResponse.text();
    assert.match(appJavascript, /idempotencyKey/u);
    assert.match(appJavascript, /tgWebAppData/u);
    assert.match(appJavascript, /telegramInitData/u);
    assert.doesNotMatch(appJavascript, /demo=1|enterDemo|demoBookings|createDemo/u);

    const withoutSession = await fetch(`${origin}/api/mini-app/v1/me`);
    assert.equal(withoutSession.status, 401);

    const validAdminInitData = signInitData({
      id: Number(ADMIN_TELEGRAM_ID),
      first_name: 'Администратор',
      username: 'meeting_admin',
    });
    const wrongOrigin = await createSession(
      origin,
      'https://attacker.example',
      validAdminInitData,
    );
    assert.equal(wrongOrigin.status, 403);

    const tampered = `${validAdminInitData}&extra=tampered`;
    const tamperedResponse = await createSession(origin, origin, tampered);
    assert.equal(tamperedResponse.status, 401);

    const expiredResponse = await createSession(
      origin,
      origin,
      signInitData(
        { id: 900000002, first_name: 'Expired' },
        Math.floor(Date.now() / 1000) - 601,
      ),
    );
    assert.equal(expiredResponse.status, 401);

    const sessionResponse = await createSession(
      origin,
      origin,
      validAdminInitData,
    );
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.user.telegramId, ADMIN_TELEGRAM_ID);
    assert.equal(sessionBody.user.role, 'ADMIN');
    assert.equal(sessionBody.user.displayName, 'Администратор');
    assert.equal('photoUrl' in sessionBody.user, false);

    const setCookie = sessionResponse.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/iu);
    assert.match(setCookie, /SameSite=Strict/iu);
    assert.match(setCookie, /Path=\/api\/mini-app/iu);
    const cookie = setCookie.split(';', 1)[0];

    const meResponse = await fetch(`${origin}/api/mini-app/v1/me`, {
      headers: { cookie },
    });
    assert.equal(meResponse.status, 200);
    assert.equal((await meResponse.json()).user.role, 'ADMIN');

    const adminSettings = await fetch(
      `${origin}/api/mini-app/v1/admin/settings`,
      { headers: { cookie } },
    );
    assert.equal(adminSettings.status, 200);
    const adminSettingsBody = await adminSettings.json();
    assert.equal(adminSettingsBody.google.authorized, false);
    assert.equal(adminSettingsBody.google.reachable, false);
    assert.equal(adminSettingsBody.schedule.timezone, 'Europe/Moscow');
    assert.equal(adminSettingsBody.schedule.workingPeriods.length, 5);
    assert.equal(adminSettingsBody.overview.templates, 8);

    const diagnosticsResponse = await fetch(
      `${origin}/api/mini-app/v1/admin/diagnostics`,
      { headers: { cookie } },
    );
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.version, 'M11');
    assert.equal(diagnostics.repairs.attempted, false);
    assert.ok(Array.isArray(diagnostics.checks));
    assert.match(diagnostics.diagnosticText, /Диагностика помощника записей/u);
    assert.doesNotMatch(diagnostics.diagnosticText, /mini-app-test-token/u);

    const repairDiagnosticsResponse = await fetch(
      `${origin}/api/mini-app/v1/admin/diagnostics/repair`,
      {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(
      repairDiagnosticsResponse.status,
      201,
      await repairDiagnosticsResponse.clone().text(),
    );
    const repairedDiagnostics = await repairDiagnosticsResponse.json();
    assert.equal(repairedDiagnostics.repairs.attempted, true);

    const updatedAdminSettings = await fetch(
      `${origin}/api/mini-app/v1/admin/settings/schedule`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Asia/Yekaterinburg',
          minimumLeadTimeMinutes: 180,
          bookingHorizonDays: 14,
          maxMeetingsPerDay: 5,
          bufferBeforeMinutes: 15,
          bufferAfterMinutes: 30,
        }),
      },
    );
    assert.equal(updatedAdminSettings.status, 200, await updatedAdminSettings.clone().text());
    const updatedAdminSettingsBody = await updatedAdminSettings.json();
    assert.equal(updatedAdminSettingsBody.schedule.timezone, 'Asia/Yekaterinburg');
    assert.equal(updatedAdminSettingsBody.schedule.minimumLeadTimeMinutes, 180);
    assert.equal(updatedAdminSettingsBody.schedule.bufferAfterMinutes, 30);

    const invalidAdminSettings = await fetch(
      `${origin}/api/mini-app/v1/admin/settings/schedule`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: 'America/New_York',
          minimumLeadTimeMinutes: 180,
          bookingHorizonDays: 14,
          maxMeetingsPerDay: 5,
          bufferBeforeMinutes: 15,
          bufferAfterMinutes: 30,
        }),
      },
    );
    assert.equal(invalidAdminSettings.status, 400);

    const customWorkingPeriods = [
      { weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 },
      { weekday: 1, startMinute: 14 * 60, endMinute: 18 * 60 },
      { weekday: 3, startMinute: 10 * 60, endMinute: 16 * 60 },
      { weekday: 6, startMinute: 11 * 60, endMinute: 14 * 60 },
    ];
    const updatedWorkingPeriods = await fetch(
      `${origin}/api/mini-app/v1/admin/settings/schedule`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Europe/Moscow',
          minimumLeadTimeMinutes: 1440,
          bookingHorizonDays: 30,
          maxMeetingsPerDay: 4,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          workingPeriods: customWorkingPeriods,
        }),
      },
    );
    assert.equal(updatedWorkingPeriods.status, 200, await updatedWorkingPeriods.clone().text());
    assert.deepEqual(
      (await updatedWorkingPeriods.json()).schedule.workingPeriods,
      customWorkingPeriods,
    );

    const overlappingWorkingPeriods = await fetch(
      `${origin}/api/mini-app/v1/admin/settings/schedule`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Europe/Moscow',
          minimumLeadTimeMinutes: 1440,
          bookingHorizonDays: 30,
          maxMeetingsPerDay: 4,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          workingPeriods: [
            { weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 },
            { weekday: 1, startMinute: 12 * 60, endMinute: 15 * 60 },
          ],
        }),
      },
    );
    assert.equal(overlappingWorkingPeriods.status, 400);

    const restoredAdminSettings = await fetch(
      `${origin}/api/mini-app/v1/admin/settings/schedule`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Europe/Moscow',
          minimumLeadTimeMinutes: 1440,
          bookingHorizonDays: 30,
          maxMeetingsPerDay: 4,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          workingPeriods: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            startMinute: 9 * 60,
            endMinute: 18 * 60,
          })),
        }),
      },
    );
    assert.equal(restoredAdminSettings.status, 200);

    const weeksResponse = await fetch(
      `${origin}/api/mini-app/v1/availability/weeks?duration=30`,
      { headers: { cookie } },
    );
    assert.equal(weeksResponse.status, 200);
    assert.ok(Array.isArray((await weeksResponse.json()).weeks));

    const invalidDuration = await fetch(
      `${origin}/api/mini-app/v1/availability/weeks?duration=25`,
      { headers: { cookie } },
    );
    assert.equal(invalidDuration.status, 400);

    const regularSession = await createSession(
      origin,
      origin,
      signInitData({
        id: 900000003,
        first_name: 'Иван',
        last_name: 'Петров',
      }),
    );
    assert.equal(regularSession.status, 200);
    assert.equal((await regularSession.json()).user.role, 'USER');
    const regularSetCookie = regularSession.headers.get('set-cookie');
    assert.ok(regularSetCookie);
    const regularCookie = regularSetCookie.split(';', 1)[0];

    const forbiddenAdminQueue = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenAdminQueue.status, 403);
    const forbiddenAdminSettings = await fetch(
      `${origin}/api/mini-app/v1/admin/settings`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenAdminSettings.status, 403);
    const forbiddenDiagnostics = await fetch(
      `${origin}/api/mini-app/v1/admin/diagnostics`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenDiagnostics.status, 403);

    const weeks = await fetch(
      `${origin}/api/mini-app/v1/availability/weeks?duration=30`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.ok(weeks.weeks.length > 0);
    const dates = await fetch(
      `${origin}/api/mini-app/v1/availability/dates?duration=30&weekOffset=${weeks.weeks[0].offset}`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.ok(dates.dates.length > 0);
    let slots;
    for (const date of dates.dates) {
      const candidate = await fetch(
        `${origin}/api/mini-app/v1/availability/slots?duration=30&date=${date}`,
        { headers: { cookie: regularCookie } },
      ).then((response) => response.json());
      if (candidate.slots.length >= 3) {
        slots = candidate;
        break;
      }
    }
    assert.ok(slots, 'A test date must provide at least three available slots');
    assert.equal(slots.slots[0].timezone, 'Europe/Moscow');

    const bookingInput = {
      title: 'M3 Mini App end-to-end',
      comment: 'Создано через защищённый API',
      meetingFormat: 'ONLINE',
      durationMinutes: 30,
      startAt: slots.slots[0].startAt,
      email: 'ivan.m3@example.com',
      idempotencyKey: 'mini-app:m3-e2e-fixed-key',
    };
    const firstBooking = await createBooking(origin, origin, regularCookie, bookingInput);
    assert.equal(firstBooking.status, 200, await firstBooking.clone().text());
    const firstBookingBody = await firstBooking.json();
    assert.equal(firstBookingBody.booking.source, 'MINI_APP');
    assert.equal(firstBookingBody.booking.status, 'PENDING_APPROVAL');
    assert.match(firstBookingBody.booking.publicCode, /^M-/u);

    const agingDatabase = new Database(databasePath);
    try {
      agingDatabase.prepare(
        'UPDATE Booking SET createdAt = ? WHERE id = ?',
      ).run(new Date(Date.now() - 20 * 60_000).toISOString(), firstBookingBody.booking.id);
    } finally {
      agingDatabase.close();
    }

    const adminQueue = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings?scope=pending`,
      { headers: { cookie } },
    );
    assert.equal(adminQueue.status, 200);
    const adminQueueBody = await adminQueue.json();
    assert.ok(
      adminQueueBody.bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );
    const pendingAdminBooking = adminQueueBody.bookings.find(
      (booking) => booking.id === firstBookingBody.booking.id,
    );
    assert.equal(pendingAdminBooking.slotAvailable, true);
    assert.equal(pendingAdminBooking.canConfirm, true);
    assert.equal(pendingAdminBooking.canReject, true);
    assert.match(
      pendingAdminBooking.googleCalendarDayUrl,
      /^https:\/\/calendar\.google\.com\/calendar\/r\/day\/\d{4}\/\d{1,2}\/\d{1,2}/u,
    );
    assert.ok(pendingAdminBooking.waitingMinutes >= 19);
    assert.equal(pendingAdminBooking.isAging, true);
    assert.ok(adminQueueBody.summary.pending >= 1);
    assert.ok(adminQueueBody.summary.aging >= 1);
    assert.ok(adminQueueBody.summary.oldestWaitingMinutes >= 19);
    assert.ok(adminQueueBody.summary.reliability.sampleSize >= 1);
    assert.equal(adminQueueBody.summary.reliability.minimumSampleSize, 5);
    assert.equal(adminQueueBody.summary.reliability.baselineSampleSize, 9);
    assert.equal(adminQueueBody.summary.reliability.baselineSlotUnavailable, 2);
    assert.equal(adminQueueBody.summary.reliability.baselineRatePercent, 22);
    assert.equal(adminQueueBody.summary.reliability.comparison, 'COLLECTING');
    const adminDetail = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings/${firstBookingBody.booking.id}`,
      { headers: { cookie } },
    );
    assert.equal(adminDetail.status, 200);
    const adminDetailBody = await adminDetail.json();
    assert.equal(adminDetailBody.booking.user.telegramId, '900000003');
    assert.equal(adminDetailBody.booking.slotAvailable, true);
    assert.equal(adminDetailBody.booking.isAging, true);
    assert.match(
      adminDetailBody.booking.googleCalendarDayUrl,
      /^https:\/\/calendar\.google\.com\/calendar\/r\/day\/\d{4}\/\d{1,2}\/\d{1,2}/u,
    );

    const repeatedBooking = await createBooking(origin, origin, regularCookie, bookingInput);
    assert.equal(repeatedBooking.status, 200, await repeatedBooking.clone().text());
    assert.equal((await repeatedBooking.json()).booking.id, firstBookingBody.booking.id);

    const activeList = await fetch(
      `${origin}/api/mini-app/v1/bookings?scope=active`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(activeList.status, 200);
    assert.ok(
      (await activeList.json()).bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );
    const bookingDetail = await fetch(
      `${origin}/api/mini-app/v1/bookings/${firstBookingBody.booking.id}`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(bookingDetail.status, 200);
    const bookingDetailBody = await bookingDetail.json();
    assert.equal(bookingDetailBody.booking.canRetry, false);
    assert.equal(bookingDetailBody.booking.canCancel, true);
    assert.equal(bookingDetailBody.booking.googleCalendarDayUrl, null);

    const emailPreferences = await updateNotifications(
      origin,
      origin,
      regularCookie,
      { channel: 'EMAIL', email: 'm4-notify@example.com' },
    );
    assert.equal(emailPreferences.status, 200, await emailPreferences.clone().text());
    assert.equal((await emailPreferences.json()).user.notificationChannel, 'EMAIL');
    const telegramPreferences = await updateNotifications(
      origin,
      origin,
      regularCookie,
      { channel: 'TELEGRAM' },
    );
    assert.equal(telegramPreferences.status, 200);

    const confirmedInput = {
      ...bookingInput,
      title: 'M4 confirmed meeting',
      startAt: slots.slots[1].startAt,
      idempotencyKey: 'mini-app:m4-confirmed-key',
    };
    const confirmedResponse = await createBooking(
      origin,
      origin,
      regularCookie,
      confirmedInput,
    );
    assert.equal(confirmedResponse.status, 200, await confirmedResponse.clone().text());
    const confirmedBooking = (await confirmedResponse.json()).booking;
    const writableDatabase = new Database(databasePath);
    try {
      writableDatabase.prepare(
        "UPDATE Booking SET status = 'CONFIRMED' WHERE id = ?",
      ).run(confirmedBooking.id);
    } finally {
      writableDatabase.close();
    }
    const confirmedDetail = await fetch(
      `${origin}/api/mini-app/v1/bookings/${confirmedBooking.id}`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.equal(confirmedDetail.booking.canReschedule, true);

    const rescheduleBody = {
      startAt: slots.slots[2].startAt,
      email: 'ivan.m4@example.com',
      idempotencyKey: 'mini-app:m4-reschedule-key',
    };
    const rescheduleResponse = await rescheduleBooking(
      origin,
      origin,
      regularCookie,
      confirmedBooking.id,
      rescheduleBody,
    );
    assert.equal(rescheduleResponse.status, 200, await rescheduleResponse.clone().text());
    const rescheduleBookingBody = (await rescheduleResponse.json()).booking;
    assert.equal(rescheduleBookingBody.type, 'RESCHEDULE');
    assert.equal(rescheduleBookingBody.originalBookingId, confirmedBooking.id);
    assert.equal(rescheduleBookingBody.status, 'PENDING_APPROVAL');
    const repeatedReschedule = await rescheduleBooking(
      origin,
      origin,
      regularCookie,
      confirmedBooking.id,
      rescheduleBody,
    );
    assert.equal(repeatedReschedule.status, 200);
    assert.equal((await repeatedReschedule.json()).booking.id, rescheduleBookingBody.id);

    const wrongDecisionOrigin = await decideBooking(
      origin,
      'https://attacker.example',
      cookie,
      rescheduleBookingBody.id,
      'reject',
      { reason: 'Проверка Origin' },
    );
    assert.equal(wrongDecisionOrigin.status, 403);
    const rejectedReschedule = await decideBooking(
      origin,
      origin,
      cookie,
      rescheduleBookingBody.id,
      'reject',
      { reason: 'Выберите другое время' },
    );
    assert.equal(rejectedReschedule.status, 200, await rejectedReschedule.clone().text());
    const rejectedRescheduleBody = await rejectedReschedule.json();
    assert.equal(rejectedRescheduleBody.decision.outcome, 'REJECTED');
    assert.equal(rejectedRescheduleBody.booking.rejectionReason, 'Выберите другое время');
    const repeatedDecision = await decideBooking(
      origin,
      origin,
      cookie,
      rescheduleBookingBody.id,
      'reject',
      { reason: 'Повтор не меняет решение' },
    );
    assert.equal(repeatedDecision.status, 200);
    assert.equal((await repeatedDecision.json()).decision.outcome, 'ALREADY_PROCESSED');

    const conflictingDatabase = new Database(databasePath);
    try {
      conflictingDatabase.prepare(
        'UPDATE Booking SET startAt = (SELECT startAt FROM Booking WHERE id = ?) WHERE id = ?',
      ).run(firstBookingBody.booking.id, confirmedBooking.id);
    } finally {
      conflictingDatabase.close();
    }
    const unavailableAdminDetail = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings/${firstBookingBody.booking.id}`,
      { headers: { cookie } },
    );
    assert.equal(unavailableAdminDetail.status, 200);
    const unavailableAdminBooking = (await unavailableAdminDetail.json()).booking;
    assert.equal(unavailableAdminBooking.slotAvailable, false);
    assert.equal(unavailableAdminBooking.canConfirm, false);
    assert.equal(unavailableAdminBooking.canReject, true);

    const cancelResponse = await cancelBooking(
      origin,
      origin,
      regularCookie,
      firstBookingBody.booking.id,
    );
    assert.equal(cancelResponse.status, 200, await cancelResponse.clone().text());
    assert.equal((await cancelResponse.json()).changed, true);
    const repeatedCancel = await cancelBooking(
      origin,
      origin,
      regularCookie,
      firstBookingBody.booking.id,
    );
    assert.equal(repeatedCancel.status, 200);
    const repeatedCancelBody = await repeatedCancel.json();
    assert.equal(repeatedCancelBody.changed, false);
    assert.equal(repeatedCancelBody.booking.status, 'CANCELLED_BY_USER');

    const unavailableDatabase = new Database(databasePath);
    try {
      unavailableDatabase.prepare(
        "UPDATE Booking SET status = 'SLOT_UNAVAILABLE' WHERE id = ?",
      ).run(firstBookingBody.booking.id);
    } finally {
      unavailableDatabase.close();
    }
    const unavailableUserDetail = await fetch(
      `${origin}/api/mini-app/v1/bookings/${firstBookingBody.booking.id}`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(unavailableUserDetail.status, 200);
    const unavailableUserBooking = (await unavailableUserDetail.json()).booking;
    assert.equal(unavailableUserBooking.status, 'SLOT_UNAVAILABLE');
    assert.equal(unavailableUserBooking.canRetry, true);
    assert.equal(unavailableUserBooking.canCancel, false);
    assert.equal(unavailableUserBooking.canReschedule, false);

    const archiveList = await fetch(
      `${origin}/api/mini-app/v1/bookings?scope=archive`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.ok(
      archiveList.bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );

    const pastStartAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const pastDatabase = new Database(databasePath);
    try {
      pastDatabase.prepare(
        "UPDATE Booking SET status = 'PENDING_APPROVAL', startAt = ? WHERE id = ?",
      ).run(pastStartAt, firstBookingBody.booking.id);
    } finally {
      pastDatabase.close();
    }
    const activeAfterPast = await fetch(
      `${origin}/api/mini-app/v1/bookings?scope=active`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.ok(
      !activeAfterPast.bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );
    const historyAfterPast = await fetch(
      `${origin}/api/mini-app/v1/bookings?scope=archive`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.ok(
      historyAfterPast.bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );
    const pastDetail = await fetch(
      `${origin}/api/mini-app/v1/bookings/${firstBookingBody.booking.id}`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.equal(pastDetail.booking.canCancel, false);
    const pendingAfterPast = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings?scope=pending`,
      { headers: { cookie } },
    ).then((response) => response.json());
    assert.ok(
      !pendingAfterPast.bookings.some(
        (booking) => booking.id === firstBookingBody.booking.id,
      ),
    );
    const recentAfterPast = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings?scope=recent`,
      { headers: { cookie } },
    ).then((response) => response.json());
    const pastAdminBooking = recentAfterPast.bookings.find(
      (booking) => booking.id === firstBookingBody.booking.id,
    );
    assert.ok(pastAdminBooking);
    assert.equal(pastAdminBooking.queueState, 'PROCESSED');
    assert.equal(pastAdminBooking.canConfirm, false);
    assert.equal(pastAdminBooking.canReject, false);
    const pastDecision = await decideBooking(
      origin,
      origin,
      cookie,
      firstBookingBody.booking.id,
      'confirm',
    );
    assert.equal(pastDecision.status, 409);

    const wrongBookingOrigin = await createBooking(
      origin,
      'https://attacker.example',
      regularCookie,
      { ...bookingInput, idempotencyKey: 'mini-app:m3-wrong-origin' },
    );
    assert.equal(wrongBookingOrigin.status, 403);

    const database = new Database(databasePath, { readonly: true });
    try {
      const row = database.prepare(
        'SELECT COUNT(*) AS count FROM Booking WHERE idempotencyKey = ?',
      ).get(bookingInput.idempotencyKey);
      assert.equal(row.count, 1);
    } finally {
      database.close();
    }

    await sendBookingsCommand(origin, 900000003);
    const bookingMessage = [...telegramRequests]
      .reverse()
      .find((request) => request.method === 'sendMessage' && JSON.stringify(request.body).includes('M3 Mini App end-to-end'));
    assert.ok(bookingMessage, 'The existing Telegram /bookings flow should list the Mini App booking');

    const blockUserSession = await createSession(
      origin,
      origin,
      signInitData({ id: 900000004, first_name: 'Мария', last_name: 'Соколова' }),
    );
    assert.equal(blockUserSession.status, 200);
    const blockUserCookie = blockUserSession.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(blockUserCookie);
    const blockCandidateResponse = await createBooking(
      origin,
      origin,
      blockUserCookie,
      {
        ...bookingInput,
        title: 'M5 block candidate',
        startAt: slots.slots[2].startAt,
        idempotencyKey: 'mini-app:m5-block-candidate',
      },
    );
    assert.equal(blockCandidateResponse.status, 200, await blockCandidateResponse.clone().text());
    const blockCandidate = (await blockCandidateResponse.json()).booking;
    const blockedDecision = await decideBooking(
      origin,
      origin,
      cookie,
      blockCandidate.id,
      'block',
      { reason: 'Нежелательные заявки' },
    );
    assert.equal(blockedDecision.status, 200, await blockedDecision.clone().text());
    const blockedBody = await blockedDecision.json();
    assert.equal(blockedBody.decision.outcome, 'BLOCKED');
    assert.equal(blockedBody.booking.user.status, 'BANNED');
    assert.equal(blockedBody.booking.status, 'REJECTED');
    const forbiddenBlockedUsers = await fetch(
      `${origin}/api/mini-app/v1/admin/blocked-users`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenBlockedUsers.status, 403);
    const blockedUsers = await fetch(
      `${origin}/api/mini-app/v1/admin/blocked-users`,
      { headers: { cookie } },
    );
    assert.equal(blockedUsers.status, 200);
    const blockedUsersBody = await blockedUsers.json();
    const blockedUser = blockedUsersBody.users.find(
      (user) => user.userId === blockedBody.booking.user.id,
    );
    assert.ok(blockedUser);
    assert.equal(blockedUser.displayName, 'Мария Соколова');
    assert.equal(blockedUser.reason, 'Нежелательные заявки');
    const wrongUnblockOrigin = await fetch(
      `${origin}/api/mini-app/v1/admin/blocked-users/${blockedUser.userId}/unblock`,
      { method: 'POST', headers: { cookie, origin: 'https://attacker.example' } },
    );
    assert.equal(wrongUnblockOrigin.status, 403);
    const unblockResponse = await fetch(
      `${origin}/api/mini-app/v1/admin/blocked-users/${blockedUser.userId}/unblock`,
      { method: 'POST', headers: { cookie, origin } },
    );
    assert.equal(unblockResponse.status, 200, await unblockResponse.clone().text());
    assert.equal((await unblockResponse.json()).changed, true);
    const repeatedUnblock = await fetch(
      `${origin}/api/mini-app/v1/admin/blocked-users/${blockedUser.userId}/unblock`,
      { method: 'POST', headers: { cookie, origin } },
    ).then((response) => response.json());
    assert.equal(repeatedUnblock.changed, false);
    const restoredUser = await fetch(`${origin}/api/mini-app/v1/me`, {
      headers: { cookie: blockUserCookie },
    });
    assert.equal(restoredUser.status, 200);
    const recentAdminQueue = await fetch(
      `${origin}/api/mini-app/v1/admin/bookings?scope=recent`,
      { headers: { cookie } },
    );
    assert.equal(recentAdminQueue.status, 200);
    assert.ok(
      (await recentAdminQueue.json()).bookings.some(
        (booking) => booking.id === blockCandidate.id,
      ),
    );

    const forbiddenRestrictions = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenRestrictions.status, 403);
    const restrictionDate = dates.dates.at(-1);
    assert.ok(restrictionDate);
    const wrongRestrictionOrigin = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: 'https://attacker.example' },
        body: JSON.stringify({ date: restrictionDate, type: 'FULL_DAY' }),
      },
    );
    assert.equal(wrongRestrictionOrigin.status, 403);
    const createRestriction = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({
          date: restrictionDate,
          type: 'FULL_DAY',
          comment: 'M10 full-day restriction',
        }),
      },
    );
    assert.equal(createRestriction.status, 200, await createRestriction.clone().text());
    const createdRestriction = await createRestriction.json();
    assert.equal(createdRestriction.created, true);
    assert.equal(createdRestriction.restriction.date, restrictionDate);
    assert.equal(createdRestriction.restriction.type, 'FULL_DAY');
    assert.equal(createdRestriction.restriction.calendarSyncStatus, 'PENDING');
    const duplicateRestriction = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ date: restrictionDate, type: 'FULL_DAY' }),
      },
    ).then((response) => response.json());
    assert.equal(duplicateRestriction.created, false);
    const restrictedSlots = await fetch(
      `${origin}/api/mini-app/v1/availability/slots?duration=30&date=${restrictionDate}`,
      { headers: { cookie: regularCookie } },
    ).then((response) => response.json());
    assert.equal(restrictedSlots.slots.length, 0);
    const restrictionList = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions`,
      { headers: { cookie } },
    ).then((response) => response.json());
    assert.ok(
      restrictionList.restrictions.some(
        (restriction) => restriction.id === createdRestriction.restriction.id,
      ),
    );
    const deleteRestriction = await fetch(
      `${origin}/api/mini-app/v1/admin/restrictions/${createdRestriction.restriction.id}`,
      { method: 'DELETE', headers: { cookie, origin } },
    );
    assert.equal(deleteRestriction.status, 200, await deleteRestriction.clone().text());
    assert.equal((await deleteRestriction.json()).deleted, true);

    const forbiddenTemplates = await fetch(
      `${origin}/api/mini-app/v1/admin/templates`,
      { headers: { cookie: regularCookie } },
    );
    assert.equal(forbiddenTemplates.status, 403);
    const templatesResponse = await fetch(
      `${origin}/api/mini-app/v1/admin/templates`,
      { headers: { cookie } },
    );
    assert.equal(templatesResponse.status, 200);
    const templatesBody = await templatesResponse.json();
    assert.equal(templatesBody.templates.length, 8);
    const confirmedTemplate = templatesBody.templates.find(
      (template) => template.type === 'BOOKING_CONFIRMED',
    );
    assert.ok(confirmedTemplate);
    assert.ok(
      confirmedTemplate.allowedPlaceholders.some(
        (placeholder) => placeholder.name === 'date',
      ),
    );
    const wrongTemplateOrigin = await fetch(
      `${origin}/api/mini-app/v1/admin/templates/BOOKING_CONFIRMED`,
      {
        method: 'PATCH',
        headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
        body: JSON.stringify({ text: confirmedTemplate.text }),
      },
    );
    assert.equal(wrongTemplateOrigin.status, 403);
    const unknownPlaceholder = await fetch(
      `${origin}/api/mini-app/v1/admin/templates/BOOKING_CONFIRMED`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Встреча {unknown_value}' }),
      },
    );
    assert.equal(unknownPlaceholder.status, 400);
    const editedTemplateText = 'Встреча подтверждена на {date} в {time} ({tz_label}).';
    const editedTemplate = await fetch(
      `${origin}/api/mini-app/v1/admin/templates/BOOKING_CONFIRMED`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ text: editedTemplateText }),
      },
    );
    assert.equal(editedTemplate.status, 200, await editedTemplate.clone().text());
    assert.equal((await editedTemplate.json()).template.text, editedTemplateText);
    const restoredTemplate = await fetch(
      `${origin}/api/mini-app/v1/admin/templates/BOOKING_CONFIRMED`,
      {
        method: 'PATCH',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ text: confirmedTemplate.text }),
      },
    );
    assert.equal(restoredTemplate.status, 200);

    const logoutResponse = await fetch(`${origin}/api/mini-app/v1/session`, {
      method: 'DELETE',
      headers: { cookie, origin },
    });
    assert.equal(logoutResponse.status, 204);
    assert.match(
      logoutResponse.headers.get('set-cookie') ?? '',
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/iu,
    );

    assert.equal(stdout.join('').includes(validAdminInitData), false);
    assert.equal(stderr.join('').includes(validAdminInitData), false);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
    await new Promise((resolve, reject) => {
      telegramServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function createSession(origin, requestOrigin, initData) {
  return fetch(`${origin}/api/mini-app/v1/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: requestOrigin,
    },
    body: JSON.stringify({ initData }),
  });
}

function createBooking(origin, requestOrigin, cookie, body) {
  return fetch(`${origin}/api/mini-app/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

function updateNotifications(origin, requestOrigin, cookie, body) {
  return fetch(`${origin}/api/mini-app/v1/me/notifications`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

function cancelBooking(origin, requestOrigin, cookie, bookingId) {
  return fetch(`${origin}/api/mini-app/v1/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
  });
}

function rescheduleBooking(
  origin,
  requestOrigin,
  cookie,
  bookingId,
  body,
) {
  return fetch(`${origin}/api/mini-app/v1/bookings/${bookingId}/reschedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

function decideBooking(
  origin,
  requestOrigin,
  cookie,
  bookingId,
  action,
  body = {},
) {
  return fetch(`${origin}/api/mini-app/v1/admin/bookings/${bookingId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

async function sendBookingsCommand(origin, telegramId) {
  const response = await fetch(`${origin}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'mini-app-webhook-secret',
    },
    body: JSON.stringify({
      update_id: 700001,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: telegramId, type: 'private', first_name: 'Иван' },
        from: { id: telegramId, is_bot: false, first_name: 'Иван' },
        text: '/bookings',
        entities: [{ offset: 0, length: 9, type: 'bot_command' }],
      },
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

function signInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const values = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAE2-mini-app-test-query',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const hash = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');
  values.set('hash', hash);
  return values.toString();
}

async function startTelegramApi(port, requests) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : {};
    const method = request.url?.split('/').at(-1) ?? '';
    requests.push({ method, body });
    response.setHeader('content-type', 'application/json');
    if (method === 'getMe') {
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'Mini App Test Bot',
            username: 'mini_app_test_bot',
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        }),
      );
      return;
    }
    if (method === 'sendMessage') {
      response.end(JSON.stringify({
        ok: true,
        result: {
          message_id: requests.length,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private', first_name: 'Иван' },
          text: body.text,
          from: { id: 123456789, is_bot: true, first_name: 'Mini App Test Bot', username: 'mini_app_test_bot' },
        },
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

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

async function waitForHealth(origin, child, stdout, stderr) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Application exited early (${child.exitCode}).\n${stdout.join('')}\n${stderr.join('')}`,
      );
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Application did not become healthy.\n${stdout.join('')}\n${stderr.join('')}`,
  );
}
