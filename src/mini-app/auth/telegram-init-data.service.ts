import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { TelegramMiniAppUser } from './mini-app-auth.types';

const MAX_INIT_DATA_LENGTH = 16_384;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 30;

interface TelegramUserPayload {
  id?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
}

@Injectable()
export class TelegramInitDataService {
  constructor(private readonly config: ConfigService) {}

  validate(initData: string, now = new Date()): TelegramMiniAppUser {
    const botToken = this.config.get<string | null>('app.telegramBotToken');
    if (!botToken) {
      throw new ServiceUnavailableException('Mini App is not configured');
    }
    if (!initData || initData.length > MAX_INIT_DATA_LENGTH) {
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    const entries = [...new URLSearchParams(initData).entries()];
    const keys = new Set<string>();
    for (const [key] of entries) {
      if (keys.has(key)) {
        throw new UnauthorizedException('Invalid Telegram init data');
      }
      keys.add(key);
    }

    const hash = entries.find(([key]) => key === 'hash')?.[1];
    const authDateRaw = entries.find(([key]) => key === 'auth_date')?.[1];
    const userRaw = entries.find(([key]) => key === 'user')?.[1];
    if (!hash || !/^[a-f\d]{64}$/iu.test(hash) || !authDateRaw || !userRaw) {
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    const dataCheckString = entries
      .filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();
    const expectedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest();
    const receivedHash = Buffer.from(hash, 'hex');
    if (
      receivedHash.length !== expectedHash.length ||
      !timingSafeEqual(receivedHash, expectedHash)
    ) {
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    const authDate = Number(authDateRaw);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const maxAgeSeconds =
      this.config.get<number>('app.miniAppInitDataMaxAgeSeconds') ?? 600;
    if (
      !Number.isSafeInteger(authDate) ||
      authDate > nowSeconds + MAX_FUTURE_CLOCK_SKEW_SECONDS ||
      nowSeconds - authDate > maxAgeSeconds
    ) {
      throw new UnauthorizedException('Telegram init data has expired');
    }

    return parseTelegramUser(userRaw);
  }
}

function parseTelegramUser(raw: string): TelegramMiniAppUser {
  let payload: TelegramUserPayload;
  try {
    payload = JSON.parse(raw) as TelegramUserPayload;
  } catch {
    throw new UnauthorizedException('Invalid Telegram user data');
  }

  const id = parseTelegramId(payload.id);
  const firstName = normalizeRequiredText(payload.first_name, 128);
  const lastName = normalizeOptionalText(payload.last_name, 128);
  const username = normalizeOptionalText(payload.username, 64);
  return {
    id,
    username,
    displayName: [firstName, lastName].filter(Boolean).join(' '),
  };
}

function parseTelegramId(value: unknown): bigint {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+$/u.test(String(value))
  ) {
    throw new UnauthorizedException('Invalid Telegram user data');
  }
  const id = BigInt(String(value));
  if (id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnauthorizedException('Invalid Telegram user data');
  }
  return id;
}

function normalizeRequiredText(value: unknown, maxLength: number): string {
  const normalized = normalizeOptionalText(value, maxLength);
  if (!normalized) {
    throw new UnauthorizedException('Invalid Telegram user data');
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new UnauthorizedException('Invalid Telegram user data');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    if (!normalized) return null;
    throw new UnauthorizedException('Invalid Telegram user data');
  }
  return normalized;
}
