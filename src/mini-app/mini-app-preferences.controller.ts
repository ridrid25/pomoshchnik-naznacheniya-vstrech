import {
  BadRequestException,
  Body,
  Controller,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { NotificationChannel } from '../generated/prisma/client';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppSessionContract } from './mini-app.contracts';
import { toUserContract } from './mini-app-user.presenter';

interface UpdatePreferencesBody {
  channel?: unknown;
  email?: unknown;
}

@Controller('api/mini-app/v1/me/notifications')
@UseGuards(MiniAppAuthGuard, MiniAppOriginGuard)
export class MiniAppPreferencesController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch()
  async update(
    @Req() request: MiniAppRequest,
    @Body() body: UpdatePreferencesBody,
  ): Promise<MiniAppSessionContract> {
    if (!request.miniAppAuth) {
      throw new Error('Mini App auth guard did not attach auth context');
    }
    const channel = parseChannel(body?.channel);
    const email = parseEmail(body?.email);
    const existingEmail = request.miniAppAuth.user.lastConfirmedEmail;
    if (channel === NotificationChannel.EMAIL && !email && !existingEmail) {
      throw new BadRequestException('email is required for email notifications');
    }
    const user = await this.prisma.user.update({
      where: { id: request.miniAppAuth.user.id },
      data: {
        notificationChannel: channel,
        ...(email ? { lastConfirmedEmail: email } : {}),
      },
    });
    return {
      authenticated: true,
      user: toUserContract({ ...request.miniAppAuth, user }),
    };
  }
}

function parseChannel(value: unknown): NotificationChannel {
  if (value === NotificationChannel.TELEGRAM) return NotificationChannel.TELEGRAM;
  if (value === NotificationChannel.EMAIL) return NotificationChannel.EMAIL;
  throw new BadRequestException('channel must be TELEGRAM or EMAIL');
}

function parseEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('email must be a string');
  }
  const email = value.trim().toLowerCase();
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new BadRequestException('email has invalid format');
  }
  return email;
}
