import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createDatabase, inArray, rooms } from '@net/database';

const API_URL = 'http://localhost:3001/api';

async function startGuest(page: Page, name: string, inviteUrl = '/') {
  await page.goto(inviteUrl);
  await page.getByRole('button', { name: 'Tiếp tục với tư cách khách' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(name);
  const created = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Vào không gian Nét' }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const body = await response.json() as { sessionId: string; roomId: string };
  await expect(page.getByText('kết nối trực tiếp')).toBeVisible();
  return body;
}

async function sendText(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Nội dung tin nhắn' }).fill(text);
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  return page.getByRole('article').filter({ hasText: text });
}

async function safelyEnd(context: BrowserContext, page: Page, sessionId: string) {
  if (!sessionId) return;
  if (!page.isClosed()) {
    const response = await context.request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': sessionId } }).catch(() => null);
    if (response && ![200, 401].includes(response.status())) throw new Error(`Guest cleanup failed: ${response.status()}`);
  }
}

test('hai guest chat hai chiều, reply/reaction/read, offline catch-up và kết thúc sau reload @critical', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for two-party chat E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const contextA = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const contextB = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageErrors: Error[] = [];
  pageA.on('pageerror', (error) => pageErrors.push(error));
  pageB.on('pageerror', (error) => pageErrors.push(error));
  let sessionA = '';
  let sessionB = '';
  let otherSession = '';
  const roomIds = new Set<string>();

  try {
    const stamp = Date.now();
    const guestA = await startGuest(pageA, `Alice QA ${stamp}`);
    sessionA = guestA.sessionId;
    roomIds.add(guestA.roomId);
    await pageA.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }).click();
    const inviteUrl = await pageA.getByLabel('Link mời').inputValue();
    expect(inviteUrl).toContain('?room=');
    await pageA.locator('.info-drawer').getByRole('button', { name: 'Đóng' }).click();
    const guestB = await startGuest(pageB, `Bob QA ${stamp}`, inviteUrl);
    sessionB = guestB.sessionId;
    roomIds.add(guestB.roomId);

    const fromAlice = `Alice gửi Bob ${stamp}`;
    const aliceArticle = await sendText(pageA, fromAlice);
    const aliceOnBob = pageB.getByRole('article').filter({ hasText: fromAlice });
    await expect(aliceOnBob).toBeVisible();
    await expect(aliceArticle).toContainText('Đã xem');

    await aliceOnBob.getByRole('button', { name: /Trả lời/ }).click();
    const fromBob = `Bob trả lời Alice ${stamp}`;
    const bobArticle = await sendText(pageB, fromBob);
    await expect(bobArticle).toContainText(fromAlice);
    const bobOnAlice = pageA.getByRole('article').filter({ hasText: fromBob });
    await expect(bobOnAlice).toBeVisible();
    await expect(bobArticle).toContainText('Đã xem');
    await bobOnAlice.getByRole('button', { name: 'Thả ❤️' }).click();
    await expect(bobArticle.getByRole('button', { name: /❤️ 1/ })).toBeVisible();
    await expect(bobOnAlice.getByRole('button', { name: /❤️ 1/ })).toBeVisible();

    await contextB.setOffline(true);
    await expect(pageB.getByText('đồng bộ dự phòng')).toBeVisible();
    const missedWhileOffline = `Tin gửi lúc Bob offline ${stamp}`;
    await sendText(pageA, missedWhileOffline);
    const missedOnBob = pageB.getByRole('article').filter({ hasText: missedWhileOffline });
    await expect(missedOnBob).toHaveCount(0);
    await contextB.setOffline(false);
    await expect(missedOnBob).toBeVisible({ timeout: 15_000 });
    await expect(missedOnBob).toHaveCount(1);
    await expect(pageB.getByText('kết nối trực tiếp')).toBeVisible({ timeout: 15_000 });

    const other = await request.post(`${API_URL}/guest`, { data: { displayName: `Phòng khác ${stamp}` } });
    expect(other.status()).toBe(200);
    const otherGuest = (await other.json()) as { sessionId: string; roomId: string };
    otherSession = otherGuest.sessionId;
    roomIds.add(otherGuest.roomId);
    const otherBootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { 'x-net-guest-session': otherSession } });
    const otherRoom = ((await otherBootstrap.json()).rooms as Array<{ inviteCode: string }>)[0];
    await pageB.goto(`/?room=${otherRoom.inviteCode}`);
    await expect(pageB.getByRole('status')).toContainText('Bạn đang ở một phiên khách khác');
    await expect(pageB.locator('.message-bubble').getByText(fromAlice, { exact: true })).toBeVisible();

    await pageB.reload();
    await expect(pageB.locator('.message-bubble').getByText(fromBob, { exact: true })).toBeVisible();
    const ended = pageB.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'DELETE');
    await pageB.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
    await pageB.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
    expect((await ended).status()).toBe(200);
    sessionB = '';
    await expect(pageB.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
    await expect(pageA.locator('.message-bubble').getByText(fromBob, { exact: true })).toBeVisible();
    await expect(pageA.getByRole('article').filter({ hasText: missedWhileOffline })).toBeVisible();
    await expect(aliceArticle).toContainText('Đã gửi');
    expect(pageErrors).toEqual([]);

    const aliceEnded = pageA.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'DELETE');
    await pageA.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
    await pageA.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
    expect((await aliceEnded).status()).toBe(200);
    sessionA = '';
  } finally {
    await Promise.all([
      safelyEnd(contextA, pageA, sessionA),
      safelyEnd(contextB, pageB, sessionB),
      otherSession ? request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': otherSession } }) : Promise.resolve(),
    ]);
    await contextA.close();
    await contextB.close();
    if (roomIds.size) await db.delete(rooms).where(inArray(rooms.id, [...roomIds]));
    await pool.end();
  }
});
