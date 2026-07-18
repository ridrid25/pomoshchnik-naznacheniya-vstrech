import {
  BadRequestException,
  BadGatewayException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { CalendarSyncStatus, RestrictionType } from '../generated/prisma/client';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppAdminRestrictionContract } from './mini-app.contracts';

interface RestrictionBody {
  date?: unknown;
  type?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  comment?: unknown;
}

@Controller('api/mini-app/v1/admin/restrictions')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminRestrictionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @Get()
  async list(): Promise<{
    timezone: string;
    restrictions: MiniAppAdminRestrictionContract[];
  }> {
    const timezone = await this.getTimezone();
    const today = todayInTimezone(timezone);
    const restrictions = await this.prisma.availabilityRestriction.findMany({
      where: { date: { gte: logicalDate(today) } },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return { timezone, restrictions: restrictions.map(toContract) };
  }

  @Post()
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: RestrictionBody): Promise<{
    restriction: MiniAppAdminRestrictionContract;
    created: boolean;
  }> {
    const timezone = await this.getTimezone();
    const date = parseDate(body.date);
    if (date < todayInTimezone(timezone)) {
      throw new BadRequestException('Нельзя закрыть прошедшую дату');
    }
    const type = parseType(body.type);
    const startMinute =
      type === RestrictionType.TIME_INTERVAL
        ? parseTime(body.startTime, 'startTime')
        : null;
    const endMinute =
      type === RestrictionType.TIME_INTERVAL
        ? parseTime(body.endTime, 'endTime')
        : null;
    if (
      type === RestrictionType.TIME_INTERVAL &&
      startMinute !== null &&
      endMinute !== null &&
      startMinute >= endMinute
    ) {
      throw new BadRequestException('Время окончания должно быть позже начала');
    }
    const comment = parseComment(body.comment);
    const restrictionDate = logicalDate(date);
    const existing = await this.prisma.availabilityRestriction.findFirst({
      where: { date: restrictionDate, type, startMinute, endMinute },
    });
    if (existing) return { restriction: toContract(existing), created: false };
    let restriction = await this.prisma.availabilityRestriction.create({
      data: { date: restrictionDate, type, startMinute, endMinute, comment },
    });
    restriction = await this.syncWithCalendar(restriction, timezone, false);
    return { restriction: toContract(restriction), created: true };
  }

  @Post(':id/sync')
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async sync(@Param('id') id: string): Promise<{
    restriction: MiniAppAdminRestrictionContract;
  }> {
    const restriction = await this.prisma.availabilityRestriction.findUnique({
      where: { id },
    });
    if (!restriction) throw new NotFoundException('Ограничение не найдено');
    const timezone = await this.getTimezone();
    return {
      restriction: toContract(
        await this.syncWithCalendar(restriction, timezone, true),
      ),
    };
  }

  @Delete(':id')
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    const restriction = await this.prisma.availabilityRestriction.findUnique({
      where: { id },
    });
    if (!restriction) throw new NotFoundException('Ограничение не найдено');
    const timezone = await this.getTimezone();
    if (restriction.date < logicalDate(todayInTimezone(timezone))) {
      throw new BadRequestException('Прошедшее ограничение нельзя удалить');
    }
    if (restriction.googleEventId) {
      try {
        await this.googleCalendar.deleteAvailabilityBlockEvent(
          restriction.googleEventId,
        );
      } catch {
        throw new BadGatewayException(
          'Не удалось убрать занятость из Google Calendar. Попробуйте ещё раз.',
        );
      }
    }
    await this.prisma.availabilityRestriction.delete({ where: { id } });
    return { deleted: true };
  }

  private async syncWithCalendar(
    restriction: RestrictionRecord,
    timezone: string,
    failOnError: boolean,
  ): Promise<RestrictionRecord> {
    if (
      restriction.calendarSyncStatus === CalendarSyncStatus.SYNCED &&
      restriction.googleEventId
    ) {
      return restriction;
    }
    const googleStatus = await this.googleCalendar.getStatus();
    if (!googleStatus.authorized) {
      if (failOnError) {
        throw new BadRequestException('Сначала подключите Google Calendar');
      }
      return restriction;
    }
    try {
      const googleEventId = await this.googleCalendar.createAvailabilityBlockEvent({
        restrictionId: restriction.id,
        date: restriction.date.toISOString().slice(0, 10),
        startMinute: restriction.startMinute,
        endMinute: restriction.endMinute,
        timezone,
        comment: restriction.comment,
      });
      return await this.prisma.availabilityRestriction.update({
        where: { id: restriction.id },
        data: {
          googleEventId,
          calendarSyncStatus: CalendarSyncStatus.SYNCED,
        },
      });
    } catch {
      const failed = await this.prisma.availabilityRestriction.update({
        where: { id: restriction.id },
        data: { calendarSyncStatus: CalendarSyncStatus.ERROR },
      });
      if (failOnError) {
        throw new BadGatewayException(
          'Время закрыто для записи, но Google Calendar пока не обновился. Повторите синхронизацию.',
        );
      }
      return failed;
    }
  }

  private async getTimezone(): Promise<string> {
    const schedule = await this.prisma.scheduleSettings.findUnique({
      where: { id: 1 },
      select: { timezone: true },
    });
    if (!schedule) throw new Error('Schedule settings are not initialized');
    return schedule.timezone;
  }
}

interface RestrictionRecord {
  id: string;
  date: Date;
  type: RestrictionType;
  startMinute: number | null;
  endMinute: number | null;
  comment: string | null;
  googleEventId: string | null;
  calendarSyncStatus: CalendarSyncStatus;
  createdAt: Date;
  updatedAt: Date;
}

function toContract(restriction: {
  id: string;
  date: Date;
  type: RestrictionType;
  startMinute: number | null;
  endMinute: number | null;
  comment: string | null;
  calendarSyncStatus: CalendarSyncStatus;
  createdAt: Date;
}): MiniAppAdminRestrictionContract {
  return {
    id: restriction.id,
    date: restriction.date.toISOString().slice(0, 10),
    type: restriction.type,
    startMinute: restriction.startMinute,
    endMinute: restriction.endMinute,
    comment: restriction.comment,
    calendarSyncStatus:
      restriction.calendarSyncStatus === CalendarSyncStatus.SYNCED
        ? 'SYNCED'
        : restriction.calendarSyncStatus === CalendarSyncStatus.ERROR
          ? 'ERROR'
          : 'PENDING',
    createdAt: restriction.createdAt.toISOString(),
  };
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new BadRequestException('Дата должна быть в формате YYYY-MM-DD');
  }
  const normalized = new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10);
  if (normalized !== value) throw new BadRequestException('Укажите существующую дату');
  return value;
}

function parseType(value: unknown): RestrictionType {
  if (value === RestrictionType.FULL_DAY) return RestrictionType.FULL_DAY;
  if (value === RestrictionType.TIME_INTERVAL) return RestrictionType.TIME_INTERVAL;
  throw new BadRequestException('Выберите тип ограничения');
}

function parseTime(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new BadRequestException(`${field} должно быть временем HH:MM`);
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function parseComment(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException('Комментарий должен быть текстом');
  const comment = value.trim();
  if (!comment) return null;
  if (comment.length > 500) throw new BadRequestException('Комментарий слишком длинный');
  return comment;
}

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function logicalDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
