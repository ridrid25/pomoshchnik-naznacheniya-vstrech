import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import {
  BookingService,
  BookingSlotUnavailableError,
} from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingSource,
  BookingStatus,
  BookingType,
  MessageTemplateType,
  type Prisma,
} from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { AvailabilityService } from '../availability/availability.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppUserBookingContract } from './mini-app.contracts';

type BookingWithCalendar = Prisma.BookingGetPayload<{
  include: { calendarEvent: true };
}>;

interface RescheduleBody {
  startAt?: unknown;
  email?: unknown;
  idempotencyKey?: unknown;
}

@Controller('api/mini-app/v1/bookings')
@UseGuards(MiniAppAuthGuard)
export class MiniAppUserBookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingService,
    private readonly availability: AvailabilityService,
    private readonly notifications: NotificationService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @Get()
  async list(
    @Req() request: MiniAppRequest,
    @Query('scope') scopeRaw?: string,
  ): Promise<{ bookings: MiniAppUserBookingContract[] }> {
    const userId = requireUserId(request);
    const scope = parseScope(scopeRaw);
    const bookings = await this.prisma.booking.findMany({
      where: { userId },
      include: { calendarEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const now = new Date();
    return {
      bookings: bookings
        .filter((booking) => isActive(booking, now) === (scope === 'active'))
        .map((booking) => toUserBookingContract(booking, now)),
    };
  }

  @Get(':id')
  async getOne(
    @Req() request: MiniAppRequest,
    @Param('id') id: string,
  ): Promise<{ booking: MiniAppUserBookingContract }> {
    const booking = await this.findOwned(id, requireUserId(request));
    const googleCalendarDayUrl = request.miniAppAuth?.role === 'ADMIN'
      ? await this.googleCalendar.getCalendarDayUrl(
          booking.startAt,
          booking.timezone,
        )
      : null;
    return {
      booking: toUserBookingContract(
        booking,
        new Date(),
        googleCalendarDayUrl,
      ),
    };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MiniAppOriginGuard)
  async cancel(
    @Req() request: MiniAppRequest,
    @Param('id') id: string,
  ): Promise<{ booking: MiniAppUserBookingContract; changed: boolean }> {
    const userId = requireUserId(request);
    const current = await this.findOwned(id, userId);
    if (
      current.status !== BookingStatus.PENDING_APPROVAL &&
      current.status !== BookingStatus.CONFIRMED &&
      current.status !== BookingStatus.CANCELLED_BY_USER
    ) {
      throw new ConflictException(
        `Booking cannot be cancelled from ${current.status}`,
      );
    }
    const changed = await this.bookings.cancelByUser(id, userId);
    if (changed) {
      await this.notifications.notifyUser({
        userId,
        bookingId: id,
        eventType: 'BOOKING_CANCELLED',
        templateType: MessageTemplateType.BOOKING_CANCELLED,
        subject: 'Встреча отменена',
        fallbackText:
          'Встреча отменена. Если событие уже было создано, оно отменено и в Google Calendar.',
      });
      await this.notifications.notifyAdmin(
        `Пользователь отменил заявку ${current.publicCode ?? current.id}.`,
      );
    }
    return {
      booking: toUserBookingContract(await this.findOwned(id, userId), new Date()),
      changed,
    };
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MiniAppOriginGuard)
  async reschedule(
    @Req() request: MiniAppRequest,
    @Param('id') id: string,
    @Body() body: RescheduleBody,
  ): Promise<{ booking: MiniAppUserBookingContract }> {
    const userId = requireUserId(request);
    const original = await this.findOwned(id, userId);
    if (original.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException('Only a confirmed booking can be rescheduled');
    }
    const input = parseRescheduleBody(body);
    const existing = await this.prisma.booking.findFirst({
      where: { userId, idempotencyKey: input.idempotencyKey },
      include: { calendarEvent: true },
    });
    if (existing) {
      if (
        existing.type !== BookingType.RESCHEDULE ||
        existing.originalBookingId !== original.id
      ) {
        throw new ConflictException('Idempotency key is already in use');
      }
      return { booking: toUserBookingContract(existing, new Date()) };
    }
    const timezone = await this.availability.getTimezone();
    try {
      const created = await this.bookings.create({
        userId,
        source: BookingSource.MINI_APP,
        type: BookingType.RESCHEDULE,
        originalBookingId: original.id,
        meetingFormat: original.meetingFormat,
        durationMinutes: original.durationMinutes,
        startAt: input.startAt,
        timezone,
        title: original.title,
        comment: original.comment ?? undefined,
        email: input.email ?? original.emailSnapshot ?? undefined,
        idempotencyKey: input.idempotencyKey,
        verifyAvailability: true,
      });
      await this.notifications.notifyUser({
        userId,
        bookingId: created.id,
        eventType: 'RESCHEDULE_SUBMITTED',
        templateType: MessageTemplateType.RESCHEDULE_SUBMITTED,
        subject: 'Запрос на перенос отправлен',
        fallbackText:
          'Запрос на перенос отправлен на согласование. Текущая встреча пока остается без изменений.',
      });
      await this.notifications.notifyAdmin(
        `Новый запрос на перенос ${created.publicCode ?? created.id} для заявки ${original.publicCode ?? original.id}.`,
      );
      return {
        booking: toUserBookingContract(
          await this.findOwned(created.id, userId),
          new Date(),
        ),
      };
    } catch (error: unknown) {
      if (error instanceof BookingSlotUnavailableError) {
        throw new ConflictException('Selected slot is no longer available');
      }
      throw error;
    }
  }

  private async findOwned(id: string, userId: string): Promise<BookingWithCalendar> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, userId },
      include: { calendarEvent: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }
}

function parseRescheduleBody(body: RescheduleBody): {
  startAt: Date;
  email: string | null;
  idempotencyKey: string;
} {
  if (typeof body?.startAt !== 'string') {
    throw new BadRequestException('startAt must be an ISO date-time string');
  }
  const startAt = new Date(body.startAt);
  if (Number.isNaN(startAt.getTime()) || startAt.toISOString() !== body.startAt) {
    throw new BadRequestException('startAt must be a normalized ISO date-time string');
  }
  if (
    typeof body?.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,128}$/u.test(body.idempotencyKey)
  ) {
    throw new BadRequestException('idempotencyKey has invalid format');
  }
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string') {
      throw new BadRequestException('email must be a string');
    }
    email = body.email.trim().toLowerCase();
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    ) {
      throw new BadRequestException('email has invalid format');
    }
  }
  return { startAt, email, idempotencyKey: body.idempotencyKey };
}

function requireUserId(request: MiniAppRequest): string {
  if (!request.miniAppAuth) {
    throw new Error('Mini App auth guard did not attach auth context');
  }
  return request.miniAppAuth.user.id;
}

function parseScope(value: string | undefined): 'active' | 'archive' {
  if (value === undefined || value === 'active') return 'active';
  if (value === 'archive') return 'archive';
  throw new BadRequestException('scope must be active or archive');
}

function isActive(booking: BookingWithCalendar, now: Date): boolean {
  if (
    booking.status === BookingStatus.PENDING_APPROVAL ||
    booking.status === BookingStatus.CONFIRMATION_ERROR
  ) {
    return true;
  }
  if (booking.status !== BookingStatus.CONFIRMED) return false;
  return booking.startAt.getTime() + booking.durationMinutes * 60_000 > now.getTime();
}

function toUserBookingContract(
  booking: BookingWithCalendar,
  now: Date,
  googleCalendarDayUrl: string | null = null,
): MiniAppUserBookingContract {
  if (!booking.publicCode) throw new Error('Booking public code is missing');
  const endAt = new Date(
    booking.startAt.getTime() + booking.durationMinutes * 60_000,
  );
  const inFuture = endAt > now;
  return {
    id: booking.id,
    publicCode: booking.publicCode,
    type: booking.type,
    source: booking.source,
    meetingFormat: booking.meetingFormat,
    durationMinutes: booking.durationMinutes,
    startAt: booking.startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone: booking.timezone,
    title: booking.title,
    comment: booking.comment,
    email: booking.emailSnapshot,
    status: booking.status,
    rejectionReason: booking.rejectionReason,
    originalBookingId: booking.originalBookingId,
    googleMeetUrl: booking.calendarEvent?.googleMeetUrl ?? null,
    googleCalendarDayUrl,
    calendarSyncStatus: booking.calendarEvent?.syncStatus ?? null,
    canCancel:
      booking.status === BookingStatus.PENDING_APPROVAL ||
      (booking.status === BookingStatus.CONFIRMED && inFuture),
    canReschedule: booking.status === BookingStatus.CONFIRMED && inFuture,
    canRetry: booking.status === BookingStatus.SLOT_UNAVAILABLE,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}
