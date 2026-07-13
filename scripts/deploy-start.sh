#!/bin/sh
set -eu

cd "${1:-/opt/meeting-assistant}"

if [ -f data/app.db.upload ]; then
  mv data/app.db.upload data/app.db
fi

chown -R 1000:1000 data backups
chmod 750 data backups
test ! -f data/app.db || chmod 600 data/app.db

docker compose --env-file .env.production up -d --no-build app

attempt=1
while [ "$attempt" -le 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' meeting-assistant-app-1 2>/dev/null || true)
  printf 'APP_STATUS=%s\n' "$status"
  if [ "$status" = healthy ]; then
    break
  fi
  if [ "$status" = unhealthy ]; then
    exit 1
  fi
  sleep 2
  attempt=$((attempt + 1))
done

test "${status:-}" = healthy
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=120 app
curl --fail --silent --show-error http://127.0.0.1:3020/health
printf '\n'
