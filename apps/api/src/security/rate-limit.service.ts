import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lt, rateLimits, sql, type NetDatabase } from '@net/database';
import { DATABASE } from '../database/database.module';
import { telemetry } from '../observability/telemetry';

@Injectable()
export class RateLimitService {
  constructor(@Inject(DATABASE) private readonly db: NetDatabase) {}

  async consume(scope: string, subject: string, limit: number, windowMs: number) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const key = `${scope}:${createHash('sha256').update(subject).digest('base64url')}`;
    const [row] = await this.db.insert(rateLimits).values({ key, windowStartedAt: now, count: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          windowStartedAt: sql<number>`case when ${rateLimits.windowStartedAt} <= ${cutoff} then ${now} else ${rateLimits.windowStartedAt} end`,
          count: sql<number>`case when ${rateLimits.windowStartedAt} <= ${cutoff} then 1 else ${rateLimits.count} + 1 end`,
          updatedAt: now,
        },
      })
      .returning({ count: rateLimits.count, windowStartedAt: rateLimits.windowStartedAt });
    if (row.count > limit) {
      telemetry.durableRateLimited.add(1, { scope });
      const retryAfterSeconds = Math.max(1, Math.ceil((row.windowStartedAt + windowMs - now) / 1000));
      throw new HttpException(`Actions are being sent too quickly. Try again in ${retryAfterSeconds} seconds.`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async cleanup() {
    await this.db.delete(rateLimits).where(lt(rateLimits.updatedAt, Date.now() - 24 * 60 * 60 * 1000));
  }
}
