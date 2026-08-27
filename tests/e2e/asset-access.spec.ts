import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase, eq, rooms, users } from '@net/database';

const API_ORIGIN = 'http://localhost:3001';
const API_URL = `${API_ORIGIN}/api`;

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated asset E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test('signed asset URL hoạt động trong img và không nhận guest credential từ query @critical', async ({ request }) => {
  const userId = `asset-user-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for asset E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  let roomId = '';
  let assetKey = '';
  let guestSessionId = '';

  try {
    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization } });
    expect(bootstrap.status()).toBe(200);
    roomId = ((await bootstrap.json()).rooms as Array<{ id: string }>)[0].id;

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7zWQAAAABJRU5ErkJggg==', 'base64');
    const uploaded = await request.post(`${API_URL}/assets?room=${roomId}`, {
      headers: { authorization, 'content-type': 'image/png' },
      data: png,
    });
    expect(uploaded.status()).toBe(200);
    assetKey = ((await uploaded.json()) as { key: string }).key;

    const sent = await request.post(`${API_URL}/rooms/${roomId}/messages`, {
      headers: { authorization },
      data: { type: 'image', assetKey, text: 'Ảnh có quyền truy cập' },
    });
    expect(sent.status()).toBe(200);

    const listed = await request.get(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization } });
    const image = ((await listed.json()).messages as Array<{ assetKey: string | null; assetUrl: string | null }>).find((message) => message.assetKey === assetKey);
    expect(image?.assetUrl).toMatch(new RegExp(`^/api/assets/${assetKey}\\?access=`));

    const signedAsset = await request.get(new URL(image!.assetUrl!, API_ORIGIN).toString());
    expect(signedAsset.status()).toBe(200);
    expect(signedAsset.headers()['content-type']).toContain('image/png');
    expect(await signedAsset.body()).toEqual(png);
    expect((await request.get(`${API_URL}/assets/${assetKey}`)).status()).toBe(401);

    const tampered = new URL(image!.assetUrl!, API_ORIGIN);
    tampered.searchParams.set('access', `${tampered.searchParams.get('access')}x`);
    expect((await request.get(tampered.toString())).status()).toBe(401);
    const refreshed = await request.get(`${API_URL}/assets/${assetKey}/access`, { headers: { authorization } });
    expect(refreshed.status()).toBe(200);
    const refreshedUrl = ((await refreshed.json()) as { assetUrl: string }).assetUrl;
    expect((await request.get(new URL(refreshedUrl, API_ORIGIN).toString())).status()).toBe(200);

    const guest = await request.post(`${API_URL}/guest`, { data: { displayName: 'Query credential probe' } });
    expect(guest.status()).toBe(200);
    guestSessionId = ((await guest.json()) as { sessionId: string }).sessionId;
    const leakedBootstrap = await request.get(`${API_URL}/bootstrap?session=${guestSessionId}`);
    await expect(leakedBootstrap.json()).resolves.toEqual({ actor: null, rooms: [] });
    expect((await request.post(`${API_URL}/guest/activity?session=${guestSessionId}`)).status()).toBe(401);
  } finally {
    if (guestSessionId) await request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': guestSessionId } });
    if (roomId) await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(users).where(eq(users.id, userId));
    if (assetKey) await unlink(resolve('apps/api/.data/uploads', assetKey)).catch(() => undefined);
    await pool.end();
  }
});
