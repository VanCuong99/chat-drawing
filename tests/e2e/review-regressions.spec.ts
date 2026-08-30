import { expect, test, type Locator } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { createDatabase, eq, inArray, messages, roomMembers, rooms, users } from '@net/database';
import { setVietnameseUi } from './use-vietnamese-ui';

test.beforeEach(async ({ context }) => setVietnameseUi(context));

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

type ElementBox = { x: number; y: number; width: number; height: number };

async function settledImageBox(image: Locator): Promise<ElementBox> {
  let previous: ElementBox | null = null;
  let latest: ElementBox | null = null;
  let stableSamples = 0;

  await expect.poll(async () => {
    const box = await image.boundingBox();
    if (!box) {
      previous = null;
      latest = null;
      stableSamples = 0;
      return stableSamples;
    }
    const stable = previous
      && Math.abs(box.width - previous.width) < 0.5
      && Math.abs(box.height - previous.height) < 0.5;
    stableSamples = stable ? stableSamples + 1 : 0;
    previous = box;
    latest = box;
    return stableSamples;
  }, { timeout: 3_000, intervals: [50, 50, 50, 50, 75, 100] }).toBeGreaterThanOrEqual(4);

  if (!latest) throw new Error('Không thể đo kích thước ảnh sau khi viewer ổn định.');
  return latest;
}

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

test('link đăng nhập giữ nguyên mã mời trong returnTo @critical', async ({ page }) => {
  const inviteCode = 'reviewInvite2026';
  await page.route(`**/api/invites/${inviteCode}`, (route) => route.fulfill({ json: { valid: true, guestAllowed: true } }));
  await page.goto(`/?room=${inviteCode}`);
  const href = await page.getByRole('link', { name: 'Đăng nhập để vào ngay' }).getAttribute('href');
  expect(href).toBeTruthy();
  expect(new URL(href!, 'http://localhost:3000').searchParams.get('returnTo')).toBe(`/?room=${inviteCode}`);
});

test('landing không yêu cầu người dùng dán lại link mời trong app @critical', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /Link mời|mã phòng/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await expect(page.getByRole('dialog', { name: 'Bạn muốn được gọi là gì?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Link mời|mã phòng/i })).toHaveCount(0);
});

test('guest mở link mời thấy ô tên trực tiếp @critical', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/invites/reviewInvite2026', (route) => route.fulfill({ json: { valid: true, guestAllowed: true } }));
  await page.goto('/?room=reviewInvite2026');
  const guestName = page.getByRole('textbox', { name: 'Tên hiển thị' });
  await expect(guestName).toBeFocused();
  expect(await guestName.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');
  await expect(page.getByRole('button', { name: 'Vào phòng' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vào phòng ngay' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const action of [
    page.getByRole('link', { name: 'Đăng nhập để vào ngay' }),
    page.getByRole('button', { name: 'Về trang chủ' }),
  ]) {
    const box = await action.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('link mời sai không tuyên bố phòng đã sẵn sàng và không hỏi tên guest @critical', async ({ page }) => {
  await page.route('**/api/invites/invalidInvite2026', (route) => route.fulfill({ status: 404, json: { error: 'Link mời không hợp lệ hoặc đã hết hạn.' } }));
  await page.goto('/?room=invalidInvite2026');
  await expect(page.getByRole('heading', { name: /Link mời này không còn hiệu lực/ })).toBeVisible();
  await expect(page.getByText('Phòng đã sẵn sàng')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Tên hiển thị' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Về trang chủ' })).toBeVisible();
  const signInHref = await page.getByRole('link', { name: 'Đăng nhập' }).getAttribute('href');
  expect(signInHref).toBeTruthy();
  expect(new URL(signInHref!, 'http://localhost:3000').searchParams.get('returnTo')).toBe('/');
});

test('link phòng không nhận guest dẫn thẳng tới đăng nhập và giữ returnTo @critical', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const inviteCode = 'authOnlyInvite2026';
  await page.route(`**/api/invites/${inviteCode}`, (route) => route.fulfill({ json: { valid: true, guestAllowed: false } }));
  await page.goto(`/?room=${inviteCode}`);
  await expect(page.getByRole('heading', { name: /Đăng nhập, rồi vào phòng ngay/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Tên hiển thị' })).toHaveCount(0);
  const href = await page.getByRole('link', { name: 'Đăng nhập và vào phòng' }).getAttribute('href');
  expect(href).toBeTruthy();
  expect(new URL(href!, 'http://localhost:3000').searchParams.get('returnTo')).toBe(`/?room=${inviteCode}`);
  const homeBox = await page.getByRole('button', { name: 'Về trang chủ' }).boundingBox();
  expect(homeBox?.height).toBeGreaterThanOrEqual(44);
});

test('lỗi kiểm tra link tạm thời có thể retry mà không làm mất lời mời @critical', async ({ page }) => {
  const inviteCode = 'retryInvite2026';
  let attempts = 0;
  await page.route(`**/api/invites/${inviteCode}`, (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'Tạm gián đoạn' } })
      : route.fulfill({ json: { valid: true, guestAllowed: true } });
  });
  await page.goto(`/?room=${inviteCode}`);
  await expect(page.getByRole('heading', { name: /Chưa thể kiểm tra lời mời của bạn/ })).toBeVisible();
  await page.getByRole('button', { name: 'Kiểm tra lại' }).click();
  await expect(page.getByRole('textbox', { name: 'Tên hiển thị' })).toBeFocused();
  expect(attempts).toBe(2);
  await expect(page).toHaveURL(new RegExp(`room=${inviteCode}`));
});

test('authenticated user mở link thì tự join và chuyển đúng phòng @critical', async ({ page }) => {
  const inviteCode = 'autoJoinInvite2026';
  const currentRoom = room('current-room');
  const invitedRoom = { ...room('invited-room'), name: 'Phòng được mời', inviteCode, allowGuests: false };
  let bootstrapCount = 0;
  let joinCount = 0;
  await page.route('**/api/bootstrap', (route) => {
    bootstrapCount += 1;
    return route.fulfill({ json: {
      actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
      rooms: bootstrapCount === 1 ? [currentRoom] : [currentRoom, invitedRoom],
    } });
  });
  await page.route('**/api/rooms/join', (route) => {
    joinCount += 1;
    return route.fulfill({ json: { roomId: invitedRoom.id } });
  });
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/*/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));

  await page.goto(`/?room=${inviteCode}`);
  await expect(page.locator('.conversation-header').getByText('Phòng được mời', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sao chép link mời' })).toBeVisible();
  expect(joinCount).toBe(1);
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: /Phòng kiểm thử.*Tin mới/ }).click();
  await expect(page.locator('.conversation-header').getByText('Phòng kiểm thử', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(300);
  await expect(page.locator('.conversation-header').getByText('Phòng kiểm thử', { exact: true })).toBeVisible();
  expect(joinCount).toBe(1);
});

test('người đã chọn ở mode nhóm vẫn tìm thấy khi quay lại nhắn riêng @critical', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const person = { id: 'person-1', displayName: 'Bạn Nét', email: 'ba•••@example.test', avatarColor: '#3aa694' };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [room('review-room')],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/review-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.route('**/api/users?q=*', (route) => route.fulfill({ json: { users: [person] } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Mở danh sách trò chuyện' }).click();
  await page.getByRole('button', { name: 'Cuộc trò chuyện mới' }).click();
  const conversationSearch = page.getByRole('searchbox', { name: 'Bạn muốn nhắn cho ai?' });
  await expect(conversationSearch).toBeVisible();
  expect(await conversationSearch.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');
  await expect(page.getByRole('button', { name: /Vào bằng link/ })).toHaveCount(0);
  await expect(page.getByText(/dán link/i)).toHaveCount(0);
  await page.getByRole('button', { name: /Tạo nhóm/ }).click();
  await page.getByRole('searchbox', { name: 'Thêm thành viên' }).fill('Bạn');
  await page.getByRole('button', { name: /Bạn Nét.*Thêm/ }).click();
  await expect(page.getByRole('button', { name: 'Xóa Bạn Nét khỏi nhóm' })).toBeVisible();
  await page.getByRole('button', { name: /Nhắn riêng/ }).click();
  await expect(page.getByRole('button', { name: /Bạn Nét.*Nhắn tin/ })).toBeVisible();
});

test('tên phòng dài không làm tràn mobile và các nút chính đủ vùng chạm @critical', async ({ page }) => {
  const longRoom = {
    ...room('long-name-room'),
    name: 'Nhóm cùng nhau vẽ một câu chuyện thật dài nhưng vẫn phải nhìn thấy toàn bộ điều khiển',
    messageCount: 0,
  };
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [longRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/long-name-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Mời một người' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Gửi tin nhắn' })).toBeInViewport();
  const actionNames = ['Mở danh sách trò chuyện', 'Tìm trong tin nhắn', 'Thông tin cuộc trò chuyện'];
  for (const name of actionNames) {
    const button = page.getByRole('button', { name });
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const headerActionBoxes = await page.locator('.conversation-actions button:visible').evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { left: box.left, right: box.right };
  }));
  for (let index = 1; index < headerActionBoxes.length; index += 1) {
    expect(headerActionBoxes[index].left - headerActionBoxes[index - 1].right).toBeGreaterThanOrEqual(8);
  }
  expect(await page.evaluate(() => {
    const conversation = document.querySelector('.conversation-panel')!;
    return {
      document: document.documentElement.scrollWidth <= window.innerWidth,
      root: document.querySelector('.product-root')!.scrollWidth <= document.querySelector('.product-root')!.clientWidth,
      conversationClientWidth: conversation.clientWidth,
      conversationScrollWidth: conversation.scrollWidth,
      overflowing: Array.from(conversation.querySelectorAll('*')).map((element) => ({
        className: (element as HTMLElement).className,
        tag: element.tagName,
        right: Math.round(element.getBoundingClientRect().right),
      })).filter((element) => element.right > window.innerWidth).slice(0, 10),
    };
  })).toEqual({ document: true, root: true, conversationClientWidth: 375, conversationScrollWidth: 375, overflowing: [] });

  await page.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }).click();
  await expect(page.locator('.info-drawer')).toBeInViewport();
  const closeBox = await page.locator('.info-drawer').getByRole('button', { name: 'Đóng' }).boundingBox();
  expect(closeBox?.width).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height).toBeGreaterThanOrEqual(44);
});

test.describe('tải ảnh theo múi giờ của người dùng', () => {
test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('ảnh trong message mở viewer, zoom bằng nút và tải file thật trên mobile @critical', async ({ page }) => {
  const mediaRoom = { ...room('media-room'), messageCount: 1, mediaCount: 1 };
  const mediaMessage = {
    ...message(1, 'Ảnh thử nghiệm'),
    id: 'media-message',
    roomId: mediaRoom.id,
    type: 'image',
    assetKey: 'test-media-key',
    assetUrl: '/api/assets/test-media-key?access=ok',
    createdAt: new Date('2026-08-27T17:30:00.000Z').getTime(),
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw7zWQAAAABJRU5ErkJggg==', 'base64');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [mediaRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/media-room/messages*', (route) => route.fulfill({ json: { messages: [mediaMessage], nextCursor: null } }));
  await page.route('**/api/assets/test-media-key*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));

  await page.goto('/');
  const openMedia = page.getByRole('button', { name: 'Mở ảnh toàn màn hình' });
  await openMedia.click();
  const viewer = page.getByRole('dialog', { name: 'Hình ảnh trong cuộc trò chuyện' });
  await expect(viewer).toBeVisible();
  await expect(page.locator('.studio-loading')).toHaveCount(0);
  await expect(viewer.locator('#media-viewer-title')).toBeFocused();
  for (const name of ['Thu nhỏ ảnh', 'Phóng to ảnh', 'Đặt lại kích thước ảnh', 'Tải ảnh xuống', 'Đóng trình xem ảnh']) {
    const box = await viewer.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await viewer.getByRole('button', { name: 'Phóng to ảnh lên 200%' }).click();
  await expect(viewer.locator('output[aria-label="Mức phóng đại"]')).toHaveText('200%');
  await viewer.getByRole('button', { name: 'Đặt ảnh về 100%' }).click();
  await expect(viewer.locator('output[aria-label="Mức phóng đại"]')).toHaveText('100%');
  await viewer.getByRole('button', { name: 'Phóng to ảnh', exact: true }).click();
  await viewer.getByRole('button', { name: 'Phóng to ảnh', exact: true }).click();
  await expect(viewer.locator('output[aria-label="Mức phóng đại"]')).toHaveText('150%');
  await page.keyboard.press('0');
  await expect(viewer.locator('output[aria-label="Mức phóng đại"]')).toHaveText('100%');
  const modifiedZoomShortcutsPrevented = await viewer.evaluate((element) => {
    const shortcuts = [
      new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }),
    ];
    for (const event of shortcuts) element.querySelector('.media-viewer')?.dispatchEvent(event);
    return shortcuts.map((event) => event.defaultPrevented);
  });
  expect(modifiedZoomShortcutsPrevented).toEqual([false, false, false]);
  await expect(viewer.locator('output[aria-label="Mức phóng đại"]')).toHaveText('100%');
  expect(await viewer.evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);

  const viewerDownload = page.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Tải ảnh xuống' }).click();
  expect((await viewerDownload).suggestedFilename()).toBe('net-image-2026-08-28.png');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(openMedia).toBeFocused();

  await openMedia.click();
  await expect(viewer).toBeVisible();
  await viewer.locator('.media-viewer-stage').click({ position: { x: 3, y: 3 } });
  await expect(viewer).toHaveCount(0);
  await expect(openMedia).toBeFocused();

  const directDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải ảnh xuống', exact: true }).click();
  expect((await directDownload).suggestedFilename()).toBe('net-image-2026-08-28.png');

  await page.setViewportSize({ width: 1440, height: 900 });
  await openMedia.click();
  await expect(viewer).toBeVisible();
  const desktopImageBox = await settledImageBox(viewer.locator('.media-viewer-image-button img'));
  expect(desktopImageBox.width).toBeLessThanOrEqual(800);
  expect(desktopImageBox.width).toBeLessThanOrEqual(1440 * 0.58);
  expect(desktopImageBox.height).toBeLessThanOrEqual(520);
  await viewer.locator('.media-viewer-viewport').click({ position: { x: 3, y: 30 } });
  await expect(viewer).toHaveCount(0);
});
});

test('viewer desktop fit đúng ảnh ngang, vuông, dọc và zoom tăng kích thước thật @critical', async ({ page }) => {
  const aspectRoom = { ...room('aspect-room'), messageCount: 3, mediaCount: 3 };
  const fixtures = [
    { key: 'landscape', width: 1200, height: 720 },
    { key: 'square', width: 800, height: 800 },
    { key: 'portrait', width: 600, height: 1200 },
  ];
  const aspectMessages = fixtures.map((fixture, index) => ({
    ...message(index + 1, `Ảnh ${fixture.key}`),
    id: `aspect-${fixture.key}`,
    roomId: aspectRoom.id,
    type: 'image',
    assetKey: `aspect-${fixture.key}`,
    assetUrl: `/api/assets/aspect-${fixture.key}?access=ok`,
  }));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'aspect-user', displayName: 'Aspect User', email: 'aspect@example.test' },
    rooms: [aspectRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/aspect-room/messages*', (route) => route.fulfill({ json: { messages: aspectMessages, nextCursor: null } }));
  await page.route('**/api/assets/aspect-*', (route) => {
    const fixture = fixtures.find(({ key }) => route.request().url().includes(`aspect-${key}`));
    if (!fixture) return route.fulfill({ status: 404 });
    return route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${fixture.width}" height="${fixture.height}" viewBox="0 0 ${fixture.width} ${fixture.height}"><rect width="100%" height="100%" fill="#f5f0ff"/><path d="M0 ${fixture.height / 2} H${fixture.width}" stroke="#6f4ee8" stroke-width="8"/></svg>`,
    });
  });

  await page.goto('/');
  const openButtons = page.getByRole('button', { name: 'Mở ảnh toàn màn hình' });
  await expect(openButtons).toHaveCount(3);

  for (const [index, fixture] of fixtures.entries()) {
    await openButtons.nth(index).click();
    const viewer = page.getByRole('dialog', { name: 'Hình ảnh trong cuộc trò chuyện' });
    const imageButton = viewer.getByRole('button', { name: 'Phóng to ảnh lên 200%' });
    const image = viewer.locator('.media-viewer-image-button img');
    await expect(imageButton).toBeVisible();
    const fitBox = await settledImageBox(image);
    expect(Math.round((fitBox.width / fitBox.height) * 100)).toBe(Math.round((fixture.width / fixture.height) * 100));
    expect(fitBox.width).toBeLessThanOrEqual(800);
    expect(fitBox.height).toBeLessThanOrEqual(520);

    await imageButton.click();
    await expect(viewer.getByRole('button', { name: 'Đặt ảnh về 100%' })).toBeVisible();
    const zoomedBox = await settledImageBox(image);
    expect(zoomedBox.width / fitBox.width).toBeGreaterThan(1.9);
    expect(zoomedBox.height / fitBox.height).toBeGreaterThan(1.9);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  }
});

test('tạo chat trực tiếp đồng thời chỉ tạo một phòng và hiển thị tên người còn lại @critical', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for direct-room E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const stamp = Date.now();
  const actorId = `direct-actor-${stamp}`;
  const targetId = `direct-target-${stamp}`;
  const outsiderId = `direct-outsider-${stamp}`;
  const targetName = `Bạn Nét ${stamp}`;
  const authorization = `Bearer ${userToken(actorId)}`;
  const createdRoomIds = new Set<string>();
  await db.insert(users).values([
    { id: actorId, email: `${actorId}@example.test`, displayName: `Người gửi ${stamp}`, avatarColor: '#6f4ee8', createdAt: stamp, updatedAt: stamp },
    { id: targetId, email: `${targetId}@example.test`, displayName: targetName, avatarColor: '#3aa694', createdAt: stamp, updatedAt: stamp },
  ]);

  try {
    const responses = await Promise.all(Array.from({ length: 2 }, () => request.post(`${API_URL}/rooms`, {
      headers: { authorization },
      data: { memberIds: [targetId], allowGuests: true },
    })));
    expect(responses.every((response) => response.ok())).toBe(true);
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string; inviteCode: string; reused: boolean }>));
    payloads.forEach((payload) => createdRoomIds.add(payload.id));
    expect(createdRoomIds.size).toBe(1);
    expect(payloads.filter((payload) => payload.reused)).toHaveLength(1);

    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers: { authorization } });
    expect(bootstrap.ok()).toBe(true);
    const directRoom = ((await bootstrap.json()) as { rooms: Array<{ id: string; name: string; allowGuests: boolean }> }).rooms.find((room) => createdRoomIds.has(room.id));
    expect(directRoom?.name).toBe(targetName);
    expect(directRoom?.allowGuests).toBe(false);

    const inviteCode = payloads[0].inviteCode;
    await db.update(rooms).set({ allowGuests: true }).where(eq(rooms.id, payloads[0].id));
    expect((await request.get(`${API_URL}/invites/${inviteCode}`)).status()).toBe(404);
    expect((await request.post(`${API_URL}/guest`, { data: { displayName: 'Khách ngoài', inviteCode } })).status()).toBe(404);
    expect((await request.post(`${API_URL}/rooms/join`, {
      headers: { authorization: `Bearer ${userToken(outsiderId)}` },
      data: { inviteCode },
    })).status()).toBe(404);
    expect(await db.select({ userId: roomMembers.userId }).from(roomMembers).where(eq(roomMembers.roomId, payloads[0].id))).toHaveLength(2);
    const reused = await request.post(`${API_URL}/rooms`, {
      headers: { authorization },
      data: { memberIds: [targetId], allowGuests: true },
    });
    expect(reused.ok()).toBe(true);
    await expect(reused.json()).resolves.toMatchObject({ id: payloads[0].id, reused: true });
    await expect(db.select({ allowGuests: rooms.allowGuests }).from(rooms).where(eq(rooms.id, payloads[0].id)))
      .resolves.toEqual([{ allowGuests: false }]);
  } finally {
    if (createdRoomIds.size) await db.delete(rooms).where(inArray(rooms.id, [...createdRoomIds]));
    await db.delete(users).where(inArray(users.id, [actorId, targetId, outsiderId]));
    await pool.end();
  }
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
  test.setTimeout(90_000);
  const createdA = await request.post(`${API_URL}/guest`, { data: { displayName: `Retained A ${Date.now()}` } });
  expect(createdA.ok()).toBe(true);
  const guestA = await createdA.json() as { sessionId: string; roomId: string };
  const headersA = { 'x-net-guest-session': guestA.sessionId };
  const bootstrapA = await request.get(`${API_URL}/bootstrap`, { headers: headersA });
  const inviteCode = ((await bootstrapA.json()).rooms as Array<{ inviteCode: string }>)[0].inviteCode;
  const retainedUserId = `retained-review-user-${Date.now()}`;
  const joinedUser = await request.post(`${API_URL}/rooms/join`, {
    headers: { authorization: `Bearer ${userToken(retainedUserId)}` },
    data: { inviteCode },
  });
  expect(joinedUser.ok()).toBe(true);
  const createdB = await request.post(`${API_URL}/guest`, { data: { displayName: `Retained B ${Date.now()}`, inviteCode } });
  expect(createdB.ok()).toBe(true);
  const guestB = await createdB.json() as { sessionId: string };
  const headersB = { 'x-net-guest-session': guestB.sessionId };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest retention cleanup E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);

  try {
    const oldGuestMessage = await request.post(`${API_URL}/rooms/${guestA.roomId}/messages`, { headers: headersB, data: { type: 'text', text: 'Tin guest nằm ngoài trang mới nhất' } });
    expect(oldGuestMessage.ok()).toBe(true);
    const oldGuestMessageId = ((await oldGuestMessage.json()) as { id: string }).id;
    const reacted = await request.post(`${API_URL}/messages/${oldGuestMessageId}/reactions`, { headers: headersB, data: { emoji: '❤️' } });
    expect(reacted.ok()).toBe(true);
    const now = Date.now();
    await db.insert(messages).values(Array.from({ length: 85 }, (_, index) => ({
      roomId: guestA.roomId,
      guestSessionId: guestA.sessionId,
      senderName: 'Retained A',
      type: 'text' as const,
      body: `Tin được giữ ${index + 1}`,
      createdAt: now + index,
      expiresAt: null,
    })));

    await page.addInitScript((sessionId) => sessionStorage.setItem('net_guest_session', sessionId), guestA.sessionId);
    await page.goto('/');
    await expect(page.getByText(/Đã đồng bộ|Đang kết nối lại/)).toBeVisible();
    await page.getByRole('button', { name: 'Tải tin nhắn cũ hơn' }).click();
    await expect(page.getByText('Tin guest nằm ngoài trang mới nhất', { exact: true })).toBeVisible();
    const oldGuestArticle = page.getByRole('article').filter({ hasText: 'Tin guest nằm ngoài trang mới nhất' });
    await expect(oldGuestArticle.locator('.reaction-list').getByRole('button', { name: 'Thả cảm xúc ❤️' })).toContainText('1');

    const ended = await request.delete(`${API_URL}/guest`, { headers: headersB });
    expect(ended.ok()).toBe(true);
    expect((await ended.json()) as { retained?: boolean }).toMatchObject({ retained: true });
    await expect(page.getByText('Tin guest nằm ngoài trang mới nhất', { exact: true })).toBeVisible();
    await expect(oldGuestArticle.locator('.reaction-list').getByRole('button', { name: 'Thả cảm xúc ❤️' })).toHaveCount(0);
  } finally {
    await request.delete(`${API_URL}/guest`, { headers: headersA });
    await request.delete(`${API_URL}/guest`, { headers: headersB }).catch(() => undefined);
    await db.delete(rooms).where(eq(rooms.id, guestA.roomId));
    await db.delete(users).where(eq(users.id, retainedUserId));
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
    const now = Date.now();
    await db.insert(messages).values([
      {
        roomId: guest.roomId,
        guestSessionId: guest.sessionId,
        senderName: 'Search history',
        type: 'text' as const,
        body: 'Kim chỉ nam nằm trong trang cũ nhất',
        createdAt: now,
        expiresAt: null,
      },
      ...Array.from({ length: 84 }, (_, index) => ({
        roomId: guest.roomId,
        guestSessionId: guest.sessionId,
        senderName: 'Search history',
        type: 'text' as const,
        body: `Tin gần đây ${index + 1}`,
        createdAt: now + index + 1,
        expiresAt: null,
      })),
    ]);

    const bootstrap = await request.get(`${API_URL}/bootstrap`, { headers });
    const activeRoom = ((await bootstrap.json()).rooms as Array<{ id: string; messageCount: number; mediaCount: number }>).find((item) => item.id === guest.roomId);
    expect(activeRoom).toMatchObject({ messageCount: 86, mediaCount: 0 });

    const found = await request.get(`${API_URL}/rooms/${guest.roomId}/messages?q=${encodeURIComponent('Kim chỉ nam')}`, { headers });
    expect(found.ok()).toBe(true);
    const result = await found.json() as { messages: Array<{ body: string }>; totalCount: number };
    expect(result.totalCount).toBe(1);
    expect(result.messages.map((item) => item.body)).toEqual(['Kim chỉ nam nằm trong trang cũ nhất']);
  } finally {
    await request.delete(`${API_URL}/guest`, { headers }).catch(() => undefined);
    try {
      await db.delete(rooms).where(eq(rooms.id, guest.roomId));
    } finally {
      await pool.end();
    }
  }
});

test('bootstrap đồng thời chỉ tạo 1 phòng chào mừng cho user mới @critical', async ({ request }) => {
  test.setTimeout(60_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for bootstrap race E2E');
  const userId = `bootstrap-race-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const { db, pool } = createDatabase(databaseUrl, 1);
  let roomIds: string[] = [];
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => request.get(`${API_URL}/bootstrap`, { headers: { authorization } })));
    const memberships = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, userId));
    roomIds = memberships.map((membership) => membership.roomId);
    expect(responses.every((response) => response.ok())).toBe(true);
    expect(memberships).toHaveLength(1);
  } finally {
    if (!roomIds.length) {
      const memberships = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, userId)).catch(() => []);
      roomIds = memberships.map((membership) => membership.roomId);
    }
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  }
});
