#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production exec -T app node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/app/data/app.db", { readonly: true });

  const count = (sql, ...params) =>
    Number(db.prepare(sql).get(...params).count || 0);
  const grouped = (column) => Object.fromEntries(
    db.prepare(`
      SELECT ${column} AS name, COUNT(*) AS count
      FROM Booking
      WHERE source = ?
      GROUP BY ${column}
      ORDER BY ${column}
    `).all("MINI_APP").map((row) => [row.name, Number(row.count)]),
  );

  const period = db.prepare(`
    SELECT MIN(createdAt) AS first_at, MAX(createdAt) AS last_at
    FROM Booking
    WHERE source = ?
  `).get("MINI_APP");

  const result = {
    event: "production.pilot.metrics",
    captured_at: new Date().toISOString(),
    mini_app_bookings: count(
      "SELECT COUNT(*) AS count FROM Booking WHERE source = ?",
      "MINI_APP",
    ),
    unique_mini_app_users: count(
      "SELECT COUNT(DISTINCT userId) AS count FROM Booking WHERE source = ?",
      "MINI_APP",
    ),
    statuses: grouped("status"),
    meeting_formats: grouped("meetingFormat"),
    booking_types: grouped("type"),
    pending_calendar_markers: count(`
      SELECT COUNT(*) AS count
      FROM Booking b
      JOIN CalendarEvent ce ON ce.bookingId = b.id
      WHERE b.source = ? AND b.status = ? AND ce.syncStatus = ?
    `, "MINI_APP", "PENDING_APPROVAL", "PENDING"),
    bookings_without_calendar_record: count(`
      SELECT COUNT(*) AS count
      FROM Booking b
      LEFT JOIN CalendarEvent ce ON ce.bookingId = b.id
      WHERE b.source = ? AND ce.id IS NULL
    `, "MINI_APP"),
    observation_started_at: period.first_at || null,
    observation_last_booking_at: period.last_at || null,
  };

  db.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
'
