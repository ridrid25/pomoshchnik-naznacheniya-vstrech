import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { BookingService } from '../bookings/booking.service';
import { PrismaService } from '../database/prisma.service';
import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppAdminBlockedUserContract } from './mini-app.contracts';

@Controller('api/mini-app/v1/admin/blocked-users')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppAdminBlockedUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingService,
  ) {}

  @Get()
  async list(): Promise<{ users: MiniAppAdminBlockedUserContract[] }> {
    const entries = await this.prisma.blacklistEntry.findMany({
      where: { active: true },
      include: { user: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return {
      users: entries.map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        displayName: entry.user.telegramDisplayName,
        username: entry.user.telegramUsername,
        reason: entry.reason,
        blockedAt: entry.updatedAt.toISOString(),
      })),
    };
  }

  @Post(':userId/unblock')
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async unblock(
    @Param('userId') userId: string,
    @Req() request: MiniAppRequest,
  ): Promise<{ changed: boolean }> {
    const entry = await this.prisma.blacklistEntry.findUnique({
      where: { userId },
      select: { active: true },
    });
    if (!entry) throw new NotFoundException('Пользователь не найден в списке блокировок');
    if (!entry.active) return { changed: false };
    if (!request.miniAppAuth || request.miniAppAuth.role !== 'ADMIN') {
      throw new Error('Mini App admin guard did not attach admin context');
    }
    await this.bookings.setUserBlocked(
      userId,
      false,
      request.miniAppAuth.user.telegramId,
    );
    return { changed: true };
  }
}
