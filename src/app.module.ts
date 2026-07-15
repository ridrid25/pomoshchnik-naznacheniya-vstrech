import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AvailabilityModule } from './availability/availability.module';
import { BookingsModule } from './bookings/bookings.module';
import appConfiguration from './config/app.configuration';
import databaseConfiguration from './config/database.configuration';
import googleConfiguration from './config/google.configuration';
import notificationConfiguration from './config/notification.configuration';
import { validateEnvironment } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { GoogleCalendarModule } from './google-calendar/google-calendar.module';
import { LoggingModule } from './logging/logging.module';
import { MiniAppModule } from './mini-app/mini-app.module';
import { NotificationModule } from './notifications/notification.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [
        appConfiguration,
        databaseConfiguration,
        googleConfiguration,
        notificationConfiguration,
      ],
      validate: validateEnvironment,
    }),
    LoggingModule,
    DatabaseModule,
    AvailabilityModule,
    BookingsModule,
    GoogleCalendarModule,
    NotificationModule,
    MiniAppModule,
    HealthModule,
    SchedulerModule,
    TelegramModule,
  ],
})
export class AppModule {}
