import assert from 'node:assert/strict';

import { ConfigService } from '@nestjs/config';

import { AdminReviewController } from '../src/bookings/admin-review.controller';
import { AdminReviewTokenService } from '../src/bookings/admin-review-token.service';
import { BookingDecisionService } from '../src/bookings/booking-decision.service';
import { BookingService } from '../src/bookings/booking.service';
import { createPrismaClient } from '../src/database/prisma-client.factory';
import { applySqliteMigrations } from '../src/database/sqlite-migrator';
import {
  BookingStatus,
  BookingSource,
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
    const confirmedPendingEvents: string[] = [];
    const pendingDescriptions: string[] = [];
    const updatedDescriptions: string[] = [];
    const pendingSourceUrls: string[] = [];
    const updatedSourceUrls: string[] = [];
    const googleCalendar = {
      isConfigured: () => true,
      createPendingEvent: async (input: { description: string; sourceUrl?: string }) => {
        pendingDescriptions.push(input.description);
        if (input.sourceUrl) pendingSourceUrls.push(input.sourceUrl);
        return {
        googleEventId: `stage6-pending-${++eventSequence}`,
        googleMeetUrl: null,
        };
      },
      updatePendingEvent: async (
        _googleEventId: string,
        input: { description: string; sourceUrl?: string },
      ) => {
        pendingDescriptions.push(input.description);
        if (input.sourceUrl) pendingSourceUrls.push(input.sourceUrl);
      },
      updateEventDescription: async (
        _googleEventId: string,
        description: string,
        source?: { url: string } | null,
      ) => {
        updatedDescriptions.push(description);
        if (source?.url) updatedSourceUrls.push(source.url);
      },
      confirmPendingEvent: async (
        googleEventId: string,
        input: { createConference?: boolean },
      ) => {
        confirmedPendingEvents.push(googleEventId);
        conferenceChoices.push(input.createConference !== false);
        return {
          googleEventId,
          googleMeetUrl:
            input.createConference === false
              ? null
              : 'https://meet.google.com/stage-six-test',
        };
      },
      createEvent: async (input: { createConference?: boolean }) => {
        conferenceChoices.push(input.createConference !== false);
        return {
          googleEventId: `stage6-direct-${++eventSequence}`,
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
    const reviewTokens = new AdminReviewTokenService(
      new ConfigService({
        app: {
          publicBaseUrl: 'https://meeting.example.com',
          adminActionSecret: 'stage6-admin-action-secret-1234567890',
        },
      }),
    );
    const service = new BookingService(
      prisma as never,
      availability as never,
      googleCalendar as never,
      new JsonLoggerService(),
      reviewTokens,
    );

    const validToken = reviewTokens.createToken(
      'stage6booking',
      new Date('2030-02-01T00:00:00.000Z'),
    );
    assert.equal(
      reviewTokens.verifyToken(validToken, new Date('2029-01-01T00:00:00.000Z'))
        ?.bookingId,
      'stage6booking',
    );
    assert.equal(
      reviewTokens.verifyToken(
        `${validToken.slice(0, -1)}x`,
        new Date('2029-01-01T00:00:00.000Z'),
      ),
      null,
    );
    assert.equal(
      reviewTokens.verifyToken(validToken, new Date('2031-01-01T00:00:00.000Z')),
      null,
    );
    const webBooking = {
      id: 'stage6booking',
      title: 'Web review smoke',
      startAt: new Date('2030-02-01T09:00:00.000Z'),
      durationMinutes: 45,
      timezone: 'Europe/Moscow',
      comment: 'Review from Google Calendar',
      meetingFormat: MeetingFormat.ONLINE,
      status: BookingStatus.PENDING_APPROVAL,
      user: {
        telegramDisplayName: 'Stage 6 user',
        telegramUsername: 'stage6_user',
      },
    };
    const webDecisions: string[] = [];
    const reviewController = new AdminReviewController(
      {
        booking: {
          findUnique: async () => webBooking,
        },
      } as never,
      reviewTokens,
      {
        decide: async (_bookingId: string, action: string) => {
          webDecisions.push(action);
          return {
            bookingId: 'stage6booking',
            outcome: action === 'confirm' ? 'CONFIRMED' : 'REJECTED',
            bookingStatus:
              action === 'confirm'
                ? BookingStatus.CONFIRMED
                : BookingStatus.REJECTED,
          };
        },
      } as never,
      {
        getCalendarDayUrl: async () =>
          'https://calendar.google.com/calendar/r/day/2030/2/1?authuser=owner%40example.com',
      } as never,
    );
    const reviewPage = responseRecorder();
    await reviewController.showReview(validToken, reviewPage.response);
    assert.equal(reviewPage.status, 200);
    assert.match(reviewPage.body, /Подтвердить/u);
    assert.match(reviewPage.body, /Отклонить/u);
    assert.match(reviewPage.body, /← Открыть заявку в Telegram/u);
    assert.match(reviewPage.body, /Открыть Google Calendar/u);
    assert.match(reviewPage.body, /start=calendar_stage6booking/u);
    assert.match(reviewPage.body, /scrollControls/u);
    assert.deepEqual(webDecisions, []);
    const invalidPage = responseRecorder();
    await reviewController.showReview(`${validToken}x`, invalidPage.response);
    assert.equal(invalidPage.status, 403);
    const decisionPage = responseRecorder();
    await reviewController.submitDecision(
      validToken,
      'confirm',
      decisionPage.response,
    );
    assert.equal(decisionPage.status, 200);
    assert.match(decisionPage.body, /← Открыть заявку в Telegram/u);
    assert.match(decisionPage.body, /Открыть Google Calendar/u);
    assert.doesNotMatch(decisionPage.body, /Можно закрыть эту вкладку/u);
    assert.deepEqual(webDecisions, ['confirm']);

    const first = await service.create({
      userId: user.id,
      source: BookingSource.MINI_APP,
      idempotencyKey: 'stage6-mini-app-create-1',
      durationMinutes: 45,
      startAt: new Date('2030-02-01T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 confirmation',
    });
    assert.match(first.publicCode ?? '', /^M-[A-F0-9]{10}$/u);
    assert.equal(first.source, BookingSource.MINI_APP);
    assert.equal(first.idempotencyKey, 'stage6-mini-app-create-1');
    const repeatedFirst = await service.create({
      userId: user.id,
      source: BookingSource.MINI_APP,
      idempotencyKey: 'stage6-mini-app-create-1',
      durationMinutes: 45,
      startAt: new Date('2030-02-01T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 confirmation',
    });
    assert.equal(repeatedFirst.id, first.id);
    assert.equal(eventSequence, 1);
    assert.equal(first.emailSnapshot, null);
    assert.equal(first.calendarEvent?.syncStatus, 'PENDING');
    assert.equal(first.calendarEvent?.googleEventId, 'stage6-pending-1');
    assert.ok(!pendingDescriptions[0].includes('/admin/review/'));
    assert.match(
      pendingDescriptions[0],
      /нажмите ниже яркую строку «🔴 ОТКРЫТЬ ЗАЯВКУ/u,
    );
    assert.doesNotMatch(pendingDescriptions[0], /https:\/\/t\.me\//u);
    assert.match(
      pendingSourceUrls[0],
      /^https:\/\/meeting\.example\.com\/admin\/review\//u,
    );
    assert.match(
      await service.ensureCalendarReturnLink(first.id),
      /^https:\/\/t\.me\/Zapiscalender_bot\?start=calendar_/u,
    );
    assert.match(
      updatedDescriptions[0],
      /нажмите ниже яркую строку «🔴 ОТКРЫТЬ ЗАЯВКУ/u,
    );
    assert.ok(!updatedDescriptions[0].includes('/admin/review/'));
    assert.doesNotMatch(updatedDescriptions[0], /https:\/\/t\.me\//u);
    assert.match(
      updatedSourceUrls[0],
      /^https:\/\/meeting\.example\.com\/admin\/review\//u,
    );
    const decisionNotifications: string[] = [];
    const decisionService = new BookingDecisionService(
      prisma as never,
      service,
      {
        notifyUser: async (input: { eventType: string }) => {
          decisionNotifications.push(input.eventType);
        },
      } as never,
      new JsonLoggerService(),
    );
    const [adminAccountOne, adminAccountTwo] = await Promise.all([
      decisionService.decide(first.id, 'confirm'),
      decisionService.decide(first.id, 'confirm'),
    ]);
    assert.equal(adminAccountOne.outcome, 'CONFIRMED');
    assert.equal(adminAccountTwo.outcome, 'CONFIRMED');
    assert.deepEqual(decisionNotifications, ['BOOKING_CONFIRMED']);
    assert.equal(
      await prisma.calendarEvent.count({ where: { bookingId: first.id } }),
      1,
    );
    assert.equal(
      (await decisionService.decide(first.id, 'confirm')).outcome,
      'ALREADY_PROCESSED',
    );
    const confirmed = await prisma.booking.findUniqueOrThrow({
      where: { id: first.id },
      include: { calendarEvent: true, slotReservation: true },
    });
    assert.equal(confirmed.status, BookingStatus.CONFIRMED);
    assert.equal(confirmed.calendarEvent?.googleEventId, 'stage6-pending-1');
    assert.equal(confirmed.calendarEvent?.syncStatus, 'SYNCED');
    assert.ok(confirmedPendingEvents.includes('stage6-pending-1'));
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
    assert.ok(cancelledGoogleEvents.includes('stage6-pending-1'));

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
    await service.reject(second.id, 'Stage 6 reason');
    const rejected = await prisma.booking.findUniqueOrThrow({
      where: { id: second.id },
      include: { slotReservation: true, calendarEvent: true },
    });
    assert.equal(rejected.status, BookingStatus.REJECTED);
    assert.equal(rejected.rejectionReason, 'Stage 6 reason');
    assert.equal(
      rejected.slotReservation?.status,
      SlotReservationStatus.RELEASED,
    );
    assert.equal(rejected.calendarEvent?.syncStatus, 'CANCELLED');
    assert.ok(
      cancelledGoogleEvents.includes(second.calendarEvent!.googleEventId),
    );

    const third = await service.create({
      userId: user.id,
      durationMinutes: 60,
      startAt: new Date('2030-02-03T09:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 block',
    });
    await service.setUserBlocked(user.id, true, 6999n, 'Stage 6 block reason');
    const blocked = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const autoRejected = await prisma.booking.findUniqueOrThrow({
      where: { id: third.id },
      include: { slotReservation: true, calendarEvent: true },
    });
    assert.equal(blocked.status, UserStatus.BANNED);
    assert.equal(
      (await prisma.blacklistEntry.findUniqueOrThrow({ where: { userId: user.id } })).reason,
      'Stage 6 block reason',
    );
    assert.equal(autoRejected.status, BookingStatus.REJECTED);
    assert.equal(
      autoRejected.slotReservation?.status,
      SlotReservationStatus.RELEASED,
    );
    assert.equal(autoRejected.calendarEvent?.syncStatus, 'CANCELLED');
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
      include: { slotReservation: true, calendarEvent: true },
    });
    assert.equal(expired.status, BookingStatus.EXPIRED);
    assert.equal(
      expired.slotReservation?.status,
      SlotReservationStatus.EXPIRED,
    );
    assert.equal(expired.calendarEvent?.syncStatus, 'CANCELLED');

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

    const approvalBooking = await service.create({
      userId: user.id,
      durationMinutes: 30,
      startAt: new Date('2030-02-08T12:00:00.000Z'),
      timezone: 'Europe/Moscow',
      title: 'Stage 6 approval reminder',
      meetingFormat: MeetingFormat.IN_PERSON,
    });
    const approvalNow = new Date();
    await prisma.booking.update({
      where: { id: approvalBooking.id },
      data: {
        createdAt: new Date(approvalNow.getTime() - 20 * 60_000),
        expiresAt: new Date(approvalNow.getTime() + 60 * 60_000),
      },
    });
    assert.equal(await scheduler.sendApprovalReminders(approvalNow), 1);
    assert.equal(await scheduler.sendApprovalReminders(approvalNow), 0);
    assert.ok(
      telegramMessages.some(({ text }) =>
        text.includes('Stage 6 approval reminder') && text.includes('20 мин'),
      ),
    );
    assert.equal(
      await prisma.businessEvent.count({
        where: {
          bookingId: approvalBooking.id,
          eventType: 'ADMIN_APPROVAL_REMINDER',
        },
      }),
      1,
    );

    process.stdout.write(
      `${JSON.stringify({
        event: 'stage6.booking.verification.completed',
        create_and_reserve_checked: true,
        google_confirmation_checked: true,
        pending_calendar_lifecycle_checked: true,
        signed_calendar_review_link_checked: true,
        calendar_review_web_page_checked: true,
        optional_email_checked: true,
        rejection_release_checked: true,
        cancellation_checked: true,
        reschedule_checked: true,
        meeting_format_checked: true,
        expiration_checked: true,
        block_auto_reject_checked: true,
        two_admin_one_calendar_event_checked: true,
        unblock_checked: true,
        email_routing_checked: true,
        telegram_routing_checked: true,
        notification_retry_checked: true,
        one_hour_meeting_reminder_checked: true,
        admin_approval_reminder_checked: true,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

function responseRecorder(): {
  response: never;
  status: number;
  body: string;
} {
  const recorder = {
    status: 0,
    body: '',
    response: undefined as never,
  };
  const response = {
    status(code: number) {
      recorder.status = code;
      return response;
    },
    set() {
      return response;
    },
    type() {
      return response;
    },
    send(body: string) {
      recorder.body = body;
      return response;
    },
  };
  recorder.response = response as never;
  return recorder;
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
