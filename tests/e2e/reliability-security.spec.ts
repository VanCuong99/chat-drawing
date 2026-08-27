import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { and, createDatabase, eq, guestSessions, inArray, messages, realtimeOutbox, roomMembers, rooms, sql, users } from '@net/database';

const apiOrigin = 'http://localhost:3001';

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated reliability E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

async function createGuest(request: APIRequestContext, name: string, inviteCode?: string) {
  const response = await request.post(`${apiOrigin}/api/guest`, { data: { displayName: name, inviteCode } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{ sessionId: string; roomId: string }>;
}

async function connectGuest(request: APIRequestContext, sessionId: string, includeOrigin = true) {
  const tokenResponse = await request.post(`${apiOrigin}/api/realtime/token`, { headers: { 'x-net-guest-session': sessionId } });
  expect(tokenResponse.status()).toBe(200);
  const { token } = await tokenResponse.json() as { token: string };
  return io(`${apiOrigin}/chat`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    reconnection: false,
    timeout: 2_000,
    ...(includeOrigin ? { extraHeaders: { Origin: 'http://localhost:3000' } } : {}),
  });
}

async function waitConnected(socket: Socket) {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

async function subscribe(socket: Socket, roomId: string) {
  return new Promise<{ ok: boolean; roomId?: string }>((resolve) => socket.emit('room.subscribe', { roomId }, resolve));
}

test('retry đồng thời chỉ tạo một message và một realtime event @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for reliability E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const guest = await createGuest(request, `Idempotent ${Date.now()}`);
  const headers = { 'x-net-guest-session': guest.sessionId };
  const socket = await connectGuest(request, guest.sessionId);
  const events: Array<{ messageId: string; eventId: string }> = [];

  try {
    await waitConnected(socket);
    await expect(subscribe(socket, guest.roomId)).resolves.toEqual({ ok: true, roomId: guest.roomId });
    socket.on('message.created', (event) => events.push(event));
    const clientRequestId = randomUUID();
    const responses = await Promise.all([0, 1].map(() => request.post(`${apiOrigin}/api/rooms/${guest.roomId}/messages`, {
      headers,
      data: { type: 'text', text: 'Một lần bấm, hai lần retry', clientRequestId },
    })));
    expect(responses.map((response) => response.status())).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string; sequence: number }>));
    expect(payloads[1]).toMatchObject({ id: payloads[0].id, sequence: payloads[0].sequence });
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.clientRequestId, clientRequestId))).toHaveLength(1);
    await expect.poll(() => events.filter((event) => event.messageId === payloads[0].id).length).toBe(1);
    const conflictingRetry = await request.post(`${apiOrigin}/api/rooms/${guest.roomId}/messages`, {
      headers,
      data: { type: 'text', text: 'Nội dung khác', clientRequestId },
    });
    expect(conflictingRetry.status()).toBe(400);
    await expect(conflictingRetry.json()).resolves.toMatchObject({ error: expect.stringContaining('nội dung khác') });
  } finally {
    socket.disconnect();
    await request.delete(`${apiOrigin}/api/guest`, { headers });
    await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    await pool.end();
  }
});

test('sequence giữ đúng pagination/read khi message đến đồng thời @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for sequence E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const stamp = Date.now();
  const guestA = await createGuest(request, `Sequence A ${stamp}`);
  const headersA = { 'x-net-guest-session': guestA.sessionId };
  const bootstrap = await request.get(`${apiOrigin}/api/bootstrap`, { headers: headersA });
  const inviteCode = ((await bootstrap.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const guestB = await createGuest(request, `Sequence B ${stamp}`, inviteCode);
  const headersB = { 'x-net-guest-session': guestB.sessionId };

  try {
    const sent = await Promise.all(['Một', 'Hai', 'Ba'].map((text) => request.post(`${apiOrigin}/api/rooms/${guestA.roomId}/messages`, {
      headers: headersA,
      data: { type: 'text', text, clientRequestId: randomUUID() },
    })));
    const created = await Promise.all(sent.map((response) => response.json() as Promise<{ id: string; sequence: number }>));
    const ordered = [...created].sort((left, right) => left.sequence - right.sequence);
    expect(new Set(ordered.map((message) => message.sequence)).size).toBe(3);

    const listed = await request.get(`${apiOrigin}/api/rooms/${guestA.roomId}/messages`, { headers: headersB });
    const listedMessages = ((await listed.json()).messages as Array<{ id: string; sequence: number }>).filter((message) => created.some((item) => item.id === message.id));
    expect(listedMessages.map((message) => message.sequence)).toEqual(ordered.map((message) => message.sequence));

    const marked = await request.patch(`${apiOrigin}/api/rooms/${guestA.roomId}/messages`, {
      headers: headersB,
      data: { messageId: ordered[1].id },
    });
    expect(marked.status()).toBe(200);
    const after = await request.get(`${apiOrigin}/api/rooms/${guestA.roomId}/messages`, { headers: headersA });
    const readCounts = new Map(((await after.json()).messages as Array<{ id: string; readCount: number }>).map((message) => [message.id, message.readCount]));
    expect(readCounts.get(ordered[0].id)).toBe(1);
    expect(readCounts.get(ordered[1].id)).toBe(1);
    expect(readCounts.get(ordered[2].id)).toBe(0);
  } finally {
    await Promise.all([
      request.delete(`${apiOrigin}/api/guest`, { headers: headersA }),
      request.delete(`${apiOrigin}/api/guest`, { headers: headersB }),
    ]);
    await db.delete(rooms).where(eq(rooms.id, guestA.roomId));
    await pool.end();
  }
});

test('join, guest send và end dùng cùng room lock, không để nội dung shared hết hạn @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for room lock E2E');
  const { db, pool } = createDatabase(databaseUrl, 3);
  const guest = await createGuest(request, `Room lock ${Date.now()}`);
  const guestHeaders = { 'x-net-guest-session': guest.sessionId };
  const bootstrap = await request.get(`${apiOrigin}/api/bootstrap`, { headers: guestHeaders });
  const inviteCode = ((await bootstrap.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const userId = `room-lock-user-${Date.now()}`;
  const userHeaders = { authorization: `Bearer ${userToken(userId)}` };
  const lockClient = await pool.connect();

  try {
    await lockClient.query('begin');
    await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [guest.roomId]);
    let sendSettled = false;
    let joinSettled = false;
    const sendPromise = request.post(`${apiOrigin}/api/rooms/${guest.roomId}/messages`, {
      headers: guestHeaders,
      data: { type: 'text', text: 'Tin guest đồng thời lúc user join', clientRequestId: randomUUID() },
    }).finally(() => { sendSettled = true; });
    const joinPromise = request.post(`${apiOrigin}/api/rooms/join`, {
      headers: userHeaders,
      data: { inviteCode },
    }).finally(() => { joinSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sendSettled).toBe(false);
    expect(joinSettled).toBe(false);
    await lockClient.query('commit');
    const [sent, joined] = await Promise.all([sendPromise, joinPromise]);
    expect(sent.status()).toBe(200);
    expect(joined.status()).toBe(200);
    const sentId = ((await sent.json()) as { id: string }).id;
    await expect.poll(async () => (await db.select({ expiresAt: messages.expiresAt }).from(messages)
      .where(eq(messages.id, sentId)))[0]?.expiresAt).toBeNull();
    expect(await db.select({ roomId: roomMembers.roomId }).from(roomMembers)
      .where(and(eq(roomMembers.roomId, guest.roomId), eq(roomMembers.userId, userId)))).toHaveLength(1);

    await lockClient.query('begin');
    await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [guest.roomId]);
    let finalSendSettled = false;
    let endSettled = false;
    const finalSendPromise = request.post(`${apiOrigin}/api/rooms/${guest.roomId}/messages`, {
      headers: guestHeaders,
      data: { type: 'text', text: 'Tin guest đồng thời lúc end', clientRequestId: randomUUID() },
    }).finally(() => { finalSendSettled = true; });
    const endPromise = request.delete(`${apiOrigin}/api/guest`, { headers: guestHeaders })
      .finally(() => { endSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(finalSendSettled).toBe(false);
    expect(endSettled).toBe(false);
    await lockClient.query('commit');
    const [finalSend, ended] = await Promise.all([finalSendPromise, endPromise]);
    expect([200, 401]).toContain(finalSend.status());
    expect(ended.status()).toBe(200);
    const retained = await db.select({ guestSessionId: messages.guestSessionId, expiresAt: messages.expiresAt })
      .from(messages).where(eq(messages.roomId, guest.roomId));
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((message) => message.guestSessionId === null && message.expiresAt === null)).toBe(true);
  } finally {
    await lockClient.query('rollback').catch(() => undefined);
    lockClient.release();
    await request.delete(`${apiOrigin}/api/guest`, { headers: guestHeaders }).catch(() => undefined);
    await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  }
});

test('guest mới vẫn join được đúng phòng khi guest trước kết thúc đồng thời @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest cleanup lock E2E');
  const { db, pool } = createDatabase(databaseUrl, 3);
  const firstGuest = await createGuest(request, `Cleanup first ${Date.now()}`);
  const firstHeaders = { 'x-net-guest-session': firstGuest.sessionId };
  const bootstrap = await request.get(`${apiOrigin}/api/bootstrap`, { headers: firstHeaders });
  const inviteCode = ((await bootstrap.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const lockClient = await pool.connect();
  let secondSessionId = '';

  try {
    await lockClient.query('begin');
    await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [firstGuest.roomId]);
    let endSettled = false;
    let joinSettled = false;
    const endPromise = request.delete(`${apiOrigin}/api/guest`, { headers: firstHeaders })
      .finally(() => { endSettled = true; });
    const joinPromise = request.post(`${apiOrigin}/api/guest`, {
      data: { displayName: `Cleanup second ${Date.now()}`, inviteCode },
    }).finally(() => { joinSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(endSettled).toBe(false);
    expect(joinSettled).toBe(false);
    await lockClient.query('commit');
    const [ended, joined] = await Promise.all([endPromise, joinPromise]);
    expect(ended.status()).toBe(200);
    expect(joined.status()).toBe(200);
    const joinedBody = await joined.json() as { sessionId: string; roomId: string };
    secondSessionId = joinedBody.sessionId;
    expect(joinedBody.roomId).toBe(firstGuest.roomId);
    const verified = await request.get(`${apiOrigin}/api/bootstrap`, {
      headers: { 'x-net-guest-session': secondSessionId },
    });
    expect(verified.status()).toBe(200);
    await expect(verified.json()).resolves.toMatchObject({ actor: { id: secondSessionId, kind: 'guest' } });
    expect(await db.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.id, secondSessionId))).toHaveLength(1);
  } finally {
    await lockClient.query('rollback').catch(() => undefined);
    lockClient.release();
    if (secondSessionId) {
      await request.delete(`${apiOrigin}/api/guest`, { headers: { 'x-net-guest-session': secondSessionId } }).catch(() => undefined);
    }
    await request.delete(`${apiOrigin}/api/guest`, { headers: firstHeaders }).catch(() => undefined);
    await db.delete(realtimeOutbox).where(eq(realtimeOutbox.roomId, firstGuest.roomId));
    await db.delete(rooms).where(eq(rooms.id, firstGuest.roomId));
    await pool.end();
  }
});

test('một drain phát hết backlog lớn hơn một batch và đánh dấu published @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for outbox E2E');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new Error('CRON_SECRET is required for outbox E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const guest = await createGuest(request, `Outbox ${Date.now()}`);
  const headers = { 'x-net-guest-session': guest.sessionId };
  const socket = await connectGuest(request, guest.sessionId);
  let outboxIds: string[] = [];

  try {
    await waitConnected(socket);
    await expect(subscribe(socket, guest.roomId)).resolves.toEqual({ ok: true, roomId: guest.roomId });
    const receivedIds = new Set<string>();
    socket.on('message.created', (event: { eventId: string }) => receivedIds.add(event.eventId));
    const now = Date.now();
    const inserted = await db.insert(realtimeOutbox).values(Array.from({ length: 51 }, (_, index) => ({
      roomId: guest.roomId,
      event: 'message.created' as const,
      payload: { roomId: guest.roomId, messageId: `recovery-probe-${index}` },
      createdAt: now + index,
      availableAt: now,
    }))).returning({ id: realtimeOutbox.id });
    outboxIds = inserted.map((row) => row.id);
    expect((await request.get(`${apiOrigin}/api/maintenance`, {
      headers: { authorization: `Bearer ${cronSecret}` },
    })).status()).toBe(200);
    await expect.poll(async () => (await db.select({ publishedAt: realtimeOutbox.publishedAt })
      .from(realtimeOutbox).where(inArray(realtimeOutbox.id, outboxIds)))
      .filter((row) => row.publishedAt !== null).length, { timeout: 15_000 }).toBe(51);
    await expect.poll(() => receivedIds.size, { timeout: 15_000 }).toBe(51);
  } finally {
    socket.disconnect();
    if (outboxIds.length) await db.delete(realtimeOutbox).where(inArray(realtimeOutbox.id, outboxIds));
    await request.delete(`${apiOrigin}/api/guest`, { headers });
    await pool.end();
  }
});

test('event mutation hiện tại được ưu tiên, không chờ toàn bộ outbox backlog @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for outbox priority E2E');
  const { db, pool } = createDatabase(databaseUrl, 2);
  const guest = await createGuest(request, `Outbox priority ${Date.now()}`);
  const headers = { 'x-net-guest-session': guest.sessionId };
  let backlogIds: string[] = [];

  try {
    const now = Date.now();
    const backlog = await db.insert(realtimeOutbox).values(Array.from({ length: 201 }, (_, index) => ({
      roomId: guest.roomId,
      event: 'room.updated' as const,
      payload: { backlogProbe: true, index },
      createdAt: now + index,
      availableAt: now,
    }))).returning({ id: realtimeOutbox.id });
    backlogIds = backlog.map((row) => row.id);
    const sent = await request.post(`${apiOrigin}/api/rooms/${guest.roomId}/messages`, {
      headers,
      data: { type: 'text', text: 'Event mới phải được phát trước backlog', clientRequestId: randomUUID() },
      timeout: 5_000,
    });
    expect(sent.status()).toBe(200);
    const messageId = ((await sent.json()) as { id: string }).id;
    await expect.poll(async () => (await db.select({ publishedAt: realtimeOutbox.publishedAt })
      .from(realtimeOutbox).where(sql`${realtimeOutbox.payload}->>'messageId' = ${messageId}`))[0]?.publishedAt ?? null).not.toBeNull();
    const publishedBacklog = (await db.select({ publishedAt: realtimeOutbox.publishedAt })
      .from(realtimeOutbox).where(inArray(realtimeOutbox.id, backlogIds)))
      .filter((row) => row.publishedAt !== null).length;
    expect(publishedBacklog).toBeLessThanOrEqual(100);
  } finally {
    await db.delete(realtimeOutbox).where(eq(realtimeOutbox.roomId, guest.roomId));
    await request.delete(`${apiOrigin}/api/guest`, { headers }).catch(() => undefined);
    await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    await pool.end();
  }
});

test('request ID được echo còn WebSocket thiếu Origin bị từ chối @critical', async ({ request }) => {
  const requestId = `e2e-request-${Date.now()}`;
  const invalid = await request.post(`${apiOrigin}/api/guest`, {
    headers: { 'x-request-id': requestId },
    data: { displayName: 'x' },
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()['x-request-id']).toBe(requestId);
  await expect(invalid.json()).resolves.toMatchObject({ requestId });

  const guest = await createGuest(request, `Origin ${Date.now()}`);
  const headers = { 'x-net-guest-session': guest.sessionId };
  const socket = await connectGuest(request, guest.sessionId, false);
  try {
    const error = await new Promise<Error>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('Socket without Origin unexpectedly connected')));
      socket.once('connect_error', resolve);
    });
    expect(error.message).toBeTruthy();
    expect(socket.connected).toBe(false);
  } finally {
    socket.disconnect();
    await request.delete(`${apiOrigin}/api/guest`, { headers });
  }
});
