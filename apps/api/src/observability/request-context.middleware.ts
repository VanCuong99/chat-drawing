import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const incoming = request.header('x-request-id');
    const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    response.setHeader('x-request-id', requestId);
    requestContext.run({ requestId, startedAt: performance.now() }, next);
  }
}
