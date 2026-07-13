import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'log',
  telegramWebhookSecret:
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
  telegramDevPolling: process.env.TELEGRAM_DEV_POLLING === 'true',
  telegramApiRoot: process.env.TELEGRAM_API_ROOT?.trim() || null,
  adminTelegramId: process.env.ADMIN_TELEGRAM_ID?.trim() || null,
}));
