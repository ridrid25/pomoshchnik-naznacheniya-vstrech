import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class MiniAppOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredBaseUrl = this.config.get<string | null>('app.publicBaseUrl');
    if (!configuredBaseUrl) {
      throw new ServiceUnavailableException('Mini App is not configured');
    }
    const request = context.switchToHttp().getRequest<Request>();
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(configuredBaseUrl).origin;
    } catch {
      throw new ServiceUnavailableException('Mini App is not configured');
    }
    if (request.headers.origin !== expectedOrigin) {
      throw new ForbiddenException('Invalid Mini App origin');
    }
    return true;
  }
}
