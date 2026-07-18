import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AvailabilityService } from '../availability/availability.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  BookingSource,
  BookingType,
  CalendarSyncStatus,
  MeetingFormat,
  Prisma,
  SlotReservationStatus,
  UserStatus,
  type User,
} from '../generated/prisma/client';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { JsonLoggerService } from '../logging/json-logger.service';
import { createCalendarReturnUrl } from '../mini-app/mini-app-links';

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
  source?: BookingSource;
  idempotencyKey?: string;
  originalBookingId?: string;
  meetingFormat?: MeetingFormat;
  verifyAvailability?: boolean;
}

export class BookingSlotUnavailableError extends Error {
  constructor() {
    super('Selected slot is no longer available');
    this.name = 'BookingSlotUnavailableError';
  }
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
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = await this.findIdempotentBooking(
        input.userId,
        idempotencyKey,
      );
      if (existing) return existing;
    }

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
    if (input.verifyAvailability) {
      const { date, time } = dateAndTimeInZone(input.startAt, input.timezone);
      const available = await this.availability.isSlotAvailable(
        date,
        time,
        input.durationMinutes,
      );
      if (!available) throw new BookingSlotUnavailableError();
    }
    const endAt = new Date(
      input.startAt.getTime() + input.durationMinutes * 60_000,
    );
    const expiresAt = new Date(Date.now() + BOOKING_TTL_MS);
    let booking;
    try {
      booking = await this.prisma.booking.create({
        data: {
          publicCode: createPublicBookingCode(),
          idempotencyKey,
          userId: input.userId,
          type: input.type ?? BookingType.NEW,
          source: input.source ?? BookingSource.TELEGRAM_BOT,
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
    } catch (error: unknown) {
      if (idempotencyKey && isUniqueConstraintError(error)) {
        const existing = await this.findIdempotentBooking(
          input.userId,
          idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }
    this.log('booking.created', booking.id, { user_id: input.userId });
    await this.createPendingCalendarMarker(booking);
    return this.prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { user: true, calendarEvent: true },
    });
  }

  private async findIdempotentBooking(
    userId: string,
    idempotencyKey: string,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { idempotencyKey },
      include: { user: true, calendarEvent: true },
    });
    if (!booking) return null;
    if (booking.userId !== userId) {
      throw new Error('Idempotency key belongs to another user');
    }
    return booking;
  }

  async syncPendingCalendarMarkers(): Promise<number> {
    if (!this.googleCalendar.isConfigured()) return 0;
    const pending = await this.prisma.booking.findMany({
      where: { status: BookingStatus.PENDING_APPROVAL },
      include: { user: true, calendarEvent: true },
    });
    let created = 0;
    let updated = 0;
    for (const booking of pending) {
      const result = await this.createPendingCalendarMarker(booking);
      if (result === 'created') created += 1;
      if (result === 'updated') updated += 1;
    }
    this.log('booking.pending_calendar.reconciled', undefined, {
      pending_count: pending.length,
      created_count: created,
      updated_count: updated,
    });
    return created;
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
    let finalizedGoogleEventId: string | null = null;
    try {
      if (
        booking.type === BookingType.RESCHEDULE &&
        (!booking.originalBooking ||
          booking.originalBooking.status !== BookingStatus.CONFIRMED ||
          !booking.originalBooking.calendarEvent?.googleEventId)
      ) {
        throw new Error('Original confirmed calendar event is missing');
      }
      const eventInput = {
        title: booking.title,
        description: this.calendarDescription(booking),
        startAt: booking.startAt,
        endAt,
        timezone: booking.timezone,
        attendeeEmail: booking.emailSnapshot,
        createConference: booking.meetingFormat === MeetingFormat.ONLINE,
      };
      const event = booking.calendarEvent
        ? await this.googleCalendar.confirmPendingEvent(
            booking.calendarEvent.googleEventId,
            eventInput,
          )
        : await this.googleCalendar.createEvent(eventInput);
      finalizedGoogleEventId = event.googleEventId;
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
        if (booking.calendarEvent) {
          await transaction.calendarEvent.update({
            where: { bookingId: booking.id },
            data: {
              googleMeetUrl: event.googleMeetUrl,
              guestEmail: booking.emailSnapshot,
              syncStatus: CalendarSyncStatus.SYNCED,
              cancelledAt: null,
            },
          });
        } else {
          await transaction.calendarEvent.create({
            data: {
              bookingId: booking.id,
              googleEventId: event.googleEventId,
              googleMeetUrl: event.googleMeetUrl,
              guestEmail: booking.emailSnapshot,
              syncStatus: CalendarSyncStatus.SYNCED,
            },
          });
        }
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
      if (finalizedGoogleEventId) {
        await this.googleCalendar.cancelEvent(finalizedGoogleEventId).catch(
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
        Boolean(finalizedGoogleEventId),
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

  async reject(bookingId: string, rejectionReason?: string | null) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { user: true, calendarEvent: true },
    });
    if (!booking) throw new Error('Booking not found');
    if (rejectionReason !== undefined) {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { rejectionReason },
      });
    }
    await this.finishWithReleasedReservation(
      booking.id,
      BookingStatus.REJECTED,
    );
    this.log('booking.rejected', booking.id);
    return this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { user: true, calendarEvent: true },
    });
  }

  async cancelByUser(bookingId: string, userId: string): Promise<boolean> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      include: { calendarEvent: true },
    });
    if (!booking) throw new Error('Booking not found');
    if (booking.status === BookingStatus.CANCELLED_BY_USER) return false;
    if (
      booking.status !== BookingStatus.PENDING_APPROVAL &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new Error(`Booking cannot be cancelled from ${booking.status}`);
    }
    if (booking.calendarEvent?.googleEventId) {
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
    return true;
  }

  async expirePending(now = new Date()): Promise<ExpiredBooking[]> {
    const expired = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING_APPROVAL,
        expiresAt: { lte: now },
      },
      select: {
        id: true,
        userId: true,
        calendarEvent: { select: { googleEventId: true } },
      },
    });
    if (!expired.length) return [];
    for (const booking of expired) {
      if (booking.calendarEvent?.googleEventId) {
        await this.cancelCalendarEventBestEffort(
          booking.id,
          booking.calendarEvent.googleEventId,
        );
      }
    }
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
      this.prisma.calendarEvent.updateMany({
        where: { bookingId: { in: ids } },
        data: {
          syncStatus: CalendarSyncStatus.CANCELLED,
          cancelledAt: now,
        },
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
    reason?: string | null,
  ): Promise<void> {
    const pending = blocked
      ? await this.prisma.booking.findMany({
          where: { userId, status: BookingStatus.PENDING_APPROVAL },
          select: {
            id: true,
            calendarEvent: { select: { googleEventId: true } },
          },
        })
      : [];
    for (const booking of pending) {
      if (booking.calendarEvent?.googleEventId) {
        await this.cancelCalendarEventBestEffort(
          booking.id,
          booking.calendarEvent.googleEventId,
        );
      }
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: userId },
        data: { status: blocked ? UserStatus.BANNED : UserStatus.ACTIVE },
      });
      await transaction.blacklistEntry.upsert({
        where: { userId },
        update: {
          active: blocked,
          reason: blocked && reason !== undefined ? reason : undefined,
          removedAt: blocked ? null : new Date(),
          createdByTelegramId: adminTelegramId,
        },
        create: {
          userId,
          active: blocked,
          reason: blocked ? reason : null,
          removedAt: blocked ? null : new Date(),
          createdByTelegramId: adminTelegramId,
        },
      });
      if (blocked) {
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
          await transaction.calendarEvent.updateMany({
            where: { bookingId: { in: ids } },
            data: {
              syncStatus: CalendarSyncStatus.CANCELLED,
              cancelledAt: new Date(),
            },
          });
        }
      }
    });
    this.log(blocked ? 'user.blocked' : 'user.unblocked', undefined, {
      user_id: userId,
    });
  }

  private async createPendingCalendarMarker(booking: {
    id: string;
    title: string;
    comment: string | null;
    startAt: Date;
    durationMinutes: number;
    timezone: string;
    expiresAt: Date;
    user: User;
  }): Promise<'created' | 'updated' | 'skipped'> {
    if (!this.googleCalendar.isConfigured()) return 'skipped';
    const existing = await this.prisma.calendarEvent.findUnique({
      where: { bookingId: booking.id },
      select: { id: true, googleEventId: true },
    });

    let googleEventId: string | null = null;
    try {
      const input = {
        bookingId: booking.id,
        title: booking.title,
        description: this.pendingCalendarDescription(booking),
        startAt: booking.startAt,
        endAt: new Date(
          booking.startAt.getTime() + booking.durationMinutes * 60_000,
        ),
        timezone: booking.timezone,
      };
      if (existing) {
        await this.googleCalendar.updatePendingEvent(
          existing.googleEventId,
          input,
        );
        this.log('booking.pending_calendar.updated', booking.id, {
          google_event_id: existing.googleEventId,
        });
        return 'updated';
      }
      const event = await this.googleCalendar.createPendingEvent(input);
      googleEventId = event.googleEventId;
      await this.prisma.calendarEvent.create({
        data: {
          bookingId: booking.id,
          googleEventId,
          googleMeetUrl: null,
          guestEmail: null,
          syncStatus: CalendarSyncStatus.PENDING,
        },
      });
      this.log('booking.pending_calendar.created', booking.id, {
        google_event_id: googleEventId,
      });
      return 'created';
    } catch (error: unknown) {
      if (googleEventId) {
        await this.cancelCalendarEventBestEffort(booking.id, googleEventId);
      }
      this.log('booking.pending_calendar.failed', booking.id, {
        error_message: error instanceof Error ? error.message : String(error),
      });
      return 'skipped';
    }
  }

  async ensureCalendarReturnLink(bookingId: string): Promise<string> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { user: true, calendarEvent: true },
    });
    if (!booking?.calendarEvent) {
      throw new Error('Google Calendar event is missing');
    }
    const returnUrl = createCalendarReturnUrl(booking.id);
    const pending =
      booking.status === BookingStatus.PENDING_APPROVAL ||
      booking.status === BookingStatus.CONFIRMATION_ERROR;
    const description = pending
      ? this.pendingCalendarDescription(booking)
      : this.calendarDescription(booking);
    await this.googleCalendar.updateEventDescription(
      booking.calendarEvent.googleEventId,
      description,
    );
    this.log('booking.calendar_return_link.updated', booking.id, {
      google_event_id: booking.calendarEvent.googleEventId,
    });
    return returnUrl;
  }

  private pendingCalendarDescription(
    booking: { id: string; comment: string | null; user: User },
  ): string {
    const miniAppUrl = createCalendarReturnUrl(booking.id);
    return [
      '⏳ Статус: заявка ожидает вашего решения.',
      'Эта бледная запись не помечает вас занятой в Google Calendar.',
      '',
      '🔐 Открыть заявку и принять решение в Telegram:',
      miniAppUrl,
      '',
      booking.comment,
      `Telegram: ${booking.user.telegramDisplayName}`,
      booking.user.telegramUsername
        ? `Username: @${booking.user.telegramUsername}`
        : 'Username: отсутствует',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private calendarDescription(booking: {
    id: string;
    comment: string | null;
    user: User;
  }): string {
    return [
      booking.comment,
      `Telegram: ${booking.user.telegramDisplayName}`,
      booking.user.telegramUsername
        ? `Username: @${booking.user.telegramUsername}`
        : 'Username: отсутствует',
      '',
      '← Открыть встречу в Telegram:',
      createCalendarReturnUrl(booking.id),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async cancelCalendarEventBestEffort(
    bookingId: string,
    googleEventId: string,
  ): Promise<void> {
    await this.googleCalendar.cancelEvent(googleEventId).catch((error: unknown) => {
      this.log('booking.pending_calendar.cancel_failed', bookingId, {
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async finishWithReleasedReservation(
    bookingId: string,
    status: BookingStatus,
    calendarAlreadyCancelled = false,
  ): Promise<void> {
    const calendarEvent = await this.prisma.calendarEvent.findUnique({
      where: { bookingId },
      select: { googleEventId: true },
    });
    if (calendarEvent && !calendarAlreadyCancelled) {
      await this.cancelCalendarEventBestEffort(
        bookingId,
        calendarEvent.googleEventId,
      );
    }
    await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: { status },
      }),
      this.prisma.slotReservation.updateMany({
        where: { bookingId },
        data: { status: SlotReservationStatus.RELEASED },
      }),
      this.prisma.calendarEvent.updateMany({
        where: { bookingId },
        data: {
          syncStatus: CalendarSyncStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      }),
    ]);
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

function createPublicBookingCode(): string {
  return `M-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function normalizeIdempotencyKey(value?: string): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(normalized)) {
    throw new Error('Invalid idempotency key');
  }
  return normalized;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
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
