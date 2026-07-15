#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
env_file="$app_dir/.env.production"

test -f "$env_file"

read_env() {
  sed -n "s/^${1}=//p" "$env_file" | tail -n 1
}

base_url=$(read_env PUBLIC_BASE_URL)
bot_token=$(read_env TELEGRAM_BOT_TOKEN)
session_secret=$(read_env MINI_APP_SESSION_SECRET)
if [ "${#session_secret}" -lt 32 ]; then
  session_secret=$(read_env ADMIN_ACTION_SECRET)
fi

case "$base_url" in
  https://*) ;;
  *)
    printf 'MINI_APP_ERROR=PUBLIC_BASE_URL must use HTTPS\n' >&2
    exit 1
    ;;
esac

[ -n "$bot_token" ] || {
  printf 'MINI_APP_ERROR=TELEGRAM_BOT_TOKEN is missing\n' >&2
  exit 1
}
[ "${#session_secret}" -ge 32 ] || {
  printf 'MINI_APP_ERROR=MINI_APP_SESSION_SECRET and ADMIN_ACTION_SECRET are missing or too short\n' >&2
  exit 1
}

mini_app_url="${base_url}/mini-app"
html=$(curl --fail --silent --show-error --max-time 15 "$mini_app_url")
javascript=$(curl --fail --silent --show-error --max-time 15 "${mini_app_url}/app.js")
printf '%s' "$html" | grep -Fq 'id="app"'
printf '%s' "$javascript" | grep -Fq 'idempotencyKey'

me_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 \
  "${base_url}/api/mini-app/v1/me")
[ "$me_status" = 401 ]

menu_button=$(curl --fail --silent --show-error --max-time 15 \
  "https://api.telegram.org/bot${bot_token}/getChatMenuButton")
printf '%s' "$menu_button" | grep -Fq '"type":"web_app"'
printf '%s' "$menu_button" | grep -Fq "\"url\":\"${mini_app_url}\""

bot_identity=$(curl --fail --silent --show-error --max-time 15 \
  "https://api.telegram.org/bot${bot_token}/getMe")
bot_username=$(printf '%s' "$bot_identity" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
[ -n "$bot_username" ]
printf '%s' "$html" | grep -Fq "https://t.me/${bot_username}"

unset bot_token session_secret
printf 'MINI_APP_STATUS=ready\nMINI_APP_URL=%s\nBOT_USERNAME=@%s\nMENU_BUTTON=web_app\n' \
  "$mini_app_url" "$bot_username"
