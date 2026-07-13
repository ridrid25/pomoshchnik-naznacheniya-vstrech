import assert from 'node:assert/strict';

import {
  BookingStatus,
  BookingType,
  CalendarSyncStatus,
  MessageTemplateType,
  MeetingFormat,
  NotificationChannel,
  Prisma,
  RestrictionType,
  SlotReservationStatus,
  SystemLogLevel,
  UserStatus,
} from '../src/generated/prisma/client';
import { createPrismaClient } from '../src/database/prisma-client.factory';

const prisma = createPrismaClient();

async function main(): Promise<void> {
  const settings = await prisma.scheduleSettings.findUnique({
    where: { id: 1 },
    include: { workingPeriods: { orderBy: { weekday: 'asc' } } },
  });
  assert.ok(settings, 'Schedule settings seed must exist');
  assert.equal(settings.timezone, 'Europe/Moscow');
  assert.deepEqual(
    settings.workingPeriods.map((period) => period.weekday),
    [1, 2, 3, 4, 5],
  );

  const templateCount = await prisma.messageTemplate.count();
  assert.equal(templateCount, Object.keys(MessageTemplateType).length);

  const user = await prisma.user.create({
    data: {
      telegramId: 123456789012345n,
      telegramUsername: 'stage2_user',
      telegramDisplayName: 'Stage 2 User',
      lastConfirmedEmail: 'stage2@example.com',
    },
  });
  assert.equal(user.lastConfirmedEmail, 'stage2@example.com');
  assert.equal(user.notificationChannel, NotificationChannel.TELEGRAM);
  assert.equal(user.status, UserStatus.ACTIVE);

  const emailNotificationUser = await prisma.user.update({
    where: { id: user.id },
    data: { notificationChannel: NotificationChannel.EMAIL },
  });
  assert.equal(
    emailNotificationUser.notificationChannel,
    NotificationChannel.EMAIL,
  );

  const persistedNotificationPreference = await prisma.user.findUniqueOrThrow({
    where: { telegramId: user.telegramId },
  });
  assert.equal(
    persistedNotificationPreference.notificationChannel,
    NotificationChannel.EMAIL,
  );

  const startAt = new Date('2030-01-15T09:00:00.000Z');
  const endAt = new Date('2030-01-15T09:30:00.000Z');
  const expiresAt = new Date('2030-01-14T09:00:00.000Z');
  const booking = await prisma.booking.create({
    data: {
      userId: user.id,
      type: BookingType.NEW,
      durationMinutes: 30,
      startAt,
      timezone: 'Europe/Moscow',
      title: 'Stage 2 relation smoke',
      emailSnapshot: 'stage2@example.com',
      status: BookingStatus.CONFIRMED,
      expiresAt,
      slotReservation: {
        create: {
          startAt,
          endAt,
          expiresAt,
          status: SlotReservationStatus.RELEASED,
        },
      },
      calendarEvent: {
        create: {
          googleEventId: 'stage2-google-event-1',
          googleMeetUrl: 'https://meet.google.com/stage-two-smoke',
          guestEmail: 'stage2@example.com',
          syncStatus: CalendarSyncStatus.SYNCED,
        },
      },
    },
    include: { slotReservation: true, calendarEvent: true, user: true },
  });
  assert.equal(booking.user.id, user.id);
  assert.equal(booking.meetingFormat, MeetingFormat.ONLINE);
  assert.equal(booking.slotReservation?.bookingId, booking.id);
  assert.equal(booking.calendarEvent?.bookingId, booking.id);

  const reschedule = await prisma.booking.create({
    data: {
      userId: user.id,
      type: BookingType.RESCHEDULE,
      durationMinutes: 30,
      startAt: new Date('2030-01-16T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: booking.title,
      emailSnapshot: booking.emailSnapshot,
      status: BookingStatus.PENDING_APPROVAL,
      expiresAt: new Date('2030-01-15T09:00:00.000Z'),
      originalBookingId: booking.id,
    },
    include: { originalBooking: true },
  });
  assert.equal(reschedule.originalBooking?.id, booking.id);

  await assert.rejects(
    prisma.user.create({
      data: {
        telegramId: user.telegramId,
        telegramDisplayName: 'Duplicate Telegram ID',
      },
    }),
    isUniqueConstraintError,
  );

  await assert.rejects(
    prisma.slotReservation.create({
      data: {
        bookingId: booking.id,
        startAt,
        endAt,
        expiresAt,
      },
    }),
    isUniqueConstraintError,
  );

  await assert.rejects(
    prisma.booking.create({
      data: {
        userId: 'missing-user',
        durationMinutes: 30,
        startAt,
        timezone: 'Europe/Moscow',
        title: 'Foreign key violation',
        emailSnapshot: 'missing@example.com',
        expiresAt,
      },
    }),
    isForeignKeyConstraintError,
  );

  await prisma.blacklistEntry.create({
    data: {
      userId: user.id,
      reason: 'Stage 2 smoke',
      createdByTelegramId: 999999999n,
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      notificationChannel: NotificationChannel.TELEGRAM,
      status: UserStatus.BANNED,
    },
  });
  const bannedUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: { blacklistEntry: true },
  });
  assert.equal(bannedUser?.status, UserStatus.BANNED);
  assert.equal(
    bannedUser?.notificationChannel,
    NotificationChannel.TELEGRAM,
  );
  assert.equal(bannedUser?.blacklistEntry?.active, true);

  await prisma.availabilityRestriction.create({
    data: {
      date: new Date('2030-01-20T00:00:00.000Z'),
      type: RestrictionType.TIME_INTERVAL,
      startMinute: 600,
      endMinute: 720,
      comment: 'Stage 2 smoke restriction',
    },
  });
  await prisma.systemLog.create({
    data: {
      eventType: 'stage2.smoke',
      level: SystemLogLevel.INFO,
      relatedEntityType: 'Booking',
      relatedEntityId: booking.id,
      message: 'Stage 2 system log smoke',
    },
  });
  await prisma.businessEvent.create({
    data: {
      eventType: 'booking.confirmed',
      userId: user.id,
      bookingId: booking.id,
      payload: JSON.stringify({ source: 'stage2-smoke' }),
    },
  });
  await prisma.notificationDelivery.create({
    data: {
      userId: user.id,
      bookingId: booking.id,
      channel: NotificationChannel.TELEGRAM,
      eventType: 'BOOKING_CONFIRMED',
      recipient: String(user.telegramId),
      subject: 'Stage 2 notification queue',
      text: 'Stage 2 notification body',
    },
  });

  const summary = {
    users: await prisma.user.count(),
    bookings: await prisma.booking.count(),
    reservations: await prisma.slotReservation.count(),
    calendarEvents: await prisma.calendarEvent.count(),
    restrictions: await prisma.availabilityRestriction.count(),
    blacklistEntries: await prisma.blacklistEntry.count(),
    messageTemplates: await prisma.messageTemplate.count(),
    systemLogs: await prisma.systemLog.count(),
    businessEvents: await prisma.businessEvent.count(),
    notificationDeliveries: await prisma.notificationDelivery.count(),
  };
  assert.deepEqual(summary, {
    users: 1,
    bookings: 2,
    reservations: 1,
    calendarEvents: 1,
    restrictions: 1,
    blacklistEntries: 1,
    messageTemplates: 8,
    systemLogs: 1,
    businessEvents: 1,
    notificationDeliveries: 1,
  });

  process.stdout.write(
    `${JSON.stringify({ event: 'database.smoke.completed', ...summary })}\n`,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003'
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'database.smoke.failed',
        error_message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
