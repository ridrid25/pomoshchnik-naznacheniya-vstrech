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
printf '%s' "$html" | grep -Fq 'Запись на встречу'
printf '%s' "$javascript" | grep -Fq 'idempotencyKey'

me_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 \
  "${base_url}/api/mini-app/v1/me")
[ "$me_status" = 401 ]

menu_button=$(curl --fail --silent --show-error --max-time 15 \
  "https://api.telegram.org/bot${bot_token}/getChatMenuButton")
printf '%s' "$menu_button" | node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const payload = JSON.parse(raw);
    const expected = process.argv[1];
    if (!payload.ok || payload.result?.type !== "web_app") process.exit(1);
    if (payload.result?.web_app?.url !== expected) process.exit(1);
  });
' "$mini_app_url"

unset bot_token session_secret
printf 'MINI_APP_STATUS=ready\nMINI_APP_URL=%s\nMENU_BUTTON=web_app\n' "$mini_app_url"
