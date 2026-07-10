import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { JsonLoggerService } from '../../logging/json-logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = getExceptionMessage(exception);
    const trace = exception instanceof Error ? exception.stack : undefined;

    this.logger.errorEvent(
      'AllExceptionsFilter',
      'http.request.failed',
      {
        method: request.method,
        path: request.originalUrl,
        status_code: status,
        error_code:
          status === HttpStatus.INTERNAL_SERVER_ERROR
            ? 'INTERNAL_SERVER_ERROR'
            : `HTTP_${status}`,
        error_message: message,
      },
      trace,
    );

    response.status(status).json({
      statusCode: status,
      error:
        status === HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal Server Error'
          : HttpStatus[status],
      message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}

function getExceptionMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) {
    return 'Internal server error';
  }

  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }

  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message: unknown }).message;
    return Array.isArray(message) ? message.join(', ') : String(message);
  }

  return exception.message;
}
