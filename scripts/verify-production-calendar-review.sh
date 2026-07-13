#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

review_url=$(docker compose --env-file .env.production exec -T app node -e '
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
    const match = response.data.description?.match(/https:\/\/[^\s]+\/admin\/review\/[A-Za-z0-9._-]+/u);
    if (!match) throw new Error("Pending event has no calendar review URL");
    process.stdout.write(match[0]);
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
')

body=$(mktemp)
trap 'rm -f "$body"' EXIT
status=$(curl --silent --show-error --output "$body" --write-out '%{http_code}' "$review_url")
test "$status" = 200
grep -q 'Подтвердить' "$body"
grep -q 'Отклонить' "$body"

printf 'CALENDAR_REVIEW_PAGE=ok\nHTTP_STATUS=%s\n' "$status"
