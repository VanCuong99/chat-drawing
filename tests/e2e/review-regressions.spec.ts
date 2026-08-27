import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { createDatabase, eq, inArray, roomMembers, rooms, users } from '@net/database';

const API_URL = 'http://localhost:3001/api';

const room = (id: string) => ({
  id,
  name: 'Phòng kiểm thử',
  kind: 'group',
  inviteCode: `${id}-invite`,
  allowGuests: true,
  preview: 'Tin mới',
  lastActivity: Date.now(),
  unreadCount: 0,
  messageCount: 101,
  mediaCount: 0,
});

const message = (sequence: number, body = `Tin ${sequence}`) => ({
  id: `message-${sequence}`,
  sequence,
  roomId: 'review-room',
  senderId: 'other-user',
  guestSessionId: null,
  senderName: 'Bạn chat',
  type: 'text',
  body,
  assetKey: null,
  assetUrl: null,
  replyToId: null,
  canvasParentId: null,
  canvasVersion: null,
  createdAt: Date.now() + sequence,
  editedAt: null,
  readCount: 0,
  reactions: [],
});

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated bootstrap E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test('lỗi bootstrap tạm thời giữ nguyên guest credential và cho phép thử lại @critical', async ({ page, request }) => {
  const created = await request.post(`${API_URL}/guest`, { data: { displayName: `Bootstrap retry ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const guest = await created.json() as { sessionId: string; roomId: string };
  await page.addInitScript((sessionId) => sessionStorage.setItem('net_guest_session', sessionId), guest.sessionId);
  let bootstrapRequests = 0;
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1;
    if (bootstrapRequests === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Bảo trì ngắn' }) });
      return;
    }
    await route.fulfill({ json: {
      actor: { kind: 'guest', id: guest.sessionId, displayName: 'Bootstrap retry', expiresAt: Date.now() + 60_000 },
      rooms: [room(guest.roomId)],
    } });
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Thử kết nối lại' })).toBeVisible();
    await expect(page.evaluate(() => sessionStorage.getItem('net_guest_session'))).resolves.toBe(guest.sessionId);
    await page.getByRole('button', { name: 'Thử kết nối lại' }).click();
    await expect(page.locator('.conversation-panel')).toBeVisible();
    const endSession = page.getByRole('button', { name: 'Kết thúc phiên khách' });
    await endSession.click();
    await expect(page.getByRole('dialog', { name: 'Kết thúc phiên khách?' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Kết thúc phiên khách?' })).toHaveCount(0);
    await expect(endSession).toBeFocused();
    await expect(page.evaluate(() => sessionStorage.getItem('net_guest_session'))).resolves.toBe(guest.sessionId);
  } finally {
    await request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': guest.sessionId } });
  }
});

test('link đăng nhập giữ nguyên mã mời trong return_to @critical', async ({ page }) => {
  const inviteCode = 'reviewInvite2026';
  await page.goto(`/?room=${inviteCode}`);
  const href = await page.getByRole('link', { name: 'Đăng nhập tài khoản' }).getAttribute('href');
  expect(href).toBeTruthy();
  expect(new URL(href!, 'http://localhost:3000').searchParams.get('return_to')).toBe(`/?room=${inviteCode}`);
});

test('refresh realtime không huỷ pagination và không đánh dấu tin chưa nhìn là đã xem @critical', async ({ page }) => {
  let latestRequests = 0;
  let releaseOlder!: () => void;
  let markOlderRequested!: () => void;
  let markLatestRefreshed!: () => void;
  const olderRelease = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const olderRequested = new Promise<void>((resolve) => { markOlderRequested = resolve; });
  const latestRefreshed = new Promise<void>((resolve) => { markLatestRefreshed = resolve; });
  const readMessageIds: string[] = [];

  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [room('review-room')],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/review-room/messages*', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { messageId: string };
      readMessageIds.push(body.messageId);
      await route.fulfill({ json: { messageId: body.messageId } });
      return;
    }
    const url = new URL(route.request().url());
    if (url.searchParams.has('before')) {
      markOlderRequested();
      await olderRelease;
      await route.fulfill({ json: { messages: Array.from({ length: 20 }, (_, index) => message(index + 1, `Tin cũ ${index + 1}`)), nextCursor: null } });
      return;
    }
    latestRequests += 1;
    const start = latestRequests === 1 ? 21 : 22;
    const end = latestRequests === 1 ? 100 : 101;
    await route.fulfill({ json: { messages: Array.from({ length: end - start + 1 }, (_, index) => message(start + index, start + index === 101 ? 'Tin mới chưa xem 101' : `Tin ${start + index}`)), nextCursor: '21' } });
    if (latestRequests >= 2) markLatestRefreshed();
  });

  await page.goto('/');
  await expect(page.getByText('Tin 100', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tải tin nhắn cũ hơn' }).click();
  await olderRequested;
  await latestRefreshed;
  await expect(page.getByText('Tin mới chưa xem 101', { exact: true })).toBeAttached();
  await page.waitForTimeout(350);
  expect(readMessageIds).not.toContain('message-101');
  releaseOlder();
  await expect(page.getByText('Tin cũ 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Tin mới chưa xem 101', { exact: true })).toBeAttached();
});

test('guest.ended giữ nội dung guest trong phần lịch sử cũ đã tải @critical', async ({ page, request }) => {
  test.setTimeout(45_000);
  const createdA = await request.post(`${API_URL}/guest`, { data: { displayName: `Retained A ${Date.now()}` } });
  expect(createdA.ok()).toBe(true);
  const guestA = await createdA.json() as { sessionId: string; roomId: string };
  const headersA = { 'x-net-guest-session': guestA.sessionId };
  const bootstrapA = await request.get(`${API_URL}/bootstrap`, { headers: headersA });
  const inviteCode = ((await bootstrapA.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const createdB = await request.post(`${API_URL}/guest`, { data: { displayName: `Retained B ${Date.now()}`, inviteCode } });
  expect(createdB.ok()).toBe(true);
  const guestB = await createdB.json() as { sessionId: string };
  const headersB = { 'x-net-guest-session': guestB.sessionId };

  try {
    const oldGuestMessage = await request.post(`${API_URL}/rooms/${guestA.roomId}/messages`, { headers: headersB, data: { type: 'text', text: 'Tin guest nằm ngoài trang mới nhất' } });
    expect(oldGuestMessage.ok()).toBe(true);
    const oldGuestMessageId = ((await oldGuestMessage.json()) as { id: string }).id;
    const reacted = await request.post(`${API_URL}/messages/${oldGuestMessageId}/reactions`, { headers: headersB, data: { emoji: '❤️' } });
    expect(reacted.ok()).toBe(true);
    const retained = await Promise.all(Array.from({ length: 100 }, (_, index) => request.post(`${API_URL}/rooms/${guestA.roomId}/messages`, { headers: headersA, data: { type: 'text', text: `Tin được giữ ${index + 1}` } })));
    expect(retained.every((response) => response.ok())).toBe(true);

    await page.addInitScript((sessionId) => sessionStorage.setItem('net_guest_session', sessionId), guestA.sessionId);
    await page.goto('/');
    await expect(page.getByText('kết nối trực tiếp')).toBeVisible();
    await page.getByRole('button', { name: 'Tải tin nhắn cũ hơn' }).click();
    await expect(page.getByText('Tin guest nằm ngoài trang mới nhất', { exact: true })).toBeVisible();
    const oldGuestArticle = page.getByRole('article').filter({ hasText: 'Tin guest nằm ngoài trang mới nhất' });
    await expect(oldGuestArticle.getByRole('button', { name: /❤️ 1/ })).toBeVisible();

    const ended = await request.delete(`${API_URL}/guest`, { headers: headersB });
    expect(ended.ok()).toBe(true);
    await expect(page.getByText('Tin guest nằm ngoài trang mới nhất', { exact: true })).toBeVisible();
    await expect(oldGuestArticle.getByRole('button', { name: /❤️ 1/ })).toHaveCount(0);
  } finally {
    await request.delete(`${API_URL}/guest`, { headers: headersA });
    await request.delete(`${API_URL}/guest`, { headers: headersB }).catch(() => undefined);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for guest retention cleanup E2E');
    const { db, pool } = createDatabase(databaseUrl, 1);
    await db.delete(rooms).where(eq(rooms.id, guestA.roomId));
    await pool.end();
  }
});

test('search và thống kê phòng bao phủ cả lịch sử chưa tải @critical', async ({ request }) => {
  test.setTimeout(45_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for message search E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const created = await request.post(`${API_URL}/guest`, { data: { displayName: `Search history ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const guest = await created.json() as { sessionId: string; roomId: string };
  const headers = { 'x-net-guest-session': guest.sessionId };
  try {
    const oldest = await request.post(`${API_URL}/rooms/${guest.roomId}/messages`, { headers, data: { type: 'text', text: 'Kim chỉ nam nằm trong trang cũ nhất' } });
    expect(oldest.ok()).toBe(true);
    for (let index = 0; index < 84; index += 1) {
      const recent = await request.post(`${API_URL}/rooms/${guest.roomId}/messages`, { headers, data: { type: 'text', text: `Tin gần đây ${index + 1}` } });
      expect(recent.ok()).toBe(true);
    }

    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers });
    const activeRoom = ((await bootstrap.json()).rooms as Array<{ id: string; messageCount: number; mediaCount: number }>).find((item) => item.id === guest.roomId);
    expect(activeRoom).toMatchObject({ messageCount: 86, mediaCount: 0 });

    const found = await request.get(`${API_URL}/rooms/${guest.roomId}/messages?q=${encodeURIComponent('Kim chỉ nam')}`, { headers });
    expect(found.ok()).toBe(true);
    const result = await found.json() as { messages: Array<{ body: string }>; totalCount: number };
    expect(result.totalCount).toBe(1);
    expect(result.messages.map((item) => item.body)).toEqual(['Kim chỉ nam nằm trong trang cũ nhất']);
  } finally {
    await request.delete(`${API_URL}/guest`, { headers });
    await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    await pool.end();
  }
});

test('bootstrap đồng thời chỉ tạo 1 phòng chào mừng cho user mới @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for bootstrap race E2E');
  const userId = `bootstrap-race-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const { db, pool } = createDatabase(databaseUrl, 1);
  let roomIds: string[] = [];
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => request.get(`${API_URL}/bootstrap`, { headers: { authorization } })));
    expect(responses.every((response) => response.ok())).toBe(true);
    const memberships = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, userId));
    expect(memberships).toHaveLength(1);
    roomIds = memberships.map((membership) => membership.roomId);
  } finally {
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  }
});
