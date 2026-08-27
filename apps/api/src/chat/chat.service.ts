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
  isNull,
  lt,
  messages,
  ne,
  or,
  reactions,
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
    const [roomRows, latest, unreadRows] = await Promise.all([
      this.db.select().from(rooms).where(inArray(rooms.id, roomIds)),
      this.db.selectDistinctOn([messages.roomId], {
        roomId: messages.roomId,
        type: messages.type,
        body: messages.body,
        createdAt: messages.createdAt,
      }).from(messages).where(and(inArray(messages.roomId, roomIds), or(isNull(messages.expiresAt), gt(messages.expiresAt, Date.now()))))
        .orderBy(messages.roomId, desc(messages.sequence)),
      Promise.all(accessRows.map(async ({ roomId, lastReadSequence }) => {
        const ownMessageCondition = actor.kind === 'user'
          ? or(isNull(messages.senderId), ne(messages.senderId, actor.id))
          : or(isNull(messages.guestSessionId), ne(messages.guestSessionId, actor.id));
        const unread = await this.db.select({ id: messages.id }).from(messages).where(and(
          eq(messages.roomId, roomId),
          gt(messages.sequence, lastReadSequence),
          or(isNull(messages.expiresAt), gt(messages.expiresAt, Date.now())),
          ownMessageCondition,
        ));
        return [roomId, unread.length] as const;
      })),
    ]);
    const latestByRoom = new Map(latest.map((message) => [message.roomId, message]));
    const unreadByRoom = new Map(unreadRows);
    return roomRows.map((room) => {
      const last = latestByRoom.get(room.id);
      const preview = !last ? 'Bắt đầu một câu chuyện mới'
        : last.type === 'canvas' ? 'Đã gửi một bản vẽ'
          : last.type === 'image' ? 'Đã gửi một hình ảnh'
            : last.body ?? 'Tin nhắn mới';
      return { ...room, preview, lastActivity: last?.createdAt ?? room.createdAt, unreadCount: unreadByRoom.get(room.id) ?? 0 };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async createGuest(displayNameInput: unknown, inviteCodeInput?: unknown) {
    const displayName = this.requireText(displayNameInput, 'Tên hiển thị', 2, 60);
    const inviteCode = typeof inviteCodeInput === 'string' ? inviteCodeInput.trim() : '';
    const now = Date.now();
    let [room] = inviteCode
      ? await this.db.select().from(rooms).where(eq(rooms.inviteCode, inviteCode)).limit(1)
      : [];
    if (inviteCode && (!room || !room.allowGuests)) throw new NotFoundException('Link mời không hợp lệ hoặc phòng không nhận khách.');
    if (!room) {
      [room] = await this.db.insert(rooms).values({ name: `Phiên của ${displayName}`, kind: 'guest', inviteCode: this.makeCode(), allowGuests: true, createdAt: now }).returning();
    }
    const expiresAt = this.actors.guestTtl();
    const [session] = await this.db.insert(guestSessions).values({ roomId: room.id, displayName, createdAt: now, lastSeenAt: now, expiresAt }).returning();
    const [firstMessage] = await this.db.select({ id: messages.id }).from(messages).where(eq(messages.roomId, room.id)).limit(1);
    if (!firstMessage) {
      await this.db.insert(messages).values({ roomId: room.id, guestSessionId: session.id, senderName: 'Nét', type: 'system', body: 'Phiên khách đã bắt đầu. Nội dung của bạn sẽ được xoá khi kết thúc phiên.', createdAt: now + 1, expiresAt });
    }
    return { sessionId: session.id, expiresAt, roomId: room.id, roomName: room.name };
  }

  async endGuest(actor: Actor) {
    if (actor.kind !== 'guest') throw new UnauthorizedException('Phiên khách không còn hiệu lực.');
    await this.endGuestById(actor.id);
    return { ok: true };
  }

  async endGuestById(guestId: string) {
    const ended = await this.db.transaction(async (tx) => {
      const [guest] = await tx.select().from(guestSessions).where(eq(guestSessions.id, guestId)).for('update').limit(1);
      if (!guest) return null;
      const [assetRows, messageRows] = await Promise.all([
        tx.select({ key: assets.key }).from(assets).where(eq(assets.guestSessionId, guestId)),
        tx.select({ id: messages.id }).from(messages).where(eq(messages.guestSessionId, guestId)),
      ]);
      if (assetRows.length) {
        await tx.update(assets).set({ status: 'deleting' }).where(and(
          eq(assets.guestSessionId, guestId),
          inArray(assets.key, assetRows.map((asset) => asset.key)),
        ));
      }
      const outboxId = await this.outbox.enqueue(tx, guest.roomId, 'guest.ended', {
        guestSessionId: guestId,
        messageIds: messageRows.map((message) => message.id),
      });
      await tx.delete(reactions).where(eq(reactions.actorKey, `guest:${guestId}`));
      await tx.delete(guestSessions).where(eq(guestSessions.id, guestId));
      return { guest, assetRows, messageRows, outboxId };
    });
    if (!ended) return;
    await this.outbox.deliverIds([ended.outboxId]);
    await this.assetService.deleteKeys(ended.assetRows.map((asset) => asset.key));
    const [room] = await this.db.select({ kind: rooms.kind }).from(rooms).where(eq(rooms.id, ended.guest.roomId)).limit(1);
    if (room?.kind === 'guest') {
      const [member, activeGuest, retainedAsset] = await Promise.all([
        this.db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.roomId, ended.guest.roomId)).limit(1),
        this.db.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.roomId, ended.guest.roomId)).limit(1),
        this.db.select({ key: assets.key }).from(assets).where(eq(assets.roomId, ended.guest.roomId)).limit(1),
      ]);
      if (!member[0] && !activeGuest[0] && !retainedAsset[0]) await this.db.delete(rooms).where(eq(rooms.id, ended.guest.roomId));
    }
    this.realtime.disconnectActor(`guest:${guestId}`);
  }

  async searchUsers(actor: Actor, queryInput: unknown) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Đăng nhập để tìm thành viên.');
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
    if (actor.kind !== 'user') throw new UnauthorizedException('Đăng nhập để tạo cuộc trò chuyện lâu dài.');
    const memberIds = [...new Set((body.memberIds ?? []).filter((id): id is string => typeof id === 'string' && id !== actor.id))].slice(0, 20);
    const members = memberIds.length ? await this.db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, memberIds)) : [];
    if (members.length !== memberIds.length) throw new BadRequestException('Một thành viên không còn khả dụng.');
    const suggestedName = members.length === 1 ? `${actor.displayName} & ${members[0].displayName}` : body.name;
    const name = this.requireText(suggestedName, 'Tên cuộc trò chuyện', 2, 60);
    const inviteCode = this.makeCode();
    const now = Date.now();
    const created = await this.db.transaction(async (tx) => {
      const [room] = await tx.insert(rooms).values({ name, kind: memberIds.length === 1 ? 'direct' : 'group', createdBy: actor.id, inviteCode, allowGuests: body.allowGuests !== false, createdAt: now }).returning({ id: rooms.id });
      await tx.insert(roomMembers).values([
        { roomId: room.id, userId: actor.id, role: 'owner', joinedAt: now },
        ...memberIds.map((userId) => ({ roomId: room.id, userId, role: 'member' as const, joinedAt: now })),
      ]);
      const outboxId = await this.outbox.enqueue(tx, room.id, 'room.updated', { memberIds: [actor.id, ...memberIds] });
      return { roomId: room.id, outboxId };
    });
    await this.outbox.deliverIds([created.outboxId]);
    return { id: created.roomId, inviteCode };
  }

  async joinRoom(actor: Actor, inviteCodeInput: unknown) {
    if (actor.kind !== 'user') throw new UnauthorizedException('Đăng nhập để tham gia với tài khoản.');
    const inviteCode = this.requireText(inviteCodeInput, 'Mã mời', 4, 60);
    const [room] = await this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.inviteCode, inviteCode)).limit(1);
    if (!room) throw new NotFoundException('Không tìm thấy cuộc trò chuyện từ link mời.');
    const outboxId = await this.db.transaction(async (tx) => {
      await tx.insert(roomMembers).values({ roomId: room.id, userId: actor.id, role: 'member', joinedAt: Date.now() })
        .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.userId] });
      return this.outbox.enqueue(tx, room.id, 'room.updated', { memberId: actor.id });
    });
    await this.outbox.deliverIds([outboxId]);
    return { roomId: room.id };
  }

  async listMessages(roomId: string, actor: Actor, limitInput?: unknown, cursorInput?: unknown) {
    await this.actors.assertRoomAccess(roomId, actor);
    const now = Date.now();
    const limit = Math.min(100, Math.max(20, Number(limitInput) || 80));
    const beforeSequence = Number(cursorInput);
    const cursorCondition = Number.isSafeInteger(beforeSequence) && beforeSequence > 0 ? lt(messages.sequence, beforeSequence) : undefined;
    const rows = await this.db.select().from(messages).where(and(
      eq(messages.roomId, roomId),
      or(isNull(messages.expiresAt), gt(messages.expiresAt, now)),
      cursorCondition,
    )).orderBy(desc(messages.sequence)).limit(limit);
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
    return { messages: output, readAt: now, nextCursor: output.length === limit && oldest ? String(oldest.sequence) : null };
  }

  async sendMessage(roomId: string, actor: Actor, body: { type?: string; text?: unknown; assetKey?: string; replyToId?: string | null; canvasParentId?: string | null; clientRequestId?: string }) {
    await this.actors.assertRoomAccess(roomId, actor);
    if (!['text', 'image', 'canvas'].includes(body.type ?? '')) throw new BadRequestException('Loại tin nhắn không hợp lệ.');
    const type = body.type as 'text' | 'image' | 'canvas';
    const text = body.text ? this.requireText(body.text, 'Nội dung', 1, 2000) : null;
    if (type === 'text' && !text) throw new BadRequestException('Tin nhắn không được để trống.');
    if ((type === 'image' || type === 'canvas') && !body.assetKey) throw new BadRequestException('Thiếu nội dung hình ảnh.');
    const clientRequestId = typeof body.clientRequestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientRequestId)
      ? body.clientRequestId
      : null;
    if (body.clientRequestId && !clientRequestId) throw new BadRequestException('Mã chống gửi trùng không hợp lệ.');
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
      if (!reply) throw new BadRequestException('Tin nhắn được trả lời không còn tồn tại.');
    }
    let canvasVersion: number | null = null;
    if (type === 'canvas') {
      if (body.canvasParentId) {
        const [parent] = await this.db.select({ version: messages.canvasVersion }).from(messages)
          .where(and(eq(messages.id, body.canvasParentId), eq(messages.roomId, roomId), eq(messages.type, 'canvas'))).limit(1);
        if (!parent) throw new BadRequestException('Bản vẽ gốc không còn tồn tại.');
        canvasVersion = (parent.version ?? 1) + 1;
      } else canvasVersion = 1;
    }
    const now = Date.now();
    const result = await this.db.transaction(async (tx) => {
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
        if (!valid) throw new UnauthorizedException('Phiên khách đã kết thúc trước khi tin nhắn được gửi.');
      }
      if (body.assetKey) {
        const attached = await tx.update(assets).set({ status: 'attached' }).where(and(
          eq(assets.key, body.assetKey), eq(assets.roomId, roomId), eq(assets.ownerKey, actor.actorKey), eq(assets.status, 'pending'),
        )).returning({ key: assets.key });
        if (!attached.length) throw new BadRequestException('Hình ảnh đã được dùng bởi một tin nhắn khác.');
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
        expiresAt: actor.kind === 'guest' ? actor.expiresAt : null,
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
    if (!target) throw new BadRequestException('Tin nhắn cuối đã đọc không hợp lệ.');
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
    if (!EMOJIS.includes(emoji)) throw new BadRequestException('Reaction không hợp lệ.');
    const [message] = await this.db.select({ roomId: messages.roomId }).from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!message) throw new NotFoundException('Tin nhắn không còn tồn tại.');
    await this.actors.assertRoomAccess(message.roomId, actor);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${messageId}:${actor.actorKey}:${emoji}`}, 0))`);
      if (actor.kind === 'guest') {
        const [valid] = await tx.select({ id: guestSessions.id }).from(guestSessions).where(and(eq(guestSessions.id, actor.id), gt(guestSessions.expiresAt, Date.now()))).for('update').limit(1);
        if (!valid) throw new UnauthorizedException('Phiên khách đã kết thúc.');
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
      const outboxId = await this.outbox.enqueue(tx, message.roomId, 'reaction.updated', { messageId, emoji, actorKey: actor.actorKey, reacted });
      return { reacted, outboxId };
    });
    await this.outbox.deliverIds([result.outboxId]);
    return { reacted: result.reacted };
  }

  async cleanupExpiredGuests() {
    const expired = await this.db.select({ id: guestSessions.id }).from(guestSessions).where(lt(guestSessions.expiresAt, Date.now())).limit(30);
    for (const guest of expired) await this.endGuestById(guest.id);
  }

  private async seedFirstRoom(actor: Extract<Actor, { kind: 'user' }>) {
    const [existing] = await this.db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, actor.id)).limit(1);
    if (existing) return;
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      const [room] = await tx.insert(rooms).values({ name: 'Minh Anh', kind: 'direct', createdBy: actor.id, inviteCode: this.makeCode(), allowGuests: true, createdAt: now }).returning({ id: rooms.id });
      await tx.insert(roomMembers).values({ roomId: room.id, userId: actor.id, role: 'owner', joinedAt: now });
      await tx.insert(messages).values([
        { roomId: room.id, senderName: 'Minh Anh', type: 'text', body: 'Chào mừng đến với Nét. Đây là nơi chữ và hình có thể tiếp tục câu chuyện cùng nhau.', createdAt: now + 1 },
        { roomId: room.id, senderId: actor.id, senderName: actor.displayName, type: 'text', body: 'Mình bắt đầu bằng một nét nhé ✨', createdAt: now + 2 },
      ]);
    });
  }

  private requireText(value: unknown, label: string, min: number, max: number) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new BadRequestException(`${label} phải có từ ${min} đến ${max} ký tự.`);
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
    if (!owned) throw new BadRequestException('Mã chống gửi trùng đã thuộc một yêu cầu khác.');
    if (message.type !== input.type || message.body !== input.body || message.assetKey !== input.assetKey
      || message.replyToId !== input.replyToId || message.canvasParentId !== input.canvasParentId) {
      throw new BadRequestException('Mã chống gửi trùng không thể dùng cho nội dung khác.');
    }
    return { id: message.id, sequence: message.sequence, createdAt: message.createdAt, canvasVersion: message.canvasVersion };
  }

  private makeCode(length = 20) { return crypto.randomUUID().replaceAll('-', '').slice(0, length); }
  private maskEmail(email: string) { const [name, domain] = email.split('@'); return domain ? `${name.slice(0, 2)}•••@${domain}` : email; }
}
