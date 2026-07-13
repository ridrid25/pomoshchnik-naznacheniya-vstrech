#!/bin/sh
set -eu

public_key_file=${1:-}
app_dir=${2:-/opt/meeting-assistant}
deploy_user=meeting-deploy
deploy_home=/home/meeting-deploy
sudoers_file=/etc/sudoers.d/meeting-assistant-deploy

fail() {
  printf 'INSTALL_ERROR=%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "This script must run as root"
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail "Expected: public_key_file [app_dir]"
[ "$app_dir" = /opt/meeting-assistant ] || fail "Unexpected application directory"
[ -f "$public_key_file" ] || fail "Public key file does not exist"
[ -f "$app_dir/scripts/deploy-on-server.sh" ] || fail "Server deployment script is missing"

public_key=$(tr -d '\r\n' < "$public_key_file")
printf '%s\n' "$public_key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' || fail "Only an ED25519 public key is accepted"

if ! id "$deploy_user" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$deploy_home" --shell /bin/bash "$deploy_user"
fi
passwd -l "$deploy_user" >/dev/null 2>&1 || true

install -d -o "$deploy_user" -g "$deploy_user" -m 700 "$deploy_home/.ssh"
install -d -o "$deploy_user" -g "$deploy_user" -m 750 "$deploy_home/releases"
authorized_keys="$deploy_home/.ssh/authorized_keys"
touch "$authorized_keys"
if ! grep -Fqx "$public_key" "$authorized_keys"; then
  printf '%s\n' "$public_key" >> "$authorized_keys"
fi
chown "$deploy_user:$deploy_user" "$authorized_keys"
chmod 600 "$authorized_keys"

install -o root -g root -m 0755 "$app_dir/scripts/deploy-on-server.sh" /usr/local/sbin/deploy-meeting-assistant
printf '%s\n' "$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/deploy-meeting-assistant *" > "$sudoers_file"
chown root:root "$sudoers_file"
chmod 440 "$sudoers_file"
visudo -cf "$sudoers_file" >/dev/null || fail "Generated sudoers rule is invalid"

printf 'INSTALL_STATUS=success\nDEPLOY_USER=%s\nRELEASE_DIR=%s\n' "$deploy_user" "$deploy_home/releases"
