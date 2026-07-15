import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { MiniAppRequest } from './mini-app-auth.types';

@Injectable()
export class MiniAppAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MiniAppRequest>();
    if (request.miniAppAuth?.role !== 'ADMIN') {
      throw new ForbiddenException('Administrator access is required');
    }
    return true;
  }
}
