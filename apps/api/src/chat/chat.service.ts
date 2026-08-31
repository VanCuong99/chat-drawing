import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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
  roomReports,
  rooms,
  sql,
  userBlocks,
  users,
  visualVotes,
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
      ? await this.db.select({ roomId: roomMembers.roomId, lastReadSequence: roomMembers.lastReadSequence, mutedAt: roomMembers.mutedAt }).from(roomMembers).where(and(eq(roomMembers.userId, actor.id), isNull(roomMembers.archivedAt)))
      : await this.db.select({ roomId: guestSessions.roomId, lastReadSequence: guestSessions.lastReadSequence, mutedAt: guestSessions.mutedAt }).from(guestSessions).where(eq(guestSessions.id, actor.id));
    const roomIds = accessRows.map((row) => row.roomId);
    if (!roomIds.length) return [];
    const activeMessageCondition = or(isNull(messages.expiresAt), gt(messages.expiresAt, Date.now()));
    const ownMessageCondition = actor.kind === 'user'
      ? or(isNull(messages.senderId), ne(messages.senderId, actor.id))
      : or(isNull(messages.guestSessionId), ne(messages.guestSessionId, actor.id));
    const blockBoundaryCondition = actor.kind === 'user' ? sql`not exists (
      select 1 from ${userBlocks}
      where (${userBlocks.blockerId} = ${actor.id} and ${userBlocks.blockedId} = ${messages.senderId})
         or (${userBlocks.blockedId} = ${actor.id} and ${userBlocks.blockerId} = ${messages.senderId})
    )` : undefined;
    const unreadQuery = actor.kind === 'user'
      ? this.db.select({ roomId: messages.roomId, count: sql<number>`count(*)::int`, firstSequence: sql<number>`min(${messages.sequence})::bigint` })
        .from(messages)
        .innerJoin(roomMembers, and(
          eq(roomMembers.roomId, messages.roomId),
          eq(roomMembers.userId, actor.id),
          gt(messages.sequence, roomMembers.lastReadSequence),
        ))
        .where(and(inArray(messages.roomId, roomIds), activeMessageCondition, ownMessageCondition, blockBoundaryCondition))
        .groupBy(messages.roomId)
      : this.db.select({ roomId: messages.roomId, count: sql<number>`count(*)::int`, firstSequence: sql<number>`min(${messages.sequence})::bigint` })
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
      }).from(messages).where(and(inArray(messages.roomId, roomIds), activeMessageCondition, blockBoundaryCondition))
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
    const firstUnreadByRoom = new Map(unreadRows.map((row) => [row.roomId, Number(row.firstSequence)]));
    const accessByRoom = new Map(accessRows.map((row) => [row.roomId, row]));
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
        firstUnreadSequence: firstUnreadByRoom.get(room.id) ?? null,
        lastReadSequence: Number(accessByRoom.get(room.id)?.lastReadSequence ?? 0),
        muted: Boolean(accessByRoom.get(room.id)?.mutedAt),
        messageCount: statistics?.messageCount ?? 0,
        mediaCount: statistics?.mediaCount ?? 0,
      };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async inspectInvite(inviteCodeInput: unknown) {
    const inviteCode = this.requireText(inviteCodeInput, 'Invite code', 4, 60);
    const [room] = await this.db.select({
      id: rooms.id,
      name: rooms.name,
      allowGuests: rooms.allowGuests,
      kind: rooms.kind,
      createdBy: rooms.createdBy,
      createdAt: rooms.createdAt,
      inviteActive: rooms.inviteActive,
      inviteExpiresAt: rooms.inviteExpiresAt,
      inviteMaxUses: rooms.inviteMaxUses,
      inviteUseCount: rooms.inviteUseCount,
    }).from(rooms)
      .where(eq(rooms.inviteCode, inviteCode)).limit(1);
    if (!room || room.kind === 'direct' || !room.inviteActive || (room.inviteExpiresAt !== null && room.inviteExpiresAt <= Date.now()) || (room.inviteMaxUses !== null && room.inviteUseCount >= room.inviteMaxUses)) throw new NotFoundException('The invite link is invalid or has expired.');
    const now = Date.now();
    const [memberRows, memberCounts, hostRows, activeGuests, activeGuestCounts, recentMessages] = await Promise.all([
      this.db.select({
        id: users.id,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        joinedAt: roomMembers.joinedAt,
      }).from(roomMembers)
        .innerJoin(users, eq(users.id, roomMembers.userId))
        .where(eq(roomMembers.roomId, room.id))
        .orderBy(asc(roomMembers.joinedAt))
        .limit(20),
      this.db.select({ count: sql<number>`count(*)::int` })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, room.id)),
      this.db.select({ displayName: users.displayName })
        .from(roomMembers)
        .innerJoin(users, eq(users.id, roomMembers.userId))
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, room.createdBy ?? '')))
        .limit(1),
      this.db.select({ id: guestSessions.id, displayName: guestSessions.displayName, joinedAt: guestSessions.createdAt })
        .from(guestSessions)
        .where(and(eq(guestSessions.roomId, room.id), gt(guestSessions.expiresAt, now)))
        .orderBy(asc(guestSessions.createdAt))
        .limit(20),
      this.db.select({ count: sql<number>`count(*)::int` })
        .from(guestSessions)
        .where(and(eq(guestSessions.roomId, room.id), gt(guestSessions.expiresAt, now))),
      this.db.select({ type: messages.type, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.roomId, room.id), ne(messages.type, 'system')))
        .orderBy(desc(messages.sequence))
        .limit(1),
    ]);
    const participants = [
      ...memberRows.map((member) => ({ displayName: member.displayName, avatarColor: member.avatarColor })),
      ...activeGuests.map((guest) => ({ displayName: guest.displayName, avatarColor: null })),
    ];
    return {
      valid: true,
      guestAllowed: room.allowGuests,
      room: {
        name: room.name,
        hostedBy: hostRows[0]?.displayName ?? null,
        participants: participants.slice(0, 20),
        participantCount: (memberCounts[0]?.count ?? 0) + (activeGuestCounts[0]?.count ?? 0),
        recentActivity: recentMessages[0] ?? null,
        createdAt: room.createdAt,
      },
    };
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
            eq(rooms.inviteActive, true),
            or(isNull(rooms.inviteExpiresAt), gt(rooms.inviteExpiresAt, now)),
            or(isNull(rooms.inviteMaxUses), sql`${rooms.inviteUseCount} < ${rooms.inviteMaxUses}`),
            ne(rooms.kind, 'direct'),
          )).limit(1);
        if (!availableRoom) throw new NotFoundException('The invite link is invalid or the room does not accept guests.');
        room = availableRoom;
        await tx.update(rooms).set({ inviteUseCount: sql`${rooms.inviteUseCount} + 1` }).where(eq(rooms.id, room.id));
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
    const [rows, blockRows] = await Promise.all([
      this.db.select({ id: users.id, displayName: users.displayName, email: users.email, avatarColor: users.avatarColor })
        .from(users).where(or(ilike(users.displayName, `%${query}%`), ilike(users.email, `%${query}%`))).orderBy(asc(users.displayName)).limit(30),
      this.db.select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId }).from(userBlocks)
        .where(or(eq(userBlocks.blockerId, actor.id), eq(userBlocks.blockedId, actor.id))),
    ]);
    const unavailable = new Set(blockRows.flatMap((block) => [block.blockerId, block.blockedId]));
    unavailable.add(actor.id);
    return { users: rows.filter((user) => !unavailable.has(user.id)).slice(0, 12).map((user) => ({ ...user, email: this.maskEmail(user.email) })) };
  }

  async createRoom(actor: Actor, body: { name?: unknown; allowGuests?: boolean; memberIds?: unknown[] }) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to create a persistent conversation.');
    const memberIds = [...new Set((body.memberIds ?? []).filter((id): id is string => typeof id === 'string' && id !== actor.id))].slice(0, 20);
    const members = memberIds.length ? await this.db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, memberIds)) : [];
    if (members.length !== memberIds.length) throw new BadRequestException('One of the selected members is no longer available.');
    if (memberIds.length) {
      const blocked = await this.db.select({ blockerId: userBlocks.blockerId }).from(userBlocks).where(or(
        and(eq(userBlocks.blockerId, actor.id), inArray(userBlocks.blockedId, memberIds)),
        and(eq(userBlocks.blockedId, actor.id), inArray(userBlocks.blockerId, memberIds)),
      )).limit(1);
      if (blocked.length) throw new BadRequestException('A blocked member cannot be added to a new conversation.');
    }
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
        .where(and(eq(rooms.id, room.id), eq(rooms.inviteCode, inviteCode), eq(rooms.inviteActive, true), or(isNull(rooms.inviteExpiresAt), gt(rooms.inviteExpiresAt, Date.now())), or(isNull(rooms.inviteMaxUses), sql`${rooms.inviteUseCount} < ${rooms.inviteMaxUses}`))).limit(1);
      if (!availableRoom) throw new NotFoundException('The conversation no longer exists.');
      if (availableRoom.kind === 'direct') {
        const [existingMember] = await tx.select({ roomId: roomMembers.roomId }).from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, actor.id))).limit(1);
        if (!existingMember) throw new NotFoundException('No conversation was found for this invite link.');
        return null;
      }
      const insertedMembership = await tx.insert(roomMembers).values({ roomId: room.id, userId: actor.id, role: 'member', joinedAt: Date.now() })
        .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.userId] }).returning({ userId: roomMembers.userId });
      await tx.update(roomMembers).set({ archivedAt: null }).where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, actor.id)));
      if (insertedMembership.length) await tx.update(rooms).set({ inviteUseCount: sql`${rooms.inviteUseCount} + 1` }).where(eq(rooms.id, room.id));
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

  async listMessages(roomId: string, actor: Actor, limitInput?: unknown, cursorInput?: unknown, fromInput?: unknown, queryInput?: unknown) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const limit = Math.min(100, Math.max(20, Number(limitInput) || 80));
    const query = typeof queryInput === 'string'
      ? queryInput.trim().replaceAll('%', '').replaceAll('_', '').slice(0, 80)
      : '';
    const beforeSequence = Number(cursorInput);
    const fromSequence = Number(fromInput);
    const cursorCondition = !query && Number.isSafeInteger(beforeSequence) && beforeSequence > 0 ? lt(messages.sequence, beforeSequence) : undefined;
    const fromCondition = !query && !cursorCondition && Number.isSafeInteger(fromSequence) && fromSequence > 0
      ? sql`${messages.sequence} >= ${fromSequence}`
      : undefined;
    const queryCondition = query
      ? or(ilike(messages.senderName, `%${query}%`), ilike(messages.body, `%${query}%`))
      : undefined;
    const messageCondition = and(
      eq(messages.roomId, roomId),
      or(isNull(messages.expiresAt), gt(messages.expiresAt, now)),
      cursorCondition,
      fromCondition,
      queryCondition,
    );
    const loadingFromUnread = Boolean(fromCondition);
    const [selectedRows, totalRows] = await Promise.all([
      this.db.select().from(messages).where(messageCondition)
        .orderBy(loadingFromUnread ? asc(messages.sequence) : desc(messages.sequence))
        .limit(loadingFromUnread ? limit + 1 : limit),
      query
        ? this.db.select({ count: sql<number>`count(*)::int` }).from(messages).where(messageCondition)
        : Promise.resolve([]),
    ]);
    const hasMoreAfter = loadingFromUnread && selectedRows.length > limit;
    const rows = selectedRows.slice(0, limit);
    if (!loadingFromUnread) rows.reverse();
    const messageIds = rows.map((message) => message.id);
    const blockedRows = actor.kind === 'user' ? await this.db.select({ blockedId: userBlocks.blockedId }).from(userBlocks).where(eq(userBlocks.blockerId, actor.id)) : [];
    const blockedIds = new Set(blockedRows.map((row) => row.blockedId));
    const lineageRootIds = rows.flatMap((message) => message.canvasRootId ? [message.canvasRootId] : []);
    const [reactionRows, memberReaders, guestReaders, continuationRows, lineageRootRows] = await Promise.all([
      messageIds.length ? this.db.select().from(reactions).where(and(inArray(reactions.messageId, messageIds), or(isNull(reactions.expiresAt), gt(reactions.expiresAt, now)))) : [],
      this.db.select({ userId: roomMembers.userId, lastReadSequence: roomMembers.lastReadSequence }).from(roomMembers).where(eq(roomMembers.roomId, roomId)),
      this.db.select({ id: guestSessions.id, lastReadSequence: guestSessions.lastReadSequence }).from(guestSessions).where(and(eq(guestSessions.roomId, roomId), gt(guestSessions.expiresAt, now))),
      messageIds.length ? this.db.select({ parentId: messages.canvasParentId, count: sql<number>`count(*)::int` }).from(messages).where(and(
        eq(messages.roomId, roomId),
        eq(messages.type, 'canvas'),
        inArray(messages.canvasParentId, messageIds),
        or(isNull(messages.expiresAt), gt(messages.expiresAt, now)),
      )).groupBy(messages.canvasParentId) : [],
      lineageRootIds.length ? this.db.select({ id: messages.id, type: messages.type, senderName: messages.senderName, deletedAt: messages.deletedAt }).from(messages).where(inArray(messages.id, lineageRootIds)) : [],
    ]);
    const continuationCountByMessage = new Map(continuationRows.flatMap((row) => row.parentId ? [[row.parentId, row.count] as const] : []));
    const lineageRootById = new Map(lineageRootRows.map((root) => [root.id, root]));
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
      assetUrl: message.assetKey && !blockedIds.has(message.senderId ?? '') ? await this.assetService.issueReadUrl(message.assetKey, roomId, actor) : null,
      blockedAuthor: blockedIds.has(message.senderId ?? ''),
      reactions: [...(reactionMap.get(message.id)?.entries() ?? [])].map(([emoji, value]) => ({ emoji, ...value })),
      continuationCount: continuationCountByMessage.get(message.id) ?? 0,
      lineageRoot: message.canvasRootId ? lineageRootById.get(message.canvasRootId) ?? null : null,
      readCount: memberReaders.filter((reader) => reader.userId !== message.senderId && this.hasRead(reader, message)).length
        + guestReaders.filter((reader) => reader.id !== message.guestSessionId && this.hasRead(reader, message)).length,
    })));
    const oldest = output[0];
    return {
      messages: output,
      readAt: now,
      nextCursor: !query && output.length === limit && oldest ? String(oldest.sequence) : null,
      hasMoreAfter,
      totalCount: query ? totalRows[0]?.count ?? 0 : null,
    };
  }

  async listCanvasLineage(roomId: string, messageId: string, actor: Actor) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const selection = {
      id: messages.id,
      sequence: messages.sequence,
      roomId: messages.roomId,
      senderName: messages.senderName,
      body: messages.body,
      assetKey: messages.assetKey,
      canvasParentId: messages.canvasParentId,
      canvasVersion: messages.canvasVersion,
      type: messages.type,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      visualStatus: messages.visualStatus,
      decisionNote: messages.decisionNote,
      decisionOwnerId: messages.decisionOwnerId,
      decidedAt: messages.decidedAt,
    };
    const activeVisual = or(isNull(messages.expiresAt), gt(messages.expiresAt, now));
    const [target] = await this.db.select(selection).from(messages).where(and(
      eq(messages.id, messageId),
      eq(messages.roomId, roomId),
      inArray(messages.type, ['image', 'canvas']),
      activeVisual,
    )).limit(1);
    if (!target) throw new NotFoundException('The visual version no longer exists.');

    let root = target;
    const visitedAncestors = new Set<string>();
    while (root.canvasParentId && !visitedAncestors.has(root.id) && visitedAncestors.size < 200) {
      visitedAncestors.add(root.id);
      const [parent] = await this.db.select(selection).from(messages).where(and(
        eq(messages.id, root.canvasParentId),
        eq(messages.roomId, roomId),
        inArray(messages.type, ['image', 'canvas']),
        activeVisual,
      )).limit(1);
      if (!parent) break;
      root = parent;
    }

    const lineageById = new Map([[root.id, root]]);
    let frontier = [root.id];
    let truncated = visitedAncestors.size >= 200;
    while (frontier.length && lineageById.size < 200) {
      const remaining = 200 - lineageById.size;
      const children = await this.db.select(selection).from(messages).where(and(
        eq(messages.roomId, roomId),
        eq(messages.type, 'canvas'),
        inArray(messages.canvasParentId, frontier),
        activeVisual,
      )).orderBy(asc(messages.sequence)).limit(remaining + 1);
      if (children.length > remaining) truncated = true;
      const accepted = children.slice(0, remaining);
      for (const child of accepted) lineageById.set(child.id, child);
      frontier = accepted.map((child) => child.id);
    }

    const rows = [...lineageById.values()].sort((left, right) => left.sequence - right.sequence);
    const voteRows = rows.length ? await this.db.select({ messageId: visualVotes.messageId, actorKey: visualVotes.actorKey }).from(visualVotes).where(inArray(visualVotes.messageId, rows.map((row) => row.id))) : [];
    const votesByMessage = new Map<string, { count: number; voted: boolean }>();
    for (const vote of voteRows) {
      const current = votesByMessage.get(vote.messageId) ?? { count: 0, voted: false };
      current.count += 1;
      current.voted ||= vote.actorKey === actor.actorKey;
      votesByMessage.set(vote.messageId, current);
    }
    const lineage = await Promise.all(rows.map(async (row) => ({
      ...row,
      assetUrl: row.assetKey ? await this.assetService.issueReadUrl(row.assetKey, roomId, actor) : null,
      voteCount: votesByMessage.get(row.id)?.count ?? 0,
      voted: votesByMessage.get(row.id)?.voted ?? false,
    })));
    const [ownMembership, decisionOwners] = await Promise.all([
      actor.kind === 'user' ? this.db.select({ role: roomMembers.role }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).limit(1) : Promise.resolve([]),
      this.db.select({ id: users.id, displayName: users.displayName }).from(roomMembers).innerJoin(users, eq(users.id, roomMembers.userId)).where(eq(roomMembers.roomId, roomId)).orderBy(asc(users.displayName)),
    ]);
    const canDecide = actor.kind === 'user' && ownMembership[0]?.role === 'owner';
    return { lineage, truncated, canDecide, decisionOwners };
  }

  async updateVisualDecision(roomId: string, messageId: string, actor: Actor, body: { voted?: unknown; status?: unknown; note?: unknown; ownerId?: unknown }) {
    await this.actors.assertRoomAccess(roomId, actor);
    const [target] = await this.db.select({ id: messages.id, rootId: messages.canvasRootId, type: messages.type }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.roomId, roomId), inArray(messages.type, ['image', 'canvas']), isNull(messages.deletedAt))).limit(1);
    if (!target) throw new NotFoundException('The visual version no longer exists.');
    const wantsDecision = body.status !== undefined || body.note !== undefined || body.ownerId !== undefined;
    if (wantsDecision) await this.requireRoomOwner(roomId, actor);
    const allowedStatuses = new Set(['exploring', 'needs_changes', 'selected']);
    const status = typeof body.status === 'string' && allowedStatuses.has(body.status) ? body.status as 'exploring' | 'needs_changes' | 'selected' : undefined;
    if (body.status !== undefined && !status) throw new BadRequestException('The visual status is invalid.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined;
    const ownerId = typeof body.ownerId === 'string' && body.ownerId ? body.ownerId : body.ownerId === null ? null : undefined;
    if (ownerId) {
      const [member] = await this.db.select({ id: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, ownerId))).limit(1);
      if (!member) throw new BadRequestException('The decision owner must be a conversation member.');
    }
    const result = await this.db.transaction(async (tx) => {
      if (typeof body.voted === 'boolean') {
        if (body.voted) await tx.insert(visualVotes).values({ messageId, actorKey: actor.actorKey, createdAt: Date.now() }).onConflictDoNothing();
        else await tx.delete(visualVotes).where(and(eq(visualVotes.messageId, messageId), eq(visualVotes.actorKey, actor.actorKey)));
      }
      if (wantsDecision) {
        const rootId = target.rootId ?? target.id;
        if (status === 'selected') await tx.update(messages).set({ visualStatus: 'exploring', decisionNote: null, decisionOwnerId: null, decidedAt: null }).where(and(eq(messages.roomId, roomId), or(eq(messages.id, rootId), eq(messages.canvasRootId, rootId))));
        await tx.update(messages).set({
          ...(status ? { visualStatus: status } : {}),
          ...(note !== undefined ? { decisionNote: note || null } : {}),
          ...(ownerId !== undefined ? { decisionOwnerId: ownerId } : {}),
          decidedAt: Date.now(),
        }).where(eq(messages.id, messageId));
      }
      return this.outbox.enqueue(tx, roomId, 'message.updated', { messageId, decisionUpdated: true });
    });
    await this.outbox.deliverIds([result]);
    return { updated: true };
  }

  async sendMessage(roomId: string, actor: Actor, body: { type?: string; text?: unknown; assetKey?: string; imageDescription?: unknown; imagePurpose?: unknown; replyToId?: string | null; canvasParentId?: string | null; clientRequestId?: string }) {
    await this.actors.assertRoomAccess(roomId, actor);
    if (!['text', 'image', 'canvas'].includes(body.type ?? '')) throw new BadRequestException('The message type is invalid.');
    const type = body.type as 'text' | 'image' | 'canvas';
    const text = body.text ? this.requireText(body.text, 'Content', 1, 2000) : null;
    if (type === 'text' && !text) throw new BadRequestException('Messages cannot be empty.');
    if ((type === 'image' || type === 'canvas') && !body.assetKey) throw new BadRequestException('Image content is missing.');
    const imageDescription = typeof body.imageDescription === 'string' ? body.imageDescription.trim() : '';
    if (imageDescription.length > 500) throw new BadRequestException('The image description must be 500 characters or fewer.');
    const imagePurpose: 'creative' | 'reference' = body.imagePurpose === 'reference' ? 'reference' : 'creative';
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
      imageDescription: imageDescription || null,
      imagePurpose,
    };
    if (clientRequestId) {
      const existing = await this.findIdempotentMessage(clientRequestId, roomId, actor, idempotencyInput);
      if (existing) return existing;
    }
    if (body.assetKey) await this.assetService.assertPending(body.assetKey, roomId, actor);
    if (body.replyToId) {
      const [reply] = await this.db.select({ id: messages.id, senderId: messages.senderId }).from(messages).where(and(eq(messages.id, body.replyToId), eq(messages.roomId, roomId))).limit(1);
      if (!reply) throw new BadRequestException('The replied-to message no longer exists.');
      if (actor.kind === 'user' && reply.senderId) {
        const [blocked] = await this.db.select({ blockerId: userBlocks.blockerId }).from(userBlocks).where(or(and(eq(userBlocks.blockerId, actor.id), eq(userBlocks.blockedId, reply.senderId)), and(eq(userBlocks.blockerId, reply.senderId), eq(userBlocks.blockedId, actor.id)))).limit(1);
        if (blocked) throw new BadRequestException('Replies are unavailable across a block boundary.');
      }
    }
    let canvasVersion: number | null = null;
    let canvasRootId: string | null = null;
    if (type === 'canvas') {
      if (body.canvasParentId) {
        const [parent] = await this.db.select({ id: messages.id, version: messages.canvasVersion, type: messages.type, rootId: messages.canvasRootId, imagePurpose: messages.imagePurpose }).from(messages)
          .where(and(
            eq(messages.id, body.canvasParentId),
            eq(messages.roomId, roomId),
            inArray(messages.type, ['image', 'canvas']),
            or(isNull(messages.expiresAt), gt(messages.expiresAt, Date.now())),
          )).limit(1);
        if (!parent) throw new BadRequestException('The source visual no longer exists.');
        if (parent.type === 'image' && parent.imagePurpose === 'reference') throw new BadRequestException('Reference attachments cannot start a drawing thread.');
        canvasVersion = parent.type === 'image' ? 1 : (parent.version ?? 1) + 1;
        canvasRootId = parent.rootId ?? parent.id;
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
          imageDescription: messages.imageDescription,
          imagePurpose: messages.imagePurpose,
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
        canvasRootId,
        canvasVersion,
        imageDescription: imageDescription || null,
        imagePurpose,
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

  async editMessage(roomId: string, messageId: string, actor: Actor, textInput: unknown) {
    await this.actors.assertRoomAccess(roomId, actor);
    const [message] = await this.db.select({
      id: messages.id,
      type: messages.type,
      senderId: messages.senderId,
      guestSessionId: messages.guestSessionId,
      deletedAt: messages.deletedAt,
    }).from(messages).where(and(eq(messages.id, messageId), eq(messages.roomId, roomId))).limit(1);
    if (!message || message.deletedAt) throw new NotFoundException('The message is no longer editable.');
    this.assertMessageOwner(message, actor);
    const text = typeof textInput === 'string' ? textInput.trim() : '';
    if (message.type === 'text' && !text) throw new BadRequestException('Messages cannot be empty.');
    if (text.length > 2000) throw new BadRequestException('Content must be 2000 characters or fewer.');
    const editedAt = Date.now();
    const outboxId = await this.db.transaction(async (tx) => {
      await tx.update(messages).set({ body: text || null, editedAt }).where(eq(messages.id, messageId));
      return this.outbox.enqueue(tx, roomId, 'message.updated', { messageId, body: text, editedAt });
    });
    await this.outbox.deliverIds([outboxId]);
    return { id: messageId, body: text || null, editedAt };
  }

  async deleteMessage(roomId: string, messageId: string, actor: Actor) {
    await this.actors.assertRoomAccess(roomId, actor);
    const deletedAt = Date.now();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`);
      const [message] = await tx.select({
        id: messages.id,
        senderId: messages.senderId,
        guestSessionId: messages.guestSessionId,
        assetKey: messages.assetKey,
        deletedAt: messages.deletedAt,
      }).from(messages).where(and(eq(messages.id, messageId), eq(messages.roomId, roomId))).for('update').limit(1);
      if (!message) throw new NotFoundException('The message no longer exists.');
      this.assertMessageOwner(message, actor);
      if (message.deletedAt) return { assetKey: null, outboxId: null };
      if (message.assetKey) await tx.update(assets).set({ status: 'deleting' }).where(eq(assets.key, message.assetKey));
      await tx.update(messages).set({ body: null, assetKey: null, deletedAt, editedAt: null }).where(eq(messages.id, messageId));
      await tx.delete(reactions).where(eq(reactions.messageId, messageId));
      const outboxId = await this.outbox.enqueue(tx, roomId, 'message.deleted', { messageId, deletedAt });
      return { assetKey: message.assetKey, outboxId };
    });
    if (result.outboxId) await this.outbox.deliverIds([result.outboxId]);
    if (result.assetKey) await this.assetService.deleteKeys([result.assetKey]);
    return { id: messageId, deletedAt };
  }

  async undoMessage(roomId: string, messageId: string, actor: Actor) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`);
      const [message] = await tx.select({
        id: messages.id,
        sequence: messages.sequence,
        senderId: messages.senderId,
        guestSessionId: messages.guestSessionId,
        assetKey: messages.assetKey,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
      }).from(messages).where(and(eq(messages.id, messageId), eq(messages.roomId, roomId))).for('update').limit(1);
      if (!message || message.deletedAt) throw new NotFoundException('The contribution is no longer available.');
      this.assertMessageOwner(message, actor);
      if (now - message.createdAt > 10_000) throw new ConflictException('Undo Send has expired. Remove the contribution instead.');
      const [reply, continuation, reaction, memberRead, guestRead] = await Promise.all([
        tx.select({ id: messages.id }).from(messages).where(and(eq(messages.replyToId, messageId), isNull(messages.deletedAt))).limit(1),
        tx.select({ id: messages.id }).from(messages).where(and(eq(messages.canvasParentId, messageId), isNull(messages.deletedAt))).limit(1),
        tx.select({ id: reactions.messageId }).from(reactions).where(eq(reactions.messageId, messageId)).limit(1),
        tx.select({ userId: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), gt(roomMembers.lastReadSequence, message.sequence - 1), message.senderId ? ne(roomMembers.userId, message.senderId) : undefined)).limit(1),
        tx.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.roomId, roomId), gt(guestSessions.lastReadSequence, message.sequence - 1), message.guestSessionId ? ne(guestSessions.id, message.guestSessionId) : undefined)).limit(1),
      ]);
      if (reply.length || continuation.length || reaction.length || memberRead.length || guestRead.length) {
        throw new ConflictException('This contribution was already seen or used. Remove it with the disclosed history instead.');
      }
      if (message.assetKey) await tx.update(assets).set({ status: 'deleting' }).where(eq(assets.key, message.assetKey));
      await tx.delete(messages).where(eq(messages.id, messageId));
      const outboxId = await this.outbox.enqueue(tx, roomId, 'message.deleted', { messageId, hard: true });
      return { assetKey: message.assetKey, outboxId };
    });
    await this.outbox.deliverIds([result.outboxId]);
    if (result.assetKey) await this.assetService.deleteKeys([result.assetKey]);
    return { id: messageId, undone: true };
  }

  async listPeople(roomId: string, actor: Actor) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const [room, memberRows, guestRows, ownMembership, blockedAccounts] = await Promise.all([
      this.db.select({ id: rooms.id, kind: rooms.kind, createdBy: rooms.createdBy, allowGuests: rooms.allowGuests, inviteActive: rooms.inviteActive, inviteExpiresAt: rooms.inviteExpiresAt, inviteMaxUses: rooms.inviteMaxUses, inviteUseCount: rooms.inviteUseCount }).from(rooms).where(eq(rooms.id, roomId)).limit(1),
      this.db.select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor, role: roomMembers.role, joinedAt: roomMembers.joinedAt })
        .from(roomMembers).innerJoin(users, eq(users.id, roomMembers.userId)).where(eq(roomMembers.roomId, roomId)).orderBy(asc(roomMembers.joinedAt)),
      this.db.select({ id: guestSessions.id, displayName: guestSessions.displayName, joinedAt: guestSessions.createdAt })
        .from(guestSessions).where(and(eq(guestSessions.roomId, roomId), gt(guestSessions.expiresAt, now))).orderBy(asc(guestSessions.createdAt)),
      actor.kind === 'user'
        ? this.db.select({ role: roomMembers.role, mutedAt: roomMembers.mutedAt }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).limit(1)
        : this.db.select({ mutedAt: guestSessions.mutedAt }).from(guestSessions).where(and(eq(guestSessions.roomId, roomId), eq(guestSessions.id, actor.id))).limit(1),
      actor.kind === 'user' ? this.db.select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor }).from(userBlocks).innerJoin(users, eq(users.id, userBlocks.blockedId)).where(eq(userBlocks.blockerId, actor.id)).orderBy(asc(users.displayName)) : Promise.resolve([]),
    ]);
    if (!room[0]) throw new NotFoundException('The conversation no longer exists.');
    return {
      members: [
        ...memberRows.map((member) => ({ ...member, kind: 'user' as const })),
        ...guestRows.map((guest) => ({ ...guest, kind: 'guest' as const, avatarColor: null, role: 'guest' as const })),
      ],
      currentRole: actor.kind === 'user' ? ownMembership[0] && 'role' in ownMembership[0] ? ownMembership[0].role : null : 'guest',
      muted: Boolean(ownMembership[0]?.mutedAt),
      allowGuests: room[0].allowGuests,
      canManage: actor.kind === 'user' && ownMembership[0] && 'role' in ownMembership[0] && ownMembership[0].role === 'owner',
      kind: room[0].kind,
      inviteActive: room[0].inviteActive,
      inviteExpiresAt: room[0].inviteExpiresAt,
      inviteMaxUses: room[0].inviteMaxUses,
      inviteUseCount: room[0].inviteUseCount,
      blockedAccounts,
    };
  }

  async updateRoomGovernance(roomId: string, actor: Actor, body: { allowGuests?: unknown; inviteActive?: unknown; inviteExpiresInHours?: unknown; inviteMaxUses?: unknown }) {
    const membership = await this.requireRoomOwner(roomId, actor);
    if (membership.kind === 'direct') throw new BadRequestException('Direct conversations do not use guest invites.');
    const patch: Partial<typeof rooms.$inferInsert> = {};
    if (typeof body.allowGuests === 'boolean') patch.allowGuests = body.allowGuests;
    if (typeof body.inviteActive === 'boolean') patch.inviteActive = body.inviteActive;
    if (body.inviteExpiresInHours !== undefined) {
      const hours = Number(body.inviteExpiresInHours);
      patch.inviteExpiresAt = Number.isFinite(hours) && hours > 0 ? Date.now() + Math.min(hours, 24 * 30) * 60 * 60 * 1000 : null;
    }
    if (body.inviteMaxUses !== undefined) {
      const maxUses = Number(body.inviteMaxUses);
      patch.inviteMaxUses = Number.isInteger(maxUses) && maxUses > 0 ? Math.min(maxUses, 1000) : null;
      patch.inviteUseCount = 0;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No conversation setting was changed.');
    if (body.inviteActive === true) {
      patch.inviteCode = this.makeCode();
      patch.inviteUseCount = 0;
    }
    const [updated] = await this.db.update(rooms).set(patch).where(eq(rooms.id, roomId)).returning();
    return updated;
  }

  async updateRoomPreferences(roomId: string, actor: Actor, body: { muted?: unknown }) {
    await this.actors.assertRoomAccess(roomId, actor);
    if (typeof body.muted !== 'boolean') throw new BadRequestException('The mute preference is invalid.');
    const mutedAt = body.muted ? Date.now() : null;
    const updated = actor.kind === 'user'
      ? await this.db.update(roomMembers).set({ mutedAt }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).returning({ roomId: roomMembers.roomId })
      : await this.db.update(guestSessions).set({ mutedAt }).where(and(eq(guestSessions.roomId, roomId), eq(guestSessions.id, actor.id), gt(guestSessions.expiresAt, Date.now()))).returning({ roomId: guestSessions.roomId });
    if (!updated.length) throw new UnauthorizedException('You no longer have access to this conversation.');
    return { muted: body.muted };
  }

  async revokeInvite(roomId: string, actor: Actor) {
    const membership = await this.requireRoomOwner(roomId, actor);
    if (membership.kind === 'direct') throw new BadRequestException('Direct conversations do not use public invite links.');
    const outboxId = await this.db.transaction(async (tx) => {
      await tx.update(rooms).set({ inviteActive: false }).where(eq(rooms.id, roomId));
      return this.outbox.enqueue(tx, roomId, 'room.updated', { inviteRevoked: true });
    });
    await this.outbox.deliverIds([outboxId]);
    return { inviteActive: false };
  }

  async transferOwnership(roomId: string, userId: string, actor: Actor) {
    await this.requireRoomOwner(roomId, actor);
    if (actor.kind !== 'user' || userId === actor.id) throw new BadRequestException('Choose another signed-in member.');
    await this.db.transaction(async (tx) => {
      const [target] = await tx.select({ id: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId), eq(roomMembers.role, 'member'))).for('update').limit(1);
      if (!target) throw new BadRequestException('The new owner must be a signed-in member.');
      await tx.update(roomMembers).set({ role: 'member' }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id)));
      await tx.update(roomMembers).set({ role: 'owner' }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
      await tx.update(rooms).set({ createdBy: userId }).where(eq(rooms.id, roomId));
    });
    return { ownerId: userId };
  }

  async removeGuest(roomId: string, guestId: string, actor: Actor) {
    await this.requireRoomOwner(roomId, actor);
    const [guest] = await this.db.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.id, guestId), eq(guestSessions.roomId, roomId))).limit(1);
    if (!guest) throw new NotFoundException('That guest session is no longer active.');
    await this.endGuestById(guestId);
    return { removed: true };
  }

  async archiveRoom(roomId: string, actor: Actor, archivedInput: unknown) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to archive conversations.');
    await this.actors.assertRoomAccess(roomId, actor);
    const archived = archivedInput !== false;
    await this.db.update(roomMembers).set({ archivedAt: archived ? Date.now() : null }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id)));
    return { archived };
  }

  async deleteRoom(roomId: string, actor: Actor) {
    await this.requireRoomOwner(roomId, actor);
    const assetRows = await this.db.select({ key: assets.key }).from(assets).where(eq(assets.roomId, roomId));
    await this.db.delete(rooms).where(eq(rooms.id, roomId));
    await this.assetService.deleteKeys(assetRows.map((asset) => asset.key));
    return { deleted: true, removedAssets: assetRows.length };
  }

  async removeMember(roomId: string, userId: string, actor: Actor) {
    await this.requireRoomOwner(roomId, actor);
    if (actor.kind === 'user' && userId === actor.id) throw new BadRequestException('Use Leave conversation to remove yourself.');
    const removed = await this.db.transaction(async (tx) => {
      const rows = await tx.delete(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId), eq(roomMembers.role, 'member'))).returning({ userId: roomMembers.userId });
      if (!rows.length) throw new NotFoundException('That member is no longer in the conversation.');
      const outboxId = await this.outbox.enqueue(tx, roomId, 'room.updated', { removedMemberId: userId });
      return { outboxId };
    });
    await this.outbox.deliverIds([removed.outboxId]);
    return { removed: true };
  }

  async leaveRoom(roomId: string, actor: Actor) {
    if (actor.kind !== 'user') throw new BadRequestException('End the guest session to leave this conversation.');
    await this.actors.assertRoomAccess(roomId, actor);
    const result = await this.db.transaction(async (tx) => {
      const [membership] = await tx.select({ role: roomMembers.role }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).for('update').limit(1);
      if (!membership) throw new NotFoundException('You are no longer in this conversation.');
      if (membership.role === 'owner') throw new BadRequestException('An owner must remove the conversation or transfer ownership before leaving.');
      await tx.delete(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id)));
      return this.outbox.enqueue(tx, roomId, 'room.updated', { leftMemberId: actor.id });
    });
    await this.outbox.deliverIds([result]);
    return { left: true };
  }

  async reportRoom(roomId: string, actor: Actor, body: { reason?: unknown; details?: unknown; reportedUserId?: unknown; messageId?: unknown }) {
    await this.actors.assertRoomAccess(roomId, actor);
    const allowedReasons = new Set(['spam', 'harassment', 'unsafe-content', 'impersonation', 'other']);
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!allowedReasons.has(reason)) throw new BadRequestException('Choose a valid report reason.');
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1000) : null;
    const reportedUserId = typeof body.reportedUserId === 'string' ? body.reportedUserId : null;
    const messageId = typeof body.messageId === 'string' ? body.messageId : null;
    if (reportedUserId) {
      const [member] = await this.db.select({ userId: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, reportedUserId))).limit(1);
      if (!member) throw new BadRequestException('The reported member is not in this conversation.');
    }
    if (messageId) {
      const [message] = await this.db.select({ id: messages.id }).from(messages).where(and(eq(messages.roomId, roomId), eq(messages.id, messageId))).limit(1);
      if (!message) throw new BadRequestException('The reported message is not in this conversation.');
    }
    const [report] = await this.db.insert(roomReports).values({
      roomId,
      reporterId: actor.kind === 'user' ? actor.id : null,
      guestSessionId: actor.kind === 'guest' ? actor.id : null,
      reportedUserId,
      messageId,
      reason,
      details,
      createdAt: Date.now(),
    }).returning({ id: roomReports.id });
    return { id: report.id, received: true };
  }

  async blockUser(userId: string, actor: Actor) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to block members.');
    if (userId === actor.id) throw new BadRequestException('You cannot block yourself.');
    const [target] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!target) throw new NotFoundException('That member no longer exists.');
    await this.db.insert(userBlocks).values({ blockerId: actor.id, blockedId: userId, createdAt: Date.now() })
      .onConflictDoNothing({ target: [userBlocks.blockerId, userBlocks.blockedId] });
    return { blocked: true };
  }

  async unblockUser(userId: string, actor: Actor) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Sign in to manage blocked accounts.');
    await this.db.delete(userBlocks).where(and(eq(userBlocks.blockerId, actor.id), eq(userBlocks.blockedId, userId)));
    return { blocked: false };
  }

  async toggleReaction(messageId: string, actor: Actor, emoji: string) {
    if (!EMOJIS.includes(emoji)) throw new BadRequestException('The reaction is invalid.');
    const [message] = await this.db.select({ roomId: messages.roomId, senderId: messages.senderId }).from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!message) throw new NotFoundException('The message no longer exists.');
    await this.actors.assertRoomAccess(message.roomId, actor);
    if (actor.kind === 'user' && message.senderId) {
      const [blocked] = await this.db.select({ blockerId: userBlocks.blockerId }).from(userBlocks).where(or(and(eq(userBlocks.blockerId, actor.id), eq(userBlocks.blockedId, message.senderId)), and(eq(userBlocks.blockerId, message.senderId), eq(userBlocks.blockedId, actor.id)))).limit(1);
      if (blocked) throw new BadRequestException('Reactions are unavailable across a block boundary.');
    }
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
    input: { type: string; body: string | null; assetKey: string | null; replyToId: string | null; canvasParentId: string | null; imageDescription: string | null; imagePurpose: 'creative' | 'reference' },
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
      imageDescription: messages.imageDescription,
      imagePurpose: messages.imagePurpose,
    }).from(messages).where(eq(messages.clientRequestId, clientRequestId)).limit(1);
    return existing ? this.assertIdempotentMessage(existing, roomId, actor, input) : null;
  }

  private assertIdempotentMessage(
    message: {
      id: string; roomId: string; senderId: string | null; guestSessionId: string | null; sequence: number;
      createdAt: number; canvasVersion: number | null; type: string; body: string | null; assetKey: string | null;
      replyToId: string | null; canvasParentId: string | null; imageDescription: string | null; imagePurpose: 'creative' | 'reference';
    },
    roomId: string,
    actor: Actor,
    input: { type: string; body: string | null; assetKey: string | null; replyToId: string | null; canvasParentId: string | null; imageDescription: string | null; imagePurpose: 'creative' | 'reference' },
  ) {
    const owned = message.roomId === roomId && (actor.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor.id);
    if (!owned) throw new BadRequestException('The duplicate-prevention key belongs to another request.');
    if (message.type !== input.type || message.body !== input.body || message.assetKey !== input.assetKey
      || message.replyToId !== input.replyToId || message.canvasParentId !== input.canvasParentId
      || message.imageDescription !== input.imageDescription || message.imagePurpose !== input.imagePurpose) {
      throw new BadRequestException('The duplicate-prevention key cannot be reused for different content.');
    }
    return { id: message.id, sequence: message.sequence, createdAt: message.createdAt, canvasVersion: message.canvasVersion };
  }

  private assertMessageOwner(message: { senderId: string | null; guestSessionId: string | null }, actor: Actor) {
    const owned = actor.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor.id;
    if (!owned) throw new UnauthorizedException('Only the creator can change this contribution.');
  }

  private async requireRoomOwner(roomId: string, actor: Actor) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Only the conversation owner can manage members and invites.');
    const [membership] = await this.db.select({ role: roomMembers.role, kind: rooms.kind }).from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).limit(1);
    if (!membership || membership.role !== 'owner') throw new UnauthorizedException('Only the conversation owner can manage members and invites.');
    return membership;
  }

  private makeCode(length = 20) { return crypto.randomUUID().replaceAll('-', '').slice(0, length); }
  private maskEmail(email: string) { const [name, domain] = email.split('@'); return domain ? `${name.slice(0, 2)}•••@${domain}` : email; }
}
