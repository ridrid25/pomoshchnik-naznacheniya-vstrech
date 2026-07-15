const NODE_ENV_VALUES = new Set(['development', 'test', 'production']);
const LOG_LEVEL_VALUES = new Set([
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
]);

export function validateEnvironment(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...rawConfig };
  const nodeEnv = String(config.NODE_ENV ?? 'development').trim();
  const logLevel = String(config.LOG_LEVEL ?? 'log').trim();
  const port = Number(config.PORT ?? 3000);
  const databaseUrl = String(
    config.DATABASE_URL ?? 'file:./data/app.db',
  ).trim();
  const telegramDevPolling = parseBoolean(
    config.TELEGRAM_DEV_POLLING ?? false,
    'TELEGRAM_DEV_POLLING',
  );
  const telegramBotToken = String(config.TELEGRAM_BOT_TOKEN ?? '').trim();
  const adminTelegramId = String(config.ADMIN_TELEGRAM_ID ?? '').trim();
  const telegramApiRoot = String(config.TELEGRAM_API_ROOT ?? '').trim();
  const telegramWebhookSecret = String(
    config.TELEGRAM_WEBHOOK_SECRET ?? '',
  ).trim();
  const googleClientId = String(config.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const googleClientSecret = String(
    config.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
  ).trim();
  const googleRedirectUri = String(
    config.GOOGLE_OAUTH_REDIRECT_URI ?? '',
  ).trim();
  const publicBaseUrl = String(config.PUBLIC_BASE_URL ?? '').trim();
  const adminActionSecret = String(config.ADMIN_ACTION_SECRET ?? '').trim();
  const miniAppSessionSecret = String(
    config.MINI_APP_SESSION_SECRET ?? '',
  ).trim();
  const miniAppSessionTtlSeconds = Number(
    config.MINI_APP_SESSION_TTL_SECONDS ?? 7200,
  );
  const miniAppInitDataMaxAgeSeconds = Number(
    config.MINI_APP_INIT_DATA_MAX_AGE_SECONDS ?? 600,
  );
  const smtpHost = String(config.SMTP_HOST ?? '').trim();
  const smtpPort = Number(config.SMTP_PORT ?? 587);
  const smtpSecure = parseBoolean(config.SMTP_SECURE ?? false, 'SMTP_SECURE');
  const smtpUser = String(config.SMTP_USER ?? '').trim();
  const smtpPassword = String(config.SMTP_PASSWORD ?? '');
  const smtpFrom = String(config.SMTP_FROM ?? '').trim();

  if (!NODE_ENV_VALUES.has(nodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of: ${[...NODE_ENV_VALUES].join(', ')}`,
    );
  }

  if (!LOG_LEVEL_VALUES.has(logLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of: ${[...LOG_LEVEL_VALUES].join(', ')}`,
    );
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (!databaseUrl.startsWith('file:')) {
    throw new Error('DATABASE_URL must use the file: protocol for SQLite');
  }

  if (telegramDevPolling && !telegramBotToken) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required when TELEGRAM_DEV_POLLING=true',
    );
  }

  if (adminTelegramId && !/^\d+$/u.test(adminTelegramId)) {
    throw new Error('ADMIN_TELEGRAM_ID must contain digits only');
  }

  if (telegramApiRoot && nodeEnv !== 'test') {
    throw new Error('TELEGRAM_API_ROOT may only be set in NODE_ENV=test');
  }

  if (
    nodeEnv === 'production' &&
    telegramBotToken &&
    !telegramDevPolling &&
    !telegramWebhookSecret
  ) {
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET is required for Telegram webhook in production',
    );
  }

  const googleValues = [googleClientId, googleClientSecret, googleRedirectUri];
  if (googleValues.some(Boolean) && !googleValues.every(Boolean)) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI must be configured together',
    );
  }

  if (googleRedirectUri) {
    const redirect = new URL(googleRedirectUri);
    if (
      nodeEnv === 'production' &&
      redirect.protocol !== 'https:'
    ) {
      throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production');
    }
  }

  if (publicBaseUrl) {
    const baseUrl = new URL(publicBaseUrl);
    if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
      throw new Error('PUBLIC_BASE_URL must contain only scheme and host');
    }
    if (nodeEnv === 'production' && baseUrl.protocol !== 'https:') {
      throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
    }
  }
  if ((publicBaseUrl || adminActionSecret) && !(publicBaseUrl && adminActionSecret)) {
    throw new Error(
      'PUBLIC_BASE_URL and ADMIN_ACTION_SECRET must be configured together',
    );
  }
  if (adminActionSecret && adminActionSecret.length < 32) {
    throw new Error('ADMIN_ACTION_SECRET must contain at least 32 characters');
  }
  if (miniAppSessionSecret && miniAppSessionSecret.length < 32) {
    throw new Error('MINI_APP_SESSION_SECRET must contain at least 32 characters');
  }
  if (nodeEnv === 'production' && publicBaseUrl && !miniAppSessionSecret) {
    throw new Error(
      'MINI_APP_SESSION_SECRET is required with PUBLIC_BASE_URL in production',
    );
  }
  if (
    !Number.isInteger(miniAppSessionTtlSeconds) ||
    miniAppSessionTtlSeconds < 300 ||
    miniAppSessionTtlSeconds > 86_400
  ) {
    throw new Error(
      'MINI_APP_SESSION_TTL_SECONDS must be an integer between 300 and 86400',
    );
  }
  if (
    !Number.isInteger(miniAppInitDataMaxAgeSeconds) ||
    miniAppInitDataMaxAgeSeconds < 60 ||
    miniAppInitDataMaxAgeSeconds > 3600
  ) {
    throw new Error(
      'MINI_APP_INIT_DATA_MAX_AGE_SECONDS must be an integer between 60 and 3600',
    );
  }
  if (nodeEnv === 'production' && googleRedirectUri && !publicBaseUrl) {
    throw new Error(
      'PUBLIC_BASE_URL and ADMIN_ACTION_SECRET are required with Google Calendar in production',
    );
  }

  const smtpValues = [smtpHost, smtpUser, smtpPassword, smtpFrom];
  if (smtpValues.some(Boolean) && !smtpValues.every(Boolean)) {
    throw new Error(
      'SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM must be configured together',
    );
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }

  config.NODE_ENV = nodeEnv;
  config.LOG_LEVEL = logLevel;
  config.PORT = port;
  config.DATABASE_URL = databaseUrl;
  config.TELEGRAM_DEV_POLLING = telegramDevPolling;
  config.TELEGRAM_BOT_TOKEN = telegramBotToken;
  config.ADMIN_TELEGRAM_ID = adminTelegramId;
  config.TELEGRAM_API_ROOT = telegramApiRoot;
  config.TELEGRAM_WEBHOOK_SECRET = telegramWebhookSecret;
  config.GOOGLE_OAUTH_CLIENT_ID = googleClientId;
  config.GOOGLE_OAUTH_CLIENT_SECRET = googleClientSecret;
  config.GOOGLE_OAUTH_REDIRECT_URI = googleRedirectUri;
  config.PUBLIC_BASE_URL = publicBaseUrl.replace(/\/$/u, '');
  config.ADMIN_ACTION_SECRET = adminActionSecret;
  config.MINI_APP_SESSION_SECRET = miniAppSessionSecret;
  config.MINI_APP_SESSION_TTL_SECONDS = miniAppSessionTtlSeconds;
  config.MINI_APP_INIT_DATA_MAX_AGE_SECONDS = miniAppInitDataMaxAgeSeconds;
  config.SMTP_HOST = smtpHost;
  config.SMTP_PORT = smtpPort;
  config.SMTP_SECURE = smtpSecure;
  config.SMTP_USER = smtpUser;
  config.SMTP_PASSWORD = smtpPassword;
  config.SMTP_FROM = smtpFrom;

  return config;
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false' || normalized === '') return false;
  throw new Error(`${name} must be true or false`);
}
