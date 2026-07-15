import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppAuthService } from './auth/mini-app-auth.service';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import { MiniAppSessionService } from './auth/mini-app-session.service';
import type { MiniAppSessionContract } from './mini-app.contracts';
import { toUserContract } from './mini-app-user.presenter';

interface CreateSessionBody {
  initData?: unknown;
}

@Controller('api/mini-app/v1/session')
export class MiniAppSessionController {
  constructor(
    private readonly auth: MiniAppAuthService,
    private readonly sessions: MiniAppSessionService,
  ) {}

  @Post()
  @UseGuards(MiniAppOriginGuard)
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() body: CreateSessionBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MiniAppSessionContract> {
    if (typeof body?.initData !== 'string') {
      throw new BadRequestException('initData must be a string');
    }
    const { auth, token } = await this.auth.authenticateInitData(body.initData);
    response.cookie(
      MiniAppSessionService.COOKIE_NAME,
      token,
      this.sessions.cookieOptions(),
    );
    return { authenticated: true, user: toUserContract(auth) };
  }

  @Delete()
  @UseGuards(MiniAppAuthGuard, MiniAppOriginGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  destroy(@Res({ passthrough: true }) response: Response): void {
    const { maxAge: _maxAge, ...options } = this.sessions.cookieOptions();
    response.clearCookie(MiniAppSessionService.COOKIE_NAME, options);
  }
}
