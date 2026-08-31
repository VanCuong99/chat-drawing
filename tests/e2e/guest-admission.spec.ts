import { expect, test } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import {
  createDatabase,
  eq,
  guestRequests,
  guestSessions,
  roomMembers,
  rooms,
  users,
} from '@net/database';
import { e2eApiOrigin } from './e2e-environment';

const API_URL = `${e2eApiOrigin}/api`;

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for guest admission E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test('approval invite keeps the room private until an owner grants and the guest claims access @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest admission E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const stamp = Date.now();
  const ownerId = `admission-owner-${stamp}`;
  const memberId = `admission-member-${stamp}`;
  const inviteCode = `approval-${stamp}`;
  const now = Date.now();
  const ownerHeaders = { authorization: `Bearer ${userToken(ownerId)}` };
  const memberHeaders = { authorization: `Bearer ${userToken(memberId)}` };
  let roomId = '';

  try {
    await db.insert(users).values([
      { id: ownerId, email: `${ownerId}@example.test`, displayName: 'Admission Owner', avatarColor: '#6D4AFF', createdAt: now, updatedAt: now },
      { id: memberId, email: `${memberId}@example.test`, displayName: 'Admission Member', avatarColor: '#EA5A8D', createdAt: now, updatedAt: now },
    ]);
    const [room] = await db.insert(rooms).values({
      name: 'Private sketch room',
      kind: 'group',
      createdBy: ownerId,
      inviteCode,
      allowGuests: true,
      guestAdmissionPolicy: 'approval',
      inviteMaxUses: 3,
      createdAt: now,
    }).returning({ id: rooms.id });
    roomId = room.id;
    await db.insert(roomMembers).values([
      { roomId, userId: ownerId, role: 'owner', joinedAt: now },
      { roomId, userId: memberId, role: 'member', joinedAt: now },
    ]);
    expect((await request.get(`${API_URL}/bootstrap`, { headers: ownerHeaders })).status()).toBe(200);
    expect((await request.get(`${API_URL}/bootstrap`, { headers: memberHeaders })).status()).toBe(200);

    const preflight = await request.get(`${API_URL}/invites/${inviteCode}`);
    expect(preflight.status()).toBe(200);
    await expect(preflight.json()).resolves.toMatchObject({ guestAdmissionPolicy: 'approval', requestExpiresInHours: 24 });

    const bypass = await request.post(`${API_URL}/guest`, { data: { displayName: 'Bypass Guest', inviteCode } });
    expect(bypass.status()).toBe(404);

    const requested = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, {
      data: { displayName: 'Lan Guest', introduction: 'I would like to continue the cover sketch.' },
    });
    expect(requested.status()).toBe(200);
    const pending = await requested.json() as { id: string; requestToken: string; status: string; duplicate: boolean };
    expect(pending).toMatchObject({ status: 'pending', duplicate: false });
    expect(pending.requestToken.length).toBeGreaterThanOrEqual(32);
    expect(await db.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.roomId, roomId))).toHaveLength(0);

    const repeated = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, {
      data: { displayName: 'Lan Guest', introduction: 'Retry', requestToken: pending.requestToken },
    });
    expect(repeated.status()).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ id: pending.id, status: 'pending', duplicate: true });
    expect(await db.select({ id: guestRequests.id }).from(guestRequests).where(eq(guestRequests.roomId, roomId))).toHaveLength(1);

    const memberQueue = await request.get(`${API_URL}/rooms/${roomId}/guest-requests`, { headers: memberHeaders });
    expect(memberQueue.status()).toBe(401);
    const ownerQueue = await request.get(`${API_URL}/rooms/${roomId}/guest-requests`, { headers: ownerHeaders });
    expect(ownerQueue.status()).toBe(200);
    await expect(ownerQueue.json()).resolves.toMatchObject({ pendingCount: 1, requests: [{ id: pending.id, status: 'pending', inviteCodeHint: inviteCode.slice(-6).toUpperCase(), expiresAt: expect.any(Number) }] });

    const approvals = await Promise.all([0, 1].map(() => request.post(`${API_URL}/rooms/${roomId}/guest-requests/${pending.id}/approve`, { headers: ownerHeaders })));
    expect(approvals.map((response) => response.status())).toEqual([200, 200]);
    expect((await db.select({ inviteUseCount: rooms.inviteUseCount }).from(rooms).where(eq(rooms.id, roomId)))[0].inviteUseCount).toBe(1);
    expect(await db.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.roomId, roomId))).toHaveLength(0);

    const approvedStatus = await request.get(`${API_URL}/guest-requests/${pending.id}/status`, {
      headers: { 'x-net-guest-request': pending.requestToken },
    });
    expect(approvedStatus.status()).toBe(200);
    await expect(approvedStatus.json()).resolves.toMatchObject({ status: 'approved', canClaim: true });
    const wrongStatus = await request.get(`${API_URL}/guest-requests/${pending.id}/status`, {
      headers: { 'x-net-guest-request': randomBytes(32).toString('base64url') },
    });
    expect(wrongStatus.status()).toBe(404);

    const claimed = await request.post(`${API_URL}/guest-requests/${pending.id}/claim`, {
      headers: { 'x-net-guest-request': pending.requestToken },
    });
    expect(claimed.status()).toBe(200);
    const session = await claimed.json() as { sessionId: string; roomId: string; expiresAt: number };
    expect(session.roomId).toBe(roomId);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(119 * 60 * 1000);
    expect(session.expiresAt - Date.now()).toBeLessThanOrEqual(120 * 60 * 1000);
    const claimedAgain = await request.post(`${API_URL}/guest-requests/${pending.id}/claim`, {
      headers: { 'x-net-guest-request': pending.requestToken },
    });
    expect(claimedAgain.status()).toBe(200);
    expect(((await claimedAgain.json()) as { sessionId: string }).sessionId).toBe(session.sessionId);
    const guestBootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { 'x-net-guest-session': session.sessionId } });
    expect(guestBootstrap.status()).toBe(200);
    expect(((await guestBootstrap.json()).rooms as Array<{ id: string }>).map((item) => item.id)).toContain(roomId);

    const second = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, { data: { displayName: 'Mai Guest' } });
    const secondRequest = await second.json() as { id: string; requestToken: string };
    expect((await request.post(`${API_URL}/rooms/${roomId}/guest-requests/${secondRequest.id}/approve`, { headers: ownerHeaders })).status()).toBe(200);
    expect((await request.post(`${API_URL}/rooms/${roomId}/guest-requests/${secondRequest.id}/revoke`, { headers: ownerHeaders })).status()).toBe(200);
    expect((await db.select({ inviteUseCount: rooms.inviteUseCount }).from(rooms).where(eq(rooms.id, roomId)))[0].inviteUseCount).toBe(1);
    const revokedStatus = await request.get(`${API_URL}/guest-requests/${secondRequest.id}/status`, { headers: { 'x-net-guest-request': secondRequest.requestToken } });
    await expect(revokedStatus.json()).resolves.toMatchObject({ status: 'rejected', canClaim: false });

    const declined = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, { data: { displayName: 'Declined Guest' } });
    const declinedRequest = await declined.json() as { id: string; requestToken: string };
    expect((await request.post(`${API_URL}/rooms/${roomId}/guest-requests/${declinedRequest.id}/reject`, {
      headers: ownerHeaders,
      data: { reason: 'Please ask the project owner for a current invite.' },
    })).status()).toBe(200);
    const declinedStatus = await request.get(`${API_URL}/guest-requests/${declinedRequest.id}/status`, { headers: { 'x-net-guest-request': declinedRequest.requestToken } });
    await expect(declinedStatus.json()).resolves.toMatchObject({
      status: 'rejected',
      decisionReason: 'Please ask the project owner for a current invite.',
      canClaim: false,
    });

    const race = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, { data: { displayName: 'Race Guest' } });
    const raceRequest = await race.json() as { id: string; requestToken: string };
    const opposingDecisions = await Promise.all([
      request.post(`${API_URL}/rooms/${roomId}/guest-requests/${raceRequest.id}/approve`, { headers: ownerHeaders }),
      request.post(`${API_URL}/rooms/${roomId}/guest-requests/${raceRequest.id}/reject`, { headers: ownerHeaders }),
    ]);
    expect(opposingDecisions.map((response) => response.status()).sort()).toEqual([200, 409]);
    const raceStatusResponse = await request.get(`${API_URL}/guest-requests/${raceRequest.id}/status`, { headers: { 'x-net-guest-request': raceRequest.requestToken } });
    const raceStatus = await raceStatusResponse.json() as { status: string };
    if (raceStatus.status === 'approved') {
      expect((await request.post(`${API_URL}/rooms/${roomId}/guest-requests/${raceRequest.id}/revoke`, { headers: ownerHeaders })).status()).toBe(200);
    }

    const third = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, { data: { displayName: 'An Guest' } });
    const thirdRequest = await third.json() as { id: string; requestToken: string };
    const fourth = await request.post(`${API_URL}/invites/${inviteCode}/guest-requests`, { data: { displayName: 'Vy Guest' } });
    const fourthRequest = await fourth.json() as { id: string; requestToken: string };
    expect((await request.post(`${API_URL}/rooms/${roomId}/guest-requests/${fourthRequest.id}/approve`, { headers: ownerHeaders })).status()).toBe(200);
    const increasedCapacity = await request.patch(`${API_URL}/rooms/${roomId}/governance`, {
      headers: ownerHeaders,
      data: { inviteMaxUses: 5 },
    });
    expect(increasedCapacity.status()).toBe(200);
    await expect(increasedCapacity.json()).resolves.toMatchObject({ inviteMaxUses: 5, inviteUseCount: 2, cancelledRequestCount: 0 });
    const reducedCapacity = await request.patch(`${API_URL}/rooms/${roomId}/governance`, {
      headers: ownerHeaders,
      data: { inviteMaxUses: 1 },
    });
    expect(reducedCapacity.status()).toBe(200);
    await expect(reducedCapacity.json()).resolves.toMatchObject({ inviteMaxUses: 1, inviteUseCount: 1, cancelledRequestCount: 1 });
    const capacityCancelled = await request.get(`${API_URL}/guest-requests/${fourthRequest.id}/status`, { headers: { 'x-net-guest-request': fourthRequest.requestToken } });
    await expect(capacityCancelled.json()).resolves.toMatchObject({ status: 'cancelled', canClaim: false });
    const stillPending = await request.get(`${API_URL}/guest-requests/${thirdRequest.id}/status`, { headers: { 'x-net-guest-request': thirdRequest.requestToken } });
    await expect(stillPending.json()).resolves.toMatchObject({ status: 'pending', canClaim: false });
    const policyOff = await request.patch(`${API_URL}/rooms/${roomId}/governance`, {
      headers: ownerHeaders,
      data: { guestAdmissionPolicy: 'off' },
    });
    expect(policyOff.status()).toBe(200);
    await expect(policyOff.json()).resolves.toMatchObject({ guestAdmissionPolicy: 'off', cancelledRequestCount: 1 });
    const cancelledStatus = await request.get(`${API_URL}/guest-requests/${thirdRequest.id}/status`, { headers: { 'x-net-guest-request': thirdRequest.requestToken } });
    await expect(cancelledStatus.json()).resolves.toMatchObject({ status: 'cancelled', canClaim: false });
    expect((await db.select({ inviteUseCount: rooms.inviteUseCount }).from(rooms).where(eq(rooms.id, roomId)))[0].inviteUseCount).toBe(1);

    await request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': session.sessionId } });
  } finally {
    if (roomId) await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, memberId));
    await pool.end();
  }
});
