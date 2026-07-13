import { Injectable } from '@nestjs/common';

import { AvailabilityService } from '../availability/availability.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  BookingType,
  CalendarSyncStatus,
  MeetingFormat,
  SlotReservationStatus,
  UserStatus,
} from '../generated/prisma/client';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { JsonLoggerService } from '../logging/json-logger.service';

const BOOKING_TTL_MS = 48 * 60 * 60 * 1000;

export interface CreateBookingInput {
  userId: string;
  durationMinutes: number;
  startAt: Date;
  timezone: string;
  title: string;
  comment?: string;
  email?: string;
  type?: BookingType;
  originalBookingId?: string;
  meetingFormat?: MeetingFormat;
}

export type ConfirmationResult =
  | { status: 'CONFIRMED'; bookingId: string; userId: string; telegramId: bigint; meetUrl: string | null }
  | { status: 'SLOT_UNAVAILABLE' | 'CONFIRMATION_ERROR'; bookingId: string; userId: string; telegramId: bigint };

export interface ExpiredBooking {
  bookingId: string;
  userId: string;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly googleCalendar: GoogleCalendarService,
    private readonly logger: JsonLoggerService,
  ) {}

  async create(input: CreateBookingInput) {
    if (input.type === BookingType.RESCHEDULE) {
      if (!input.originalBookingId) {
        throw new Error('Original booking is required for reschedule');
      }
      const original = await this.prisma.booking.findFirst({
        where: {
          id: input.originalBookingId,
          userId: input.userId,
          status: BookingStatus.CONFIRMED,
        },
        select: { id: true },
      });
      if (!original) throw new Error('Confirmed original booking not found');
    }
    const endAt = new Date(
      input.startAt.getTime() + input.durationMinutes * 60_000,
    );
    const expiresAt = new Date(Date.now() + BOOKING_TTL_MS);
    const booking = await this.prisma.booking.create({
      data: {
        userId: input.userId,
        type: input.type ?? BookingType.NEW,
        meetingFormat: input.meetingFormat ?? MeetingFormat.ONLINE,
        durationMinutes: input.durationMinutes,
        startAt: input.startAt,
        timezone: input.timezone,
        title: input.title,
        comment: input.comment,
        emailSnapshot: input.email,
        status: BookingStatus.PENDING_APPROVAL,
        expiresAt,
        originalBookingId: input.originalBookingId,
        slotReservation: {
          create: {
            startAt: input.startAt,
            endAt,
            expiresAt,
            status: SlotReservationStatus.ACTIVE,
          },
        },
      },
      include: { user: true },
    });
    this.log('booking.created', booking.id, { user_id: input.userId });
    return booking;
  }

  async confirm(bookingId: string): Promise<ConfirmationResult> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        user: true,
        slotReservation: true,
        calendarEvent: true,
        originalBooking: { include: { calendarEvent: true } },
      },
    });
    if (!booking) throw new Error('Booking not found');
    if (booking.status !== BookingStatus.PENDING_APPROVAL) {
      throw new Error(`Booking cannot be confirmed from ${booking.status}`);
    }
    const { date, time } = dateAndTimeInZone(booking.startAt, booking.timezone);
    const available = await this.availability.isSlotAvailable(
      date,
      time,
      booking.durationMinutes,
      new Date(),
      booking.id,
    );
    if (!available) {
      await this.finishWithReleasedReservation(
        booking.id,
        BookingStatus.SLOT_UNAVAILABLE,
      );
      this.log('booking.confirmation.slot_unavailable', booking.id);
      return {
        status: 'SLOT_UNAVAILABLE',
        bookingId: booking.id,
        userId: booking.userId,
        telegramId: booking.user.telegramId,
      };
    }

    const endAt = new Date(
      booking.startAt.getTime() + booking.durationMinutes * 60_000,
    );
    let createdGoogleEventId: string | null = null;
    try {
      if (
        booking.type === BookingType.RESCHEDULE &&
        (!booking.originalBooking ||
          booking.originalBooking.status !== BookingStatus.CONFIRMED ||
          !booking.originalBooking.calendarEvent?.googleEventId)
      ) {
        throw new Error('Original confirmed calendar event is missing');
      }
      const event = await this.googleCalendar.createEvent({
        title: booking.title,
        description: [
          booking.comment,
          `Telegram: ${booking.user.telegramDisplayName}`,
          booking.user.telegramUsername
            ? `Username: @${booking.user.telegramUsername}`
            : 'Username: отсутствует',
        ]
          .filter(Boolean)
          .join('\n'),
        startAt: booking.startAt,
        endAt,
        timezone: booking.timezone,
        attendeeEmail: booking.emailSnapshot,
        createConference: booking.meetingFormat === MeetingFormat.ONLINE,
      });
      createdGoogleEventId = event.googleEventId;
      if (booking.type === BookingType.RESCHEDULE && booking.originalBooking) {
        await this.googleCalendar.cancelEvent(
          booking.originalBooking.calendarEvent!.googleEventId,
        );
      }
      await this.prisma.$transaction(async (transaction) => {
        await transaction.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.CONFIRMED },
        });
        await transaction.calendarEvent.create({
          data: {
            bookingId: booking.id,
            googleEventId: event.googleEventId,
            googleMeetUrl: event.googleMeetUrl,
            guestEmail: booking.emailSnapshot,
            syncStatus: CalendarSyncStatus.SYNCED,
          },
        });
        if (booking.type === BookingType.RESCHEDULE && booking.originalBooking) {
          await transaction.booking.update({
            where: { id: booking.originalBooking.id },
            data: { status: BookingStatus.CANCELLED_BY_USER },
          });
          await transaction.slotReservation.updateMany({
            where: { bookingId: booking.originalBooking.id },
            data: { status: SlotReservationStatus.RELEASED },
          });
          await transaction.calendarEvent.update({
            where: { bookingId: booking.originalBooking.id },
            data: {
              syncStatus: CalendarSyncStatus.CANCELLED,
              cancelledAt: new Date(),
            },
          });
        }
      });
      this.log('booking.confirmed', booking.id, {
        google_event_id: event.googleEventId,
      });
      return {
        status: 'CONFIRMED',
        bookingId: booking.id,
        userId: booking.userId,
        telegramId: booking.user.telegramId,
        meetUrl: event.googleMeetUrl,
      };
    } catch (error: unknown) {
      if (createdGoogleEventId) {
        await this.googleCalendar.cancelEvent(createdGoogleEventId).catch(
          (rollbackError: unknown) => {
            this.log('booking.confirmation.rollback_failed', booking.id, {
              error_message:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            });
          },
        );
      }
      await this.finishWithReleasedReservation(
        booking.id,
        BookingStatus.CONFIRMATION_ERROR,
      );
      this.log('booking.confirmation.failed', booking.id, {
        error_message: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'CONFIRMATION_ERROR',
        bookingId: booking.id,
        userId: booking.userId,
        telegramId: booking.user.telegramId,
      };
    }
  }

  async reject(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { user: true },
    });
    if (!booking) throw new Error('Booking not found');
    await this.finishWithReleasedReservation(
      booking.id,
      BookingStatus.REJECTED,
    );
    this.log('booking.rejected', booking.id);
    return booking;
  }

  async cancelByUser(bookingId: string, userId: string): Promise<void> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      include: { calendarEvent: true },
    });
    if (!booking) throw new Error('Booking not found');
    if (
      booking.status !== BookingStatus.PENDING_APPROVAL &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new Error(`Booking cannot be cancelled from ${booking.status}`);
    }
    if (
      booking.status === BookingStatus.CONFIRMED &&
      booking.calendarEvent?.googleEventId
    ) {
      await this.googleCalendar.cancelEvent(
        booking.calendarEvent.googleEventId,
      );
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CANCELLED_BY_USER },
      });
      await transaction.slotReservation.updateMany({
        where: { bookingId: booking.id },
        data: { status: SlotReservationStatus.RELEASED },
      });
      if (booking.calendarEvent) {
        await transaction.calendarEvent.update({
          where: { bookingId: booking.id },
          data: {
            syncStatus: CalendarSyncStatus.CANCELLED,
            cancelledAt: new Date(),
          },
        });
      }
    });
    this.log('booking.cancelled_by_user', booking.id);
  }

  async expirePending(now = new Date()): Promise<ExpiredBooking[]> {
    const expired = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING_APPROVAL,
        expiresAt: { lte: now },
      },
      select: { id: true, userId: true },
    });
    if (!expired.length) return [];
    const ids = expired.map(({ id }) => id);
    await this.prisma.$transaction([
      this.prisma.booking.updateMany({
        where: { id: { in: ids } },
        data: { status: BookingStatus.EXPIRED },
      }),
      this.prisma.slotReservation.updateMany({
        where: { bookingId: { in: ids } },
        data: { status: SlotReservationStatus.EXPIRED },
      }),
    ]);
    this.log('booking.expiration.completed', undefined, {
      expired_count: ids.length,
    });
    return expired.map(({ id, userId }) => ({ bookingId: id, userId }));
  }

  async cleanupOldData(now = new Date()): Promise<{
    systemLogs: number;
    businessEvents: number;
    bookings: number;
    notifications: number;
  }> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [systemLogs, businessEvents, notifications, bookings] = await this.prisma.$transaction([
      this.prisma.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.businessEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.notificationDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.booking.deleteMany({
        where: {
          updatedAt: { lt: cutoff },
          status: {
            in: [
              BookingStatus.REJECTED,
              BookingStatus.EXPIRED,
              BookingStatus.CANCELLED_BY_USER,
              BookingStatus.SLOT_UNAVAILABLE,
              BookingStatus.CONFIRMATION_ERROR,
            ],
          },
        },
      }),
    ]);
    const result = {
      systemLogs: systemLogs.count,
      businessEvents: businessEvents.count,
      bookings: bookings.count,
      notifications: notifications.count,
    };
    this.log('data.cleanup.completed', undefined, result);
    return result;
  }

  async setUserBlocked(
    userId: string,
    blocked: boolean,
    adminTelegramId: bigint,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: userId },
        data: { status: blocked ? UserStatus.BANNED : UserStatus.ACTIVE },
      });
      await transaction.blacklistEntry.upsert({
        where: { userId },
        update: {
          active: blocked,
          removedAt: blocked ? null : new Date(),
          createdByTelegramId: adminTelegramId,
        },
        create: {
          userId,
          active: blocked,
          removedAt: blocked ? null : new Date(),
          createdByTelegramId: adminTelegramId,
        },
      });
      if (blocked) {
        const pending = await transaction.booking.findMany({
          where: { userId, status: BookingStatus.PENDING_APPROVAL },
          select: { id: true },
        });
        if (pending.length) {
          const ids = pending.map(({ id }) => id);
          await transaction.booking.updateMany({
            where: { id: { in: ids } },
            data: { status: BookingStatus.REJECTED },
          });
          await transaction.slotReservation.updateMany({
            where: { bookingId: { in: ids } },
            data: { status: SlotReservationStatus.RELEASED },
          });
        }
      }
    });
    this.log(blocked ? 'user.blocked' : 'user.unblocked', undefined, {
      user_id: userId,
    });
  }

  private async finishWithReleasedReservation(
    bookingId: string,
    status: BookingStatus,
  ): Promise<void> {
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status,
        slotReservation: {
          update: { status: SlotReservationStatus.RELEASED },
        },
      },
    });
  }

  private log(
    event: string,
    bookingId?: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger.logEvent('BookingService', event, {
      booking_id: bookingId,
      ...fields,
    });
  }
}

function dateAndTimeInZone(
  value: Date,
  timeZone: string,
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}
