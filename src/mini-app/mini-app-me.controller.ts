import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import type { MiniAppRequest } from './auth/mini-app-auth.types';
import type { MiniAppSessionContract } from './mini-app.contracts';
import { toUserContract } from './mini-app-user.presenter';

@Controller('api/mini-app/v1/me')
@UseGuards(MiniAppAuthGuard)
export class MiniAppMeController {
  @Get()
  getMe(@Req() request: MiniAppRequest): MiniAppSessionContract {
    if (!request.miniAppAuth) {
      throw new Error('Mini App auth guard did not attach auth context');
    }
    return {
      authenticated: true,
      user: toUserContract(request.miniAppAuth),
    };
  }
}
