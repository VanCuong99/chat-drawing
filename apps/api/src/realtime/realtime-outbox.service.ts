import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gt,
  guestSessions,
  inArray,
  isNull,
  lt,
  lte,
  or,
  realtimeOutbox,
  roomMembers,
  sql,
  type NetDatabase,
} from '@net/database';
import { DATABASE } from '../database/database.module';
import { RealtimeService, type RealtimeEvent } from './realtime.service';
import { telemetry } from '../observability/telemetry';

const BATCH_SIZE = 50;
const LEASE_MS = 30_000;

@Injectable()
export class RealtimeOutboxService {
  private readonly logger = new Logger(RealtimeOutboxService.name);
  private draining = false;

  constructor(
    @Inject(DATABASE) private readonly db: NetDatabase,
    private readonly realtime: RealtimeService,
  ) {
    telemetry.outboxPending.addCallback(async (result) => {
      const [row] = await this.db.select({
        count: sql<number>`count(*)::int`,
        oldest: sql<number | null>`min(${realtimeOutbox.createdAt})`,
      }).from(realtimeOutbox).where(isNull(realtimeOutbox.publishedAt));
      result.observe(Number(row?.count ?? 0));
    });
    telemetry.outboxOldestAge.addCallback(async (result) => {
      const [row] = await this.db.select({ oldest: sql<number | null>`min(${realtimeOutbox.createdAt})` })
        .from(realtimeOutbox).where(isNull(realtimeOutbox.publishedAt));
      if (row?.oldest !== null && row?.oldest !== undefined) result.observe(Math.max(0, Date.now() - Number(row.oldest)));
    });
  }

  async enqueue(executor: NetDatabase, roomId: string, event: RealtimeEvent, payload: Record<string, unknown>) {
    const now = Date.now();
    const [row] = await executor.insert(realtimeOutbox).values({ roomId, event, payload, createdAt: now, availableAt: now }).returning({ id: realtimeOutbox.id });
    return row.id;
  }

  async deliverIds(ids: string[]) {
    if (!ids.length) return;
    await this.drain(ids);
  }

  async drain(onlyIds?: string[]) {
    if (this.draining || !this.realtime.isReady()) return;
    this.draining = true;
    try {
      const claimed = await this.claim(onlyIds);
      for (const event of claimed) await this.deliver(event);
    } finally {
      this.draining = false;
    }
  }

  async cleanup() {
    await this.db.delete(realtimeOutbox).where(and(
      lt(realtimeOutbox.publishedAt, Date.now() - 24 * 60 * 60 * 1000),
    ));
  }

  private async claim(onlyIds?: string[]) {
    const now = Date.now();
    const workerId = crypto.randomUUID();
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(realtimeOutbox).where(and(
        isNull(realtimeOutbox.publishedAt),
        lte(realtimeOutbox.availableAt, now),
        or(isNull(realtimeOutbox.lockedUntil), lt(realtimeOutbox.lockedUntil, now)),
        onlyIds?.length ? inArray(realtimeOutbox.id, onlyIds) : undefined,
      )).orderBy(asc(realtimeOutbox.createdAt)).limit(BATCH_SIZE).for('update', { skipLocked: true });
      if (!rows.length) return [];
      await tx.update(realtimeOutbox).set({
        workerId,
        lockedUntil: now + LEASE_MS,
      }).where(inArray(realtimeOutbox.id, rows.map((row) => row.id)));
      return rows.map((row) => ({ ...row, workerId }));
    });
  }

  private async deliver(event: typeof realtimeOutbox.$inferSelect & { workerId: string }) {
    try {
      const now = Date.now();
      const [members, guests] = await Promise.all([
        this.db.select({ userId: roomMembers.userId }).from(roomMembers).where(eq(roomMembers.roomId, event.roomId)),
        this.db.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.roomId, event.roomId), gt(guestSessions.expiresAt, now))),
      ]);
      const payload = { ...event.payload, eventId: event.id };
      this.realtime.publish(event.roomId, event.event as RealtimeEvent, payload);
      this.realtime.publishRoomActivity(event.roomId, [
        ...members.map((member) => `user:${member.userId}`),
        ...guests.map((guest) => `guest:${guest.id}`),
      ], event.event as RealtimeEvent, payload);
      await this.db.update(realtimeOutbox).set({
        publishedAt: Date.now(),
        lockedUntil: null,
        workerId: null,
        attempts: event.attempts + 1,
        lastError: null,
      }).where(and(eq(realtimeOutbox.id, event.id), eq(realtimeOutbox.workerId, event.workerId)));
      telemetry.outboxDelivered.add(1, { event: event.event });
    } catch (error) {
      const attempts = event.attempts + 1;
      const delay = Math.min(60_000, 500 * 2 ** Math.min(attempts, 7));
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown realtime delivery error';
      this.logger.warn({ eventId: event.id, roomId: event.roomId, attempts, message });
      telemetry.outboxFailed.add(1, { event: event.event });
      await this.db.update(realtimeOutbox).set({
        availableAt: Date.now() + delay,
        lockedUntil: null,
        workerId: null,
        attempts,
        lastError: message,
      }).where(and(eq(realtimeOutbox.id, event.id), eq(realtimeOutbox.workerId, event.workerId)));
    }
  }
}
