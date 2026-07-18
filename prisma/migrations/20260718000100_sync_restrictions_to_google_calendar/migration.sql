-- Keep manually blocked time visible in the owner's Google Calendar.
ALTER TABLE "AvailabilityRestriction"
ADD COLUMN "googleEventId" TEXT;

ALTER TABLE "AvailabilityRestriction"
ADD COLUMN "calendarSyncStatus" TEXT NOT NULL DEFAULT 'PENDING';

CREATE UNIQUE INDEX "AvailabilityRestriction_googleEventId_key"
ON "AvailabilityRestriction"("googleEventId");
