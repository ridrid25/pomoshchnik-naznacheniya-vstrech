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

  config.NODE_ENV = nodeEnv;
  config.LOG_LEVEL = logLevel;
  config.PORT = port;

  return config;
}
