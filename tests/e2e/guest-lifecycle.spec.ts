import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assets, createDatabase, eq, guestSessions, messages, reactions, rooms, users } from '@net/database';

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated guest retention E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test('guest kết thúc phiên thì mất quyền truy cập nhưng tin nhắn và canvas vẫn được giữ lại @critical', async ({ page, request }) => {
  test.setTimeout(90_000);
  const uniqueName = `Guest E2E ${Date.now()}`;
  await page.goto('/');

  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(uniqueName);
  const guestResponse = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  const createdGuestResponse = await guestResponse;
  expect(createdGuestResponse.status()).toBe(200);
  const createdGuest = await createdGuestResponse.json() as { sessionId: string; roomId: string };
  const originalHeaders = { 'x-net-guest-session': createdGuest.sessionId };
  const bootstrap = await request.get('http://localhost:3001/api/bootstrap', { headers: originalHeaders });
  expect(bootstrap.status()).toBe(200);
  const inviteCode = ((await bootstrap.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const authenticatedUserId = `retention-user-${Date.now()}`;
  const joined = await request.post('http://localhost:3001/api/rooms/join', {
    headers: { authorization: `Bearer ${userToken(authenticatedUserId)}` },
    data: { inviteCode },
  });
  expect(joined.status()).toBe(200);
  await expect(page.getByText(/Đã đồng bộ|Đang kết nối lại/)).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Nội dung tin nhắn' });
  await composer.fill('Tin nhắn tạm thời');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const firstMessage = page.getByRole('article').filter({ hasText: 'Tin nhắn tạm thời' });
  await expect(firstMessage).toBeVisible();

  await firstMessage.getByRole('button', { name: 'Thả ❤️' }).click();
  await expect(firstMessage.getByRole('button', { name: 'Gỡ cảm xúc ❤️' })).toContainText('1');
  await firstMessage.getByRole('button', { name: /Trả lời/ }).click();
  await composer.fill('Nội dung trả lời');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const reply = page.getByRole('article').filter({ hasText: 'Nội dung trả lời' });
  await expect(reply.getByText('Tin nhắn tạm thời')).toBeVisible();

  await page.getByRole('button', { name: 'Mở canvas' }).click();
  const canvas = page.locator('canvas');
  const closeStudio = page.getByRole('button', { name: /Đóng/ });
  await expect(closeStudio).toBeFocused();
  expect(await page.locator('.product-sidebar').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' })).toBeFocused();
  await closeStudio.focus();
  await expect(page.getByRole('button', { name: /Bút chì/ })).toHaveAttribute('aria-pressed', 'true');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 60, box!.y + 60);
  await page.mouse.down();
  await page.mouse.move(box!.x + 220, box!.y + 140, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Hình dạng/ }).click();
  await page.getByRole('button', { name: 'Chữ nhật', exact: true }).click();
  await page.mouse.move(box!.x + 280, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 410, box!.y + 180, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText('2 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Xoá các nét mới' }).click();
  await expect(page.getByText('0 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('2 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Làm lại' }).click();
  await expect(page.getByText('0 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('2 thao tác')).toBeVisible();
  await page.getByRole('button', { name: /Chèn chữ/ }).click();
  await page.getByRole('textbox', { name: 'Nội dung chữ' }).fill('Một ý nhỏ');
  const textCanvasBox = await canvas.boundingBox();
  await page.mouse.move(textCanvasBox!.x + 120, textCanvasBox!.y + 80);
  await page.mouse.down();
  await page.mouse.move(textCanvasBox!.x + 230, textCanvasBox!.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  const canvasStatus = page.getByRole('dialog').getByText(/Đã di chuyển chữ tới X/);
  await expect(canvasStatus).toHaveText(/Đã di chuyển chữ tới X .* Y/);
  const firstTextPosition = await canvasStatus.textContent();
  await page.mouse.move(textCanvasBox!.x + 230, textCanvasBox!.y + 150);
  await page.mouse.down();
  await page.mouse.move(textCanvasBox!.x + 310, textCanvasBox!.y + 190, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  await expect(canvasStatus).toHaveText(/Đã di chuyển chữ tới X .* Y/);
  await expect(canvasStatus).not.toHaveText(firstTextPosition!);
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Làm lại' }).click();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Xóa chữ đã chọn' }).click();
  await expect(page.getByText('2 thao tác')).toBeVisible();
  await expect(page.getByText(/Đã xóa chữ/)).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  await canvas.click({ position: { x: 310, y: 190 } });
  await expect(page.getByRole('button', { name: 'Xóa chữ đã chọn' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.getByText('2 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('3 thao tác')).toBeVisible();
  await page.getByRole('button', { name: 'Lưới' }).click();
  await expect(page.getByRole('button', { name: 'Lưới' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByRole('button', { name: 'Trắng' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Làm lại' }).click();
  await expect(page.getByRole('button', { name: 'Lưới' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Phóng to' }).click();
  await expect(page.getByText('110%')).toBeVisible();
  await page.getByRole('button', { name: /Di chuyển/ }).click();
  await expect(page.getByRole('button', { name: /Di chuyển/ })).toHaveAttribute('aria-pressed', 'true');
  const viewport = page.locator('.canvas-viewport');
  const scrollBeforePan = await viewport.evaluate((element) => element.scrollLeft);
  const zoomedBox = await canvas.boundingBox();
  await page.mouse.move(zoomedBox!.x + 300, zoomedBox!.y + 180);
  await page.mouse.down();
  await page.mouse.move(zoomedBox!.x + 180, zoomedBox!.y + 180, { steps: 5 });
  await page.mouse.up();
  expect(await viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollBeforePan);
  await page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' }).fill('Canvas tạm thời');
  const uploadResponse = page.waitForResponse((response) => response.url().includes('/api/assets?room=') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Gửi bản vẽ', exact: true }).click();
  expect((await uploadResponse).status()).toBe(200);
  const drawing = page.getByRole('article').filter({ hasText: 'Canvas tạm thời' });
  await expect(drawing.getByRole('img', { name: 'Bản vẽ phiên bản 1' })).toBeVisible();

  const assetPath = await drawing.getByRole('img').getAttribute('src');
  expect(assetPath).toBeTruthy();
  const liveAsset = await request.get(new URL(assetPath!, 'http://localhost:3000').toString());
  expect(liveAsset.status()).toBe(200);
  const png = await liveAsset.body();
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(720);
  const assetKey = new URL(assetPath!, 'http://localhost:3000').pathname.split('/').pop()!;
  let failRefreshOnce = true;
  await page.route(`**/api/assets/${assetKey}/access`, async (route) => {
    if (failRefreshOnce) {
      failRefreshOnce = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Lỗi refresh thử nghiệm' }) });
    } else await route.continue();
  });
  await drawing.getByRole('button', { name: /Vẽ tiếp/ }).click();
  await expect(page.getByText('Lỗi refresh thử nghiệm')).toBeVisible();
  await drawing.getByRole('button', { name: /Vẽ tiếp/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng Esc', exact: true }).click();
  await page.unroute(`**/api/assets/${assetKey}/access`);
  const endResponse = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  expect((await endResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
  await expect(page.getByText('Phiên khách đã kết thúc. Bạn không còn quyền truy cập; nội dung đã gửi vẫn được giữ lại trong phòng.')).toBeVisible();

  const revokedAssetUrl = await request.get(new URL(assetPath!, 'http://localhost:3000').toString());
  expect(revokedAssetUrl.status()).toBe(401);
  const revokedSession = await request.get(`http://localhost:3001/api/rooms/${createdGuest.roomId}/messages`, { headers: originalHeaders });
  expect(revokedSession.status()).toBe(401);

  const observerResponse = await request.post('http://localhost:3001/api/guest', { data: { displayName: `Observer ${Date.now()}`, inviteCode } });
  expect(observerResponse.status()).toBe(200);
  const observer = await observerResponse.json() as { sessionId: string };
  const observerHeaders = { 'x-net-guest-session': observer.sessionId };
  const retainedHistory = await request.get(`http://localhost:3001/api/rooms/${createdGuest.roomId}/messages`, { headers: observerHeaders });
  expect(retainedHistory.status()).toBe(200);
  const retainedMessages = (await retainedHistory.json()).messages as Array<{ body: string | null; type: string; assetKey: string | null; assetUrl: string | null }>;
  expect(retainedMessages.some((message) => message.body === 'Tin nhắn tạm thời')).toBe(true);
  expect(retainedMessages.some((message) => message.body === 'Nội dung trả lời')).toBe(true);
  const retainedCanvas = retainedMessages.find((message) => message.type === 'canvas' && message.assetKey === assetKey);
  expect(retainedCanvas?.assetUrl).toBeTruthy();
  const retainedAsset = await request.get(new URL(retainedCanvas!.assetUrl!, 'http://localhost:3001').toString());
  expect(retainedAsset.status()).toBe(200);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest retention E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  try {
    const retainedRows = await db.select({ guestSessionId: messages.guestSessionId, expiresAt: messages.expiresAt }).from(messages).where(eq(messages.roomId, createdGuest.roomId));
    expect(retainedRows.length).toBeGreaterThanOrEqual(3);
    expect(retainedRows.every((message) => message.guestSessionId === null && message.expiresAt === null)).toBe(true);
    const [retainedAssetRow] = await db.select({ guestSessionId: assets.guestSessionId, expiresAt: assets.expiresAt, ownerKey: assets.ownerKey, status: assets.status }).from(assets).where(eq(assets.key, assetKey));
    expect(retainedAssetRow).toMatchObject({ guestSessionId: null, expiresAt: null, ownerKey: `retained-guest:${createdGuest.sessionId}`, status: 'attached' });
  } finally {
    await request.delete('http://localhost:3001/api/guest', { headers: observerHeaders }).catch(() => undefined);
    await db.delete(rooms).where(eq(rooms.id, createdGuest.roomId));
    await db.delete(users).where(eq(users.id, authenticatedUserId));
    await unlink(resolve('apps/api/.data/uploads', assetKey)).catch(() => undefined);
    await pool.end();
  }
});

test('read cursor không đánh dấu tin đến sau lần tải danh sách là đã xem @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for read cursor E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const stamp = Date.now();
  const guestAResponse = await request.post('http://localhost:3001/api/guest', { data: { displayName: `Read A ${stamp}` } });
  expect(guestAResponse.status()).toBe(200);
  const guestA = await guestAResponse.json() as { sessionId: string; roomId: string };
  const headersA = { 'x-net-guest-session': guestA.sessionId };
  const bootstrapA = await request.get('http://localhost:3001/api/bootstrap', { headers: headersA });
  const inviteCode = ((await bootstrapA.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const guestBResponse = await request.post('http://localhost:3001/api/guest', { data: { displayName: `Read B ${stamp}`, inviteCode } });
  expect(guestBResponse.status()).toBe(200);
  const guestB = await guestBResponse.json() as { sessionId: string };
  const headersB = { 'x-net-guest-session': guestB.sessionId };

  try {
    const first = await request.post(`http://localhost:3001/api/rooms/${guestA.roomId}/messages`, {
      headers: headersA,
      data: { type: 'text', text: 'Tin đã render' },
    });
    const firstId = ((await first.json()) as { id: string }).id;
    const rendered = await request.get(`http://localhost:3001/api/rooms/${guestA.roomId}/messages`, { headers: headersB });
    expect(((await rendered.json()).messages as Array<{ id: string }>).some((message) => message.id === firstId)).toBe(true);

    const second = await request.post(`http://localhost:3001/api/rooms/${guestA.roomId}/messages`, {
      headers: headersA,
      data: { type: 'text', text: 'Tin đến sau GET' },
    });
    const secondId = ((await second.json()) as { id: string }).id;
    const marked = await request.patch(`http://localhost:3001/api/rooms/${guestA.roomId}/messages`, {
      headers: headersB,
      data: { messageId: firstId },
    });
    expect(marked.status()).toBe(200);

    const after = await request.get(`http://localhost:3001/api/rooms/${guestA.roomId}/messages`, { headers: headersA });
    const messages = (await after.json()).messages as Array<{ id: string; readCount: number }>;
    expect(messages.find((message) => message.id === firstId)?.readCount).toBe(1);
    expect(messages.find((message) => message.id === secondId)?.readCount).toBe(0);
  } finally {
    await Promise.all([
      request.delete('http://localhost:3001/api/guest', { headers: headersA }),
      request.delete('http://localhost:3001/api/guest', { headers: headersB }),
    ]);
    await db.delete(rooms).where(eq(rooms.id, guestA.roomId));
    await pool.end();
  }
});

test('kết thúc guest tuần tự hoá với upload và reaction đang chạy @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest race E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const created = await request.post('http://localhost:3001/api/guest', {
    data: { displayName: `Race Guest ${Date.now()}` },
  });
  expect(created.status()).toBe(200);
  const guest = await created.json() as { sessionId: string; roomId: string };
  const headers = { 'x-net-guest-session': guest.sessionId };
  let uploadedKey = '';

  try {
    const sent = await request.post(`http://localhost:3001/api/rooms/${guest.roomId}/messages`, {
      headers,
      data: { type: 'text', text: 'Tin dùng để thử race reaction' },
    });
    expect(sent.status()).toBe(200);
    const messageId = ((await sent.json()) as { id: string }).id;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7zWQAAAABJRU5ErkJggg==', 'base64');

    const [reactionResponse, uploadResponse, endResponse] = await Promise.all([
      request.post(`http://localhost:3001/api/messages/${messageId}/reactions`, {
        headers,
        data: { emoji: '✨' },
      }),
      request.post(`http://localhost:3001/api/assets?room=${guest.roomId}`, {
        headers: { ...headers, 'content-type': 'image/png' },
        data: png,
      }),
      request.delete('http://localhost:3001/api/guest', { headers }),
    ]);

    expect([200, 401]).toContain(reactionResponse.status());
    expect([200, 401]).toContain(uploadResponse.status());
    expect(endResponse.status()).toBe(200);
    if (uploadResponse.status() === 200) uploadedKey = ((await uploadResponse.json()) as { key: string }).key;

    expect(await db.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.id, guest.sessionId))).toHaveLength(0);
    expect(await db.select({ key: assets.key }).from(assets).where(eq(assets.ownerKey, `guest:${guest.sessionId}`))).toHaveLength(0);
    expect(await db.select({ actorKey: reactions.actorKey }).from(reactions).where(eq(reactions.actorKey, `guest:${guest.sessionId}`))).toHaveLength(0);
    if (uploadedKey) {
      await expect(access(resolve('apps/api/.data/uploads', uploadedKey)).then(() => true).catch(() => false)).resolves.toBe(false);
    }
  } finally {
    await request.delete('http://localhost:3001/api/guest', { headers }).catch(() => undefined);
    await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    await pool.end();
  }
});
