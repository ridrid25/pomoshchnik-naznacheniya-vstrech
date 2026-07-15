import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { UserStatus } from '../../generated/prisma/client';
import { JsonLoggerService } from '../../logging/json-logger.service';
import type { MiniAppAuthContext } from './mini-app-auth.types';
import { MiniAppSessionService } from './mini-app-session.service';
import { TelegramInitDataService } from './telegram-init-data.service';

@Injectable()
export class MiniAppAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: JsonLoggerService,
    private readonly initData: TelegramInitDataService,
    private readonly sessions: MiniAppSessionService,
  ) {}

  async authenticateInitData(rawInitData: string): Promise<{
    auth: MiniAppAuthContext;
    token: string;
  }> {
    const telegramUser = this.initData.validate(rawInitData);
    const user = await this.prisma.user.upsert({
      where: { telegramId: telegramUser.id },
      update: {
        telegramUsername: telegramUser.username,
        telegramDisplayName: telegramUser.displayName,
      },
      create: {
        telegramId: telegramUser.id,
        telegramUsername: telegramUser.username,
        telegramDisplayName: telegramUser.displayName,
      },
    });
    this.assertActive(user.status);
    const auth = { user, role: this.roleFor(user.telegramId) } as const;
    const token = this.sessions.create(user.id, user.telegramId);
    this.logger.logEvent('MiniAppAuthService', 'mini_app.session.created', {
      user_id: user.id,
      role: auth.role,
    });
    return { auth, token };
  }

  async authenticateSession(token: string): Promise<MiniAppAuthContext> {
    const payload = this.sessions.verify(token);
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || user.telegramId.toString() !== payload.tid) {
      throw new UnauthorizedException('Invalid Mini App session');
    }
    this.assertActive(user.status);
    return { user, role: this.roleFor(user.telegramId) };
  }

  private roleFor(telegramId: bigint): 'ADMIN' | 'USER' {
    const adminTelegramId = this.config.get<string | null>(
      'app.adminTelegramId',
    );
    return adminTelegramId === telegramId.toString() ? 'ADMIN' : 'USER';
  }

  private assertActive(status: UserStatus): void {
    if (status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This Telegram account is blocked');
    }
  }
}
