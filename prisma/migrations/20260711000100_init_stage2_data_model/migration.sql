-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" BIGINT NOT NULL,
    "telegramUsername" TEXT,
    "telegramDisplayName" TEXT NOT NULL,
    "lastConfirmedEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstInteractionAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NEW',
    "durationMinutes" INTEGER NOT NULL,
    "startAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "comment" TEXT,
    "emailSnapshot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "rejectionReason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "originalBookingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Booking_originalBookingId_fkey" FOREIGN KEY ("originalBookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SlotReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SlotReservation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "googleMeetUrl" TEXT,
    "guestEmail" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "cancelledAt" DATETIME,
    CONSTRAINT "CalendarEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduleSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "minimumLeadTimeMinutes" INTEGER NOT NULL DEFAULT 1440,
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxMeetingsPerDay" INTEGER NOT NULL DEFAULT 4,
    "bookingHorizonDays" INTEGER NOT NULL DEFAULT 30,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScheduleWorkingPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleSettingsId" INTEGER NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ScheduleWorkingPeriod_scheduleSettingsId_fkey" FOREIGN KEY ("scheduleSettingsId") REFERENCES "ScheduleSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AvailabilityRestriction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BlacklistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByTelegramId" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "removedAt" DATETIME,
    CONSTRAINT "BlacklistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "message" TEXT NOT NULL,
    "technicalDetails" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BusinessEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "userId" TEXT,
    "bookingId" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BusinessEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "Booking_userId_createdAt_idx" ON "Booking"("userId", "createdAt");
CREATE INDEX "Booking_status_expiresAt_idx" ON "Booking"("status", "expiresAt");
CREATE INDEX "Booking_startAt_idx" ON "Booking"("startAt");
CREATE UNIQUE INDEX "SlotReservation_bookingId_key" ON "SlotReservation"("bookingId");
CREATE INDEX "SlotReservation_status_expiresAt_idx" ON "SlotReservation"("status", "expiresAt");
CREATE INDEX "SlotReservation_startAt_endAt_idx" ON "SlotReservation"("startAt", "endAt");
CREATE UNIQUE INDEX "CalendarEvent_bookingId_key" ON "CalendarEvent"("bookingId");
CREATE UNIQUE INDEX "CalendarEvent_googleEventId_key" ON "CalendarEvent"("googleEventId");
CREATE INDEX "CalendarEvent_syncStatus_idx" ON "CalendarEvent"("syncStatus");
CREATE INDEX "ScheduleWorkingPeriod_weekday_enabled_idx" ON "ScheduleWorkingPeriod"("weekday", "enabled");
CREATE UNIQUE INDEX "ScheduleWorkingPeriod_scheduleSettingsId_weekday_startMinute_endMinute_key" ON "ScheduleWorkingPeriod"("scheduleSettingsId", "weekday", "startMinute", "endMinute");
CREATE INDEX "AvailabilityRestriction_date_type_idx" ON "AvailabilityRestriction"("date", "type");
CREATE UNIQUE INDEX "BlacklistEntry_userId_key" ON "BlacklistEntry"("userId");
CREATE INDEX "BlacklistEntry_active_idx" ON "BlacklistEntry"("active");
CREATE UNIQUE INDEX "MessageTemplate_type_key" ON "MessageTemplate"("type");
CREATE INDEX "SystemLog_level_createdAt_idx" ON "SystemLog"("level", "createdAt");
CREATE INDEX "SystemLog_relatedEntityType_relatedEntityId_idx" ON "SystemLog"("relatedEntityType", "relatedEntityId");
CREATE INDEX "BusinessEvent_eventType_createdAt_idx" ON "BusinessEvent"("eventType", "createdAt");
CREATE INDEX "BusinessEvent_userId_idx" ON "BusinessEvent"("userId");
CREATE INDEX "BusinessEvent_bookingId_idx" ON "BusinessEvent"("bookingId");
