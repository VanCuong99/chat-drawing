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
import { RealtimeBrokerService } from './realtime-broker.service';
import { telemetry } from '../observability/telemetry';

const BATCH_SIZE = 50;
const LEASE_MS = 30_000;
const BACKGROUND_MAX_BATCHES = 2;
const MAINTENANCE_MAX_BATCHES = 10;

@Injectable()
export class RealtimeOutboxService {
  private readonly logger = new Logger(RealtimeOutboxService.name);
  private drainPromise: Promise<void> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: NetDatabase,
    private readonly realtime: RealtimeService,
    private readonly broker: RealtimeBrokerService,
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
    let remaining = [...new Set(ids)];
    while (remaining.length) {
      const claimed = await this.claim(remaining);
      if (!claimed.length) return;
      for (const event of claimed) await this.deliver(event);
      const deliveredIds = new Set(claimed.map((event) => event.id));
      remaining = remaining.filter((id) => !deliveredIds.has(id));
    }
  }

  triggerDrain() {
    return this.drain(BACKGROUND_MAX_BATCHES).catch((error) => {
      this.logger.warn({
        event: 'outbox.drain.failed',
        message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown outbox drain error',
      });
    });
  }

  async drainForMaintenance() {
    while (this.drainPromise) await this.drainPromise;
    await this.drain(MAINTENANCE_MAX_BATCHES);
  }

  async drain(maxBatches = BACKGROUND_MAX_BATCHES) {
    if (this.drainPromise) return this.drainPromise;
    const run = (async () => {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const claimed = await this.claim();
        for (const event of claimed) await this.deliver(event);
        if (claimed.length < BATCH_SIZE) break;
      }
    })();
    this.drainPromise = run;
    try {
      await run;
    } finally {
      if (this.drainPromise === run) this.drainPromise = null;
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
        this.db.select({ userId: roomMembers.userId, role: roomMembers.role }).from(roomMembers).where(eq(roomMembers.roomId, event.roomId)),
        this.db.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.roomId, event.roomId), gt(guestSessions.expiresAt, now))),
      ]);
      const payload = { ...event.payload, eventId: event.id };
      const admissionEvent = event.event === 'guest.requested' || event.event === 'guest.request.updated';
      if (admissionEvent) {
        const ownerActorKeys = members.filter((member) => member.role === 'owner').map((owner) => `user:${owner.userId}`);
        for (const actorKey of ownerActorKeys) this.realtime.publishActor(actorKey, event.event as RealtimeEvent, { roomId: event.roomId, ...payload });
        await this.broker.publishActors(ownerActorKeys, event.roomId, event.event as RealtimeEvent, payload);
      } else {
        this.realtime.publish(event.roomId, event.event as RealtimeEvent, payload);
        this.realtime.publishRoomActivity(event.roomId, [
          ...members.map((member) => `user:${member.userId}`),
          ...guests.map((guest) => `guest:${guest.id}`),
        ], event.event as RealtimeEvent, payload);
      }
      if (!admissionEvent) await this.broker.publish(event.roomId, event.event as RealtimeEvent, payload);
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
