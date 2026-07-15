import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const requiredFiles = [
  '.dockerignore',
  '.env.production.example',
  'Caddyfile',
  'Dockerfile',
  'docker-compose.yml',
  'docs/DEPLOY_VPS.md',
  'scripts/prepare-production-env.sh',
  'scripts/deploy-start.sh',
  'scripts/install-host-caddy-site.sh',
  'scripts/install-telegram-webhook.sh',
  'scripts/verify-production-runtime.sh',
  'scripts/verify-production-google.sh',
  'scripts/verify-production-telegram-send.sh',
  'scripts/backup-production.sh',
  'scripts/set-production-calendar-account.sh',
  'scripts/verify-production-account-pin.sh',
  'scripts/inspect-production-pending.sh',
  'scripts/verify-production-pending-event.sh',
  'scripts/enable-calendar-review-production.sh',
  'scripts/verify-production-calendar-review.sh',
  'scripts/verify-production-mini-app.sh',
];

for (const file of requiredFiles) {
  assert.equal(existsSync(file), true, `Missing Stage 7 artifact: ${file}`);
}

const dockerfile = readFileSync('Dockerfile', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const caddy = readFileSync('Caddyfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const envExample = readFileSync('.env.production.example', 'utf8');
const deploymentGuide = readFileSync('docs/DEPLOY_VPS.md', 'utf8');

for (const marker of [
  'node:24.18.0-bookworm-slim',
  'npm prune --omit=dev --ignore-scripts',
  '/app/node_modules ./node_modules',
  'USER node',
  'HEALTHCHECK',
  'dist/main.js',
]) {
  assert.ok(dockerfile.includes(marker), `Dockerfile marker missing: ${marker}`);
}

for (const marker of [
  'restart: unless-stopped',
  './data:/app/data',
  './backups:/app/backups',
  '127.0.0.1:${APP_BIND_PORT:-3020}:3000',
  'caddy:2.11.4-alpine',
  'bundled-proxy',
  'TELEGRAM_DEV_POLLING: "false"',
  'no-new-privileges:true',
]) {
  assert.ok(compose.includes(marker), `Compose marker missing: ${marker}`);
}

assert.ok(caddy.includes('{$DOMAIN}'));
assert.ok(caddy.includes('reverse_proxy app:3000'));
assert.ok(caddy.includes('format json'));

for (const marker of ['.env', 'node_modules', 'data', 'backups']) {
  assert.ok(
    dockerignore.split(/\r?\n/u).includes(marker),
    `.dockerignore marker missing: ${marker}`,
  );
}

const productionEnv = parseEnv(envExample);
for (const key of [
  'DOMAIN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ADMIN_TELEGRAM_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'PUBLIC_BASE_URL',
  'ADMIN_ACTION_SECRET',
  'MINI_APP_SESSION_SECRET',
  'MINI_APP_SESSION_TTL_SECONDS',
  'MINI_APP_INIT_DATA_MAX_AGE_SECONDS',
]) {
  assert.ok(key in productionEnv, `Production env key missing: ${key}`);
}
assert.equal(productionEnv.NODE_ENV, 'production');
assert.equal(productionEnv.TELEGRAM_DEV_POLLING, 'false');
assert.equal(productionEnv.DATABASE_URL, 'file:/app/data/app.db');
assert.equal(productionEnv.TELEGRAM_BOT_TOKEN, '');
assert.equal(productionEnv.TELEGRAM_WEBHOOK_SECRET, '');
assert.equal(productionEnv.MINI_APP_SESSION_SECRET, '');

const miniAppVerification = readFileSync(
  'scripts/verify-production-mini-app.sh',
  'utf8',
);
for (const marker of [
  '/mini-app',
  '${mini_app_url}/app.js',
  '/api/mini-app/v1/me',
  'getChatMenuButton',
  'ADMIN_ACTION_SECRET',
  'MINI_APP_STATUS=ready',
]) {
  assert.ok(
    miniAppVerification.includes(marker),
    `Mini App verification marker missing: ${marker}`,
  );
}

for (const marker of [
  'docker compose --env-file .env.production config',
  'docker compose --env-file .env.production up -d --build',
  'getWebhookInfo',
  'docker compose --env-file .env.production restart app',
  'chown -R 1000:1000 data backups',
  'systemctl reload caddy',
  '--profile bundled-proxy',
]) {
  assert.ok(
    deploymentGuide.includes(marker),
    `Deployment guide marker missing: ${marker}`,
  );
}

let composeConfigChecked = false;
const dockerVersion = spawnSync('docker', ['compose', 'version'], {
  encoding: 'utf8',
  shell: false,
});
if (dockerVersion.status === 0) {
  const composeConfig = spawnSync(
    'docker',
    ['compose', '--env-file', '.env.production.example', 'config'],
    { encoding: 'utf8', shell: false },
  );
  assert.equal(
    composeConfig.status,
    0,
    `${composeConfig.stdout}\n${composeConfig.stderr}`,
  );
  composeConfigChecked = true;
}

process.stdout.write(
  `${JSON.stringify({
    event: 'stage7.deployment.verification.completed',
    required_files_checked: requiredFiles.length,
    dockerfile_checked: true,
    compose_static_checked: true,
    compose_config_checked: composeConfigChecked,
    caddy_checked: true,
    production_env_checked: true,
    deployment_guide_checked: true,
  })}\n`,
);

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        assert.notEqual(separator, -1, `Invalid env line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
