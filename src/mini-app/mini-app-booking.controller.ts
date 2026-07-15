import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Body,
  UseGuards,
} from '@nestjs/common';

import {
  BookingService,
  BookingSlotUnavailableError,
} from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import {
  BookingSource,
  MeetingFormat,
} from '../generated/prisma/client';
import { AvailabilityService } from '../availability/availability.service';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppBookingContract } from './mini-app.contracts';

interface CreateMiniAppBookingBody {
  title?: unknown;
  comment?: unknown;
  meetingFormat?: unknown;
  durationMinutes?: unknown;
  startAt?: unknown;
  email?: unknown;
  idempotencyKey?: unknown;
}

@Controller('api/mini-app/v1/bookings')
@UseGuards(MiniAppOriginGuard, MiniAppAuthGuard)
export class MiniAppBookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Req() request: MiniAppRequest,
    @Body() body: CreateMiniAppBookingBody,
  ): Promise<{ booking: MiniAppBookingContract }> {
    if (!request.miniAppAuth) {
      throw new Error('Mini App auth guard did not attach auth context');
    }
    const input = parseCreateBody(body);
    const timezone = await this.availability.getTimezone();
    try {
      const booking = await this.bookings.create({
        userId: request.miniAppAuth.user.id,
        source: BookingSource.MINI_APP,
        meetingFormat: input.meetingFormat,
        durationMinutes: input.durationMinutes,
        startAt: input.startAt,
        timezone,
        title: input.title,
        comment: input.comment ?? undefined,
        email: input.email ?? undefined,
        idempotencyKey: input.idempotencyKey,
        verifyAvailability: true,
      });
      if (input.email) {
        await this.prisma.user.update({
          where: { id: request.miniAppAuth.user.id },
          data: { lastConfirmedEmail: input.email },
        });
      }
      return { booking: toContract(booking) };
    } catch (error: unknown) {
      if (error instanceof BookingSlotUnavailableError) {
        throw new ConflictException('Selected slot is no longer available');
      }
      throw error;
    }
  }
}

function parseCreateBody(body: CreateMiniAppBookingBody) {
  const title = requiredString(body?.title, 'title', 100);
  const comment = optionalString(body?.comment, 'comment', 500);
  const email = optionalEmail(body?.email);
  const idempotencyKey = requiredString(
    body?.idempotencyKey,
    'idempotencyKey',
    128,
  );
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) {
    throw new BadRequestException('idempotencyKey has invalid format');
  }
  const durationMinutes = Number(body?.durationMinutes);
  if (![30, 45, 60].includes(durationMinutes)) {
    throw new BadRequestException('durationMinutes must be one of: 30, 45, 60');
  }
  const meetingFormat = parseMeetingFormat(body?.meetingFormat);
  if (typeof body?.startAt !== 'string') {
    throw new BadRequestException('startAt must be an ISO date-time string');
  }
  const startAt = new Date(body.startAt);
  if (Number.isNaN(startAt.getTime()) || startAt.toISOString() !== body.startAt) {
    throw new BadRequestException('startAt must be a normalized ISO date-time string');
  }
  return {
    title,
    comment,
    email,
    idempotencyKey,
    durationMinutes,
    meetingFormat,
    startAt,
  };
}

function requiredString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new BadRequestException(
      `${name} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized || null;
}

function optionalEmail(value: unknown): string | null {
  const email = optionalString(value, 'email', 254)?.toLowerCase() ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new BadRequestException('email has invalid format');
  }
  return email;
}

function parseMeetingFormat(value: unknown): MeetingFormat {
  if (value === MeetingFormat.ONLINE) return MeetingFormat.ONLINE;
  if (value === MeetingFormat.IN_PERSON) return MeetingFormat.IN_PERSON;
  throw new BadRequestException('meetingFormat must be ONLINE or IN_PERSON');
}

function toContract(booking: {
  id: string;
  publicCode: string | null;
  source: BookingSource;
  meetingFormat: MeetingFormat;
  durationMinutes: number;
  startAt: Date;
  timezone: string;
  title: string;
  comment: string | null;
  emailSnapshot: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}): MiniAppBookingContract {
  if (
    !booking.publicCode ||
    booking.source !== BookingSource.MINI_APP ||
    booking.status !== 'PENDING_APPROVAL'
  ) {
    throw new Error('Mini App booking invariant failed');
  }
  return {
    id: booking.id,
    publicCode: booking.publicCode,
    source: 'MINI_APP',
    meetingFormat: booking.meetingFormat,
    durationMinutes: booking.durationMinutes,
    startAt: booking.startAt.toISOString(),
    timezone: booking.timezone,
    title: booking.title,
    comment: booking.comment,
    email: booking.emailSnapshot,
    status: 'PENDING_APPROVAL',
    expiresAt: booking.expiresAt.toISOString(),
    createdAt: booking.createdAt.toISOString(),
  };
}
