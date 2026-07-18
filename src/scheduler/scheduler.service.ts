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

const APPROVAL_REMINDER_AFTER_MS = 15 * 60_000;
const APPROVAL_REMINDER_EVENT = 'ADMIN_APPROVAL_REMINDER';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private expirationTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private notificationRetryTimer?: NodeJS.Timeout;
  private meetingReminderTimer?: NodeJS.Timeout;
  private approvalReminderTimer?: NodeJS.Timeout;

  constructor(
    private readonly bookings: BookingService,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly logger: JsonLoggerService,
  ) {}

  onModuleInit(): void {
    void this.bookings.syncPendingCalendarMarkers().catch((error: unknown) =>
      this.logFailure('scheduler.pending_calendar_sync.failed', error),
    );
    void this.sendApprovalReminders().catch((error: unknown) =>
      this.logFailure('scheduler.approval_reminder.failed', error),
    );
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
    this.approvalReminderTimer = setInterval(() => {
      void this.sendApprovalReminders().catch((error: unknown) =>
        this.logFailure('scheduler.approval_reminder.failed', error),
      );
    }, 5 * 60_000);
    this.cleanupTimer = setInterval(() => {
      void this.bookings.cleanupOldData().catch((error: unknown) =>
        this.logFailure('scheduler.cleanup.failed', error),
      );
    }, 6 * 60 * 60_000);
    this.expirationTimer.unref();
    this.notificationRetryTimer.unref();
    this.meetingReminderTimer.unref();
    this.approvalReminderTimer.unref();
    this.cleanupTimer.unref();
    this.logger.logEvent('SchedulerService', 'scheduler.started', {
      expiration_interval_ms: 60_000,
      notification_retry_interval_ms: 60_000,
      meeting_reminder_interval_ms: 60_000,
      approval_reminder_interval_ms: 5 * 60_000,
      cleanup_interval_ms: 6 * 60 * 60_000,
    });
  }

  onModuleDestroy(): void {
    if (this.expirationTimer) clearInterval(this.expirationTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.notificationRetryTimer) clearInterval(this.notificationRetryTimer);
    if (this.meetingReminderTimer) clearInterval(this.meetingReminderTimer);
    if (this.approvalReminderTimer) clearInterval(this.approvalReminderTimer);
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

  async sendApprovalReminders(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - APPROVAL_REMINDER_AFTER_MS);
    const waiting = await this.prisma.booking.findMany({
      where: {
        status: {
          in: [
            BookingStatus.PENDING_APPROVAL,
            BookingStatus.CONFIRMATION_ERROR,
          ],
        },
        createdAt: { lte: cutoff },
        expiresAt: { gt: now },
      },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const unsent: Array<{
      booking: (typeof waiting)[number];
      waitingMinutes: number;
    }> = [];
    for (const booking of waiting) {
      const exists = await this.prisma.businessEvent.findFirst({
        where: { bookingId: booking.id, eventType: APPROVAL_REMINDER_EVENT },
        select: { id: true },
      });
      if (exists) continue;
      const waitingMinutes = Math.max(
        15,
        Math.floor((now.getTime() - booking.createdAt.getTime()) / 60_000),
      );
      unsent.push({ booking, waitingMinutes });
    }
    if (!unsent.length) return 0;
    const lines = unsent.slice(0, 5).map(
      ({ booking, waitingMinutes }) =>
        `• «${booking.title}» — ${booking.user.telegramDisplayName}, ${waitingMinutes} мин.`,
    );
    if (unsent.length > 5) lines.push(`• Ещё ${unsent.length - 5}`);
    const delivered = await this.notifications.notifyAdmin(
      `⏳ ${unsent.length} заявок ждут решения.\n${lines.join('\n')}\nОткройте Mini App → Управление.`,
    );
    if (!delivered) return 0;
    for (const { booking, waitingMinutes } of unsent) {
      await this.prisma.businessEvent.create({
        data: {
          eventType: APPROVAL_REMINDER_EVENT,
          userId: booking.userId,
          bookingId: booking.id,
          payload: JSON.stringify({ waitingMinutes }),
        },
      });
    }
    this.logger.logEvent('SchedulerService', 'approval.reminders.sent', {
      reminder_count: unsent.length,
    });
    return unsent.length;
  }

  private logFailure(event: string, error: unknown): void {
    this.logger.errorEvent('SchedulerService', event, {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
