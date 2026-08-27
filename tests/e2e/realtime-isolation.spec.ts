import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { createDatabase, eq, inArray, rooms, users } from '@net/database';

const apiOrigin = 'http://localhost:3001';

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated realtime E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

async function createGuest(request: APIRequestContext, displayName: string) {
  const response = await request.post(`${apiOrigin}/api/guest`, { data: { displayName } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ sessionId: string; roomId: string }>;
}

async function connectGuest(request: APIRequestContext, sessionId: string) {
  const tokenResponse = await request.post(`${apiOrigin}/api/realtime/token`, { headers: { 'x-net-guest-session': sessionId } });
  expect(tokenResponse.ok()).toBe(true);
  const { token } = await tokenResponse.json() as { token: string };
  const socket = io(`${apiOrigin}/chat`, { path: '/socket.io', transports: ['websocket'], auth: { token }, forceNew: true, extraHeaders: { origin: 'http://localhost:3000' } });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

async function subscribe(socket: Socket, roomId: string) {
  return new Promise<{ ok: boolean; roomId?: string }>((resolve) => socket.emit('room.subscribe', { roomId }, resolve));
}

test('WebSocket chỉ phát message vào đúng room đã được cấp quyền @critical', async ({ request }) => {
  const guestA = await createGuest(request, `Realtime A ${Date.now()}`);
  const guestB = await createGuest(request, `Realtime B ${Date.now()}`);
  const [socketA, socketB] = await Promise.all([
    connectGuest(request, guestA.sessionId),
    connectGuest(request, guestB.sessionId),
  ]);
  const eventsA: Array<{ roomId: string; messageId: string }> = [];
  const eventsB: Array<{ roomId: string; messageId: string }> = [];
  socketA.on('message.created', (event) => eventsA.push(event));
  socketB.on('message.created', (event) => eventsB.push(event));

  try {
    await expect(subscribe(socketA, guestA.roomId)).resolves.toEqual({ ok: true, roomId: guestA.roomId });
    await expect(subscribe(socketB, guestB.roomId)).resolves.toEqual({ ok: true, roomId: guestB.roomId });
    await expect(subscribe(socketB, guestA.roomId)).resolves.toMatchObject({ ok: false });

    const sent = await request.post(`${apiOrigin}/api/rooms/${guestA.roomId}/messages`, {
      headers: { 'x-net-guest-session': guestA.sessionId },
      data: { type: 'text', text: 'Chỉ phòng A được nhận' },
    });
    expect(sent.ok()).toBe(true);
    await expect.poll(() => eventsA.length, { timeout: 3000 }).toBe(1);
    expect(eventsA[0].roomId).toBe(guestA.roomId);

    // A short negative window proves the server did not broadcast the room-A event globally.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(eventsB).toEqual([]);

    const disconnected = new Promise<void>((resolve) => socketB.once('disconnect', () => resolve()));
    const ended = await request.delete(`${apiOrigin}/api/guest`, { headers: { 'x-net-guest-session': guestB.sessionId } });
    expect(ended.ok()).toBe(true);
    await expect(disconnected).resolves.toBeUndefined();
    expect(socketB.connected).toBe(false);
  } finally {
    socketA.disconnect();
    socketB.disconnect();
    await Promise.all([
      request.delete(`${apiOrigin}/api/guest`, { headers: { 'x-net-guest-session': guestA.sessionId } }),
      request.delete(`${apiOrigin}/api/guest`, { headers: { 'x-net-guest-session': guestB.sessionId } }),
    ]);
  }
});

test('actor channel báo unread cho phòng nền nhưng không phát message.created sai phòng @critical', async ({ request }) => {
  const userId = `realtime-user-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for realtime E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const roomIds: string[] = [];
  let socket: Socket | null = null;

  try {
    const activeRoom = await request.post(`${apiOrigin}/api/rooms`, {
      headers: { authorization },
      data: { name: 'Phòng đang mở realtime', allowGuests: true },
    });
    expect(activeRoom.status()).toBe(200);
    const activeRoomId = ((await activeRoom.json()) as { id: string }).id;
    roomIds.push(activeRoomId);
    const created = await request.post(`${apiOrigin}/api/rooms`, {
      headers: { authorization },
      data: { name: 'Phòng nền realtime', allowGuests: true },
    });
    expect(created.status()).toBe(200);
    const backgroundRoomId = ((await created.json()) as { id: string }).id;
    roomIds.push(backgroundRoomId);

    const tokenResponse = await request.post(`${apiOrigin}/api/realtime/token`, { headers: { authorization } });
    const { token } = await tokenResponse.json() as { token: string };
    socket = io(`${apiOrigin}/chat`, { path: '/socket.io', transports: ['websocket'], auth: { token }, forceNew: true, extraHeaders: { origin: 'http://localhost:3000' } });
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', resolve);
      socket!.once('connect_error', reject);
    });
    await expect(subscribe(socket, activeRoomId)).resolves.toEqual({ ok: true, roomId: activeRoomId });

    const messageEvents: Array<{ roomId: string }> = [];
    const activityEvents: Array<{ roomId: string; sourceEvent: string }> = [];
    socket.on('message.created', (event) => messageEvents.push(event));
    socket.on('room.activity', (event) => activityEvents.push(event));

    const sent = await request.post(`${apiOrigin}/api/rooms/${backgroundRoomId}/messages`, {
      headers: { authorization },
      data: { type: 'text', text: 'Tin ở phòng nền' },
    });
    expect(sent.status()).toBe(200);
    await expect.poll(() => activityEvents.some((event) => (
      event.roomId === backgroundRoomId && event.sourceEvent === 'message.created'
    ))).toBe(true);
    expect(messageEvents).toEqual([]);
  } finally {
    socket?.disconnect();
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  }
});
