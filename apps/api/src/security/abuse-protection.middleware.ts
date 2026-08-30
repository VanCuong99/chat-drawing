import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { telemetry } from '../observability/telemetry';
import { configInteger } from '../config/runtime-config';

type ClientBucket = { tokens: number; updatedAt: number; active: number };

@Injectable()
export class AbuseProtectionMiddleware implements NestMiddleware {
  private readonly clients = new Map<string, ClientBucket>();
  private readonly refillPerMs: number;
  private readonly burst: number;
  private readonly maxActivePerClient: number;
  private readonly maxActiveGlobal: number;
  private readonly maxTrackedClients: number;
  private activeGlobal = 0;
  private lastPrune = 0;

  constructor(config: ConfigService) {
    this.refillPerMs = configInteger(config, 'API_REQUESTS_PER_MINUTE', 600, { min: 1, max: 1_000_000 }) / 60_000;
    this.burst = configInteger(config, 'API_REQUEST_BURST', 120, { min: 1, max: 100_000 });
    this.maxActivePerClient = configInteger(config, 'API_MAX_ACTIVE_PER_IP', 30, { min: 1, max: 10_000 });
    this.maxActiveGlobal = configInteger(config, 'API_MAX_ACTIVE_GLOBAL', 1_000, { min: 1, max: 1_000_000 });
    this.maxTrackedClients = configInteger(config, 'API_MAX_TRACKED_IPS', 50_000, { min: 100, max: 1_000_000 });
  }

  use(request: Request, response: Response, next: NextFunction) {
    const now = Date.now();
    this.prune(now);
    const key = createHash('sha256').update(request.ip ?? request.socket.remoteAddress ?? 'unknown').digest('base64url');
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= this.maxTrackedClients) return this.reject(response, 'tracked_ip_capacity');
      client = { tokens: this.burst, updatedAt: now, active: 0 };
      this.clients.set(key, client);
    }
    client.tokens = Math.min(this.burst, client.tokens + (now - client.updatedAt) * this.refillPerMs);
    client.updatedAt = now;
    if (client.tokens < 1) return this.reject(response, 'token_bucket');
    if (client.active >= this.maxActivePerClient) return this.reject(response, 'client_concurrency');
    if (this.activeGlobal >= this.maxActiveGlobal) return this.reject(response, 'global_concurrency');
    client.tokens -= 1;
    client.active += 1;
    this.activeGlobal += 1;
    telemetry.httpActive.add(1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      client!.active = Math.max(0, client!.active - 1);
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      telemetry.httpActive.add(-1);
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  }

  private reject(response: Response, reason: string) {
    telemetry.httpRejected.add(1, { reason });
    response.setHeader('retry-after', '1');
    response.status(429).json({ error: 'The server is receiving too many requests. Try again later.', requestId: response.getHeader('x-request-id') });
  }

  private prune(now: number) {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [key, client] of this.clients) {
      if (client.active === 0 && now - client.updatedAt > 10 * 60_000) this.clients.delete(key);
    }
  }
}
