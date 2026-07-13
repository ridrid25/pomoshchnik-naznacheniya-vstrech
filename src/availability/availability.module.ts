import { Module } from '@nestjs/common';

import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [GoogleCalendarModule],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
