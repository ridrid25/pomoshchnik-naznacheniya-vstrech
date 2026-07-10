import { Injectable, LoggerService } from '@nestjs/common';

type LogLevel = 'debug' | 'error' | 'fatal' | 'log' | 'verbose' | 'warn';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  fatal: 0,
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
  verbose: 4,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  event?: string;
  trace?: string;
  [key: string]: unknown;
}

@Injectable()
export class JsonLoggerService implements LoggerService {
  private defaultContext = 'Application';
  private minimumLevel: LogLevel = 'log';

  setContext(context: string): void {
    this.defaultContext = context;
  }

  setMinimumLevel(level: Exclude<LogLevel, 'fatal'>): void {
    this.minimumLevel = level;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', this.defaultContext, message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', this.defaultContext, message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', this.defaultContext, message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', this.defaultContext, message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', this.defaultContext, message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', this.defaultContext, message, optionalParams);
  }

  logEvent(
    context: string,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.emit({
      timestamp: new Date().toISOString(),
      level: 'log',
      context,
      message: event,
      event,
      ...fields,
    });
  }

  errorEvent(
    context: string,
    event: string,
    fields: Record<string, unknown> = {},
    trace?: string,
  ): void {
    this.emit(
      {
        timestamp: new Date().toISOString(),
        level: 'error',
        context,
        message: event,
        event,
        ...fields,
        ...(trace ? { trace } : {}),
      },
      true,
    );
  }

  fatalEvent(
    context: string,
    event: string,
    error: unknown,
  ): void {
    const normalized = normalizeError(error);
    this.emit(
      {
        timestamp: new Date().toISOString(),
        level: 'fatal',
        context,
        message: event,
        event,
        error_message: normalized.message,
        ...(normalized.stack ? { trace: normalized.stack } : {}),
      },
      true,
    );
  }

  private write(
    level: LogLevel,
    context: string,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const normalized = normalizeError(message);
    this.emit(
      {
        timestamp: new Date().toISOString(),
        level,
        context,
        message: normalized.message,
        ...(normalized.stack ? { trace: normalized.stack } : {}),
        ...(optionalParams.length > 0 ? { meta: optionalParams } : {}),
      },
      level === 'error' || level === 'fatal',
    );
  }

  private emit(entry: LogEntry, useStderr = false): void {
    if (LEVEL_PRIORITY[entry.level] > LEVEL_PRIORITY[this.minimumLevel]) {
      return;
    }

    const line = `${JSON.stringify(entry)}\n`;
    (useStderr ? process.stderr : process.stdout).write(line);
  }
}

function normalizeError(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }

  if (typeof value === 'string') {
    return { message: value };
  }

  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}
