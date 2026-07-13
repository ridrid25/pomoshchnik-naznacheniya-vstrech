#!/bin/sh
set -eu

account_email=${1:?Usage: set-production-calendar-account.sh EMAIL [APP_DIR]}
app_dir=${2:-/opt/meeting-assistant}

case "$account_email" in
  *@*.*) ;;
  *)
    printf 'Invalid Google account email\n' >&2
    exit 1
    ;;
esac

cd "$app_dir"
docker compose --env-file .env.production exec -T \
  -e CALENDAR_ACCOUNT_EMAIL="$account_email" app node -e '
    const Database = require("better-sqlite3");
    const db = new Database("/app/data/app.db");
    const result = db.prepare("UPDATE GoogleOAuthToken SET accountEmail = ?, updatedAt = ? WHERE id = 1")
      .run(process.env.CALENDAR_ACCOUNT_EMAIL, new Date().toISOString());
    db.close();
    if (result.changes !== 1) throw new Error("Google OAuth token row was not found");
    process.stdout.write(JSON.stringify({ calendar_account_updated: true }));
  '
printf '\n'
