#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production exec -T app node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/app/data/app.db", { readonly: true });
  const result = db.prepare(`
    SELECT
      COUNT(*) AS pending,
      SUM(CASE WHEN ce.id IS NULL THEN 1 ELSE 0 END) AS without_marker,
      SUM(CASE WHEN ce.syncStatus = ? THEN 1 ELSE 0 END) AS pending_markers
    FROM Booking b
    LEFT JOIN CalendarEvent ce ON ce.bookingId = b.id
    WHERE b.status = ?
  `).get("PENDING", "PENDING_APPROVAL");
  db.close();
  process.stdout.write(JSON.stringify(result));
'
printf '\n'
