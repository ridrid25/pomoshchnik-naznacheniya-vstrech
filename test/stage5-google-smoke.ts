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
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  try {
    await prisma.googleOAuthToken.create({
      data: {
        id: 1,
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        scope: 'https://www.googleapis.com/auth/calendar',
        tokenType: 'Bearer',
        expiryDate: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    const fakeCalendar = {
      freebusy: {
        query: async (params: Record<string, unknown>) => {
          calls.push({ method: 'freebusy.query', params });
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
              id: 'google-stage5-event',
              hangoutLink:
                params.conferenceDataVersion === 1
                  ? 'https://meet.google.com/stage-five-test'
                  : undefined,
            },
          };
        },
        patch: async (params: Record<string, unknown>) => {
          calls.push({ method: 'events.patch', params });
          return { data: { id: 'google-stage5-event', status: 'cancelled' } };
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
      app: { telegramBotToken: null, adminTelegramId: null },
    });
    const service = new GoogleCalendarService(
      prisma as unknown as PrismaService,
      config,
      new JsonLoggerService(),
    );

    assert.deepEqual(await service.getStatus(), {
      configured: true,
      authorized: true,
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    const authorizationUrl = new URL(service.createAuthorizationUrl());
    assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
    assert.equal(authorizationUrl.searchParams.get('prompt'), 'consent');
    assert.ok(authorizationUrl.searchParams.get('state'));

    const busy = await service.getBusyIntervals(
      new Date('2030-01-15T00:00:00.000Z'),
      new Date('2030-01-16T00:00:00.000Z'),
      'Europe/Moscow',
    );
    assert.equal(busy.length, 1);
    assert.equal(busy[0]?.start.toISOString(), '2030-01-15T09:00:00.000Z');

    const created = await service.createEvent({
      title: 'Stage 5 test',
      description: 'Telegram user: Stage 5',
      startAt: new Date('2030-01-15T09:00:00.000Z'),
      endAt: new Date('2030-01-15T09:30:00.000Z'),
      timezone: 'Europe/Moscow',
      attendeeEmail: 'stage5@example.com',
    });
    assert.deepEqual(created, {
      googleEventId: 'google-stage5-event',
      googleMeetUrl: 'https://meet.google.com/stage-five-test',
    });
    const insert = calls.find((call) => call.method === 'events.insert');
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
    )[1];
    const bodyWithoutEmail = insertWithoutEmail?.params.requestBody as {
      attendees?: Array<{ email: string }>;
      conferenceData?: unknown;
    };
    assert.equal(bodyWithoutEmail.attendees, undefined);
    assert.equal(insertWithoutEmail?.params.conferenceDataVersion, undefined);
    assert.equal(bodyWithoutEmail.conferenceData, undefined);

    await service.cancelEvent(created.googleEventId);
    const cancellation = calls.find((call) => call.method === 'events.patch');
    assert.equal(cancellation?.params.eventId, 'google-stage5-event');
    assert.deepEqual(cancellation?.params.requestBody, { status: 'cancelled' });

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
      })}\n`,
    );
  } finally {
    (google as unknown as { calendar: typeof google.calendar }).calendar =
      originalCalendar;
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
