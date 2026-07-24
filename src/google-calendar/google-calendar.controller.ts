import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Redirect,
} from '@nestjs/common';

import { GoogleCalendarService } from './google-calendar.service';

@Controller('google/oauth')
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Get('status')
  async getStatus() {
    return this.googleCalendar.getStatus();
  }

  @Get('start')
  @Redirect()
  async startAuthorization() {
    if (!this.googleCalendar.isConfigured()) {
      throw new BadRequestException(
        'Google OAuth is not configured. Fill GOOGLE_OAUTH_* in .env.',
      );
    }
    const accountEmail = await this.googleCalendar.getAccountEmail();
    return {
      url: this.googleCalendar.createAuthorizationUrl(accountEmail),
    };
  }

  @Get('callback')
  async handleCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) throw new BadRequestException(`Google authorization failed: ${error}`);
    if (!code || !state) {
      throw new BadRequestException('Google OAuth callback requires code and state');
    }
    await this.googleCalendar.handleOAuthCallback(code, state);
    return {
      ok: true,
      message: 'Google Calendar подключен. Можно вернуться в Telegram.',
    };
  }
}
