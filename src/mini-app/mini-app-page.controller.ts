import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ALLOWED_ASSETS = new Set(['app.js', 'index.html', 'styles.css']);

@Controller('mini-app')
export class MiniAppPageController {
  @Get()
  index(@Res() response: Response): void {
    this.sendAsset(response, 'index.html');
  }

  @Get(':asset')
  asset(@Param('asset') asset: string, @Res() response: Response): void {
    if (!ALLOWED_ASSETS.has(asset)) {
      response.sendStatus(404);
      return;
    }
    this.sendAsset(response, asset);
  }

  private sendAsset(response: Response, asset: string): void {
    const root = resolveAssetRoot();
    response.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://telegram.org",
        "style-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      ].join('; '),
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    response.sendFile(asset, { root });
  }
}

function resolveAssetRoot(): string {
  const compiled = resolve(process.cwd(), 'dist', 'mini-app-public');
  if (__dirname.startsWith(resolve(process.cwd(), 'dist')) && existsSync(compiled)) {
    return compiled;
  }
  return resolve(process.cwd(), 'prototype', 'mini-app');
}
