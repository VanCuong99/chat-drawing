import { expect, test, type Locator } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createDatabase, eq, inArray, messages, roomMembers, rooms, users } from '@net/database';
import { e2eApiUrl, e2eWebOrigin } from './e2e-environment';
import { setVietnameseUi } from './use-vietnamese-ui';

test.beforeEach(async ({ context }) => setVietnameseUi(context));

const API_URL = e2eApiUrl;

const room = (id: string) => ({
  id,
  name: 'Phòng kiểm thử',
  kind: 'group',
  inviteCode: `${id}-invite`,
  allowGuests: true,
  preview: 'Tin mới',
  lastActivity: Date.now(),
  unreadCount: 0,
  firstUnreadSequence: null,
  lastReadSequence: 0,
  muted: false,
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
  canvasRootId: null,
  canvasVersion: null,
  lineageRoot: null,
  continuationCount: 0,
  createdAt: Date.now() + sequence,
  editedAt: null,
  deletedAt: null,
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

function userToken(userId: string, displayName = userId) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated bootstrap E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
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

test('tạo guest thành công nhưng bootstrap lỗi vẫn giữ modal và nét vẽ để thử lại @critical', async ({ page, request }) => {
  const firstMark = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7rWQAAAABJRU5ErkJggg==';
  await page.addInitScript((mark) => sessionStorage.setItem('net_pending_landing_sketch', mark), firstMark);

  let guestCreates = 0;
  let bootstrapRequests = 0;
  let sessionId: string | null = null;
  page.on('request', (pageRequest) => {
    if (pageRequest.method() === 'POST' && new URL(pageRequest.url()).pathname === '/api/guest') guestCreates += 1;
  });
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1;
    if (bootstrapRequests === 1) {
      await route.continue();
      return;
    }
    if (bootstrapRequests === 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Bảo trì ngắn' }) });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bạn muốn được gọi là gì?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.guest-mark-preview')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Tên hiển thị' }).fill('Nét đầu tiên');
    await dialog.getByRole('button', { name: 'Vào Nét' }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.guest-recovery')).toBeVisible();
    sessionId = await page.evaluate(() => sessionStorage.getItem('net_guest_session'));
    expect(sessionId).toBeTruthy();
    await expect(page.evaluate(() => sessionStorage.getItem('net_pending_landing_sketch'))).resolves.toBe(firstMark);

    await dialog.getByRole('button', { name: 'Thử lại' }).click();
    await expect(page.getByRole('dialog', { name: 'Nét Studio' })).toBeVisible();
    expect(guestCreates).toBe(1);
    await expect(page.evaluate(() => sessionStorage.getItem('net_pending_landing_sketch'))).resolves.toBeNull();
  } finally {
    if (sessionId) await request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': sessionId } });
  }
});

test('bootstrap 401 loại session hết hạn rồi tạo guest mới mà không mất nét đầu tiên @critical', async ({ page, request }) => {
  const firstMark = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7rWQAAAABJRU5ErkJggg==';
  await page.addInitScript((mark) => sessionStorage.setItem('net_pending_landing_sketch', mark), firstMark);

  const createdSessionIds: string[] = [];
  let bootstrapRequests = 0;
  await page.route('**/api/guest', async (route) => {
    if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== '/api/guest') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as { sessionId: string };
    createdSessionIds.push(body.sessionId);
    await route.fulfill({ response });
  });
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1;
    if (bootstrapRequests === 2) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Guest session expired' }) });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bạn muốn được gọi là gì?' });
    await dialog.getByRole('textbox', { name: 'Tên hiển thị' }).fill('Nét hồi phục');
    await dialog.getByRole('button', { name: 'Vào Nét' }).click();

    await expect(dialog.locator('.guest-recovery')).toContainText('nét vẽ đầu tiên của bạn vẫn còn đây');
    await expect(page.evaluate(() => sessionStorage.getItem('net_guest_session'))).resolves.toBeNull();
    await expect(page.evaluate(() => sessionStorage.getItem('net_pending_landing_sketch'))).resolves.toBe(firstMark);
    expect(createdSessionIds).toHaveLength(1);

    await dialog.getByRole('button', { name: 'Thử lại' }).click();
    await expect(page.getByRole('dialog', { name: 'Nét Studio' })).toBeVisible();
    expect(createdSessionIds).toHaveLength(2);
    expect(createdSessionIds[1]).not.toBe(createdSessionIds[0]);
    await expect(page.evaluate(() => sessionStorage.getItem('net_pending_landing_sketch'))).resolves.toBeNull();
  } finally {
    await Promise.all(createdSessionIds.map((sessionId) => request.delete(`${API_URL}/guest`, { headers: { 'x-net-guest-session': sessionId } })));
  }
});

test('link đăng nhập giữ nguyên mã mời trong returnTo @critical', async ({ page }) => {
  const inviteCode = 'reviewInvite2026';
  await page.route(`**/api/invites/${inviteCode}`, (route) => route.fulfill({ json: { valid: true, guestAllowed: true } }));
  await page.goto(`/?room=${inviteCode}`);
  const href = await page.getByRole('link', { name: 'Đăng nhập để vào ngay' }).getAttribute('href');
  expect(href).toBeTruthy();
  expect(new URL(href!, e2eWebOrigin).searchParams.get('returnTo')).toBe(`/?room=${inviteCode}`);
});

test('invite cho biết ai mời, tên phòng, người tham gia và hoạt động gần đây @critical', async ({ page }) => {
  const inviteCode = 'socialInvite2026';
  await page.route(`**/api/invites/${inviteCode}`, (route) => route.fulfill({ json: {
    valid: true,
    guestAllowed: true,
    room: {
      name: 'Weekend Sketch Club',
      hostedBy: 'Minh Anh',
      participants: [
        { id: 'minh', displayName: 'Minh Anh', avatarColor: '#6f4ee8' },
        { id: 'an', displayName: 'An Vẽ', avatarColor: '#3aa694' },
      ],
      participantCount: 2,
      recentActivity: { type: 'canvas', createdAt: Date.now() },
      createdAt: Date.now() - 60_000,
    },
  } }));
  await page.goto(`/?room=${inviteCode}`);
  await expect(page.getByText('Phòng do Minh Anh tạo')).toBeVisible();
  await expect(page.getByText('Weekend Sketch Club')).toBeVisible();
  await expect(page.getByLabel('2 người trong phòng này')).toBeVisible();
  await expect(page.getByText(/Vừa có một bản vẽ được chia sẻ/)).toBeVisible();
});

test('form xin tham gia invite approval nằm trong viewport mobile đầu tiên @critical', async ({ page }) => {
  const inviteCode = 'mobileApprovalInvite2026';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/invites/${inviteCode}`, (route) => route.fulfill({ json: {
    valid: true,
    guestAllowed: true,
    guestAdmissionPolicy: 'approval',
    requestExpiresInHours: 24,
    room: { name: 'Nhóm phác thảo', hostedBy: 'Minh Anh', participants: [], participantCount: 1, recentActivity: null, createdAt: Date.now() },
  } }));
  await page.goto(`/?room=${inviteCode}`);
  const form = page.locator('.invite-join-form');
  const submit = form.getByRole('button', { name: /Xin tham gia/ });
  await expect(form.getByRole('textbox', { name: 'Tên hiển thị' })).toBeVisible();
  await expect(form.getByRole('textbox', { name: /giới thiệu ngắn/i })).toBeVisible();
  const submitBox = await submit.boundingBox();
  expect(submitBox).not.toBeNull();
  expect((submitBox?.y ?? 844) + (submitBox?.height ?? 0)).toBeLessThanOrEqual(844);
});

test('khách có thể thử một nét trước khi chọn tên @critical', async ({ page }) => {
  await page.goto('/');
  const canvas = page.getByLabel('Canvas nhỏ để thử Nét');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Không tìm thấy canvas thử trên landing.');
  await page.mouse.move(box.x + 50, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 8 });
  await page.mouse.up();
  const useMark = page.getByRole('button', { name: /Tiếp tục nét này/ });
  await expect(useMark).toBeEnabled();
  await page.getByRole('button', { name: 'Xóa' }).click();
  await expect(useMark).toBeDisabled();
  await canvas.press('Space');
  await expect(useMark).toBeEnabled();
  await useMark.click();
  await expect(page.getByRole('dialog', { name: 'Bạn muốn được gọi là gì?' })).toBeVisible();
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
  await expect(guestName).toBeVisible();
  await expect(guestName).not.toBeFocused();
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
  expect(new URL(signInHref!, e2eWebOrigin).searchParams.get('returnTo')).toBe('/');
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
  expect(new URL(href!, e2eWebOrigin).searchParams.get('returnTo')).toBe(`/?room=${inviteCode}`);
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

test('một people picker tự chuyển từ chat riêng sang nhóm theo số người đã chọn @critical', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const person = { id: 'person-1', displayName: 'Bạn Nét', email: 'ba•••@example.test', avatarColor: '#3aa694' };
  const secondPerson = { id: 'person-2', displayName: 'An Vẽ', email: 'an•••@example.test', avatarColor: '#6f4ee8' };
  await context.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [room('review-room')],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/review-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.route('**/api/users?q=*', (route) => route.fulfill({ json: { users: [person, secondPerson] } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Mở danh sách trò chuyện' }).click();
  await page.getByRole('button', { name: 'Cuộc trò chuyện mới' }).click();
  const conversationSearch = page.getByRole('searchbox', { name: 'Bạn muốn sáng tạo cùng ai?' });
  await expect(conversationSearch).toBeVisible();
  expect(await conversationSearch.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');
  await expect(page.getByRole('button', { name: /Vào bằng link/ })).toHaveCount(0);
  await expect(page.getByText(/dán link/i)).toHaveCount(0);
  await conversationSearch.fill('Bạn');
  await page.getByRole('button', { name: /Bạn Nét.*Chọn/ }).click();
  await expect(page.getByRole('button', { name: 'Bỏ chọn Bạn Nét' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nhắn cho Bạn Nét' })).toBeVisible();
  await page.getByRole('button', { name: /An Vẽ.*Chọn/ }).click();
  await expect(page.getByRole('textbox', { name: /Tên nhóm/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Tạo nhóm · 3 người/ })).toBeVisible();
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
  const actionNames = ['Mở danh sách trò chuyện', 'Sao chép link mời', 'Thêm thao tác cuộc trò chuyện'];
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

  const moreActions = page.getByRole('button', { name: 'Thêm thao tác cuộc trò chuyện' });
  await moreActions.click();
  const mobileActions = page.locator('#mobile-header-actions');
  await expect(mobileActions.getByRole('button', { name: 'Tìm trong tin nhắn' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(mobileActions).toHaveCount(0);
  await expect(moreActions).toBeFocused();
  await moreActions.click();
  await page.locator('.message-scroll').click({ position: { x: 8, y: 8 } });
  await expect(mobileActions).toHaveCount(0);
  await moreActions.click();
  await mobileActions.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }).click();
  await expect(page.locator('.info-drawer')).toBeInViewport();
  const closeBox = await page.locator('.info-drawer').getByRole('button', { name: 'Đóng' }).boundingBox();
  expect(closeBox?.width).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height).toBeGreaterThanOrEqual(44);
});

test('Studio mobile ưu tiên canvas và chỉ giữ dock năm công cụ chính @critical', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const studioRoom = { ...room('studio-mobile-room'), messageCount: 2 };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [studioRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/studio-mobile-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.goto('/');
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  await expect(studio).toBeVisible();
  const drawingArea = studio.getByLabel('Vùng vẽ nâng cao');
  await expect(drawingArea).toHaveAttribute('width', '900');
  await expect(drawingArea).toHaveAttribute('height', '1200');
  await expect(studio.locator('.gesture-coach')).toContainText('Chụm hai ngón để phóng to');
  await studio.locator('.gesture-coach').getByRole('button', { name: 'Đã hiểu' }).click();
  await expect(studio.locator('.tool-rail button:visible')).toHaveCount(5);
  for (const name of ['Bút chì (P)', 'Màu và cài đặt công cụ', 'Hoàn tác', 'Thêm vào canvas', 'Công cụ khác']) {
    await expect(studio.locator('.tool-rail').getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(studio.locator('.studio-header').getByRole('button', { name: 'Gửi', exact: true })).toBeVisible();
  const workspaceBox = await studio.locator('.studio-workspace').boundingBox();
  const canvasBox = await studio.locator('.canvas-panel').boundingBox();
  const drawableBox = await drawingArea.boundingBox();
  const headerBox = await studio.locator('.studio-header').boundingBox();
  const dockBox = await studio.locator('.tool-rail').boundingBox();
  expect(workspaceBox && canvasBox ? canvasBox.height / workspaceBox.height : 0).toBeGreaterThan(0.84);
  expect(canvasBox && drawableBox ? drawableBox.width / canvasBox.width : 0).toBeGreaterThan(0.9);
  expect(drawableBox ? drawableBox.height / 844 : 0).toBeGreaterThan(0.7);
  await expect(studio.getByRole('button', { name: 'Cho giấy lấp đầy vùng làm việc' })).toHaveAttribute('aria-pressed', 'true');
  await studio.getByRole('button', { name: 'Hiển thị vừa toàn bộ giấy' }).click();
  await expect.poll(async () => (await drawingArea.boundingBox())?.width ?? 0).toBeLessThanOrEqual(375);
  await expect.poll(async () => (await drawingArea.boundingBox())?.height ?? 0).toBeLessThan(510);
  await studio.getByRole('button', { name: 'Cho giấy lấp đầy vùng làm việc' }).click();
  expect(headerBox && canvasBox ? canvasBox.y >= headerBox.y + headerBox.height : false).toBe(true);
  await expect.poll(async () => {
    const settledCanvasBox = await studio.locator('.canvas-panel').boundingBox();
    const settledDockBox = await studio.locator('.tool-rail').boundingBox();
    return settledCanvasBox && settledDockBox ? settledCanvasBox.y + settledCanvasBox.height <= settledDockBox.y : false;
  }).toBe(true);
  expect(await studio.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(studio.locator('.tool-inspector')).not.toBeVisible();
  await studio.getByRole('button', { name: 'Màu và cài đặt công cụ' }).click();
  const toolDialog = studio.getByRole('dialog', { name: 'Cài đặt công cụ' });
  await expect(toolDialog).toBeVisible();
  await toolDialog.getByRole('button', { name: 'Vuông' }).click();
  await expect(toolDialog.locator('.resize-preview')).toContainText('900 × 1200');
  const cropMask = toolDialog.locator('.resize-preview-map b');
  await expect(cropMask).toBeVisible();
  expect(await cropMask.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  const sourcePreviewBox = await toolDialog.locator('.resize-preview-map i').boundingBox();
  const targetPreviewBox = await cropMask.boundingBox();
  expect(sourcePreviewBox && targetPreviewBox ? sourcePreviewBox.height > targetPreviewBox.height : false).toBe(true);
  await toolDialog.getByRole('button', { name: 'Áp dụng kích thước' }).click();
  await expect(drawingArea).toHaveAttribute('width', '1080');
  await expect(drawingArea).toHaveAttribute('height', '1080');
  await page.keyboard.press('Shift+Tab');
  await expect(toolDialog.locator(':focus')).toHaveCount(1);
  for (const colorButton of await toolDialog.locator('.color,.custom-color').all()) {
    const colorBox = await colorButton.boundingBox();
    expect(colorBox?.width).toBeGreaterThanOrEqual(44);
    expect(colorBox?.height).toBeGreaterThanOrEqual(44);
  }
  await toolDialog.getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  await expect(studio.locator('.tool-inspector')).not.toBeVisible();
  await expect(studio.getByRole('button', { name: 'Màu và cài đặt công cụ' })).toBeFocused();
  const drawingBox = await drawingArea.boundingBox();
  if (!drawingBox) throw new Error('Không đo được canvas Studio mobile.');
  await page.mouse.move(drawingBox.x + 60, drawingBox.y + 70);
  await page.mouse.down();
  await page.mouse.move(drawingBox.x + 150, drawingBox.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect(studio.getByText(/Đã lưu trên thiết bị này/)).toBeVisible();
  await studio.getByRole('button', { name: 'Màu và cài đặt công cụ' }).click();
  const resizeDialog = studio.getByRole('dialog', { name: 'Cài đặt công cụ' });
  await resizeDialog.getByRole('button', { name: 'Story' }).click();
  await resizeDialog.getByRole('button', { name: 'Neo góc trên trái' }).click();
  await resizeDialog.getByRole('button', { name: 'Đổi kích thước canvas' }).click();
  await expect(drawingArea).toHaveAttribute('width', '900');
  await expect(drawingArea).toHaveAttribute('height', '1600');
  await expect(studio.locator('.canvas-commandbar>span')).toContainText('1 thao tác');
  await resizeDialog.getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  await studio.locator('.tool-rail').getByRole('button', { name: 'Hoàn tác', exact: true }).click();
  await expect(drawingArea).toHaveAttribute('width', '1080');
  await expect(drawingArea).toHaveAttribute('height', '1080');
  page.once('dialog', (dialog) => dialog.accept());
  await studio.locator('.studio-header').getByRole('button', { name: /Đóng/ }).click();
  await expect(studio).toBeHidden();
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const restoredStudio = page.getByRole('dialog', { name: 'Nét Studio' });
  await expect(restoredStudio.getByText(/Đã khôi phục bản nháp/)).toBeVisible();
  await restoredStudio.getByRole('button', { name: 'Công cụ khác' }).click();
  await expect(restoredStudio.getByRole('dialog', { name: 'Công cụ khác' }).getByRole('button', { name: 'Xoá các nét mới' })).toBeEnabled();
});

test('tin nhắn offline vào hộp thư chờ và tự gửi lại bằng cùng mã yêu cầu @critical', async ({ page, context }) => {
  const outboxRoom = { ...room('outbox-room'), messageCount: 1 };
  let sentRequestId = '';
  let postCount = 0;
  await context.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'outbox-user', displayName: 'Outbox User', email: 'outbox@example.test' },
    rooms: [outboxRoom],
  } }));
  await context.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await context.route('**/api/rooms/outbox-room/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
      const body = route.request().postDataJSON() as { clientRequestId: string };
      sentRequestId = body.clientRequestId;
      await route.fulfill({ json: { id: 'sent-from-outbox' } });
      return;
    }
    await route.fulfill({ json: { messages: [], nextCursor: null } });
  });

  await page.goto('/');
  await expect(page.locator('.conversation-panel')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('textbox', { name: 'Nội dung tin nhắn' }).fill('Tin nhắn vẫn an toàn');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();

  const outbox = page.locator('.message-outbox');
  await expect(outbox).toContainText('1 mục được lưu trên thiết bị này');
  await expect(page.locator('.conversation-title')).toContainText('Ngoại tuyến · 1 mục đang chờ');
  const storedRequestId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('net_message_outbox:v3:user:outbox-user:'));
    return key ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { id?: string }).id ?? '' : '';
  });
  expect(storedRequestId).toBeTruthy();

  await page.close();
  await context.setOffline(false);
  const restoredPage = await context.newPage();
  await restoredPage.goto('/');
  await expect(restoredPage.locator('.conversation-panel')).toBeVisible();
  const restoredOutbox = restoredPage.locator('.message-outbox');
  await expect(restoredOutbox).toContainText('1 mục được lưu trên thiết bị này');
  expect(postCount).toBe(0);
  await restoredOutbox.getByRole('button', { name: 'Thử lại tất cả' }).click();
  await expect.poll(() => postCount).toBe(1);
  await expect(restoredOutbox).toHaveCount(0);
  expect(sentRequestId).toBe(storedRequestId);
});

test('mất phản hồi khi gửi không tạo mã mới hoặc tin nhắn trùng @critical', async ({ page }) => {
  const outboxRoom = { ...room('uncertain-send-room'), messageCount: 1 };
  const requestIds: string[] = [];
  let allowSend = false;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'uncertain-user', displayName: 'Uncertain User', email: 'uncertain@example.test' },
    rooms: [outboxRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/uncertain-send-room/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { clientRequestId: string };
      requestIds.push(body.clientRequestId);
      if (!allowSend) {
        await route.abort('connectionrefused');
        return;
      }
      await route.fulfill({ json: { id: 'idempotent-message' } });
      return;
    }
    await route.fulfill({ json: { messages: [], nextCursor: null } });
  });

  await page.goto('/');
  await page.getByRole('textbox', { name: 'Nội dung tin nhắn' }).fill('Chỉ được gửi một lần');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const outbox = page.locator('.message-outbox');
  await expect(outbox.getByRole('button', { name: 'Thử lại tất cả' })).toBeEnabled();
  expect(requestIds).toHaveLength(1);
  expect(new Set(requestIds).size).toBe(1);
  const storedRequestId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('net_message_outbox:v3:user:uncertain-user:'));
    return key ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { id?: string }).id ?? '' : '';
  });
  expect(storedRequestId).toBe(requestIds[0]);

  allowSend = true;
  await outbox.getByRole('button', { name: 'Thử lại tất cả' }).click();
  await expect(outbox).toHaveCount(0);
  expect(requestIds).toHaveLength(2);
  expect(new Set(requestIds).size).toBe(1);
});

test('ảnh offline được giữ trong outbox và gửi lại sau khi mở tab mới @critical', async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const mediaRoom = { ...room('media-outbox-room'), messageCount: 1 };
  let uploadCount = 0;
  let sendCount = 0;
  let uploadId = '';
  let messageRequestId = '';
  await context.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'media-outbox-user', displayName: 'Media Outbox', email: 'media-outbox@example.test' },
    rooms: [mediaRoom],
  } }));
  await context.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await context.route('**/api/assets?room=media-outbox-room*', async (route) => {
    uploadCount += 1;
    uploadId = new URL(route.request().url()).searchParams.get('uploadId') ?? '';
    await route.fulfill({ json: { key: 'queued-photo-key' } });
  });
  await context.route('**/api/rooms/media-outbox-room/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      sendCount += 1;
      const payload = route.request().postDataJSON() as { clientRequestId: string };
      messageRequestId = payload.clientRequestId;
      expect(payload).toMatchObject({ type: 'image', assetKey: 'queued-photo-key' });
      await route.fulfill({ json: { id: 'queued-photo-message' } });
      return;
    }
    await route.fulfill({ json: { messages: [], nextCursor: null } });
  });

  await page.goto('/');
  await expect(page.locator('.conversation-panel')).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel('Tệp hình ảnh').setInputFiles({ name: 'ban-phac-thao.png', mimeType: 'image/png', buffer: Buffer.from('anh thu nghiem') });
  const photoDialog = page.getByRole('dialog', { name: 'Chuẩn bị ảnh' });
  const photoGeometry = await photoDialog.locator('.photo-preparation-dialog').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector('h2');
    const close = element.querySelector<HTMLButtonElement>('.dialog-close');
    return {
      width: bounds.width,
      height: bounds.height,
      titleSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 99,
      closeWidth: close?.getBoundingClientRect().width ?? 0,
      closeIconWidth: close?.querySelector('svg')?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(photoGeometry.width).toBe(390);
  expect(photoGeometry.height).toBe(844);
  expect(photoGeometry.titleSize).toBe(22);
  expect(photoGeometry.closeWidth).toBeGreaterThanOrEqual(44);
  expect(photoGeometry.closeIconWidth).toBe(18);
  await expect(page.getByRole('button', { name: 'Gửi ảnh', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tiếp: Chia sẻ' }).click();
  await page.getByRole('button', { name: 'Gửi ảnh', exact: true }).click();
  const outbox = page.locator('.message-outbox');
  await expect(outbox).toContainText('ban-phac-thao.png');
  expect(uploadCount).toBe(0);
  await page.close();

  await context.setOffline(false);
  const restoredPage = await context.newPage();
  await restoredPage.goto('/');
  const restoredOutbox = restoredPage.locator('.message-outbox');
  await restoredOutbox.getByRole('button', { name: /Chưa thể gửi.*1 mục được lưu/ }).click();
  await expect(restoredOutbox).toContainText('ban-phac-thao.png');
  await restoredOutbox.getByRole('button', { name: 'Thử lại tất cả' }).click();
  await expect.poll(() => ({ uploadCount, sendCount }), { timeout: 15_000 }).toEqual({ uploadCount: 1, sendCount: 1 });
  await expect(restoredOutbox).toHaveCount(0, { timeout: 15_000 });
  expect(uploadCount).toBe(1);
  expect(sendCount).toBe(1);
  expect(uploadId).toBe(messageRequestId);
});

test('hai tab hợp nhất outbox mà không làm mất mục của nhau @critical', async ({ page, context }) => {
  const sharedRoom = { ...room('shared-outbox-room'), messageCount: 1 };
  await context.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'shared-outbox-user', displayName: 'Shared Outbox', email: 'shared-outbox@example.test' },
    rooms: [sharedRoom],
  } }));
  await context.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await context.route('**/api/rooms/shared-outbox-room/messages*', (route) => route.request().method() === 'POST'
    ? route.fulfill({ json: { id: 'sent-after-reconnect' } })
    : route.fulfill({ json: { messages: [], nextCursor: null } }));

  const secondPage = await context.newPage();
  await Promise.all([page.goto('/'), secondPage.goto('/')]);
  await context.setOffline(true);
  await page.getByRole('textbox', { name: 'Nội dung tin nhắn' }).fill('Mục từ tab A');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await secondPage.getByRole('textbox', { name: 'Nội dung tin nhắn' }).fill('Mục từ tab B');
  await secondPage.getByRole('button', { name: 'Gửi tin nhắn' }).click();

  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('net_message_outbox:v3:user:shared-outbox-user:')).length)).toBe(2);
  await expect(page.locator('.message-outbox')).toContainText('2 mục được lưu trên thiết bị này');
  await expect(secondPage.locator('.message-outbox')).toContainText('2 mục được lưu trên thiết bị này');
  await page.close();
  await secondPage.close();
  await context.setOffline(false);
  const restoredPage = await context.newPage();
  await restoredPage.goto('/');
  await expect(restoredPage.locator('.message-outbox')).toContainText('2 mục được lưu trên thiết bị này');
});

test('lỗi gửi vĩnh viễn cho phép xem và sửa nội dung thay vì retry mù @critical', async ({ page }) => {
  const blockedRoom = { ...room('blocked-outbox-room'), messageCount: 1 };
  let firstAttempt = true;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'blocked-user', displayName: 'Blocked User', email: 'blocked@example.test' },
    rooms: [blockedRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/blocked-outbox-room/messages*', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { messages: [], nextCursor: null } });
      return;
    }
    if (firstAttempt) {
      firstAttempt = false;
      await route.abort('connectionrefused');
      return;
    }
    await route.fulfill({ status: 400, json: { error: 'The reply target no longer exists.' } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Nội dung tin nhắn' });
  await composer.fill('Nội dung cần sửa lại');
  await page.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const outbox = page.locator('.message-outbox');
  await expect(outbox).toContainText('Nội dung cần sửa lại');
  await outbox.getByRole('button', { name: 'Thử lại tất cả' }).click();
  await expect(outbox).toContainText('Cần xử lý');
  await expect(outbox).toContainText('The reply target no longer exists.');
  await outbox.getByRole('button', { name: 'Sửa' }).click();
  await expect(composer).toHaveValue('Nội dung cần sửa lại');
  await expect(composer).toBeFocused();
  await expect(outbox).toHaveCount(0);
});

test('ảnh và bản vẽ lỗi vĩnh viễn vẫn có thể phục hồi từng mục @critical', async ({ page }) => {
  const blockedRoom = { ...room('blocked-media-room'), messageCount: 1 };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'blocked-media-user', displayName: 'Blocked Media', email: 'blocked-media@example.test' },
    rooms: [blockedRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/assets?room=blocked-media-room*', async (route) => {
    const uploadId = new URL(route.request().url()).searchParams.get('uploadId');
    expect(uploadId).toBeTruthy();
    await route.fulfill({ json: { key: uploadId } });
  });
  await page.route('**/api/rooms/blocked-media-room/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 400, json: { error: 'The attachment cannot be added to this conversation.' } });
      return;
    }
    await route.fulfill({ json: { messages: [], nextCursor: null } });
  });

  await page.goto('/');
  await page.getByLabel('Tệp hình ảnh').setInputFiles({ name: 'anh-can-xu-ly.png', mimeType: 'image/png', buffer: Buffer.from('anh loi') });
  await page.getByRole('button', { name: 'Tiếp: Chia sẻ' }).click();
  await page.getByRole('button', { name: 'Gửi ảnh', exact: true }).click();
  const outbox = page.locator('.message-outbox');
  await expect(outbox).toContainText('anh-can-xu-ly.png');
  await expect(outbox).toContainText('Cần xử lý');
  await expect(outbox).toContainText('The attachment cannot be added to this conversation.');
  await outbox.getByRole('button', { name: 'Xóa', exact: true }).click();
  await page.getByRole('dialog', { name: 'Xóa mục chưa gửi này?' }).getByRole('button', { name: 'Xóa', exact: true }).click();
  await expect(outbox).toHaveCount(0);

  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Không đo được canvas.');
  await page.mouse.move(box.x + 80, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 150, { steps: 6 });
  await page.mouse.up();
  await expect(studio.getByText('Đã lưu trên thiết bị này')).toBeVisible();
  await studio.getByRole('button', { name: 'Gửi bản vẽ', exact: true }).click();
  await expect(studio).toBeVisible();
  await expect(page.locator('.toast.error')).toContainText('The attachment cannot be added to this conversation.');
  page.once('dialog', (dialog) => dialog.accept());
  await studio.locator('.studio-header').getByRole('button', { name: /Đóng/ }).click();
  await expect(outbox).toContainText('Bản vẽ');
  await expect(outbox).toContainText('Cần xử lý');

  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const restoredStudio = page.getByRole('dialog', { name: 'Nét Studio' });
  await expect(restoredStudio.getByText('Đã khôi phục bản nháp')).toBeVisible();
  await expect(restoredStudio.getByText('1 thao tác')).toBeVisible();
});

test('Studio giữ draft khi thiết bị từ chối lưu metadata outbox @critical', async ({ page }) => {
  const blockedRoom = { ...room('blocked-storage-room'), messageCount: 1 };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'blocked-storage-user', displayName: 'Blocked Storage', email: 'blocked-storage@example.test' },
    rooms: [blockedRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/assets?room=blocked-storage-room*', (route) => {
    const uploadId = new URL(route.request().url()).searchParams.get('uploadId');
    return route.fulfill({ json: { key: uploadId } });
  });
  await page.route('**/api/rooms/blocked-storage-room/messages*', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'Attachment rejected for test.' } })
    : route.fulfill({ json: { messages: [], nextCursor: null } }));

  await page.goto('/');
  await page.evaluate(() => {
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key.startsWith('net_message_outbox:')) throw new DOMException('Outbox storage blocked for test.', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
  });
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Không đo được canvas.');
  await page.mouse.move(box.x + 70, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 150, { steps: 6 });
  await page.mouse.up();
  await expect(studio.getByText('Đã lưu trên thiết bị này')).toBeVisible();
  await studio.getByRole('button', { name: 'Gửi bản vẽ', exact: true }).click();
  await expect(studio).toBeVisible();
  await expect(page.locator('.message-outbox')).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await studio.locator('.studio-header').getByRole('button', { name: /Đóng/ }).click();
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  const restoredStudio = page.getByRole('dialog', { name: 'Nét Studio' });
  await expect(restoredStudio.getByText('Đã khôi phục bản nháp')).toBeVisible();
  await expect(restoredStudio.getByText('1 thao tác')).toBeVisible();
});

test('kết thúc phiên khách xóa outbox riêng tư và blob chưa gửi trên thiết bị @critical', async ({ page }) => {
  const sessionId = '48a85ac5-66b6-4dd5-9798-75127ba08e74';
  const pendingId = '5459ee21-666e-4333-857a-15ca61863084';
  const guestRoom = { ...room('guest-outbox-room'), kind: 'guest' as const, messageCount: 1 };
  await page.addInitScript((guestSession) => sessionStorage.setItem('net_guest_session', guestSession), sessionId);
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'guest', id: sessionId, displayName: 'Guest Outbox', expiresAt: Date.now() + 60_000 },
    rooms: [guestRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/guest-outbox-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.route('**/api/guest/activity', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/guest', (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ json: { retained: true } })
    : route.continue());

  await page.goto('/');
  await page.evaluate(async ({ guestSession, itemId }) => {
    const blobKey = `guest:${guestSession}:${itemId}`;
    localStorage.setItem(`net_message_outbox:v3:guest:${guestSession}:${itemId}`, JSON.stringify({
      id: itemId,
      roomId: 'guest-outbox-room',
      type: 'image',
      text: null,
      assetKey: null,
      canvasParentId: null,
      fileName: 'chua-gui.png',
      blobKey,
      replyToId: null,
      createdAt: Date.now(),
      status: 'waiting',
      error: null,
    }));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('net-message-outbox', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('blobs');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const write = database.transaction('blobs', 'readwrite').objectStore('blobs').put(new Blob(['private']), blobKey);
        write.onerror = () => reject(write.error);
        write.onsuccess = () => { database.close(); resolve(); };
      };
    });
  }, { guestSession: sessionId, itemId: pendingId });
  await page.reload();
  const outbox = page.locator('.message-outbox');
  await outbox.getByRole('button', { name: /Chưa thể gửi.*1 mục được lưu/ }).click();
  await expect(outbox).toContainText('chua-gui.png');
  await page.evaluate(({ guestSession, itemId }) => localStorage.setItem(`net_message_outbox:v3:guest:${guestSession}:${itemId}`, '{corrupt'), { guestSession: sessionId, itemId: pendingId });
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();

  await expect.poll(() => page.evaluate(async ({ guestSession, itemId }) => {
    const metadata = localStorage.getItem(`net_message_outbox:v3:guest:${guestSession}:${itemId}`);
    const blobKey = `guest:${guestSession}:${itemId}`;
    const blob = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('net-message-outbox', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction('blobs', 'readonly').objectStore('blobs').get(blobKey);
        read.onerror = () => reject(read.error);
        read.onsuccess = () => { database.close(); resolve(read.result); };
      };
    });
    return { metadata, hasBlob: blob instanceof Blob };
  }, { guestSession: sessionId, itemId: pendingId })).toEqual({ metadata: null, hasBlob: false });
});

test('kết thúc guest thắng race với attachment đang được ghi vào outbox @critical', async ({ page }) => {
  const sessionId = '8c8409af-5e93-4fe5-8895-bd5307bfc04f';
  const guestRoom = { ...room('guest-outbox-race-room'), kind: 'guest' as const, messageCount: 1 };
  await page.addInitScript((guestSession) => sessionStorage.setItem('net_guest_session', guestSession), sessionId);
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'guest', id: sessionId, displayName: 'Guest Race', expiresAt: Date.now() + 60_000 },
    rooms: [guestRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/guest-outbox-race-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.route('**/api/guest/activity', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/assets?room=guest-outbox-race-room*', (route) => route.abort('connectionrefused'));
  await page.route('**/api/guest', (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ json: { retained: true } })
    : route.continue());

  await page.goto('/');
  await page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
      if (this.transaction.db.name !== 'net-message-outbox') return request;
      (window as unknown as { __outboxPutStarted: boolean }).__outboxPutStarted = true;
      request.addEventListener('success', (event) => {
        event.stopImmediatePropagation();
        const handler = request.onsuccess;
        request.onsuccess = null;
        window.setTimeout(() => handler?.call(request, event), 800);
      }, { capture: true, once: true });
      return request;
    };
  });
  await page.getByLabel('Tệp hình ảnh').setInputFiles({ name: 'race-private.png', mimeType: 'image/png', buffer: Buffer.from('private race') });
  await page.getByRole('button', { name: 'Tiếp: Chia sẻ' }).click();
  await page.getByRole('button', { name: 'Gửi ảnh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __outboxPutStarted?: boolean }).__outboxPutStarted))).toBe(true);
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  await page.waitForTimeout(900);

  await expect.poll(() => page.evaluate(async (guestSession) => {
    const metadataKeys = Object.keys(localStorage).filter((key) => key.startsWith(`net_message_outbox:v3:guest:${guestSession}:`));
    const blobKeys = await new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open('net-message-outbox', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const keys = database.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys();
        keys.onerror = () => reject(keys.error);
        keys.onsuccess = () => { database.close(); resolve(keys.result.filter((key): key is string => typeof key === 'string')); };
      };
    });
    return { metadataCount: metadataKeys.length, privateBlobCount: blobKeys.filter((key) => key.startsWith(`guest:${guestSession}:`)).length };
  }, sessionId)).toEqual({ metadataCount: 0, privateBlobCount: 0 });
});

test('Studio giữ đúng tỷ lệ nguồn khi tiếp nối bản vẽ dọc @critical', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sourceRoom = { ...room('source-aspect-room'), messageCount: 2 };
  const portraitSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#f4e9ff"/><path d="M30 60L270 540" stroke="#6f4ee8" stroke-width="16"/></svg>';
  const portraitSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg)}`;
  let releaseSource: (() => void) | undefined;
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  const canvasMessage = {
    ...message(1),
    id: 'portrait-canvas',
    roomId: sourceRoom.id,
    type: 'canvas',
    body: 'Bản phác thảo dọc',
    assetKey: 'portrait-source',
    assetUrl: portraitSource,
    canvasVersion: 1,
  };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'aspect-user', displayName: 'Aspect User', email: 'aspect@example.test' },
    rooms: [sourceRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/source-aspect-room/messages*', (route) => route.fulfill({ json: { messages: [canvasMessage], nextCursor: null } }));
  await page.route('**/api/assets/portrait-source/access', (route) => route.fulfill({ json: { assetUrl: '/slow-portrait.svg' } }));
  await page.route('**/slow-portrait.svg', async (route) => {
    await sourceGate;
    await route.fulfill({ contentType: 'image/svg+xml', body: portraitSvg });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Vẽ tiếp bản này/ }).click();
  const studio = page.getByRole('dialog', { name: /Nét Studio · V1/ });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  await studio.getByRole('button', { name: 'Lớp nguồn' }).click();
  const settings = studio.getByRole('dialog', { name: 'Cài đặt công cụ' });
  await expect(settings.getByRole('button', { name: 'Kem' })).toBeDisabled();
  releaseSource?.();
  await expect(canvas).toHaveAttribute('width', '300');
  await expect(canvas).toHaveAttribute('height', '600');
  await expect(settings.getByRole('button', { name: 'Kem' })).toBeEnabled();
  const box = await canvas.boundingBox();
  expect(box ? Math.abs(box.width / box.height - 0.5) : Number.POSITIVE_INFINITY).toBeLessThan(0.01);
  await expect(studio.getByText('Bản vẽ tiếp nối tự động giữ nguyên hình dạng giấy gốc.')).toBeVisible();
  await settings.getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  let discardDialogs = 0;
  page.on('dialog', async (dialog) => { discardDialogs += 1; await dialog.dismiss(); });
  await studio.locator('.studio-header').getByRole('button', { name: /Đóng/ }).click();
  await expect(studio).toBeHidden();
  expect(discardDialogs).toBe(0);
});

test('Studio pinch-to-zoom và pan hai ngón không tạo nét ngoài ý muốn @critical', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const studioRoom = { ...room('studio-gesture-room'), messageCount: 1 };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'gesture-user', displayName: 'Gesture User', email: 'gesture@example.test' },
    rooms: [studioRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/studio-gesture-room/messages*', (route) => route.fulfill({ json: { messages: [], nextCursor: null } }));
  await page.goto('/');
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();

  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  const viewport = studio.locator('.canvas-viewport');
  await studio.locator('.gesture-coach').getByRole('button', { name: 'Đã hiểu' }).click();
  await studio.getByRole('button', { name: 'Màu và cài đặt công cụ' }).click();
  const settings = studio.getByRole('dialog', { name: 'Cài đặt công cụ' });
  await settings.getByRole('button', { name: 'Ngang' }).click();
  await settings.getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  const actionStatus = studio.locator('.canvas-commandbar>span');
  await expect(actionStatus).toContainText('0 thao tác');
  await expect(canvas).toHaveAttribute('aria-describedby', 'canvas-gesture-description');
  await expect(studio.locator('#canvas-gesture-description')).toContainText('Một ngón vẽ · hai ngón thu phóng và di chuyển');
  const viewportBox = await viewport.boundingBox();
  if (!viewportBox) throw new Error('Không đo được viewport canvas cho gesture.');
  const center = { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 };
  const client = await context.newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const dispatchTouch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ id: number; x: number; y: number }>) => {
    await client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((point) => ({ ...point, radiusX: 5, radiusY: 5, force: 0.5 })),
    });
  };

  await dispatchTouch('touchStart', [
    { id: 1, x: center.x - 40, y: center.y },
    { id: 2, x: center.x + 40, y: center.y },
  ]);
  await dispatchTouch('touchMove', [
    { id: 1, x: center.x - 70, y: center.y },
    { id: 2, x: center.x + 70, y: center.y },
  ]);
  await dispatchTouch('touchEnd', []);

  await expect(studio.getByLabel('Mức phóng đại')).toHaveText('175%');
  await expect(actionStatus).toContainText('0 thao tác');
  const scrollAfterZoom = await viewport.evaluate((element) => element.scrollLeft);
  expect(scrollAfterZoom).toBeGreaterThan(0);

  await dispatchTouch('touchStart', [
    { id: 3, x: center.x - 55, y: center.y },
    { id: 4, x: center.x + 55, y: center.y },
  ]);
  await dispatchTouch('touchMove', [
    { id: 3, x: center.x - 95, y: center.y },
    { id: 4, x: center.x + 15, y: center.y },
  ]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await dispatchTouch('touchEnd', []);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollAfterZoom + 20);
  await expect(actionStatus).toContainText('0 thao tác');

  const visibleCanvasBox = await canvas.boundingBox();
  if (!visibleCanvasBox) throw new Error('Không đo được canvas sau gesture.');
  const strokeStart = {
    x: Math.max(viewportBox.x + 60, visibleCanvasBox.x + 80),
    y: Math.max(viewportBox.y + 90, visibleCanvasBox.y + 90),
  };
  await dispatchTouch('touchStart', [{ id: 5, ...strokeStart }]);
  await dispatchTouch('touchMove', [{ id: 5, x: strokeStart.x + 45, y: strokeStart.y + 28 }]);
  await dispatchTouch('touchEnd', []);
  await expect(actionStatus).toContainText('1 thao tác');
  await expect(studio.getByRole('button', { name: 'Hoàn tác' })).toBeEnabled();
  await client.detach();
});

test('vẽ và tiếp tục bản vẽ là hành động nổi bật nhưng message mobile vẫn gọn @critical', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const canvasRoom = { ...room('canvas-conversation-room'), messageCount: 1, mediaCount: 1 };
  const canvasMessage = {
    ...message(1, ''),
    id: 'canvas-message',
    roomId: canvasRoom.id,
    type: 'canvas',
    body: null,
    assetKey: 'canvas-asset',
    assetUrl: '/api/assets/canvas-asset?access=review',
    canvasVersion: 2,
    continuationCount: 7,
  };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [canvasRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/canvas-conversation-room/messages*', (route) => route.fulfill({ json: { messages: [canvasMessage], nextCursor: null } }));
  await page.goto('/');

  const modes = page.locator('.composer-modes');
  await expect(modes.getByRole('button', { name: 'Chữ' })).toBeVisible();
  await expect(modes.getByRole('button', { name: 'Vẽ' })).toBeVisible();
  await expect(modes.getByRole('button', { name: 'Ảnh' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Vẽ tiếp bản này.*phiên bản 3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Bản vẽ gốc.*7 lượt tiếp nối/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'So sánh phiên bản' })).toBeVisible();
  await expect(page.locator('.message-tools')).not.toBeVisible();
  const overflow = page.locator('.message-overflow');
  await expect(overflow).toBeVisible();
  const overflowBox = await overflow.locator('summary').boundingBox();
  expect(overflowBox?.width).toBeGreaterThanOrEqual(44);
  expect(overflowBox?.height).toBeGreaterThanOrEqual(44);
  await overflow.locator('summary').click();
  await expect(overflow.getByRole('button', { name: 'Trả lời' })).toBeVisible();
  for (const reaction of await overflow.locator('div>span button').all()) {
    const reactionBox = await reaction.boundingBox();
    expect(reactionBox?.width).toBeGreaterThanOrEqual(44);
    expect(reactionBox?.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'Thêm thao tác cuộc trò chuyện' }).click();
  const inviteBox = await page.locator('#mobile-header-actions').getByRole('button', { name: 'Mời bằng link' }).boundingBox();
  expect(inviteBox?.width).toBeGreaterThanOrEqual(44);
  expect(inviteBox?.height).toBeGreaterThanOrEqual(44);
});

test('lịch sử bản vẽ cho phép so sánh và tiếp tục từ bất kỳ phiên bản nào @critical', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const canvasRoom = { ...room('canvas-lineage-room'), messageCount: 3, mediaCount: 3 };
  const lineage = [1, 2, 3].map((version) => ({
    ...message(version, version === 2 ? 'Thêm một nhánh cây' : ''),
    id: `canvas-v${version}`,
    roomId: canvasRoom.id,
    senderName: version === 1 ? 'Minh Anh' : 'Review User',
    senderId: version === 1 ? 'minh-anh' : 'review-user',
    type: 'canvas',
    assetKey: `canvas-asset-v${version}`,
    assetUrl: `/api/assets/canvas-asset-v${version}?access=review`,
    canvasParentId: version === 1 ? null : `canvas-v${version - 1}`,
    canvasVersion: version,
  }));
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [canvasRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/canvas-lineage-room/messages/canvas-v3/lineage', (route) => route.fulfill({ json: { lineage } }));
  await page.route('**/api/rooms/canvas-lineage-room/messages*', (route) => route.fulfill({ json: { messages: [lineage[2]], nextCursor: null } }));
  await page.route('**/api/assets/canvas-asset-v*', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720"><rect width="100%" height="100%" fill="#f7f2ff"/><path d="M120 500 Q480 110 1080 430" fill="none" stroke="#6f4ee8" stroke-width="28"/></svg>',
  }));
  await page.route('**/api/assets/*/access', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').at(-2);
    return route.fulfill({ json: { assetUrl: `/api/assets/${key}?access=refreshed` } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Xem lịch sử 3 phiên bản|Xem lịch sử phiên bản/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Lịch sử hình ảnh' });
  await expect(dialog).toBeVisible();
  const lineageGeometry = await dialog.locator('.lineage-dialog').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector<HTMLElement>('.lineage-header');
    const title = element.querySelector('h2');
    const close = element.querySelector<HTMLButtonElement>('.dialog-close');
    const metadata = element.querySelector<HTMLElement>('.lineage-filmstrip small');
    const footer = element.querySelector<HTMLElement>('.lineage-footer');
    const decisionActions = [...element.querySelectorAll<HTMLElement>('.lineage-decision-actions button')];
    return {
      width: bounds.width,
      height: bounds.height,
      headerHeight: header?.getBoundingClientRect().height ?? 99,
      titleSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 99,
      closeWidth: close?.getBoundingClientRect().width ?? 0,
      closeIconWidth: close?.querySelector('svg')?.getBoundingClientRect().width ?? 0,
      metadataSize: metadata ? Number.parseFloat(getComputedStyle(metadata).fontSize) : 0,
      footerHeight: footer?.getBoundingClientRect().height ?? 99,
      decisionActionHeights: decisionActions.map((button) => button.getBoundingClientRect().height),
    };
  });
  expect(lineageGeometry.width).toBe(390);
  expect(lineageGeometry.height).toBe(844);
  expect(lineageGeometry.headerHeight).toBeLessThanOrEqual(72);
  expect(lineageGeometry.titleSize).toBeLessThanOrEqual(22);
  expect(lineageGeometry.closeWidth).toBeGreaterThanOrEqual(44);
  expect(lineageGeometry.closeIconWidth).toBe(18);
  expect(lineageGeometry.metadataSize).toBeGreaterThanOrEqual(12);
  expect(lineageGeometry.footerHeight).toBeLessThanOrEqual(64);
  expect(lineageGeometry.decisionActionHeights.every((height) => height >= 44)).toBe(true);
  await expect(dialog.getByText('3 phiên bản')).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Bản vẽ phiên bản 3 của Review User' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'So sánh với' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'So sánh phiên bản' }).click();
  await expect(dialog.getByRole('combobox', { name: 'So sánh với' })).toHaveValue('canvas-v2');
  await expect(dialog.getByRole('img', { name: 'Bản so sánh A · phiên bản 2' })).toBeHidden();
  await expect(dialog.getByRole('img', { name: 'Bản so sánh B · phiên bản 3' })).toBeVisible();
  const previewChoice = dialog.getByRole('group', { name: 'Chọn phiên bản để xem trước' });
  await previewChoice.getByRole('button', { name: /A · Phiên bản 2/ }).click();
  await expect(dialog.getByRole('img', { name: 'Bản so sánh A · phiên bản 2' })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Bản so sánh B · phiên bản 3' })).toBeHidden();
  await previewChoice.getByRole('button', { name: /B · Phiên bản 3/ }).click();
  const continueButton = dialog.getByRole('button', { name: /Vẽ tiếp từ phiên bản 3/ });
  const continueBox = await continueButton.boundingBox();
  expect(continueBox?.height).toBeGreaterThanOrEqual(44);
  await dialog.getByRole('button', { name: /Phiên bản 1.*Minh Anh/ }).click();
  await expect(dialog.getByRole('heading', { name: 'So sánh với Phiên bản 1', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'So sánh với' })).toHaveValue('canvas-v2');
  await expect(dialog.getByRole('button', { name: /Vẽ tiếp từ phiên bản 1/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Vẽ tiếp từ phiên bản 1/ }).click();
  await expect(page.getByRole('dialog', { name: /Nét Studio · V1/ })).toBeVisible();
});

test('lịch sử chỉ có một phiên bản không hiển thị hành động so sánh @critical', async ({ page }) => {
  const canvasRoom = { ...room('single-lineage-room'), messageCount: 1, mediaCount: 1 };
  const onlyVersion = {
    ...message(1, ''),
    id: 'single-canvas-v1',
    roomId: canvasRoom.id,
    senderName: 'Review User',
    senderId: 'review-user',
    type: 'canvas',
    assetKey: 'single-canvas-asset',
    assetUrl: '/api/assets/single-canvas-asset?access=review',
    canvasVersion: 1,
  };
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' },
    rooms: [canvasRoom],
  } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'Dùng polling trong test' } }));
  await page.route('**/api/rooms/single-lineage-room/messages/single-canvas-v1/lineage', (route) => route.fulfill({ json: { lineage: [onlyVersion] } }));
  await page.route('**/api/rooms/single-lineage-room/messages*', (route) => route.fulfill({ json: { messages: [onlyVersion], nextCursor: null } }));
  await page.route('**/api/assets/single-canvas-asset*', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720"><rect width="100%" height="100%" fill="#f7f2ff"/></svg>',
  }));

  await page.goto('/');
  await page.getByRole('button', { name: /Xem lịch sử phiên bản/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Lịch sử hình ảnh' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'So sánh phiên bản' })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: 'So sánh với' })).toHaveCount(0);
  await expect(dialog.locator('.lineage-filmstrip')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Vẽ tiếp từ phiên bản 1/ })).toBeVisible();
});

test('ảnh là nguồn sáng tạo với CTA 44px, source layer và lineage parent được giữ khi gửi @critical', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const photoRoom = { ...room('photo-source-room'), messageCount: 1, mediaCount: 1 };
  const photo = {
    ...message(1, 'Ảnh sản phẩm cần thử hướng mới'),
    id: 'source-photo-message',
    roomId: photoRoom.id,
    senderName: 'Minh Anh',
    senderId: 'minh-anh',
    type: 'image',
    assetKey: 'source-photo-asset',
    assetUrl: '/api/assets/source-photo-asset?access=initial',
    continuationCount: 2,
  };
  let sentPayload: Record<string, unknown> | null = null;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: { actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' }, rooms: [photoRoom] } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'polling' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { colors: [] } }));
  await page.route('**/api/assets/source-photo-asset/access', (route) => route.fulfill({ json: { assetUrl: '/api/assets/source-photo-asset?access=refreshed' } }));
  await page.route('**/api/assets/source-photo-asset?*', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#f2c6a0"/><circle cx="600" cy="400" r="220" fill="#6f4ee8"/></svg>' }));
  await page.route('**/api/assets?room=photo-source-room*', (route) => route.fulfill({ json: { key: 'continued-photo-asset' } }));
  await page.route('**/api/rooms/photo-source-room/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      sentPayload = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { id: 'photo-version-1', sequence: 2, createdAt: Date.now(), canvasVersion: 1 } });
    }
    return route.fulfill({ json: { messages: [photo], nextCursor: null, hasMoreAfter: false } });
  });

  await page.goto('/');
  const continuePhoto = page.getByRole('button', { name: /Tiếp tục với ảnh này/ });
  const actionBox = await continuePhoto.boundingBox();
  expect(actionBox?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText('2 lượt tiếp nối')).toBeVisible();
  await continuePhoto.click();
  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  await expect(studio).toBeVisible();
  await expect(studio.getByText('Dựa trên ảnh của Minh Anh')).toBeVisible();
  await studio.getByRole('button', { name: 'Lớp nguồn' }).click();
  await expect(studio.getByText('Lớp nguồn')).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Ẩn nguồn' })).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Vừa khung' })).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Cắt phủ' })).toBeVisible();
  await studio.getByRole('dialog', { name: 'Cài đặt công cụ' }).getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  const canvas = studio.locator('canvas').last();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error('Canvas is not ready');
  await page.mouse.move(canvasBox.x + canvasBox.width * .35, canvasBox.y + canvasBox.height * .4);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * .58, canvasBox.y + canvasBox.height * .55, { steps: 5 });
  await page.mouse.up();
  await studio.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect.poll(() => sentPayload).not.toBeNull();
  expect(sentPayload).toMatchObject({ type: 'canvas', assetKey: 'continued-photo-asset', canvasParentId: photo.id });
});

test('người quay lại mở tại first unread với ngày thật và chỉ đọc khi đến latest @critical', async ({ page }) => {
  const unreadRoom = { ...room('unread-context-room'), unreadCount: 3, firstUnreadSequence: 2, lastReadSequence: 1, messageCount: 5 };
  const today = Date.now();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const old = new Date('2026-07-14T08:00:00+07:00').getTime();
  const unreadMessages = [
    { ...message(2, 'Tin cũ theo ngày'), roomId: unreadRoom.id, createdAt: old },
    { ...message(3, 'Tin hôm qua'), roomId: unreadRoom.id, createdAt: yesterday },
    { ...message(4, 'Tin hôm nay'), roomId: unreadRoom.id, createdAt: today },
  ];
  let initialUrl = '';
  let readRequests = 0;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: { actor: { kind: 'user', id: 'review-user', displayName: 'Review User', email: 'review@example.test' }, rooms: [unreadRoom] } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'polling' } }));
  await page.route('**/api/rooms/unread-context-room/messages*', (route) => {
    if (route.request().method() === 'PATCH') { readRequests += 1; return route.fulfill({ json: { readAt: Date.now(), messageId: 'message-4', sequence: 4 } }); }
    initialUrl ||= route.request().url();
    return route.fulfill({ json: { messages: unreadMessages, nextCursor: '2', hasMoreAfter: true } });
  });
  await page.goto('/');
  await expect(page.getByText('3 tin nhắn mới')).toBeVisible();
  expect(initialUrl).toContain('from=2');
  await expect(page.getByText('Hôm qua', { exact: true })).toBeVisible();
  await expect(page.getByText(/14.*tháng 7.*2026/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Đến tin mới nhất/ })).toBeVisible();
  await page.waitForTimeout(300);
  expect(readRequests).toBe(0);
  await expect(page.locator('.message-scroll')).not.toHaveAttribute('aria-live');
});

test('People & Safety hiển thị vai trò, mute, report và thu hồi invite trong một bề mặt @critical', async ({ page }) => {
  const safetyRoom = { ...room('safety-room'), messageCount: 1 };
  let muted = false;
  let inviteRevoked = false;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: { actor: { kind: 'user', id: 'owner-user', displayName: 'Chủ phòng', email: 'owner@example.test' }, rooms: [safetyRoom] } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'polling' } }));
  await page.route('**/api/rooms/safety-room/messages*', (route) => route.fulfill({ json: { messages: [message(1)], nextCursor: null } }));
  await page.route('**/api/rooms/safety-room/people', (route) => route.fulfill({ json: { members: [
    { id: 'owner-user', kind: 'user', displayName: 'Chủ phòng', avatarColor: '#6f4ee8', role: 'owner', joinedAt: 1 },
    { id: 'member-user', kind: 'user', displayName: 'Bảo Nét', avatarColor: '#ef7668', role: 'member', joinedAt: 2 },
  ], currentRole: 'owner', muted, allowGuests: true, guestAdmissionPolicy: 'approval', canManage: true, kind: 'group', inviteActive: true, inviteExpiresAt: null, inviteMaxUses: 5, inviteUseCount: 1, blockedAccounts: [] } }));
  await page.route('**/api/rooms/safety-room/guest-requests', (route) => route.fulfill({ json: { requests: [], pendingCount: 0 } }));
  await page.route('**/api/rooms/safety-room/preferences', async (route) => { muted = Boolean((route.request().postDataJSON() as { muted: boolean }).muted); return route.fulfill({ json: { muted } }); });
  await page.route('**/api/rooms/safety-room/governance', async (route) => {
    const payload = route.request().postDataJSON() as { inviteActive?: boolean };
    inviteRevoked = payload.inviteActive === false;
    return route.fulfill({ json: { ...safetyRoom, inviteActive: false, guestAdmissionPolicy: 'approval', allowGuests: true, inviteExpiresAt: null, inviteMaxUses: 5, inviteUseCount: 1, cancelledRequestCount: 0 } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }).click();
  await page.getByRole('button', { name: 'Thành viên & An toàn' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thành viên & An toàn' });
  await expect(dialog.getByText('Bảo Nét')).toBeVisible();
  await expect(dialog.getByText('Chủ phòng', { exact: true }).first()).toBeVisible();
  const managementGeometry = await dialog.locator('.people-safety-dialog').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector('h2');
    const close = element.querySelector<HTMLButtonElement>('.dialog-close');
    const tabs = element.querySelector<HTMLElement>('.people-safety-tabs');
    const people = element.querySelector<HTMLElement>('.people-list');
    return {
      width: bounds.width,
      rightGap: window.innerWidth - bounds.right,
      titleSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 99,
      closeWidth: close?.getBoundingClientRect().width ?? 0,
      closeIconWidth: close?.querySelector('svg')?.getBoundingClientRect().width ?? 0,
      tabWrap: tabs ? getComputedStyle(tabs).flexWrap : 'wrap',
      peopleBorder: people ? getComputedStyle(people).borderTopWidth : '1px',
    };
  });
  expect(managementGeometry.width).toBeLessThanOrEqual(720);
  expect(managementGeometry.rightGap).toBeLessThanOrEqual(1);
  expect(managementGeometry.titleSize).toBeLessThanOrEqual(24);
  expect(managementGeometry.closeWidth).toBeGreaterThanOrEqual(44);
  expect(managementGeometry.closeIconWidth).toBe(18);
  expect(managementGeometry.tabWrap).toBe('nowrap');
  expect(managementGeometry.peopleBorder).toBe('0px');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => dialog.locator('.people-safety-dialog').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [Math.round(bounds.width), Math.round(bounds.height)];
  })).toEqual([390, 844]);
  await dialog.getByRole('tab', { name: 'An toàn' }).click();
  const mute = dialog.getByRole('button', { name: /Tắt thông báo/ });
  expect((await mute.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await mute.click();
  await expect(dialog.getByRole('button', { name: /Bật lại thông báo/ })).toBeVisible();
  await dialog.getByRole('tab', { name: /Mọi người/ }).click();
  await dialog.locator('summary[aria-label="Thao tác với Bảo Nét"]').click();
  await expect(dialog.getByRole('button', { name: 'Báo cáo', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Xóa', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Quyền truy cập & lời mời' }).click();
  await dialog.getByRole('button', { name: 'Thu hồi lời mời' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Thu hồi lời mời này?' });
  await expect(confirmation.getByText('Tin nhắn, bản vẽ và thành viên hiện tại không bị xóa.')).toBeVisible();
  const confirmationGeometry = await confirmation.locator('.confirmation-dialog').evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    titleSize: Number.parseFloat(getComputedStyle(element.querySelector('h2')!).fontSize),
    bodySize: Number.parseFloat(getComputedStyle(element.querySelector('p')!).fontSize),
    eyebrowDisplay: getComputedStyle(element.querySelector<HTMLElement>('.eyebrow')!).display,
  }));
  expect(confirmationGeometry.width).toBeLessThanOrEqual(440);
  expect(confirmationGeometry.titleSize).toBe(20);
  expect(confirmationGeometry.bodySize).toBeGreaterThanOrEqual(15);
  expect(confirmationGeometry.eyebrowDisplay).toBe('none');
  await confirmation.getByRole('button', { name: 'Thu hồi lời mời' }).click();
  await expect.poll(() => inviteRevoked).toBe(true);
  await dialog.getByRole('tab', { name: 'An toàn' }).click();
  await expect(dialog.getByRole('button', { name: 'Báo cáo cuộc trò chuyện' })).toBeVisible();
});

test('badge yêu cầu mở thẳng hàng đợi và tách trạng thái đang chờ với đã duyệt @critical', async ({ page }) => {
  const admissionRoom = { ...room('admission-ui-room'), pendingRequestCount: 2 };
  const requestedAt = Date.now() - 3 * 60_000;
  const requests = [
    { id: 'pending-request', displayName: 'Lan Guest', introduction: 'Mình muốn tiếp tục bản phác.', status: 'pending', requestedAt, expiresAt: Date.now() + 23 * 60 * 60_000, grantExpiresAt: null, inviteCodeHint: 'ABC123', decisionReason: null },
    { id: 'approved-request', displayName: 'Mai Guest', introduction: null, status: 'approved', requestedAt: requestedAt - 60_000, expiresAt: Date.now() + 23 * 60 * 60_000, grantExpiresAt: Date.now() + 60 * 60_000, inviteCodeHint: 'ABC123', decisionReason: null },
  ];
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: { actor: { kind: 'user', id: 'owner-user', displayName: 'Chủ phòng', email: 'owner@example.test' }, rooms: [admissionRoom] } }));
  await page.route('**/api/realtime/token', (route) => route.fulfill({ status: 503, json: { error: 'polling' } }));
  await page.route('**/api/rooms/admission-ui-room/messages*', (route) => route.fulfill({ json: { messages: [message(1)], nextCursor: null } }));
  await page.route('**/api/rooms/admission-ui-room/people', (route) => route.fulfill({ json: { members: [], currentRole: 'owner', muted: false, allowGuests: true, guestAdmissionPolicy: 'approval', canManage: true, kind: 'group', inviteActive: true, inviteExpiresAt: null, inviteMaxUses: null, inviteUseCount: 1, blockedAccounts: [] } }));
  await page.route('**/api/rooms/admission-ui-room/guest-requests', (route) => route.fulfill({ json: { requests, pendingCount: 1 } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Mở 2 yêu cầu tham gia Phòng kiểm thử' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thành viên & An toàn' });
  await expect(dialog.getByRole('tab', { name: /Yêu cầu/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { name: 'Đang chờ duyệt' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Đã duyệt · Đang chờ vào phòng' })).toBeVisible();
  await expect(page.locator('#guest-request-pending-request')).toHaveClass(/highlighted/);
  await expect(dialog.getByText(/3 phút trước/)).toBeVisible();
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

  const overflow = page.locator('.message-overflow');
  await overflow.locator('summary').click();
  const directDownload = page.waitForEvent('download');
  await overflow.getByRole('button', { name: 'Tải xuống', exact: true }).click();
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

test('API invite chỉ lộ ngữ cảnh xã hội an toàn và trang đăng nhập giữ ngữ cảnh phòng @critical', async ({ page, request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for invite preview E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  const stamp = Date.now();
  const actorId = `invite-owner-${stamp}`;
  const memberIds = [`invite-member-a-${stamp}`, `invite-member-b-${stamp}`];
  const overflowMemberIds = Array.from({ length: 19 }, (_, index) => `invite-overflow-${index}-${stamp}`);
  const authorization = `Bearer ${userToken(actorId, 'Minh Anh')}`;
  let roomId = '';
  await db.insert(users).values([
    { id: actorId, email: `${actorId}@example.test`, displayName: 'Minh Anh', avatarColor: '#6f4ee8', createdAt: stamp, updatedAt: stamp },
    ...memberIds.map((id, index) => ({ id, email: `${id}@example.test`, displayName: index ? 'An Vẽ' : 'Bảo Nét', avatarColor: index ? '#3aa694' : '#ef7668', createdAt: stamp, updatedAt: stamp })),
  ]);
  try {
    const created = await request.post(`${API_URL}/rooms`, {
      headers: { authorization },
      data: { name: 'Weekend Sketch Club', memberIds, allowGuests: true },
    });
    expect(created.ok()).toBe(true);
    const room = await created.json() as { id: string; inviteCode: string };
    roomId = room.id;
    const sent = await request.post(`${API_URL}/rooms/${room.id}/messages`, {
      headers: { authorization },
      data: { type: 'text', text: 'Nội dung riêng không được lộ trong preview', clientRequestId: randomUUID() },
    });
    expect(sent.ok()).toBe(true);
    const inspected = await request.get(`${API_URL}/invites/${room.inviteCode}`);
    expect(inspected.ok()).toBe(true);
    const payload = await inspected.json() as {
      room: { name: string; hostedBy: string; participantCount: number; participants: Array<{ displayName: string }>; recentActivity: { type: string } };
      guestAllowed: boolean;
    };
    expect(payload).toMatchObject({ guestAllowed: true, room: { name: 'Weekend Sketch Club', hostedBy: 'Minh Anh', participantCount: 3, recentActivity: { type: 'text' } } });
    expect(payload.room.participants.map((participant) => participant.displayName)).toEqual(expect.arrayContaining(['Minh Anh', 'Bảo Nét', 'An Vẽ']));
    expect(JSON.stringify(payload)).not.toContain('Nội dung riêng');
    await db.insert(users).values(overflowMemberIds.map((id, index) => ({ id, email: `${id}@example.test`, displayName: `Thành viên ${index + 4}`, avatarColor: '#4e8fb8', createdAt: stamp, updatedAt: stamp })));
    await db.insert(roomMembers).values(overflowMemberIds.map((userId, index) => ({ roomId: room.id, userId, role: 'member' as const, joinedAt: stamp + index + 10 })));
    const crowdedPreview = await request.get(`${API_URL}/invites/${room.inviteCode}`);
    await expect(crowdedPreview.json()).resolves.toMatchObject({ room: { participantCount: 22, hostedBy: 'Minh Anh' } });
    const returnTo = `/?room=${encodeURIComponent(room.inviteCode)}`;
    await page.goto(`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    await expect(page.getByText('Weekend Sketch Club')).toBeVisible();
    await expect(page.getByText(/Phòng do Minh Anh tạo · 22 người/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hiện mật khẩu' })).toBeVisible();
  } finally {
    if (roomId) await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(users).where(inArray(users.id, [actorId, ...memberIds, ...overflowMemberIds]));
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
    await db.insert(messages).values(Array.from({ length: 105 }, (_, index) => ({
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
    await request.delete(`${API_URL}/guest`, { headers: headersA }).catch(() => undefined);
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
