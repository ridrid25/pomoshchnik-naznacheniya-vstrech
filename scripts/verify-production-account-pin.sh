#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production exec -T app sh -c \
  "grep -R -q 'authuser' /app/dist"
printf 'CALENDAR_LINK_AUTHUSER_IN_IMAGE=ok\n'

sh ./verify-production-runtime.sh
sh ./verify-production-google.sh

docker builder prune --all --force >/dev/null
printf 'DISK='
df -h / | tail -n 1
docker compose --env-file .env.production ps
