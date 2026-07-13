import { Module } from '@nestjs/common';

import { AvailabilityModule } from '../availability/availability.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { BookingService } from './booking.service';

@Module({
  imports: [AvailabilityModule, GoogleCalendarModule],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingsModule {}
