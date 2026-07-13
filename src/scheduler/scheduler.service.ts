import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { BookingService } from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  MeetingFormat,
  MessageTemplateType,
} from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private expirationTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private notificationRetryTimer?: NodeJS.Timeout;
  private meetingReminderTimer?: NodeJS.Timeout;

  constructor(
    private readonly bookings: BookingService,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly logger: JsonLoggerService,
  ) {}

  onModuleInit(): void {
    this.expirationTimer = setInterval(() => {
      void this.expireAndNotify().catch((error: unknown) =>
        this.logFailure('scheduler.expiration.failed', error),
      );
    }, 60_000);
    this.notificationRetryTimer = setInterval(() => {
      void this.notifications.retryPending().catch((error: unknown) =>
        this.logFailure('scheduler.notification_retry.failed', error),
      );
    }, 60_000);
    this.meetingReminderTimer = setInterval(() => {
      void this.sendUpcomingReminders().catch((error: unknown) =>
        this.logFailure('scheduler.meeting_reminder.failed', error),
      );
    }, 60_000);
    this.cleanupTimer = setInterval(() => {
      void this.bookings.cleanupOldData().catch((error: unknown) =>
        this.logFailure('scheduler.cleanup.failed', error),
      );
    }, 6 * 60 * 60_000);
    this.expirationTimer.unref();
    this.notificationRetryTimer.unref();
    this.meetingReminderTimer.unref();
    this.cleanupTimer.unref();
    this.logger.logEvent('SchedulerService', 'scheduler.started', {
      expiration_interval_ms: 60_000,
      notification_retry_interval_ms: 60_000,
      meeting_reminder_interval_ms: 60_000,
      cleanup_interval_ms: 6 * 60 * 60_000,
    });
  }

  onModuleDestroy(): void {
    if (this.expirationTimer) clearInterval(this.expirationTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.notificationRetryTimer) clearInterval(this.notificationRetryTimer);
    if (this.meetingReminderTimer) clearInterval(this.meetingReminderTimer);
  }

  private async expireAndNotify(): Promise<void> {
    const expired = await this.bookings.expirePending();
    for (const item of expired) {
      await this.notifications.notifyUser({
        userId: item.userId,
        bookingId: item.bookingId,
        eventType: 'BOOKING_EXPIRED',
        templateType: MessageTemplateType.BOOKING_EXPIRED,
        subject: 'Заявка на встречу закрыта',
        fallbackText:
          'Заявка закрыта автоматически, так как не была обработана в течение 48 часов. Вы можете создать новую заявку.',
      });
    }
  }

  async sendUpcomingReminders(now = new Date()): Promise<number> {
    const upcoming = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.CONFIRMED,
        startAt: {
          gt: now,
          lte: new Date(now.getTime() + 60 * 60_000),
        },
      },
      include: { calendarEvent: true },
    });
    let sent = 0;
    for (const booking of upcoming) {
      const exists = await this.prisma.notificationDelivery.findFirst({
        where: { bookingId: booking.id, eventType: 'MEETING_REMINDER' },
        select: { id: true },
      });
      if (exists) continue;
      const online = booking.meetingFormat === MeetingFormat.ONLINE;
      await this.notifications.notifyUser({
        userId: booking.userId,
        bookingId: booking.id,
        eventType: 'MEETING_REMINDER',
        subject: 'Встреча начнётся через час',
        fallbackText: online
          ? `⏰ Встреча «${booking.title}» начнётся через час.\nGoogle Meet: ${booking.calendarEvent?.googleMeetUrl ?? 'ссылка временно недоступна'}`
          : `⏰ Личная встреча «${booking.title}» начнётся через час.`,
      });
      sent += 1;
    }
    if (sent) {
      this.logger.logEvent('SchedulerService', 'meeting.reminders.sent', {
        reminder_count: sent,
      });
    }
    return sent;
  }

  private logFailure(event: string, error: unknown): void {
    this.logger.errorEvent('SchedulerService', event, {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
