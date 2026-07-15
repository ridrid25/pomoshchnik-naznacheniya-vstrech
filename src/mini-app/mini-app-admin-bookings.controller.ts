import {
  BadRequestException,
  Body,
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
  BookingDecisionService,
  type BookingDecisionAction,
  type BookingDecisionResult,
} from '../bookings/booking-decision.service';
import { PrismaService } from '../database/prisma.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import {
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

interface DecisionBody {
  reason?: unknown;
}

@Controller('api/mini-app/v1/admin/bookings')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminBookingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decisions: BookingDecisionService,
    private readonly googleCalendar: GoogleCalendarService,
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
    const [bookings, pending, decidedToday] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where:
          scope === 'pending'
            ? { status: { in: pendingStatuses } }
            : { status: { notIn: pendingStatuses } },
        include: { user: true, calendarEvent: true },
        orderBy: scope === 'pending' ? { createdAt: 'asc' } : { updatedAt: 'desc' },
        take: 100,
      }),
      this.prisma.booking.count({
        where: { status: { in: pendingStatuses } },
      }),
      this.prisma.booking.count({
        where: {
          status: { notIn: pendingStatuses },
          updatedAt: { gte: startOfToday },
        },
      }),
    ]);
    return {
      bookings: bookings.map((booking) => toAdminBookingContract(booking)),
      summary: { pending, decidedToday },
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
    return { booking: toAdminBookingContract(booking, googleCalendarDayUrl) };
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
    await this.findBooking(id);
    const adminTelegramId = requireAdminTelegramId(request);
    const decision = await this.decisions.decide(id, action, {
      reason: action === 'confirm' ? undefined : reason,
      adminTelegramId: action === 'block' ? adminTelegramId : undefined,
    });
    return {
      decision,
      booking: toAdminBookingContract(await this.findBooking(id)),
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
): MiniAppAdminBookingContract {
  if (!booking.publicCode) throw new Error('Booking public code is missing');
  const endAt = new Date(
    booking.startAt.getTime() + booking.durationMinutes * 60_000,
  );
  const pending = booking.status === BookingStatus.PENDING_APPROVAL;
  const technicalError = booking.status === BookingStatus.CONFIRMATION_ERROR;
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
    queueState: technicalError
      ? 'TECHNICAL_ERROR'
      : pending
        ? 'REQUIRES_DECISION'
        : 'PROCESSED',
    canConfirm: pending,
    canReject: pending || technicalError,
    canBlock:
      (pending || technicalError) && booking.user.status === UserStatus.ACTIVE,
  };
}
