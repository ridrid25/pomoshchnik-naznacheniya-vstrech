import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppAdminSettingsContract } from './mini-app.contracts';

interface ScheduleUpdateBody {
  timezone?: unknown;
  minimumLeadTimeMinutes?: unknown;
  bufferBeforeMinutes?: unknown;
  bufferAfterMinutes?: unknown;
  maxMeetingsPerDay?: unknown;
  bookingHorizonDays?: unknown;
}

const RUSSIAN_TIMEZONES = new Set([
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
]);

@Controller('api/mini-app/v1/admin/settings')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @Get()
  async getSettings(): Promise<MiniAppAdminSettingsContract> {
    return this.buildContract();
  }

  @Patch('schedule')
  @UseGuards(MiniAppOriginGuard)
  async updateSchedule(
    @Body() body: ScheduleUpdateBody,
  ): Promise<MiniAppAdminSettingsContract> {
    const data = {
      timezone: parseTimezone(body.timezone),
      minimumLeadTimeMinutes: parseInteger(
        body.minimumLeadTimeMinutes,
        'minimumLeadTimeMinutes',
        0,
        10_080,
      ),
      bufferBeforeMinutes: parseInteger(
        body.bufferBeforeMinutes,
        'bufferBeforeMinutes',
        0,
        240,
      ),
      bufferAfterMinutes: parseInteger(
        body.bufferAfterMinutes,
        'bufferAfterMinutes',
        0,
        240,
      ),
      maxMeetingsPerDay: parseInteger(
        body.maxMeetingsPerDay,
        'maxMeetingsPerDay',
        1,
        20,
      ),
      bookingHorizonDays: parseInteger(
        body.bookingHorizonDays,
        'bookingHorizonDays',
        1,
        365,
      ),
    };
    await this.prisma.scheduleSettings.update({ where: { id: 1 }, data });
    return this.buildContract();
  }

  private async buildContract(): Promise<MiniAppAdminSettingsContract> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [googleStatus, accountEmail, schedule, activeRestrictions, blockedUsers, templates] =
      await Promise.all([
        this.googleCalendar.getStatus(),
        this.googleCalendar.getAccountEmail(),
        this.prisma.scheduleSettings.findUnique({
          where: { id: 1 },
          include: {
            workingPeriods: {
              where: { enabled: true },
              orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
            },
          },
        }),
        this.prisma.availabilityRestriction.count({
          where: { date: { gte: startOfToday } },
        }),
        this.prisma.blacklistEntry.count({ where: { active: true } }),
        this.prisma.messageTemplate.count(),
      ]);
    if (!schedule) throw new Error('Schedule settings are not initialized');
    return {
      google: { ...googleStatus, accountEmail },
      schedule: {
        timezone: schedule.timezone,
        minimumLeadTimeMinutes: schedule.minimumLeadTimeMinutes,
        bufferBeforeMinutes: schedule.bufferBeforeMinutes,
        bufferAfterMinutes: schedule.bufferAfterMinutes,
        maxMeetingsPerDay: schedule.maxMeetingsPerDay,
        bookingHorizonDays: schedule.bookingHorizonDays,
        workingPeriods: schedule.workingPeriods.map((period) => ({
          weekday: period.weekday,
          startMinute: period.startMinute,
          endMinute: period.endMinute,
        })),
      },
      overview: { activeRestrictions, blockedUsers, templates },
    };
  }
}

function parseTimezone(value: unknown): string {
  if (typeof value !== 'string' || !RUSSIAN_TIMEZONES.has(value)) {
    throw new BadRequestException('timezone must be a supported Russian time zone');
  }
  return value;
}

function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new BadRequestException(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}
