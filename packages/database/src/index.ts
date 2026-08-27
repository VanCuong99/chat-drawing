import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export * from './schema';
export { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
export { schema };

export type NetDatabase = NodePgDatabase<typeof schema>;

export type DatabasePoolOptions = {
  applicationName?: string;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  queryTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export function createDatabase(databaseUrl: string, maxConnections = 10, options: DatabasePoolOptions = {}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    application_name: options.applicationName ?? 'net',
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    query_timeout: options.queryTimeoutMs ?? 15_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  });
  return { db: drizzle(pool, { schema }), pool };
}

export function createDatabaseFromPool(pool: Pool) {
  return drizzle(pool, { schema });
}
