#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production exec -T app node -e '
  const Database = require("better-sqlite3");
  const { google } = require("googleapis");

  (async () => {
    const db = new Database("/app/data/app.db", { readonly: true });
    const token = db.prepare("SELECT accessToken, refreshToken, scope, tokenType, expiryDate, accountEmail FROM GoogleOAuthToken WHERE id = 1").get();
    db.close();
    if (!token || (!token.accessToken && !token.refreshToken)) {
      throw new Error("Google Calendar is not authorized");
    }
    if (!token.accountEmail) {
      throw new Error("Google Calendar account email is missing");
    }

    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI,
    );
    oauth.setCredentials({
      access_token: token.accessToken || undefined,
      refresh_token: token.refreshToken || undefined,
      scope: token.scope || undefined,
      token_type: token.tokenType || undefined,
      expiry_date: token.expiryDate ? new Date(token.expiryDate).getTime() : undefined,
    });

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
    const calendar = google.calendar({ version: "v3", auth: oauth });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: tomorrow.toISOString(),
        timeZone: "Europe/Moscow",
        items: [{ id: calendarId }],
      },
    });
    const result = response.data.calendars && response.data.calendars[calendarId];
    if (!result || (result.errors && result.errors.length)) {
      throw new Error("Google Calendar returned free/busy errors");
    }
    process.stdout.write(JSON.stringify({
      google_freebusy: "ok",
      calendar_account: token.accountEmail,
      busy_intervals: (result.busy || []).length,
      timezone: "Europe/Moscow",
    }));
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
'
printf '\n'
