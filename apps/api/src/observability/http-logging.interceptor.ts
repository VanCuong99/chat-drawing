import { CallHandler, ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { finalize, type Observable } from 'rxjs';
import { currentRequestId, requestContext } from './request-context';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpRequest');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = requestContext.getStore()?.startedAt ?? performance.now();
    return next.handle().pipe(finalize(() => {
      const span = trace.getActiveSpan()?.spanContext();
      this.logger.log({
        event: 'http.request',
        requestId: currentRequestId(),
        traceId: span?.traceId,
        method: request.method,
        path: request.route?.path ?? request.path,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        responseBytes: Number(response.getHeader('content-length')) || undefined,
      });
    }));
  }
}
