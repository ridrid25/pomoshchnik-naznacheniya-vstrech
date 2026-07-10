import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfiguration from './config/app.configuration';
import { validateEnvironment } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfiguration],
      validate: validateEnvironment,
    }),
    LoggingModule,
    HealthModule,
    TelegramModule,
  ],
})
export class AppModule {}
