import { Module } from '@nestjs/common';

import { AvailabilityModule } from '../availability/availability.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { NotificationModule } from '../notifications/notification.module';
import { AdminReviewController } from './admin-review.controller';
import { AdminReviewTokenService } from './admin-review-token.service';
import { BookingDecisionService } from './booking-decision.service';
import { BookingService } from './booking.service';

@Module({
  imports: [AvailabilityModule, GoogleCalendarModule, NotificationModule],
  controllers: [AdminReviewController],
  providers: [
    AdminReviewTokenService,
    BookingDecisionService,
    BookingService,
  ],
  exports: [AdminReviewTokenService, BookingDecisionService, BookingService],
})
export class BookingsModule {}
