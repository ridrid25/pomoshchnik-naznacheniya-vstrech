import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  MeetingFormat,
  MessageTemplateType,
} from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';
import { NotificationService } from '../notifications/notification.service';
import { BookingService } from './booking.service';

export type BookingDecisionAction = 'confirm' | 'reject';
export type BookingDecisionOutcome =
  | 'CONFIRMED'
  | 'REJECTED'
  | 'SLOT_UNAVAILABLE'
  | 'CONFIRMATION_ERROR'
  | 'ALREADY_PROCESSED';

export interface BookingDecisionResult {
  bookingId: string;
  outcome: BookingDecisionOutcome;
  bookingStatus: BookingStatus;
}

@Injectable()
export class BookingDecisionService {
  private readonly active = new Map<string, Promise<BookingDecisionResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingService,
    private readonly notifications: NotificationService,
    private readonly logger: JsonLoggerService,
  ) {}

  decide(
    bookingId: string,
    action: BookingDecisionAction,
  ): Promise<BookingDecisionResult> {
    const current = this.active.get(bookingId);
    if (current) return current;
    const decision = this.performDecision(bookingId, action).finally(() => {
      this.active.delete(bookingId);
    });
    this.active.set(bookingId, decision);
    return decision;
  }

  private async performDecision(
    bookingId: string,
    action: BookingDecisionAction,
  ): Promise<BookingDecisionResult> {
    const before = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!before) throw new Error('Booking not found');
    const canRejectAfterTechnicalFailure =
      action === 'reject' && before.status === BookingStatus.CONFIRMATION_ERROR;
    if (
      before.status !== BookingStatus.PENDING_APPROVAL &&
      !canRejectAfterTechnicalFailure
    ) {
      return {
        bookingId,
        outcome: 'ALREADY_PROCESSED',
        bookingStatus: before.status,
      };
    }

    if (action === 'reject') {
      const booking = await this.bookings.reject(bookingId);
      await this.notifications.notifyUser({
        userId: booking.userId,
        bookingId,
        eventType: 'BOOKING_REJECTED',
        templateType: MessageTemplateType.BOOKING_REJECTED,
        subject: 'Заявка на встречу отклонена',
        fallbackText: 'Заявка отклонена. {reason_optional}',
        variables: { reason_optional: booking.rejectionReason ?? '' },
      });
      this.logDecision(bookingId, action, BookingStatus.REJECTED);
      return {
        bookingId,
        outcome: 'REJECTED',
        bookingStatus: BookingStatus.REJECTED,
      };
    }

    const result = await this.bookings.confirm(bookingId);
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    if (result.status === 'CONFIRMED') {
      await this.notifications.notifyUser({
        userId: result.userId,
        bookingId,
        eventType: 'BOOKING_CONFIRMED',
        templateType: MessageTemplateType.BOOKING_CONFIRMED,
        subject: 'Встреча подтверждена',
        fallbackText:
          'Встреча подтверждена. Дата: {date}. Время: {time} ({tz_label}). Длительность: {duration} мин. Формат: {meeting_format}. {meeting_note}',
        variables: bookingTemplateVariables(booking),
      });
    } else if (result.status === 'SLOT_UNAVAILABLE') {
      await this.notifications.notifyUser({
        userId: result.userId,
        bookingId,
        eventType: 'SLOT_UNAVAILABLE',
        templateType: MessageTemplateType.SLOT_UNAVAILABLE,
        subject: 'Время встречи стало недоступно',
        fallbackText:
          'Выбранное время стало недоступно. Создайте новую заявку.',
      });
    } else {
      await this.notifications.notifyUser({
        userId: result.userId,
        bookingId,
        eventType: 'CONFIRMATION_ERROR',
        templateType: MessageTemplateType.CONFIRMATION_ERROR,
        subject: 'Не удалось подтвердить встречу',
        fallbackText:
          'Не удалось подтвердить встречу из-за технической ошибки. Администратор уже получил уведомление.',
      });
    }
    this.logDecision(bookingId, action, booking.status);
    return {
      bookingId,
      outcome: result.status,
      bookingStatus: booking.status,
    };
  }

  private logDecision(
    bookingId: string,
    action: BookingDecisionAction,
    status: BookingStatus,
  ): void {
    this.logger.logEvent('BookingDecisionService', 'admin.booking.decided', {
      booking_id: bookingId,
      action,
      booking_status: status,
    });
  }
}

function bookingTemplateVariables(booking: {
  startAt: Date;
  durationMinutes: number;
  timezone: string;
  meetingFormat: MeetingFormat;
}): Record<string, string | number> {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: booking.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(booking.startAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  const online = booking.meetingFormat === MeetingFormat.ONLINE;
  return {
    date: `${part('day')}.${part('month')}.${part('year')}`,
    time: `${part('hour')}:${part('minute')}`,
    tz_label: booking.timezone,
    duration: booking.durationMinutes,
    meeting_format: online
      ? '🌐 Онлайн · Google Meet'
      : '🤝 Лично · без видеоссылки',
    meeting_note: online
      ? 'Ссылка Google Meet придёт в напоминании за час.'
      : 'Google Meet не создаётся.',
  };
}
