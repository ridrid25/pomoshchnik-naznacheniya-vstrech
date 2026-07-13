#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production exec -T app node -e '
  const Database = require("better-sqlite3");
  const { google } = require("googleapis");

  (async () => {
    const db = new Database("/app/data/app.db", { readonly: true });
    const row = db.prepare(`
      SELECT ce.googleEventId, t.accessToken, t.refreshToken, t.scope,
             t.tokenType, t.expiryDate
      FROM Booking b
      JOIN CalendarEvent ce ON ce.bookingId = b.id
      JOIN GoogleOAuthToken t ON t.id = 1
      WHERE b.status = ? AND ce.syncStatus = ?
      ORDER BY b.createdAt DESC
      LIMIT 1
    `).get("PENDING_APPROVAL", "PENDING");
    db.close();
    if (!row) throw new Error("Pending Calendar marker was not found");

    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI,
    );
    oauth.setCredentials({
      access_token: row.accessToken || undefined,
      refresh_token: row.refreshToken || undefined,
      scope: row.scope || undefined,
      token_type: row.tokenType || undefined,
      expiry_date: row.expiryDate ? new Date(row.expiryDate).getTime() : undefined,
    });
    const calendar = google.calendar({ version: "v3", auth: oauth });
    const response = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      eventId: row.googleEventId,
    });
    const event = response.data;
    if (
      event.status !== "tentative" ||
      event.transparency !== "transparent" ||
      event.colorId !== "8" ||
      !event.summary?.startsWith("⏳ На согласовании") ||
      event.attendees?.length ||
      event.conferenceData
    ) {
      throw new Error("Pending Google event does not match the review-marker contract");
    }
    process.stdout.write(JSON.stringify({
      pending_event: "ok",
      status: event.status,
      transparency: event.transparency,
      color_id: event.colorId,
      attendee_count: 0,
      has_meet: false,
      starts_at: event.start?.dateTime || null,
    }));
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
'
printf '\n'
