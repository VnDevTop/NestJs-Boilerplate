import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiErrorResponse } from '../interfaces/index.js';

interface HttpExceptionResponseBody {
  message?: string | string[];
  error?: string;
  statusCode?: number;
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();

    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const body = this.normalizeExceptionResponse(exceptionResponse, statusCode);

    const errorResponse: ApiErrorResponse = {
      success: false,
      statusCode,
      message: body.message ?? exception.message,
      error: body.error ?? HttpStatus[statusCode],
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    // A 429 that says how long to wait is a client that waits. Without the header
    // the number has nowhere to go, because the body deliberately leaves it out:
    // telling an attacker how long its guess has left is a progress bar.
    if (statusCode === HttpStatus.TOO_MANY_REQUESTS) {
      const retryAfter = (exception as { retryAfterSeconds?: unknown })
        .retryAfterSeconds;

      if (typeof retryAfter === 'number' && retryAfter > 0) {
        response.header('Retry-After', String(Math.ceil(retryAfter)));
      }
    }

    response.status(statusCode).send(errorResponse);
  }

  private normalizeExceptionResponse(
    exceptionResponse: string | object,
    statusCode: number,
  ): HttpExceptionResponseBody {
    if (typeof exceptionResponse === 'string') {
      return {
        message: exceptionResponse,
        statusCode,
      };
    }

    return exceptionResponse as HttpExceptionResponseBody;
  }
}
