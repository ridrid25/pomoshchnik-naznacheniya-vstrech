import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = {
  workflow: '.github/workflows/deploy-production.yml',
  deploy: 'scripts/deploy-on-server.sh',
  installer: 'scripts/install-github-deploy-access.sh',
  docs: 'docs/AUTO_DEPLOY_GITHUB.md',
};

const failures = [];
const contents = {};

for (const [name, relativePath] of Object.entries(files)) {
  const fullPath = resolve(root, relativePath);
  try {
    if (!statSync(fullPath).isFile()) throw new Error('not a file');
    contents[name] = readFileSync(fullPath, 'utf8');
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
  }
}

const requireMarkers = (name, markers) => {
  const text = contents[name] ?? '';
  for (const marker of markers) {
    if (!text.includes(marker)) failures.push(`${files[name]}: missing marker ${JSON.stringify(marker)}`);
  }
};

requireMarkers('workflow', [
  'branches:',
  '- main',
  'workflow_dispatch:',
  'permissions:',
  'contents: read',
  'cancel-in-progress: false',
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
  'npm ci',
  'cp .env.production.example .env.production',
  'npm test',
  'prototype \\',
  'VPS_SSH_PRIVATE_KEY',
  'VPS_KNOWN_HOSTS',
  'StrictHostKeyChecking yes',
  'scp "$RELEASE_ARCHIVE"',
  '/usr/local/sbin/deploy-meeting-assistant',
  'Verify public health endpoint',
  '${base_url}/mini-app',
  '${base_url}/mini-app/app.js',
]);

requireMarkers('deploy', [
  'expected_app_dir=/opt/meeting-assistant',
  'expected_release_dir=/home/meeting-deploy/releases',
  'flock -n 9',
  'Unsafe path found in release archive',
  'Release archive contains a link or special file',
  'Release must not contain .env.production',
  'MINI_APP_ENV_MIGRATION=session_secret_added',
  'MINI_APP_SESSION_TTL_SECONDS=7200',
  'docker buildx build --load',
  'app-before-${commit_sha}',
  'DEPLOY_ROLLBACK=started',
  'meeting-assistant-app:local',
  'http://127.0.0.1:3020/health',
  'http://127.0.0.1:3020/mini-app',
  'http://127.0.0.1:3020/mini-app/app.js',
  '.deployed-sha',
]);

requireMarkers('installer', [
  'deploy_user=meeting-deploy',
  'ssh-ed25519',
  'authorized_keys',
  '/etc/sudoers.d/meeting-assistant-deploy',
  'visudo -cf',
]);

requireMarkers('docs', [
  'VPS_HOST',
  'VPS_SSH_PRIVATE_KEY',
  'VPS_KNOWN_HOSTS',
  'PUBLIC_HEALTH_URL',
  '.env.production',
]);

if ((contents.workflow ?? '').match(/uses:\s+[^\s]+@(main|master|v\d+)/)) {
  failures.push(`${files.workflow}: every GitHub Action must be pinned to a full commit SHA`);
}
if ((contents.workflow ?? '').includes('git pull')) {
  failures.push(`${files.workflow}: deployment must use the verified archive, not git pull`);
}
const packageBlock = (contents.workflow ?? '').match(
  /- name: Package verified source([\s\S]*?)- name: Upload release to VPS/,
)?.[1] ?? '';
if (packageBlock.match(/\.env(?:\.production)?(?:\s|\\|$)/)) {
  failures.push(`${files.workflow}: environment files must not be included in the release archive`);
}
if ((contents.deploy ?? '').match(/docker\s+(?:system|image|builder)\s+prune/)) {
  failures.push(`${files.deploy}: global Docker pruning is forbidden on the shared VPS`);
}

if (failures.length > 0) {
  console.error('Stage 8 CI/CD verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Stage 8 CI/CD verification passed (${Object.keys(files).length} artifacts).`);

