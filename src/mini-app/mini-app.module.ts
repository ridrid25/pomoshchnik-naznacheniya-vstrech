import { Module } from '@nestjs/common';

import { AvailabilityModule } from '../availability/availability.module';
import { BookingsModule } from '../bookings/bookings.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthService } from './auth/mini-app-auth.service';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import { MiniAppSessionService } from './auth/mini-app-session.service';
import { TelegramInitDataService } from './auth/telegram-init-data.service';
import { MiniAppAvailabilityController } from './mini-app-availability.controller';
import { MiniAppAdminBookingsController } from './mini-app-admin-bookings.controller';
import { MiniAppAdminSettingsController } from './mini-app-admin-settings.controller';
import { MiniAppAdminRestrictionsController } from './mini-app-admin-restrictions.controller';
import { MiniAppBookingController } from './mini-app-booking.controller';
import { MiniAppMeController } from './mini-app-me.controller';
import { MiniAppPageController } from './mini-app-page.controller';
import { MiniAppPreferencesController } from './mini-app-preferences.controller';
import { MiniAppSessionController } from './mini-app-session.controller';
import { MiniAppUserBookingsController } from './mini-app-user-bookings.controller';

@Module({
  imports: [AvailabilityModule, BookingsModule, GoogleCalendarModule],
  controllers: [
    MiniAppPageController,
    MiniAppSessionController,
    MiniAppMeController,
    MiniAppAvailabilityController,
    MiniAppBookingController,
    MiniAppUserBookingsController,
    MiniAppPreferencesController,
    MiniAppAdminBookingsController,
    MiniAppAdminSettingsController,
    MiniAppAdminRestrictionsController,
  ],
  providers: [
    TelegramInitDataService,
    MiniAppSessionService,
    MiniAppAuthService,
    MiniAppAuthGuard,
    MiniAppAdminGuard,
    MiniAppOriginGuard,
  ],
})
export class MiniAppModule {}
