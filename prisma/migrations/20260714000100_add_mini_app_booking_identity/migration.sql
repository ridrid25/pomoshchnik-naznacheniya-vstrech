-- Add Mini App provenance and retry-safe booking identifiers.
ALTER TABLE "Booking"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'TELEGRAM_BOT';

ALTER TABLE "Booking"
ADD COLUMN "publicCode" TEXT;

ALTER TABLE "Booking"
ADD COLUMN "idempotencyKey" TEXT;

-- Existing rows receive stable, human-readable codes based on their SQLite rowid.
UPDATE "Booking"
SET "publicCode" = 'M-' || upper(hex(randomblob(5)))
WHERE "publicCode" IS NULL;

CREATE UNIQUE INDEX "Booking_publicCode_key" ON "Booking"("publicCode");
CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON "Booking"("idempotencyKey");
