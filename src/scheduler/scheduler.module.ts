import { Module } from '@nestjs/common';

import { BookingsModule } from '../bookings/bookings.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [BookingsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
