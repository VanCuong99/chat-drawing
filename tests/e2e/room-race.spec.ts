import { expect, test } from '@playwright/test';

const room = (id: string, name: string) => ({
  id, name, kind: 'group', inviteCode: `${id}-invite`, allowGuests: true,
  preview: `Xem ${name}`, lastActivity: 1, unreadCount: 0,
});

const message = (id: string, roomId: string, body: string) => ({
  id, roomId, senderId: 'other', guestSessionId: null, senderName: 'Bạn chat', type: 'text', body,
  assetKey: null, assetUrl: null, replyToId: null, canvasParentId: null, canvasVersion: null,
  createdAt: 1, editedAt: null, readCount: 0, reactions: [],
});

test('response cũ không ghi đè phòng vừa chọn @critical', async ({ page }) => {
  let roomARequestCount = 0;
  let releaseRoomA!: () => void;
  let markRoomARequested!: () => void;
  let markOldFulfilled!: () => void;
  const roomARequested = new Promise<void>((resolve) => { markRoomARequested = resolve; });
  const roomARelease = new Promise<void>((resolve) => { releaseRoomA = resolve; });
  const oldFulfilled = new Promise<void>((resolve) => { markOldFulfilled = resolve; });

  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'test-user', displayName: 'E2E User', email: 'e2e@example.test' },
    rooms: [room('room-a', 'Phòng A'), room('room-b', 'Phòng B')],
  } }));
  await page.route('**/api/rooms/*/messages*', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ json: { readAt: Date.now() } });
      return;
    }
    if (route.request().url().includes('/room-a/')) {
      roomARequestCount += 1;
      if (roomARequestCount === 1) {
        markRoomARequested();
        await roomARelease;
        await route.fulfill({ json: { messages: [message('a-old', 'room-a', 'Tin A cũ về trễ')], nextCursor: null } });
        markOldFulfilled();
      } else await route.fulfill({ json: { messages: [message('a-new', 'room-a', 'Tin A mới nhất')], nextCursor: null } });
      return;
    }
    await route.fulfill({ json: { messages: [message('b-1', 'room-b', 'Tin của phòng B')], nextCursor: null } });
  });

  await page.goto('/');
  await roomARequested;
  await page.getByRole('button', { name: /Phòng B/ }).click();
  await expect(page.getByRole('main').getByText('Tin của phòng B')).toBeVisible();
  await page.getByRole('button', { name: /Phòng A/ }).click();
  await expect(page.getByRole('main').getByText('Tin A mới nhất')).toBeVisible();
  releaseRoomA();
  await oldFulfilled;
  await expect(page.getByRole('main').getByText('Tin A cũ về trễ')).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Tin A mới nhất')).toBeVisible();
});

test('poll loại tin đã bị xoá khỏi shared room @critical', async ({ page }) => {
  let getCount = 0;
  let markSecondGet!: () => void;
  const secondGet = new Promise<void>((resolve) => { markSecondGet = resolve; });
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: {
    actor: { kind: 'user', id: 'test-user', displayName: 'E2E User', email: 'e2e@example.test' },
    rooms: [room('shared-room', 'Phòng chung')],
  } }));
  await page.route('**/api/rooms/*/messages*', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ json: { readAt: Date.now() } });
      return;
    }
    getCount += 1;
    if (getCount === 1) {
      await route.fulfill({ json: { messages: [message('deleted-message', 'shared-room', 'Tin sắp bị xoá')], nextCursor: null } });
    } else {
      await route.fulfill({ json: { messages: [], nextCursor: null } });
      markSecondGet();
    }
  });

  await page.goto('/');
  await expect(page.getByRole('main').getByText('Tin sắp bị xoá')).toBeVisible();
  await secondGet;
  await expect(page.getByRole('main').getByText('Tin sắp bị xoá')).toHaveCount(0);
});
