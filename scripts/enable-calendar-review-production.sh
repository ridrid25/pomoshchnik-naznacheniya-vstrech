#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
env_file="$app_dir/.env.production"
test -f "$env_file"

domain=$(sed -n 's/^DOMAIN=//p' "$env_file" | tail -n 1)
test -n "$domain"
secret=$(sed -n 's/^ADMIN_ACTION_SECRET=//p' "$env_file" | tail -n 1)
if [ -z "$secret" ]; then
  secret=$(openssl rand -hex 32)
fi

temporary=$(mktemp "$app_dir/.env.production.review.XXXXXX")
trap 'rm -f "$temporary"' EXIT
awk '!/^(PUBLIC_BASE_URL|ADMIN_ACTION_SECRET)=/' "$env_file" > "$temporary"
printf '\nPUBLIC_BASE_URL=https://%s\nADMIN_ACTION_SECRET=%s\n' \
  "$domain" "$secret" >> "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$env_file"
trap - EXIT

printf 'PUBLIC_BASE_URL=https://%s\nADMIN_ACTION_SECRET=PRESENT\n' "$domain"
