import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, type calendar_v3 } from 'googleapis';

import { PrismaService } from '../database/prisma.service';
import { JsonLoggerService } from '../logging/json-logger.service';

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CreateGoogleEventInput {
  title: string;
  description: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  attendeeEmail?: string | null;
  createConference?: boolean;
}

export interface CreatePendingGoogleEventInput
  extends Omit<CreateGoogleEventInput, 'attendeeEmail' | 'createConference'> {
  bookingId: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface CreatedGoogleEvent {
  googleEventId: string;
  googleMeetUrl: string | null;
}

export interface CreateAvailabilityBlockEventInput {
  restrictionId: string;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  timezone: string;
  comment: string | null;
}

interface TokenCredentials {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
}

@Injectable()
export class GoogleCalendarService {
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly redirectUri: string | null;
  private readonly calendarId: string;
  private readonly oauthStates = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
  ) {
    this.clientId = config.get<string | null>('google.clientId') ?? null;
    this.clientSecret = config.get<string | null>('google.clientSecret') ?? null;
    this.redirectUri = config.get<string | null>('google.redirectUri') ?? null;
    this.calendarId = config.get<string>('google.calendarId') ?? 'primary';
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  async getStatus(): Promise<{
    configured: boolean;
    authorized: boolean;
    tokenExpiresAt: string | null;
  }> {
    const token = await this.prisma.googleOAuthToken.findUnique({
      where: { id: 1 },
    });
    return {
      configured: this.isConfigured(),
      authorized: Boolean(token?.refreshToken || token?.accessToken),
      tokenExpiresAt: token?.expiryDate?.toISOString() ?? null,
    };
  }

  async getAccountEmail(): Promise<string | null> {
    const token = await this.prisma.googleOAuthToken.findUnique({
      where: { id: 1 },
      select: { accountEmail: true },
    });
    return token?.accountEmail?.trim() || null;
  }

  async probeConnection(): Promise<boolean> {
    const calendar = await this.authorizedCalendar();
    await calendar.calendars.get(
      { calendarId: this.calendarId },
      { timeout: 10_000 },
    );
    return true;
  }

  async getCalendarDayUrl(value: Date, timeZone: string): Promise<string> {
    const date = dateInTimeZone(value, timeZone);
    const [year, month, day] = date.split('-').map(Number);
    const url = new URL(
      `https://calendar.google.com/calendar/r/day/${year}/${month}/${day}`,
    );
    const accountEmail = await this.getAccountEmail();
    if (accountEmail) url.searchParams.set('authuser', accountEmail);
    return url.toString();
  }

  createAuthorizationUrl(loginHint?: string | null): string {
    const oauth = this.createOAuthClient();
    const state = randomBytes(32).toString('hex');
    this.oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    this.cleanupExpiredStates();
    this.logger.logEvent('GoogleCalendarService', 'google.oauth.started');
    return oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: true,
      login_hint: loginHint?.trim() || undefined,
      scope: [GOOGLE_CALENDAR_SCOPE],
      state,
    });
  }

  async handleOAuthCallback(code: string, state: string): Promise<void> {
    const expiresAt = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      throw new Error('Google OAuth state is invalid or expired');
    }
    const oauth = this.createOAuthClient();
    const existing = await this.prisma.googleOAuthToken.findUnique({
      where: { id: 1 },
    });
    const { tokens } = await oauth.getToken(code);
    await this.persistTokens(tokens, existing?.refreshToken ?? null);
    this.logger.logEvent('GoogleCalendarService', 'google.oauth.completed', {
      token_expiry: tokens.expiry_date ?? null,
    });
  }

  async getBusyIntervals(
    timeMin: Date,
    timeMax: Date,
    timezone: string,
  ): Promise<BusyInterval[]> {
    if (!this.isConfigured()) return [];
    try {
      const calendar = await this.authorizedCalendar();
      const response = await calendar.freebusy.query(
        {
          requestBody: {
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            timeZone: timezone,
            items: [{ id: this.calendarId }],
          },
        },
        { timeout: 10_000 },
      );
      const calendarData = response.data.calendars?.[this.calendarId];
      if (calendarData?.errors?.length) {
        throw new Error('Google Calendar returned free/busy errors');
      }
      const intervals = (calendarData?.busy ?? []).flatMap((interval) =>
        interval.start && interval.end
          ? [{ start: new Date(interval.start), end: new Date(interval.end) }]
          : [],
      );
      this.logger.logEvent('GoogleCalendarService', 'google.freebusy.completed', {
        busy_interval_count: intervals.length,
      });
      return intervals;
    } catch (error: unknown) {
      await this.reportFailure('google.freebusy.failed', error);
      throw error;
    }
  }

  async createEvent(input: CreateGoogleEventInput): Promise<CreatedGoogleEvent> {
    try {
      const calendar = await this.authorizedCalendar();
      const response = await calendar.events.insert({
        calendarId: this.calendarId,
        conferenceDataVersion: input.createConference === false ? undefined : 1,
        sendUpdates: 'all',
        requestBody: {
          summary: input.title,
          description: input.description,
          start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
          attendees: input.attendeeEmail
            ? [{ email: input.attendeeEmail }]
            : undefined,
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 60 }],
          },
          conferenceData:
            input.createConference === false
              ? undefined
              : {
                  createRequest: {
                    requestId: randomUUID(),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
        },
      });
      if (!response.data.id) throw new Error('Google Calendar returned no event id');
      const meetUrl =
        response.data.hangoutLink ??
        response.data.conferenceData?.entryPoints?.find(
          (entry) => entry.entryPointType === 'video',
        )?.uri ??
        null;
      this.logger.logEvent('GoogleCalendarService', 'google.event.created', {
        google_event_id: response.data.id,
      });
      return { googleEventId: response.data.id, googleMeetUrl: meetUrl };
    } catch (error: unknown) {
      await this.reportFailure('google.event.create_failed', error);
      throw error;
    }
  }

  async createAvailabilityBlockEvent(
    input: CreateAvailabilityBlockEventInput,
  ): Promise<string> {
    try {
      const calendar = await this.authorizedCalendar();
      const allDay = input.startMinute === null || input.endMinute === null;
      const response = await calendar.events.insert({
        calendarId: this.calendarId,
        sendUpdates: 'none',
        requestBody: {
          summary: '⛔ Недоступно для записи',
          description: [
            'Это время закрыто для записи через помощника.',
            input.comment ? `Комментарий: ${input.comment}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          start: allDay
            ? { date: input.date }
            : {
                dateTime: localDateTime(input.date, input.startMinute!),
                timeZone: input.timezone,
              },
          end: allDay
            ? { date: addUtcDays(input.date, 1) }
            : {
                dateTime: localDateTime(input.date, input.endMinute!),
                timeZone: input.timezone,
              },
          status: 'confirmed',
          transparency: 'opaque',
          colorId: '11',
          visibility: 'private',
          reminders: { useDefault: false, overrides: [] },
          extendedProperties: {
            private: {
              availabilityRestrictionId: input.restrictionId,
              bookingState: 'blocked_by_owner',
            },
          },
        },
      });
      if (!response.data.id) {
        throw new Error('Google Calendar returned no availability block event id');
      }
      this.logger.logEvent(
        'GoogleCalendarService',
        'google.availability_block.created',
        { google_event_id: response.data.id, restriction_id: input.restrictionId },
      );
      return response.data.id;
    } catch (error: unknown) {
      await this.reportFailure('google.availability_block.create_failed', error);
      throw error;
    }
  }

  async deleteAvailabilityBlockEvent(googleEventId: string): Promise<void> {
    try {
      const calendar = await this.authorizedCalendar();
      await calendar.events.delete({
        calendarId: this.calendarId,
        eventId: googleEventId,
        sendUpdates: 'none',
      });
      this.logger.logEvent(
        'GoogleCalendarService',
        'google.availability_block.deleted',
        { google_event_id: googleEventId },
      );
    } catch (error: unknown) {
      if (googleNotFound(error)) return;
      await this.reportFailure('google.availability_block.delete_failed', error);
      throw error;
    }
  }

  async createPendingEvent(
    input: CreatePendingGoogleEventInput,
  ): Promise<CreatedGoogleEvent> {
    try {
      const calendar = await this.authorizedCalendar();
      const response = await calendar.events.insert({
        calendarId: this.calendarId,
        sendUpdates: 'none',
        requestBody: {
          summary: `⏳ На согласовании · ${input.title}`,
          description: input.description,
          start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
          status: 'tentative',
          transparency: 'transparent',
          colorId: '8',
          visibility: 'private',
          source: input.sourceUrl
            ? {
                title:
                  input.sourceTitle ||
                  '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
                url: input.sourceUrl,
              }
            : undefined,
          reminders: { useDefault: false, overrides: [] },
          extendedProperties: {
            private: {
              bookingId: input.bookingId,
              bookingState: 'pending_approval',
            },
          },
        },
      });
      if (!response.data.id) {
        throw new Error('Google Calendar returned no pending event id');
      }
      this.logger.logEvent('GoogleCalendarService', 'google.pending_event.created', {
        google_event_id: response.data.id,
      });
      return { googleEventId: response.data.id, googleMeetUrl: null };
    } catch (error: unknown) {
      await this.reportFailure('google.pending_event.create_failed', error);
      throw error;
    }
  }

  async updatePendingEvent(
    googleEventId: string,
    input: CreatePendingGoogleEventInput,
  ): Promise<void> {
    try {
      const calendar = await this.authorizedCalendar();
      await calendar.events.patch({
        calendarId: this.calendarId,
        eventId: googleEventId,
        sendUpdates: 'none',
        requestBody: {
          summary: `⏳ На согласовании · ${input.title}`,
          description: input.description,
          start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
          status: 'tentative',
          transparency: 'transparent',
          colorId: '8',
          visibility: 'private',
          source: input.sourceUrl
            ? {
                title:
                  input.sourceTitle ||
                  '🔴 ОТКРЫТЬ ЗАЯВКУ — подтвердить или отклонить',
                url: input.sourceUrl,
              }
            : undefined,
          attendees: [],
          reminders: { useDefault: false, overrides: [] },
          extendedProperties: {
            private: {
              bookingId: input.bookingId,
              bookingState: 'pending_approval',
            },
          },
        },
      });
      this.logger.logEvent('GoogleCalendarService', 'google.pending_event.updated', {
        google_event_id: googleEventId,
      });
    } catch (error: unknown) {
      await this.reportFailure('google.pending_event.update_failed', error);
      throw error;
    }
  }

  async updateEventDescription(
    googleEventId: string,
    description: string,
    source?: { title: string; url: string } | null,
  ): Promise<void> {
    try {
      const calendar = await this.authorizedCalendar();
      await calendar.events.patch({
        calendarId: this.calendarId,
        eventId: googleEventId,
        sendUpdates: 'none',
        requestBody: { description, source },
      });
      this.logger.logEvent('GoogleCalendarService', 'google.event.description_updated', {
        google_event_id: googleEventId,
      });
    } catch (error: unknown) {
      await this.reportFailure('google.event.description_update_failed', error);
      throw error;
    }
  }

  async confirmPendingEvent(
    googleEventId: string,
    input: CreateGoogleEventInput,
  ): Promise<CreatedGoogleEvent> {
    try {
      const calendar = await this.authorizedCalendar();
      const response = await calendar.events.patch({
        calendarId: this.calendarId,
        eventId: googleEventId,
        conferenceDataVersion: input.createConference === false ? undefined : 1,
        sendUpdates: 'all',
        requestBody: {
          summary: input.title,
          description: input.description,
          start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
          status: 'confirmed',
          transparency: 'opaque',
          colorId: '10',
          source: null,
          attendees: input.attendeeEmail
            ? [{ email: input.attendeeEmail }]
            : [],
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 60 }],
          },
          conferenceData:
            input.createConference === false
              ? undefined
              : {
                  createRequest: {
                    requestId: randomUUID(),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
          extendedProperties: {
            private: { bookingState: 'confirmed' },
          },
        },
      });
      const meetUrl =
        response.data.hangoutLink ??
        response.data.conferenceData?.entryPoints?.find(
          (entry) => entry.entryPointType === 'video',
        )?.uri ??
        null;
      this.logger.logEvent('GoogleCalendarService', 'google.pending_event.confirmed', {
        google_event_id: googleEventId,
      });
      return { googleEventId, googleMeetUrl: meetUrl };
    } catch (error: unknown) {
      await this.reportFailure('google.pending_event.confirm_failed', error);
      throw error;
    }
  }

  async cancelEvent(googleEventId: string): Promise<void> {
    try {
      const calendar = await this.authorizedCalendar();
      await calendar.events.patch({
        calendarId: this.calendarId,
        eventId: googleEventId,
        sendUpdates: 'all',
        requestBody: { status: 'cancelled' },
      });
      this.logger.logEvent('GoogleCalendarService', 'google.event.cancelled', {
        google_event_id: googleEventId,
      });
    } catch (error: unknown) {
      await this.reportFailure('google.event.cancel_failed', error);
      throw error;
    }
  }

  private createOAuthClient() {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('Google OAuth is not configured');
    }
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
  }

  private async authorizedCalendar(): Promise<calendar_v3.Calendar> {
    const token = await this.prisma.googleOAuthToken.findUnique({
      where: { id: 1 },
    });
    if (!token?.accessToken && !token?.refreshToken) {
      throw new Error('Google Calendar is not authorized');
    }
    const oauth = this.createOAuthClient();
    oauth.setCredentials({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      scope: token.scope ?? undefined,
      token_type: token.tokenType ?? undefined,
      expiry_date: token.expiryDate?.getTime(),
    });
    oauth.on('tokens', (tokens) => {
      void this.persistTokens(tokens, token.refreshToken).catch((error: unknown) =>
        this.logger.errorEvent('GoogleCalendarService', 'google.token.persist_failed', {
          error_message: errorMessage(error),
        }),
      );
    });
    return google.calendar({ version: 'v3', auth: oauth as never });
  }

  private async persistTokens(
    tokens: TokenCredentials,
    fallbackRefreshToken: string | null,
  ): Promise<void> {
    await this.prisma.googleOAuthToken.upsert({
      where: { id: 1 },
      update: {
        accessToken: tokens.access_token ?? undefined,
        refreshToken: tokens.refresh_token ?? fallbackRefreshToken ?? undefined,
        scope: tokens.scope ?? undefined,
        tokenType: tokens.token_type ?? undefined,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
      create: {
        id: 1,
        accessToken: tokens.access_token ?? null,
        refreshToken: tokens.refresh_token ?? fallbackRefreshToken,
        scope: tokens.scope ?? null,
        tokenType: tokens.token_type ?? null,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
    });
  }

  private async reportFailure(event: string, error: unknown): Promise<void> {
    this.logger.errorEvent('GoogleCalendarService', event, {
      error_message: errorMessage(error),
    });
    const token = this.config.get<string | null>('app.telegramBotToken');
    const adminId = this.config.get<string | null>('app.adminTelegramId');
    if (!token || !adminId) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminId,
          text: `⚠️ Ошибка Google Calendar\n${event}\n${errorMessage(error)}`,
        }),
      });
    } catch {
      this.logger.errorEvent('GoogleCalendarService', 'google.admin_notification.failed');
    }
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.oauthStates) {
      if (expiresAt < now) this.oauthStates.delete(state);
    }
  }
}

function localDateTime(date: string, minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function googleNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  return candidate.code === 404 || candidate.code === 410 ||
    candidate.response?.status === 404 || candidate.response?.status === 410;
}

function dateInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
