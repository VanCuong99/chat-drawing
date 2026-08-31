import { expect, test } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase, eq, inArray, rooms, users } from '@net/database';
import { e2eApiOrigin } from './e2e-environment';

const API_ORIGIN = e2eApiOrigin;
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
    const uploadId = randomUUID();
    const uploaded = await request.post(`${API_URL}/assets?room=${roomId}&uploadId=${uploadId}`, {
      headers: { authorization, 'content-type': 'image/png' },
      data: png,
    });
    expect(uploaded.status()).toBe(200);
    assetKey = ((await uploaded.json()) as { key: string }).key;
    expect(assetKey).toBe(uploadId);

    const sent = await request.post(`${API_URL}/rooms/${roomId}/messages`, {
      headers: { authorization },
      data: { type: 'image', assetKey, text: 'Ảnh có quyền truy cập' },
    });
    expect(sent.status()).toBe(200);

    const replayedUpload = await request.post(`${API_URL}/assets?room=${roomId}&uploadId=${uploadId}`, {
      headers: { authorization, 'content-type': 'image/png' },
      data: png,
    });
    expect(replayedUpload.status()).toBe(200);
    expect((await replayedUpload.json()).key).toBe(uploadId);
    const differentSameLengthPng = Buffer.from(png);
    differentSameLengthPng[differentSameLengthPng.length - 1] ^= 1;
    const conflictingReplay = await request.post(`${API_URL}/assets?room=${roomId}&uploadId=${uploadId}`, {
      headers: { authorization, 'content-type': 'image/png' },
      data: differentSameLengthPng,
    });
    expect(conflictingReplay.status()).toBe(400);

    const listed = await request.get(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization } });
    const image = ((await listed.json()).messages as Array<{ assetKey: string | null; assetUrl: string | null }>).find((message) => message.assetKey === assetKey);
    expect(image?.assetUrl).toMatch(new RegExp(`^/api/assets/${assetKey}\\?access=`));
    const accessToken = new URL(image!.assetUrl!, API_ORIGIN).searchParams.get('access');
    const accessClaims = JSON.parse(Buffer.from(accessToken!.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    expect(accessClaims).toMatchObject({ sub: userId, kind: 'user', roomId, assetKey, purpose: 'asset-read' });
    expect(accessClaims).not.toHaveProperty('email');
    expect(accessClaims).not.toHaveProperty('displayName');
    expect(accessClaims).not.toHaveProperty('actorKey');

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

test('lineage trả đủ chuỗi canvas trong room và không lộ cho người ngoài @critical', async ({ request }) => {
  const userId = `lineage-user-${Date.now()}`;
  const outsiderId = `lineage-outsider-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const outsiderAuthorization = `Bearer ${userToken(outsiderId)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for lineage E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const roomIds: string[] = [];
  const assetKeys: string[] = [];

  try {
    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization } });
    expect(bootstrap.status()).toBe(200);
    const roomId = ((await bootstrap.json()).rooms as Array<{ id: string }>)[0].id;
    roomIds.push(roomId);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7zWQAAAABJRU5ErkJggg==', 'base64');
    let parentId: string | null = null;
    let latestId = '';

    for (let version = 1; version <= 3; version += 1) {
      const uploaded = await request.post(`${API_URL}/assets?room=${roomId}`, {
        headers: { authorization, 'content-type': 'image/png' },
        data: png,
      });
      expect(uploaded.status()).toBe(200);
      const assetKey = ((await uploaded.json()) as { key: string }).key;
      assetKeys.push(assetKey);
      const sent = await request.post(`${API_URL}/rooms/${roomId}/messages`, {
        headers: { authorization },
        data: { type: 'canvas', assetKey, canvasParentId: parentId, text: `Bản ${version}` },
      });
      expect(sent.status()).toBe(200);
      const payload = await sent.json() as { id: string; canvasVersion: number };
      expect(payload.canvasVersion).toBe(version);
      parentId = payload.id;
      latestId = payload.id;
    }

    const lineageResponse = await request.get(`${API_URL}/rooms/${roomId}/messages/${latestId}/lineage`, { headers: { authorization } });
    expect(lineageResponse.status()).toBe(200);
    const lineage = (await lineageResponse.json()).lineage as Array<Record<string, unknown>>;
    expect(lineage).toHaveLength(3);
    expect(lineage.map((item) => item.canvasVersion)).toEqual([1, 2, 3]);
    expect(lineage[1].canvasParentId).toBe(lineage[0].id);
    expect(lineage[2].canvasParentId).toBe(lineage[1].id);
    expect(lineage.every((item) => typeof item.assetUrl === 'string' && String(item.assetUrl).includes('access='))).toBe(true);
    expect(lineage.every((item) => !('senderId' in item) && !('guestSessionId' in item) && !('email' in item))).toBe(true);

    const branchUpload = await request.post(`${API_URL}/assets?room=${roomId}`, {
      headers: { authorization, 'content-type': 'image/png' },
      data: png,
    });
    expect(branchUpload.status()).toBe(200);
    const branchAssetKey = ((await branchUpload.json()) as { key: string }).key;
    assetKeys.push(branchAssetKey);
    const branchSend = await request.post(`${API_URL}/rooms/${roomId}/messages`, {
      headers: { authorization },
      data: { type: 'canvas', assetKey: branchAssetKey, canvasParentId: lineage[0].id, text: 'Nhánh song song' },
    });
    expect(branchSend.status()).toBe(200);
    expect((await branchSend.json()).canvasVersion).toBe(2);
    const branchedLineageResponse = await request.get(`${API_URL}/rooms/${roomId}/messages/${latestId}/lineage`, { headers: { authorization } });
    const branchedLineage = (await branchedLineageResponse.json()).lineage as Array<Record<string, unknown>>;
    expect(branchedLineage).toHaveLength(4);
    expect(branchedLineage.filter((item) => item.canvasParentId === lineage[0].id && item.canvasVersion === 2)).toHaveLength(2);
    const messagesResponse = await request.get(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization } });
    const roomMessages = (await messagesResponse.json()).messages as Array<{ id: string; continuationCount: number }>;
    expect(roomMessages.find((item) => item.id === lineage[0].id)?.continuationCount).toBe(2);

    const outsiderBootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization: outsiderAuthorization } });
    roomIds.push(...((await outsiderBootstrap.json()).rooms as Array<{ id: string }>).map((item) => item.id));
    const forbidden = await request.get(`${API_URL}/rooms/${roomId}/messages/${latestId}/lineage`, { headers: { authorization: outsiderAuthorization } });
    expect(forbidden.status()).toBe(403);
  } finally {
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds));
    await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
    await Promise.all(assetKeys.map((key) => unlink(resolve('apps/api/.data/uploads', key)).catch(() => undefined)));
    await pool.end();
  }
});

test('ảnh nguồn tạo lineage canvas, giữ tombstone và context sau khi ảnh gốc bị xóa @critical', async ({ request }) => {
  const userId = `photo-lineage-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for photo lineage E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const assetKeys: string[] = [];
  let roomId = '';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7zWQAAAABJRU5ErkJggg==', 'base64');
  const upload = async () => {
    const response = await request.post(`${API_URL}/assets?room=${roomId}`, { headers: { authorization, 'content-type': 'image/png' }, data: png });
    expect(response.status()).toBe(200);
    const key = ((await response.json()) as { key: string }).key;
    assetKeys.push(key);
    return key;
  };

  try {
    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization } });
    roomId = ((await bootstrap.json()).rooms as Array<{ id: string }>)[0].id;
    const sourceKey = await upload();
    const sourceResponse = await request.post(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization }, data: { type: 'image', assetKey: sourceKey, text: 'Ảnh sản phẩm nguồn' } });
    expect(sourceResponse.status()).toBe(200);
    const sourceId = ((await sourceResponse.json()) as { id: string }).id;

    const versionOneKey = await upload();
    const versionOneResponse = await request.post(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization }, data: { type: 'canvas', assetKey: versionOneKey, canvasParentId: sourceId, text: 'Thêm chú thích' } });
    expect(versionOneResponse.status()).toBe(200);
    const versionOne = await versionOneResponse.json() as { id: string; canvasVersion: number };
    expect(versionOne.canvasVersion).toBe(1);

    const versionTwoKey = await upload();
    const versionTwoResponse = await request.post(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization }, data: { type: 'canvas', assetKey: versionTwoKey, canvasParentId: versionOne.id, text: 'Phương án tiếp theo' } });
    expect(versionTwoResponse.status()).toBe(200);
    const versionTwo = await versionTwoResponse.json() as { id: string; canvasVersion: number };
    expect(versionTwo.canvasVersion).toBe(2);

    const listedResponse = await request.get(`${API_URL}/rooms/${roomId}/messages`, { headers: { authorization } });
    const listed = (await listedResponse.json()).messages as Array<{ id: string; continuationCount: number; lineageRoot: { id: string; type: string; senderName: string } | null }>;
    expect(listed.find((item) => item.id === sourceId)?.continuationCount).toBe(1);
    expect(listed.find((item) => item.id === versionTwo.id)?.lineageRoot).toMatchObject({ id: sourceId, type: 'image', senderName: userId });

    const lineageResponse = await request.get(`${API_URL}/rooms/${roomId}/messages/${versionTwo.id}/lineage`, { headers: { authorization } });
    expect(lineageResponse.status()).toBe(200);
    const lineage = (await lineageResponse.json()).lineage as Array<{ id: string; type: string; canvasVersion: number | null; assetUrl: string | null; deletedAt: number | null }>;
    expect(lineage.map((item) => item.type)).toEqual(['image', 'canvas', 'canvas']);
    expect(lineage.map((item) => item.canvasVersion)).toEqual([null, 1, 2]);

    const deleted = await request.delete(`${API_URL}/rooms/${roomId}/messages/${sourceId}`, { headers: { authorization } });
    expect(deleted.status()).toBe(200);
    const afterDelete = await request.get(`${API_URL}/rooms/${roomId}/messages/${versionTwo.id}/lineage`, { headers: { authorization } });
    const tombstoned = (await afterDelete.json()).lineage as Array<{ id: string; assetUrl: string | null; deletedAt: number | null }>;
    expect(tombstoned[0]).toMatchObject({ id: sourceId, assetUrl: null });
    expect(tombstoned[0].deletedAt).toEqual(expect.any(Number));
    expect(tombstoned.slice(1).every((item) => typeof item.assetUrl === 'string')).toBe(true);
  } finally {
    if (roomId) await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(users).where(eq(users.id, userId));
    await Promise.all(assetKeys.map((key) => unlink(resolve('apps/api/.data/uploads', key)).catch(() => undefined)));
    await pool.end();
  }
});

test('ownership cho phép edit/delete cá nhân và owner quản lý People & Safety @critical', async ({ request }) => {
  const stamp = Date.now();
  const ownerId = `safety-owner-${stamp}`;
  const memberId = `safety-member-${stamp}`;
  const observerId = `safety-observer-${stamp}`;
  const ownerAuthorization = `Bearer ${userToken(ownerId)}`;
  const memberAuthorization = `Bearer ${userToken(memberId)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for safety E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const roomIds: string[] = [];
  try {
    const [ownerBootstrap, memberBootstrap, observerBootstrap] = await Promise.all([
      request.get(`${API_URL}/bootstrap`, { headers: { authorization: ownerAuthorization } }),
      request.get(`${API_URL}/bootstrap`, { headers: { authorization: memberAuthorization } }),
      request.get(`${API_URL}/bootstrap`, { headers: { authorization: `Bearer ${userToken(observerId)}` } }),
    ]);
    roomIds.push(...((await ownerBootstrap.json()).rooms as Array<{ id: string }>).map((room) => room.id));
    roomIds.push(...((await memberBootstrap.json()).rooms as Array<{ id: string }>).map((room) => room.id));
    roomIds.push(...((await observerBootstrap.json()).rooms as Array<{ id: string }>).map((room) => room.id));
    const created = await request.post(`${API_URL}/rooms`, { headers: { authorization: ownerAuthorization }, data: { name: 'Safety room', memberIds: [memberId, observerId], allowGuests: true } });
    expect(created.status()).toBe(200);
    const createdRoom = await created.json() as { id: string; inviteCode: string };
    roomIds.push(createdRoom.id);

    const people = await request.get(`${API_URL}/rooms/${createdRoom.id}/people`, { headers: { authorization: ownerAuthorization } });
    expect(people.status()).toBe(200);
    expect(await people.json()).toMatchObject({ currentRole: 'owner', canManage: true, muted: false });
    const muted = await request.patch(`${API_URL}/rooms/${createdRoom.id}/preferences`, { headers: { authorization: ownerAuthorization }, data: { muted: true } });
    expect(await muted.json()).toEqual({ muted: true });

    const sent = await request.post(`${API_URL}/rooms/${createdRoom.id}/messages`, { headers: { authorization: ownerAuthorization }, data: { type: 'text', text: 'Bản nháp cần sửa' } });
    const sentMessage = await sent.json() as { id: string; sequence: number };
    const messageId = sentMessage.id;
    await request.patch(`${API_URL}/rooms/${createdRoom.id}/messages`, { headers: { authorization: ownerAuthorization }, data: { messageId } });
    const incomingSequences: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const incoming = await request.post(`${API_URL}/rooms/${createdRoom.id}/messages`, { headers: { authorization: memberAuthorization }, data: { type: 'text', text: `Tin chưa đọc ${index + 1}` } });
      incomingSequences.push(((await incoming.json()) as { sequence: number }).sequence);
    }
    const returningBootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization: ownerAuthorization } });
    const returningRoom = ((await returningBootstrap.json()).rooms as Array<{ id: string; unreadCount: number; firstUnreadSequence: number }>).find((room) => room.id === createdRoom.id);
    expect(returningRoom).toMatchObject({ unreadCount: 3, firstUnreadSequence: incomingSequences[0] });
    const unreadPage = await request.get(`${API_URL}/rooms/${createdRoom.id}/messages?from=${incomingSequences[0]}`, { headers: { authorization: ownerAuthorization } });
    expect(((await unreadPage.json()).messages as Array<{ sequence: number }>)[0].sequence).toBe(incomingSequences[0]);
    expect((await request.patch(`${API_URL}/rooms/${createdRoom.id}/messages/${messageId}`, { headers: { authorization: memberAuthorization }, data: { text: 'Sửa trái phép' } })).status()).toBe(401);
    const edited = await request.patch(`${API_URL}/rooms/${createdRoom.id}/messages/${messageId}`, { headers: { authorization: ownerAuthorization }, data: { text: 'Nội dung đã sửa' } });
    expect(edited.status()).toBe(200);

    const report = await request.post(`${API_URL}/rooms/${createdRoom.id}/reports`, { headers: { authorization: memberAuthorization }, data: { reason: 'unsafe-content', messageId, reportedUserId: ownerId, details: 'Kiểm thử báo cáo' } });
    expect(report.status()).toBe(200);
    expect((await report.json()).received).toBe(true);
    expect((await request.post(`${API_URL}/rooms/${createdRoom.id}/invite/revoke`, { headers: { authorization: memberAuthorization } })).status()).toBe(401);
    const revoked = await request.post(`${API_URL}/rooms/${createdRoom.id}/invite/revoke`, { headers: { authorization: ownerAuthorization } });
    expect(revoked.status()).toBe(200);
    expect((await request.get(`${API_URL}/invites/${createdRoom.inviteCode}`)).status()).toBe(404);

    const removedMessage = await request.delete(`${API_URL}/rooms/${createdRoom.id}/messages/${messageId}`, { headers: { authorization: ownerAuthorization } });
    expect(removedMessage.status()).toBe(200);
    const history = await request.get(`${API_URL}/rooms/${createdRoom.id}/messages`, { headers: { authorization: ownerAuthorization } });
    const tombstone = ((await history.json()).messages as Array<{ id: string; body: string | null; deletedAt: number | null }>).find((message) => message.id === messageId);
    expect(tombstone).toMatchObject({ id: messageId, body: null });
    expect(tombstone?.deletedAt).toEqual(expect.any(Number));

    expect((await request.post(`${API_URL}/users/${memberId}/block`, { headers: { authorization: ownerAuthorization } })).status()).toBe(200);
    const search = await request.get(`${API_URL}/users?q=safety-member`, { headers: { authorization: ownerAuthorization } });
    expect((await search.json()).users).toEqual([]);
    expect((await request.delete(`${API_URL}/rooms/${createdRoom.id}/members/${memberId}`, { headers: { authorization: ownerAuthorization } })).status()).toBe(200);
    expect((await request.get(`${API_URL}/rooms/${createdRoom.id}/people`, { headers: { authorization: memberAuthorization } })).status()).toBe(403);
  } finally {
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, [...new Set(roomIds)]));
    await db.delete(users).where(inArray(users.id, [ownerId, memberId, observerId]));
    await pool.end();
  }
});
