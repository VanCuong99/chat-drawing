import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mixPigmentHex, pigmentPercentages } from '@net/pigment';
import { createDatabase, eq, paletteColors } from '@net/database';
import { e2eApiUrl } from './e2e-environment';
import { setVietnameseUi } from './use-vietnamese-ui';

test.beforeEach(async ({ context }) => setVietnameseUi(context));

const API_URL = e2eApiUrl;

function userToken(userId: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is required for authenticated palette E2E');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: userId, kind: 'user', email: `${userId}@example.test`, displayName: userId, actorKey: `user:${userId}`, iss: 'net-web', aud: 'net-api', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test('pha từ nhiều sắc tố, lưu và nạp lại công thức trong palette guest @critical', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Pigment E2E ${Date.now()}`);
  const guestResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  const guestSessionId = ((await (await guestResponsePromise).json()) as { sessionId: string }).sessionId;
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();

  await expect(page.getByRole('button', { name: 'Màu nước', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mở pha màu nâng cao' }).click();
  const mixer = page.getByRole('region', { name: 'Pha màu nâng cao' });
  await expect(mixer).toBeVisible();
  await expect(mixer.getByText('Trộn nhiều màu', { exact: true })).toBeVisible();
  await mixer.getByText('Thông tin mô phỏng màu').click();
  await expect(mixer.getByText(/Kubelka–Munk/)).toBeVisible();
  await expect(mixer.getByText(/Mô phỏng gần đúng/)).toBeVisible();

  const components = mixer.getByRole('list', { name: 'Các màu thành phần' });
  await expect(components.getByRole('listitem')).toHaveCount(2);
  await mixer.getByRole('button', { name: 'Thêm màu thành phần' }).click();
  await expect(components.getByRole('listitem')).toHaveCount(3);
  await components.getByLabel('Màu 1', { exact: true }).fill('#FCF046');
  await components.getByLabel('Màu 2', { exact: true }).fill('#E53166');
  await components.getByLabel('Màu 3', { exact: true }).fill('#3375DA');
  await components.getByLabel('Lượng của màu 1').fill('1');
  await components.getByLabel('Lượng của màu 2').fill('1');
  await components.getByLabel('Lượng của màu 3').fill('1');
  await expect(components.getByRole('listitem').nth(0)).toContainText('33.3%');
  const addComponent = mixer.getByRole('button', { name: 'Thêm màu thành phần' });
  for (let index = 0; index < 9; index += 1) await addComponent.click();
  await expect(components.getByRole('listitem')).toHaveCount(12);
  await expect(addComponent).toBeDisabled();
  for (let index = 12; index > 3; index -= 1) {
    await mixer.getByRole('button', { name: `Xóa màu ${index}` }).click();
  }
  await expect(components.getByRole('listitem')).toHaveCount(3);
  await expect(mixer.getByText('#705C71')).toBeVisible();

  await mixer.getByRole('button', { name: 'Dùng màu' }).click();
  await expect(page.getByText('#705C71').first()).toBeVisible();
  await mixer.getByText('Lưu vào bảng màu').click();
  await mixer.getByRole('textbox', { name: 'Tên màu đã pha' }).fill('Nâu trung tính ba màu');
  await page.route('**/api/palette', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  const saveResponse = page.waitForResponse((response) => response.url().endsWith('/api/palette') && response.request().method() === 'POST');
  await mixer.getByRole('button', { name: 'Lưu trong phiên' }).click();
  await expect(page.getByRole('button', { name: 'Đóng Esc', exact: true })).toBeDisabled();
  await expect(page.locator('.studio-header .primary-button')).toBeDisabled();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Đóng Esc', exact: true })).toBeEnabled();
  await page.unroute('**/api/palette');
  await expect(page.getByRole('button', { name: 'Dùng màu Nâu trung tính ba màu' })).toBeVisible();

  await mixer.getByRole('button', { name: 'Đóng pha màu nâng cao' }).click();
  await page.getByRole('button', { name: 'Đóng Esc', exact: true }).click();
  await page.reload();
  await expect(page.getByText(/Đã đồng bộ|Đang kết nối lại/)).toBeVisible();
  await page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' }).click();
  await expect(page.getByRole('button', { name: 'Dùng màu Nâu trung tính ba màu' })).toBeVisible();
  await page.getByRole('button', { name: 'Nạp công thức Nâu trung tính ba màu' }).click();
  await expect(page.getByRole('region', { name: 'Pha màu nâng cao' }).getByRole('listitem')).toHaveCount(3);
  await page.getByRole('region', { name: 'Pha màu nâng cao' }).getByText('Thông tin mô phỏng màu').click();
  await expect(page.getByRole('region', { name: 'Pha màu nâng cao' }).getByText(/#FCF046/)).toBeVisible();

  await page.getByRole('region', { name: 'Pha màu nâng cao' }).getByRole('button', { name: 'Đóng pha màu nâng cao' }).click();
  await page.getByRole('button', { name: 'Đóng Esc', exact: true }).click();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for guest cascade E2E');
  const { db, pool } = createDatabase(databaseUrl, 1);
  try {
    expect(await db.select({ id: paletteColors.id }).from(paletteColors).where(eq(paletteColors.guestSessionId, guestSessionId))).toHaveLength(1);
    const endResponse = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
    await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
    expect((await endResponse).status()).toBe(200);
    expect(await db.select({ id: paletteColors.id }).from(paletteColors).where(eq(paletteColors.guestSessionId, guestSessionId))).toHaveLength(0);
  } finally {
    await pool.end();
  }
});

test('bảng màu tài khoản tồn tại qua token mới và cách ly theo user @critical', async ({ request }) => {
  const userId = `palette-user-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const created = await request.post(`${API_URL}/palette`, {
    headers: { authorization },
    data: { name: 'Nâu ba màu', color: '#FF0000', components: [{ color: '#FCF046', weight: 1 }, { color: '#E53166', weight: 1 }, { color: '#3375DA', weight: 1 }] },
  });
  expect(created.status()).toBe(200);
  const createdColor = (await created.json()).color as { id: string };

  const freshAuthorization = `Bearer ${userToken(userId)}`;
  const persisted = await request.get(`${API_URL}/palette`, { headers: { authorization: freshAuthorization } });
  expect(persisted.status()).toBe(200);
  await expect(persisted.json()).resolves.toMatchObject({ colors: [expect.objectContaining({ id: createdColor.id, name: 'Nâu ba màu', color: '#705C71', components: [{ color: '#FCF046', weight: 1 }, { color: '#E53166', weight: 1 }, { color: '#3375DA', weight: 1 }], model: { id: 'spectral-kubelka-munk-rgb', version: 2, colorSpace: 'sRGB', illuminant: 'D65' } })] });

  const anotherUser = await request.get(`${API_URL}/palette`, { headers: { authorization: `Bearer ${userToken(`${userId}-other`)}` } });
  expect(anotherUser.status()).toBe(200);
  await expect(anotherUser.json()).resolves.toEqual({ colors: [] });

  const removed = await request.delete(`${API_URL}/palette/${createdColor.id}`, { headers: { authorization: freshAuthorization } });
  expect(removed.status()).toBe(200);
});

test('giới hạn 24 màu vẫn đúng khi nhiều request lưu đồng thời @critical', async ({ request }) => {
  test.setTimeout(60_000);
  const userId = `palette-race-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => request.post(`${API_URL}/palette`, {
    headers: { authorization },
    data: { name: `Màu đồng thời ${index + 1}`, components: [{ color: '#002185', weight: 1 }, { color: '#FCD200', weight: 1 }] },
  })));
  expect(responses.filter((response) => response.status() === 200)).toHaveLength(24);
  expect(responses.filter((response) => response.status() === 400)).toHaveLength(1);

  const listed = await request.get(`${API_URL}/palette`, { headers: { authorization } });
  const colors = (await listed.json()).colors as Array<{ id: string }>;
  expect(colors).toHaveLength(24);
  for (const color of colors) {
    const deleted = await request.delete(`${API_URL}/palette/${color.id}`, { headers: { authorization } });
    expect(deleted.status()).toBe(200);
  }
});

test('API chặn công thức ngoài giới hạn 2-12 màu và phần pha không hợp lệ', async ({ request }) => {
  const authorization = `Bearer ${userToken(`palette-boundary-${Date.now()}`)}`;
  const component = { color: '#FCF046', weight: 1 };
  const invalidFormulas = [
    [component],
    Array.from({ length: 13 }, () => component),
    [component, { color: '#3375DA', weight: 0 }],
    [component, { color: '#3375DA', weight: 1.5 }],
  ];
  for (const components of invalidFormulas) {
    const response = await request.post(`${API_URL}/palette`, { headers: { authorization }, data: { name: 'Không hợp lệ', components } });
    expect(response.status()).toBe(400);
  }
});

test('chuẩn hóa phần trăm không tạo giá trị âm và luôn đủ 100%', () => {
  const percentages = pigmentPercentages([33, 59, 37, 81, 9, 83, 97, 1].map((weight) => ({ color: '#FCF046', weight })));
  expect(percentages.every((value) => value >= 0)).toBe(true);
  expect(percentages.reduce((sum, value) => sum + Math.round(value * 10), 0)).toBe(1000);
});

test('mô hình pha đồng thời 3-12 thành phần, giữ tỷ lệ và không phụ thuộc thứ tự', () => {
  const formula = [
    { color: '#FCF046', weight: 5 },
    { color: '#E53166', weight: 3 },
    { color: '#3375DA', weight: 2 },
    { color: '#16A085', weight: 1 },
    { color: '#FCF046', weight: 4 },
  ];
  expect(mixPigmentHex(formula)).toBe(mixPigmentHex([...formula].reverse()));
  expect(pigmentPercentages(formula).reduce((sum, value) => sum + value, 0)).toBe(100);

  const twelve = Array.from({ length: 12 }, (_, index) => ({
    color: ['#FCF046', '#E53166', '#3375DA', '#16A085'][index % 4],
    weight: index + 1,
  }));
  expect(mixPigmentHex(twelve)).toMatch(/^#[0-9A-F]{6}$/);
  expect(pigmentPercentages(twelve)).toHaveLength(12);
});

test('API tiếp tục nhận payload hai màu từ client cũ', async ({ request }) => {
  const authorization = `Bearer ${userToken(`palette-legacy-post-${Date.now()}`)}`;
  const created = await request.post(`${API_URL}/palette`, {
    headers: { authorization },
    data: { name: 'Payload cũ', color: '#FFFFFF', sourceA: '#002185', sourceB: '#FCD200', ratio: 50 },
  });
  expect(created.status()).toBe(200);
  const saved = (await created.json()).color as { id: string; color: string; components: Array<{ color: string; weight: number }> };
  expect(saved).toMatchObject({ color: '#00414F', components: [{ color: '#002185', weight: 50 }, { color: '#FCD200', weight: 50 }] });
  expect((await request.delete(`${API_URL}/palette/${saved.id}`, { headers: { authorization } })).status()).toBe(200);
});

test('màu hai thành phần cũ được chuyển thành công thức khi đọc', async ({ request }) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for legacy palette E2E');
  const userId = `palette-legacy-${Date.now()}`;
  const authorization = `Bearer ${userToken(userId)}`;
  expect((await request.get(`${API_URL}/palette`, { headers: { authorization } })).status()).toBe(200);
  const { db, pool } = createDatabase(databaseUrl, 1);
  try {
    const [legacy] = await db.insert(paletteColors).values({ userId, name: 'Màu cũ', color: '#3D933E', sourceA: '#002185', sourceB: '#FCD200', ratio: 50, createdAt: Date.now() }).returning({ id: paletteColors.id });
    const listed = await request.get(`${API_URL}/palette`, { headers: { authorization } });
    await expect(listed.json()).resolves.toMatchObject({ colors: [expect.objectContaining({ id: legacy.id, components: [{ color: '#002185', weight: 50 }, { color: '#FCD200', weight: 50 }] })] });
    expect((await request.delete(`${API_URL}/palette/${legacy.id}`, { headers: { authorization } })).status()).toBe(200);
  } finally {
    await pool.end();
  }
});
