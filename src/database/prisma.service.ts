import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

import { PrismaClient } from '../generated/prisma/client';
import { JsonLoggerService } from '../logging/json-logger.service';
import { ensureSqliteDirectory } from './sqlite-path';
import { ensureDefaultData } from './default-data';
import {
  applySqliteMigrations,
  type MigrationResult,
} from './sqlite-migrator';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly databaseUrl: string;
  private readonly appLogger: JsonLoggerService;
  private readonly migrationResult: MigrationResult;

  constructor(config: ConfigService, logger: JsonLoggerService) {
    const databaseUrl =
      config.get<string>('database.url') ?? 'file:./data/app.db';
    ensureSqliteDirectory(databaseUrl);
    const migrationResult = applySqliteMigrations(databaseUrl);
    super({
      adapter: new PrismaBetterSqlite3({ url: databaseUrl }),
    });
    this.databaseUrl = databaseUrl;
    this.appLogger = logger;
    this.migrationResult = migrationResult;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await ensureDefaultData(this);
    this.appLogger.logEvent('PrismaService', 'database.migrations.ready', {
      applied_count: this.migrationResult.appliedNames.length,
      applied_migrations: this.migrationResult.appliedNames,
      total_count: this.migrationResult.totalCount,
    });
    this.appLogger.logEvent('PrismaService', 'database.connected', {
      provider: 'sqlite',
      database_url: redactDatabaseUrl(this.databaseUrl),
    });
    this.appLogger.logEvent('PrismaService', 'database.seed.ready', {
      schedule_settings_id: 1,
      message_template_count: 6,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.appLogger.logEvent('PrismaService', 'database.disconnected', {
      provider: 'sqlite',
    });
  }
}

function redactDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.startsWith('file:') ? databaseUrl : '[redacted]';
}
