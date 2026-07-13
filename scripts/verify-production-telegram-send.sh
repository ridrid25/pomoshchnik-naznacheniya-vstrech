#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

set -a
. ./.env.production
set +a

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${ADMIN_TELEGRAM_ID:?ADMIN_TELEGRAM_ID is required}"

response=$(curl --fail --silent --show-error \
  --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${ADMIN_TELEGRAM_ID}" \
  --data-urlencode 'text=✅ Помощник записи перенесён на VPS и работает. Google Calendar и защищённый webhook проверены.')
printf '%s' "$response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
printf 'TELEGRAM_PRODUCTION_SEND=ok\n'

unset TELEGRAM_BOT_TOKEN ADMIN_TELEGRAM_ID
