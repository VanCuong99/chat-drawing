import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  and,
  asc,
  assets,
  desc,
  eq,
  gt,
  guestSessions,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  messages,
  ne,
  or,
  reactions,
  realtimeOutbox,
  roomMembers,
  rooms,
  sql,
  users,
  type NetDatabase,
} from '@net/database';
import type { Actor } from '../auth/actor.types';
import { DATABASE } from '../database/database.module';
import { ActorService } from '../auth/actor.service';
import { AssetsService } from '../assets/assets.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service';

const EMOJIS = ['❤️', '👍', '✨', '😂', '👀'];
const EMPTY_GUEST_ROOM_GRACE_MS = 5 * 60 * 1000;
const ABANDONED_GUEST_ROOM_BATCH = 10;

@Injectable()
export class ChatService {
  constructor(
    @Inject(DATABASE) private readonly db: NetDatabase,
    private readonly actors: ActorService,
    private readonly assetService: AssetsService,
    private readonly realtime: RealtimeService,
    private readonly outbox: RealtimeOutboxService,
  ) {}

  async bootstrap(actor: Actor | null) {
    if (!actor) return { actor: null, rooms: [] };
    if (actor.kind === 'user') await this.seedFirstRoom(actor);
    return {
      actor: { kind: actor.kind, id: actor.id, displayName: actor.displayName, email: actor.email ?? undefined, expiresAt: actor.expiresAt ?? undefined },
      rooms: await this.listRooms(actor),
    };
  }

  async listRooms(actor: Actor) {
    const accessRows = actor.kind === 'user'
      ? await this.db.select({ roomId: roomMembers.roomId, lastReadSequence: roomMembers.lastReadSequence }).from(roomMembers).where(eq(roomMembers.userId, actor.id))
      : await this.db.select({ roomId: guestSessions.roomId, lastReadSequence: guestSessions.lastReadSequence }).from(guestSessions).where(eq(guestSessions.id, actor.id));
    const roomIds = accessRows.map((row) => row.roomId);
    if (!roomIds.length) return [];
    const activeMessageCondition = or(isNull(messages.expiresAt), gt(messages.expiresAt, Date.now()));
    const ownMessageCondition = actor.kind === 'user'
      ? or(isNull(messages.senderId), ne(messages.senderId, actor.id))
      : or(isNull(messages.guestSessionId), ne(messages.guestSessionId, actor.id));
    const unreadQuery = actor.kind === 'user'
      ? this.db.select({ roomId: messages.roomId, count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(roomMembers, and(
          eq(roomMembers.roomId, messages.roomId),
          eq(roomMembers.userId, actor.id),
          gt(messages.sequence, roomMembers.lastReadSequence),
        ))
        .where(and(inArray(messages.roomId, roomIds), activeMessageCondition, ownMessageCondition))
        .groupBy(messages.roomId)
      : this.db.select({ roomId: messages.roomId, count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(guestSessions, and(
          eq(guestSessions.roomId, messages.roomId),
          eq(guestSessions.id, actor.id),
          gt(messages.sequence, guestSessions.lastReadSequence),
        ))
        .where(and(inArray(messages.roomId, roomIds), activeMessageCondition, ownMessageCondition))
        .groupBy(messages.roomId);
    const [roomRows, latest, unreadRows, statisticRows, counterpartRows] = await Promise.all([
      this.db.select().from(rooms).where(inArray(rooms.id, roomIds)),
      this.db.selectDistinctOn([messages.roomId], {
        roomId: messages.roomId,
        type: messages.type,
        body: messages.body,
        createdAt: messages.createdAt,
      }).from(messages).where(and(inArray(messages.roomId, roomIds), activeMessageCondition))
        .orderBy(messages.roomId, desc(messages.sequence)),
      unreadQuery,
      this.db.select({
        roomId: messages.roomId,
        messageCount: sql<number>`count(*)::int`,
        mediaCount: sql<number>`count(*) filter (where ${messages.assetKey} is not null)::int`,
      }).from(messages)
        .where(and(inArray(messages.roomId, roomIds), activeMessageCondition))
        .groupBy(messages.roomId),
      actor.kind === 'user'
        ? this.db.select({ roomId: roomMembers.roomId, displayName: users.displayName })
          .from(roomMembers)
          .innerJoin(users, eq(users.id, roomMembers.userId))
          .where(and(inArray(roomMembers.roomId, roomIds), ne(roomMembers.userId, actor.id)))
        : Promise.resolve([]),
    ]);
    const latestByRoom = new Map(latest.map((message) => [message.roomId, message]));
    const unreadByRoom = new Map(unreadRows.map((row) => [row.roomId, row.count]));
    const statisticsByRoom = new Map(statisticRows.map((row) => [row.roomId, row]));
    const counterpartByRoom = new Map(counterpartRows.map((row) => [row.roomId, row.displayName]));
    return roomRows.map((room) => {
      const last = latestByRoom.get(room.id);
      const preview = !last ? 'Start a new conversation'
        : last.type === 'canvas' ? 'Sent a drawing'
          : last.type === 'image' ? 'Sent an image'
            : last.body ?? 'New message';
      const statistics = statisticsByRoom.get(room.id);
      return {
        ...room,
        name: room.kind === 'direct' ? counterpartByRoom.get(room.id) ?? room.name : room.name,
        preview,
        lastActivity: last?.createdAt ?? room.createdAt,
        unreadCount: unreadByRoom.get(room.id) ?? 0,
        messageCount: statistics?.messageCount ?? 0,
        mediaCount: statistics?.mediaCount ?? 0,
      };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async inspectInvite(inviteCodeInput: unknown) {
    const inviteCode = this.requireText(inviteCodeInput, 'Invite code', 4, 60);
    const [room] = await this.db.select({ allowGuests: rooms.allowGuests, kind: rooms.kind }).from(rooms)
      .where(eq(rooms.inviteCode, inviteCode)).limit(1);
    if (!room || room.kind === 'direct') throw new NotFoundException('The invite link is invalid or has expired.');
    return { valid: true, guestAllowed: room.allowGuests };
  }

  async createGuest(displayNameInput: unknown, inviteCodeInput?: unknown) {
    const displayName = this.requireText(displayNameInput, 'Display name', 2, 60);
    const inviteCode = typeof inviteCodeInput === 'string' ? inviteCodeInput.trim() : '';
    const now = Date.now();
    const expiresAt = this.actors.guestTtl();
    const [candidate] = inviteCode
      ? await this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.inviteCode, inviteCode)).limit(1)
      : [];
    if (inviteCode && !candidate) throw new NotFoundException('The invite link is invalid or the room does not accept guests.');
    return this.db.transaction(async (tx) => {
      let room: typeof rooms.$inferSelect;
      if (candidate) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.id}, 0))`);
        const [availableRoom] = await tx.select().from(rooms)
          .where(and(
            eq(rooms.id, candidate.id),
            eq(rooms.inviteCode, inviteCode),
            eq(rooms.allowGuests, true),
            ne(rooms.kind, 'direct'),
          )).limit(1);
        if (!availableRoom) throw new NotFoundException('The invite link is invalid or the room does not accept guests.');
        room = availableRoom;
      } else {
        [room] = await tx.insert(rooms).values({ name: `${displayName}'s Session`, kind: 'guest', inviteCode: this.makeCode(), allowGuests: true, createdAt: now }).returning();
      }
      const [session] = await tx.insert(guestSessions).values({ roomId: room.id, displayName, createdAt: now, lastSeenAt: now, expiresAt }).returning();
      const [firstMessage] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.roomId, room.id)).limit(1);
      if (!firstMessage) {
        await tx.insert(messages).values({
          roomId: room.id,
          guestSessionId: session.id,
          senderName: 'Nét',
          type: 'system',
          body: 'The guest session started. When it ends, the guest loses access but submitted content remains in the room.',
          createdAt: now + 1,
          expiresAt: null,
        });
      }
      return { sessionId: session.id, expiresAt, roomId: room.id, roomName: room.name };
    });
  }

  async endGuest(actor: Actor) {
    if (actor.kind !== 'guest') throw new UnauthorizedException('The guest session is no longer valid.');
    const retained = await this.endGuestById(actor.id);
    return { ok: true, retained };
  }

  async endGuestById(guestId: string) {
    const ended = await this.db.transaction(async (tx) => {
      const [candidate] = await tx.select({ roomId: guestSessions.roomId }).from(guestSessions)
        .where(eq(guestSessions.id, guestId)).limit(1);
      if (!candidate) return null;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.roomId}, 0))`);
      const [guest] = await tx.select().from(guestSessions).where(eq(guestSessions.id, guestId)).for('update').limit(1);
      if (!guest) return null;
      const assetRows = await tx.select({ key: assets.key, status: assets.status }).from(assets)
        .where(eq(assets.guestSessionId, guestId));
      const removedReactions = await tx.select({ messageId: reactions.messageId, emoji: reactions.emoji }).from(reactions)
        .where(eq(reactions.actorKey, `guest:${guestId}`));
      const disposableAssets = assetRows.filter((asset) => asset.status !== 'attached');
      if (disposableAssets.length) {
        await tx.update(assets).set({ status: 'deleting' }).where(and(
          eq(assets.guestSessionId, guestId),
          inArray(assets.key, disposableAssets.map((asset) => asset.key)),
        ));
      }
      await tx.update(assets).set({
        guestSessionId: null,
        ownerKey: `retained-guest:${guestId}`,
        expiresAt: null,
      }).where(and(eq(assets.guestSessionId, guestId), eq(assets.status, 'attached')));
      await tx.update(messages).set({ guestSessionId: null, expiresAt: null }).where(eq(messages.guestSessionId, guestId));
      const outboxId = await this.outbox.enqueue(tx, guest.roomId, 'guest.ended', {
        guestSessionId: guestId,
        retained: true,
        messageIds: [],
        removedReactions,
      });
      await tx.delete(reactions).where(eq(reactions.actorKey, `guest:${guestId}`));
      await tx.delete(guestSessions).where(eq(guestSessions.id, guestId));
      return { guest, disposableAssets, outboxId };
    });
    if (!ended) return false;
    await this.outbox.deliverIds([ended.outboxId]);
    await this.assetService.deleteKeys(ended.disposableAssets.map((asset) => asset.key));
    this.realtime.disconnectActor(`guest:${guestId}`);
    return true;
  }

  async searchUsers(actor: Actor, queryInput: unknown) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to find members.');
    const query = typeof queryInput === 'string' ? queryInput.trim().replaceAll('%', '').replaceAll('_', '') : '';
    if (query.length < 2) return { users: [] };
    const rows = await this.db.select({ id: users.id, displayName: users.displayName, email: users.email, avatarColor: users.avatarColor })
      .from(users).where(and(
        or(ilike(users.displayName, `%${query}%`), ilike(users.email, `%${query}%`)),
        // The current user is filtered in application code to keep the query expression typed.
      )).orderBy(asc(users.displayName)).limit(13);
    return { users: rows.filter((user) => user.id !== actor.id).slice(0, 12).map((user) => ({ ...user, email: this.maskEmail(user.email) })) };
  }

  async createRoom(actor: Actor, body: { name?: unknown; allowGuests?: boolean; memberIds?: unknown[] }) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to create a persistent conversation.');
    const memberIds = [...new Set((body.memberIds ?? []).filter((id): id is string => typeof id === 'string' && id !== actor.id))].slice(0, 20);
    const members = memberIds.length ? await this.db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, memberIds)) : [];
    if (members.length !== memberIds.length) throw new BadRequestException('One of the selected members is no longer available.');
    const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
    const suggestedName = members.length === 1
      ? `${actor.displayName} & ${members[0].displayName}`
      : requestedName || (members.length > 1 ? `Group: ${members.slice(0, 3).map((member) => member.displayName).join(', ')}`.slice(0, 60) : body.name);
    const name = this.requireText(suggestedName, 'Conversation name', 2, 60);
    const inviteCode = this.makeCode();
    const now = Date.now();
    const created = await this.db.transaction(async (tx) => {
      if (memberIds.length === 1) {
        const directKey = [actor.id, memberIds[0]].sort().join(':');
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`direct:${directKey}`}, 0))`);
        const [actorRooms, targetRooms] = await Promise.all([
          tx.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, actor.id)),
          tx.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, memberIds[0])),
        ]);
        const targetRoomIds = new Set(targetRooms.map((row) => row.roomId));
        const sharedRoomIds = actorRooms.map((row) => row.roomId).filter((roomId) => targetRoomIds.has(roomId));
        if (sharedRoomIds.length) {
          const [directRooms, memberCounts] = await Promise.all([
            tx.select({ id: rooms.id, inviteCode: rooms.inviteCode }).from(rooms).where(and(inArray(rooms.id, sharedRoomIds), eq(rooms.kind, 'direct'))),
            tx.select({ roomId: roomMembers.roomId, count: sql<number>`count(*)::int` }).from(roomMembers)
              .where(inArray(roomMembers.roomId, sharedRoomIds)).groupBy(roomMembers.roomId),
          ]);
          const memberCountByRoom = new Map(memberCounts.map((row) => [row.roomId, row.count]));
          const existing = directRooms.find((room) => memberCountByRoom.get(room.id) === 2);
          if (existing) {
            await tx.update(rooms).set({ allowGuests: false }).where(eq(rooms.id, existing.id));
            return { roomId: existing.id, inviteCode: existing.inviteCode, outboxId: null, reused: true };
          }
        }
      }
      const kind = memberIds.length === 1 ? 'direct' : 'group';
      const [room] = await tx.insert(rooms).values({ name, kind, createdBy: actor.id, inviteCode, allowGuests: kind === 'direct' ? false : body.allowGuests !== false, createdAt: now }).returning({ id: rooms.id });
      await tx.insert(roomMembers).values([
        { roomId: room.id, userId: actor.id, role: 'owner', joinedAt: now },
        ...memberIds.map((userId) => ({ roomId: room.id, userId, role: 'member' as const, joinedAt: now })),
      ]);
      const outboxId = await this.outbox.enqueue(tx, room.id, 'room.updated', { memberIds: [actor.id, ...memberIds] });
      return { roomId: room.id, inviteCode, outboxId, reused: false };
    });
    if (created.outboxId) await this.outbox.deliverIds([created.outboxId]);
    return { id: created.roomId, inviteCode: created.inviteCode, reused: created.reused };
  }

  async joinRoom(actor: Actor, inviteCodeInput: unknown) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to join with an account.');
    const inviteCode = this.requireText(inviteCodeInput, 'Invite code', 4, 60);
    const [room] = await this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.inviteCode, inviteCode)).limit(1);
    if (!room) throw new NotFoundException('No conversation was found for this invite link.');
    const outboxId = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${room.id}, 0))`);
      const [availableRoom] = await tx.select({ id: rooms.id, kind: rooms.kind }).from(rooms)
        .where(and(eq(rooms.id, room.id), eq(rooms.inviteCode, inviteCode))).limit(1);
      if (!availableRoom) throw new NotFoundException('The conversation no longer exists.');
      if (availableRoom.kind === 'direct') {
        const [existingMember] = await tx.select({ roomId: roomMembers.roomId }).from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, actor.id))).limit(1);
        if (!existingMember) throw new NotFoundException('No conversation was found for this invite link.');
        return null;
      }
      await tx.insert(roomMembers).values({ roomId: room.id, userId: actor.id, role: 'member', joinedAt: Date.now() })
        .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.userId] });
      await tx.update(messages).set({ expiresAt: null }).where(and(
        eq(messages.roomId, room.id),
        isNotNull(messages.guestSessionId),
      ));
      await tx.update(assets).set({ expiresAt: null }).where(and(
        eq(assets.roomId, room.id),
        isNotNull(assets.guestSessionId),
        eq(assets.status, 'attached'),
      ));
      return this.outbox.enqueue(tx, room.id, 'room.updated', { memberId: actor.id });
    });
    if (outboxId) await this.outbox.deliverIds([outboxId]);
    return { roomId: room.id };
  }

  async listMessages(roomId: string, actor: Actor, limitInput?: unknown, cursorInput?: unknown, queryInput?: unknown) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const limit = Math.min(100, Math.max(20, Number(limitInput) || 80));
    const query = typeof queryInput === 'string'
      ? queryInput.trim().replaceAll('%', '').replaceAll('_', '').slice(0, 80)
      : '';
    const beforeSequence = Number(cursorInput);
    const cursorCondition = !query && Number.isSafeInteger(beforeSequence) && beforeSequence > 0 ? lt(messages.sequence, beforeSequence) : undefined;
    const queryCondition = query
      ? or(ilike(messages.senderName, `%${query}%`), ilike(messages.body, `%${query}%`))
      : undefined;
    const messageCondition = and(
      eq(messages.roomId, roomId),
      or(isNull(messages.expiresAt), gt(messages.expiresAt, now)),
      cursorCondition,
      queryCondition,
    );
    const [rows, totalRows] = await Promise.all([
      this.db.select().from(messages).where(messageCondition).orderBy(desc(messages.sequence)).limit(limit),
      query
        ? this.db.select({ count: sql<number>`count(*)::int` }).from(messages).where(messageCondition)
        : Promise.resolve([]),
    ]);
    rows.reverse();
    const messageIds = rows.map((message) => message.id);
    const [reactionRows, memberReaders, guestReaders] = await Promise.all([
      messageIds.length ? this.db.select().from(reactions).where(and(inArray(reactions.messageId, messageIds), or(isNull(reactions.expiresAt), gt(reactions.expiresAt, now)))) : [],
      this.db.select({ userId: roomMembers.userId, lastReadSequence: roomMembers.lastReadSequence }).from(roomMembers).where(eq(roomMembers.roomId, roomId)),
      this.db.select({ id: guestSessions.id, lastReadSequence: guestSessions.lastReadSequence }).from(guestSessions).where(and(eq(guestSessions.roomId, roomId), gt(guestSessions.expiresAt, now))),
    ]);
    const reactionMap = new Map<string, Map<string, { count: number; reacted: boolean }>>();
    for (const reaction of reactionRows) {
      const byEmoji = reactionMap.get(reaction.messageId) ?? new Map();
      const current = byEmoji.get(reaction.emoji) ?? { count: 0, reacted: false };
      current.count += 1;
      current.reacted ||= reaction.actorKey === actor.actorKey;
      byEmoji.set(reaction.emoji, current);
      reactionMap.set(reaction.messageId, byEmoji);
    }
    const output = await Promise.all(rows.map(async (message) => ({
      ...message,
      assetUrl: message.assetKey ? await this.assetService.issueReadUrl(message.assetKey, roomId, actor) : null,
      reactions: [...(reactionMap.get(message.id)?.entries() ?? [])].map(([emoji, value]) => ({ emoji, ...value })),
      readCount: memberReaders.filter((reader) => reader.userId !== message.senderId && this.hasRead(reader, message)).length
        + guestReaders.filter((reader) => reader.id !== message.guestSessionId && this.hasRead(reader, message)).length,
    })));
    const oldest = output[0];
    return {
      messages: output,
      readAt: now,
      nextCursor: !query && output.length === limit && oldest ? String(oldest.sequence) : null,
      totalCount: query ? totalRows[0]?.count ?? 0 : null,
    };
  }

  async sendMessage(roomId: string, actor: Actor, body: { type?: string; text?: unknown; assetKey?: string; replyToId?: string | null; canvasParentId?: string | null; clientRequestId?: string }) {
    await this.actors.assertRoomAccess(roomId, actor);
    if (!['text', 'image', 'canvas'].includes(body.type ?? '')) throw new BadRequestException('The message type is invalid.');
    const type = body.type as 'text' | 'image' | 'canvas';
    const text = body.text ? this.requireText(body.text, 'Content', 1, 2000) : null;
    if (type === 'text' && !text) throw new BadRequestException('Messages cannot be empty.');
    if ((type === 'image' || type === 'canvas') && !body.assetKey) throw new BadRequestException('Image content is missing.');
    const clientRequestId = typeof body.clientRequestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientRequestId)
      ? body.clientRequestId
      : null;
    if (body.clientRequestId && !clientRequestId) throw new BadRequestException('The duplicate-prevention key is invalid.');
    const idempotencyInput = {
      type,
      body: text,
      assetKey: body.assetKey ?? null,
      replyToId: body.replyToId ?? null,
      canvasParentId: body.canvasParentId ?? null,
    };
    if (clientRequestId) {
      const existing = await this.findIdempotentMessage(clientRequestId, roomId, actor, idempotencyInput);
      if (existing) return existing;
    }
    if (body.assetKey) await this.assetService.assertPending(body.assetKey, roomId, actor);
    if (body.replyToId) {
      const [reply] = await this.db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.replyToId), eq(messages.roomId, roomId))).limit(1);
      if (!reply) throw new BadRequestException('The replied-to message no longer exists.');
    }
    let canvasVersion: number | null = null;
    if (type === 'canvas') {
      if (body.canvasParentId) {
        const [parent] = await this.db.select({ version: messages.canvasVersion }).from(messages)
          .where(and(eq(messages.id, body.canvasParentId), eq(messages.roomId, roomId), eq(messages.type, 'canvas'))).limit(1);
        if (!parent) throw new BadRequestException('The original drawing no longer exists.');
        canvasVersion = (parent.version ?? 1) + 1;
      } else canvasVersion = 1;
    }
    const now = Date.now();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`);
      const guestContentExpiresAt = null;
      if (clientRequestId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${clientRequestId}, 0))`);
        const [existing] = await tx.select({
          id: messages.id,
          roomId: messages.roomId,
          senderId: messages.senderId,
          guestSessionId: messages.guestSessionId,
          sequence: messages.sequence,
          createdAt: messages.createdAt,
          canvasVersion: messages.canvasVersion,
          type: messages.type,
          body: messages.body,
          assetKey: messages.assetKey,
          replyToId: messages.replyToId,
          canvasParentId: messages.canvasParentId,
        }).from(messages).where(eq(messages.clientRequestId, clientRequestId)).limit(1);
        if (existing) return { ...this.assertIdempotentMessage(existing, roomId, actor, idempotencyInput), outboxId: null };
      }
      if (actor.kind === 'guest') {
        const [valid] = await tx.select({ id: guestSessions.id }).from(guestSessions)
          .where(and(eq(guestSessions.id, actor.id), eq(guestSessions.roomId, roomId), gt(guestSessions.expiresAt, now))).for('update').limit(1);
        if (!valid) throw new UnauthorizedException('The guest session ended before the message was sent.');
      }
      if (body.assetKey) {
        const attached = await tx.update(assets).set({ status: 'attached', expiresAt: guestContentExpiresAt }).where(and(
          eq(assets.key, body.assetKey), eq(assets.roomId, roomId), eq(assets.ownerKey, actor.actorKey), eq(assets.status, 'pending'),
        )).returning({ key: assets.key });
        if (!attached.length) throw new BadRequestException('The image has already been used by another message.');
      }
      const [inserted] = await tx.insert(messages).values({
        roomId,
        senderId: actor.kind === 'user' ? actor.id : null,
        guestSessionId: actor.kind === 'guest' ? actor.id : null,
        senderName: actor.displayName,
        type,
        body: text,
        assetKey: body.assetKey ?? null,
        replyToId: body.replyToId ?? null,
        canvasParentId: body.canvasParentId ?? null,
        canvasVersion,
        clientRequestId,
        createdAt: now,
        expiresAt: guestContentExpiresAt,
      }).returning({ id: messages.id, sequence: messages.sequence, createdAt: messages.createdAt, canvasVersion: messages.canvasVersion });
      const outboxId = await this.outbox.enqueue(tx, roomId, 'message.created', { messageId: inserted.id, sequence: inserted.sequence });
      return { ...inserted, outboxId };
    });
    if (result.outboxId) await this.outbox.deliverIds([result.outboxId]);
    return { id: result.id, sequence: result.sequence, createdAt: result.createdAt, canvasVersion: result.canvasVersion };
  }

  async markRead(roomId: string, actor: Actor, messageIdInput: unknown) {
    await this.actors.assertRoomAccess(roomId, actor);
    const messageId = typeof messageIdInput === 'string' ? messageIdInput : '';
    const [target] = await this.db.select({ id: messages.id, createdAt: messages.createdAt, sequence: messages.sequence }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.roomId, roomId))).limit(1);
    if (!target) throw new BadRequestException('The last-read message is invalid.');
    const outboxId = await this.db.transaction(async (tx) => {
      const advanced = actor.kind === 'user'
        ? await tx.update(roomMembers).set({ lastReadSequence: target.sequence }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id), lt(roomMembers.lastReadSequence, target.sequence))).returning({ roomId: roomMembers.roomId })
        : await tx.update(guestSessions).set({ lastReadSequence: target.sequence }).where(and(eq(guestSessions.id, actor.id), eq(guestSessions.roomId, roomId), gt(guestSessions.expiresAt, Date.now()), lt(guestSessions.lastReadSequence, target.sequence))).returning({ roomId: guestSessions.roomId });
      return advanced.length
        ? this.outbox.enqueue(tx, roomId, 'messages.read', { actorKey: actor.actorKey, readAt: target.createdAt, messageId: target.id, sequence: target.sequence })
        : null;
    });
    if (outboxId) await this.outbox.deliverIds([outboxId]);
    return { readAt: target.createdAt, messageId: target.id, sequence: target.sequence };
  }

  async toggleReaction(messageId: string, actor: Actor, emoji: string) {
    if (!EMOJIS.includes(emoji)) throw new BadRequestException('The reaction is invalid.');
    const [message] = await this.db.select({ roomId: messages.roomId }).from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!message) throw new NotFoundException('The message no longer exists.');
    await this.actors.assertRoomAccess(message.roomId, actor);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${messageId}:${actor.actorKey}:${emoji}`}, 0))`);
      if (actor.kind === 'guest') {
        const [valid] = await tx.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.id, actor.id), gt(guestSessions.expiresAt, Date.now()))).for('update').limit(1);
        if (!valid) throw new UnauthorizedException('The guest session has ended.');
      }
      const [existing] = await tx.select({ messageId: reactions.messageId }).from(reactions)
        .where(and(eq(reactions.messageId, messageId), eq(reactions.actorKey, actor.actorKey), eq(reactions.emoji, emoji))).limit(1);
      let reacted: boolean;
      if (existing) {
        await tx.delete(reactions).where(and(eq(reactions.messageId, messageId), eq(reactions.actorKey, actor.actorKey), eq(reactions.emoji, emoji)));
        reacted = false;
      } else {
        await tx.insert(reactions).values({ messageId, actorKey: actor.actorKey, emoji, createdAt: Date.now(), expiresAt: actor.kind === 'guest' ? actor.expiresAt : null });
        reacted = true;
      }
      const [reactionCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(reactions)
        .where(and(eq(reactions.messageId, messageId), eq(reactions.emoji, emoji), or(isNull(reactions.expiresAt), gt(reactions.expiresAt, Date.now()))));
      const count = reactionCount?.count ?? 0;
      const outboxId = await this.outbox.enqueue(tx, message.roomId, 'reaction.updated', {
        messageId,
        emoji,
        actorKey: actor.actorKey,
        reacted,
        count,
      });
      return { reacted, count, outboxId };
    });
    await this.outbox.deliverIds([result.outboxId]);
    return { reacted: result.reacted, count: result.count };
  }

  async cleanupExpiredGuests() {
    const now = Date.now();
    const expired = await this.db.select({ id: guestSessions.id }).from(guestSessions).where(lt(guestSessions.expiresAt, now)).limit(30);
    for (const guest of expired) await this.endGuestById(guest.id);
    const abandonedRoomCandidates = await this.db.select({ id: rooms.id }).from(rooms).where(and(
      eq(rooms.kind, 'guest'),
      lt(rooms.createdAt, now - EMPTY_GUEST_ROOM_GRACE_MS),
      sql`not exists (select 1 from ${roomMembers} where ${roomMembers.roomId} = ${rooms.id})`,
      sql`not exists (select 1 from ${guestSessions} where ${guestSessions.roomId} = ${rooms.id})`,
      sql`not exists (select 1 from ${messages} where ${messages.roomId} = ${rooms.id} and ${messages.type} <> 'system')`,
      sql`not exists (select 1 from ${assets} where ${assets.roomId} = ${rooms.id})`,
    )).orderBy(asc(rooms.createdAt)).limit(ABANDONED_GUEST_ROOM_BATCH);
    for (const candidate of abandonedRoomCandidates) {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.id}, 0))`);
        const [room, member, activeGuest, remainingMessage, remainingAsset, latestGuestEnd] = await Promise.all([
          tx.select({ id: rooms.id, createdAt: rooms.createdAt }).from(rooms).where(and(
            eq(rooms.id, candidate.id),
            eq(rooms.kind, 'guest'),
            lt(rooms.createdAt, now - EMPTY_GUEST_ROOM_GRACE_MS),
          )).limit(1),
          tx.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.roomId, candidate.id)).limit(1),
          tx.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.roomId, candidate.id)).limit(1),
          tx.select({ id: messages.id }).from(messages).where(and(eq(messages.roomId, candidate.id), ne(messages.type, 'system'))).limit(1),
          tx.select({ key: assets.key }).from(assets).where(eq(assets.roomId, candidate.id)).limit(1),
          tx.select({ createdAt: realtimeOutbox.createdAt }).from(realtimeOutbox).where(and(
            eq(realtimeOutbox.roomId, candidate.id),
            eq(realtimeOutbox.event, 'guest.ended'),
          )).orderBy(desc(realtimeOutbox.createdAt)).limit(1),
        ]);
        const emptySince = latestGuestEnd[0]?.createdAt ?? room[0]?.createdAt;
        if (room[0] && !member[0] && !activeGuest[0] && !remainingMessage[0] && !remainingAsset[0]
          && emptySince && emptySince < now - EMPTY_GUEST_ROOM_GRACE_MS) {
          await tx.delete(rooms).where(and(eq(rooms.id, candidate.id), eq(rooms.kind, 'guest')));
        }
      });
    }
  }

  private async seedFirstRoom(actor: Extract<Actor, { kind: 'user' }>) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seed-first-room:${actor.id}`}, 0))`);
      const [existing] = await tx.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, actor.id)).limit(1);
      if (existing) return;
      const now = Date.now();
      const [room] = await tx.insert(rooms).values({ name: 'Minh Anh', kind: 'direct', createdBy: actor.id, inviteCode: this.makeCode(), allowGuests: false, createdAt: now }).returning({ id: rooms.id });
      await tx.insert(roomMembers).values({ roomId: room.id, userId: actor.id, role: 'owner', joinedAt: now });
      await tx.insert(messages).values([
        { roomId: room.id, senderName: 'Minh Anh', type: 'text', body: 'Welcome to Nét, where words and drawings can continue the same story.', createdAt: now + 1 },
        { roomId: room.id, senderId: actor.id, senderName: actor.displayName, type: 'text', body: 'I will start with a line ✨', createdAt: now + 2 },
      ]);
    });
  }

  private requireText(value: unknown, label: string, min: number, max: number) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new BadRequestException(`${label} must be between ${min} and ${max} characters.`);
    return text;
  }

  private hasRead(reader: { lastReadSequence: number }, message: { sequence: number }) {
    return reader.lastReadSequence >= message.sequence;
  }

  private async findIdempotentMessage(
    clientRequestId: string,
    roomId: string,
    actor: Actor,
    input: { type: string; body: string | null; assetKey: string | null; replyToId: string | null; canvasParentId: string | null },
  ) {
    const [existing] = await this.db.select({
      id: messages.id,
      roomId: messages.roomId,
      senderId: messages.senderId,
      guestSessionId: messages.guestSessionId,
      sequence: messages.sequence,
      createdAt: messages.createdAt,
      canvasVersion: messages.canvasVersion,
      type: messages.type,
      body: messages.body,
      assetKey: messages.assetKey,
      replyToId: messages.replyToId,
      canvasParentId: messages.canvasParentId,
    }).from(messages).where(eq(messages.clientRequestId, clientRequestId)).limit(1);
    return existing ? this.assertIdempotentMessage(existing, roomId, actor, input) : null;
  }

  private assertIdempotentMessage(
    message: {
      id: string; roomId: string; senderId: string | null; guestSessionId: string | null; sequence: number;
      createdAt: number; canvasVersion: number | null; type: string; body: string | null; assetKey: string | null;
      replyToId: string | null; canvasParentId: string | null;
    },
    roomId: string,
    actor: Actor,
    input: { type: string; body: string | null; assetKey: string | null; replyToId: string | null; canvasParentId: string | null },
  ) {
    const owned = message.roomId === roomId && (actor.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor.id);
    if (!owned) throw new BadRequestException('The duplicate-prevention key belongs to another request.');
    if (message.type !== input.type || message.body !== input.body || message.assetKey !== input.assetKey
      || message.replyToId !== input.replyToId || message.canvasParentId !== input.canvasParentId) {
      throw new BadRequestException('The duplicate-prevention key cannot be reused for different content.');
    }
    return { id: message.id, sequence: message.sequence, createdAt: message.createdAt, canvasVersion: message.canvasVersion };
  }

  private makeCode(length = 20) { return crypto.randomUUID().replaceAll('-', '').slice(0, length); }
  private maskEmail(email: string) { const [name, domain] = email.split('@'); return domain ? `${name.slice(0, 2)}•••@${domain}` : email; }
}
