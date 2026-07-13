#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

set -a
. ./.env.production
set +a

: "${DOMAIN:?DOMAIN is required}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_SECRET:?TELEGRAM_WEBHOOK_SECRET is required}"

database_state() {
  docker compose --env-file .env.production exec -T app node -e '
    const Database = require("better-sqlite3");
    const db = new Database("/app/data/app.db", { readonly: true });
    const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
    const result = {
      integrity: db.pragma("integrity_check", { simple: true }),
      bookings: count("Booking"),
      calendar_events: count("CalendarEvent"),
      oauth_tokens: count("GoogleOAuthToken"),
    };
    db.close();
    process.stdout.write(JSON.stringify(result));
  '
}

before=$(database_state)
printf 'DATABASE_BEFORE=%s\n' "$before"
printf '%s' "$before" | grep -Fq '"integrity":"ok"'

oauth_status=$(curl --fail --silent --show-error "https://${DOMAIN}/google/oauth/status")
printf 'GOOGLE_OAUTH_STATUS=%s\n' "$oauth_status"
printf '%s' "$oauth_status" | grep -Fq '"authorized":true'

accepted_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "https://${DOMAIN}/telegram/webhook" \
  --header 'Content-Type: application/json' \
  --header "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  --data '{"update_id":2147483000}')
rejected_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "https://${DOMAIN}/telegram/webhook" \
  --header 'Content-Type: application/json' \
  --header 'X-Telegram-Bot-Api-Secret-Token: deliberately-wrong' \
  --data '{"update_id":2147483001}')
printf 'WEBHOOK_ACCEPTED_STATUS=%s\nWEBHOOK_REJECTED_STATUS=%s\n' "$accepted_status" "$rejected_status"
test "$accepted_status" = 200
test "$rejected_status" = 401

docker compose --env-file .env.production restart app
attempt=1
while [ "$attempt" -le 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' meeting-assistant-app-1 2>/dev/null || true)
  printf 'RESTART_STATUS=%s\n' "$status"
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && exit 1
  sleep 2
  attempt=$((attempt + 1))
done
test "${status:-}" = healthy

after=$(database_state)
printf 'DATABASE_AFTER=%s\n' "$after"
test "$before" = "$after"

health=$(curl --fail --silent --show-error "https://${DOMAIN}/health")
printf 'PUBLIC_HEALTH=%s\n' "$health"
printf '%s' "$health" | grep -Fq '"status":"ok"'

webhook_info=$(curl --fail --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")
printf 'WEBHOOK_INFO_AFTER_RESTART=%s\n' "$webhook_info"
printf '%s' "$webhook_info" | grep -Fq "\"url\":\"https://${DOMAIN}/telegram/webhook\""

unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
