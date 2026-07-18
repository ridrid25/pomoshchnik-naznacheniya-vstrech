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
  workingPeriods?: unknown;
}

interface WorkingPeriodInput {
  weekday: number;
  startMinute: number;
  endMinute: number;
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
    const workingPeriods = parseWorkingPeriods(body.workingPeriods);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.scheduleSettings.update({ where: { id: 1 }, data });
      if (workingPeriods !== null) {
        await transaction.scheduleWorkingPeriod.deleteMany({
          where: { scheduleSettingsId: 1 },
        });
        await transaction.scheduleWorkingPeriod.createMany({
          data: workingPeriods.map((period) => ({
            scheduleSettingsId: 1,
            ...period,
            enabled: true,
          })),
        });
      }
    });
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

function parseWorkingPeriods(value: unknown): WorkingPeriodInput[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new BadRequestException('Рабочие интервалы должны быть списком');
  }
  if (value.length === 0) {
    throw new BadRequestException('Оставьте хотя бы один рабочий интервал');
  }
  if (value.length > 28) {
    throw new BadRequestException('Слишком много рабочих интервалов');
  }

  const periods = value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new BadRequestException(`Рабочий интервал ${index + 1} заполнен неверно`);
    }
    const candidate = item as Record<string, unknown>;
    const weekday = parseInteger(candidate.weekday, `workingPeriods[${index}].weekday`, 0, 6);
    const startMinute = parseInteger(
      candidate.startMinute,
      `workingPeriods[${index}].startMinute`,
      0,
      1439,
    );
    const endMinute = parseInteger(
      candidate.endMinute,
      `workingPeriods[${index}].endMinute`,
      1,
      1440,
    );
    if (startMinute % 15 !== 0 || endMinute % 15 !== 0) {
      throw new BadRequestException('Время рабочих интервалов задаётся с шагом 15 минут');
    }
    if (endMinute - startMinute < 30) {
      throw new BadRequestException('Рабочий интервал должен длиться не меньше 30 минут');
    }
    return { weekday, startMinute, endMinute };
  });

  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const dayPeriods = periods
      .filter((period) => period.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);
    if (dayPeriods.length > 4) {
      throw new BadRequestException('В одном дне можно сохранить не больше четырёх интервалов');
    }
    for (let index = 1; index < dayPeriods.length; index += 1) {
      if (dayPeriods[index].startMinute < dayPeriods[index - 1].endMinute) {
        throw new BadRequestException('Рабочие интервалы одного дня не должны пересекаться');
      }
    }
  }
  return periods.sort(
    (left, right) => left.weekday - right.weekday || left.startMinute - right.startMinute,
  );
}
