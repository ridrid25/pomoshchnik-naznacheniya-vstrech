#!/bin/sh
set -eu

app_dir=${1:-/opt/meeting-assistant}
cd "$app_dir"

docker compose --env-file .env.production stop app
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/app-${timestamp}.db"
cp data/app.db "$backup"
chown 1000:1000 "$backup"
chmod 600 "$backup"
test -s "$backup"
docker compose --env-file .env.production start app

attempt=1
while [ "$attempt" -le 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' meeting-assistant-app-1 2>/dev/null || true)
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && exit 1
  sleep 2
  attempt=$((attempt + 1))
done
test "${status:-}" = healthy
printf 'PRODUCTION_BACKUP=%s\nAPP_STATUS=%s\n' "$backup" "$status"
