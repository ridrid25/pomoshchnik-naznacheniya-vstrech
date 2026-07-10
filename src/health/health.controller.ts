import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getHealth(): Record<string, unknown> {
    return {
      status: 'ok',
      service: 'pomoshchnik-naznacheniya-vstrech',
      environment: this.config.get<string>('app.nodeEnv') ?? 'development',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    };
  }
}
