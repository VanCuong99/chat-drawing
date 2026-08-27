import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { trace } from '@opentelemetry/api';
import { currentRequestId } from './request-context';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const message = typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object' && 'message' in payload
        ? Array.isArray(payload.message) ? payload.message[0] : String(payload.message)
        : 'Có lỗi xảy ra. Vui lòng thử lại.';
    if (status >= 500) {
      this.logger.error({
        event: 'http.exception',
        requestId: currentRequestId(),
        traceId: trace.getActiveSpan()?.spanContext().traceId,
        statusCode: status,
        errorType: exception instanceof Error ? exception.name : typeof exception,
        message: exception instanceof Error ? exception.message.slice(0, 500) : 'Unknown error',
      }, exception instanceof Error ? exception.stack : undefined);
    }
    response.status(status).json({ error: message, requestId: currentRequestId() });
  }
}
