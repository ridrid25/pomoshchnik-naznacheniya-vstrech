import assert from 'node:assert/strict';

import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

import { createPrismaClient } from '../src/database/prisma-client.factory';
import { PrismaService } from '../src/database/prisma.service';
import { applySqliteMigrations } from '../src/database/sqlite-migrator';
import { GoogleCalendarService } from '../src/google-calendar/google-calendar.service';
import { JsonLoggerService } from '../src/logging/json-logger.service';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  applySqliteMigrations(databaseUrl);
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  const originalCalendar = google.calendar;
  const originalOauth2 = google.oauth2;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const telegramAlerts: Array<Record<string, unknown>> = [];
  let insertedEventSequence = 0;
  let freeBusyError: Error | null = null;
  try {
    globalThis.fetch = (async (_input, init) => {
      telegramAlerts.push(
        JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      );
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await prisma.googleOAuthToken.create({
      data: {
        id: 1,
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        scope: 'https://www.googleapis.com/auth/calendar',
        tokenType: 'Bearer',
        expiryDate: new Date('2030-01-01T00:00:00.000Z'),
        accountEmail: 'owner@example.com',
      },
    });
    const fakeCalendar = {
      calendars: {
        get: async (params: Record<string, unknown>) => {
          calls.push({ method: 'calendars.get', params });
          return { data: { id: 'primary' } };
        },
      },
      freebusy: {
        query: async (params: Record<string, unknown>) => {
          calls.push({ method: 'freebusy.query', params });
          if (freeBusyError) throw freeBusyError;
          return {
            data: {
              calendars: {
                primary: {
                  busy: [
                    {
                      start: '2030-01-15T09:00:00.000Z',
                      end: '2030-01-15T09:30:00.000Z',
                    },
                  ],
                },
              },
            },
          };
        },
      },
      events: {
        insert: async (params: Record<string, unknown>) => {
          calls.push({ method: 'events.insert', params });
          return {
            data: {
              id: `google-stage5-event-${++insertedEventSequence}`,
              hangoutLink:
                params.conferenceDataVersion === 1
                  ? 'https://meet.google.com/stage-five-test'
                  : undefined,
            },
          };
        },
        patch: async (params: Record<string, unknown>) => {
          calls.push({ method: 'events.patch', params });
          return {
            data: {
              id: params.eventId,
              status: (params.requestBody as { status?: string })?.status,
              hangoutLink:
                params.conferenceDataVersion === 1
                  ? 'https://meet.google.com/stage-five-pending'
                  : undefined,
            },
          };
        },
        delete: async (params: Record<string, unknown>) => {
          calls.push({ method: 'events.delete', params });
          return { data: {} };
        },
      },
    };
    (google as unknown as { calendar: () => unknown }).calendar = () => fakeCalendar;
    const config = new ConfigService({
      google: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/google/oauth/callback',
        calendarId: 'primary',
      },
      app: {
        telegramBotToken: 'stage5-bot-token',
        adminTelegramId: '900000001',
      },
    });
    const service = new GoogleCalendarService(
      prisma as unknown as PrismaService,
      config,
      new JsonLoggerService(),
    );
    assert.equal(await service.getAccountEmail(), 'owner@example.com');

    assert.deepEqual(await service.getStatus(), {
      configured: true,
      authorized: true,
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    const authorizationUrl = new URL(
      service.createAuthorizationUrl(await service.getAccountEmail()),
    );
    assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
    assert.equal(
      authorizationUrl.searchParams.get('prompt'),
      'select_account consent',
    );
    assert.equal(
      authorizationUrl.searchParams.get('login_hint'),
      'owner@example.com',
    );
    assert.match(
      authorizationUrl.searchParams.get('scope') ?? '',
      /userinfo\.email/u,
    );
    assert.ok(authorizationUrl.searchParams.get('state'));

    const originalCreateOAuthClient = (
      service as unknown as {
        createOAuthClient: () => unknown;
      }
    ).createOAuthClient;
    const fakeOauth = {
      getToken: async () => ({
        tokens: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          scope:
            'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email',
          token_type: 'Bearer',
          expiry_date: new Date('2031-01-01T00:00:00.000Z').getTime(),
        },
      }),
      setCredentials: () => undefined,
    };
    (
      service as unknown as {
        createOAuthClient: () => unknown;
      }
    ).createOAuthClient = () => fakeOauth;
    (google as unknown as { oauth2: () => unknown }).oauth2 = () => ({
      userinfo: {
        get: async () => ({ data: { email: 'NEW-OWNER@example.com' } }),
      },
    });
    await service.handleOAuthCallback(
      'stage5-valid-code',
      authorizationUrl.searchParams.get('state')!,
    );
    assert.equal(await service.getAccountEmail(), 'new-owner@example.com');
    const refreshedToken = await prisma.googleOAuthToken.findUnique({
      where: { id: 1 },
    });
    assert.equal(refreshedToken?.refreshToken, 'new-refresh-token');

    (
      service as unknown as {
        createOAuthClient: () => unknown;
      }
    ).createOAuthClient = originalCreateOAuthClient;
    const missingRefreshUrl = new URL(service.createAuthorizationUrl());
    (
      service as unknown as {
        createOAuthClient: () => unknown;
      }
    ).createOAuthClient = () => ({
      getToken: async () => ({
        tokens: {
          access_token: 'access-without-refresh',
          expiry_date: new Date('2031-02-01T00:00:00.000Z').getTime(),
        },
      }),
      setCredentials: () => undefined,
    });
    await assert.rejects(
      service.handleOAuthCallback(
        'stage5-code-without-refresh',
        missingRefreshUrl.searchParams.get('state')!,
      ),
      /new refresh token/u,
    );
    const tokenAfterRejectedCallback =
      await prisma.googleOAuthToken.findUnique({ where: { id: 1 } });
    assert.equal(tokenAfterRejectedCallback?.refreshToken, 'new-refresh-token');
    assert.equal(tokenAfterRejectedCallback?.accountEmail, 'new-owner@example.com');
    (
      service as unknown as {
        createOAuthClient: () => unknown;
      }
    ).createOAuthClient = originalCreateOAuthClient;

    const busy = await service.getBusyIntervals(
      new Date('2030-01-15T00:00:00.000Z'),
      new Date('2030-01-16T00:00:00.000Z'),
      'Europe/Moscow',
    );
    assert.equal(busy.length, 1);
    assert.equal(busy[0]?.start.toISOString(), '2030-01-15T09:00:00.000Z');

    const pending = await service.createPendingEvent({
      bookingId: 'booking-stage5-pending',
      title: 'Stage 5 pending',
      description: 'Awaiting Telegram approval',
      startAt: new Date('2030-01-15T08:00:00.000Z'),
      endAt: new Date('2030-01-15T08:30:00.000Z'),
      timezone: 'Europe/Moscow',
      sourceUrl: 'https://meeting.example.com/admin/review/signed-token',
      sourceTitle: '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
    });
    assert.equal(pending.googleEventId, 'google-stage5-event-1');
    const pendingInsert = calls.find((call) => {
      const requestBody = call.params.requestBody as { status?: string } | undefined;
      return call.method === 'events.insert' && requestBody?.status === 'tentative';
    });
    const pendingBody = pendingInsert?.params.requestBody as {
      summary: string;
      status: string;
      transparency: string;
      colorId: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      attendees?: unknown;
      conferenceData?: unknown;
      source?: { title: string; url: string };
    };
    assert.ok(pendingBody.summary.startsWith('⏳ На согласовании'));
    assert.ok(pendingBody.summary.includes('Stage 5 pending'));
    assert.equal(pendingBody.status, 'tentative');
    assert.equal(pendingBody.transparency, 'transparent');
    assert.equal(pendingBody.colorId, '8');
    assert.deepEqual(pendingBody.start, {
      dateTime: '2030-01-15T08:00:00.000Z',
      timeZone: 'Europe/Moscow',
    });
    assert.deepEqual(pendingBody.end, {
      dateTime: '2030-01-15T08:30:00.000Z',
      timeZone: 'Europe/Moscow',
    });
    assert.equal(pendingBody.attendees, undefined);
    assert.equal(pendingBody.conferenceData, undefined);
    assert.deepEqual(pendingBody.source, {
      title: '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
      url: 'https://meeting.example.com/admin/review/signed-token',
    });

    await service.updateEventDescription(
      pending.googleEventId,
      '← Открыть встречу в Telegram:\nhttps://t.me/example_bot?start=calendar_booking',
      {
        title: '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
        url: 'https://meeting.example.com/admin/review/signed-token',
      },
    );
    const descriptionPatch = calls.find((call) => {
      const requestBody = call.params.requestBody as { description?: string; status?: string } | undefined;
      return call.method === 'events.patch' && requestBody?.description?.includes('Открыть встречу в Telegram') && !requestBody.status;
    });
    assert.equal(descriptionPatch?.params.eventId, pending.googleEventId);
    assert.equal(descriptionPatch?.params.sendUpdates, 'none');
    assert.deepEqual(
      (descriptionPatch?.params.requestBody as { source?: unknown }).source,
      {
        title: '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
        url: 'https://meeting.example.com/admin/review/signed-token',
      },
    );

    const confirmedPending = await service.confirmPendingEvent(
      pending.googleEventId,
      {
        title: 'Stage 5 confirmed pending',
        description: 'Approved in Telegram',
        startAt: new Date('2030-01-15T08:00:00.000Z'),
        endAt: new Date('2030-01-15T08:30:00.000Z'),
        timezone: 'Europe/Moscow',
        attendeeEmail: 'stage5@example.com',
        createConference: true,
      },
    );
    const confirmationPatch = calls.find((call) => {
      const requestBody = call.params.requestBody as { status?: string } | undefined;
      return call.method === 'events.patch' && requestBody?.status === 'confirmed';
    });
    assert.equal(
      (confirmationPatch?.params.requestBody as { source?: unknown }).source,
      null,
    );
    assert.deepEqual(confirmedPending, {
      googleEventId: 'google-stage5-event-1',
      googleMeetUrl: 'https://meet.google.com/stage-five-pending',
    });
    const pendingPatch = calls.find((call) => {
      const requestBody = call.params.requestBody as { status?: string } | undefined;
      return call.method === 'events.patch' && requestBody?.status === 'confirmed';
    });
    const confirmedPendingBody = pendingPatch?.params.requestBody as {
      status: string;
      transparency: string;
      colorId: string;
      attendees: Array<{ email: string }>;
      conferenceData: { createRequest: { requestId: string } };
    };
    assert.equal(confirmedPendingBody.transparency, 'opaque');
    assert.equal(confirmedPendingBody.colorId, '10');
    assert.equal(confirmedPendingBody.attendees[0]?.email, 'stage5@example.com');
    assert.ok(confirmedPendingBody.conferenceData.createRequest.requestId);

    const created = await service.createEvent({
      title: 'Stage 5 test',
      description: 'Telegram user: Stage 5',
      startAt: new Date('2030-01-15T09:00:00.000Z'),
      endAt: new Date('2030-01-15T09:30:00.000Z'),
      timezone: 'Europe/Moscow',
      attendeeEmail: 'stage5@example.com',
    });
    assert.deepEqual(created, {
      googleEventId: 'google-stage5-event-2',
      googleMeetUrl: 'https://meet.google.com/stage-five-test',
    });
    const insert = calls.filter((call) => call.method === 'events.insert')[1];
    assert.equal(insert?.params.conferenceDataVersion, 1);
    assert.equal(insert?.params.sendUpdates, 'all');
    const body = insert?.params.requestBody as {
      attendees: Array<{ email: string }>;
      reminders: { overrides: Array<{ minutes: number }> };
      conferenceData: { createRequest: { requestId: string } };
    };
    assert.equal(body.attendees[0]?.email, 'stage5@example.com');
    assert.equal(body.reminders.overrides[0]?.minutes, 60);
    assert.ok(body.conferenceData.createRequest.requestId);

    await service.createEvent({
      title: 'Stage 5 Telegram-only test',
      description: 'Telegram delivery without guest email',
      startAt: new Date('2030-01-15T10:00:00.000Z'),
      endAt: new Date('2030-01-15T10:45:00.000Z'),
      timezone: 'Europe/Moscow',
      attendeeEmail: null,
      createConference: false,
    });
    const insertWithoutEmail = calls.filter(
      (call) => call.method === 'events.insert',
    )[2];
    const bodyWithoutEmail = insertWithoutEmail?.params.requestBody as {
      attendees?: Array<{ email: string }>;
      conferenceData?: unknown;
    };
    assert.equal(bodyWithoutEmail.attendees, undefined);
    assert.equal(insertWithoutEmail?.params.conferenceDataVersion, undefined);
    assert.equal(bodyWithoutEmail.conferenceData, undefined);

    const availabilityBlockId = await service.createAvailabilityBlockEvent({
      restrictionId: 'restriction-stage5',
      date: '2030-01-18',
      startMinute: 16 * 60,
      endMinute: 17 * 60,
      timezone: 'Europe/Moscow',
      comment: 'Личные дела',
    });
    assert.equal(availabilityBlockId, 'google-stage5-event-4');
    const availabilityInsert = calls.filter(
      (call) => call.method === 'events.insert',
    )[3];
    const availabilityBody = availabilityInsert?.params.requestBody as {
      summary: string;
      transparency: string;
      colorId: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      extendedProperties: { private: { availabilityRestrictionId: string } };
    };
    assert.equal(availabilityBody.summary, '⛔ Недоступно для записи');
    assert.equal(availabilityBody.transparency, 'opaque');
    assert.equal(availabilityBody.colorId, '11');
    assert.equal(availabilityBody.start.dateTime, '2030-01-18T16:00:00');
    assert.equal(availabilityBody.end.dateTime, '2030-01-18T17:00:00');
    assert.equal(
      availabilityBody.extendedProperties.private.availabilityRestrictionId,
      'restriction-stage5',
    );
    await service.deleteAvailabilityBlockEvent(availabilityBlockId);
    const availabilityDelete = calls.find(
      (call) => call.method === 'events.delete',
    );
    assert.equal(availabilityDelete?.params.eventId, availabilityBlockId);
    assert.equal(availabilityDelete?.params.sendUpdates, 'none');

    await service.cancelEvent(created.googleEventId);
    const cancellation = calls.find((call) => {
      const requestBody = call.params.requestBody as { status?: string } | undefined;
      return call.method === 'events.patch' && requestBody?.status === 'cancelled';
    });
    assert.equal(cancellation?.params.eventId, 'google-stage5-event-2');
    assert.deepEqual(cancellation?.params.requestBody, { status: 'cancelled' });

    freeBusyError = new Error('invalid_grant');
    await assert.rejects(
      service.getBusyIntervals(
        new Date('2030-01-16T00:00:00.000Z'),
        new Date('2030-01-17T00:00:00.000Z'),
        'Europe/Moscow',
      ),
      /invalid_grant/u,
    );
    assert.deepEqual(await service.getStatus(), {
      configured: true,
      authorized: false,
      tokenExpiresAt: null,
    });
    assert.equal(
      await service.getAccountEmail(),
      'new-owner@example.com',
      'An expired authorization must not erase the selected account hint',
    );
    await assert.rejects(
      service.getBusyIntervals(
        new Date('2030-01-16T00:00:00.000Z'),
        new Date('2030-01-17T00:00:00.000Z'),
        'Europe/Moscow',
      ),
      /not authorized/u,
    );
    assert.equal(
      telegramAlerts.length,
      1,
      'Repeated authorization failures must produce one actionable alert',
    );

    process.stdout.write(
      `${JSON.stringify({
        event: 'stage5.google.verification.completed',
        oauth_url_checked: true,
        token_status_checked: true,
        freebusy_checked: true,
        event_payload_checked: true,
        optional_email_checked: true,
        meet_checked: true,
        in_person_without_meet_checked: true,
        cancellation_checked: true,
        pending_event_lifecycle_checked: true,
        availability_block_sync_checked: true,
        invalid_grant_disconnect_checked: true,
        duplicate_alert_suppression_checked: true,
        oauth_account_identity_checked: true,
        oauth_refresh_token_required: true,
      })}\n`,
    );
  } finally {
    (google as unknown as { calendar: typeof google.calendar }).calendar =
      originalCalendar;
    (google as unknown as { oauth2: typeof google.oauth2 }).oauth2 =
      originalOauth2;
    globalThis.fetch = originalFetch;
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'stage5.google.verification.failed',
      error_message: error instanceof Error ? error.message : String(error),
      trace: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
