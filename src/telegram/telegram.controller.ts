import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JsonLoggerService } from '../logging/json-logger.service';

interface TelegramUpdateShape {
  update_id?: unknown;
}

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handleWebhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') receivedSecret?: string,
  ): { ok: true } {
    const configuredSecret = this.config.get<string | null>(
      'app.telegramWebhookSecret',
    );

    if (configuredSecret && receivedSecret !== configuredSecret) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }

    this.logger.logEvent('TelegramController', 'telegram.webhook.received', {
      update_id: getUpdateId(update),
    });

    return { ok: true };
  }
}

function getUpdateId(update: unknown): number | string | null {
  if (typeof update !== 'object' || update === null) {
    return null;
  }

  const value = (update as TelegramUpdateShape).update_id;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}
