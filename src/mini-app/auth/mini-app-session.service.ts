import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface SessionPayload {
  v: 1;
  sub: string;
  tid: string;
  iat: number;
  exp: number;
  nonce: string;
}

@Injectable()
export class MiniAppSessionService {
  static readonly COOKIE_NAME = 'meeting_mini_app_session';

  constructor(private readonly config: ConfigService) {}

  create(userId: string, telegramId: bigint, now = new Date()): string {
    const secret = this.requireSecret();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const ttl = this.config.get<number>('app.miniAppSessionTtlSeconds') ?? 7200;
    const payload: SessionPayload = {
      v: 1,
      sub: userId,
      tid: telegramId.toString(),
      iat: issuedAt,
      exp: issuedAt + ttl,
      nonce: randomBytes(12).toString('base64url'),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${sign(encoded, secret)}`;
  }

  verify(token: string, now = new Date()): SessionPayload {
    const secret = this.requireSecret();
    const [encoded, receivedSignature, extra] = token.split('.');
    if (!encoded || !receivedSignature || extra) {
      throw new UnauthorizedException('Invalid Mini App session');
    }
    const expectedSignature = Buffer.from(sign(encoded, secret));
    const received = Buffer.from(receivedSignature);
    if (
      received.length !== expectedSignature.length ||
      !timingSafeEqual(received, expectedSignature)
    ) {
      throw new UnauthorizedException('Invalid Mini App session');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid Mini App session');
    }
    if (!isSessionPayload(payload)) {
      throw new UnauthorizedException('Invalid Mini App session');
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (payload.exp <= nowSeconds || payload.iat > nowSeconds + 30) {
      throw new UnauthorizedException('Mini App session has expired');
    }
    return payload;
  }

  cookieOptions(): {
    httpOnly: true;
    maxAge: number;
    path: string;
    sameSite: 'strict' | 'none';
    secure: boolean;
    partitioned: boolean;
  } {
    const production = this.config.get<string>('app.nodeEnv') === 'production';
    return {
      httpOnly: true,
      maxAge:
        (this.config.get<number>('app.miniAppSessionTtlSeconds') ?? 7200) *
        1000,
      path: '/api/mini-app',
      sameSite: production ? 'none' : 'strict',
      secure: production,
      partitioned: production,
    };
  }

  private requireSecret(): string {
    const secret = this.config.get<string | null>('app.miniAppSessionSecret');
    if (!secret) {
      throw new ServiceUnavailableException('Mini App is not configured');
    }
    return secret;
  }
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<SessionPayload>;
  return (
    payload.v === 1 &&
    typeof payload.sub === 'string' &&
    payload.sub.length > 0 &&
    typeof payload.tid === 'string' &&
    /^\d+$/u.test(payload.tid) &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp) &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16
  );
}
