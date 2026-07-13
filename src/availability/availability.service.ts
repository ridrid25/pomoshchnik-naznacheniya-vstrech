import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import {
  BookingStatus,
  RestrictionType,
  SlotReservationStatus,
} from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';

const SLOT_STEP_MINUTES = 30;
const MINUTES_PER_DAY = 24 * 60;

export interface AvailableSlot {
  date: string;
  time: string;
  startAt: Date;
  endAt: Date;
}

export interface AvailableWeek {
  offset: number;
  startDate: string;
  endDate: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: JsonLoggerService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  async getAvailableWeekOffsets(
    durationMinutes: number,
    now = new Date(),
  ): Promise<number[]> {
    return (await this.getAvailableWeeks(durationMinutes, now)).map(
      (week) => week.offset,
    );
  }

  async getAvailableWeeks(
    durationMinutes: number,
    now = new Date(),
  ): Promise<AvailableWeek[]> {
    assertDuration(durationMinutes);
    const settings = await this.loadSettings();
    const today = dateInTimeZone(now, settings.timezone);
    const horizonDate = addDays(today, settings.bookingHorizonDays);
    const maxWeekOffset = weekOffsetForDate(today, horizonDate);
    const weeks: AvailableWeek[] = [];
    let googleBusy: BusyIntervalLike[];
    try {
      googleBusy = await this.googleCalendar.getBusyIntervals(
        zonedDateTimeToUtc(today, 0, settings.timezone),
        zonedDateTimeToUtc(addDays(horizonDate, 1), 0, settings.timezone),
        settings.timezone,
      );
    } catch {
      this.logRejectedDate(today, durationMinutes, 'google_calendar_unavailable');
      return [];
    }

    for (let offset = 0; offset <= maxWeekOffset; offset += 1) {
      const dates = await this.getAvailableDates(
        durationMinutes,
        offset,
        now,
        googleBusy,
      );
      if (dates.length > 0) {
        const startDate = mondayOfWeek(addDays(today, offset * 7));
        weeks.push({
          offset,
          startDate,
          endDate: addDays(startDate, 6),
        });
      }
    }

    this.logger.logEvent(
      'AvailabilityService',
      'availability.weeks.calculated',
      {
        duration_minutes: durationMinutes,
        timezone: settings.timezone,
        week_offsets: weeks.map((week) => week.offset),
      },
    );
    return weeks;
  }

  async getAvailableDates(
    durationMinutes: number,
    weekOffset: number,
    now = new Date(),
    googleBusyOverride?: BusyIntervalLike[],
  ): Promise<string[]> {
    assertDuration(durationMinutes);
    if (!Number.isInteger(weekOffset) || weekOffset < 0) return [];
    const settings = await this.loadSettings();
    const today = dateInTimeZone(now, settings.timezone);
    const horizonDate = addDays(today, settings.bookingHorizonDays);
    const monday = mondayOfWeek(addDays(today, weekOffset * 7));
    const dates: string[] = [];
    let googleBusy = googleBusyOverride;
    if (!googleBusy) {
      try {
        googleBusy = await this.googleCalendar.getBusyIntervals(
          zonedDateTimeToUtc(monday, 0, settings.timezone),
          zonedDateTimeToUtc(addDays(monday, 7), 0, settings.timezone),
          settings.timezone,
        );
      } catch {
        this.logRejectedDate(
          monday,
          durationMinutes,
          'google_calendar_unavailable',
        );
        return [];
      }
    }

    for (let day = 0; day < 7; day += 1) {
      const date = addDays(monday, day);
      if (compareDates(date, today) < 0 || compareDates(date, horizonDate) > 0) {
        continue;
      }
      const slots = await this.getAvailableSlots(
        date,
        durationMinutes,
        now,
        undefined,
        googleBusy,
      );
      if (slots.length > 0) dates.push(date);
    }

    this.logger.logEvent(
      'AvailabilityService',
      'availability.dates.calculated',
      {
        available_date_count: dates.length,
        duration_minutes: durationMinutes,
        timezone: settings.timezone,
        week_offset: weekOffset,
      },
    );
    return dates;
  }

  async getAvailableSlots(
    date: string,
    durationMinutes: number,
    now = new Date(),
    excludeBookingId?: string,
    googleBusyOverride?: BusyIntervalLike[],
  ): Promise<AvailableSlot[]> {
    assertDate(date);
    assertDuration(durationMinutes);
    const settings = await this.loadSettings();
    const today = dateInTimeZone(now, settings.timezone);
    const horizonDate = addDays(today, settings.bookingHorizonDays);
    if (compareDates(date, today) < 0 || compareDates(date, horizonDate) > 0) {
      this.logRejectedDate(date, durationMinutes, 'outside_booking_horizon');
      return [];
    }

    const weekday = weekdayForDate(date);
    const workingPeriods = settings.workingPeriods.filter(
      (period) => period.enabled && period.weekday === weekday,
    );
    if (workingPeriods.length === 0) {
      this.logRejectedDate(date, durationMinutes, 'non_working_day');
      return [];
    }

    const logicalDayStart = new Date(`${date}T00:00:00.000Z`);
    const logicalDayEnd = new Date(logicalDayStart.getTime() + 86_400_000);
    const localDayStart = zonedDateTimeToUtc(date, 0, settings.timezone);
    const localDayEnd = zonedDateTimeToUtc(
      addDays(date, 1),
      0,
      settings.timezone,
    );
    let googleBusy = googleBusyOverride;
    if (!googleBusy) {
      try {
        googleBusy = await this.googleCalendar.getBusyIntervals(
          localDayStart,
          localDayEnd,
          settings.timezone,
        );
      } catch {
        this.logRejectedDate(date, durationMinutes, 'google_calendar_unavailable');
        return [];
      }
    }
    const [restrictions, reservations, confirmedBookings] = await Promise.all([
      this.prisma.availabilityRestriction.findMany({
        where: { date: { gte: logicalDayStart, lt: logicalDayEnd } },
      }),
      this.prisma.slotReservation.findMany({
        where: {
          bookingId: excludeBookingId ? { not: excludeBookingId } : undefined,
          status: SlotReservationStatus.ACTIVE,
          expiresAt: { gt: now },
          startAt: { lt: localDayEnd },
          endAt: { gt: localDayStart },
        },
      }),
      this.prisma.booking.findMany({
        where: {
          id: excludeBookingId ? { not: excludeBookingId } : undefined,
          status: BookingStatus.CONFIRMED,
          startAt: { gte: localDayStart, lt: localDayEnd },
        },
        select: { id: true, startAt: true, durationMinutes: true },
      }),
    ]);

    if (
      restrictions.some(
        (restriction) => restriction.type === RestrictionType.FULL_DAY,
      )
    ) {
      this.logRejectedDate(date, durationMinutes, 'full_day_restriction');
      return [];
    }

    const occupiedBookingIds = new Set([
      ...reservations.map((reservation) => reservation.bookingId),
      ...confirmedBookings.map((booking) => booking.id),
    ]);
    if (occupiedBookingIds.size >= settings.maxMeetingsPerDay) {
      this.logRejectedDate(date, durationMinutes, 'daily_limit_reached');
      return [];
    }

    const minimumStart = new Date(
      now.getTime() + settings.minimumLeadTimeMinutes * 60_000,
    );
    const slots: AvailableSlot[] = [];
    const slotStartTimestamps = new Set<number>();
    const rejectionCounts: Record<string, number> = {};

    for (const period of workingPeriods) {
      for (
        let startMinute = roundUpToStep(period.startMinute, SLOT_STEP_MINUTES);
        startMinute + durationMinutes <= period.endMinute;
        startMinute += SLOT_STEP_MINUTES
      ) {
        const startAt = zonedDateTimeToUtc(
          date,
          startMinute,
          settings.timezone,
        );
        const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
        if (startAt < minimumStart) {
          increment(rejectionCounts, 'minimum_lead_time');
          continue;
        }

        const bufferedStart = new Date(
          startAt.getTime() - settings.bufferBeforeMinutes * 60_000,
        );
        const bufferedEnd = new Date(
          endAt.getTime() + settings.bufferAfterMinutes * 60_000,
        );
        if (
          restrictions.some((restriction) => {
            if (restriction.type !== RestrictionType.TIME_INTERVAL) return false;
            const restrictionStart = zonedDateTimeToUtc(
              date,
              restriction.startMinute ?? 0,
              settings.timezone,
            );
            const restrictionEnd = zonedDateTimeToUtc(
              date,
              restriction.endMinute ?? MINUTES_PER_DAY,
              settings.timezone,
            );
            return overlaps(bufferedStart, bufferedEnd, restrictionStart, restrictionEnd);
          })
        ) {
          increment(rejectionCounts, 'time_restriction');
          continue;
        }

        if (
          reservations.some((reservation) =>
            overlaps(
              bufferedStart,
              bufferedEnd,
              new Date(
                reservation.startAt.getTime() -
                  settings.bufferBeforeMinutes * 60_000,
              ),
              new Date(
                reservation.endAt.getTime() +
                  settings.bufferAfterMinutes * 60_000,
              ),
            ),
          )
        ) {
          increment(rejectionCounts, 'active_reservation');
          continue;
        }

        if (
          confirmedBookings.some((booking) => {
            const bookingEnd = new Date(
              booking.startAt.getTime() + booking.durationMinutes * 60_000,
            );
            return overlaps(
              bufferedStart,
              bufferedEnd,
              new Date(
                booking.startAt.getTime() -
                  settings.bufferBeforeMinutes * 60_000,
              ),
              new Date(
                bookingEnd.getTime() + settings.bufferAfterMinutes * 60_000,
              ),
            );
          })
        ) {
          increment(rejectionCounts, 'confirmed_booking');
          continue;
        }

        if (
          googleBusy.some((interval) =>
            overlaps(
              bufferedStart,
              bufferedEnd,
              new Date(
                interval.start.getTime() -
                  settings.bufferBeforeMinutes * 60_000,
              ),
              new Date(
                interval.end.getTime() +
                  settings.bufferAfterMinutes * 60_000,
              ),
            ),
          )
        ) {
          increment(rejectionCounts, 'google_calendar_busy');
          continue;
        }

        if (slotStartTimestamps.has(startAt.getTime())) continue;
        slotStartTimestamps.add(startAt.getTime());
        slots.push({
          date,
          time: minuteToTime(startMinute),
          startAt,
          endAt,
        });
      }
    }

    this.logger.logEvent(
      'AvailabilityService',
      'availability.slots.calculated',
      {
        available_slot_count: slots.length,
        date,
        duration_minutes: durationMinutes,
        rejection_counts: rejectionCounts,
        timezone: settings.timezone,
      },
    );
    return slots;
  }

  async isSlotAvailable(
    date: string,
    time: string,
    durationMinutes: number,
    now = new Date(),
    excludeBookingId?: string,
  ): Promise<boolean> {
    if (!/^\d{2}:\d{2}$/u.test(time)) return false;
    const slots = await this.getAvailableSlots(
      date,
      durationMinutes,
      now,
      excludeBookingId,
    );
    return slots.some((slot) => slot.time === time);
  }

  private async loadSettings() {
    const settings = await this.prisma.scheduleSettings.findUnique({
      where: { id: 1 },
      include: { workingPeriods: true },
    });
    if (!settings) throw new Error('Schedule settings are not initialized');
    return settings;
  }

  private logRejectedDate(
    date: string,
    durationMinutes: number,
    reason: string,
  ): void {
    this.logger.logEvent(
      'AvailabilityService',
      'availability.date.rejected',
      { date, duration_minutes: durationMinutes, reason },
    );
  }
}

interface BusyIntervalLike {
  start: Date;
  end: Date;
}

function assertDuration(durationMinutes: number): void {
  if (![30, 45, 60].includes(durationMinutes)) {
    throw new Error('Duration must be one of: 30, 45, 60 minutes');
  }
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error('Date must use YYYY-MM-DD format');
  }
}

function dateInTimeZone(value: Date, timeZone: string): string {
  const parts = dateTimeParts(value, timeZone);
  return formatDate(parts);
}

function zonedDateTimeToUtc(
  date: string,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const { year, month, day } = parseDate(date);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desiredAsUtc);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = dateTimeParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const adjustment = desiredAsUtc - actualAsUtc;
    if (adjustment === 0) return candidate;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}

function dateTimeParts(value: Date, timeZone: string): DateParts & {
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((item) => item.type === type)?.value;
    if (!found) throw new Error(`Unable to format ${type} in ${timeZone}`);
    return Number(found);
  };
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

function parseDate(date: string): DateParts {
  assertDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day))
    .toISOString()
    .slice(0, 10);
  if (normalized !== date) throw new Error('Date is not a valid calendar date');
  return { year, month, day };
}

function formatDate(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function weekdayForDate(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

function mondayOfWeek(date: string): string {
  return addDays(date, 1 - weekdayForDate(date));
}

function weekOffsetForDate(today: string, target: string): number {
  const start = Date.parse(`${mondayOfWeek(today)}T00:00:00.000Z`);
  const end = Date.parse(`${mondayOfWeek(target)}T00:00:00.000Z`);
  return Math.floor((end - start) / (7 * 86_400_000));
}

function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function minuteToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function overlaps(
  leftStart: Date,
  leftEnd: Date,
  rightStart: Date,
  rightEnd: Date,
): boolean {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}
