import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'log',
  telegramWebhookSecret:
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
}));
