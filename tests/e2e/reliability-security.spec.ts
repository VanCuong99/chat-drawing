import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { createDatabase, eq, messages, realtimeOutbox } from '@net/database';

const apiOrigin = 'http://localhost:3001';

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
    await pool.end();
  }
});

test('sequence giữ đúng pagination/read khi message đến đồng thời @critical', async ({ request }) => {
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
  }
});

test('outbox worker phát lại event pending và đánh dấu published @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for outbox E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const guest = await createGuest(request, `Outbox ${Date.now()}`);
  const headers = { 'x-net-guest-session': guest.sessionId };
  const socket = await connectGuest(request, guest.sessionId);
  let outboxId = '';

  try {
    await waitConnected(socket);
    await expect(subscribe(socket, guest.roomId)).resolves.toEqual({ ok: true, roomId: guest.roomId });
    const received = new Promise<{ eventId: string; messageId: string }>((resolve) => socket.once('message.created', resolve));
    const now = Date.now();
    const [inserted] = await db.insert(realtimeOutbox).values({
      roomId: guest.roomId,
      event: 'message.created',
      payload: { roomId: guest.roomId, messageId: 'recovery-probe' },
      createdAt: now,
      availableAt: now,
    }).returning({ id: realtimeOutbox.id });
    outboxId = inserted.id;
    await expect(received).resolves.toMatchObject({ eventId: outboxId, messageId: 'recovery-probe' });
    await expect.poll(async () => (await db.select({ publishedAt: realtimeOutbox.publishedAt }).from(realtimeOutbox).where(eq(realtimeOutbox.id, outboxId)))[0]?.publishedAt ?? null).not.toBeNull();
  } finally {
    socket.disconnect();
    if (outboxId) await db.delete(realtimeOutbox).where(eq(realtimeOutbox.id, outboxId));
    await request.delete(`${apiOrigin}/api/guest`, { headers });
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
