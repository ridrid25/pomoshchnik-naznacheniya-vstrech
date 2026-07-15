#!/bin/sh
set -eu

expected_app_dir=/opt/meeting-assistant
expected_release_dir=/home/meeting-deploy/releases
archive=${1:-}
commit_sha=${2:-}
app_dir=${3:-}

fail() {
  printf 'DEPLOY_ERROR=%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "This script must run as root"
[ "$#" -eq 3 ] || fail "Expected: archive commit_sha app_dir"
[ "$app_dir" = "$expected_app_dir" ] || fail "Unexpected application directory"
printf '%s' "$commit_sha" | grep -Eq '^[0-9a-f]{40}$' || fail "Invalid commit SHA"
expected_archive="$expected_release_dir/release-${commit_sha}.tar.gz"
[ "$archive" = "$expected_archive" ] || fail "Unexpected release archive path"
[ -f "$archive" ] && [ -s "$archive" ] || fail "Release archive is missing or empty"

exec 9>/var/lock/meeting-assistant-deploy.lock
flock -n 9 || fail "Another meeting-assistant deployment is running"

staging="$app_dir/.deploy/$commit_sha"
builder="meeting-assistant-$(printf '%s' "$commit_sha" | cut -c1-12)"
candidate_image="meeting-assistant-app:candidate-${commit_sha}"
rollback_image="meeting-assistant-app:rollback-${commit_sha}"
backup=
old_image=
release_started=false
deployment_succeeded=false
builder_created=false

cleanup() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ] && [ "$release_started" = true ] && [ "$deployment_succeeded" = false ]; then
    printf 'DEPLOY_ROLLBACK=started\n' >&2
    cd "$app_dir" || true
    docker compose --env-file .env.production stop app >/dev/null 2>&1 || true
    if [ -n "$backup" ] && [ -s "$backup" ]; then
      cp "$backup" "$app_dir/data/app.db" || true
      chown 1000:1000 "$app_dir/data/app.db" || true
      chmod 600 "$app_dir/data/app.db" || true
    fi
    docker image tag "$rollback_image" meeting-assistant-app:local >/dev/null 2>&1 || true
    docker compose --env-file .env.production up -d --no-build --force-recreate app >/dev/null 2>&1 || true
  fi
  if [ "$builder_created" = true ]; then
    docker buildx rm -f "$builder" >/dev/null 2>&1 || true
  fi
  rm -rf "$staging"
  rm -f "$archive"
  return "$exit_status"
}
trap cleanup EXIT INT TERM

rm -rf "$staging"
install -d -m 750 "$staging"

if tar -tzf "$archive" | awk '
  /^\// { bad=1 }
  /(^|\/)\.\.($|\/)/ { bad=1 }
  END { exit bad ? 0 : 1 }
'; then
  fail "Unsafe path found in release archive"
fi
if tar -tvzf "$archive" | awk '{ type=substr($1,1,1); if (type != "-" && type != "d") unsafe=1 } END { exit unsafe ? 0 : 1 }'; then
  fail "Release archive contains a link or special file"
fi
tar -xzf "$archive" -C "$staging" --no-same-owner --no-same-permissions
[ -z "$(find "$staging" -type l -print -quit)" ] || fail "Release extraction contains a symbolic link"

for required in Dockerfile docker-compose.yml package.json package-lock.json prisma.config.ts tsconfig.json tsconfig.build.json src prisma prototype scripts; do
  [ -e "$staging/$required" ] || fail "Required release item is missing: $required"
done
[ ! -e "$staging/.env" ] || fail "Release must not contain .env"
[ ! -e "$staging/.env.production" ] || fail "Release must not contain .env.production"
[ -f "$app_dir/.env.production" ] || fail "Server .env.production is missing"
[ -s "$app_dir/data/app.db" ] || fail "Production database is missing or empty"

if ! grep -Eq '^MINI_APP_SESSION_SECRET=.{32,}$' "$app_dir/.env.production"; then
  env_temporary="$app_dir/.env.production.mini-app.tmp"
  awk '!/^MINI_APP_SESSION_SECRET=/' "$app_dir/.env.production" > "$env_temporary"
  printf '\nMINI_APP_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$env_temporary"
  chmod 600 "$env_temporary"
  mv "$env_temporary" "$app_dir/.env.production"
  printf 'MINI_APP_ENV_MIGRATION=session_secret_added\n'
fi
grep -Eq '^MINI_APP_SESSION_TTL_SECONDS=' "$app_dir/.env.production" || \
  printf 'MINI_APP_SESSION_TTL_SECONDS=7200\n' >> "$app_dir/.env.production"
grep -Eq '^MINI_APP_INIT_DATA_MAX_AGE_SECONDS=' "$app_dir/.env.production" || \
  printf 'MINI_APP_INIT_DATA_MAX_AGE_SECONDS=600\n' >> "$app_dir/.env.production"
chmod 600 "$app_dir/.env.production"

docker buildx create --name "$builder" --driver docker-container --use >/dev/null
builder_created=true
docker buildx build --load --tag "$candidate_image" "$staging"
docker buildx rm -f "$builder" >/dev/null
builder_created=false

old_image=$(docker image inspect meeting-assistant-app:local --format '{{.Id}}' 2>/dev/null || true)
[ -n "$old_image" ] || fail "Current production image was not found"
docker image tag "$old_image" "$rollback_image"

cd "$app_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$app_dir/backups/app-before-${commit_sha}-${timestamp}.db"
docker compose --env-file .env.production stop app
cp "$app_dir/data/app.db" "$backup"
chown 1000:1000 "$backup"
chmod 600 "$backup"
[ -s "$backup" ] || fail "Database backup is empty"
release_started=true

rm -rf "$app_dir/src" "$app_dir/prisma" "$app_dir/prototype" "$app_dir/scripts"
rm -f \
  "$app_dir/.dockerignore" \
  "$app_dir/Caddyfile" \
  "$app_dir/Dockerfile" \
  "$app_dir/docker-compose.yml" \
  "$app_dir/package.json" \
  "$app_dir/package-lock.json" \
  "$app_dir/prisma.config.ts" \
  "$app_dir/tsconfig.json" \
  "$app_dir/tsconfig.build.json"
cp -a "$staging/." "$app_dir/"
docker image tag "$candidate_image" meeting-assistant-app:local

start_and_wait() {
  docker compose --env-file .env.production up -d --no-build --force-recreate app
  attempt=1
  while [ "$attempt" -le 40 ]; do
    container_id=$(docker compose --env-file .env.production ps -q app 2>/dev/null || true)
    status=
    if [ -n "$container_id" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)
    fi
    if [ "$status" = healthy ] && curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3020/health >/dev/null; then
      mini_app_html=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3020/mini-app) || return 1
      mini_app_js=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3020/mini-app/app.js) || return 1
      printf '%s' "$mini_app_html" | grep -Fq 'id="app"' || return 1
      printf '%s' "$mini_app_js" | grep -Fq 'idempotencyKey' || return 1
      return 0
    fi
    [ "$status" != unhealthy ] || return 1
    sleep 3
    attempt=$((attempt + 1))
  done
  return 1
}

if ! start_and_wait; then
  docker compose --env-file .env.production ps app >&2 || true
  docker compose --env-file .env.production logs --no-color --tail=80 app >&2 || true
  fail "New release failed health checks; automatic rollback was started"
fi

printf '%s\n' "$commit_sha" > "$app_dir/.deployed-sha.tmp"
chmod 644 "$app_dir/.deployed-sha.tmp"
mv "$app_dir/.deployed-sha.tmp" "$app_dir/.deployed-sha"
deployment_succeeded=true

docker image rm "$candidate_image" >/dev/null 2>&1 || true
docker image rm "$rollback_image" >/dev/null 2>&1 || true
if [ "$old_image" != "$(docker image inspect meeting-assistant-app:local --format '{{.Id}}')" ]; then
  docker image rm "$old_image" >/dev/null 2>&1 || true
fi

printf 'DEPLOY_STATUS=success\nDEPLOYED_SHA=%s\nDATABASE_BACKUP=%s\n' "$commit_sha" "$backup"
