#!/bin/sh
set -eu

domain=${1:?Usage: prepare-production-env.sh DOMAIN [APP_BIND_PORT] [SOURCE] [TARGET]}
app_bind_port=${2:-3020}
source_file=${3:-.env.local-source}
target_file=${4:-.env.production}

test -f "$source_file"
umask 077

awk -F= '
  /^(NODE_ENV|PORT|LOG_LEVEL|DATABASE_URL|TELEGRAM_WEBHOOK_SECRET|TELEGRAM_DEV_POLLING|TELEGRAM_API_ROOT|GOOGLE_OAUTH_REDIRECT_URI|PUBLIC_BASE_URL|ADMIN_ACTION_SECRET|DOMAIN|APP_BIND_PORT)=/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ { print; next }
  /^[[:space:]]*(#.*)?$/ { print }
' "$source_file" > "$target_file"

webhook_secret=$(openssl rand -hex 32)
admin_action_secret=$(openssl rand -hex 32)
printf '\nDOMAIN=%s\nAPP_BIND_PORT=%s\nNODE_ENV=production\nPORT=3000\nLOG_LEVEL=log\nDATABASE_URL=file:/app/data/app.db\nTELEGRAM_WEBHOOK_SECRET=%s\nTELEGRAM_DEV_POLLING=false\nTELEGRAM_API_ROOT=\nGOOGLE_OAUTH_REDIRECT_URI=https://%s/google/oauth/callback\nPUBLIC_BASE_URL=https://%s\nADMIN_ACTION_SECRET=%s\n' \
  "$domain" "$app_bind_port" "$webhook_secret" "$domain" "$domain" "$admin_action_secret" >> "$target_file"
chmod 600 "$target_file"

for key in \
  TELEGRAM_BOT_TOKEN \
  TELEGRAM_WEBHOOK_SECRET \
  ADMIN_TELEGRAM_ID \
  GOOGLE_OAUTH_CLIENT_ID \
  GOOGLE_OAUTH_CLIENT_SECRET \
  GOOGLE_OAUTH_REDIRECT_URI \
  PUBLIC_BASE_URL \
  ADMIN_ACTION_SECRET
do
  if grep -Eq "^${key}=.+" "$target_file"; then
    printf '%s=PRESENT\n' "$key"
  else
    printf '%s=MISSING\n' "$key" >&2
    exit 1
  fi
done

rm -f "$source_file"
