import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { MiniAppRequest } from './mini-app-auth.types';
import { MiniAppAuthService } from './mini-app-auth.service';
import { MiniAppSessionService } from './mini-app-session.service';

@Injectable()
export class MiniAppAuthGuard implements CanActivate {
  constructor(private readonly auth: MiniAppAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MiniAppRequest>();
    const token = readCookie(
      request.headers.cookie,
      MiniAppSessionService.COOKIE_NAME,
    );
    if (!token) throw new UnauthorizedException('Mini App session is required');
    request.miniAppAuth = await this.auth.authenticateSession(token);
    return true;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
