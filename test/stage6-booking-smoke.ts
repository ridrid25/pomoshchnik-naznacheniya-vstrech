import assert from 'node:assert/strict';

import { ConfigService } from '@nestjs/config';

import { BookingService } from '../src/bookings/booking.service';
import { createPrismaClient } from '../src/database/prisma-client.factory';
import { applySqliteMigrations } from '../src/database/sqlite-migrator';
import {
  BookingStatus,
  BookingType,
  MessageTemplateType,
  MeetingFormat,
  NotificationChannel,
  NotificationDeliveryStatus,
  SlotReservationStatus,
  UserStatus,
} from '../src/generated/prisma/client';
import { JsonLoggerService } from '../src/logging/json-logger.service';
import { NotificationService } from '../src/notifications/notification.service';
import { SchedulerService } from '../src/scheduler/scheduler.service';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  applySqliteMigrations(databaseUrl);
  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
  try {
    const user = await prisma.user.create({
      data: {
        telegramId: 6001n,
        telegramDisplayName: 'Stage 6 user',
      },
    });
    const availability = {
      isSlotAvailable: async () => true,
    };
    let eventSequence = 0;
    const cancelledGoogleEvents: string[] = [];
    const conferenceChoices: boolean[] = [];
    const googleCalendar = {
      createEvent: async (input: { createConference?: boolean }) => {
        conferenceChoices.push(input.createConference !== false);
        return {
          googleEventId: `stage6-${++eventSequence}`,
          googleMeetUrl:
            input.createConference === false
              ? null
              : 'https://meet.google.com/stage-six-test',
        };
      },
      cancelEvent: async (googleEventId: string) => {
        cancelledGoogleEvents.push(googleEventId);
      },
    };
    const service = new BookingService(
      prisma as never,
      availability as never,
      googleCalendar as never,
      new JsonLoggerService(),
    );

    const first = await service.create({
      userId: user.id,
      durationMinutes: 45,
      startAt: new Date('2030-02-01T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 confirmation',
    });
    assert.equal(first.emailSnapshot, null);
    const confirmation = await service.confirm(first.id);
    assert.equal(confirmation.status, 'CONFIRMED');
    const confirmed = await prisma.booking.findUniqueOrThrow({
      where: { id: first.id },
      include: { calendarEvent: true, slotReservation: true },
    });
    assert.equal(confirmed.status, BookingStatus.CONFIRMED);
    assert.equal(confirmed.calendarEvent?.guestEmail, null);
    assert.equal(
      confirmed.calendarEvent?.googleMeetUrl,
      'https://meet.google.com/stage-six-test',
    );
    const reschedule = await service.create({
      userId: user.id,
      durationMinutes: 45,
      startAt: new Date('2030-02-05T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 confirmation',
      type: BookingType.RESCHEDULE,
      originalBookingId: first.id,
    });
    assert.equal((await service.confirm(reschedule.id)).status, 'CONFIRMED');
    const originalAfterReschedule = await prisma.booking.findUniqueOrThrow({
      where: { id: first.id },
      include: { calendarEvent: true, slotReservation: true },
    });
    assert.equal(
      originalAfterReschedule.status,
      BookingStatus.CANCELLED_BY_USER,
    );
    assert.equal(originalAfterReschedule.calendarEvent?.syncStatus, 'CANCELLED');
    assert.ok(cancelledGoogleEvents.includes('stage6-1'));

    await service.cancelByUser(reschedule.id, user.id);
    const cancelled = await prisma.booking.findUniqueOrThrow({
      where: { id: reschedule.id },
      include: { calendarEvent: true, slotReservation: true },
    });
    assert.equal(cancelled.status, BookingStatus.CANCELLED_BY_USER);
    assert.equal(
      cancelled.slotReservation?.status,
      SlotReservationStatus.RELEASED,
    );
    assert.equal(cancelled.calendarEvent?.syncStatus, 'CANCELLED');

    const inPerson = await service.create({
      userId: user.id,
      durationMinutes: 30,
      startAt: new Date('2030-02-07T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 in-person meeting',
      meetingFormat: MeetingFormat.IN_PERSON,
    });
    assert.equal((await service.confirm(inPerson.id)).status, 'CONFIRMED');
    const confirmedInPerson = await prisma.booking.findUniqueOrThrow({
      where: { id: inPerson.id },
      include: { calendarEvent: true },
    });
    assert.equal(confirmedInPerson.calendarEvent?.googleMeetUrl, null);
    assert.equal(conferenceChoices.at(-1), false);

    const second = await service.create({
      userId: user.id,
      durationMinutes: 30,
      startAt: new Date('2030-02-02T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 rejection',
      email: 'stage6@example.com',
    });
    await service.reject(second.id);
    const rejected = await prisma.booking.findUniqueOrThrow({
      where: { id: second.id },
      include: { slotReservation: true },
    });
    assert.equal(rejected.status, BookingStatus.REJECTED);
    assert.equal(
      rejected.slotReservation?.status,
      SlotReservationStatus.RELEASED,
    );

    const third = await service.create({
      userId: user.id,
      durationMinutes: 60,
      startAt: new Date('2030-02-03T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 block',
    });
    await service.setUserBlocked(user.id, true, 6999n);
    const blocked = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const autoRejected = await prisma.booking.findUniqueOrThrow({
      where: { id: third.id },
      include: { slotReservation: true },
    });
    assert.equal(blocked.status, UserStatus.BANNED);
    assert.equal(autoRejected.status, BookingStatus.REJECTED);
    assert.equal(
      autoRejected.slotReservation?.status,
      SlotReservationStatus.RELEASED,
    );
    await service.setUserBlocked(user.id, false, 6999n);
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      UserStatus.ACTIVE,
    );

    const expiring = await service.create({
      userId: user.id,
      durationMinutes: 30,
      startAt: new Date('2030-02-04T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 expiry',
    });
    await prisma.booking.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    assert.equal((await service.expirePending(new Date())).length, 1);
    const expired = await prisma.booking.findUniqueOrThrow({
      where: { id: expiring.id },
      include: { slotReservation: true },
    });
    assert.equal(expired.status, BookingStatus.EXPIRED);
    assert.equal(
      expired.slotReservation?.status,
      SlotReservationStatus.EXPIRED,
    );

    const logger = new JsonLoggerService();
    const notificationService = new NotificationService(
      prisma as never,
      new ConfigService({}) as never,
      logger,
    );
    const emailMessages: Array<{ to?: string; subject?: string }> = [];
    const telegramMessages: Array<{ chatId: string; text: string }> = [];
    let emailShouldFail = false;
    Reflect.set(notificationService, 'smtpFrom', 'bot@example.com');
    Reflect.set(notificationService, 'smtpTransport', {
      sendMail: async (message: { to?: string; subject?: string }) => {
        if (emailShouldFail) throw new Error('Synthetic SMTP failure');
        emailMessages.push(message);
      },
    });
    Reflect.set(notificationService, 'adminTelegramId', '6999');
    Reflect.set(notificationService, 'telegramBot', {
      api: {
        sendMessage: async (chatId: string, text: string) => {
          telegramMessages.push({ chatId, text });
        },
      },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        notificationChannel: NotificationChannel.EMAIL,
        lastConfirmedEmail: 'stage6@example.com',
      },
    });
    await notificationService.notifyUser({
      userId: user.id,
      eventType: 'BOOKING_CONFIRMED',
      templateType: MessageTemplateType.BOOKING_CONFIRMED,
      subject: 'Stage 6 email',
      fallbackText: 'Confirmed {duration}',
      variables: { duration: 45 },
    });
    assert.equal(emailMessages.length, 1);
    assert.equal(emailMessages[0].to, 'stage6@example.com');

    emailShouldFail = true;
    await notificationService.notifyUser({
      userId: user.id,
      eventType: 'BOOKING_REJECTED',
      templateType: MessageTemplateType.BOOKING_REJECTED,
      subject: 'Stage 6 retry',
      fallbackText: 'Rejected',
    });
    assert.equal(
      (await prisma.notificationDelivery.findFirstOrThrow({
        where: { subject: 'Stage 6 retry' },
      })).attempts,
      1,
    );
    await notificationService.retryPending(new Date('2100-01-01T00:00:00.000Z'));
    await notificationService.retryPending(new Date('2100-01-01T00:00:00.000Z'));
    const failedDelivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { subject: 'Stage 6 retry' },
    });
    assert.equal(failedDelivery.attempts, 3);
    assert.equal(failedDelivery.status, NotificationDeliveryStatus.FAILED);
    assert.ok(telegramMessages.some(({ chatId }) => chatId === '6999'));

    await prisma.user.update({
      where: { id: user.id },
      data: { notificationChannel: NotificationChannel.TELEGRAM },
    });
    await notificationService.notifyUser({
      userId: user.id,
      eventType: 'BOOKING_CANCELLED',
      templateType: MessageTemplateType.BOOKING_CANCELLED,
      subject: 'Stage 6 Telegram',
      fallbackText: 'Cancelled',
    });
    assert.ok(telegramMessages.some(({ chatId }) => chatId === '6001'));

    const reminderBooking = await service.create({
      userId: user.id,
      durationMinutes: 30,
      startAt: new Date('2030-02-08T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 online reminder',
      meetingFormat: MeetingFormat.ONLINE,
    });
    assert.equal((await service.confirm(reminderBooking.id)).status, 'CONFIRMED');
    const scheduler = new SchedulerService(
      service,
      notificationService,
      prisma as never,
      logger,
    );
    assert.equal(
      await scheduler.sendUpcomingReminders(
        new Date('2030-02-08T08:00:30.000Z'),
      ),
      1,
    );
    assert.equal(
      await scheduler.sendUpcomingReminders(
        new Date('2030-02-08T08:01:00.000Z'),
      ),
      0,
    );
    assert.ok(
      telegramMessages.some(({ text }) =>
        text.includes('https://meet.google.com/stage-six-test'),
      ),
    );

    process.stdout.write(
      `${JSON.stringify({
        event: 'stage6.booking.verification.completed',
        create_and_reserve_checked: true,
        google_confirmation_checked: true,
        optional_email_checked: true,
        rejection_release_checked: true,
        cancellation_checked: true,
        reschedule_checked: true,
        meeting_format_checked: true,
        expiration_checked: true,
        block_auto_reject_checked: true,
        unblock_checked: true,
        email_routing_checked: true,
        telegram_routing_checked: true,
        notification_retry_checked: true,
        one_hour_meeting_reminder_checked: true,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'stage6.booking.verification.failed',
      error_message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
