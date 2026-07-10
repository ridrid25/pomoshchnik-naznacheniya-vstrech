import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JsonLoggerService } from './logging/json-logger.service';

const bootstrapLogger = new JsonLoggerService();
bootstrapLogger.setContext('Bootstrap');
registerProcessErrorHandlers(bootstrapLogger);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: bootstrapLogger,
    abortOnError: false,
  });
  const logger = app.get(JsonLoggerService);
  const config = app.get(ConfigService);

  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.enableShutdownHooks();

  const port = config.get<number>('app.port') ?? 3000;
  const nodeEnv = config.get<string>('app.nodeEnv') ?? 'development';
  const logLevel =
    config.get<'debug' | 'error' | 'log' | 'verbose' | 'warn'>('app.logLevel') ??
    'log';

  logger.setMinimumLevel(logLevel);

  logger.logEvent('Bootstrap', 'configuration.loaded', {
    node_env: nodeEnv,
    log_level: logLevel,
    port,
  });

  await app.listen(port, '0.0.0.0');

  logger.logEvent('Bootstrap', 'application.started', {
    node_env: nodeEnv,
    port,
  });
}

void bootstrap().catch((error: unknown) => {
  bootstrapLogger.fatalEvent('Bootstrap', 'application.start_failed', error);
  process.exitCode = 1;
});

function registerProcessErrorHandlers(logger: JsonLoggerService): void {
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatalEvent('Process', 'process.unhandled_rejection', reason);
    process.exitCode = 1;
  });

  process.on('uncaughtException', (error: Error) => {
    logger.fatalEvent('Process', 'process.uncaught_exception', error);
    process.exit(1);
  });
}
