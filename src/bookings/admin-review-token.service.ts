import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ReviewTokenPayload {
  bookingId: string;
  expiresAt: Date;
}

@Injectable()
export class AdminReviewTokenService {
  private readonly baseUrl: string | null;
  private readonly secret: string | null;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string | null>('app.publicBaseUrl') ?? null;
    this.secret = config.get<string | null>('app.adminActionSecret') ?? null;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.secret);
  }

  createReviewUrl(bookingId: string, expiresAt: Date): string | null {
    if (!this.baseUrl || !this.secret) return null;
    const token = this.createToken(bookingId, expiresAt);
    return `${this.baseUrl}/admin/review/${encodeURIComponent(token)}`;
  }

  createToken(bookingId: string, expiresAt: Date): string {
    if (!this.secret) throw new Error('ADMIN_ACTION_SECRET is not configured');
    const payload = Buffer.from(
      JSON.stringify({ bookingId, expiresAt: expiresAt.getTime() }),
      'utf8',
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string, now = new Date()): ReviewTokenPayload | null {
    if (!this.secret) return null;
    const separator = token.lastIndexOf('.');
    if (separator <= 0 || separator === token.length - 1) return null;
    const payload = token.slice(0, separator);
    const receivedSignature = token.slice(separator + 1);
    const expectedSignature = this.sign(payload);
    const received = Buffer.from(receivedSignature, 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      return null;
    }

    try {
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { bookingId?: unknown; expiresAt?: unknown };
      if (
        typeof decoded.bookingId !== 'string' ||
        !/^[a-z0-9]+$/u.test(decoded.bookingId) ||
        typeof decoded.expiresAt !== 'number' ||
        !Number.isSafeInteger(decoded.expiresAt) ||
        decoded.expiresAt <= now.getTime()
      ) {
        return null;
      }
      return {
        bookingId: decoded.bookingId,
        expiresAt: new Date(decoded.expiresAt),
      };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret!)
      .update(payload, 'utf8')
      .digest('base64url');
  }
}
