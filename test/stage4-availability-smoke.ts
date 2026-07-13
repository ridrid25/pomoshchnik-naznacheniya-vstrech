import assert from 'node:assert/strict';

import { AvailabilityService } from '../src/availability/availability.service';
import { createPrismaClient } from '../src/database/prisma-client.factory';
import { ensureDefaultData } from '../src/database/default-data';
import { PrismaService } from '../src/database/prisma.service';
import { applySqliteMigrations } from '../src/database/sqlite-migrator';
import {
  BookingStatus,
  RestrictionType,
  SlotReservationStatus,
} from '../src/generated/prisma/client';
import { JsonLoggerService } from '../src/logging/json-logger.service';
import { GoogleCalendarService } from '../src/google-calendar/google-calendar.service';

const now = new Date('2026-07-13T06:00:00.000Z'); // Monday, 09:00 Moscow.
const monday = '2026-07-13';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  applySqliteMigrations(databaseUrl);
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  try {
    await ensureDefaultData(prisma);
    let googleBusyIntervals: Array<{ start: Date; end: Date }> = [];
    let googleBusyRequestCount = 0;
    const availability = new AvailabilityService(
      prisma as unknown as PrismaService,
      new JsonLoggerService(),
      {
        getBusyIntervals: async () => {
          googleBusyRequestCount += 1;
          return googleBusyIntervals;
        },
      } as unknown as GoogleCalendarService,
    );
    await resetFixture(prisma as unknown as PrismaService);

    googleBusyRequestCount = 0;
    const batchedWeeks = await availability.getAvailableWeeks(30, now);
    assert.ok(batchedWeeks.length > 0);
    assert.equal(
      googleBusyRequestCount,
      1,
      'Week menu must use one batched Google free/busy request',
    );

    const initialSlots = await availability.getAvailableSlots(monday, 30, now);
    assert.equal(initialSlots.length, 16);
    assert.equal(initialSlots[0]?.time, '10:00');
    assert.equal(initialSlots.at(-1)?.time, '17:30');
    assert.ok(
      initialSlots.every(
        (slot, index, values) =>
          index === 0 ||
          slot.startAt.getTime() - values[index - 1].startAt.getTime() ===
            30 * 60_000,
      ),
      'Slots must use a 30-minute start step',
    );
    googleBusyIntervals = [
      {
        start: new Date('2026-07-13T12:00:00.000Z'),
        end: new Date('2026-07-13T12:30:00.000Z'),
      },
    ];
    assert.equal(
      await availability.isSlotAvailable(monday, '15:00', 30, now),
      false,
      'Google busy interval must hide its slot',
    );
    googleBusyIntervals = [];
    assert.equal(
      (await availability.getAvailableSlots('2026-07-18', 30, now)).length,
      0,
      'Saturday must be hidden',
    );
    assert.equal(
      (await availability.getAvailableSlots('2026-08-13', 30, now)).length,
      0,
      'Date outside 30-day horizon must be hidden',
    );

    await prisma.availabilityRestriction.create({
      data: {
        date: new Date(`${monday}T00:00:00.000Z`),
        type: RestrictionType.TIME_INTERVAL,
        startMinute: 11 * 60,
        endMinute: 12 * 60,
      },
    });
    const restrictedSlots = await availability.getAvailableSlots(monday, 30, now);
    assert.ok(!restrictedSlots.some((slot) => slot.time === '11:00'));
    assert.ok(!restrictedSlots.some((slot) => slot.time === '11:30'));
    assert.ok(restrictedSlots.some((slot) => slot.time === '10:30'));
    await prisma.availabilityRestriction.deleteMany();

    const user = await prisma.user.create({
      data: {
        telegramId: 44440001n,
        telegramDisplayName: 'Stage 4 User',
        lastConfirmedEmail: 'stage4@example.com',
      },
    });
    const reservedBooking = await prisma.booking.create({
      data: {
        userId: user.id,
        durationMinutes: 30,
        startAt: new Date('2026-07-13T10:00:00.000Z'),
        timezone: 'Europe/Moscow',
        title: 'Reserved at 13:00 Moscow',
        emailSnapshot: 'stage4@example.com',
        expiresAt: new Date('2026-07-15T00:00:00.000Z'),
        slotReservation: {
          create: {
            startAt: new Date('2026-07-13T10:00:00.000Z'),
            endAt: new Date('2026-07-13T10:30:00.000Z'),
            expiresAt: new Date('2026-07-15T00:00:00.000Z'),
          },
        },
      },
    });
    assert.equal(
      await availability.isSlotAvailable(monday, '13:00', 30, now),
      false,
      'Active reservation must hide its slot',
    );

    await prisma.scheduleSettings.update({
      where: { id: 1 },
      data: { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
    });
    const bufferedSlots = await availability.getAvailableSlots(monday, 30, now);
    for (const time of ['12:30', '13:00', '13:30']) {
      assert.ok(!bufferedSlots.some((slot) => slot.time === time));
    }
    assert.ok(bufferedSlots.some((slot) => slot.time === '14:00'));

    await prisma.slotReservation.update({
      where: { bookingId: reservedBooking.id },
      data: { expiresAt: new Date('2026-07-13T05:59:00.000Z') },
    });
    assert.equal(
      await availability.isSlotAvailable(monday, '13:00', 30, now),
      true,
      'Expired reservation must not hide a slot',
    );

    await prisma.$transaction([
      prisma.booking.update({
        where: { id: reservedBooking.id },
        data: { status: BookingStatus.CONFIRMED },
      }),
      prisma.slotReservation.update({
        where: { bookingId: reservedBooking.id },
        data: { status: SlotReservationStatus.RELEASED },
      }),
      prisma.scheduleSettings.update({
        where: { id: 1 },
        data: { maxMeetingsPerDay: 1 },
      }),
    ]);
    assert.equal(
      (await availability.getAvailableSlots(monday, 30, now)).length,
      0,
      'Daily meeting limit must hide the entire day',
    );

    await prisma.scheduleSettings.update({
      where: { id: 1 },
      data: { maxMeetingsPerDay: 10, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    });
    await prisma.availabilityRestriction.create({
      data: {
        date: new Date(`${monday}T00:00:00.000Z`),
        type: RestrictionType.FULL_DAY,
      },
    });
    assert.equal(
      (await availability.getAvailableSlots(monday, 30, now)).length,
      0,
      'Full-day restriction must hide the entire day',
    );
    await prisma.availabilityRestriction.deleteMany();

    const weekOffsets = await availability.getAvailableWeekOffsets(30, now);
    assert.ok(weekOffsets.length > 0);
    const firstWeekDates = await availability.getAvailableDates(
      30,
      weekOffsets[0],
      now,
    );
    assert.ok(firstWeekDates.every((date) => date >= monday));

    await prisma.scheduleSettings.update({
      where: { id: 1 },
      data: {
        timezone: 'America/New_York',
        minimumLeadTimeMinutes: 0,
      },
    });
    const newYorkSlots = await availability.getAvailableSlots(
      '2026-07-14',
      30,
      new Date('2026-07-13T00:00:00.000Z'),
    );
    assert.equal(newYorkSlots[0]?.time, '09:00');
    assert.equal(newYorkSlots[0]?.startAt.toISOString(), '2026-07-14T13:00:00.000Z');

    process.stdout.write(
      `${JSON.stringify({
        event: 'stage4.availability.verification.completed',
        initial_slot_count: initialSlots.length,
        restriction_checked: true,
        reservation_checked: true,
        buffers_checked: true,
        daily_limit_checked: true,
        horizon_checked: true,
        timezone_checked: true,
        google_busy_checked: true,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function resetFixture(prisma: PrismaService): Promise<void> {
  await prisma.availabilityRestriction.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.blacklistEntry.deleteMany();
  await prisma.user.deleteMany();
  await prisma.scheduleWorkingPeriod.deleteMany({
    where: { scheduleSettingsId: 1 },
  });
  await prisma.scheduleSettings.update({
    where: { id: 1 },
    data: {
      minimumLeadTimeMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxMeetingsPerDay: 10,
      bookingHorizonDays: 30,
      timezone: 'Europe/Moscow',
    },
  });
  await prisma.scheduleWorkingPeriod.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({
      scheduleSettingsId: 1,
      weekday,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      enabled: true,
    })),
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'stage4.availability.verification.failed',
      error_message: error instanceof Error ? error.message : String(error),
      trace: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
