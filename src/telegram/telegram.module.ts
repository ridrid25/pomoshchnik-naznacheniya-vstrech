import { Module } from '@nestjs/common';

import { AvailabilityModule } from '../availability/availability.module';
import { BookingsModule } from '../bookings/bookings.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { TelegramController } from './telegram.controller';
import { BotFlowService } from './bot-flow.service';

@Module({
  imports: [AvailabilityModule, BookingsModule, GoogleCalendarModule],
  controllers: [TelegramController],
  providers: [BotFlowService],
  exports: [BotFlowService],
})
export class TelegramModule {}
