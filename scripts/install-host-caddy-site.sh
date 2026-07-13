#!/bin/sh
set -eu

domain=${1:?Usage: install-host-caddy-site.sh DOMAIN [UPSTREAM_PORT] [CADDYFILE]}
upstream_port=${2:-3020}
caddyfile=${3:-/etc/caddy/Caddyfile}
marker="# meeting-assistant: ${domain}"

case "$domain" in
  *[!A-Za-z0-9.-]*|'')
    printf 'Invalid domain: %s\n' "$domain" >&2
    exit 1
    ;;
esac
case "$upstream_port" in
  *[!0-9]*|'')
    printf 'Invalid upstream port: %s\n' "$upstream_port" >&2
    exit 1
    ;;
esac

if grep -Fq "$marker" "$caddyfile"; then
  printf 'Caddy site already present: %s\n' "$domain"
  exit 0
fi

backup="${caddyfile}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$caddyfile" "$backup"

printf '\n%s\n%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' \
  "$marker" "$domain" "$upstream_port" >> "$caddyfile"

if ! caddy validate --config "$caddyfile"; then
  cp -a "$backup" "$caddyfile"
  printf 'Caddy validation failed; configuration restored from %s\n' "$backup" >&2
  exit 1
fi

if ! systemctl reload caddy; then
  cp -a "$backup" "$caddyfile"
  systemctl reload caddy || true
  printf 'Caddy reload failed; configuration restored from %s\n' "$backup" >&2
  exit 1
fi

printf 'CADDY_SITE_INSTALLED=%s\nCADDY_BACKUP=%s\n' "$domain" "$backup"
