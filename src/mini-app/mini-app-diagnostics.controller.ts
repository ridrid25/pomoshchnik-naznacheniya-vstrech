import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { MiniAppAdminGuard } from './auth/mini-app-admin.guard';
import { MiniAppAuthGuard } from './auth/mini-app-auth.guard';
import { MiniAppOriginGuard } from './auth/mini-app-origin.guard';
import type { MiniAppDiagnosticsContract } from './mini-app.contracts';
import { MiniAppDiagnosticsService } from './mini-app-diagnostics.service';

@Controller('api/mini-app/v1/admin/diagnostics')
@UseGuards(MiniAppAuthGuard, MiniAppAdminGuard)
export class MiniAppDiagnosticsController {
  constructor(private readonly diagnostics: MiniAppDiagnosticsService) {}

  @Get()
  getDiagnostics(): Promise<MiniAppDiagnosticsContract> {
    return this.diagnostics.inspect();
  }

  @Post('repair')
  @UseGuards(MiniAppOriginGuard)
  repair(): Promise<MiniAppDiagnosticsContract> {
    return this.diagnostics.repairNow();
  }
}
