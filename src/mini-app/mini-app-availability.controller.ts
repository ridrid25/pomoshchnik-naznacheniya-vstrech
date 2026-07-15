import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AvailabilityService } from '../availability/availability.service';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type {
  MiniAppSlotContract,
  MiniAppWeekContract,
} from './mini-app.contracts';

@Controller('api/mini-app/v1/availability')
@UseGuards(MiniAppAuthGuard)
export class MiniAppAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('weeks')
  async getWeeks(
    @Query('duration') durationRaw?: string,
  ): Promise<{ weeks: MiniAppWeekContract[] }> {
    const duration = parseDuration(durationRaw);
    return { weeks: await this.availability.getAvailableWeeks(duration) };
  }

  @Get('dates')
  async getDates(
    @Query('duration') durationRaw?: string,
    @Query('weekOffset') weekOffsetRaw?: string,
  ): Promise<{ dates: string[] }> {
    const duration = parseDuration(durationRaw);
    const weekOffset = parseWeekOffset(weekOffsetRaw);
    return {
      dates: await this.availability.getAvailableDates(duration, weekOffset),
    };
  }

  @Get('slots')
  async getSlots(
    @Query('duration') durationRaw?: string,
    @Query('date') date?: string,
  ): Promise<{ slots: MiniAppSlotContract[] }> {
    const duration = parseDuration(durationRaw);
    if (!date || !isCalendarDate(date)) {
      throw new BadRequestException('date must use YYYY-MM-DD format');
    }
    const slots = await this.availability.getAvailableSlots(date, duration);
    const timezone = await this.availability.getTimezone();
    return {
      slots: slots.map((slot) => ({
        date: slot.date,
        time: slot.time,
        startAt: slot.startAt.toISOString(),
        endAt: slot.endAt.toISOString(),
        timezone,
      })),
    };
  }
}

function parseDuration(value: string | undefined): number {
  const duration = Number(value);
  if (!Number.isInteger(duration) || ![30, 45, 60].includes(duration)) {
    throw new BadRequestException('duration must be one of: 30, 45, 60');
  }
  return duration;
}

function parseWeekOffset(value: string | undefined): number {
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > 52) {
    throw new BadRequestException(
      'weekOffset must be an integer between 0 and 52',
    );
  }
  return offset;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const normalized = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(normalized.getTime()) &&
    normalized.toISOString().slice(0, 10) === value;
}
