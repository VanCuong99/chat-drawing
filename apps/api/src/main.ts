import './observability/instrumentation';
import 'reflect-metadata';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { json, raw, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { ApiExceptionFilter } from './observability/api-exception.filter';
import { AppModule } from './app.module';
import { SocketIoAdapter } from './realtime/socket-io.adapter';
import { AbuseProtectionMiddleware } from './security/abuse-protection.middleware';
import { RequestContextMiddleware } from './observability/request-context.middleware';
import { configBoolean, configInteger } from './config/runtime-config';
import { RealtimeOutboxService } from './realtime/realtime-outbox.service';

async function bootstrap() {
  const jsonLogs = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ json: jsonLogs, colors: !jsonLogs, maxStringLength: 2_000 }),
  });
  const config = app.get(ConfigService);
  const trustProxyHops = configInteger(config, 'TRUST_PROXY_HOPS', 0, { min: 0, max: 10 });
  if (trustProxyHops > 0) app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  const requestContextMiddleware = app.get(RequestContextMiddleware);
  const abuseProtectionMiddleware = app.get(AbuseProtectionMiddleware);
  const realtimeOutbox = app.get(RealtimeOutboxService);
  app.use(requestContextMiddleware.use.bind(requestContextMiddleware));
  app.use(abuseProtectionMiddleware.use.bind(abuseProtectionMiddleware));
  app.use((_request: Request, _response: Response, next: NextFunction) => {
    const drain = realtimeOutbox.triggerDrain();
    if (process.env.VERCEL) waitUntil(drain);
    next();
  });
  const origin = config.get<string>('WEB_ORIGIN', 'http://localhost:3000');
  const redisUrl = config.get<string>('REDIS_URL');
  if (process.env.NODE_ENV === 'production' && !redisUrl) {
    throw new Error('REDIS_URL is required in production so realtime events remain consistent across instances.');
  }
  const allowedOrigins = origin.split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
  if (!allowedOrigins.length) throw new Error('WEB_ORIGIN must contain at least one absolute origin.');
  for (const allowedOrigin of allowedOrigins) {
    const parsed = new URL(allowedOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== allowedOrigin) {
      throw new Error('Each WEB_ORIGIN value must be an HTTP(S) origin without a path.');
    }
  }
  const socketAdapter = new SocketIoAdapter(app, allowedOrigins, configBoolean(config, 'SOCKET_ALLOW_NO_ORIGIN', false));
  if (redisUrl) await socketAdapter.connect(redisUrl);
  app.useWebSocketAdapter(socketAdapter);
  app.use('/api/assets', raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: '8mb' }));
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.enableCors({
    origin: allowedOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-net-guest-session',
      'x-request-id',
      ...(process.env.NODE_ENV === 'test' ? ['x-forwarded-for', 'x-net-e2e-rate-key'] : []),
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  const server = await app.listen(configInteger(config, 'API_PORT', 3001, { min: 1, max: 65_535 }), '0.0.0.0');
  server.requestTimeout = configInteger(config, 'HTTP_REQUEST_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 });
  server.headersTimeout = configInteger(config, 'HTTP_HEADERS_TIMEOUT_MS', 10_000, { min: 1_000, max: 60_000 });
  server.keepAliveTimeout = configInteger(config, 'HTTP_KEEP_ALIVE_TIMEOUT_MS', 5_000, { min: 1_000, max: 120_000 });
  server.maxRequestsPerSocket = configInteger(config, 'HTTP_MAX_REQUESTS_PER_SOCKET', 1_000, { min: 1, max: 100_000 });
}

void bootstrap();
