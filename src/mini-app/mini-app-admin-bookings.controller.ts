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

import { AvailabilityService } from '../availability/availability.service';
import {
  BookingDecisionService,
  type BookingDecisionAction,
  type BookingDecisionResult,
} from '../bookings/booking-decision.service';
import { BookingService } from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import {
  BookingSource,
  BookingStatus,
  UserStatus,
  type Prisma,
} from '../generated/prisma/client';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type {
  MiniAppAdminBookingContract,
  MiniAppAdminQueueSummaryContract,
} from './mini-app.contracts';

type AdminBooking = Prisma.BookingGetPayload<{
  include: { user: true; calendarEvent: true };
}>;

const AGING_AFTER_MS = 15 * 60_000;
const MAX_BOOKING_DURATION_MS = 60 * 60_000;
const M9_OBSERVATION_STARTED_AT = new Date('2026-07-17T14:01:24.000Z');
const M9_MINIMUM_SAMPLE_SIZE = 5;
const M8_BASELINE_SAMPLE_SIZE = 9;
const M8_BASELINE_SLOT_UNAVAILABLE = 2;

interface DecisionBody {
  reason?: unknown;
}

@Controller('api/mini-app/v1/admin/bookings')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminBookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decisions: BookingDecisionService,
    private readonly bookings: BookingService,
    private readonly googleCalendar: GoogleCalendarService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get()
  async list(
    @Query('scope') scopeRaw?: string,
  ): Promise<{
    bookings: MiniAppAdminBookingContract[];
    summary: MiniAppAdminQueueSummaryContract;
  }> {
    const scope = parseScope(scopeRaw);
    const pendingStatuses = [
      BookingStatus.PENDING_APPROVAL,
      BookingStatus.CONFIRMATION_ERROR,
    ];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const now = new Date();
    const agingCutoff = new Date(now.getTime() - AGING_AFTER_MS);
    const activeStartCutoff = new Date(now.getTime() - MAX_BOOKING_DURATION_MS);
    const [
      bookingCandidates,
      pendingCandidates,
      decidedToday,
      m9SampleSize,
      m9SlotUnavailable,
    ] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where:
          scope === 'pending'
            ? {
                status: { in: pendingStatuses },
                startAt: { gt: activeStartCutoff },
              }
            : undefined,
        include: { user: true, calendarEvent: true },
        orderBy: scope === 'pending' ? { createdAt: 'asc' } : { updatedAt: 'desc' },
        take: scope === 'pending' ? 100 : 200,
      }),
      this.prisma.booking.findMany({
        where: {
          status: { in: pendingStatuses },
          startAt: { gt: activeStartCutoff },
        },
        select: { startAt: true, durationMinutes: true, createdAt: true },
      }),
      this.prisma.booking.count({
        where: {
          status: { notIn: pendingStatuses },
          updatedAt: { gte: startOfToday },
        },
      }),
      this.prisma.booking.count({
        where: {
          source: BookingSource.MINI_APP,
          createdAt: { gte: M9_OBSERVATION_STARTED_AT },
        },
      }),
      this.prisma.booking.count({
        where: {
          source: BookingSource.MINI_APP,
          createdAt: { gte: M9_OBSERVATION_STARTED_AT },
          status: BookingStatus.SLOT_UNAVAILABLE,
        },
      }),
    ]);
    const actionablePending = pendingCandidates.filter((booking) =>
      isBookingFuture(booking, now),
    );
    const oldestPending = actionablePending.reduce<Date | null>(
      (oldest, booking) =>
        !oldest || booking.createdAt < oldest ? booking.createdAt : oldest,
      null,
    );
    const scopedBookings = bookingCandidates
      .filter((booking) =>
        scope === 'pending'
          ? isBookingActionable(booking, now)
          : !isBookingActionable(booking, now),
      )
      .slice(0, 100);
    const m9RatePercent = m9SampleSize
      ? Math.round((m9SlotUnavailable / m9SampleSize) * 1_000) / 10
      : null;
    const comparison = compareReliability(m9SampleSize, m9SlotUnavailable);
    const bookingContracts = await Promise.all(
      scopedBookings.map(async (booking) => {
        const googleCalendarDayUrl = await this.googleCalendar.getCalendarDayUrl(
          booking.startAt,
          booking.timezone,
        );
        return this.toContract(booking, googleCalendarDayUrl, now);
      }),
    );
    return {
      bookings: bookingContracts,
      summary: {
        pending: actionablePending.length,
        decidedToday,
        aging: actionablePending.filter(
          (booking) => booking.createdAt <= agingCutoff,
        ).length,
        oldestWaitingMinutes: oldestPending
          ? Math.max(0, Math.floor((now.getTime() - oldestPending.getTime()) / 60_000))
          : null,
        reliability: {
          observationStartedAt: M9_OBSERVATION_STARTED_AT.toISOString(),
          sampleSize: m9SampleSize,
          minimumSampleSize: M9_MINIMUM_SAMPLE_SIZE,
          slotUnavailable: m9SlotUnavailable,
          ratePercent: m9RatePercent,
          baselineSampleSize: M8_BASELINE_SAMPLE_SIZE,
          baselineSlotUnavailable: M8_BASELINE_SLOT_UNAVAILABLE,
          baselineRatePercent: 22,
          comparison,
        },
      },
    };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
  ): Promise<{ booking: MiniAppAdminBookingContract }> {
    const booking = await this.findBooking(id);
    const googleCalendarDayUrl = await this.googleCalendar.getCalendarDayUrl(
      booking.startAt,
      booking.timezone,
    );
    return {
      booking: await this.toContract(booking, googleCalendarDayUrl),
    };
  }

  @Post(':id/calendar-return')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MiniAppOriginGuard)
  async prepareCalendarReturn(
    @Param('id') id: string,
  ): Promise<{ returnUrl: string }> {
    await this.findBooking(id);
    return { returnUrl: await this.bookings.ensureCalendarReturnLink(id) };
  }

  @Post(':id/:action')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MiniAppOriginGuard)
  async decide(
    @Req() request: MiniAppRequest,
    @Param('id') id: string,
    @Param('action') actionRaw: string,
    @Body() body: DecisionBody = {},
  ): Promise<{
    decision: BookingDecisionResult;
    booking: MiniAppAdminBookingContract;
  }> {
    const action = parseAction(actionRaw);
    const reason = parseReason(body?.reason);
    const booking = await this.findBooking(id);
    if (!isBookingFuture(booking, new Date())) {
      throw new ConflictException('Booking date has already passed');
    }
    const adminTelegramId = requireAdminTelegramId(request);
    const decision = await this.decisions.decide(id, action, {
      reason: action === 'confirm' ? undefined : reason,
      adminTelegramId: action === 'block' ? adminTelegramId : undefined,
    });
    return {
      decision,
      booking: await this.toContract(await this.findBooking(id)),
    };
  }

  private async findBooking(id: string): Promise<AdminBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { user: true, calendarEvent: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  private async toContract(
    booking: AdminBooking,
    googleCalendarDayUrl: string | null = null,
    now = new Date(),
  ): Promise<MiniAppAdminBookingContract> {
    const slotAvailable =
      booking.status === BookingStatus.PENDING_APPROVAL &&
      isBookingFuture(booking, now)
        ? await this.isBookingSlotAvailable(booking)
        : null;
    return toAdminBookingContract(
      booking,
      googleCalendarDayUrl,
      slotAvailable,
      now,
    );
  }

  private async isBookingSlotAvailable(
    booking: AdminBooking,
  ): Promise<boolean> {
    const { date, time } = dateAndTimeInZone(
      booking.startAt,
      booking.timezone,
    );
    return this.availability.isSlotAvailable(
      date,
      time,
      booking.durationMinutes,
      new Date(),
      booking.id,
    );
  }
}

function compareReliability(
  sampleSize: number,
  slotUnavailable: number,
): 'COLLECTING' | 'IMPROVED' | 'UNCHANGED' | 'WORSE' {
  if (sampleSize < M9_MINIMUM_SAMPLE_SIZE) return 'COLLECTING';
  const currentScaled = slotUnavailable * M8_BASELINE_SAMPLE_SIZE;
  const baselineScaled = M8_BASELINE_SLOT_UNAVAILABLE * sampleSize;
  if (currentScaled < baselineScaled) return 'IMPROVED';
  if (currentScaled > baselineScaled) return 'WORSE';
  return 'UNCHANGED';
}

function parseScope(value: string | undefined): 'pending' | 'recent' {
  if (value === undefined || value === 'pending') return 'pending';
  if (value === 'recent') return 'recent';
  throw new BadRequestException('scope must be pending or recent');
}

function parseAction(value: string): BookingDecisionAction {
  if (value === 'confirm' || value === 'reject' || value === 'block') {
    return value;
  }
  throw new BadRequestException('action must be confirm, reject or block');
}

function parseReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('reason must be a string');
  }
  const reason = value.trim();
  if (reason.length > 500) {
    throw new BadRequestException('reason must not exceed 500 characters');
  }
  return reason || null;
}

function requireAdminTelegramId(request: MiniAppRequest): bigint {
  if (!request.miniAppAuth || request.miniAppAuth.role !== 'ADMIN') {
    throw new Error('Mini App admin guard did not attach admin context');
  }
  return request.miniAppAuth.user.telegramId;
}

function toAdminBookingContract(
  booking: AdminBooking,
  googleCalendarDayUrl: string | null = null,
  slotAvailable: boolean | null = null,
  now = new Date(),
): MiniAppAdminBookingContract {
  if (!booking.publicCode) throw new Error('Booking public code is missing');
  const endAt = new Date(
    booking.startAt.getTime() + booking.durationMinutes * 60_000,
  );
  const pending = booking.status === BookingStatus.PENDING_APPROVAL;
  const technicalError = booking.status === BookingStatus.CONFIRMATION_ERROR;
  const requiresDecision =
    (pending || technicalError) && isBookingFuture(booking, now);
  const waitingMinutes = requiresDecision
    ? Math.max(0, Math.floor((now.getTime() - booking.createdAt.getTime()) / 60_000))
    : null;
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
    calendarSyncStatus: booking.calendarEvent?.syncStatus ?? null,
    googleCalendarDayUrl,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    user: {
      id: booking.user.id,
      telegramId: booking.user.telegramId.toString(),
      username: booking.user.telegramUsername,
      displayName: booking.user.telegramDisplayName,
      status: booking.user.status,
    },
    queueState: !requiresDecision
      ? 'PROCESSED'
      : technicalError
        ? 'TECHNICAL_ERROR'
        : 'REQUIRES_DECISION',
    waitingMinutes,
    isAging: waitingMinutes !== null && waitingMinutes >= 15,
    slotAvailable,
    canConfirm: requiresDecision && pending && slotAvailable !== false,
    canReject: requiresDecision,
    canBlock:
      requiresDecision && booking.user.status === UserStatus.ACTIVE,
  };
}

function isBookingFuture(
  booking: { startAt: Date; durationMinutes: number },
  now: Date,
): boolean {
  return (
    booking.startAt.getTime() + booking.durationMinutes * 60_000 > now.getTime()
  );
}

function isBookingActionable(
  booking: { status: BookingStatus; startAt: Date; durationMinutes: number },
  now: Date,
): boolean {
  return (
    (booking.status === BookingStatus.PENDING_APPROVAL ||
      booking.status === BookingStatus.CONFIRMATION_ERROR) &&
    isBookingFuture(booking, now)
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
