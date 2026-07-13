import 'dotenv/config';

import { ConfigService } from '@nestjs/config';

import { AvailabilityService } from '../src/availability/availability.service';
import { createPrismaClient } from '../src/database/prisma-client.factory';
import { GoogleCalendarService } from '../src/google-calendar/google-calendar.service';
import { JsonLoggerService } from '../src/logging/json-logger.service';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? 'file:./data/app.db';
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  try {
    const config = new ConfigService({
      google: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? null,
        redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? null,
        calendarId: process.env.GOOGLE_CALENDAR_ID ?? 'primary',
      },
      app: { telegramBotToken: null, adminTelegramId: null },
    });
    const logger = new JsonLoggerService();
    const service = new GoogleCalendarService(
      prisma as never,
      config,
      logger,
    );
    const timeMin = new Date();
    const timeMax = new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);
    const busy = await service.getBusyIntervals(
      timeMin,
      timeMax,
      'Europe/Moscow',
    );
    const availability = new AvailabilityService(
      prisma as never,
      logger,
      service,
    );
    const weekStartedAt = Date.now();
    const weeks = await availability.getAvailableWeeks(30);
    const weekCalculationMs = Date.now() - weekStartedAt;
    process.stdout.write(
      `${JSON.stringify({
        event: 'google.live.freebusy.completed',
        authorized: true,
        busy_interval_count: busy.length,
        available_week_count: weeks.length,
        week_calculation_ms: weekCalculationMs,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'google.live.freebusy.failed',
      error_message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
