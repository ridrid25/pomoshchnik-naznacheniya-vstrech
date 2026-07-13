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

webhook_url="https://${DOMAIN}/telegram/webhook"
set_response=$(curl --fail --silent --show-error \
  --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${webhook_url}" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]')
printf 'SET_WEBHOOK=%s\n' "$set_response"
printf '%s' "$set_response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'

webhook_info=$(curl --fail --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")
printf 'WEBHOOK_INFO=%s\n' "$webhook_info"
printf '%s' "$webhook_info" | grep -Fq "\"url\":\"${webhook_url}\""

unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
