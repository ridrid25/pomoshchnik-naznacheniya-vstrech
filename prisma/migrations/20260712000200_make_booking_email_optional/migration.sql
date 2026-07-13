-- codex: foreign-keys-off
-- Rebuild the two SQLite tables so email can be omitted for Telegram delivery.

CREATE TABLE "new_Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NEW',
    "durationMinutes" INTEGER NOT NULL,
    "startAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "comment" TEXT,
    "emailSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "rejectionReason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "originalBookingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Booking_originalBookingId_fkey" FOREIGN KEY ("originalBookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Booking" (
    "id", "userId", "type", "durationMinutes", "startAt", "timezone",
    "title", "comment", "emailSnapshot", "status", "rejectionReason",
    "expiresAt", "originalBookingId", "createdAt", "updatedAt"
)
SELECT
    "id", "userId", "type", "durationMinutes", "startAt", "timezone",
    "title", "comment", "emailSnapshot", "status", "rejectionReason",
    "expiresAt", "originalBookingId", "createdAt", "updatedAt"
FROM "Booking";

DROP TABLE "Booking";
ALTER TABLE "new_Booking" RENAME TO "Booking";
CREATE INDEX "Booking_userId_createdAt_idx" ON "Booking"("userId", "createdAt");
CREATE INDEX "Booking_status_expiresAt_idx" ON "Booking"("status", "expiresAt");
CREATE INDEX "Booking_startAt_idx" ON "Booking"("startAt");

CREATE TABLE "new_CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "googleMeetUrl" TEXT,
    "guestEmail" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "cancelledAt" DATETIME,
    CONSTRAINT "CalendarEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_CalendarEvent" (
    "id", "bookingId", "googleEventId", "googleMeetUrl", "guestEmail",
    "syncStatus", "createdAt", "updatedAt", "cancelledAt"
)
SELECT
    "id", "bookingId", "googleEventId", "googleMeetUrl", "guestEmail",
    "syncStatus", "createdAt", "updatedAt", "cancelledAt"
FROM "CalendarEvent";

DROP TABLE "CalendarEvent";
ALTER TABLE "new_CalendarEvent" RENAME TO "CalendarEvent";
CREATE UNIQUE INDEX "CalendarEvent_bookingId_key" ON "CalendarEvent"("bookingId");
CREATE UNIQUE INDEX "CalendarEvent_googleEventId_key" ON "CalendarEvent"("googleEventId");
CREATE INDEX "CalendarEvent_syncStatus_idx" ON "CalendarEvent"("syncStatus");
