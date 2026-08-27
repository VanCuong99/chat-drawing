import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabase, createDatabaseFromPool, type NetDatabase } from '@net/database';
import type { Pool } from 'pg';
import { configInteger } from '../config/runtime-config';
import { telemetry } from '../observability/telemetry';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {
    telemetry.databasePoolTotal.addCallback((result) => result.observe(pool.totalCount));
    telemetry.databasePoolIdle.addCallback((result) => result.observe(pool.idleCount));
    telemetry.databasePoolWaiting.addCallback((result) => result.observe(pool.waitingCount));
  }
  async onApplicationShutdown() { await this.pool.end(); }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createDatabase(
        config.get<string>('DATABASE_URL', 'postgresql://net:net@localhost:5432/net'),
        configInteger(config, 'DATABASE_POOL_MAX', 10, { min: 1, max: 100 }),
        {
          applicationName: config.get<string>('DATABASE_APPLICATION_NAME', 'net-api'),
          connectionTimeoutMs: configInteger(config, 'DATABASE_CONNECTION_TIMEOUT_MS', 5_000, { min: 500, max: 60_000 }),
          idleTimeoutMs: configInteger(config, 'DATABASE_IDLE_TIMEOUT_MS', 30_000, { min: 1_000, max: 600_000 }),
          queryTimeoutMs: configInteger(config, 'DATABASE_QUERY_TIMEOUT_MS', 15_000, { min: 1_000, max: 300_000 }),
          statementTimeoutMs: configInteger(config, 'DATABASE_STATEMENT_TIMEOUT_MS', 10_000, { min: 1_000, max: 300_000 }),
        },
      ).pool,
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): NetDatabase => createDatabaseFromPool(pool),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule {}
